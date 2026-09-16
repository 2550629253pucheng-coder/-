const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

// 集合常量
const ORDER_COLLECTION = "order";
const CHALLENGE_SESSION_COLLECTION = "challenge_session";
const CHALLENGE_RULES_COLLECTION = "challenge_rules";
const REFUNDS_COLLECTION = "refunds";

// 活动模式: TEST (测试模式) | LIVE (正式模式)
const ACTIVITY_MODE = process.env.ACTIVITY_MODE || "TEST";

// HMAC 秘钥仅服务端持有，绝对禁止下发客户端或写入小程序前端
const CHALLENGE_HMAC_SECRET =
  process.env.CHALLENGE_HMAC_SECRET || "RTL_CHALLENGE_SECRET_KEY_2026";

// 默认基准规则 (当数据库规则表尚未预置时作为防御保障)
const DEFAULT_ACTIVE_RULE = {
  ruleId: "RULE_3S_TEST_V1",
  gameType: "THREE_SECOND_HOLD",
  ruleVersion: "TEST_V1",
  targetTimeMs: 3000,
  successMinMs: 2990,
  successMaxMs: 3010,
  maxRoundDurationMs: 10000,
  timingToleranceMs: 1000, // 初始测试容忍阈值 (ms)
  negativeToleranceMs: 100, // 时钟前移/负偏差容忍阈值 (ms)
  status: "ACTIVE",
  effectiveFrom: 0,
  effectiveTo: 4102444800000,
};

/**
 * 挑战状态枚举
 */
const ChallengeStatus = {
  ELIGIBLE: "ELIGIBLE", // 具备资格未开始
  IN_PROGRESS: "IN_PROGRESS", // 正在挑战
  WIN: "WIN", // 挑战成功
  LOSE: "LOSE", // 挑战失败
  PENDING_REVIEW: "PENDING_REVIEW", // 命中风控异常，待人工审查
  INTERRUPTED: "INTERRUPTED", // 网络或技术异常中断
  EXPIRED: "EXPIRED", // 超时作废
};

/**
 * 履约暂扣状态枚举
 */
const FulfillmentHoldStatus = {
  NONE: "NONE", // 无暂扣，允许发货/推ERP
  CHALLENGE_PENDING: "CHALLENGE_PENDING", // 挑战进行中暂扣
  REFUND_PENDING: "REFUND_PENDING", // 挑战获胜但退款尚未成功，退款暂扣
  SAFE_SETTLEMENT: "SAFE_SETTLEMENT", // 风控审查或安全结算中暂扣
};

/**
 * 挑战退款状态枚举
 */
const ChallengeRefundStatus = {
  NONE: "NONE",
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
};

/**
 * ERP 推单状态枚举
 */
const ErpStatus = {
  HOLD: "HOLD",
  READY: "READY",
  SYNCED: "SYNCED",
  FAILED: "FAILED",
};

/**
 * 获取当前生效的规则
 */
async function getEffectiveRule() {
  try {
    const now = Date.now();
    const res = await db
      .collection(CHALLENGE_RULES_COLLECTION)
      .where({
        status: "ACTIVE",
        effectiveFrom: _.lte(now),
        effectiveTo: _.gte(now),
      })
      .orderBy("effectiveFrom", "desc")
      .limit(1)
      .get();

    if (res.data && res.data.length > 0) {
      return res.data[0];
    }
  } catch (err) {
    console.warn("[getEffectiveRule] read rules error, using default fallback:", err);
  }
  return DEFAULT_ACTIVE_RULE;
}

/**
 * 生成服务端防篡改签名 Ticket
 */
function createSignedTicket({
  challengeId,
  orderId,
  openid,
  ruleVersion,
  nonce,
  issuedAt,
  maxRoundDurationMs,
}) {
  const payloadStr = `${challengeId}:${orderId}:${openid}:${ruleVersion}:${nonce}:${issuedAt}:${maxRoundDurationMs}`;
  const signature = crypto
    .createHmac("sha256", CHALLENGE_HMAC_SECRET)
    .update(payloadStr)
    .digest("hex");

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
 */
function verifyTicket(ticket) {
  if (!ticket || !ticket.signature) return false;
  const payloadStr = `${ticket.challengeId}:${ticket.orderId}:${ticket.openid}:${ticket.ruleVersion}:${ticket.nonce}:${ticket.issuedAt}:${ticket.maxRoundDurationMs}`;
  const expectedSig = crypto
    .createHmac("sha256", CHALLENGE_HMAC_SECRET)
    .update(payloadStr)
    .digest("hex");
  return expectedSig === ticket.signature;
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openId = wxContext.OPENID;
  const { action, payload = {} } = event || {};

  if (!openId) {
    return { success: false, message: "User not logged in" };
  }

  try {
    switch (action) {
      case "startSession":
      case "challengeStart":
        return await handleStartSession(openId, payload);

      case "submitChallenge":
      case "challengeFinish":
        return await handleSubmitChallenge(openId, payload);

      case "resumeSession":
      case "challengeResume":
        return await handleResumeSession(openId, payload);

      case "recordInterrupted":
        return await handleRecordInterrupted(openId, payload);

      case "skipChallenge":
      case "settleHold":
        return await handleSkipChallenge(openId, payload);

      case "refundCallback":
        return await handleRefundCallback(payload);

      case "getSession":
        return await handleGetSession(openId, payload);

      default:
        return { success: false, message: `Unknown action: ${action}` };
    }
  } catch (err) {
    console.error(`[manageChallenge] ${action} failed:`, err);
    return { success: false, message: err.message || "Internal server error" };
  }
};

/**
 * 1. 启动或初始化挑战会话 (challengeStart)
 * - 读取并锁定生效规则 (ruleSnapshot)，禁止后续改动影响已有挑战
 * - 生成仅在服务端持有的 HMAC Ticket
 * - 记录 serverStartResponseSentAt
 * - 订单履约暂扣状态置为 CHALLENGE_PENDING
 */
async function handleStartSession(openId, { orderId }) {
  if (!orderId) {
    throw new Error("OrderId required");
  }

  // 查询订单
  const orderRes = await db.collection(ORDER_COLLECTION).doc(orderId).get();
  const order = orderRes.data;
  if (!order) {
    throw new Error("订单不存在");
  }
  if (order._openid !== openId) {
    throw new Error("无权操作此订单");
  }

  // 必须是已付款订单 (待发货/待收货等)
  if (order.status === "PENDING_PAYMENT" || order.status === "CANCELED_NOT_PAYMENT") {
    throw new Error("订单尚未完成支付，无法发起免单挑战");
  }

  // 检查是否已有此订单的挑战会话
  const sessionRes = await db
    .collection(CHALLENGE_SESSION_COLLECTION)
    .where({ orderId, _openid: openId })
    .limit(1)
    .get();

  const now = Date.now();

  if (sessionRes.data && sessionRes.data.length > 0) {
    const existingSession = sessionRes.data[0];

    // 如果已经是终态 (WIN, LOSE, PENDING_REVIEW, EXPIRED)，直接返回结果
    if (
      existingSession.challengeStatus === ChallengeStatus.WIN ||
      existingSession.challengeStatus === ChallengeStatus.LOSE ||
      existingSession.challengeStatus === ChallengeStatus.PENDING_REVIEW ||
      existingSession.challengeStatus === ChallengeStatus.EXPIRED
    ) {
      return {
        success: true,
        data: {
          sessionId: existingSession._id,
          orderId: existingSession.orderId,
          challengeStatus: existingSession.challengeStatus,
          challengeCompleted: true,
          result: existingSession.result || null,
          ruleSnapshot: existingSession.ruleSnapshot,
          activityMode: existingSession.activityMode || ACTIVITY_MODE,
        },
      };
    }

    // 若会话处于 INTERRUPTED，允许恢复
    if (existingSession.challengeStatus === ChallengeStatus.INTERRUPTED) {
      return await handleResumeSession(openId, { sessionId: existingSession._id });
    }

    // 仍在进行中的会话，更新并重新签发 Ticket
    const nonce = crypto.randomBytes(16).toString("hex");
    const serverStartResponseSentAt = now;
    const ticket = createSignedTicket({
      challengeId: existingSession._id,
      orderId,
      openid: openId,
      ruleVersion: existingSession.ruleSnapshot.ruleVersion,
      nonce,
      issuedAt: serverStartResponseSentAt,
      maxRoundDurationMs: existingSession.ruleSnapshot.maxRoundDurationMs,
    });

    await db.collection(CHALLENGE_SESSION_COLLECTION).doc(existingSession._id).update({
      data: {
        serverStartResponseSentAt,
        latestTicketNonce: nonce,
        challengeStatus: ChallengeStatus.IN_PROGRESS,
        updatedAt: now,
      },
    });

    return {
      success: true,
      data: {
        sessionId: existingSession._id,
        orderId: existingSession.orderId,
        challengeStatus: ChallengeStatus.IN_PROGRESS,
        challengeCompleted: false,
        serverStartResponseSentAt,
        ticket,
        ruleSnapshot: existingSession.ruleSnapshot,
        activityMode: existingSession.activityMode || ACTIVITY_MODE,
      },
    };
  }

  // 全新创建挑战会话并锁定规则版本
  const rule = await getEffectiveRule();
  const ruleSnapshot = {
    ruleId: rule.ruleId,
    gameType: rule.gameType,
    ruleVersion: rule.ruleVersion,
    targetTimeMs: rule.targetTimeMs,
    successMinMs: rule.successMinMs,
    successMaxMs: rule.successMaxMs,
    maxRoundDurationMs: rule.maxRoundDurationMs,
    timingToleranceMs: rule.timingToleranceMs,
    negativeToleranceMs: rule.negativeToleranceMs,
  };

  const serverStartResponseSentAt = now;
  const nonce = crypto.randomBytes(16).toString("hex");

  const newSessionDoc = {
    orderId,
    _openid: openId,
    activityMode: ACTIVITY_MODE,
    challengeStatus: ChallengeStatus.IN_PROGRESS,
    ruleSnapshot,
    serverStartResponseSentAt,
    latestTicketNonce: nonce,
    attempts: 0,
    maxAttempts: 1, // 严格每单一次
    createdAt: now,
    updatedAt: now,
  };

  const addRes = await db.collection(CHALLENGE_SESSION_COLLECTION).add({
    data: newSessionDoc,
  });

  const sessionId = addRes._id;

  // 生成合法 Ticket
  const ticket = createSignedTicket({
    challengeId: sessionId,
    orderId,
    openid: openId,
    ruleVersion: ruleSnapshot.ruleVersion,
    nonce,
    issuedAt: serverStartResponseSentAt,
    maxRoundDurationMs: ruleSnapshot.maxRoundDurationMs,
  });

  // 更新订单：保持主状态不变，设置独立字段与枚举值
  await db.collection(ORDER_COLLECTION).doc(orderId).update({
    data: {
      challengeStatus: ChallengeStatus.IN_PROGRESS,
      fulfillmentHold: FulfillmentHoldStatus.CHALLENGE_PENDING,
      erpStatus: ErpStatus.HOLD,
      updatedAt: now,
    },
  });

  return {
    success: true,
    data: {
      sessionId,
      orderId,
      challengeStatus: ChallengeStatus.IN_PROGRESS,
      challengeCompleted: false,
      serverStartResponseSentAt,
      ticket,
      ruleSnapshot,
      activityMode: ACTIVITY_MODE,
    },
  };
}

/**
 * 2. 提交挑战结果 (challengeFinish)
 * - 记录 serverFinishRequestReceivedAt
 * - 校验签名 Ticket
 * - 计算 Hybrid Timing (clientElapsedMs, serverObservedDurationMs, timingDeltaMs)
 * - 执行风控判定 (abs(timingDeltaMs) > timingToleranceMs) -> 异常进入 PENDING_REVIEW
 * - 执行规则判定 (successMinMs <= clientElapsedMs <= successMaxMs)
 * - WIN -> REFUND_PENDING -> 创建 refunds 单 -> 退款成功后解冻
 * - LOSE -> 释放履约锁 (NONE) -> erpStatus = READY
 */
async function handleSubmitChallenge(openId, payload) {
  // 服务端接收到提交请求的瞬时毫秒时间戳
  const serverFinishRequestReceivedAt = Date.now();

  const {
    sessionId,
    ticket,
    clientElapsedMs,
    clientStartMonotonic,
    clientStopMonotonic,
    deviceInfo = {},
    networkInfo = {},
  } = payload || {};

  if (!sessionId) {
    throw new Error("SessionId required");
  }

  const sessionRes = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).get();
  const session = sessionRes.data;
  if (!session) {
    throw new Error("挑战会话不存在");
  }
  if (session._openid !== openId) {
    throw new Error("无权提交此挑战会话");
  }

  // 幂等保护：如果已经结算完成，直接返回既有结果，不产生二次副作用
  if (
    session.challengeStatus === ChallengeStatus.WIN ||
    session.challengeStatus === ChallengeStatus.LOSE ||
    session.challengeStatus === ChallengeStatus.PENDING_REVIEW
  ) {
    return {
      success: true,
      data: {
        isIdempotent: true,
        sessionId,
        challengeStatus: session.challengeStatus,
        result: session.result,
        refundInfo: session.refundInfo || null,
      },
    };
  }

  // 验签 Ticket (HMAC 严格校验，仅服务端持有密钥)
  if (!verifyTicket(ticket)) {
    throw new Error("挑战Ticket非法或被篡改，无法结算");
  }

  if (ticket.challengeId !== sessionId || ticket.orderId !== session.orderId) {
    throw new Error("Ticket 与当前会话信息不匹配");
  }

  // 严格基于当前 session 创建时绑定的 ruleSnapshot 判定，杜绝后台规则改动影响已有挑战
  const ruleSnapshot = session.ruleSnapshot || DEFAULT_ACTIVE_RULE;
  const clientElapsed = Math.round(Number(clientElapsedMs));

  if (!Number.isFinite(clientElapsed) || clientElapsed <= 0) {
    throw new Error("无效的客户端计时数据");
  }

  // 计算 Hybrid Timing 服务端观测耗时与偏差
  const serverStartResponseSentAt = session.serverStartResponseSentAt || ticket.issuedAt || 0;
  const serverObservedDurationMs = Math.max(0, serverFinishRequestReceivedAt - serverStartResponseSentAt);
  const timingDeltaMs = serverObservedDurationMs - clientElapsed;

  // 风控检测 (RISK CHECK)
  let riskLevel = "NORMAL";
  let isSuspicious = false;

  const timingToleranceMs = ruleSnapshot.timingToleranceMs || 1000;
  const negativeToleranceMs = ruleSnapshot.negativeToleranceMs || 100;
  const maxRoundDurationMs = ruleSnapshot.maxRoundDurationMs || 10000;

  // 1) 客户端耗时明显大于单局最大上限
  // 2) 客户端上报时间竟然比整个网络往返还要大超过 negativeToleranceMs (物理不可能)
  // 3) timingDelta 偏离超过 timingToleranceMs
  if (
    clientElapsed > maxRoundDurationMs ||
    timingDeltaMs < -negativeToleranceMs ||
    Math.abs(timingDeltaMs) > timingToleranceMs
  ) {
    isSuspicious = true;
    riskLevel = "SUSPICIOUS";
  }

  const now = Date.now();
  const baseResultData = {
    clientElapsedMs: clientElapsed,
    clientStartMonotonic: clientStartMonotonic || null,
    clientStopMonotonic: clientStopMonotonic || null,
    serverStartResponseSentAt,
    serverFinishRequestReceivedAt,
    serverObservedDurationMs,
    timingDeltaMs,
    deviceInfo,
    networkInfo,
    ruleVersion: ruleSnapshot.ruleVersion,
    targetTimeMs: ruleSnapshot.targetTimeMs,
    successMinMs: ruleSnapshot.successMinMs,
    successMaxMs: ruleSnapshot.successMaxMs,
    diffMs: Math.abs(clientElapsed - ruleSnapshot.targetTimeMs),
    riskLevel,
    evaluatedAt: now,
  };

  // 场景 A: 命中风控异常 -> 进入 PENDING_REVIEW (不得直接判 LOSE，订单进入 SAFE_SETTLEMENT 暂扣)
  if (isSuspicious) {
    const finalStatus = ChallengeStatus.PENDING_REVIEW;
    const reviewResult = {
      ...baseResultData,
      isWinner: false,
      reviewReason: `Timing delta anomaly: delta=${timingDeltaMs}ms, tolerance=${timingToleranceMs}ms`,
    };

    await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).update({
      data: {
        challengeStatus: finalStatus,
        result: reviewResult,
        attempts: (session.attempts || 0) + 1,
        settledTime: now,
        updatedAt: now,
      },
    });

    await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
      data: {
        challengeStatus: finalStatus,
        fulfillmentHold: FulfillmentHoldStatus.SAFE_SETTLEMENT,
        erpStatus: ErpStatus.HOLD,
        updatedAt: now,
      },
    });

    return {
      success: true,
      data: {
        sessionId,
        challengeStatus: finalStatus,
        isWinner: false,
        riskLevel,
        result: reviewResult,
      },
    };
  }

  // 场景 B: 正常判定 WIN / LOSE
  const isWinner =
    clientElapsed >= ruleSnapshot.successMinMs &&
    clientElapsed <= ruleSnapshot.successMaxMs;

  const finalStatus = isWinner ? ChallengeStatus.WIN : ChallengeStatus.LOSE;
  const finalResult = {
    ...baseResultData,
    isWinner,
  };

  // 挑战失败 LOSE
  if (!isWinner) {
    await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).update({
      data: {
        challengeStatus: finalStatus,
        result: finalResult,
        attempts: (session.attempts || 0) + 1,
        settledTime: now,
        updatedAt: now,
      },
    });

    // 释放订单暂扣状态：fulfillmentHold = NONE, erpStatus = READY，主订单状态保持 PENDING_DELIVERY
    await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
      data: {
        challengeStatus: ChallengeStatus.LOSE,
        challengeRefundStatus: ChallengeRefundStatus.NONE,
        fulfillmentHold: FulfillmentHoldStatus.NONE,
        erpStatus: ErpStatus.READY,
        updatedAt: now,
      },
    });

    return {
      success: true,
      data: {
        sessionId,
        challengeStatus: ChallengeStatus.LOSE,
        isWinner: false,
        result: finalResult,
      },
    };
  }

  // 挑战成功 WIN
  // 1) 订单保持 PENDING_DELIVERY, 履约进入 REFUND_PENDING, 退款成功前禁止发货
  await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).update({
    data: {
      challengeStatus: ChallengeStatus.WIN,
      result: finalResult,
      attempts: (session.attempts || 0) + 1,
      settledTime: now,
      updatedAt: now,
    },
  });

  await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
    data: {
      challengeStatus: ChallengeStatus.WIN,
      challengeRefundStatus: ChallengeRefundStatus.PENDING,
      fulfillmentHold: FulfillmentHoldStatus.REFUND_PENDING,
      erpStatus: ErpStatus.HOLD,
      updatedAt: now,
    },
  });

  // 2) 创建独立的 refunds 记录 (严禁写入 after-service)
  const refundInfo = await executeChallengeRefund({
    session,
    result: finalResult,
  });

  return {
    success: true,
    data: {
      sessionId,
      challengeStatus: ChallengeStatus.WIN,
      isWinner: true,
      result: finalResult,
      refundInfo,
    },
  };
}

/**
 * 3. 执行挑战免单退款 (写入 refunds 集合并流转)
 */
async function executeChallengeRefund({ session, result }) {
  const orderId = session.orderId;
  const orderRes = await db.collection(ORDER_COLLECTION).doc(orderId).get();
  const order = orderRes.data;
  if (!order) return null;

  const totalFee = order.wechatPayInfo && order.wechatPayInfo.totalFee
    ? Number(order.wechatPayInfo.totalFee)
    : Math.round(Number(order.orderSummary ? order.orderSummary.totalPayAmount : 0) * 100);

  const outRefundNo = `RF_CHALLENGE_${Date.now()}_${orderId.slice(-6)}`;
  const now = Date.now();
  const isTestMode = session.activityMode === "TEST" || ACTIVITY_MODE === "TEST";

  const refundDoc = {
    orderId,
    sourceType: "CHALLENGE_FREE_ORDER", // 严格区别于普通售后 AFTER_SALE
    outRefundNo,
    amount: totalFee,
    amountYuan: (totalFee / 100).toFixed(2),
    status: "PENDING",
    wechatRefundId: isTestMode ? `test_wx_rf_${Date.now()}` : null,
    errorCode: null,
    errorMessage: null,
    testMode: isTestMode,
    createdAt: now,
    updatedAt: now,
  };

  const refundAddRes = await db.collection(REFUNDS_COLLECTION).add({
    data: refundDoc,
  });

  const refundId = refundAddRes._id;

  // 如果在 TEST 模式：执行退款状态推进，模拟 callback 成功
  if (isTestMode) {
    await handleRefundCallback({
      outRefundNo,
      refundId,
      status: "SUCCESS",
      wechatRefundId: refundDoc.wechatRefundId,
      isTestSimulation: true,
    });
  }

  return {
    refundId,
    outRefundNo,
    amountYuan: refundDoc.amountYuan,
    status: isTestMode ? "SUCCESS" : "PENDING",
  };
}

/**
 * 4. 微信退款异步回调通知处理 (refundCallback)
 * 幂等支持：仅当退款 SUCCESS 时，才将 fulfillmentHold 解锁为 NONE，并将 erpStatus 置为 READY！
 */
async function handleRefundCallback(payload) {
  const { outRefundNo, refundId, status, wechatRefundId, errorCode, errorMessage } = payload || {};

  let refund = null;
  if (refundId) {
    const res = await db.collection(REFUNDS_COLLECTION).doc(refundId).get();
    refund = res.data;
  } else if (outRefundNo) {
    const res = await db.collection(REFUNDS_COLLECTION).where({ outRefundNo }).limit(1).get();
    refund = res.data && res.data[0];
  }

  if (!refund) {
    return { success: false, message: "Refund record not found" };
  }

  // 幂等拦截：如果已经是最终 SUCCESS 状态，直接返回成功，杜绝重复处理
  if (refund.status === "SUCCESS") {
    return { success: true, message: "Already processed (idempotent)" };
  }

  const now = Date.now();
  const isSuccess = status === "SUCCESS";

  // 更新 refunds 表
  await db.collection(REFUNDS_COLLECTION).doc(refund._id).update({
    data: {
      status: isSuccess ? "SUCCESS" : "FAILED",
      wechatRefundId: wechatRefundId || refund.wechatRefundId,
      errorCode: errorCode || null,
      errorMessage: errorMessage || null,
      updatedAt: now,
    },
  });

  // 更新订单状态：
  // 只有退款 SUCCESS 以后，才能将 fulfillmentHold 改为 NONE，并将 erpStatus 改为 READY！
  if (isSuccess) {
    await db.collection(ORDER_COLLECTION).doc(refund.orderId).update({
      data: {
        challengeRefundStatus: ChallengeRefundStatus.SUCCESS,
        fulfillmentHold: FulfillmentHoldStatus.NONE,
        erpStatus: ErpStatus.READY,
        challengeRefundInfo: {
          refundId: refund._id,
          outRefundNo: refund.outRefundNo,
          amountYuan: refund.amountYuan,
          successTime: now,
        },
        updatedAt: now,
      },
    });
  } else {
    // 退款失败：继续保持 REFUND_PENDING 锁定，禁止发货与 ERP 推单
    await db.collection(ORDER_COLLECTION).doc(refund.orderId).update({
      data: {
        challengeRefundStatus: ChallengeRefundStatus.FAILED,
        fulfillmentHold: FulfillmentHoldStatus.REFUND_PENDING,
        erpStatus: ErpStatus.HOLD,
        refundError: errorMessage || "Refund failed",
        updatedAt: now,
      },
    });
  }

  return { success: true };
}

/**
 * 5. 用户主动放弃/跳过挑战 (USER_SKIPPED)
 * 用户主动跳过后：challengeStatus = LOSE, settlementReason = USER_SKIPPED, fulfillmentHold = NONE, erpStatus = READY
 */
async function handleSkipChallenge(openId, { orderId }) {
  if (!orderId) throw new Error("OrderId required");

  const orderRes = await db.collection(ORDER_COLLECTION).doc(orderId).get();
  const order = orderRes.data;
  if (!order || order._openid !== openId) {
    throw new Error("Order not found or permission denied");
  }

  const now = Date.now();

  // 更新订单
  await db.collection(ORDER_COLLECTION).doc(orderId).update({
    data: {
      challengeStatus: ChallengeStatus.LOSE,
      challengeRefundStatus: ChallengeRefundStatus.NONE,
      settlementReason: "USER_SKIPPED",
      fulfillmentHold: FulfillmentHoldStatus.NONE,
      erpStatus: ErpStatus.READY,
      updatedAt: now,
    },
  });

  // 如果有会话，同步标记为 LOSE (USER_SKIPPED)
  const sessionRes = await db
    .collection(CHALLENGE_SESSION_COLLECTION)
    .where({ orderId, _openid: openId })
    .limit(1)
    .get();

  if (sessionRes.data && sessionRes.data.length > 0) {
    await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionRes.data[0]._id).update({
      data: {
        challengeStatus: ChallengeStatus.LOSE,
        settlementReason: "USER_SKIPPED",
        settledTime: now,
        updatedAt: now,
      },
    });
  }

  return { success: true };
}

/**
 * 6. 技术异常上报 (NETWORK_ERROR, APP_TERMINATED, etc)
 * 绝对不能判 LOSE，进入 INTERRUPTED 状态
 */
async function handleRecordInterrupted(openId, { sessionId, reason }) {
  if (!sessionId) throw new Error("SessionId required");

  const sessionRes = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).get();
  const session = sessionRes.data;
  if (!session || session._openid !== openId) {
    throw new Error("Session not found or permission denied");
  }

  // 终态不可篡改
  if (
    session.challengeStatus === ChallengeStatus.WIN ||
    session.challengeStatus === ChallengeStatus.LOSE
  ) {
    return { success: true, message: "Session already finished" };
  }

  const now = Date.now();
  await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).update({
    data: {
      challengeStatus: ChallengeStatus.INTERRUPTED,
      interruptedReason: reason || "NETWORK_ERROR",
      interruptedAt: now,
      updatedAt: now,
    },
  });

  await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
    data: {
      challengeStatus: ChallengeStatus.INTERRUPTED,
      fulfillmentHold: FulfillmentHoldStatus.CHALLENGE_PENDING,
      updatedAt: now,
    },
  });

  return { success: true };
}

/**
 * 7. 恢复会话 (challengeResume)
 * 用户重新进入时，若状态是 INTERRUPTED，允许恢复会话并重新下发合法 Ticket
 */
async function handleResumeSession(openId, { sessionId }) {
  if (!sessionId) throw new Error("SessionId required");

  const sessionRes = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).get();
  const session = sessionRes.data;
  if (!session || session._openid !== openId) {
    throw new Error("Session not found or permission denied");
  }

  // 终态不恢复，直接返回结果
  if (
    session.challengeStatus === ChallengeStatus.WIN ||
    session.challengeStatus === ChallengeStatus.LOSE ||
    session.challengeStatus === ChallengeStatus.PENDING_REVIEW
  ) {
    return {
      success: true,
      data: {
        sessionId,
        challengeStatus: session.challengeStatus,
        challengeCompleted: true,
        result: session.result,
        ruleSnapshot: session.ruleSnapshot,
      },
    };
  }

  const now = Date.now();
  const ruleSnapshot = session.ruleSnapshot || DEFAULT_ACTIVE_RULE;
  const nonce = crypto.randomBytes(16).toString("hex");
  const serverStartResponseSentAt = now;

  const ticket = createSignedTicket({
    challengeId: sessionId,
    orderId: session.orderId,
    openid: openId,
    ruleVersion: ruleSnapshot.ruleVersion,
    nonce,
    issuedAt: serverStartResponseSentAt,
    maxRoundDurationMs: ruleSnapshot.maxRoundDurationMs,
  });

  await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).update({
    data: {
      challengeStatus: ChallengeStatus.IN_PROGRESS,
      serverStartResponseSentAt,
      latestTicketNonce: nonce,
      resumedAt: now,
      updatedAt: now,
    },
  });

  await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
    data: {
      challengeStatus: ChallengeStatus.IN_PROGRESS,
      fulfillmentHold: FulfillmentHoldStatus.CHALLENGE_PENDING,
      updatedAt: now,
    },
  });

  return {
    success: true,
    data: {
      sessionId,
      orderId: session.orderId,
      challengeStatus: ChallengeStatus.IN_PROGRESS,
      challengeCompleted: false,
      serverStartResponseSentAt,
      ticket,
      ruleSnapshot,
      activityMode: session.activityMode || ACTIVITY_MODE,
      resumed: true,
    },
  };
}

/**
 * 8. 查询会话状态
 */
async function handleGetSession(openId, { orderId, sessionId }) {
  let session = null;
  if (sessionId) {
    const res = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).get();
    session = res.data;
  } else if (orderId) {
    const res = await db
      .collection(CHALLENGE_SESSION_COLLECTION)
      .where({ orderId, _openid: openId })
      .limit(1)
      .get();
    session = res.data && res.data[0];
  }

  if (!session || session._openid !== openId) {
    return { success: false, message: "Session not found" };
  }

  return {
    success: true,
    data: session,
  };
}
