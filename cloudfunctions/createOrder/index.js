const cloud = require("wx-server-sdk");
const Collections = require("../shared/collections");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

let privateConfig = {};
try {
  privateConfig = require("./config.private.js");
} catch (error) {
  privateConfig = {};
}

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
    goodsTotalAmount: formatAmount(goodsTotalAmount),
    deliveryFee: formatAmount(deliveryFee),
    promotionAmount: formatAmount(promotionAmount),
    totalPayAmount: formatAmount(totalPayAmount),
    actualPayAmount: formatAmount(totalPayAmount),
  };
}

/**
 * 构造 createOrder 核心处理器 (支持依赖注入与真实测试 Harness)
 */
function createHandler(deps = {}) {
  const cloudInstance = deps.cloud || cloud;
  const dbInstance = deps.db || cloudInstance.database();
  const _ = dbInstance.command;

  return async function handleCreateOrder(event, context) {
    console.log("[createOrder] event:", event);

    const { orderData } = event || {};
    const goodsList = orderData && orderData.goodsList;

    if (!orderData || !Array.isArray(goodsList) || goodsList.length === 0) {
      return {
        success: false,
        message: "参数不完整",
      };
    }

    const wxContext = cloudInstance.getWXContext();
    const openId = wxContext.OPENID;
    console.log("[createOrder] openId:", openId);

    // 0. 读取分销来源（记录最后一次推荐关系）
    let distributorOpenid = "";
    let distributorNickName = "";
    try {
      const userRes = await dbInstance
        .collection("user_info")
        .where({ _openid: openId })
        .limit(1)
        .get();
      const user = userRes.data && userRes.data.length ? userRes.data[0] : null;
      const referrerOpenid = user && user.referrerOpenid;
      if (referrerOpenid && referrerOpenid !== openId) {
        const distributorRes = await dbInstance
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

    const transaction = await dbInstance.startTransaction();

    try {
      console.log(
        "[createOrder] start transaction, input goods count:",
        goodsList.length
      );

      // [P0 安全架构] 核心商品数据服务端 Canonical 化：
      // 客户端只可信 skuId 与 quantity，所有 SPU、价格、标题、主图、规格信息一律从数据库重建！
      // 严禁从客户端读取标题或图片作为 fallback；SPU 查不到直接抛出 PRODUCT_DATA_INCONSISTENT 拒绝下单！
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
          .collection(Collections.GOODS_SKU)
          .where({ skuId })
          .get();

        if (!skuQuery.data || skuQuery.data.length === 0) {
          throw new Error(`商品规格不存在或已下架 (SKU: ${skuId})`);
        }

        const skuData = skuQuery.data[0];
        const realSkuDocId = skuData._id;
        const spuId = skuData.spuId;

        if (!spuId) {
          throw new Error(`PRODUCT_DATA_INCONSISTENT: SKU未关联有效SPU (SKU: ${skuId})`);
        }

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

        // 1.4 查询权威 SPU 数据以锁定商品标题与主图（禁止客户端 fallback，SPU 缺失直接失败）
        let spuRes = null;
        try {
          spuRes = await transaction
            .collection(Collections.GOODS_SPU)
            .doc(spuId)
            .get();
        } catch (spuErr) {
          console.warn(`[createOrder] Fetch spu ${spuId} error:`, spuErr.message);
        }
        const spuData = spuRes && spuRes.data;

        if (!spuData) {
          throw new Error(`PRODUCT_DATA_INCONSISTENT: SPU商品不存在或已失效 (SPU: ${spuId})`);
        }

        const canonicalTitle = spuData.title || spuData.name;
        if (!canonicalTitle) {
          throw new Error(`PRODUCT_DATA_INCONSISTENT: SPU标题缺失 (SPU: ${spuId})`);
        }

        const canonicalImage =
          spuData.primaryImage ||
          (Array.isArray(spuData.images) && spuData.images[0]) ||
          "";

        const canonicalItem = {
          skuId: skuData.skuId || skuId,
          spuId: spuId,
          title: canonicalTitle,
          primaryImage: canonicalImage,
          price: formatAmount(dbPrice),
          quantity,
          specInfo: skuData.specInfo || skuData.spec || [],
        };

        canonicalGoodsList.push(canonicalItem);
        goodsTotalAmount = roundCurrency(goodsTotalAmount + dbPrice * quantity);

        // 1.5 扣减 SKU 库存
        await transaction
          .collection(Collections.GOODS_SKU)
          .doc(realSkuDocId)
          .update({
            data: {
              stock: _.inc(-quantity),
            },
          });

        // 1.6 同步扣减 SPU 库存
        try {
          await transaction
            .collection(Collections.GOODS_SPU)
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

      // [P0 防套利防线] 基于服务端重建的 canonicalGoodsList 判定免单活动商品单件下单规则
      const now = Date.now();
      const activeChallengeRes = await transaction
        .collection(Collections.ACTIVITIES)
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
        goodsList: canonicalGoodsList, // 服务端重建的完全权威商品列表
        address: orderData.address || null,
        deliveryType: normalizedDeliveryType,
        invoice: orderData.invoice || null,
        userRemark: orderData.userRemark || "",
        orderSummary: computedOrderSummary,
        _openid: openId,
        status: "PENDING_PAYMENT",
        paymentStatus: "UNPAID",
        distributorOpenid: distributorOpenid,
        distributorNickName: distributorNickName,
        // 挑战初始状态：待支付完成校验后激活
        challengeEligible: false,
        challengeStatus: "NONE",
        challengeRefundStatus: "NONE",
        fulfillmentHold: "NONE",
        erpStatus: "PENDING_PAYMENT",
        createTime: ts,
        createdAt: ts,
        updateTime: ts,
        updatedAt: ts,
      };

      console.log("[createOrder] creating order doc with canonical data");
      const orderRes = await transaction.collection(Collections.ORDER).add({
        data: finalOrderData,
      });

      // 2. 生成可读订单号
      const orderNo =
        ts.toString() +
        Math.floor(Math.random() * 1000)
          .toString()
          .padStart(3, "0");

      if (orderRes._id) {
        await transaction
          .collection(Collections.ORDER)
          .doc(orderRes._id)
          .update({
            data: { orderNo, updatedAt: Date.now() },
          });
      }

      // 3. (可选) 清理购物车
      const cartIds = goodsList
        .filter((g) => g.cartId)
        .map((g) => g.cartId);

      if (cartIds.length > 0) {
        console.log("[createOrder] removing cart items:", cartIds);
        await transaction
          .collection(Collections.CART)
          .where({
            _id: _.in(cartIds),
            _openid: openId,
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
}

exports.createHandler = createHandler;
exports.main = createHandler();
