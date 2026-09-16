/**
 * Challenge HMAC Ticket 签发与验签 (ticket.js)
 * 严格零信任架构：HMAC 密钥仅在服务端内存和云函数环境变量中持有
 */
const crypto = require("crypto");

function getHmacSecret() {
  const secret = process.env.CHALLENGE_HMAC_SECRET;
  if (!secret) {
    throw new Error("CHALLENGE_HMAC_SECRET_NOT_CONFIGURED");
  }
  return secret;
}

/**
 * 签发不可篡改的 Ticket
 */
function createSignedTicket(
  { challengeId, orderId, openid, ruleVersion, nonce, issuedAt, maxRoundDurationMs },
  secret = getHmacSecret()
) {
  if (!challengeId || !orderId || !openid || !ruleVersion || !nonce || !issuedAt) {
    throw new Error("TICKET_PARAMS_INCOMPLETE");
  }
  const payloadStr = `${challengeId}:${orderId}:${openid}:${ruleVersion}:${nonce}:${issuedAt}:${maxRoundDurationMs}`;
  const signature = crypto.createHmac("sha256", secret).update(payloadStr).digest("hex");
  return {
    challengeId,
    orderId,
    openid,
    ruleVersion,
    nonce,
    issuedAt,
    maxRoundDurationMs,
    signature,
  };
}

/**
 * 验证客户端回传的 Ticket
 * 使用 crypto.timingSafeEqual 抵抗时序攻击，并做 Buffer 长度保护
 */
function verifyTicket(ticket, secret = getHmacSecret()) {
  if (!ticket || !ticket.signature) {
    return false;
  }
  const { challengeId, orderId, openid, ruleVersion, nonce, issuedAt, maxRoundDurationMs, signature } = ticket;
  if (!challengeId || !orderId || !openid || !ruleVersion || !nonce || !issuedAt) {
    return false;
  }

  const payloadStr = `${challengeId}:${orderId}:${openid}:${ruleVersion}:${nonce}:${issuedAt}:${maxRoundDurationMs}`;
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadStr).digest("hex");

  const bufExpected = Buffer.from(expectedSig, "utf8");
  const bufActual = Buffer.from(signature, "utf8");

  if (bufExpected.length !== bufActual.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(bufExpected, bufActual);
  } catch (err) {
    return false;
  }
}

/**
 * 强校验 Ticket 与 Session、OpenID 的一致性绑定
 * 阻止：跨Session重放、旧Ticket重放、篡改openid、跨订单套利
 */
function verifyTicketBinding(ticket, session, openId) {
  if (!ticket || !session) {
    return { valid: false, reason: "MISSING_TICKET_OR_SESSION" };
  }

  // 1. 签名基础防篡改校验
  if (!verifyTicket(ticket)) {
    return { valid: false, reason: "INVALID_TICKET_SIGNATURE" };
  }

  // 2. 强绑定 Challenge Session ID
  if (ticket.challengeId !== session._id) {
    return { valid: false, reason: "TICKET_SESSION_ID_MISMATCH" };
  }

  // 3. 强绑定 订单号
  if (ticket.orderId !== session.orderId) {
    return { valid: false, reason: "TICKET_ORDER_ID_MISMATCH" };
  }

  // 4. 强绑定 微信用户 OpenID
  if (openId && (ticket.openid !== openId || session._openid !== openId)) {
    return { valid: false, reason: "TICKET_OPENID_MISMATCH" };
  }

  // 5. 强绑定 规则版本
  const sessionRuleVersion =
    session.ruleSnapshot && session.ruleSnapshot.ruleVersion;
  if (sessionRuleVersion && ticket.ruleVersion !== sessionRuleVersion) {
    return { valid: false, reason: "TICKET_RULE_VERSION_MISMATCH" };
  }

  // 6. 强绑定 最新 Nonce（旧 Ticket 立即失效）
  if (session.latestTicketNonce && ticket.nonce !== session.latestTicketNonce) {
    return { valid: false, reason: "TICKET_NONCE_EXPIRED_OR_MISMATCH" };
  }

  // 7. 强绑定 服务器下发 Ticket 的基准时间戳
  if (
    session.serverStartResponseSentAt &&
    Number(ticket.issuedAt) !== Number(session.serverStartResponseSentAt)
  ) {
    return { valid: false, reason: "TICKET_ISSUED_AT_MISMATCH" };
  }

  // 8. 强绑定 最大单局时长
  const sessionMaxDuration =
    session.ruleSnapshot && session.ruleSnapshot.maxRoundDurationMs;
  if (
    sessionMaxDuration &&
    Number(ticket.maxRoundDurationMs) !== Number(sessionMaxDuration)
  ) {
    return { valid: false, reason: "TICKET_MAX_DURATION_MISMATCH" };
  }

  return { valid: true };
}

module.exports = {
  getHmacSecret,
  createSignedTicket,
  verifyTicket,
  verifyTicketBinding,
};
