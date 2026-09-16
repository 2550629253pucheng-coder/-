const cloud = require("wx-server-sdk");
const paymentGateway = require("../shared/paymentGateway.js");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

const CHALLENGE_SESSION_COLLECTION = "challenge_sessions";
const ORDER_COLLECTION = "order";
const REFUNDS_COLLECTION = "refunds";
const REFUND_TASKS_COLLECTION = "refund_tasks";

const SETTLING_TIMEOUT_MS = 60 * 1000; // 60秒超时卡死判定
const PROCESSING_TIMEOUT_MS = 120 * 1000; // 120秒退款处理超时主动查单

/**
 * 1. 扫描并恢复卡死在 SETTLING 状态的挑战会话
 */
async function recoverSettlingSessions() {
  const now = Date.now();
  const thresholdTime = now - SETTLING_TIMEOUT_MS;

  console.log("[challengeRecovery] Scanning SETTLING sessions before:", new Date(thresholdTime).toISOString());

  const stuckSessionsRes = await db
    .collection(CHALLENGE_SESSION_COLLECTION)
    .where({
      challengeStatus: "SETTLING",
      settlingStartedAt: _.lte(thresholdTime),
    })
    .limit(20)
    .get();

  const sessions = stuckSessionsRes.data || [];
  console.log(`[challengeRecovery] Found ${sessions.length} stuck SETTLING sessions`);

  const results = [];

  for (const session of sessions) {
    try {
      const orderRes = await db.collection(ORDER_COLLECTION).doc(session.orderId).get();
      const order = orderRes.data;

      if (!order) {
        console.error(`[challengeRecovery] Session ${session._id} associated order ${session.orderId} not found`);
        continue;
      }

      // 检查 order 状态：如果 order 已经完成结算流转
      if (["WIN", "LOSE", "PENDING_REVIEW"].includes(order.challengeStatus)) {
        console.log(`[challengeRecovery] Session ${session._id} sync to order status: ${order.challengeStatus}`);
        await db.collection(CHALLENGE_SESSION_COLLECTION).doc(session._id).update({
          data: {
            challengeStatus: order.challengeStatus,
            reviewReason: "RECOVERED_SYNC_FROM_ORDER",
            settlingRecoveryStatus: "RECOVERED_MATCHED_ORDER",
            updatedAt: now,
          },
        });
        results.push({ sessionId: session._id, action: "SYNCED_TO_ORDER", status: order.challengeStatus });
        continue;
      }

      // 如果 order 仍为未决状态（说明事务未提交或中断崩溃）
      const ruleSnapshot = session.ruleSnapshot || {};
      const maxResumeCount = ruleSnapshot.maxResumeCount || 1;
      const currentResumeCount = session.resumeCount || 0;

      if (currentResumeCount < maxResumeCount) {
        // 回滚到可重试状态 READY_TO_RESTART
        console.log(`[challengeRecovery] Session ${session._id} rollback to READY_TO_RESTART`);
        await db.collection(CHALLENGE_SESSION_COLLECTION).doc(session._id).update({
          data: {
            challengeStatus: "READY_TO_RESTART",
            serverStartResponseSentAt: null,
            latestTicketNonce: null,
            settlingRecoveryStatus: "RECOVERED_TO_RESTART",
            updatedAt: now,
          },
        });

        await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
          data: {
            challengeStatus: "READY_TO_RESTART",
            fulfillmentHold: "CHALLENGE_PENDING",
            erpStatus: "HOLD",
            updatedAt: now,
          },
        });
        results.push({ sessionId: session._id, action: "ROLLBACK_TO_RESTART" });
      } else {
        // 恢复次数超限，置入 PENDING_REVIEW 风控审核
        console.log(`[challengeRecovery] Session ${session._id} moved to PENDING_REVIEW`);
        await db.collection(CHALLENGE_SESSION_COLLECTION).doc(session._id).update({
          data: {
            challengeStatus: "PENDING_REVIEW",
            reviewReason: "SETTLING_TIMEOUT_RECOVERED",
            settlingRecoveryStatus: "RECOVERED_TO_REVIEW",
            updatedAt: now,
          },
        });

        await db.collection(ORDER_COLLECTION).doc(session.orderId).update({
          data: {
            challengeStatus: "PENDING_REVIEW",
            challengeEligible: false,
            fulfillmentHold: "SAFE_SETTLEMENT",
            erpStatus: "HOLD",
            updatedAt: now,
          },
        });
        results.push({ sessionId: session._id, action: "MOVED_TO_REVIEW" });
      }
    } catch (err) {
      console.error(`[challengeRecovery] Error recovering session ${session._id}:`, err);
      results.push({ sessionId: session._id, error: err.message });
    }
  }

  return results;
}

/**
 * 2. 补偿与主动对账退款任务 (Refund Task Worker)
 */
async function processRefundTasks() {
  const now = Date.now();
  const processingThreshold = now - PROCESSING_TIMEOUT_MS;

  const results = {
    queriedProcessing: 0,
    retried: 0,
    deadLetters: 0,
  };

  // 2.1 主动对账：对处于 PROCESSING 超过 120 秒的任务，主动向微信支付查询退款状态
  try {
    const processingTasksRes = await db
      .collection(REFUND_TASKS_COLLECTION)
      .where({
        status: "PROCESSING",
        updatedAt: _.lte(processingThreshold),
      })
      .limit(10)
      .get();

    const processingTasks = processingTasksRes.data || [];
    for (const task of processingTasks) {
      console.log("[challengeRecovery] Querying refund status for task:", task._id, task.outRefundNo);
      try {
        const queryRes = await paymentGateway.queryRefund(cloud, {
          outRefundNo: task.outRefundNo,
        });

        if (queryRes && queryRes.status === "SUCCESS") {
          console.log("[challengeRecovery] Refund confirmed SUCCESS via query:", task.outRefundNo);
          // 确认成功：更新 refund, task, order
          await db.collection(REFUNDS_COLLECTION).doc(`CHALLENGE_REFUND_${task.orderId}`).update({
            data: {
              status: "SUCCESS",
              wechatRefundId: queryRes.refundId || null,
              updatedAt: now,
            },
          });

          await db.collection(REFUND_TASKS_COLLECTION).doc(task._id).update({
            data: {
              status: "SUCCESS",
              wechatRefundId: queryRes.refundId || null,
              updatedAt: now,
            },
          });

          await db.collection(ORDER_COLLECTION).doc(task.orderId).update({
            data: {
              challengeRefundStatus: "SUCCESS",
              fulfillmentHold: "NONE", // 解锁发货
              erpStatus: "READY",
              updatedAt: now,
            },
          });
          results.queriedProcessing++;
        } else if (queryRes && (queryRes.status === "CLOSED" || queryRes.status === "ABNORMAL")) {
          const retryCount = (task.retryCount || 0) + 1;
          const maxRetries = task.maxRetries || 5;
          const nextStatus = retryCount >= maxRetries ? "DEAD_LETTER" : "RETRY";

          await db.collection(REFUND_TASKS_COLLECTION).doc(task._id).update({
            data: {
              status: nextStatus,
              retryCount,
              lastError: `QUERY_FAILED_${queryRes.status}`,
              nextRetryAt: now + (nextStatus === "RETRY" ? 30000 * retryCount : 0),
              updatedAt: now,
            },
          });

          if (nextStatus === "DEAD_LETTER") {
            results.deadLetters++;
          }
        }
      } catch (qErr) {
        console.warn("[challengeRecovery] Query refund error:", qErr.message);
      }
    }
  } catch (err) {
    console.warn("[challengeRecovery] Query processing tasks failed:", err.message);
  }

  // 2.2 重试退款：对处于 RETRY 且 nextRetryAt <= now 的任务重新发起
  try {
    const retryTasksRes = await db
      .collection(REFUND_TASKS_COLLECTION)
      .where({
        status: "RETRY",
        nextRetryAt: _.lte(now),
      })
      .limit(10)
      .get();

    const retryTasks = retryTasksRes.data || [];
    for (const task of retryTasks) {
      console.log("[challengeRecovery] Retrying refund task:", task._id);
      try {
        const refundRes = await paymentGateway.createRefund(cloud, {
          outTradeNo: task.orderId,
          outRefundNo: task.outRefundNo,
          totalFee: task.amountCents,
          refundFee: task.amountCents,
          refundDesc: "3秒挑战免单全额返款",
          reason: "CHALLENGE_FREE_ORDER",
        });

        if (refundRes && (refundRes.status === "SUCCESS" || refundRes.simulated)) {
          await db.collection(REFUNDS_COLLECTION).doc(`CHALLENGE_REFUND_${task.orderId}`).update({
            data: {
              status: "SUCCESS",
              wechatRefundId: refundRes.refundId || null,
              updatedAt: now,
            },
          });

          await db.collection(REFUND_TASKS_COLLECTION).doc(task._id).update({
            data: {
              status: "SUCCESS",
              wechatRefundId: refundRes.refundId || null,
              updatedAt: now,
            },
          });

          await db.collection(ORDER_COLLECTION).doc(task.orderId).update({
            data: {
              challengeRefundStatus: "SUCCESS",
              fulfillmentHold: "NONE",
              erpStatus: "READY",
              updatedAt: now,
            },
          });
        } else {
          await db.collection(REFUND_TASKS_COLLECTION).doc(task._id).update({
            data: {
              status: "PROCESSING",
              updatedAt: now,
            },
          });
        }
        results.retried++;
      } catch (retryErr) {
        console.error(`[challengeRecovery] Retry refund failed for ${task._id}:`, retryErr.message);
        const retryCount = (task.retryCount || 0) + 1;
        const maxRetries = task.maxRetries || 5;
        const nextStatus = retryCount >= maxRetries ? "DEAD_LETTER" : "RETRY";

        await db.collection(REFUND_TASKS_COLLECTION).doc(task._id).update({
          data: {
            status: nextStatus,
            retryCount,
            lastError: retryErr.message,
            nextRetryAt: now + (nextStatus === "RETRY" ? 30000 * retryCount : 0),
            updatedAt: now,
          },
        });

        if (nextStatus === "DEAD_LETTER") {
          results.deadLetters++;
        }
      }
    }
  } catch (err) {
    console.warn("[challengeRecovery] Fetch retry tasks failed:", err.message);
  }

  return results;
}

exports.main = async (event, context) => {
  console.log("[challengeRecovery] Triggered at:", new Date().toISOString(), "event:", event);

  try {
    const sessionRecoveryResults = await recoverSettlingSessions();
    const refundTaskResults = await processRefundTasks();

    return {
      success: true,
      timestamp: Date.now(),
      sessionRecoveryResults,
      refundTaskResults,
    };
  } catch (err) {
    console.error("[challengeRecovery] fatal error:", err);
    return {
      success: false,
      error: err.message,
    };
  }
};
