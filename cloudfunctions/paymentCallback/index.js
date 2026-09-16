const cloud = require("wx-server-sdk");
const Collections = require("../shared/collections");
let initClientSDK;
try {
  initClientSDK = require("./wxCloudClientSDK.umd.js").init;
} catch (e) {
  initClientSDK = null;
}
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

if (typeof initClientSDK === "function") {
  try {
    initClientSDK(cloud);
  } catch (e) {
    console.warn("[paymentCallback] initClientSDK warning:", e.message);
  }
}

const STATUS_PENDING_PAYMENT = "PENDING_PAYMENT";
const STATUS_PENDING_DELIVERY = "PENDING_DELIVERY";

function normalizeWxpayResource(resource) {
  if (!resource) return null;
  if (typeof resource === "string") {
    try {
      return JSON.parse(resource);
    } catch (err) {
      return { ciphertext: resource };
    }
  }
  return resource;
}

function decryptWxpayResource(resource, apiV3Key) {
  const normalized = normalizeWxpayResource(resource);
  const {
    ciphertext,
    nonce,
    associated_data: associatedData,
  } = normalized || {};
  if (!ciphertext || !nonce || !apiV3Key) {
    throw new Error("Missing ciphertext/nonce/associated_data or apiV3Key");
  }

  const buf = Buffer.from(ciphertext, "base64");
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(apiV3Key, "utf-8"),
    Buffer.from(nonce, "utf-8")
  );
  decipher.setAuthTag(authTag);
  if (associatedData) {
    decipher.setAAD(Buffer.from(associatedData, "utf-8"));
  }

  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString("utf-8");
  return JSON.parse(decrypted);
}

function createHandler(deps = {}) {
  const cloudInstance = deps.cloud || cloud;
  const db = deps.db || cloudInstance.database();
  const _ = db.command;

  /**
   * 严格核实活动与规则快照 (Fail-Closed 审计)
   */
  async function checkChallengeEligibility(order, isLive) {
    try {
      const goodsList = order && order.goodsList;
      if (!Array.isArray(goodsList) || goodsList.length === 0) {
        return { isEligible: false, reason: "NO_GOODS" };
      }

      // 强校验：防混购套利防线。参与 3 秒挑战免单的订单必须单商品单件！
      const totalCount = goodsList.reduce((sum, g) => sum + (Number(g.quantity) || 1), 0);
      if (goodsList.length > 1 || totalCount > 1) {
        console.warn("[checkChallengeEligibility] Multi goods/items blocked from challenge eligibility:", {
          goodsCount: goodsList.length,
          totalCount,
        });
        return { isEligible: false, reason: "MIXED_GOODS_OR_MULTI_ITEMS" };
      }

      const targetGood = goodsList[0];
      const now = Date.now();
      const actRes = await db
        .collection(Collections.ACTIVITIES)
        .where({
          type: "THREE_SECOND_CHALLENGE",
          status: "ACTIVE",
          startTime: _.lte(now),
          endTime: _.gte(now),
        })
        .limit(1)
        .get();

      if (!actRes.data || actRes.data.length === 0) {
        return { isEligible: false, reason: "NO_ACTIVE_ACTIVITY" };
      }

      const activity = actRes.data[0];

      // 如果活动限制特定 spu/sku，做严格比对（严禁 .some 混购套利）
      if (activity.applicableSpuIds && activity.applicableSpuIds.length > 0) {
        if (!activity.applicableSpuIds.includes(targetGood.spuId)) {
          return { isEligible: false, reason: "SPU_NOT_IN_ACTIVITY" };
        }
      }

      // 查询绑定的完整规则并生成不可变快照 challengeRuleSnapshot
      let ruleSnapshot = null;
      const ruleVersionToFind = activity.ruleVersion;
      let ruleRes;
      try {
        if (ruleVersionToFind) {
          ruleRes = await db
            .collection(Collections.CHALLENGE_RULES)
            .where({ ruleVersion: ruleVersionToFind, status: "ACTIVE" })
            .limit(1)
            .get();
        } else {
          ruleRes = await db
            .collection(Collections.CHALLENGE_RULES)
            .where({ status: "ACTIVE" })
            .orderBy("effectiveFrom", "desc")
            .limit(1)
            .get();
        }
      } catch (rErr) {
        console.warn("[checkChallengeEligibility] query challenge_rules warning:", rErr.message);
        ruleRes = { data: [] };
      }

      const dbRule = ruleRes && ruleRes.data && ruleRes.data[0];
      if (dbRule) {
        ruleSnapshot = {
          ruleId: dbRule._id || dbRule.ruleId || "RULE_3S_DEFAULT",
          ruleVersion: dbRule.ruleVersion || activity.ruleVersion || "TEST_V1",
          gameType: dbRule.gameType || "THREE_SECOND_STOPWATCH",
          targetTimeMs: Number(dbRule.targetTimeMs) || 3000,
          successMinMs: Number(dbRule.successMinMs) || 2980,
          successMaxMs: Number(dbRule.successMaxMs) || 3020,
          maxRoundDurationMs: Number(dbRule.maxRoundDurationMs) || 10000,
          timingToleranceMs: Number(dbRule.timingToleranceMs) || 50,
          negativeToleranceMs: Number(dbRule.negativeToleranceMs) || 0,
          maxResumeCount: Number(dbRule.maxResumeCount) || 1,
        };
      } else {
        // [P0 关键修复] LIVE 模式下严禁使用临时默认规则 fallback，必须 Fail-Closed！
        if (isLive) {
          console.error("[checkChallengeEligibility] LIVE Fail-Closed: challenge_rules not found for activity:", activity._id);
          try {
            await db.collection(Collections.RISK_LOGS).add({
              data: {
                type: "CHALLENGE_RULE_NOT_FOUND",
                activityId: activity._id,
                orderId: order._id,
                spuId: targetGood.spuId,
                createdAt: now,
                message: "LIVE模式未找到关联的有效挑战规则，Fail-Closed拒绝挑战资格",
              },
            });
          } catch (logErr) {
            console.warn("[checkChallengeEligibility] log risk failed:", logErr.message);
          }
          return { isEligible: false, reason: "CHALLENGE_RULE_NOT_FOUND" };
        }

        // 仅在非 LIVE / TEST_MODE 模式下允许测试默认规则
        ruleSnapshot = {
          ruleId: activity.ruleId || "RULE_3S_DEFAULT",
          ruleVersion: activity.ruleVersion || "TEST_V1",
          gameType: "THREE_SECOND_STOPWATCH",
          targetTimeMs: 3000,
          successMinMs: 2980,
          successMaxMs: 3020,
          maxRoundDurationMs: 10000,
          timingToleranceMs: 50,
          negativeToleranceMs: 0,
          maxResumeCount: 1,
        };
      }

      return {
        isEligible: true,
        activityId: activity._id || activity.activityId || "ACT_3S_CHALLENGE",
        ruleVersion: ruleSnapshot.ruleVersion,
        challengeRuleSnapshot: ruleSnapshot,
      };
    } catch (err) {
      console.warn(
        "[checkChallengeEligibility] Query activities failed, fallback to false:",
        err
      );
      return { isEligible: false, reason: err.message };
    }
  }

  return async function handlePaymentCallback(event, context) {
    console.log("[paymentCallback] event:", event);

    const isLive = process.env.NODE_ENV === "production" || process.env.ACTIVITY_MODE === "LIVE";

    let returnCode = "FAIL";
    let resultCode = "FAIL";
    let outTradeNo = null;
    let transactionId = null;
    let timeEnd = null;
    let totalFee = null;
    let cashFee = null;

    // 微信支付 V3 官方推送 (含 encrypted resource)
    if (event && event.resource) {
      try {
        const apiV3Key = process.env.WX_PAY_APIV3_KEY;
        if (!apiV3Key) {
          throw new Error("WX_PAY_APIV3_KEY environment variable not configured");
        }
        const payload = event;
        const decrypted = decryptWxpayResource(event.resource, apiV3Key);
        outTradeNo = decrypted.out_trade_no;
        transactionId = decrypted.transaction_id;
        timeEnd = decrypted.success_time;
        totalFee = decrypted.amount ? decrypted.amount.total : undefined;
        cashFee = decrypted.amount ? decrypted.amount.payer_total : undefined;
        returnCode = "SUCCESS";
        resultCode =
          payload && payload.event_type === "TRANSACTION.SUCCESS"
            ? "SUCCESS"
            : "FAIL";

        console.log("[paymentCallback] decrypted wxpay payload:", {
          outTradeNo,
          transactionId,
          timeEnd,
          totalFee,
          cashFee,
        });
      } catch (err) {
        console.error("[paymentCallback] decrypt wxpay resource failed:", err);
        return { errcode: 1, errmsg: "DECRYPT_FAILED" };
      }
    } else {
      // 关键安全防线：在 LIVE 生产环境中，只信任官方安全触发器，严禁外部普通调用伪造支付！
      if (isLive) {
        console.error("[paymentCallback] Untrusted caller in LIVE environment! Blocked.");
        return { errcode: 1, errmsg: "UNTRUSTED_CALL_SOURCE" };
      }

      // 仅在非 LIVE / TEST 环境下允许模拟调用
      ({
        returnCode,
        resultCode,
        outTradeNo,
        transactionId,
        timeEnd,
        totalFee,
        cashFee,
      } = event || {});
    }

    if (returnCode !== "SUCCESS" || resultCode !== "SUCCESS") {
      console.warn("[paymentCallback] non-success return/result:", {
        returnCode,
        resultCode,
        outTradeNo,
      });
      return { errcode: 0, errmsg: "IGNORE_FAILURE" };
    }

    if (!outTradeNo) {
      console.warn("[paymentCallback] missing outTradeNo:", event);
      return { errcode: 1, errmsg: "MISSING_OUT_TRADE_NO" };
    }

    try {
      console.log("[paymentCallback] fetching order:", outTradeNo);
      // 1. 查询订单
      let order = null;
      if (cloudInstance.models && cloudInstance.models.order) {
        const orderRes = await cloudInstance.models.order.get({
          filter: {
            where: {
              $and: [
                {
                  _id: { $eq: outTradeNo },
                },
              ],
            },
          },
          select: {
            _id: true,
            status: true,
            orderSummary: true,
            goodsList: true,
          },
        });
        order = orderRes.data;
      } else {
        const orderRes = await db.collection(Collections.ORDER).doc(outTradeNo).get();
        order = orderRes.data;
      }

      if (!order) {
        console.error("[paymentCallback] order not found:", outTradeNo);
        return { errcode: 1, errmsg: "ORDER_NOT_FOUND" };
      }

      // 2. 幂等性防护：若订单已经是 PENDING_DELIVERY / PROCESSING / COMPLETE，直接成功返回
      if (order.status !== STATUS_PENDING_PAYMENT) {
        console.log(
          "[paymentCallback] order already processed or not in PENDING_PAYMENT:",
          {
            outTradeNo,
            currentStatus: order.status,
          }
        );
        return { errcode: 0, errmsg: "ORDER_ALREADY_PAID_OR_PROCESSED" };
      }

      // 3. [P0 严闭合资金校验] 强校验支付金额 (Fail-Closed)
      const expectedCents = Math.round(
        Number(order.orderSummary ? order.orderSummary.totalPayAmount : 0) * 100
      );

      if (totalFee == null || totalFee === undefined) {
        if (isLive) {
          console.error(
            "[paymentCallback] PAYMENT_AMOUNT_MISSING in LIVE! Intercepted:",
            {
              orderId: outTradeNo,
            }
          );
          return { errcode: 1, errmsg: "PAYMENT_AMOUNT_MISSING" };
        }
      }

      const actualCents = Number(
        totalFee != null ? totalFee : isLive ? NaN : expectedCents
      );
      if (Number.isNaN(actualCents) || actualCents <= 0) {
        console.error("[paymentCallback] INVALID_PAYMENT_AMOUNT:", {
          outTradeNo,
          totalFee,
        });
        return { errcode: 1, errmsg: "INVALID_PAYMENT_AMOUNT" };
      }

      if (actualCents !== expectedCents) {
        console.error(
          "[paymentCallback] PAYMENT_AMOUNT_MISMATCH! Intercepted:",
          {
            orderId: outTradeNo,
            actualCents,
            expectedCents,
          }
        );
        // 记录支付异常，不修改订单主支付状态，拒绝推进订单
        const anomalyData = {
          paymentAnomaly: {
            reason: "AMOUNT_MISMATCH",
            actualCents,
            expectedCents,
            transactionId,
            time: Date.now(),
          },
        };
        if (cloudInstance.models && cloudInstance.models.order) {
          await cloudInstance.models.order.update({
            filter: {
              where: {
                $and: [{ _id: { $eq: outTradeNo } }],
              },
            },
            data: anomalyData,
          });
        } else {
          await db.collection(Collections.ORDER).doc(outTradeNo).update({
            data: anomalyData,
          });
        }
        return { errcode: 1, errmsg: "PAYMENT_AMOUNT_MISMATCH" };
      }

      // 4. 活动资质校验 (严格防混购套利并锁定活动版本)
      const eligibilityResult = await checkChallengeEligibility(order, isLive);
      const isEligible = Boolean(eligibilityResult && eligibilityResult.isEligible);

      const nextStatus = STATUS_PENDING_DELIVERY;
      const now = Date.now();

      console.log("[paymentCallback] updating order to PENDING_DELIVERY:", {
        outTradeNo,
        isEligible,
        eligibilityResult,
      });

      const updateData = {
        status: nextStatus,
        payTime: now,
        paidAmountCents: actualCents,
        wechatPayInfo: {
          transactionId,
          timeEnd,
          totalFee: actualCents,
          cashFee,
        },
        challengeEligible: isEligible,
        challengeActivityId: isEligible ? eligibilityResult.activityId : null,
        challengeRuleVersion: isEligible ? eligibilityResult.ruleVersion : null,
        challengeRuleSnapshot: isEligible ? eligibilityResult.challengeRuleSnapshot : null,
        challengeStatus: isEligible ? "ELIGIBLE" : "NONE",
        challengeRefundStatus: "NONE",
        fulfillmentHold: isEligible ? "CHALLENGE_PENDING" : "NONE",
        erpStatus: isEligible ? "HOLD" : "READY",
      };

      if (cloudInstance.models && cloudInstance.models.order) {
        await cloudInstance.models.order.update({
          filter: {
            where: {
              $and: [
                { _id: { $eq: outTradeNo } },
                { status: { $eq: STATUS_PENDING_PAYMENT } },
              ],
            },
          },
          data: updateData,
        });
      } else {
        await db.collection(Collections.ORDER).doc(outTradeNo).update({
          data: updateData,
        });
      }

      console.log("[paymentCallback] order update success for:", outTradeNo);
      return { errcode: 0, errmsg: "SUCCESS" };
    } catch (err) {
      console.error("[paymentCallback] handler error:", err);
      return { errcode: 1, errmsg: err.message || "INTERNAL_ERROR" };
    }
  };
}

exports.createHandler = createHandler;
exports.main = createHandler();
