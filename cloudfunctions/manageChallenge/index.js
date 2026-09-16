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
  verifyTicketBinding,
} = require("./lib/ticket");

const { evaluateTiming } = require("./lib/timing");
const { assessRisk } = require("./lib/risk");
const { resolveSettlement } = require("./lib/settlement");
const {
  buildDeterministicRefundKeys,
  resolvePaidAmountCents,
  buildChallengeRefundDoc,
} = require("./lib/refund");
const paymentGateway = require("./lib/paymentGateway");

/**
 * 数据库事务执行器 (支持 CloudBase 事务并在非事务测试环境下安全 fallback)
 */
async function runWithTransaction(database, fn) {
  if (typeof database.startTransaction === "function") {
    const transaction = await database.startTransaction();
    try {
      const result = await fn(transaction);
      await transaction.commit();
      return result;
    } catch (err) {
      if (typeof transaction.rollback === "function") {
        try {
          await transaction.rollback();
        } catch (rbErr) {
          console.warn("[runWithTransaction] rollback error:", rbErr.message);
        }
      }
      throw err;
    }
  } else {
    return await fn(database);
  }
}

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

  if (order.status !== "PENDING_DELIVERY") {
    throw new Error("CHALLENGE_NOT_STARTABLE: ORDER_NOT_PAID");
  }

  if (!order.challengeEligible) {
    throw new Error("CHALLENGE_NOT_STARTABLE: ORDER_NOT_ELIGIBLE");
  }

  if (
    order.challengeStatus !== ChallengeStatus.ELIGIBLE &&
    order.challengeStatus !== ChallengeStatus.READY_TO_RESTART &&
    order.challengeStatus !== ChallengeStatus.IN_PROGRESS
  ) {
    throw new Error(`CHALLENGE_NOT_STARTABLE: ORDER_STATUS_${order.challengeStatus}`);
  }

  if (order.fulfillmentHold !== FulfillmentHoldStatus.CHALLENGE_PENDING) {
    throw new Error(`CHALLENGE_NOT_STARTABLE: FULFILLMENT_HOLD_${order.fulfillmentHold}`);
  }

  // 确定性 Session ID（一单仅一会话，彻底消除 Session 漂移与并发多会话）
  const sessionId = `CHALLENGE_SESSION_${orderId}`;

  // 查询是否已有此订单的挑战会话
  let existingSession = null;
  try {
    const sessionRes = await db
      .collection(CHALLENGE_SESSION_COLLECTION)
      .doc(sessionId)
      .get();
    existingSession = sessionRes.data;
  } catch (err) {
    // 若根据 ID 查不到，兼容按 orderId 兜底查一次
    const legacyRes = await db
      .collection(CHALLENGE_SESSION_COLLECTION)
      .where({ orderId, _openid: openId })
      .limit(1)
      .get();
    if (legacyRes.data && legacyRes.data.length > 0) {
      existingSession = legacyRes.data[0];
    }
  }

  const now = Date.now();

  if (existingSession) {
    // [P0 安全原则] 检查 Session 与 Order 状态冲突 (如 Order 已终结但 Session 处于重启或进行中)
    if (
      (order.challengeStatus === ChallengeStatus.LOSE || order.challengeStatus === ChallengeStatus.WIN) &&
      (existingSession.challengeStatus === ChallengeStatus.READY_TO_RESTART || existingSession.challengeStatus === ChallengeStatus.IN_PROGRESS)
    ) {
      console.error("[handleStartSession] SESSION_ORDER_STATUS_CONFLICT:", {
        orderId,
        orderStatus: order.challengeStatus,
        sessionStatus: existingSession.challengeStatus,
      });
      throw new Error("CHALLENGE_NOT_STARTABLE: SESSION_ORDER_STATUS_CONFLICT");
    }

    // 1. 如果已经是终态，直接幂等返回结果，绝不重新挑战
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

    // 2. 如果会话正处于 SETTLING 结算锁定中
    if (existingSession.challengeStatus === ChallengeStatus.SETTLING) {
      return {
        success: true,
        data: {
          sessionId: existingSession._id,
          orderId: existingSession.orderId,
          challengeStatus: ChallengeStatus.SETTLING,
          challengeCompleted: false,
          message: "正在结算中，请稍候",
          ruleSnapshot: existingSession.ruleSnapshot,
        },
      };
    }

    // 3. 如果会话处于 INTERRUPTED，提示需要先调用 resumeSession
    if (existingSession.challengeStatus === ChallengeStatus.INTERRUPTED) {
      return {
        success: false,
        message: "挑战会话已中断，请先恢复挑战资格",
        data: {
          sessionId: existingSession._id,
          challengeStatus: ChallengeStatus.INTERRUPTED,
          requireResume: true,
        },
      };
    }

    // 4. 并发幂等：若已经是 IN_PROGRESS，严禁重新签发 Ticket 重置 serverStart！直接返回当前已有时序凭证
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

    // 5. 关键逻辑：若会话处于 READY_TO_RESTART（resume 成功后，用户明确点击“开始挑战”）：
    if (existingSession.challengeStatus === ChallengeStatus.READY_TO_RESTART) {
      const ruleSnapshot = existingSession.ruleSnapshot || order.challengeRuleSnapshot;
      const serverStartResponseSentAt = now;
      const nonce = crypto.randomBytes(16).toString("hex");

      const ticket = createSignedTicket({
        challengeId: existingSession._id,
        orderId,
        openid: openId,
        ruleVersion: ruleSnapshot.ruleVersion,
        nonce,
        issuedAt: serverStartResponseSentAt,
        maxRoundDurationMs: ruleSnapshot.maxRoundDurationMs,
      });

      await db
        .collection(CHALLENGE_SESSION_COLLECTION)
        .doc(existingSession._id)
        .update({
          data: {
            challengeStatus: ChallengeStatus.IN_PROGRESS,
            serverStartResponseSentAt,
            latestTicketNonce: nonce,
            latestTicket: ticket,
            updatedAt: now,
          },
        });

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
          sessionId: existingSession._id,
          orderId,
          challengeStatus: ChallengeStatus.IN_PROGRESS,
          challengeCompleted: false,
          serverStartResponseSentAt,
          ticket,
          ruleSnapshot,
          activityMode: existingSession.activityMode || ACTIVITY_MODE,
          restarted: true,
        },
      };
    }
  }

  // 规则快照锁定：优先且强制使用订单支付时冻结的 challengeRuleSnapshot
  let ruleSnapshot = order.challengeRuleSnapshot;
  if (!ruleSnapshot) {
    const isLive = process.env.NODE_ENV === "production" || process.env.ACTIVITY_MODE === "LIVE" || ACTIVITY_MODE === "LIVE";
    if (isLive) {
      throw new Error("CHALLENGE_NOT_STARTABLE: CHALLENGE_RULE_SNAPSHOT_MISSING");
    }
    const fallbackRule = await getEffectiveRule();
    ruleSnapshot = {
      ruleId: fallbackRule.ruleId || "RULE_3S_TEST_V1",
      gameType: fallbackRule.gameType || "THREE_SECOND_HOLD",
      ruleVersion: order.challengeRuleVersion || fallbackRule.ruleVersion || "TEST_V1",
      targetTimeMs: Number(fallbackRule.targetTimeMs) || 3000,
      successMinMs: Number(fallbackRule.successMinMs) || 2990,
      successMaxMs: Number(fallbackRule.successMaxMs) || 3010,
      maxRoundDurationMs: Number(fallbackRule.maxRoundDurationMs) || 10000,
      timingToleranceMs: Number(fallbackRule.timingToleranceMs) || 1000,
      negativeToleranceMs: Number(fallbackRule.negativeToleranceMs) || 100,
      maxResumeCount: Number(fallbackRule.maxResumeCount) || 1,
    };
  }

  const serverStartResponseSentAt = now;
  const nonce = crypto.randomBytes(16).toString("hex");

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

  try {
    await db.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).set({
      data: newSessionDoc,
    });
  } catch (createErr) {
    console.warn("[handleStartSession] doc set warning, fallback to add:", createErr.message);
    await db.collection(CHALLENGE_SESSION_COLLECTION).add({
      data: newSessionDoc,
    });
  }

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
 * 并发安全 CAS 推进至 SETTLING，严格 Ticket-Session 强绑定审计，退款任务异步解耦
 */
async function handleSubmitChallenge(openId, payload) {
  const {
    sessionId,
    orderId,
    ticket,
    clientElapsedMs,
    clientStartMonotonic,
    clientStopMonotonic,
    deviceInfo,
    networkInfo,
  } = payload || {};

  const serverFinishRequestReceivedAt = Date.now();
  const targetSessionId = sessionId || (orderId ? `CHALLENGE_SESSION_${orderId}` : null);

  if (!targetSessionId || !ticket || clientElapsedMs == null) {
    throw new Error("SUBMIT_PARAMS_INVALID");
  }

  // 1. 查询会话
  let session = null;
  try {
    const sessionRes = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(targetSessionId).get();
    session = sessionRes.data;
  } catch (e) {
    if (orderId) {
      const fallbackRes = await db
        .collection(CHALLENGE_SESSION_COLLECTION)
        .where({ orderId, _openid: openId })
        .limit(1)
        .get();
      session = fallbackRes.data && fallbackRes.data[0];
    }
  }

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
        sessionId: session._id,
        isIdempotent: true,
        challengeStatus: session.challengeStatus,
        isWinner: session.challengeStatus === ChallengeStatus.WIN,
        result: session.result,
        ruleSnapshot: session.ruleSnapshot,
      },
    };
  }

  // 2. 严格验签 Ticket (使用 crypto.timingSafeEqual 防伪)
  if (!verifyTicket(ticket)) {
    throw new Error("TICKET_SIGNATURE_VERIFICATION_FAILED");
  }

  // 2.1 [P0 核心安全防御] Ticket-Session 强绑定与防旧票/跨会话重放
  const bindingCheck = verifyTicketBinding(ticket, session, openId);
  if (!bindingCheck.valid) {
    console.error("[handleSubmitChallenge] Ticket session binding failed:", bindingCheck.reason);
    throw new Error(`TICKET_SESSION_BINDING_FAILED: ${bindingCheck.reason}`);
  }

  // 3. CAS 推进状态到 SETTLING 结算锁定态（防重入与并发）
  const casUpdateRes = await db
    .collection(CHALLENGE_SESSION_COLLECTION)
    .where({
      _id: session._id,
      challengeStatus: ChallengeStatus.IN_PROGRESS,
    })
    .update({
      data: {
        challengeStatus: ChallengeStatus.SETTLING,
        settlingStartedAt: serverFinishRequestReceivedAt,
        updatedAt: serverFinishRequestReceivedAt,
      },
    });

  // 若 CAS 未匹配到记录，说明有并发请求已抢先推进或正在结算中
  if (casUpdateRes.stats && casUpdateRes.stats.updated === 0) {
    const refreshed = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(session._id).get();
    const curStatus = refreshed.data && refreshed.data.challengeStatus;
    if (curStatus === ChallengeStatus.SETTLING) {
      return {
        success: true,
        data: {
          sessionId: session._id,
          challengeStatus: ChallengeStatus.SETTLING,
          message: "正在结算中，请稍候",
        },
      };
    }
    return {
      success: true,
      data: {
        sessionId: session._id,
        isIdempotent: true,
        challengeStatus: curStatus,
        isWinner: curStatus === ChallengeStatus.WIN,
        result: refreshed.data && refreshed.data.result,
      },
    };
  }

  // 4. 计算 Hybrid Timing 差值
  const timingMetrics = evaluateTiming({
    serverStartResponseSentAt: session.serverStartResponseSentAt,
    serverFinishRequestReceivedAt,
    clientElapsedMs,
    ruleSnapshot: session.ruleSnapshot,
  });

  // 5. 风控与异常审计评估
  const riskAssessment = assessRisk({
    timingMetrics,
    ruleSnapshot: session.ruleSnapshot,
    resumeCount: session.resumeCount || 0,
    maxResumeCount: session.ruleSnapshot.maxResumeCount || 1,
  });

  // 6. 结算裁决 (从 SETTLING 状态安全流转到终态)
  const settlement = resolveSettlement({
    currentStatus: ChallengeStatus.SETTLING,
    timingMetrics,
    riskAssessment,
    ruleSnapshot: session.ruleSnapshot,
  });

  const now = Date.now();
  const targetOrderId = session.orderId || orderId;
  const orderRes = await db.collection(ORDER_COLLECTION).doc(targetOrderId).get();
  const order = orderRes.data;
  if (!order) {
    throw new Error("ORDER_NOT_FOUND");
  }

  const isLive = process.env.NODE_ENV === "production" || process.env.ACTIVITY_MODE === "LIVE" || ACTIVITY_MODE === "LIVE";
  const paidCents = resolvePaidAmountCents(order, isLive);
  const isTestMode = session.activityMode === "TEST" || ACTIVITY_MODE === "TEST";
  const { refundDocId, outRefundNo, refundTaskId } = buildDeterministicRefundKeys({
    sessionId: session._id,
    orderId: targetOrderId,
  });

  let taskDocToDispatch = null;
  let refundDocToReturn = null;

  // 7. [P0 核心安全] 结算原子事务化：Session + Order + Refunds + RefundTask 在同一事务内提交
  await runWithTransaction(db, async (t) => {
    // 7.1 更新 Session 至终态
    await t.collection(CHALLENGE_SESSION_COLLECTION).doc(session._id).update({
      data: {
        challengeStatus: settlement.challengeStatus,
        result: settlement.result,
        deviceInfo: deviceInfo || null,
        networkInfo: networkInfo || null,
        settledTime: now,
        settledAt: now,
        updatedAt: now,
      },
    });

    // 7.2 同步更新订单状态机与履约暂扣标记（永久消费资格 challengeEligible: false）
    let orderUpdateData;
    if (settlement.challengeStatus === ChallengeStatus.WIN) {
      orderUpdateData = {
        challengeStatus: ChallengeStatus.WIN,
        challengeEligible: false, // 终态永久消费资格
        challengeRefundStatus: ChallengeRefundStatus.PENDING,
        fulfillmentHold: FulfillmentHoldStatus.REFUND_PENDING,
        erpStatus: ErpStatus.HOLD,
        updatedAt: now,
      };
    } else if (settlement.challengeStatus === ChallengeStatus.LOSE) {
      orderUpdateData = {
        challengeStatus: ChallengeStatus.LOSE,
        challengeEligible: false,
        challengeRefundStatus: ChallengeRefundStatus.NONE,
        fulfillmentHold: FulfillmentHoldStatus.NONE,
        erpStatus: ErpStatus.READY,
        updatedAt: now,
      };
    } else {
      orderUpdateData = {
        challengeStatus: ChallengeStatus.PENDING_REVIEW,
        challengeEligible: false,
        challengeRefundStatus: ChallengeRefundStatus.NONE,
        fulfillmentHold: FulfillmentHoldStatus.SAFE_SETTLEMENT,
        erpStatus: ErpStatus.HOLD,
        updatedAt: now,
      };
    }

    await t.collection(ORDER_COLLECTION).doc(targetOrderId).update({
      data: orderUpdateData,
    });

    // 7.3 若获胜 WIN，在同一事务内生成确定的退款单和退款任务
    if (settlement.challengeStatus === ChallengeStatus.WIN) {
      const refundDoc = {
        _id: refundDocId,
        orderId: targetOrderId,
        sessionId: session._id,
        sourceType: "CHALLENGE_FREE_ORDER",
        outRefundNo,
        amount: paidCents,
        amountYuan: (paidCents / 100).toFixed(2),
        status: "PENDING",
        wechatRefundId: null,
        errorCode: null,
        errorMessage: null,
        testMode: isTestMode,
        createdAt: now,
        updatedAt: now,
      };
      await t.collection(REFUNDS_COLLECTION).doc(refundDocId).set({
        data: refundDoc,
      });

      const taskDoc = {
        _id: refundTaskId,
        orderId: targetOrderId,
        sessionId: session._id,
        outRefundNo,
        amountCents: paidCents,
        status: "PENDING",
        retryCount: 0,
        maxRetries: 5,
        lastError: null,
        nextRetryAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await t.collection("refund_tasks").doc(refundTaskId).set({
        data: taskDoc,
      });

      taskDocToDispatch = taskDoc;
      refundDocToReturn = refundDoc;
    }
  });

  // 8. 事务 Commit 成功后，才允许向支付网关派发退款任务
  let refundInfo = null;
  if (settlement.challengeStatus === ChallengeStatus.WIN && taskDocToDispatch) {
    const dispatchRes = await dispatchRefundTask(taskDocToDispatch, session, order);
    refundInfo = {
      refundId: refundDocId,
      outRefundNo,
      amountCents: paidCents,
      amountYuan: refundDocToReturn.amountYuan,
      status: dispatchRes.status,
    };
  }

  return {
    success: true,
    data: {
      sessionId: session._id,
      challengeStatus: settlement.challengeStatus,
      isWinner: settlement.isWinner,
      result: settlement.result,
      refundInfo,
    },
  };
}

/**
 * 3. 派发并处理退款任务 (通过统一 paymentGateway 执行)
 */
async function dispatchRefundTask(taskDoc, session, order) {
  const isTestMode = session.activityMode === "TEST" || ACTIVITY_MODE === "TEST";
  const now = Date.now();
  const { refundDocId, outRefundNo, refundTaskId } = buildDeterministicRefundKeys({
    sessionId: session._id,
    orderId: taskDoc.orderId,
  });

  // TEST 模式：自动成功模拟
  if (isTestMode) {
    if (TEST_REFUND_MODE === "AUTO_SUCCESS") {
      await db.collection(REFUNDS_COLLECTION).doc(refundDocId).update({
        data: {
          status: "SUCCESS",
          updatedAt: now,
        },
      });

      await db.collection("refund_tasks").doc(refundTaskId).update({
        data: {
          status: "SUCCESS",
          updatedAt: now,
        },
      });

      await db.collection(ORDER_COLLECTION).doc(taskDoc.orderId).update({
        data: {
          challengeRefundStatus: ChallengeRefundStatus.SUCCESS,
          fulfillmentHold: FulfillmentHoldStatus.NONE, // 退款成功才允许释放暂扣！
          erpStatus: ErpStatus.READY,
          challengeRefundInfo: {
            refundId: refundDocId,
            outRefundNo,
            amountCents: taskDoc.amountCents,
            successTime: now,
          },
          updatedAt: now,
        },
      });

      return { status: "SUCCESS" };
    } else if (TEST_REFUND_MODE === "FAILURE") {
      await db.collection(REFUNDS_COLLECTION).doc(refundDocId).update({
        data: {
          status: "FAILED",
          updatedAt: now,
        },
      });
      await db.collection("refund_tasks").doc(refundTaskId).update({
        data: {
          status: "FAILED",
          lastError: "SIMULATED_TEST_FAILURE",
          updatedAt: now,
        },
      });
      return { status: "FAILED" };
    }

    return { status: "PENDING" };
  }

  // LIVE 模式：通过统一 paymentGateway 发起退款
  await db.collection("refund_tasks").doc(refundTaskId).update({
    data: {
      status: "PROCESSING",
      updatedAt: now,
    },
  });

  try {
    const refundRes = await paymentGateway.createRefund(cloud, {
      outTradeNo: taskDoc.orderId,
      outRefundNo,
      totalFee: taskDoc.amountCents,
      refundFee: taskDoc.amountCents,
      refundDesc: "3秒挑战免单全额返款",
      reason: "CHALLENGE_FREE_ORDER",
    });

    console.log("[dispatchRefundTask] paymentGateway.createRefund result:", refundRes);

    if (refundRes && (refundRes.status === "SUCCESS" || (refundRes.simulated && TEST_REFUND_MODE === "AUTO_SUCCESS"))) {
      await db.collection(REFUNDS_COLLECTION).doc(refundDocId).update({
        data: {
          status: "SUCCESS",
          wechatRefundId: refundRes.refundId || null,
          updatedAt: now,
        },
      });
      await db.collection("refund_tasks").doc(refundTaskId).update({
        data: {
          status: "SUCCESS",
          wechatRefundId: refundRes.refundId || null,
          updatedAt: now,
        },
      });
      await db.collection(ORDER_COLLECTION).doc(taskDoc.orderId).update({
        data: {
          challengeRefundStatus: ChallengeRefundStatus.SUCCESS,
          fulfillmentHold: FulfillmentHoldStatus.NONE,
          erpStatus: ErpStatus.READY,
          challengeRefundInfo: {
            refundId: refundDocId,
            outRefundNo,
            amountCents: taskDoc.amountCents,
            successTime: now,
          },
          updatedAt: now,
        },
      });
      return { status: "SUCCESS" };
    }

    return { status: "PROCESSING" };
  } catch (wxErr) {
    console.error("[dispatchRefundTask] paymentGateway.createRefund failed:", wxErr);
    const retryCount = (taskDoc.retryCount || 0) + 1;
    const maxRetries = taskDoc.maxRetries || 5;
    const nextStatus = retryCount >= maxRetries ? "DEAD_LETTER" : "RETRY";

    await db.collection("refund_tasks").doc(refundTaskId).update({
      data: {
        status: nextStatus,
        retryCount,
        lastError: wxErr.message,
        nextRetryAt: now + (nextStatus === "RETRY" ? 30000 * retryCount : 0),
        updatedAt: now,
      },
    });

    if (nextStatus === "DEAD_LETTER") {
      await db.collection(ORDER_COLLECTION).doc(taskDoc.orderId).update({
        data: {
          fulfillmentHold: FulfillmentHoldStatus.REFUND_PENDING,
          erpStatus: ErpStatus.HOLD,
          updatedAt: now,
        },
      });
    }

    return { status: nextStatus, error: wxErr.message };
  }
}

/**
 * 4. 恢复会话资格 (challengeResume)
 * [P0 核心解耦]：Resume 只恢复资格，绝不签发 timing ticket，绝不设置 serverStartResponseSentAt！
 */
async function handleResumeSession(openId, { sessionId, orderId }) {
  const targetSessionId = sessionId || (orderId ? `CHALLENGE_SESSION_${orderId}` : null);
  if (!targetSessionId) throw new Error("SessionId or orderId required");

  let session = null;
  try {
    const sessionRes = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(targetSessionId).get();
    session = sessionRes.data;
  } catch (e) {
    if (orderId) {
      const fallbackRes = await db
        .collection(CHALLENGE_SESSION_COLLECTION)
        .where({ orderId, _openid: openId })
        .limit(1)
        .get();
      session = fallbackRes.data && fallbackRes.data[0];
    }
  }

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
        sessionId: session._id,
        challengeStatus: session.challengeStatus,
        challengeCompleted: true,
        result: session.result,
        ruleSnapshot: session.ruleSnapshot,
      },
    };
  }

  // 若已经是 READY_TO_RESTART，幂等返回
  if (session.challengeStatus === ChallengeStatus.READY_TO_RESTART) {
    return {
      success: true,
      data: {
        sessionId: session._id,
        orderId: session.orderId,
        challengeStatus: ChallengeStatus.READY_TO_RESTART,
        readyToStart: true,
        resumeCount: session.resumeCount || 0,
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
    await db.collection(CHALLENGE_SESSION_COLLECTION).doc(session._id).update({
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
        sessionId: session._id,
        challengeStatus: ChallengeStatus.PENDING_REVIEW,
      },
    };
  }

  // [P0 核心解耦]：Resume 只恢复资格，绝不签发 timing ticket，绝不打点时序！
  // 必须立即使旧 ticket 与 nonce 彻底作废！
  const now = Date.now();
  await db.collection(CHALLENGE_SESSION_COLLECTION).doc(session._id).update({
    data: {
      challengeStatus: ChallengeStatus.READY_TO_RESTART,
      serverStartResponseSentAt: null, // 清空起始时序打点
      latestTicketNonce: null,         // 作废旧 Nonce
      latestTicket: null,              // 作废旧 Ticket
      resumeCount: currentResumeCount + 1,
      resumedAt: now,
      updatedAt: now,
    },
  });

  await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
    data: {
      challengeStatus: ChallengeStatus.READY_TO_RESTART,
      fulfillmentHold: FulfillmentHoldStatus.CHALLENGE_PENDING,
      erpStatus: ErpStatus.HOLD,
      updatedAt: now,
    },
  });

  return {
    success: true,
    data: {
      sessionId: session._id,
      orderId: session.orderId,
      challengeStatus: ChallengeStatus.READY_TO_RESTART,
      readyToStart: true,
      resumeCount: currentResumeCount + 1,
      ruleSnapshot: session.ruleSnapshot,
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
 * [P0 安全原则]：跳过必须永久消费资格，绝不允许在 REFUND_PENDING, SAFE_SETTLEMENT 下跳过！
 */
async function handleSkipChallenge(openId, { orderId }) {
  if (!orderId) throw new Error("OrderId required");

  const orderRes = await db.collection(ORDER_COLLECTION).doc(orderId).get();
  const order = orderRes.data;
  if (!order || order._openid !== openId) {
    throw new Error("Order not found or permission denied");
  }

  // 安全检查：只有 ELIGIBLE 或 READY_TO_RESTART 允许跳过！
  if (
    order.challengeStatus &&
    order.challengeStatus !== ChallengeStatus.ELIGIBLE &&
    order.challengeStatus !== ChallengeStatus.READY_TO_RESTART
  ) {
    throw new Error(`CANNOT_SKIP_IN_STATUS: ${order.challengeStatus}`);
  }

  if (
    order.fulfillmentHold === FulfillmentHoldStatus.REFUND_PENDING ||
    order.fulfillmentHold === FulfillmentHoldStatus.SAFE_SETTLEMENT
  ) {
    throw new Error(`CANNOT_SKIP_UNDER_HOLD: ${order.fulfillmentHold}`);
  }

  const now = Date.now();
  const sessionId = `CHALLENGE_SESSION_${orderId}`;

  // [P0 核心修复] 事务同步原子修改：order + challenge_session
  await runWithTransaction(db, async (t) => {
    // 1. 更新订单：永久消费资格，标记 LOSE 与 USER_SKIPPED，解除发货锁定
    await t.collection(ORDER_COLLECTION).doc(orderId).update({
      data: {
        challengeEligible: false, // 永久消费资格，严禁二次发起
        challengeStatus: ChallengeStatus.LOSE,
        challengeRefundStatus: ChallengeRefundStatus.NONE,
        settlementReason: "USER_SKIPPED",
        fulfillmentHold: FulfillmentHoldStatus.NONE, // 释放履约暂扣，进入正常备货
        erpStatus: ErpStatus.READY,                  // 允许进入 ERP
        updatedAt: now,
      },
    });

    // 2. 如果存在关联 Session，同一事务内同步置为 LOSE 终态，彻底防止 Session 孤立被刷
    try {
      await t.collection(CHALLENGE_SESSION_COLLECTION).doc(sessionId).update({
        data: {
          challengeStatus: ChallengeStatus.LOSE,
          settlementReason: "USER_SKIPPED",
          updatedAt: now,
        },
      });
    } catch (sessErr) {
      // 若 Session 尚未创建可安全忽略
    }
  });

  return { success: true };
}

/**
 * 6.1 容灾恢复卡死在 SETTLING 的会话 (recoverSettlingSession)
 */
async function handleRecoverSettlingSession(openId, { sessionId, orderId }) {
  const targetSessionId = sessionId || (orderId ? `CHALLENGE_SESSION_${orderId}` : null);
  if (!targetSessionId) throw new Error("SessionId or orderId required");

  const sessionRes = await db.collection(CHALLENGE_SESSION_COLLECTION).doc(targetSessionId).get();
  const session = sessionRes.data;
  if (!session) throw new Error("Session not found");

  // 如果会话在 SETTLING 超过 10 秒
  const now = Date.now();
  if (
    session.challengeStatus === ChallengeStatus.SETTLING &&
    now - (session.settlingStartedAt || 0) > 10000
  ) {
    console.warn("[handleRecoverSettlingSession] Recovering stuck settling session:", targetSessionId);
    // 自动移交人工或风控审核，绝不陷入死锁
    await db.collection(CHALLENGE_SESSION_COLLECTION).doc(targetSessionId).update({
      data: {
        challengeStatus: ChallengeStatus.PENDING_REVIEW,
        reviewReason: "SETTLING_TIMEOUT_RECOVERED",
        updatedAt: now,
      },
    });
    await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
      data: {
        challengeStatus: ChallengeStatus.PENDING_REVIEW,
        challengeEligible: false,
        fulfillmentHold: FulfillmentHoldStatus.SAFE_SETTLEMENT,
        erpStatus: ErpStatus.HOLD,
        updatedAt: now,
      },
    });
    return { success: true, recovered: true, status: ChallengeStatus.PENDING_REVIEW };
  }

  return { success: true, recovered: false, status: session.challengeStatus };
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

      case "recoverSettlingSession":
        return await handleRecoverSettlingSession(openId, payload);

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
