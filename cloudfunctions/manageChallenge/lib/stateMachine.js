/**
 * Challenge 核心状态机与严格白名单规则 (stateMachine.js)
 */

const ChallengeStatus = {
  ELIGIBLE: "ELIGIBLE",             // 具备资格未开始
  IN_PROGRESS: "IN_PROGRESS",       // 正在挑战
  WIN: "WIN",                       // 挑战成功
  LOSE: "LOSE",                     // 挑战失败
  PENDING_REVIEW: "PENDING_REVIEW", // 命中风控异常，待人工审查
  INTERRUPTED: "INTERRUPTED",       // 网络或技术异常中断
  EXPIRED: "EXPIRED",               // 超时作废
};

const FulfillmentHoldStatus = {
  NONE: "NONE",                             // 无暂扣，允许发货/推ERP
  CHALLENGE_PENDING: "CHALLENGE_PENDING",   // 挑战进行中暂扣
  REFUND_PENDING: "REFUND_PENDING",         // 挑战获胜但退款尚未成功，退款暂扣
  SAFE_SETTLEMENT: "SAFE_SETTLEMENT",       // 风控审查或安全结算中暂扣
};

const ChallengeRefundStatus = {
  NONE: "NONE",
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
};

const ErpStatus = {
  HOLD: "HOLD",
  READY: "READY",
  SYNCED: "SYNCED",
  FAILED: "FAILED",
};

// 严格合法的状态转移白名单
const ALLOWED_TRANSITIONS = {
  ELIGIBLE: [ChallengeStatus.IN_PROGRESS, ChallengeStatus.LOSE, ChallengeStatus.EXPIRED],
  IN_PROGRESS: [
    ChallengeStatus.WIN,
    ChallengeStatus.LOSE,
    ChallengeStatus.PENDING_REVIEW,
    ChallengeStatus.INTERRUPTED,
    ChallengeStatus.EXPIRED,
  ],
  INTERRUPTED: [
    ChallengeStatus.IN_PROGRESS,
    ChallengeStatus.PENDING_REVIEW,
    ChallengeStatus.EXPIRED,
  ],
  WIN: [],             // 终态，禁止任何后续客户端/自动状态转移
  LOSE: [],            // 终态，禁止任何后续状态转移
  PENDING_REVIEW: [],  // 风控审查中，客户端禁止修改，仅后台管理员审计流转
  EXPIRED: [],         // 终态，禁止恢复
};

function canTransition(from, to) {
  if (!from || !to) return false;
  if (from === to) return true; // 同态幂等
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`INVALID_STATE_TRANSITION: Cannot transition from ${from} to ${to}`);
  }
}

module.exports = {
  ChallengeStatus,
  FulfillmentHoldStatus,
  ChallengeRefundStatus,
  ErpStatus,
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransition,
};
