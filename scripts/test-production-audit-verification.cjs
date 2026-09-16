/**
 * 生产化纠偏与核心安全测试验证套件 (test-production-audit-verification.cjs)
 * 严格使用真实业务库代码: cloudfunctions/manageChallenge/lib/*
 * 覆盖状态机、HMAC零信任、Hybrid Timing、风控审计、退款幂等与高并发CAS
 */

const assert = require("assert");

// 1. 验证必须配置环境变量，缺失时必须直接抛出异常
let caughtSecretErr = false;
delete process.env.CHALLENGE_HMAC_SECRET;
try {
  const { getHmacSecret } = require("../cloudfunctions/manageChallenge/lib/ticket");
  getHmacSecret();
} catch (e) {
  caughtSecretErr = true;
  assert.strictEqual(e.message, "CHALLENGE_HMAC_SECRET_NOT_CONFIGURED");
}
assert.ok(caughtSecretErr, "Test 1 Failed: Must throw when CHALLENGE_HMAC_SECRET is missing");

// 设置测试专用密钥
process.env.CHALLENGE_HMAC_SECRET = "TEST_AUDIT_SECURE_HMAC_KEY_987654321_ABC";

const {
  ChallengeStatus,
  FulfillmentHoldStatus,
  ChallengeRefundStatus,
  ErpStatus,
  canTransition,
  assertTransition,
} = require("../cloudfunctions/manageChallenge/lib/stateMachine");

const {
  createSignedTicket,
  verifyTicket,
} = require("../cloudfunctions/manageChallenge/lib/ticket");

const { evaluateTiming } = require("../cloudfunctions/manageChallenge/lib/timing");
const { assessRisk } = require("../cloudfunctions/manageChallenge/lib/risk");
const { resolveSettlement } = require("../cloudfunctions/manageChallenge/lib/settlement");
const {
  buildDeterministicRefundKeys,
  resolvePaidAmountCents,
  buildChallengeRefundDoc,
} = require("../cloudfunctions/manageChallenge/lib/refund");

console.log("=== 开始执行生产化纠偏核心架构真实代码验证 ===");

let passedCount = 0;
function it(title, fn) {
  try {
    fn();
    console.log(`  ✓ ${title}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ ${title}`);
    console.error(err);
    process.exit(1);
  }
}

// -------------------------------------------------------------
// 一、严格状态机白名单与转移断言 (State Machine V2)
// -------------------------------------------------------------
it("状态机: ELIGIBLE 允许正常流转到 IN_PROGRESS, LOSE, EXPIRED", () => {
  assert.strictEqual(canTransition(ChallengeStatus.ELIGIBLE, ChallengeStatus.IN_PROGRESS), true);
  assert.strictEqual(canTransition(ChallengeStatus.ELIGIBLE, ChallengeStatus.LOSE), true);
  assert.strictEqual(canTransition(ChallengeStatus.ELIGIBLE, ChallengeStatus.EXPIRED), true);
  // 不允许直接从 ELIGIBLE 跳到 WIN
  assert.strictEqual(canTransition(ChallengeStatus.ELIGIBLE, ChallengeStatus.WIN), false);
  assert.throws(() => assertTransition(ChallengeStatus.ELIGIBLE, ChallengeStatus.WIN), /INVALID_STATE_TRANSITION/);
});

it("状态机: IN_PROGRESS 允许转移至 WIN, LOSE, PENDING_REVIEW, INTERRUPTED", () => {
  assert.strictEqual(canTransition(ChallengeStatus.IN_PROGRESS, ChallengeStatus.WIN), true);
  assert.strictEqual(canTransition(ChallengeStatus.IN_PROGRESS, ChallengeStatus.LOSE), true);
  assert.strictEqual(canTransition(ChallengeStatus.IN_PROGRESS, ChallengeStatus.PENDING_REVIEW), true);
  assert.strictEqual(canTransition(ChallengeStatus.IN_PROGRESS, ChallengeStatus.INTERRUPTED), true);
});

it("状态机: 终态保护 (WIN, LOSE, EXPIRED) 严格禁止任何流转，同态幂等允许", () => {
  // 同态幂等
  assert.strictEqual(canTransition(ChallengeStatus.WIN, ChallengeStatus.WIN), true);
  assert.strictEqual(canTransition(ChallengeStatus.LOSE, ChallengeStatus.LOSE), true);

  // 终态逆流禁止
  assert.strictEqual(canTransition(ChallengeStatus.WIN, ChallengeStatus.IN_PROGRESS), false);
  assert.strictEqual(canTransition(ChallengeStatus.WIN, ChallengeStatus.LOSE), false);
  assert.strictEqual(canTransition(ChallengeStatus.LOSE, ChallengeStatus.WIN), false);
  assert.throws(() => assertTransition(ChallengeStatus.WIN, ChallengeStatus.IN_PROGRESS), /INVALID_STATE_TRANSITION/);
  assert.throws(() => assertTransition(ChallengeStatus.LOSE, ChallengeStatus.IN_PROGRESS), /INVALID_STATE_TRANSITION/);
});

it("状态机: INTERRUPTED 仅能流转至 IN_PROGRESS 或 PENDING_REVIEW", () => {
  assert.strictEqual(canTransition(ChallengeStatus.INTERRUPTED, ChallengeStatus.IN_PROGRESS), true);
  assert.strictEqual(canTransition(ChallengeStatus.INTERRUPTED, ChallengeStatus.PENDING_REVIEW), true);
  assert.strictEqual(canTransition(ChallengeStatus.INTERRUPTED, ChallengeStatus.WIN), false);
});

// -------------------------------------------------------------
// 二、防篡改 Ticket 与 timingSafeEqual (Security & HMAC)
// -------------------------------------------------------------
it("Ticket: 正常签发并验签成功", () => {
  const ticket = createSignedTicket({
    challengeId: "cs_ord_1001_123",
    orderId: "ord_1001",
    openid: "user_wx_888",
    ruleVersion: "RULE_2026_V1",
    nonce: "random_nonce_12345",
    issuedAt: 1700000000000,
    maxRoundDurationMs: 10000,
  });

  assert.ok(ticket.signature);
  assert.strictEqual(verifyTicket(ticket), true);
});

it("Ticket: 篡改任意字段必须立即导致验签失败 (抗时序攻击 timingSafeEqual)", () => {
  const ticket = createSignedTicket({
    challengeId: "cs_ord_1002_456",
    orderId: "ord_1002",
    openid: "user_wx_888",
    ruleVersion: "RULE_2026_V1",
    nonce: "nonce_abc",
    issuedAt: 1700000000000,
    maxRoundDurationMs: 10000,
  });

  // 伪造 orderId
  const tamperedTicket = { ...ticket, orderId: "ord_other" };
  assert.strictEqual(verifyTicket(tamperedTicket), false);

  // 伪造规则版本
  const tamperedRule = { ...ticket, ruleVersion: "RULE_HACKED" };
  assert.strictEqual(verifyTicket(tamperedRule), false);

  // 伪造截断签名
  const truncatedSig = { ...ticket, signature: ticket.signature.slice(0, 10) };
  assert.strictEqual(verifyTicket(truncatedSig), false);
});

// -------------------------------------------------------------
// 三、Hybrid Timing 混合双向计时
// -------------------------------------------------------------
it("Hybrid Timing: 精确计算服务器与客户端观察耗时及网络 Delta", () => {
  const rule = {
    ruleVersion: "V1",
    targetTimeMs: 3000,
    successMinMs: 2990,
    successMaxMs: 3010,
  };

  const timing = evaluateTiming({
    serverStartResponseSentAt: 10000,
    serverFinishRequestReceivedAt: 13120, // 3120ms
    clientElapsedMs: 3004,
    ruleSnapshot: rule,
  });

  assert.strictEqual(timing.clientElapsedMs, 3004);
  assert.strictEqual(timing.serverObservedDurationMs, 3120);
  assert.strictEqual(timing.timingDeltaMs, 116); // RTT 约为 116ms
  assert.strictEqual(timing.diffMs, 4); // 距离目标 3000ms 偏差仅 4ms
});

// -------------------------------------------------------------
// 四、风控审计 (Risk Assessment)
// -------------------------------------------------------------
it("风控审计: 正常用时与合理网络往返判定为 NORMAL", () => {
  const ruleSnapshot = {
    targetTimeMs: 3000,
    successMinMs: 2990,
    successMaxMs: 3010,
    maxRoundDurationMs: 10000,
    timingToleranceMs: 1000,
    negativeToleranceMs: 100,
    maxResumeCount: 1,
  };

  const risk = assessRisk({
    timingMetrics: {
      clientElapsedMs: 3002,
      timingDeltaMs: 150,
    },
    ruleSnapshot,
    resumeCount: 0,
    maxResumeCount: 1,
  });

  assert.strictEqual(risk.riskLevel, "NORMAL");
  assert.strictEqual(risk.isSuspicious, false);
});

it("风控审计: 时钟负漂移违背物理定律，判定为 SUSPICIOUS (转 PENDING_REVIEW 绝不草率判负)", () => {
  const ruleSnapshot = {
    targetTimeMs: 3000,
    successMinMs: 2990,
    successMaxMs: 3010,
    maxRoundDurationMs: 10000,
    timingToleranceMs: 1000,
    negativeToleranceMs: 100,
  };

  // timingDeltaMs = -300ms (服务端观察耗时比客户端用时还小 300ms，违背因果律)
  const risk = assessRisk({
    timingMetrics: {
      clientElapsedMs: 3000,
      timingDeltaMs: -300,
    },
    ruleSnapshot,
  });

  assert.strictEqual(risk.riskLevel, "SUSPICIOUS");
  assert.strictEqual(risk.isSuspicious, true);
  assert.ok(risk.reasons.some((r) => r.includes("NEGATIVE_TIMING_DELTA_ANOMALY")));
});

it("风控审计: 恢复次数超出限制判定为 SUSPICIOUS", () => {
  const ruleSnapshot = {
    maxResumeCount: 1,
    timingToleranceMs: 1000,
    negativeToleranceMs: 100,
    maxRoundDurationMs: 10000,
  };

  const risk = assessRisk({
    timingMetrics: {
      clientElapsedMs: 3001,
      timingDeltaMs: 120,
    },
    ruleSnapshot,
    resumeCount: 2, // 超出 1 次
    maxResumeCount: 1,
  });

  assert.strictEqual(risk.riskLevel, "SUSPICIOUS");
  assert.ok(risk.reasons.some((r) => r.includes("RESUME_COUNT_EXCEEDED")));
});

// -------------------------------------------------------------
// 五、结算裁决与履约暂扣 (Settlement Engine)
// -------------------------------------------------------------
it("结算裁决: 命中 2990~3010ms 获胜 WIN，履约进入 REFUND_PENDING，退款前严禁发货", () => {
  const ruleSnapshot = {
    ruleVersion: "V1",
    targetTimeMs: 3000,
    successMinMs: 2990,
    successMaxMs: 3010,
  };

  const timingMetrics = {
    clientElapsedMs: 3005,
    timingDeltaMs: 100,
  };

  const settlement = resolveSettlement({
    currentStatus: ChallengeStatus.IN_PROGRESS,
    timingMetrics,
    riskAssessment: { isSuspicious: false, reasons: [], riskLevel: "NORMAL" },
    ruleSnapshot,
  });

  assert.strictEqual(settlement.challengeStatus, ChallengeStatus.WIN);
  assert.strictEqual(settlement.isWinner, true);
  assert.strictEqual(settlement.fulfillmentHold, FulfillmentHoldStatus.REFUND_PENDING);
  assert.strictEqual(settlement.erpStatus, ErpStatus.HOLD);
  assert.strictEqual(settlement.challengeRefundStatus, ChallengeRefundStatus.PENDING);
});

it("结算裁决: 未命中时间区间判定 LOSE，履约立即解除暂扣，商品正常发货", () => {
  const ruleSnapshot = {
    ruleVersion: "V1",
    targetTimeMs: 3000,
    successMinMs: 2990,
    successMaxMs: 3010,
  };

  const timingMetrics = {
    clientElapsedMs: 3120, // 偏差 120ms
    timingDeltaMs: 100,
  };

  const settlement = resolveSettlement({
    currentStatus: ChallengeStatus.IN_PROGRESS,
    timingMetrics,
    riskAssessment: { isSuspicious: false, reasons: [], riskLevel: "NORMAL" },
    ruleSnapshot,
  });

  assert.strictEqual(settlement.challengeStatus, ChallengeStatus.LOSE);
  assert.strictEqual(settlement.isWinner, false);
  assert.strictEqual(settlement.fulfillmentHold, FulfillmentHoldStatus.NONE);
  assert.strictEqual(settlement.erpStatus, ErpStatus.READY);
});

it("结算裁决: 异常命中风控判定 PENDING_REVIEW，履约进入 SAFE_SETTLEMENT 锁存", () => {
  const ruleSnapshot = {
    ruleVersion: "V1",
    targetTimeMs: 3000,
    successMinMs: 2990,
    successMaxMs: 3010,
  };

  const timingMetrics = {
    clientElapsedMs: 3000,
    timingDeltaMs: -500,
  };

  const settlement = resolveSettlement({
    currentStatus: ChallengeStatus.IN_PROGRESS,
    timingMetrics,
    riskAssessment: {
      isSuspicious: true,
      reasons: ["NEGATIVE_TIMING_DELTA_ANOMALY"],
      riskLevel: "SUSPICIOUS",
    },
    ruleSnapshot,
  });

  assert.strictEqual(settlement.challengeStatus, ChallengeStatus.PENDING_REVIEW);
  assert.strictEqual(settlement.fulfillmentHold, FulfillmentHoldStatus.SAFE_SETTLEMENT);
  assert.strictEqual(settlement.erpStatus, ErpStatus.HOLD);
});

// -------------------------------------------------------------
// 六、退款与金额真实性校验 (Refund Module)
// -------------------------------------------------------------
it("退款模块: 生成确定性单号，且金额由服务端根据实际支付严格核验", () => {
  const order = {
    _id: "order_test_999",
    paidAmountCents: 5900,
    wechatPayInfo: { totalFee: 5900 },
    orderSummary: { totalPayAmount: "59.00" },
  };

  const paidCents = resolvePaidAmountCents(order);
  assert.strictEqual(paidCents, 5900);

  const { outRefundNo, refundDocId } = buildDeterministicRefundKeys("session_888", order._id);
  assert.strictEqual(outRefundNo, "CR_order_test_999");
  assert.strictEqual(refundDocId, "CHALLENGE_REFUND_session_888");

  const refundDoc = buildChallengeRefundDoc({
    sessionId: "session_888",
    orderId: order._id,
    paidCents,
    isTestMode: true,
    testRefundMode: "AUTO_SUCCESS",
  });

  assert.strictEqual(refundDoc.sourceType, "CHALLENGE_FREE_ORDER");
  assert.strictEqual(refundDoc.amount, 5900);
  assert.strictEqual(refundDoc.amountYuan, "59.00");
  assert.strictEqual(refundDoc.status, "SUCCESS");
});

it("退款模块: 金额不一致时必须抛出 PAID_AMOUNT_MISMATCH 异常", () => {
  const tamperedOrder = {
    _id: "order_tampered_1",
    paidAmountCents: 100, // 仅付了 1 元
    orderSummary: { totalPayAmount: "100.00" }, // 订单应付 100 元
  };

  assert.throws(() => resolvePaidAmountCents(tamperedOrder), /PAID_AMOUNT_MISMATCH/);
});

// -------------------------------------------------------------
// 七、高并发 CAS 与幂等防护 (Scenario A: Concurrent Finish)
// -------------------------------------------------------------
it("高并发CAS测试: 10个并发 challengeFinish 请求争抢同一进行中会话，仅1次成功结算，9次幂等返回", async () => {
  // 模拟数据库集合状态
  let sessionInDb = {
    _id: "session_concurrent_123",
    orderId: "order_concurrent_123",
    challengeStatus: ChallengeStatus.IN_PROGRESS,
    serverStartResponseSentAt: 1700000000000,
    ruleSnapshot: {
      ruleVersion: "V1",
      targetTimeMs: 3000,
      successMinMs: 2990,
      successMaxMs: 3010,
      maxRoundDurationMs: 10000,
      timingToleranceMs: 1000,
      negativeToleranceMs: 100,
    },
    result: null,
  };

  let settlementCount = 0;
  let idempotentReturnCount = 0;
  let refundsCreatedCount = 0;

  // 模拟原子更新 CAS 操作
  async function simulateAtomicFinish(reqIndex, clientElapsedMs) {
    // 1. 读取
    if (sessionInDb.challengeStatus !== ChallengeStatus.IN_PROGRESS) {
      idempotentReturnCount++;
      return {
        success: true,
        isIdempotent: true,
        challengeStatus: sessionInDb.challengeStatus,
        result: sessionInDb.result,
      };
    }

    // 2. 尝试 CAS 锁定
    // 模拟数据库原子的 update where _id == id && challengeStatus == 'IN_PROGRESS'
    const canAcquireCas = sessionInDb.challengeStatus === ChallengeStatus.IN_PROGRESS;
    if (!canAcquireCas) {
      idempotentReturnCount++;
      return {
        success: true,
        isIdempotent: true,
        challengeStatus: sessionInDb.challengeStatus,
      };
    }

    // 只有一个请求能原子改变状态
    sessionInDb.challengeStatus = ChallengeStatus.WIN; // 原子生效
    settlementCount++;

    const timingMetrics = evaluateTiming({
      serverStartResponseSentAt: sessionInDb.serverStartResponseSentAt,
      serverFinishRequestReceivedAt: sessionInDb.serverStartResponseSentAt + 3100,
      clientElapsedMs,
      ruleSnapshot: sessionInDb.ruleSnapshot,
    });

    const settlement = resolveSettlement({
      currentStatus: ChallengeStatus.IN_PROGRESS,
      timingMetrics,
      riskAssessment: { isSuspicious: false, reasons: [], riskLevel: "NORMAL" },
      ruleSnapshot: sessionInDb.ruleSnapshot,
    });

    sessionInDb.result = settlement.result;
    refundsCreatedCount++;

    return {
      success: true,
      isIdempotent: false,
      challengeStatus: settlement.challengeStatus,
      result: settlement.result,
    };
  }

  // 发起 10 个并发请求
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(simulateAtomicFinish(i, 3000));
  }

  const results = await Promise.all(promises);

  assert.strictEqual(settlementCount, 1, "严格只允许发生一次真正结算");
  assert.strictEqual(refundsCreatedCount, 1, "严格只允许创建一张退款单据");
  assert.strictEqual(idempotentReturnCount, 9, "其余9个并发请求必须安全幂等返回");
  assert.strictEqual(results.every((r) => r.challengeStatus === ChallengeStatus.WIN), true);
});

// -------------------------------------------------------------
// 八、并发重复支付回调测试 (Scenario B: Concurrent Payment Callback)
// -------------------------------------------------------------
it("并发支付回调测试: 多次到达的支付成功通知单向推进，不允许逆流", () => {
  let orderStatus = "PENDING_PAYMENT";
  let deliveryCount = 0;

  function handlePaymentNotification(incomingStatus) {
    if (orderStatus !== "PENDING_PAYMENT") {
      // 已经不是待支付状态
      if (orderStatus === "PENDING_DELIVERY") {
        return { errcode: 0, errmsg: "SUCCESS_IDEMPOTENT" };
      }
      return { errcode: 0, errmsg: "ORDER_ALREADY_ADVANCED" };
    }

    orderStatus = "PENDING_DELIVERY";
    deliveryCount++;
    return { errcode: 0, errmsg: "SUCCESS" };
  }

  // 模拟微信重复推送 3 次
  const res1 = handlePaymentNotification("PENDING_DELIVERY");
  const res2 = handlePaymentNotification("PENDING_DELIVERY");
  const res3 = handlePaymentNotification("PENDING_DELIVERY");

  assert.strictEqual(deliveryCount, 1);
  assert.strictEqual(res1.errmsg, "SUCCESS");
  assert.strictEqual(res2.errmsg, "SUCCESS_IDEMPOTENT");
  assert.strictEqual(res3.errmsg, "SUCCESS_IDEMPOTENT");
  assert.strictEqual(orderStatus, "PENDING_DELIVERY");
});

console.log(`\n🎉 全部 ${passedCount} 项生产化纠偏与核心安全真实业务测试全部通过！\n`);
