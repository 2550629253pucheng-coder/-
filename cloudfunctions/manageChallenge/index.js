const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

const {
  ChallengeStatus,
  FulfillmentHoldStatus,
  ChallengeRefundStatus,
  ErpStatus,
  assertTransition,
} = require("./lib/stateMachine");

const {
  getHmacSecret,
  createSignedTicket,
  verifyTicket,
} = require("./lib/ticket");

const { evaluateTiming } = require("./lib/timing");
const { assessRisk } = require("./lib/risk");
const { resolveSettlement } = require("./lib/settlement");
const {
  buildDeterministicRefundKeys,
  resolvePaidAmountCents,
  buildChallengeRefundDoc,
} = require("./lib/refund");

// 集合定义
const ORDER_COLLECTION = "order";
const CHALLENGE_SESSION_COLLECTION = "challenge_session";
const CHALLENGE_RULES_COLLECTION = "challenge_rules";
const REFUNDS_COLLECTION = "refunds";

// 活动模式: TEST (测试模式) | LIVE (正式模式)
const ACTIVITY_MODE = process.env.ACTIVITY_MODE || "TEST";
// 测试退款模拟模式: AUTO_SUCCESS (自动回调成功) | MANUAL_SUCCESS (手动推进) | FAILURE (模拟失败)
const TEST_REFUND_MODE = process.env.TEST_REFUND_MODE || "AUTO_SUCCESS";

// 确保在启动阶段就校验 HMAC 密钥配置，公开仓库绝不包含任何 fallback 默认密钥
try {
  getHmacSecret();
} catch (err) {
  console.warn("[manageChallenge] Warning on startup:", err.message);
}

// 默认兜底基准规则 (TEST_ONLY)
const DEFAULT_ACTIVE_RULE = {
  ruleId: "RULE_3S_TEST_V1",
  gameType: "THREE_SECOND_HOLD",
  ruleVersion: "TEST_V1", // 标记为测试版本
  targetTimeMs: 3000,
  successMinMs: 2990,
  successMaxMs: 3010,
  maxRoundDurationMs: 10000,
  timingToleranceMs: 1000, // TEST_ONLY: 初始测试宽松容忍阈值，正式上线前需根据真机 P99 校准
  negativeToleranceMs: 100, // 物理时钟负偏差阈值
  maxResumeCount: 1, // 最多允许中断恢复 1 次
  status: "ACTIVE",
  effectiveFrom: 0,
  effectiveTo: 4102444800000,
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
    console.warn("[getEffectiveRule] Query challenge_rules failed, using default rule:", err);
  }
  return DEFAULT_ACTIVE_RULE;
}

/**
 * 0. 页面加载查询挑战上下文 (getChallengeContext)
 * 仅查询资格与规则，不触发生命周期状态扭转，不提前打点
 */
async function handleGetChallengeContext(openId, { orderId }) {
  if (!orderId) {
    throw new Error("OrderId required");
  }

  const orderRes = await db.collection(ORDER_COLLECTION).doc(orderId).get();
  const order = orderRes.data;
  if (!order || order._openid !== openId) {
    throw new Error("订单不存在或无权操作");
  }

  // 检查已有会话
  const sessionRes = await db
    .collection(CHALLENGE_SESSION_COLLECTION)
    .where({ orderId, _openid: openId })
    .limit(1)
    .get();

  const existingSession = sessionRes.data && sessionRes.data[0];
  const rule = existingSession ? existingSession.ruleSnapshot : await getEffectiveRule();

  return {
    success: true,
    data: {
      orderId,
      orderStatus: order.status,
      challengeEligible: !!order.challengeEligible,
      challengeStatus: existingSession ? existingSession.challengeStatus : (order.challengeStatus || "ELIGIBLE"),
      fulfillmentHold: order.fulfillmentHold || "NONE",
      session: existingSession || null,
      ruleSnapshot: rule,
      activityMode: (existingSession && existingSession.activityMode) || ACTIVITY_MODE,
    },
  };
}

/**
 * 1. 真正开始挑战 (challengeStart / startSession)
 * 关键修正：在用户真正点击【开始挑战】时调用，紧贴客户端计时起点
 */
async function handleStartSession(openId, { orderId }) {
  if (!orderId) {
    throw new Error("OrderId required");
  }

  // 严格检查密钥配置
  getHmacSecret();

  const orderRes = await db.collection(ORDER_COLLECTION).doc(orderId).get();
  const order = orderRes.data;
  if (!order) {
    throw new Error("订单不存在");
  }
  if (order._openid !== openId) {
    throw new Error("无权操作此订单");
  }

  if (order.status === "PENDING_PAYMENT" || order.status === "CANCELED_NOT_PAYMENT") {
    throw new Error("订单尚未完成支付，无法发起免单挑战");
  }

  if (!order.challengeEligible) {
    throw new Error("该订单不满足免单挑战参与条件");
  }

  // 查询是否已有此订单的挑战会话
  const sessionRes = await db
    .collection(CHALLENGE_SESSION_COLLECTION)
    .where({ orderId, _openid: openId })
    .limit(1)
    .get();

  const now = Date.now();

  if (sessionRes.data && sessionRes.data.length > 0) {
    const existingSession = sessionRes.data[0];

    // 如果已经是终态，直接返回结果，绝不重新挑战
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

    // 如果会话处于 INTERRUPTED，走恢复逻辑
    if (existingSession.challengeStatus === ChallengeStatus.INTERRUPTED) {
      return await handleResumeSession(openId, { sessionId: existingSession._id });
    }

    // 关键修正：若已经是 IN_PROGRESS，严禁重新签发 Ticket 重置 serverStart！直接返回当前已有时序凭证
    if (existingSession.challengeStatus === ChallengeStatus.IN_PROGRESS) {
      return {
        success: true,
        data: {
          sessionId: existingSession._id,
          orderId: existingSession.orderId,
          challengeStatus: ChallengeStatus.IN_PROGRESS,
          challengeCompleted: false,
          serverStartResponseSentAt: existingSession.serverStartResponseSentAt,
          ticket: existingSession.latestTicket,
          ruleSnapshot: existingSession.ruleSnapshot,
          activityMode: existingSession.activityMode || ACTIVITY_MODE,
        },
      };
    }
  }

  // 全新创建挑战会话并锁定规则版本 (Rule Snapshotting)
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
    maxResumeCount: rule.maxResumeCount || 1,
  };

  const serverStartResponseSentAt = now;
  const nonce = crypto.randomBytes(16).toString("hex");
  const sessionId = `cs_${orderId}_${now}`;

  const ticket = createSignedTicket({
    challengeId: sessionId,
    orderId,
    openid: openId,
    ruleVersion: ruleSnapshot.ruleVersion,
    nonce,
    issuedAt: serverStartResponseSentAt,
    maxRoundDurationMs: ruleSnapshot.maxRoundDurationMs,
  });

  const newSessionDoc = {
    _id: sessionId,
    orderId,
    _openid: openId,
    activityMode: ACTIVITY_MODE,
    challengeStatus: ChallengeStatus.IN_PROGRESS,
    ruleSnapshot,
    serverStartResponseSentAt,
    latestTicketNonce: nonce,
    latestTicket: ticket,
    attempts: 0,
    resumeCount: 0,
    result: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(CHALLENGE_SESSION_COLLECTION).add({
    data: newSessionDoc,
  });

  // 更新订单：挑战进行中，独立履约锁置入 CHALLENGE_PENDING
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
 * 2. 提交挑战成绩 (challengeFinish / submitChallenge)
 * 并发安全 CAS，防重入，严密风控审计，退款与履约解耦
 */
async function handleSubmitChallenge(openId, payload) {
  const {
    sessionId,
    ticket,
    clientElapsedMs,
    clientStartMonotonic,
    clientStopMonotonic,
    deviceInfo,
    networkInfo,
  } = payload || {};

  const serverFinishRequestReceivedAt = Date.now();

  if (!sessionId || !ticket || clientElapsedMs == null) {
    throw new Error("SUBMIT_PARAMS_INVALID");
  }

  // 1. 查询会话
  const sessionRes = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).get();
  const session = sessionRes.data;
  if (!session || session._openid !== openId) {
    throw new Error("Session not found or permission denied");
  }

  // 并发幂等防护：若已处于终态，直接返回既有结算结果
  if (
    session.challengeStatus === ChallengeStatus.WIN ||
    session.challengeStatus === ChallengeStatus.LOSE ||
    session.challengeStatus === ChallengeStatus.PENDING_REVIEW ||
    session.challengeStatus === ChallengeStatus.EXPIRED
  ) {
    return {
      success: true,
      data: {
        sessionId,
        isIdempotent: true,
        challengeStatus: session.challengeStatus,
        isWinner: session.challengeStatus === ChallengeStatus.WIN,
        result: session.result,
        ruleSnapshot: session.ruleSnapshot,
      },
    };
  }

  // 2. 严格验签 Ticket (使用 crypto.timingSafeEqual 防时序攻击)
  if (!verifyTicket(ticket)) {
    throw new Error("TICKET_SIGNATURE_VERIFICATION_FAILED");
  }

  // 3. 计算 Hybrid Timing 差值
  const timingMetrics = evaluateTiming({
    serverStartResponseSentAt: session.serverStartResponseSentAt,
    serverFinishRequestReceivedAt,
    clientElapsedMs,
    ruleSnapshot: session.ruleSnapshot,
  });

  // 4. 风控与异常审计评估
  const riskAssessment = assessRisk({
    timingMetrics,
    ruleSnapshot: session.ruleSnapshot,
    resumeCount: session.resumeCount || 0,
    maxResumeCount: session.ruleSnapshot.maxResumeCount || 1,
  });

  // 5. 结算裁决 (通过状态机白名单断言)
  const settlement = resolveSettlement({
    currentStatus: session.challengeStatus,
    timingMetrics,
    riskAssessment,
    ruleSnapshot: session.ruleSnapshot,
  });

  const now = Date.now();

  // 6. CAS 条件更新：仅当 challengeStatus == session.challengeStatus (IN_PROGRESS) 时才允许推进
  const casUpdateRes = await db
    .collection(CHALLENGE_SESSION_COLLECTION)
    .where({
      _id: sessionId,
      challengeStatus: session.challengeStatus,
    })
    .update({
      data: {
        challengeStatus: settlement.challengeStatus,
        result: settlement.result,
        deviceInfo: deviceInfo || null,
        networkInfo: networkInfo || null,
        settledTime: now,
        updatedAt: now,
      },
    });

  // 若 CAS 未匹配到记录，说明有并发请求已抢先完成结算
  if (casUpdateRes.stats && casUpdateRes.stats.updated === 0) {
    const refreshed = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).get();
    return {
      success: true,
      data: {
        sessionId,
        isIdempotent: true,
        challengeStatus: refreshed.data.challengeStatus,
        isWinner: refreshed.data.challengeStatus === ChallengeStatus.WIN,
        result: refreshed.data.result,
      },
    };
  }

  // 7. 同步更新订单状态与履约暂扣标记
  await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
    data: {
      challengeStatus: settlement.challengeStatus,
      challengeRefundStatus: settlement.challengeRefundStatus,
      fulfillmentHold: settlement.fulfillmentHold,
      erpStatus: settlement.erpStatus,
      updatedAt: now,
    },
  });

  // 8. 若获胜 WIN，触发退款链路
  let refundInfo = null;
  if (settlement.challengeStatus === ChallengeStatus.WIN) {
    refundInfo = await executeChallengeRefund({
      session,
      result: settlement.result,
    });
  }

  return {
    success: true,
    data: {
      sessionId,
      challengeStatus: settlement.challengeStatus,
      isWinner: settlement.isWinner,
      result: settlement.result,
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

  // 确定金额 (服务端校验实际已支付金额，绝不信客户端)
  const paidCents = resolvePaidAmountCents(order);
  const isTestMode = session.activityMode === "TEST" || ACTIVITY_MODE === "TEST";

  // 构建确定性退款单据 (CR_{orderId})
  const refundDoc = buildChallengeRefundDoc({
    sessionId: session._id,
    orderId,
    paidCents,
    isTestMode,
    testRefundMode: TEST_REFUND_MODE,
  });

  try {
    await db.collection(REFUNDS_COLLECTION).add({
      data: refundDoc,
    });
  } catch (err) {
    console.warn("[executeChallengeRefund] Refund doc might already exist:", err.message);
  }

  // 如果在 TEST 模式且配置为 AUTO_SUCCESS，直接安全模拟退款成功并解除履约暂扣
  if (isTestMode && TEST_REFUND_MODE === "AUTO_SUCCESS") {
    const now = Date.now();
    await db.collection(REFUNDS_COLLECTION).doc(refundDoc._id).update({
      data: {
        status: "SUCCESS",
        updatedAt: now,
      },
    });

    await db.collection(ORDER_COLLECTION).doc(orderId).update({
      data: {
        challengeRefundStatus: ChallengeRefundStatus.SUCCESS,
        fulfillmentHold: FulfillmentHoldStatus.NONE, // 退款成功才允许释放暂扣！
        erpStatus: ErpStatus.READY,
        challengeRefundInfo: {
          refundId: refundDoc._id,
          outRefundNo: refundDoc.outRefundNo,
          amountYuan: refundDoc.amountYuan,
          successTime: now,
        },
        updatedAt: now,
      },
    });

    return {
      refundId: refundDoc._id,
      outRefundNo: refundDoc.outRefundNo,
      amountYuan: refundDoc.amountYuan,
      status: "SUCCESS",
    };
  }

  // LIVE 模式或 MANUAL/FAILURE 模式：真实发起微信支付退款，状态保持 PROCESSING，发货坚决锁定
  if (!isTestMode) {
    try {
      if (cloud.cloudPay && typeof cloud.cloudPay.refund === "function") {
        await cloud.cloudPay.refund({
          out_trade_no: orderId,
          out_refund_no: refundDoc.outRefundNo,
          total_fee: paidCents,
          refund_fee: paidCents,
          refund_desc: "3秒挑战免单全额返款",
        });
      }
    } catch (wxErr) {
      console.error("[executeChallengeRefund] cloud.cloudPay.refund failed:", wxErr);
    }
  }

  return {
    refundId: refundDoc._id,
    outRefundNo: refundDoc.outRefundNo,
    amountYuan: refundDoc.amountYuan,
    status: "PROCESSING",
  };
}

/**
 * 4. 恢复会话 (challengeResume)
 * 限制恢复次数，防范作弊，防范无限刷新
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
    session.challengeStatus === ChallengeStatus.PENDING_REVIEW ||
    session.challengeStatus === ChallengeStatus.EXPIRED
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

  const ruleSnapshot = session.ruleSnapshot || DEFAULT_ACTIVE_RULE;
  const currentResumeCount = session.resumeCount || 0;
  const maxResumeCount = ruleSnapshot.maxResumeCount || 1;

  // 校验恢复次数限制：超过上限直接转为 PENDING_REVIEW 风控挂起
  if (currentResumeCount >= maxResumeCount) {
    const now = Date.now();
    await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).update({
      data: {
        challengeStatus: ChallengeStatus.PENDING_REVIEW,
        reviewReason: "EXCEEDED_MAX_RESUME_COUNT",
        updatedAt: now,
      },
    });

    await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
      data: {
        challengeStatus: ChallengeStatus.PENDING_REVIEW,
        fulfillmentHold: FulfillmentHoldStatus.SAFE_SETTLEMENT,
        erpStatus: ErpStatus.HOLD,
        updatedAt: now,
      },
    });

    return {
      success: false,
      message: "中断恢复次数超出限制，已移交风控审核",
      data: {
        sessionId,
        challengeStatus: ChallengeStatus.PENDING_REVIEW,
      },
    };
  }

  // 正常恢复：生成新 Nonce 与 Ticket，重新打点 serverStartResponseSentAt
  const now = Date.now();
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
      latestTicket: ticket,
      resumeCount: currentResumeCount + 1,
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
      resumeCount: currentResumeCount + 1,
    },
  };
}

/**
 * 5. 技术异常上报 (recordInterrupted)
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
    session.challengeStatus === ChallengeStatus.LOSE ||
    session.challengeStatus === ChallengeStatus.PENDING_REVIEW ||
    session.challengeStatus === ChallengeStatus.EXPIRED
  ) {
    return { success: true, message: "Session already finished" };
  }

  // 只能从 IN_PROGRESS 转为 INTERRUPTED
  if (session.challengeStatus !== ChallengeStatus.IN_PROGRESS) {
    return { success: true, message: "Only IN_PROGRESS session can be interrupted" };
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
 * 6. 用户主动放弃/跳过挑战 (skipChallenge)
 * 关键安全修复：绝不允许在 IN_PROGRESS, WIN, REFUND_PENDING, SAFE_SETTLEMENT 下绕过发货锁定！
 * 仅允许在 challengeStatus == ELIGIBLE (未开始) 时 Skip
 */
async function handleSkipChallenge(openId, { orderId }) {
  if (!orderId) throw new Error("OrderId required");

  const orderRes = await db.collection(ORDER_COLLECTION).doc(orderId).get();
  const order = orderRes.data;
  if (!order || order._openid !== openId) {
    throw new Error("Order not found or permission denied");
  }

  // 安全检查：只有 ELIGIBLE 允许跳过！
  if (order.challengeStatus && order.challengeStatus !== ChallengeStatus.ELIGIBLE) {
    throw new Error(`CANNOT_SKIP_IN_STATUS: ${order.challengeStatus}`);
  }

  if (
    order.fulfillmentHold === FulfillmentHoldStatus.REFUND_PENDING ||
    order.fulfillmentHold === FulfillmentHoldStatus.SAFE_SETTLEMENT
  ) {
    throw new Error(`CANNOT_SKIP_UNDER_HOLD: ${order.fulfillmentHold}`);
  }

  const now = Date.now();

  // 条件原子更新：确保订单未被其他操作修改
  const updateRes = await db
    .collection(ORDER_COLLECTION)
    .where({
      _id: orderId,
      _openid: openId,
      challengeStatus: ChallengeStatus.ELIGIBLE,
    })
    .update({
      data: {
        challengeStatus: ChallengeStatus.LOSE,
        challengeRefundStatus: ChallengeRefundStatus.NONE,
        settlementReason: "USER_SKIPPED",
        fulfillmentHold: FulfillmentHoldStatus.NONE,
        erpStatus: ErpStatus.READY,
        updatedAt: now,
      },
    });

  if (updateRes.stats && updateRes.stats.updated === 0) {
    throw new Error("SKIP_FAILED_STATE_CONFLICT");
  }

  return { success: true };
}

/**
 * 7. 查询会话状态
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

// 主入口路由器 (彻底删除 refundCallback 客户端入口！)
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openId = wxContext.OPENID;
  const { action, payload = {} } = event || {};

  if (!openId) {
    return { success: false, message: "User not logged in" };
  }

  try {
    switch (action) {
      case "getChallengeContext":
        return await handleGetChallengeContext(openId, payload);

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

      case "getSession":
        return await handleGetSession(openId, payload);

      default:
        return { success: false, message: `Unknown or forbidden action: ${action}` };
    }
  } catch (err) {
    console.error(`[manageChallenge] ${action} failed:`, err);
    return { success: false, message: err.message || "Internal server error" };
  }
};
