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

module.exports = {
  getHmacSecret,
  createSignedTicket,
  verifyTicket,
};
