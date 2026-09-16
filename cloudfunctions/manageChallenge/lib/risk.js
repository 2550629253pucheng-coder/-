/**
 * Challenge 风控与异常审计评估 (risk.js)
 */

function assessRisk({
  timingMetrics,
  ruleSnapshot,
  resumeCount = 0,
  maxResumeCount = 1,
}) {
  const { clientElapsedMs, timingDeltaMs } = timingMetrics;
  const reasons = [];

  const maxRoundDurationMs = ruleSnapshot.maxRoundDurationMs || 10000;
  const negativeToleranceMs = ruleSnapshot.negativeToleranceMs || 100;
  const timingToleranceMs = ruleSnapshot.timingToleranceMs || 1000;

  // 1. 客户端用时违规超过单轮上限
  if (clientElapsedMs > maxRoundDurationMs) {
    reasons.push(`CLIENT_ELAPSED_EXCEEDED_MAX (${clientElapsedMs}ms > ${maxRoundDurationMs}ms)`);
  }

  // 2. 负偏差异常（服务端总耗时小于客户端自报用时）
  if (timingDeltaMs < -negativeToleranceMs) {
    reasons.push(`NEGATIVE_TIMING_DELTA_ANOMALY (${timingDeltaMs}ms < -${negativeToleranceMs}ms)`);
  }

  // 3. 时差超出容忍窗口（严重网络抖动或可疑客户端挂起）
  if (Math.abs(timingDeltaMs) > timingToleranceMs) {
    reasons.push(`TIMING_DELTA_EXCEEDED_TOLERANCE (|${timingDeltaMs}|ms > ${timingToleranceMs}ms)`);
  }

  // 4. 中断恢复次数超出上限
  if (resumeCount > maxResumeCount) {
    reasons.push(`RESUME_COUNT_EXCEEDED (${resumeCount} > ${maxResumeCount})`);
  }

  const isSuspicious = reasons.length > 0;

  return {
    riskLevel: isSuspicious ? "SUSPICIOUS" : "NORMAL",
    isSuspicious,
    reasons,
  };
}

module.exports = {
  assessRisk,
};
