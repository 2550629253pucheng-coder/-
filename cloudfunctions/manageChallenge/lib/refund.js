/**
 * Challenge 免单退款核心模块 (refund.js)
 * 严格独立于普通售后 after-service，单号确定性，金额服务端确定不可篡改
 */

/**
 * 构建确定性唯一退款单号，防重复建单
 */
function buildDeterministicRefundKeys(sessionId, orderId) {
  const outRefundNo = `CR_${orderId}`;
  const refundDocId = `CHALLENGE_REFUND_${sessionId}`;
  return { outRefundNo, refundDocId };
}

/**
 * 校验并获取订单实际支付金额（分）
 */
function resolvePaidAmountCents(order) {
  if (!order) {
    throw new Error("ORDER_NOT_FOUND");
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
  const { outRefundNo, refundDocId } = buildDeterministicRefundKeys(sessionId, orderId);
  const now = Date.now();

  return {
    _id: refundDocId,
    orderId,
    sessionId,
    sourceType: "CHALLENGE_FREE_ORDER", // 严格区别于售后 AFTER_SALE
    outRefundNo,
    amount: paidCents,
    amountYuan: (paidCents / 100).toFixed(2),
    status: isTestMode && testRefundMode === "AUTO_SUCCESS" ? "SUCCESS" : "PROCESSING",
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
