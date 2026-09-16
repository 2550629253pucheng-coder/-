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

const paymentGateway = require("../shared/paymentGateway.js");

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

exports.main = async (event, context) => {
  console.log("[unifiedOrder] event:", event);
  const { orderId, payerOpenId, totalFee: clientTotalFee } = event || {};

  // 1. 简单校验
  if (!orderId) {
    console.warn("[unifiedOrder] missing params:", { orderId });
    return {
      code: -1,
      message: "缺少订单ID参数",
    };
  }

  const wxContext = cloud.getWXContext();
  const openId = wxContext.OPENID;

  // [New] 2. 安全校验：确保订单存在且属于当前用户
  const db = cloud.database();
  const orderRes = await db
    .collection("order")
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

  console.log("[unifiedOrder] calling payment gateway:", wxContext.OPENID);

  try {
    const payResult = await paymentGateway.createPayment(cloud, {
      orderId,
      totalFee,
      description: getPaymentDescription(order),
      openId: payerOpenId || openId,
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
