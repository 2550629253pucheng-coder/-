const cloud = require("wx-server-sdk");
const { init } = require("./wxCloudClientSDK.umd.js");
const crypto = require("crypto");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

init(cloud);

const db = cloud.database();
const _ = db.command;

const STATUS_PENDING_PAYMENT = "PENDING_PAYMENT";
const STATUS_PENDING_DELIVERY = "PENDING_DELIVERY";

const ACTIVITIES_COLLECTION = "activities";

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

  const decipher = crypto.createDecipheriv("aes-256-gcm", apiV3Key, nonce);
  if (associatedData) {
    decipher.setAAD(Buffer.from(associatedData));
  }
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * 校验订单是否命中 3 秒挑战活动资格
 * 规则：activities 表存在 ACTIVE 状态活动，时间在有效范围内；
 * 严格防套利规则：Challenge订单必须单商品单件（goodsList.length === 1 && quantity === 1），绝不允许混购！
 */
async function checkChallengeEligibility(order) {
  try {
    const goodsList = order.goodsList || [];
    const totalCount = goodsList.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );
    if (goodsList.length !== 1 || totalCount !== 1) {
      return { isEligible: false, reason: "NOT_SINGLE_SKU" };
    }

    const targetGood = goodsList[0];
    const now = Date.now();
    const actRes = await db
      .collection(ACTIVITIES_COLLECTION)
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

    return {
      isEligible: true,
      activityId: activity._id || activity.activityId || "ACT_3S_CHALLENGE",
      ruleVersion: activity.ruleVersion || "TEST_V1",
    };
  } catch (err) {
    console.warn(
      "[checkChallengeEligibility] Query activities failed, fallback to false:",
      err
    );
    return { isEligible: false, reason: err.message };
  }
}

exports.main = async (event, context) => {
  console.log("[paymentCallback] event:", event);

  const isLive = process.env.NODE_ENV === "production" || process.env.ACTIVITY_MODE === "LIVE";

  let returnCode;
  let resultCode;
  let outTradeNo;
  let transactionId;
  let timeEnd;
  let totalFee;
  let cashFee;
  let isTriggerFromWxpay = false;

  // 1. 微信支付触发器回调解析
  if (
    event &&
    event.wxpayTrigger &&
    event.wxpayTrigger.input &&
    event.wxpayTrigger.input.data
  ) {
    try {
      isTriggerFromWxpay = true;
      const input = event.wxpayTrigger.input || {};
      const payload = JSON.parse(input.data);
      const plaintext = decryptWxpayResource(
        payload && payload.resource,
        input.apiV3key
      );
      const decrypted = JSON.parse(plaintext);

      outTradeNo = decrypted.out_trade_no;
      transactionId = decrypted.transaction_id;
      timeEnd = decrypted.success_time || decrypted.time_end;
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
    const orderRes = await cloud.models.order.get({
      filter: {
        where: {
          $and: [
            {
              _id: { $eq: outTradeNo },
            },
          ],
        },
      },
    });

    const order = orderRes.data;

    if (!order) {
      console.error("[paymentCallback] order not found:", outTradeNo);
      return { errcode: 1, errmsg: "ORDER_NOT_FOUND" };
    }

    // 2. 状态单向扭转守护：只允许 PENDING_PAYMENT -> PENDING_DELIVERY
    if (order.status !== STATUS_PENDING_PAYMENT) {
      // 若已经是 PENDING_DELIVERY，幂等返回成功
      if (order.status === STATUS_PENDING_DELIVERY) {
        console.log("[paymentCallback] already processed PENDING_DELIVERY:", outTradeNo);
        return { errcode: 0, errmsg: "SUCCESS" };
      }
      // 若已经处于 PENDING_RECEIPT 或 COMPLETE 等后续流程，绝不逆流倒退！
      console.warn("[paymentCallback] Order is already advanced, state backward rejected:", {
        orderId: outTradeNo,
        currentStatus: order.status,
      });
      return { errcode: 0, errmsg: "ORDER_ALREADY_ADVANCED" };
    }

    // 3. 严格金额校验：Fail-Closed 原则（一分钱不差，严禁允许 ±1 分容忍度）
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
      await cloud.models.order.update({
        filter: {
          where: {
            $and: [{ _id: { $eq: outTradeNo } }],
          },
        },
        data: {
          paymentAnomaly: {
            reason: "AMOUNT_MISMATCH",
            actualCents,
            expectedCents,
            transactionId,
            time: Date.now(),
          },
        },
      });
      return { errcode: 1, errmsg: "PAYMENT_AMOUNT_MISMATCH" };
    }

    // 4. 活动资质校验 (严格防混购套利并锁定活动版本)
    const eligibilityResult = await checkChallengeEligibility(order);
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
      paidAmountCents: actualCents, // 唯一合法退款基准：必须等于微信支付实收回调
      wechatPayInfo: {
        transactionId,
        timeEnd,
        totalFee: actualCents,
        cashFee,
      },
      // 若命中活动：锁定活动ID、规则版本、置入挑战资格与暂扣状态；若未命中：直接 READY，无暂扣
      challengeEligible: isEligible,
      challengeActivityId: isEligible ? eligibilityResult.activityId : null,
      challengeRuleVersion: isEligible ? eligibilityResult.ruleVersion : null,
      challengeStatus: isEligible ? "ELIGIBLE" : "NONE",
      challengeRefundStatus: "NONE",
      fulfillmentHold: isEligible ? "CHALLENGE_PENDING" : "NONE",
      erpStatus: isEligible ? "HOLD" : "READY",
    };

    const updateRes = await cloud.models.order.update({
      filter: {
        where: {
          $and: [
            {
              _id: { $eq: outTradeNo },
            },
            {
              status: { $eq: STATUS_PENDING_PAYMENT }, // CAS 单向更新
            },
          ],
        },
      },
      data: updateData,
    });

    console.log("[paymentCallback] order update success:", updateRes);
    return { errcode: 0, errmsg: "SUCCESS" };
  } catch (err) {
    console.error("[paymentCallback] handler error:", err);
    return { errcode: 1, errmsg: err.message || "INTERNAL_ERROR" };
  }
};
