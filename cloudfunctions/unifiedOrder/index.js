const cloud = require("wx-server-sdk");
const Collections = require("../shared/collections");
const paymentGateway = require("../shared/paymentGateway.js");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

let privateConfig = {};
try {
  privateConfig = require("./config.private.js");
} catch (error) {
  privateConfig = {};
}

const workflowName =
  (privateConfig.payment && privateConfig.payment.workflowName) || "wxpay_order";

function toCents(amountYuan) {
  const amount = Number(amountYuan);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid order total amount");
  }
  return Math.round(amount * 100);
}

function getOrderTotalFee(order) {
  return toCents(
    order && order.orderSummary && order.orderSummary.totalPayAmount
  );
}

function getPaymentDescription(order) {
  const goodsList = Array.isArray(order && order.goodsList)
    ? order.goodsList
    : [];
  const firstTitle =
    goodsList[0] && goodsList[0].title
      ? String(goodsList[0].title)
      : "商品订单";
  const orderNo = order && order.orderNo ? String(order.orderNo) : "";
  return orderNo ? `${firstTitle} ${orderNo}` : firstTitle;
}

/**
 * 构造统一的 unifiedOrder 处理函数（支持依赖注入与真实测试）
 */
function createHandler(deps = {}) {
  const cloudInstance = deps.cloud || cloud;
  const dbInstance = deps.db || cloudInstance.database();
  const gateway = deps.paymentGateway || paymentGateway;

  return async function handleUnifiedOrder(event, context) {
    console.log("[unifiedOrder] event:", event);
    // [P0 支付身份安全] 严禁从 event 中解构或信任 payerOpenId，付款人身份严格以微信鉴权上下文为准！
    const { orderId, totalFee: clientTotalFee } = event || {};

    if (!orderId) {
      console.warn("[unifiedOrder] missing params:", { orderId });
      return {
        code: -1,
        message: "缺少订单ID参数",
      };
    }

    const wxContext = cloudInstance.getWXContext();
    const openId = wxContext.OPENID;

    if (!openId) {
      console.warn("[unifiedOrder] unauthenticated caller");
      return {
        code: -1,
        message: "无法获取支付身份",
      };
    }

    // 2. 安全校验：确保订单存在且严格归属于当前用户（防止越权代付或偷梁换柱）
    const orderRes = await dbInstance
      .collection(Collections.ORDER)
      .where({
        _id: orderId,
        _openid: openId,
        status: "PENDING_PAYMENT", // 只能支付待支付的订单
      })
      .get();

    if (!orderRes.data || orderRes.data.length === 0) {
      console.warn("[unifiedOrder] order not found or permission denied:", {
        orderId,
        openId,
      });
      return {
        code: -1,
        message: "订单不存在或无法支付",
      };
    }

    const order = orderRes.data[0];
    let totalFee;
    try {
      totalFee = getOrderTotalFee(order);
    } catch (error) {
      console.warn("[unifiedOrder] invalid order amount:", {
        orderId,
        orderSummary: order && order.orderSummary,
        message: error.message,
      });
      return {
        code: -1,
        message: "订单金额异常",
      };
    }

    if (
      Number.isFinite(Number(clientTotalFee)) &&
      Number(clientTotalFee) !== totalFee
    ) {
      console.warn("[unifiedOrder] ignore mismatched client totalFee:", {
        orderId,
        clientTotalFee,
        serverTotalFee: totalFee,
      });
    }

    console.log("[unifiedOrder] calling payment gateway with authenticated openId:", openId);

    try {
      // 3. 严格使用 wxContext.OPENID 发起支付，杜绝任何外部 openId 覆盖
      const payResult = await gateway.createPayment(cloudInstance, {
        orderId,
        totalFee,
        description: getPaymentDescription(order),
        openId,
        workflowName,
      });

      console.log("[unifiedOrder] payment gateway result:", payResult);
      return payResult;
    } catch (payErr) {
      console.error("[unifiedOrder] payment gateway failed:", payErr);
      return {
        code: -1,
        message: payErr.message || "发起支付失败",
      };
    }
  };
}

exports.createHandler = createHandler;
exports.main = createHandler();
