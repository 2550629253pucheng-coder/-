/**
 * Hybrid Timing 混合双向计时比对模块 (timing.js)
 */

function evaluateTiming({
  serverStartResponseSentAt,
  serverFinishRequestReceivedAt,
  clientElapsedMs,
  ruleSnapshot,
}) {
  const clientElapsed = Math.round(Number(clientElapsedMs));
  const serverObservedDurationMs = serverFinishRequestReceivedAt - serverStartResponseSentAt;
  const timingDeltaMs = serverObservedDurationMs - clientElapsed;

  return {
    clientElapsedMs: clientElapsed,
    serverStartResponseSentAt,
    serverFinishRequestReceivedAt,
    serverObservedDurationMs,
    timingDeltaMs,
    targetTimeMs: ruleSnapshot.targetTimeMs,
    diffMs: Math.abs(clientElapsed - ruleSnapshot.targetTimeMs),
    ruleVersion: ruleSnapshot.ruleVersion,
  };
}

module.exports = {
  evaluateTiming,
};
