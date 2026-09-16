/**
 * CloudBase 官方微信支付集成网关 (Payment Gateway)
 * 封装 CloudBase Integration Center 提供的微信支付组件/工作流
 * 业务层禁止直接调用旧版 cloud.cloudPay 或硬编码商户凭证
 * 所有密钥 (APIv3Key, 商户私钥, 证书) 必须由 CloudBase 控制台 Integration Center 托管
 */

const CLOUDBASE_PAY_MODULE = "cloudbase_module";
const PAY_COMMON_FUNCTION = "pay-common";

/**
 * 创建预支付订单 (统一下单)
 * @param {Object} cloud - wx-server-sdk 实例
 * @param {Object} params - 下单参数
 */
async function createPayment(cloud, {
  orderId,
  totalFee,
  description,
  openId,
  workflowName = "wxpay_order",
}) {
  if (!orderId || !totalFee || !openId) {
    throw new Error("createPayment: orderId, totalFee, openId 均为必填字段");
  }

  // 1. 尝试调用 CloudBase Integration Center 托管支付服务
  try {
    const res = await cloud.callFunction({
      name: CLOUDBASE_PAY_MODULE,
      data: {
        name: workflowName,
        action: "wxpay_order",
        data: {
          description: description || "商品订单支付",
          amount: {
            total: totalFee,
            currency: "CNY",
          },
          out_trade_no: orderId,
          payer: {
            openid: openId,
          },
        },
      },
    });

    if (res && res.result) {
      return res.result;
    }
  } catch (err) {
    console.warn("[paymentGateway.createPayment] cloudbase_module call failed:", err.message);

    // 2. 尝试调用 pay-common 官方集成
    try {
      const commonRes = await cloud.callFunction({
        name: PAY_COMMON_FUNCTION,
        data: {
          action: "wxpay_order",
          out_trade_no: orderId,
          total_fee: totalFee,
          body: description || "商品订单支付",
          openid: openId,
        },
      });
      if (commonRes && commonRes.result) {
        return commonRes.result;
      }
    } catch (commonErr) {
      console.warn("[paymentGateway.createPayment] pay-common fallback failed:", commonErr.message);
    }

    // 3. 外部配置提示：如果在沙箱/测试模式且未配置控制台 Integration，提示清晰状态
    if (process.env.ACTIVITY_MODE !== "LIVE") {
      console.log("[paymentGateway.createPayment] TEST_MODE simulated payment pre-order");
      return {
        code: 0,
        sub_code: "TODO_EXTERNAL_CONFIG",
        message: "TEST_MODE: 请在 CloudBase 控制台 -> 集成中心 (Integration Center) -> 微信支付 完成商户号绑定",
        paymentData: {
          timeStamp: String(Math.floor(Date.now() / 1000)),
          nonceStr: "test_nonce_mock",
          package: `prepay_id=mock_wx_prepay_${orderId}`,
          signType: "RSA",
          paySign: "mock_signature_for_test",
        },
      };
    }

    throw new Error(
      `TODO_EXTERNAL_CONFIG: 微信支付集成未配置或调用失败: ${err.message}. 请前往 CloudBase 控制台 -> 集成中心 检查微信支付 Integration。`
    );
  }
}

/**
 * 查询支付订单状态 (主动对账/兜底)
 */
async function queryPayment(cloud, { outTradeNo }) {
  if (!outTradeNo) {
    throw new Error("queryPayment: outTradeNo 必填");
  }

  try {
    const res = await cloud.callFunction({
      name: CLOUDBASE_PAY_MODULE,
      data: {
        action: "wxpay_query_order_by_out_trade_no",
        data: {
          out_trade_no: outTradeNo,
        },
      },
    });
    if (res && res.result) return res.result;
  } catch (err) {
    console.warn("[paymentGateway.queryPayment] query failed:", err.message);
  }

  // Fallback to pay-common
  try {
    const commonRes = await cloud.callFunction({
      name: PAY_COMMON_FUNCTION,
      data: {
        action: "wxpay_query_order_by_out_trade_no",
        out_trade_no: outTradeNo,
      },
    });
    if (commonRes && commonRes.result) return commonRes.result;
  } catch (commonErr) {
    console.warn("[paymentGateway.queryPayment] pay-common query failed:", commonErr.message);
  }

  return {
    status: "UNKNOWN",
    sub_code: "TODO_EXTERNAL_CONFIG",
    message: "无法连接微信支付查询接口，请检查 CloudBase 集成中心配置",
  };
}

/**
 * 发起退款 (Challenge 免单全额返款 & 售后退款)
 * @param {Object} cloud - wx-server-sdk 实例
 * @param {Object} params - 退款参数
 */
async function createRefund(cloud, {
  outTradeNo,
  outRefundNo,
  totalFee,
  refundFee,
  refundDesc = "3秒挑战免单退款",
  reason = "CHALLENGE_FREE_ORDER",
}) {
  if (!outTradeNo || !outRefundNo || !totalFee || !refundFee) {
    throw new Error("createRefund: outTradeNo, outRefundNo, totalFee, refundFee 必填");
  }

  try {
    const res = await cloud.callFunction({
      name: CLOUDBASE_PAY_MODULE,
      data: {
        action: "wxpay_refund",
        data: {
          out_trade_no: outTradeNo,
          out_refund_no: outRefundNo,
          reason: refundDesc,
          amount: {
            refund: refundFee,
            total: totalFee,
            currency: "CNY",
          },
        },
      },
    });

    if (res && res.result) {
      return {
        success: true,
        refundId: res.result.refund_id || res.result.refundId,
        status: res.result.status || "PROCESSING",
        raw: res.result,
      };
    }
  } catch (err) {
    console.warn("[paymentGateway.createRefund] cloudbase_module failed:", err.message);
  }

  // Fallback to pay-common
  try {
    const commonRes = await cloud.callFunction({
      name: PAY_COMMON_FUNCTION,
      data: {
        action: "wxpay_refund",
        out_trade_no: outTradeNo,
        out_refund_no: outRefundNo,
        total_fee: totalFee,
        refund_fee: refundFee,
        refund_desc: refundDesc,
      },
    });
    if (commonRes && commonRes.result) {
      return {
        success: true,
        refundId: commonRes.result.refund_id || commonRes.result.refundId,
        status: commonRes.result.status || "PROCESSING",
        raw: commonRes.result,
      };
    }
  } catch (commonErr) {
    console.warn("[paymentGateway.createRefund] pay-common fallback failed:", commonErr.message);
  }

  // 若在 TEST 模式下未接入真实微信商户号，优雅返回模拟状态
  if (process.env.ACTIVITY_MODE !== "LIVE") {
    console.log("[paymentGateway.createRefund] TEST_MODE simulated refund success");
    return {
      success: true,
      refundId: `test_wx_rf_${Date.now()}`,
      status: "PROCESSING",
      simulated: true,
      sub_code: "TODO_EXTERNAL_CONFIG",
    };
  }

  throw new Error(
    "TODO_EXTERNAL_CONFIG: 微信支付退款接口调用失败，请在 CloudBase 控制台 -> 集成中心 检查微信支付 Integration 配置"
  );
}

/**
 * 主动查询微信退款状态 (兜底任务)
 */
async function queryRefund(cloud, { outRefundNo }) {
  if (!outRefundNo) {
    throw new Error("queryRefund: outRefundNo 必填");
  }

  try {
    const res = await cloud.callFunction({
      name: CLOUDBASE_PAY_MODULE,
      data: {
        action: "wxpay_refund_query",
        data: {
          out_refund_no: outRefundNo,
        },
      },
    });
    if (res && res.result) {
      return {
        status: res.result.status,
        refundId: res.result.refund_id,
        raw: res.result,
      };
    }
  } catch (err) {
    console.warn("[paymentGateway.queryRefund] query failed:", err.message);
  }

  // Fallback to pay-common
  try {
    const commonRes = await cloud.callFunction({
      name: PAY_COMMON_FUNCTION,
      data: {
        action: "wxpay_refund_query",
        out_refund_no: outRefundNo,
      },
    });
    if (commonRes && commonRes.result) {
      return {
        status: commonRes.result.status,
        refundId: commonRes.result.refund_id,
        raw: commonRes.result,
      };
    }
  } catch (commonErr) {
    console.warn("[paymentGateway.queryRefund] pay-common query failed:", commonErr.message);
  }

  return {
    status: "UNKNOWN",
    sub_code: "TODO_EXTERNAL_CONFIG",
    message: "无法查询退款结果，请检查 CloudBase 集成中心配置",
  };
}

module.exports = {
  createPayment,
  queryPayment,
  createRefund,
  queryRefund,
};
