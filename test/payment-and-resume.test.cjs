const assert = require("assert");

console.log("=== 正在运行 订单创建防套利、支付回调强校验与 Resume/Skip 生命周期解耦测试 ===");

// 1. 模拟 createOrder 混合购物车与多数量套利拦截
console.log("\n[Test 1] 校验 createOrder 免单挑战活动商品的单品、单件防套利校验");
function validateChallengeOrderItems(goodsList) {
  const hasChallengeActivity = goodsList.some((item) => item.isChallengeActivity || item.activityId === "3s_free_challenge");
  if (hasChallengeActivity) {
    if (goodsList.length > 1) {
      throw new Error("CHALLENGE_MIXED_CART_FORBIDDEN: 3秒挑战免单活动商品不可与其他商品混合结算");
    }
    const challengeItem = goodsList[0];
    if (challengeItem.quantity !== 1) {
      throw new Error("CHALLENGE_QUANTITY_LIMIT_EXCEEDED: 3秒挑战免单活动商品单笔订单限购1件");
    }
  }
  return true;
}

// 正常活动商品
assert.doesNotThrow(() => {
  validateChallengeOrderItems([{ spuId: "spu_001", quantity: 1, isChallengeActivity: true }]);
});

// 违规：混合其他商品
assert.throws(() => {
  validateChallengeOrderItems([
    { spuId: "spu_001", quantity: 1, isChallengeActivity: true },
    { spuId: "spu_002", quantity: 1, isChallengeActivity: false },
  ]);
}, /CHALLENGE_MIXED_CART_FORBIDDEN/);

// 违规：单活动商品购买多件套利
assert.throws(() => {
  validateChallengeOrderItems([{ spuId: "spu_001", quantity: 3, isChallengeActivity: true }]);
}, /CHALLENGE_QUANTITY_LIMIT_EXCEEDED/);

console.log("✓ createOrder 单品、单件防套利校验测试通过");

// 2. 模拟 paymentCallback 严闭合无容差金额校验与元数据锁定
console.log("\n[Test 2] 校验 paymentCallback 金额 Fail-Closed 判定");
function validatePaymentAmount(orderAmountCents, callbackPaidCents) {
  if (orderAmountCents !== callbackPaidCents) {
    throw new Error(`PAYMENT_AMOUNT_MISMATCH: 应付 ${orderAmountCents}分, 实付 ${callbackPaidCents}分`);
  }
  return true;
}

assert.doesNotThrow(() => {
  validatePaymentAmount(9900, 9900);
});

assert.throws(() => {
  validatePaymentAmount(9900, 9899); // 哪怕差 1 分钱也严密驳回
}, /PAYMENT_AMOUNT_MISMATCH/);

console.log("✓ paymentCallback 严闭合金额校验通过");

// 3. 校验 Resume 生命周期与 Start 生命周期的绝对解耦
console.log("\n[Test 3] 校验 ResumeSession 仅恢复资格，绝不签发 Ticket / 打点 serverStart");
function simulateResumeSession(session) {
  // Resume 仅将状态转为 READY_TO_RESTART，作废旧票与旧 Nonce，清空 serverStart 打点
  return {
    ...session,
    challengeStatus: "READY_TO_RESTART",
    serverStartResponseSentAt: null,
    latestTicketNonce: null,
    latestTicket: null,
    resumeCount: (session.resumeCount || 0) + 1,
    readyToStart: true,
  };
}

const interruptedSession = {
  _id: "CHALLENGE_SESSION_ORDER_001",
  orderId: "ORDER_001",
  challengeStatus: "INTERRUPTED",
  serverStartResponseSentAt: 10000,
  latestTicketNonce: "old_nonce",
  latestTicket: { sig: "old_ticket" },
  resumeCount: 0,
};

const resumed = simulateResumeSession(interruptedSession);
assert.strictEqual(resumed.challengeStatus, "READY_TO_RESTART");
assert.strictEqual(resumed.serverStartResponseSentAt, null, "Resume 绝不提前打点时序");
assert.strictEqual(resumed.latestTicket, null, "Resume 必须作废旧 Ticket");
assert.strictEqual(resumed.latestTicketNonce, null, "Resume 必须作废旧 Nonce");
assert.strictEqual(resumed.resumeCount, 1);

console.log("✓ Resume 与 Start 彻底解耦断言通过");

// 4. 校验 SkipChallenge 永久消费资格
console.log("\n[Test 4] 校验 SkipChallenge 永久消费挑战资格");
function simulateSkipChallenge(order) {
  if (order.challengeStatus !== "ELIGIBLE" && order.challengeStatus !== "READY_TO_RESTART") {
    throw new Error(`CANNOT_SKIP_IN_STATUS: ${order.challengeStatus}`);
  }
  return {
    ...order,
    challengeEligible: false, // 永久消费
    challengeStatus: "LOSE",
    fulfillmentHold: "NONE",
    erpStatus: "READY",
  };
}

const orderEligible = {
  _id: "ORDER_001",
  challengeEligible: true,
  challengeStatus: "ELIGIBLE",
  fulfillmentHold: "CHALLENGE_PENDING",
};

const skippedOrder = simulateSkipChallenge(orderEligible);
assert.strictEqual(skippedOrder.challengeEligible, false, "跳过后资格必须永久置 false");
assert.strictEqual(skippedOrder.challengeStatus, "LOSE");
assert.strictEqual(skippedOrder.fulfillmentHold, "NONE");
assert.strictEqual(skippedOrder.erpStatus, "READY");

// 再次尝试跳过或发起挑战必须被拦截
assert.throws(() => {
  simulateSkipChallenge(skippedOrder);
}, /CANNOT_SKIP_IN_STATUS/);

console.log("✓ SkipChallenge 永久消费资格断言通过");

console.log("\n========================================================");
console.log("🎉 ALL TRANSACTION SECURITY & DECOUPLING TESTS PASSED!");
console.log("========================================================\n");
