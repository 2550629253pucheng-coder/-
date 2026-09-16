/**
 * Challenge 免单退款核心模块 (refund.js)
 * 严格独立于普通售后 after-service，单号确定性，金额服务端确定不可篡改
 */

/**
 * 构建确定性唯一退款单号与文档ID体系，防重复建单与ID漂移
 * 整个项目统一使用：
 * refundDocId = CHALLENGE_REFUND_{orderId}
 * outRefundNo = CR_{orderId}
 * refundTaskId = REFUND_TASK_{orderId}
 */
function buildDeterministicRefundKeys(arg1, arg2) {
  let sessionId;
  let orderId;
  if (typeof arg1 === "object" && arg1 !== null) {
    sessionId = arg1.sessionId;
    orderId = arg1.orderId;
  } else {
    sessionId = arg1;
    orderId = arg2;
  }

  if (!orderId) {
    throw new Error("ORDER_ID_REQUIRED_FOR_REFUND_KEYS");
  }

  const refundDocId = `CHALLENGE_REFUND_${orderId}`;
  const outRefundNo = `CR_${orderId}`;
  const refundTaskId = `REFUND_TASK_${orderId}`;

  return {
    refundDocId,
    outRefundNo,
    refundTaskId,
  };
}

/**
 * 校验并获取订单实际支付金额（分）
 * LIVE 模式严禁 fallback 至客户端衍生字段，只认 order.paidAmountCents
 */
function resolvePaidAmountCents(order, isLiveMode = false) {
  if (!order) {
    throw new Error("ORDER_NOT_FOUND");
  }

  // LIVE 模式严禁从客户端衍生字段 fallback，只认 order.paidAmountCents 权威打点
  if (isLiveMode) {
    if (order.paidAmountCents == null || Number(order.paidAmountCents) <= 0) {
      throw new Error("INVALID_PAID_AMOUNT_SNAPSHOT");
    }
    return Number(order.paidAmountCents);
  }

  let totalFee = null;
  if (order.paidAmountCents != null) {
    totalFee = Number(order.paidAmountCents);
  } else if (order.wechatPayInfo && order.wechatPayInfo.totalFee != null) {
    totalFee = Number(order.wechatPayInfo.totalFee);
  } else if (order.orderSummary && order.orderSummary.totalPayAmount != null) {
    totalFee = Math.round(Number(order.orderSummary.totalPayAmount) * 100);
  }

  if (totalFee == null || Number.isNaN(totalFee) || totalFee <= 0) {
    throw new Error("INVALID_ORDER_PAID_AMOUNT");
  }

  // 金额一致性双重校验
  if (order.orderSummary && order.orderSummary.totalPayAmount != null) {
    const expectedCents = Math.round(Number(order.orderSummary.totalPayAmount) * 100);
    if (Math.abs(expectedCents - totalFee) > 1) {
      throw new Error(`PAID_AMOUNT_MISMATCH: payAmount=${expectedCents}, totalFee=${totalFee}`);
    }
  }

  return totalFee;
}

/**
 * 构建 Challenge 退款单据结构
 */
function buildChallengeRefundDoc({
  sessionId,
  orderId,
  paidCents,
  isTestMode = false,
  testRefundMode = "AUTO_SUCCESS",
}) {
  const { outRefundNo, refundDocId } = buildDeterministicRefundKeys({ sessionId, orderId });
  const now = Date.now();

  return {
    _id: refundDocId,
    orderId,
    sessionId,
    sourceType: "CHALLENGE_FREE_ORDER", // 严格区别于售后 AFTER_SALE
    outRefundNo,
    amount: paidCents,
    amountYuan: (paidCents / 100).toFixed(2),
    status: isTestMode && testRefundMode === "AUTO_SUCCESS" ? "SUCCESS" : "PENDING",
    wechatRefundId: isTestMode ? `test_wx_rf_${now}` : null,
    errorCode: null,
    errorMessage: null,
    testMode: isTestMode,
    testRefundMode,
    createdAt: now,
    updatedAt: now,
  };
}

module.exports = {
  buildDeterministicRefundKeys,
  resolvePaidAmountCents,
  buildChallengeRefundDoc,
};
