const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

let privateConfig = {};
try {
  privateConfig = require("./config.private.js");
} catch (error) {
  privateConfig = {};
}

const db = cloud.database();
const _ = db.command;
const shippingConfig =
  (privateConfig.order && privateConfig.order.shipping) || {};

function roundCurrency(amount) {
  return Math.round(Number(amount || 0) * 100) / 100;
}

function formatAmount(amount) {
  return roundCurrency(amount).toFixed(2);
}

function buildOrderSummary({ goodsTotalAmount, deliveryType }) {
  const freeShippingThreshold =
    Number(shippingConfig.freeShippingThreshold) || 0;
  const defaultFee = Number(shippingConfig.defaultFee) || 0;
  const normalizedDeliveryType = Number(deliveryType) === 2 ? 2 : 1;
  const shouldChargeShipping =
    normalizedDeliveryType === 1 && goodsTotalAmount < freeShippingThreshold;
  const deliveryFee = shouldChargeShipping ? defaultFee : 0;
  const promotionAmount = 0;
  const totalPayAmount = Math.max(
    0,
    goodsTotalAmount + deliveryFee - promotionAmount
  );

  return {
    totalGoodsCount: 0,
    totalSalePrice: formatAmount(goodsTotalAmount),
    deliveryFee: formatAmount(deliveryFee),
    promotionAmount: formatAmount(promotionAmount),
    totalPayAmount: formatAmount(totalPayAmount),
    invoiceSupport: true,
  };
}

exports.main = async (event, context) => {
  console.log("[createOrder] event:", event);
  const { goodsList, orderData } = event;

  // 参数校验
  if (!goodsList || !orderData) {
    console.warn("[createOrder] missing params:", { goodsList, orderData });
    return {
      success: false,
      message: "参数不完整",
    };
  }

  const wxContext = cloud.getWXContext();
  const openId = wxContext.OPENID;
  console.log("[createOrder] openId:", openId);

  // 0. 读取分销来源（记录最后一次推荐关系）
  let distributorOpenid = "";
  let distributorNickName = "";
  try {
    const userRes = await db
      .collection("user_info")
      .where({ _openid: openId })
      .limit(1)
      .get();
    const user = userRes.data && userRes.data.length ? userRes.data[0] : null;
    const referrerOpenid = user && user.referrerOpenid;
    if (referrerOpenid && referrerOpenid !== openId) {
      const distributorRes = await db
        .collection("user_info")
        .where({
          _openid: referrerOpenid,
          distributorStatus: "APPROVED",
        })
        .limit(1)
        .get();
      const distributor =
        distributorRes.data && distributorRes.data.length
          ? distributorRes.data[0]
          : null;
      if (
        distributor &&
        (distributor.role === "distributor" ||
          distributor.distributorStatus === "APPROVED")
      ) {
        distributorOpenid = referrerOpenid;
        distributorNickName = distributor.nickName || "";
      }
    }
  } catch (err) {
    console.warn("[createOrder] fetch distributor info failed:", err);
  }

  const transaction = await db.startTransaction();

  try {
    console.log(
      "[createOrder] start transaction, input goods count:",
      goodsList.length
    );

    // [P0 安全架构] 核心商品数据服务端 Canonical 化：
    // 客户端只信任 skuId 与 quantity，所有 SPU、价格、标题、主图、规格信息一律由数据库重建！
    const canonicalGoodsList = [];
    let goodsTotalAmount = 0;

    for (const rawItem of goodsList) {
      const skuId = rawItem.skuId;
      const quantity = parseInt(rawItem.quantity, 10);
      if (!skuId || !quantity || quantity <= 0) {
        throw new Error("商品规格或数量参数非法");
      }

      // 1.1 查询权威 SKU 数据
      const skuQuery = await transaction
        .collection("goods_sku")
        .where({ skuId })
        .get();

      if (!skuQuery.data || skuQuery.data.length === 0) {
        throw new Error(`商品规格不存在或已下架 (SKU: ${skuId})`);
      }

      const skuData = skuQuery.data[0];
      const realSkuDocId = skuData._id;
      const spuId = skuData.spuId;

      // 1.2 校验库存
      const currentStock = skuData.stock || 0;
      if (currentStock < quantity) {
        throw new Error(`商品库存不足 (仅剩${currentStock})`);
      }

      // 1.3 权威价格计算（完全以服务端 DB 价格为准，杜绝任何客户端价格欺诈）
      const dbPrice = parseFloat(skuData.price);
      if (Number.isNaN(dbPrice) || dbPrice < 0) {
        throw new Error("商品价格配置异常");
      }

      // 1.4 查询权威 SPU 数据以锁定商品标题与主图
      let spuData = null;
      if (spuId) {
        try {
          const spuRes = await transaction.collection("goods_spu").doc(spuId).get();
          spuData = spuRes.data || null;
        } catch (spuErr) {
          console.warn(`[createOrder] Fetch spu ${spuId} warning:`, spuErr.message);
        }
      }

      const canonicalItem = {
        skuId: skuData.skuId || skuId,
        spuId: spuId || "",
        title: spuData ? (spuData.title || spuData.name || "商品") : (rawItem.title || "商品"),
        primaryImage: spuData ? (spuData.primaryImage || (Array.isArray(spuData.images) && spuData.images[0]) || "") : (rawItem.primaryImage || ""),
        price: formatAmount(dbPrice),
        quantity,
        specInfo: skuData.specInfo || skuData.spec || [],
      };

      canonicalGoodsList.push(canonicalItem);
      goodsTotalAmount = roundCurrency(goodsTotalAmount + dbPrice * quantity);

      // 1.5 扣减 SKU 库存
      await transaction
        .collection("goods_sku")
        .doc(realSkuDocId)
        .update({
          data: {
            stock: _.inc(-quantity),
          },
        });

      // 1.6 同步扣减 SPU 库存
      if (spuId) {
        try {
          await transaction
            .collection("goods_spu")
            .doc(spuId)
            .update({
              data: {
                spuStockQuantity: _.inc(-quantity),
              },
            });
        } catch (spuStockErr) {
          console.warn("[createOrder] deduct spuStock non-blocking:", spuStockErr.message);
        }
      }
    }

    // [P0 防套利防线] 基于服务端重建的 canonicalGoodsList 判定免单活动商品单件下单规则
    const now = Date.now();
    const activeChallengeRes = await transaction
      .collection("activities")
      .where({
        type: "THREE_SECOND_CHALLENGE",
        status: "ACTIVE",
        startTime: _.lte(now),
        endTime: _.gte(now),
      })
      .limit(1)
      .get();

    if (activeChallengeRes.data && activeChallengeRes.data.length > 0) {
      const challengeActivity = activeChallengeRes.data[0];
      const applicableSpuIds = challengeActivity.applicableSpuIds || [];

      if (applicableSpuIds.length > 0) {
        const containsChallengeItem = canonicalGoodsList.some((g) =>
          applicableSpuIds.includes(g.spuId)
        );

        if (containsChallengeItem) {
          const totalCount = canonicalGoodsList.reduce(
            (sum, item) => sum + item.quantity,
            0
          );
          if (canonicalGoodsList.length > 1 || totalCount > 1) {
            console.warn("[createOrder] Arbitrage blocked: mixed cart or quantity > 1");
            throw new Error("CHALLENGE_MIXED_CART_FORBIDDEN: 3秒挑战免单活动商品不可与其他商品混购，且单笔限购1件");
          }
        }
      }
    }

    const normalizedDeliveryType = Number(orderData.deliveryType) === 2 ? 2 : 1;
    const totalGoodsCount = canonicalGoodsList.reduce(
      (sum, item) => sum + item.quantity,
      0
    );
    const computedOrderSummary = {
      ...buildOrderSummary({
        goodsTotalAmount,
        deliveryType: normalizedDeliveryType,
      }),
      totalGoodsCount,
    };

    const ts = Date.now();
    // 严格安全白名单过滤非商品业务字段，严禁客户端透传内部状态字段
    const finalOrderData = {
      goodsList: canonicalGoodsList, // 服务端重建的完全可信商品列表
      address: orderData.address || null,
      deliveryType: normalizedDeliveryType,
      invoice: orderData.invoice || null,
      userRemark: orderData.userRemark || "",
      orderSummary: computedOrderSummary,
      _openid: openId,
      status: "PENDING_PAYMENT",
      challengeEligible: false,
      challengeStatus: "NONE",
      challengeRefundStatus: "NONE",
      erpStatus: "HOLD",
      fulfillmentHold: "NONE",
      createdAt: ts,
      updatedAt: ts,
      deleted: false, // 集合方式添加数据不会添加默认值
    };
    if (distributorOpenid) {
      finalOrderData.distributorOpenid = distributorOpenid;
      finalOrderData.distributorNickName = distributorNickName;
    }

    // 2. 创建订单
    console.log("[createOrder] creating order:", finalOrderData);
    const orderRes = await transaction.collection("order").add({
      data: finalOrderData,
    });
    console.log("[createOrder] order created:", orderRes);

    // 2.1 生成订单号 (时间戳 + _id后6位)
    const createdId = orderRes?._id;
    const orderNo = `${Date.now()}${createdId ? createdId.slice(-6) : ""}`;
    if (createdId) {
      await transaction
        .collection("order")
        .doc(createdId)
        .update({
          data: { orderNo, updatedAt: Date.now() },
        });
    }

    // 3. (可选) 清理购物车
    const cartIds = goodsList
      .filter((g) => g.cartId) // 前端传递的 item.cartId (原 _id)
      .map((g) => g.cartId);

    if (cartIds.length > 0) {
      console.log("[createOrder] removing cart items:", cartIds);
      await transaction
        .collection("cart")
        .where({
          _id: _.in(cartIds),
          _openid: openId, // 双重保障，只能删自己的
        })
        .remove();
    }

    // 4. 提交事务
    console.log("[createOrder] committing transaction");
    await transaction.commit();

    return {
      success: true,
      orderId: orderRes._id,
      orderNo: orderNo,
    };
  } catch (err) {
    console.error("[createOrder] transaction error:", err);
    await transaction.rollback();
    return {
      success: false,
      message: err.message || "创建订单失败",
    };
  }
};
