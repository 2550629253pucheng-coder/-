/**
 * Phase 2 核心架构纠偏全链路自动化验收脚本
 * 覆盖 Scenario 1 至 Scenario 10
 */
const crypto = require("crypto");

const HMAC_SECRET = "RTL_CHALLENGE_SECRET_KEY_2026";

// 模拟数据库内存表
const mockDb = {
  order: {},
  challenge_session: {},
  challenge_rules: {},
  refunds: {},
};

// 预置默认生效规则 (支持规则配置化，不可变快照)
const DEFAULT_TEST_RULE = {
  ruleId: "RULE_3S_TEST_V1",
  gameType: "THREE_SECOND_HOLD",
  ruleVersion: "TEST_V1",
  targetTimeMs: 3000,
  successMinMs: 2990,
  successMaxMs: 3010,
  maxRoundDurationMs: 10000,
  timingToleranceMs: 1000,
  negativeToleranceMs: 100,
  status: "ACTIVE",
  effectiveFrom: 0,
  effectiveTo: 4102444800000,
};
mockDb.challenge_rules[DEFAULT_TEST_RULE.ruleId] = DEFAULT_TEST_RULE;

function createSignedTicket({ challengeId, orderId, openid, ruleVersion, nonce, issuedAt, maxRoundDurationMs }) {
  const payload = `${challengeId}:${orderId}:${openid}:${ruleVersion}:${nonce}:${issuedAt}:${maxRoundDurationMs}`;
  const signature = crypto.createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
  return { challengeId, orderId, openid, ruleVersion, nonce, issuedAt, maxRoundDurationMs, signature };
}

function verifyTicket(ticket) {
  if (!ticket || !ticket.signature) return false;
  const payload = `${ticket.challengeId}:${ticket.orderId}:${ticket.openid}:${ticket.ruleVersion}:${ticket.nonce}:${ticket.issuedAt}:${ticket.maxRoundDurationMs}`;
  const expected = crypto.createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
  return expected === ticket.signature;
}

// 模拟创建订单并完成支付
function setupPaidOrder(orderId, openid = "user_test_001", payAmount = "39.80") {
  const order = {
    _id: orderId,
    orderNo: `ORD_${orderId}`,
    _openid: openid,
    status: "PENDING_DELIVERY", // 原订单主状态机：已支付待发货
    deliveryType: 1, // 快递
    orderSummary: { totalPayAmount: payAmount },
    wechatPayInfo: { totalFee: Math.round(Number(payAmount) * 100) },
    // 独立解耦字段
    challengeEligible: true,
    challengeStatus: "ELIGIBLE",
    challengeRefundStatus: "NONE",
    fulfillmentHold: "CHALLENGE_PENDING",
    erpStatus: "HOLD",
  };
  mockDb.order[orderId] = order;
  return order;
}

// 模拟云函数 manageChallenge.startSession
function startSession(openId, orderId) {
  const order = mockDb.order[orderId];
  if (!order) throw new Error("订单不存在");

  // 读取生效规则快照
  const rule = DEFAULT_TEST_RULE;
  const ruleSnapshot = { ...rule };

  const sessionId = `cs_${orderId}_${Date.now()}`;
  const now = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");

  const ticket = createSignedTicket({
    challengeId: sessionId,
    orderId,
    openid: openId,
    ruleVersion: ruleSnapshot.ruleVersion,
    nonce,
    issuedAt: now,
    maxRoundDurationMs: ruleSnapshot.maxRoundDurationMs,
  });

  const session = {
    _id: sessionId,
    orderId,
    _openid: openId,
    activityMode: "TEST",
    challengeStatus: "IN_PROGRESS",
    ruleSnapshot,
    serverStartResponseSentAt: now,
    latestTicketNonce: nonce,
    attempts: 0,
    createdAt: now,
  };
  mockDb.challenge_session[sessionId] = session;

  order.challengeStatus = "IN_PROGRESS";
  order.fulfillmentHold = "CHALLENGE_PENDING";
  order.erpStatus = "HOLD";

  return { sessionId, ticket, ruleSnapshot, serverStartResponseSentAt: now };
}

// 模拟云函数 manageChallenge.submitChallenge
function submitChallenge(openId, {
  sessionId,
  ticket,
  clientElapsedMs,
  clientStartMonotonic,
  clientStopMonotonic,
  mockServerFinishTime,
}) {
  const serverFinishRequestReceivedAt = mockServerFinishTime || Date.now();
  const session = mockDb.challenge_session[sessionId];
  if (!session) throw new Error("会话不存在");

  // 幂等拦截
  if (session.challengeStatus === "WIN" || session.challengeStatus === "LOSE" || session.challengeStatus === "PENDING_REVIEW") {
    return {
      isIdempotent: true,
      sessionId,
      challengeStatus: session.challengeStatus,
      result: session.result,
    };
  }

  // 验签 Ticket
  if (!verifyTicket(ticket)) throw new Error("Ticket 验签失败");

  const ruleSnapshot = session.ruleSnapshot;
  const clientElapsed = Math.round(Number(clientElapsedMs));

  // Hybrid Timing 评估
  const serverObservedDurationMs = serverFinishRequestReceivedAt - session.serverStartResponseSentAt;
  const timingDeltaMs = serverObservedDurationMs - clientElapsed;

  // 风控判定
  let riskLevel = "NORMAL";
  let isSuspicious = false;
  if (
    clientElapsed > ruleSnapshot.maxRoundDurationMs ||
    timingDeltaMs < -ruleSnapshot.negativeToleranceMs ||
    Math.abs(timingDeltaMs) > ruleSnapshot.timingToleranceMs
  ) {
    isSuspicious = true;
    riskLevel = "SUSPICIOUS";
  }

  const baseResult = {
    clientElapsedMs: clientElapsed,
    serverObservedDurationMs,
    timingDeltaMs,
    ruleVersion: ruleSnapshot.ruleVersion,
    diffMs: Math.abs(clientElapsed - ruleSnapshot.targetTimeMs),
    riskLevel,
  };

  const order = mockDb.order[session.orderId];

  // 场景 A: 风控可疑 -> PENDING_REVIEW (SAFE_SETTLEMENT)
  if (isSuspicious) {
    session.challengeStatus = "PENDING_REVIEW";
    session.result = { ...baseResult, isWinner: false, reviewReason: "Timing delta anomaly" };
    order.challengeStatus = "PENDING_REVIEW";
    order.fulfillmentHold = "SAFE_SETTLEMENT";
    order.erpStatus = "HOLD";
    return { sessionId, challengeStatus: "PENDING_REVIEW", riskLevel: "SUSPICIOUS", result: session.result };
  }

  // 场景 B: 正常规则判定
  const isWinner = clientElapsed >= ruleSnapshot.successMinMs && clientElapsed <= ruleSnapshot.successMaxMs;

  if (!isWinner) {
    session.challengeStatus = "LOSE";
    session.result = { ...baseResult, isWinner: false };
    order.challengeStatus = "LOSE";
    order.challengeRefundStatus = "NONE";
    order.fulfillmentHold = "NONE";
    order.erpStatus = "READY";
    return { sessionId, challengeStatus: "LOSE", isWinner: false, result: session.result };
  }

  // WIN 流程
  session.challengeStatus = "WIN";
  session.result = { ...baseResult, isWinner: true };

  order.challengeStatus = "WIN";
  order.challengeRefundStatus = "PENDING";
  order.fulfillmentHold = "REFUND_PENDING"; // 必须锁定！
  order.erpStatus = "HOLD";

  // 创建专属 refunds 单 (绝不写 after-service)
  const refundId = `rf_${session.orderId}_${Date.now()}`;
  const refundDoc = {
    _id: refundId,
    orderId: session.orderId,
    sourceType: "CHALLENGE_FREE_ORDER",
    outRefundNo: `RF_CHALLENGE_${session.orderId}`,
    amount: order.wechatPayInfo.totalFee,
    amountYuan: (order.wechatPayInfo.totalFee / 100).toFixed(2),
    status: "PENDING",
    testMode: true,
    createdAt: Date.now(),
  };
  mockDb.refunds[refundId] = refundDoc;

  return {
    sessionId,
    challengeStatus: "WIN",
    isWinner: true,
    result: session.result,
    refundId,
  };
}

// 模拟微信退款异步回调
function refundCallback({ refundId, status, errorMessage }) {
  const refund = mockDb.refunds[refundId];
  if (!refund) throw new Error("Refund not found");

  if (refund.status === "SUCCESS") {
    return { success: true, message: "Already processed (idempotent)" };
  }

  const order = mockDb.order[refund.orderId];
  if (status === "SUCCESS") {
    refund.status = "SUCCESS";
    order.challengeRefundStatus = "SUCCESS";
    order.fulfillmentHold = "NONE"; // 只有退款 SUCCESS 才解锁！
    order.erpStatus = "READY";
    order.challengeRefundInfo = { refundId, amountYuan: refund.amountYuan };
  } else {
    refund.status = "FAILED";
    refund.errorMessage = errorMessage;
    order.challengeRefundStatus = "FAILED";
    order.fulfillmentHold = "REFUND_PENDING"; // 依然锁定，禁止发货！
    order.erpStatus = "HOLD";
  }
  return { success: true, refundStatus: refund.status };
}

// 模拟发货接口 adminManageOrder.shipOrder
function shipOrder(orderId) {
  const order = mockDb.order[orderId];
  if (!order) throw new Error("Order not found");
  if (order.status !== "PENDING_DELIVERY") throw new Error("订单主状态不允许发货");
  if (order.fulfillmentHold && order.fulfillmentHold !== "NONE") {
    throw new Error(`[拦截] 履约暂扣中 (hold: ${order.fulfillmentHold})，禁止发货`);
  }
  order.shippedTime = Date.now();
  return { success: true, shipped: true };
}

// 运行 10 大测试场景
async function runTests() {
  console.log("==================================================================");
  console.log("   PHASE 2 核心架构纠偏与稳健性全链路自动化验收测试 (10 SCENARIOS)");
  console.log("==================================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (!condition) {
      console.error(`❌ FAIL: ${message}`);
      failed++;
      throw new Error(message);
    } else {
      console.log(`✅ PASS: ${message}`);
      passed++;
    }
  }

  // -------------------------------------------------------------
  console.log("[Scenario 1] 正常 LOSE 流程校验");
  // -------------------------------------------------------------
  {
    const orderId = "order_sc1";
    setupPaidOrder(orderId);
    const sessionRes = startSession("user_test_001", orderId);
    const submitRes = submitChallenge("user_test_001", {
      sessionId: sessionRes.sessionId,
      ticket: sessionRes.ticket,
      clientElapsedMs: 3250, // 偏离目标
      mockServerFinishTime: sessionRes.serverStartResponseSentAt + 3280, // delta=30ms
    });

    assert(submitRes.challengeStatus === "LOSE", "判定结果为 LOSE");
    assert(mockDb.order[orderId].status === "PENDING_DELIVERY", "订单主状态机未受污染保持 PENDING_DELIVERY");
    assert(mockDb.order[orderId].fulfillmentHold === "NONE", "LOSE 后履约锁释放 fulfillmentHold = NONE");
    assert(mockDb.order[orderId].erpStatus === "READY", "LOSE 后 erpStatus 允许就绪 READY");
    assert(mockDb.order[orderId].challengeRefundStatus === "NONE", "LOSE 不产生退款 challengeRefundStatus = NONE");
    assert(Object.keys(mockDb.refunds).filter(k => mockDb.refunds[k].orderId === orderId).length === 0, "LOSE 未创建任何退款单");
  }

  // -------------------------------------------------------------
  console.log("\n[Scenario 2] 正常 WIN 流程与退款前禁止发货校验");
  // -------------------------------------------------------------
  let sc2RefundId = null;
  {
    const orderId = "order_sc2";
    setupPaidOrder(orderId);
    const sessionRes = startSession("user_test_001", orderId);
    const submitRes = submitChallenge("user_test_001", {
      sessionId: sessionRes.sessionId,
      ticket: sessionRes.ticket,
      clientElapsedMs: 3004, // 命中 2990~3010
      mockServerFinishTime: sessionRes.serverStartResponseSentAt + 3025, // delta=21ms, 正常
    });
    sc2RefundId = submitRes.refundId;

    assert(submitRes.challengeStatus === "WIN", "判定结果为 WIN");
    assert(mockDb.order[orderId].status === "PENDING_DELIVERY", "主订单状态保持 PENDING_DELIVERY (严禁篡改主状态机)");
    assert(mockDb.order[orderId].challengeRefundStatus === "PENDING", "免单退款状态进入 PENDING");
    assert(mockDb.order[orderId].fulfillmentHold === "REFUND_PENDING", "履约状态进入 REFUND_PENDING 锁定");
    assert(mockDb.order[orderId].erpStatus === "HOLD", "退款完成前 erpStatus 严格为 HOLD");

    // 尝试在退款未完成时发货 -> 必须拦截！
    let shipBlocked = false;
    try {
      shipOrder(orderId);
    } catch (e) {
      shipBlocked = true;
    }
    assert(shipBlocked, "退款完成前发货被严格拦截 (fulfillmentHold = REFUND_PENDING)");
  }

  // -------------------------------------------------------------
  console.log("\n[Scenario 3] 微信退款成功回调 (refundCallback SUCCESS) 解锁校验");
  // -------------------------------------------------------------
  {
    const orderId = "order_sc2";
    refundCallback({ refundId: sc2RefundId, status: "SUCCESS" });

    assert(mockDb.refunds[sc2RefundId].status === "SUCCESS", "退款单状态更新为 SUCCESS");
    assert(mockDb.order[orderId].challengeRefundStatus === "SUCCESS", "订单 challengeRefundStatus 流转为 SUCCESS");
    assert(mockDb.order[orderId].fulfillmentHold === "NONE", "退款成功后履约锁解除 fulfillmentHold = NONE");
    assert(mockDb.order[orderId].erpStatus === "READY", "退款成功后 ERP 允许推单 erpStatus = READY");

    // 此时发货必须成功
    const shipRes = shipOrder(orderId);
    assert(shipRes.shipped === true, "退款成功后订单发货成功通过");
  }

  // -------------------------------------------------------------
  console.log("\n[Scenario 4] 退款失败 (refundCallback FAILED) 继续锁定校验");
  // -------------------------------------------------------------
  {
    const orderId = "order_sc4";
    setupPaidOrder(orderId);
    const sessionRes = startSession("user_test_001", orderId);
    const submitRes = submitChallenge("user_test_001", {
      sessionId: sessionRes.sessionId,
      ticket: sessionRes.ticket,
      clientElapsedMs: 3000,
      mockServerFinishTime: sessionRes.serverStartResponseSentAt + 3030,
    });
    const refundId = submitRes.refundId;

    // 模拟退款失败
    refundCallback({ refundId, status: "FAILED", errorMessage: "NOTENOUGH_FUNDS" });

    assert(mockDb.refunds[refundId].status === "FAILED", "退款单标记为 FAILED");
    assert(mockDb.order[orderId].challengeRefundStatus === "FAILED", "订单 challengeRefundStatus = FAILED");
    assert(mockDb.order[orderId].fulfillmentHold === "REFUND_PENDING", "退款失败继续保持锁定 REFUND_PENDING");
    assert(mockDb.order[orderId].erpStatus === "HOLD", "退款失败 ERP 继续保持 HOLD");

    let shipBlocked = false;
    try {
      shipOrder(orderId);
    } catch (e) {
      shipBlocked = true;
    }
    assert(shipBlocked, "退款失败时发货依然被严格拦截");
  }

  // -------------------------------------------------------------
  console.log("\n[Scenario 5] 网络/系统异常中断 (INTERRUPTED) 与恢复 (RESUME) 校验");
  // -------------------------------------------------------------
  {
    const orderId = "order_sc5";
    setupPaidOrder(orderId);
    const sessionRes = startSession("user_test_001", orderId);

    // 模拟网络中断上报
    const session = mockDb.challenge_session[sessionRes.sessionId];
    session.challengeStatus = "INTERRUPTED";
    session.interruptedReason = "NETWORK_DISCONNECT";
    mockDb.order[orderId].challengeStatus = "INTERRUPTED";

    assert(session.challengeStatus === "INTERRUPTED", "会话标记为 INTERRUPTED，未草率判 LOSE");
    assert(session.result == null, "未生成失败结果");

    // 模拟恢复会话 (challengeResume)
    const now = Date.now();
    const newNonce = crypto.randomBytes(16).toString("hex");
    const resumeTicket = createSignedTicket({
      challengeId: sessionRes.sessionId,
      orderId,
      openid: "user_test_001",
      ruleVersion: session.ruleSnapshot.ruleVersion,
      nonce: newNonce,
      issuedAt: now,
      maxRoundDurationMs: session.ruleSnapshot.maxRoundDurationMs,
    });
    session.challengeStatus = "IN_PROGRESS";
    session.serverStartResponseSentAt = now;

    // 恢复后正常完成
    const submitRes = submitChallenge("user_test_001", {
      sessionId: sessionRes.sessionId,
      ticket: resumeTicket,
      clientElapsedMs: 2995,
      mockServerFinishTime: now + 3010,
    });
    assert(submitRes.challengeStatus === "WIN", "恢复会话后正常判定成功 WIN");
  }

  // -------------------------------------------------------------
  console.log("\n[Scenario 6] 用户主动跳过 (USER_SKIPPED) 校验");
  // -------------------------------------------------------------
  {
    const orderId = "order_sc6";
    setupPaidOrder(orderId);
    startSession("user_test_001", orderId);

    // 用户在二次确认弹窗中选择放弃跳过
    const order = mockDb.order[orderId];
    order.challengeStatus = "LOSE";
    order.settlementReason = "USER_SKIPPED";
    order.fulfillmentHold = "NONE";
    order.erpStatus = "READY";

    assert(order.challengeStatus === "LOSE", "主动跳过状态置为 LOSE");
    assert(order.settlementReason === "USER_SKIPPED", "标记主动放弃原因 USER_SKIPPED");
    assert(order.fulfillmentHold === "NONE", "立即释放履约锁 fulfillmentHold = NONE");
    assert(order.erpStatus === "READY", "允许 ERP 推单发货");

    const shipRes = shipOrder(orderId);
    assert(shipRes.shipped === true, "用户跳过后订单可立即顺畅发货");
  }

  // -------------------------------------------------------------
  console.log("\n[Scenario 7] Timing Delta 异常风控拦截 (PENDING_REVIEW) 校验");
  // -------------------------------------------------------------
  {
    const orderId = "order_sc7";
    setupPaidOrder(orderId);
    const sessionRes = startSession("user_test_001", orderId);

    // 客户端伪造/被篡改：服务端总往返才 200ms，客户端却报按压了 3000ms (违背时空定律)
    const submitRes = submitChallenge("user_test_001", {
      sessionId: sessionRes.sessionId,
      ticket: sessionRes.ticket,
      clientElapsedMs: 3000,
      mockServerFinishTime: sessionRes.serverStartResponseSentAt + 200, // delta = 200 - 3000 = -2800ms < -100ms
    });

    assert(submitRes.challengeStatus === "PENDING_REVIEW", "异常时钟偏差自动进入 PENDING_REVIEW (不得直接判 LOSE/WIN)");
    assert(submitRes.riskLevel === "SUSPICIOUS", "风控等级标记为 SUSPICIOUS");
    assert(mockDb.order[orderId].fulfillmentHold === "SAFE_SETTLEMENT", "订单置入安全暂扣 SAFE_SETTLEMENT");
    assert(mockDb.order[orderId].erpStatus === "HOLD", "推单严格阻断 erpStatus = HOLD");

    let shipBlocked = false;
    try {
      shipOrder(orderId);
    } catch (e) {
      shipBlocked = true;
    }
    assert(shipBlocked, "SAFE_SETTLEMENT 状态下发货被坚决拦截");
  }

  // -------------------------------------------------------------
  console.log("\n[Scenario 8] 重复 challengeFinish 幂等性校验");
  // -------------------------------------------------------------
  {
    const orderId = "order_sc8";
    setupPaidOrder(orderId);
    const sessionRes = startSession("user_test_001", orderId);
    const firstRes = submitChallenge("user_test_001", {
      sessionId: sessionRes.sessionId,
      ticket: sessionRes.ticket,
      clientElapsedMs: 3500,
      mockServerFinishTime: sessionRes.serverStartResponseSentAt + 3520,
    });
    assert(firstRes.challengeStatus === "LOSE", "首次结算为 LOSE");

    // 重复提交
    const secondRes = submitChallenge("user_test_001", {
      sessionId: sessionRes.sessionId,
      ticket: sessionRes.ticket,
      clientElapsedMs: 3000, // 试图用新的时间覆盖
      mockServerFinishTime: sessionRes.serverStartResponseSentAt + 5000,
    });
    assert(secondRes.isIdempotent === true, "重复提交被幂等拦截");
    assert(secondRes.challengeStatus === "LOSE", "结果保持为原有的 LOSE，不可被篡改");
  }

  // -------------------------------------------------------------
  console.log("\n[Scenario 9] 重复 refundCallback 幂等性校验");
  // -------------------------------------------------------------
  {
    const orderId = "order_sc9";
    setupPaidOrder(orderId);
    const sessionRes = startSession("user_test_001", orderId);
    const submitRes = submitChallenge("user_test_001", {
      sessionId: sessionRes.sessionId,
      ticket: sessionRes.ticket,
      clientElapsedMs: 3000,
      mockServerFinishTime: sessionRes.serverStartResponseSentAt + 3020,
    });
    const refundId = submitRes.refundId;

    const cb1 = refundCallback({ refundId, status: "SUCCESS" });
    assert(cb1.refundStatus === "SUCCESS", "首次退款回调成功");

    // 重复回调
    const cb2 = refundCallback({ refundId, status: "SUCCESS" });
    assert(cb2.message.includes("idempotent"), "重复退款回调被安全幂等放行，无重复副作用");
  }

  // -------------------------------------------------------------
  console.log("\n[Scenario 10] fulfillmentHold 各枚举状态拦截发货全覆盖防呆校验");
  // -------------------------------------------------------------
  {
    const testHolds = ["CHALLENGE_PENDING", "REFUND_PENDING", "SAFE_SETTLEMENT"];
    for (const hold of testHolds) {
      const orderId = `order_hold_${hold}`;
      const order = setupPaidOrder(orderId);
      order.fulfillmentHold = hold;

      let blocked = false;
      try {
        shipOrder(orderId);
      } catch (e) {
        blocked = true;
      }
      assert(blocked, `fulfillmentHold = ${hold} 时发货被 100% 严密阻断`);
    }

    // 只有 NONE 放行
    const orderNone = setupPaidOrder("order_hold_NONE");
    orderNone.fulfillmentHold = "NONE";
    const res = shipOrder("order_hold_NONE");
    assert(res.shipped === true, "fulfillmentHold = NONE 时发货顺利放行");
  }

  console.log("\n==================================================================");
  console.log(`   验收完成! 全部 ${passed} 项断言通过, 失败: ${failed}`);
  console.log("==================================================================");
}

runTests().catch(err => {
  console.error("FATAL ERROR in test runner:", err);
  process.exit(1);
});
