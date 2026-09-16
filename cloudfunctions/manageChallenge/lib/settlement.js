/**
 * Challenge 结算裁决核心逻辑 (settlement.js)
 */
const {
  ChallengeStatus,
  FulfillmentHoldStatus,
  ChallengeRefundStatus,
  ErpStatus,
  assertTransition,
} = require("./stateMachine");

function resolveSettlement({
  currentStatus,
  timingMetrics,
  riskAssessment,
  ruleSnapshot,
}) {
  const { clientElapsedMs } = timingMetrics;
  const { isSuspicious, reasons, riskLevel } = riskAssessment;

  let nextStatus;
  let isWinner = false;
  let fulfillmentHold;
  let erpStatus;
  let challengeRefundStatus;
  let reviewReason = null;

  if (isSuspicious) {
    // 命中风控异常，流转至待人工审查，绝不武断判 LOSE
    nextStatus = ChallengeStatus.PENDING_REVIEW;
    isWinner = false;
    fulfillmentHold = FulfillmentHoldStatus.SAFE_SETTLEMENT;
    erpStatus = ErpStatus.HOLD;
    challengeRefundStatus = ChallengeRefundStatus.NONE;
    reviewReason = reasons.join("; ");
  } else {
    // 正常规则区间比对 (successMinMs ~ successMaxMs)
    const minMs = ruleSnapshot.successMinMs;
    const maxMs = ruleSnapshot.successMaxMs;

    isWinner = clientElapsedMs >= minMs && clientElapsedMs <= maxMs;

    if (isWinner) {
      nextStatus = ChallengeStatus.WIN;
      fulfillmentHold = FulfillmentHoldStatus.REFUND_PENDING; // 获胜但退款未成功前，必须强制锁定履约！
      erpStatus = ErpStatus.HOLD;
      challengeRefundStatus = ChallengeRefundStatus.PENDING;
    } else {
      nextStatus = ChallengeStatus.LOSE;
      fulfillmentHold = FulfillmentHoldStatus.NONE; // 失败立刻释放，不阻碍正常商品发货
      erpStatus = ErpStatus.READY;
      challengeRefundStatus = ChallengeRefundStatus.NONE;
    }
  }

  // 严格状态机迁移断言
  assertTransition(currentStatus, nextStatus);

  const finalResult = {
    ...timingMetrics,
    isWinner,
    riskLevel,
    reviewReason,
  };

  return {
    challengeStatus: nextStatus,
    isWinner,
    fulfillmentHold,
    erpStatus,
    challengeRefundStatus,
    result: finalResult,
  };
}

module.exports = {
  resolveSettlement,
};
