const assert = require("assert");
const crypto = require("crypto");

// 确保测试环境下环境变量正确注入
process.env.CHALLENGE_HMAC_SECRET = "test_challenge_secret_key_12345678901234567890";
process.env.CHALLENGE_ACTIVITY_MODE = "TEST";
process.env.CHALLENGE_TEST_REFUND_MODE = "AUTO_SUCCESS";

const {
  ChallengeStatus,
  ChallengeRefundStatus,
  FulfillmentHoldStatus,
  ErpStatus,
  assertTransition,
} = require("../cloudfunctions/manageChallenge/lib/stateMachine");

const {
  getHmacSecret,
  createSignedTicket,
  verifyTicket,
  verifyTicketBinding,
} = require("../cloudfunctions/manageChallenge/lib/ticket");

const { evaluateTiming } = require("../cloudfunctions/manageChallenge/lib/timing");
const { assessRisk } = require("../cloudfunctions/manageChallenge/lib/risk");
const { resolveSettlement } = require("../cloudfunctions/manageChallenge/lib/settlement");

console.log("=== 正在运行 3秒挑战与核心交易链路安全自动化测试 ===");

// 1. 状态机合法性与非法转移拦截测试
console.log("\n[Test 1] 状态机与 SETTLING 状态转移测试");
assert.doesNotThrow(() => {
  assertTransition(ChallengeStatus.IN_PROGRESS, ChallengeStatus.SETTLING);
}, "IN_PROGRESS 必须允许转移至 SETTLING");

assert.doesNotThrow(() => {
  assertTransition(ChallengeStatus.SETTLING, ChallengeStatus.WIN);
  assertTransition(ChallengeStatus.SETTLING, ChallengeStatus.LOSE);
  assertTransition(ChallengeStatus.SETTLING, ChallengeStatus.PENDING_REVIEW);
}, "SETTLING 必须允许转移至 WIN/LOSE/PENDING_REVIEW");

assert.throws(() => {
  assertTransition(ChallengeStatus.WIN, ChallengeStatus.IN_PROGRESS);
}, /INVALID_STATE_TRANSITION/, "终态 WIN 严禁重入 IN_PROGRESS");

assert.throws(() => {
  assertTransition(ChallengeStatus.LOSE, ChallengeStatus.SETTLING);
}, /INVALID_STATE_TRANSITION/, "终态 LOSE 严禁转移至 SETTLING");

console.log("✓ 状态机转移断言通过");

// 2. Ticket 签名与时序防篡改测试
console.log("\n[Test 2] Ticket HMAC 签名与防篡改测试");
const now = Date.now();
const testTicket = createSignedTicket({
  challengeId: "cs_order_001",
  orderId: "order_001",
  openid: "user_test_openid",
  ruleVersion: "v1.0",
  nonce: "random_nonce_123",
  issuedAt: now,
  maxRoundDurationMs: 10000,
});

const verified = verifyTicket(testTicket);
assert.strictEqual(verified, true, "有效 Ticket 必须验签成功");
assert.strictEqual(testTicket.challengeId, "cs_order_001");
assert.strictEqual(testTicket.orderId, "order_001");

// 篡改测试
const tamperedTicket = { ...testTicket, signature: testTicket.signature.slice(0, -4) + "abcd" };
const tamperedVerified = verifyTicket(tamperedTicket);
assert.strictEqual(tamperedVerified, false, "篡改后的 Ticket 必须验签失败");

console.log("✓ Ticket HMAC 与防篡改校验通过");

// 3. Ticket-Session 强绑定与防串单测试 (verifyTicketBinding)
console.log("\n[Test 3] Ticket-Session 强绑定与防串单防旧票校验测试");
const mockSession = {
  _id: "cs_order_001",
  orderId: "order_001",
  _openid: "user_test_openid",
  latestTicketNonce: "random_nonce_123",
  latestTicket: testTicket,
  ruleSnapshot: { ruleVersion: "v1.0" },
};

const bindingOk = verifyTicketBinding(testTicket, mockSession, "user_test_openid");
assert.strictEqual(bindingOk.valid, true, "真实绑定的 Session 必须校验通过");

// 伪造不同 OpenID
const crossUser = verifyTicketBinding(testTicket, mockSession, "attacker_openid");
assert.strictEqual(crossUser.valid, false, "不同 OpenID 必须拦截");
assert.strictEqual(crossUser.reason, "TICKET_OPENID_MISMATCH");

// 伪造不同 OrderID 会话
const wrongOrderSession = { ...mockSession, orderId: "order_999" };
const crossOrder = verifyTicketBinding(testTicket, wrongOrderSession, "user_test_openid");
assert.strictEqual(crossOrder.valid, false, "不同 OrderID 跨单使用必须拦截");
assert.strictEqual(crossOrder.reason, "TICKET_ORDER_ID_MISMATCH");

// 旧 Nonce 作废测试 (重放攻击)
const expiredNonceSession = { ...mockSession, latestTicketNonce: "new_nonce_456" };
const replayTicket = verifyTicketBinding(testTicket, expiredNonceSession, "user_test_openid");
assert.strictEqual(replayTicket.valid, false, "已被刷新的旧 Ticket/Nonce 必须被拦截");
assert.strictEqual(replayTicket.reason, "TICKET_NONCE_EXPIRED_OR_MISMATCH");

console.log("✓ Ticket-Session 强绑定防串单防重放通过");

// 4. Hybrid Timing 混合时序裁定测试
console.log("\n[Test 4] Hybrid Timing 混合时钟与双端时延评估测试");
const rule = {
  ruleVersion: "v1.0",
  targetTimeMs: 3000,
  successMinMs: 2990,
  successMaxMs: 3010,
  maxRoundDurationMs: 10000,
  timingToleranceMs: 300,
  negativeToleranceMs: 50,
};

// 模拟正常获胜
const winMetrics = evaluateTiming({
  serverStartResponseSentAt: 10000,
  serverFinishRequestReceivedAt: 13080, // 网络总往返 ~80ms
  clientElapsedMs: 3004,
  ruleSnapshot: rule,
});
assert.strictEqual(winMetrics.clientElapsedMs, 3004);
assert.strictEqual(winMetrics.timingDeltaMs >= 0, true);

const winRisk = assessRisk({
  timingMetrics: winMetrics,
  ruleSnapshot: rule,
});
assert.strictEqual(winRisk.isSuspicious, false);

const winSettlement = resolveSettlement({
  currentStatus: ChallengeStatus.SETTLING,
  timingMetrics: winMetrics,
  riskAssessment: winRisk,
  ruleSnapshot: rule,
});
assert.strictEqual(winSettlement.challengeStatus, ChallengeStatus.WIN);
assert.strictEqual(winSettlement.challengeRefundStatus, ChallengeRefundStatus.PENDING);
assert.strictEqual(winSettlement.fulfillmentHold, FulfillmentHoldStatus.REFUND_PENDING);
assert.strictEqual(winSettlement.erpStatus, ErpStatus.HOLD);

// 模拟时钟穿越作弊 (服务端耗时严重小于客户端耗时)
const cheatMetrics = evaluateTiming({
  serverStartResponseSentAt: 10000,
  serverFinishRequestReceivedAt: 11000, // 服务端只过了 1000ms
  clientElapsedMs: 3000, // 客户端自称跑了 3000ms
  ruleSnapshot: rule,
});
const cheatRisk = assessRisk({
  timingMetrics: cheatMetrics,
  ruleSnapshot: rule,
});
assert.strictEqual(cheatRisk.isSuspicious, true);
const cheatSettlement = resolveSettlement({
  currentStatus: ChallengeStatus.SETTLING,
  timingMetrics: cheatMetrics,
  riskAssessment: cheatRisk,
  ruleSnapshot: rule,
});
assert.strictEqual(cheatSettlement.challengeStatus, ChallengeStatus.PENDING_REVIEW);
assert.strictEqual(cheatSettlement.fulfillmentHold, FulfillmentHoldStatus.SAFE_SETTLEMENT);

console.log("✓ Hybrid Timing 时钟比对与风控裁决断言通过");

// 5. 履约暂扣与 ERP 解耦状态测试
console.log("\n[Test 5] 履约暂扣状态断言测试");
// LOSE 或 SKIP: 释放暂扣，进入正常发货
const loseSettlement = resolveSettlement({
  currentStatus: ChallengeStatus.SETTLING,
  timingMetrics: { clientInTargetRange: false, timingGapMs: 100, serverElapsedMs: 3500 },
  riskAssessment: { safe: true },
  ruleSnapshot: rule,
});
assert.strictEqual(loseSettlement.challengeStatus, ChallengeStatus.LOSE);
assert.strictEqual(loseSettlement.fulfillmentHold, FulfillmentHoldStatus.NONE);
assert.strictEqual(loseSettlement.erpStatus, ErpStatus.READY);

console.log("✓ 履约暂扣与 ERP 解耦状态断言通过");

console.log("\n========================================================");
console.log("🎉 ALL 5 CORE SAFETY & STATE MACHINE TESTS PASSED 100%!");
console.log("========================================================\n");
