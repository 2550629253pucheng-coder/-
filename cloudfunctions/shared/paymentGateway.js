/**
 * CloudBase 官方微信支付集成网关 (Payment Gateway)
 * 
 * 核心原则：
 * 1. 业务层统一调用 createPayment, queryPayment, createRefund, queryRefund，禁止直接使用 wx.cloud / cloud.cloudPay。
 * 2. 禁止假定写死集成函数名称（如 cloudbase_module 或 pay-common）。
 *    真实 CloudBase Integration 实际 HTTP/云函数名称由控制台创建时生成，并通过环境变量 PAYMENT_INTEGRATION_FUNCTION_NAME 配置。
 * 3. 严格区分 TEST 与 LIVE 模式：
 *    - LIVE 生产模式：若未配置 PAYMENT_INTEGRATION_FUNCTION_NAME，严密 Fail-Closed，拒绝产生不安全支付/退款，抛出明确错误。
 *    - TEST 模式：允许返回确定性 Mock / 模拟数据供真机测试模式免单挑战流程验证，标记 REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION。
 */

function isLiveMode() {
  return process.env.NODE_ENV === "production" || process.env.ACTIVITY_MODE === "LIVE";
}

function getIntegrationFunctionName() {
  return process.env.PAYMENT_INTEGRATION_FUNCTION_NAME || null;
}

/**
 * 统一下单 (创建预支付订单)
 * @param {Object} cloud - wx-server-sdk 实例
 * @param {Object} params - 下单参数 { orderId, totalFee, description, openId, workflowName }
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

  const fnName = getIntegrationFunctionName();

  // LIVE 模式：必须有真实 CloudBase Integration 配置，严禁隐式降级模拟
  if (isLiveMode()) {
    if (!fnName) {
      const err = new Error(
        "PAYMENT_INTEGRATION_FUNCTION_NAME_NOT_CONFIGURED: [REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION] 生产环境未配置 CloudBase 微信支付集成函数"
      );
      err.code = "PAYMENT_INTEGRATION_FUNCTION_NAME_NOT_CONFIGURED";
      throw err;
    }

    const res = await cloud.callFunction({
      name: fnName,
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
    throw new Error("INVALID_PAYMENT_INTEGRATION_RESPONSE");
  }

  // TEST 模式：若配置了集成函数则调用真实集成，否则安全返回测试模拟凭据
  if (fnName && cloud && typeof cloud.callFunction === "function") {
    try {
      const res = await cloud.callFunction({
        name: fnName,
        data: {
          name: workflowName,
          action: "wxpay_order",
          data: {
            description: description || "商品订单支付",
            amount: { total: totalFee, currency: "CNY" },
            out_trade_no: orderId,
            payer: { openid: openId },
          },
        },
      });
      if (res && res.result) {
        return res.result;
      }
    } catch (err) {
      console.warn("[paymentGateway.createPayment] Integration call warning:", err.message);
    }
  }

  console.log(`[paymentGateway.createPayment] TEST_MODE: simulated prepay order for ${orderId}`);
  return {
    code: 0,
    sub_code: "REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION",
    message: "TEST_MODE: 未配置或无法连接真实集成云函数，使用沙箱模拟预支付参数",
    paymentData: {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: "test_nonce_mock",
      package: `prepay_id=mock_wx_prepay_${orderId}`,
      signType: "RSA",
      paySign: "mock_signature_for_test",
    },
  };
}

/**
 * 查询支付订单状态 (对账与异常补偿)
 */
async function queryPayment(cloud, { outTradeNo }) {
  if (!outTradeNo) {
    throw new Error("queryPayment: outTradeNo 必填");
  }

  const fnName = getIntegrationFunctionName();

  if (isLiveMode()) {
    if (!fnName) {
      throw new Error(
        "PAYMENT_INTEGRATION_FUNCTION_NAME_NOT_CONFIGURED: [REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION]"
      );
    }
    const res = await cloud.callFunction({
      name: fnName,
      data: {
        action: "wxpay_query_order_by_out_trade_no",
        data: {
          out_trade_no: outTradeNo,
        },
      },
    });
    if (res && res.result) return res.result;
    throw new Error("QUERY_PAYMENT_FAILED");
  }

  if (fnName && cloud && typeof cloud.callFunction === "function") {
    try {
      const res = await cloud.callFunction({
        name: fnName,
        data: {
          action: "wxpay_query_order_by_out_trade_no",
          data: { out_trade_no: outTradeNo },
        },
      });
      if (res && res.result) return res.result;
    } catch (err) {
      console.warn("[paymentGateway.queryPayment] Integration call warning:", err.message);
    }
  }

  return {
    status: "UNKNOWN",
    sub_code: "REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION",
    message: "TEST_MODE: 模拟支付查询结果",
  };
}

/**
 * 发起微信退款 (Challenge 免单全额返款 & 售后退款)
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

  const fnName = getIntegrationFunctionName();

  if (isLiveMode()) {
    if (!fnName) {
      throw new Error(
        "PAYMENT_INTEGRATION_FUNCTION_NAME_NOT_CONFIGURED: [REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION] 生产环境未配置微信支付退款集成"
      );
    }

    const res = await cloud.callFunction({
      name: fnName,
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
    throw new Error("CREATE_REFUND_FAILED");
  }

  if (fnName && cloud && typeof cloud.callFunction === "function") {
    try {
      const res = await cloud.callFunction({
        name: fnName,
        data: {
          action: "wxpay_refund",
          data: {
            out_trade_no: outTradeNo,
            out_refund_no: outRefundNo,
            reason: refundDesc,
            amount: { refund: refundFee, total: totalFee, currency: "CNY" },
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
      console.warn("[paymentGateway.createRefund] Integration call warning:", err.message);
    }
  }

  console.log(`[paymentGateway.createRefund] TEST_MODE: simulated refund for ${outRefundNo}`);
  return {
    success: true,
    refundId: `test_wx_rf_${Date.now()}`,
    status: "PROCESSING",
    simulated: true,
    sub_code: "REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION",
  };
}

/**
 * 主动查询微信退款状态
 */
async function queryRefund(cloud, { outRefundNo }) {
  if (!outRefundNo) {
    throw new Error("queryRefund: outRefundNo 必填");
  }

  const fnName = getIntegrationFunctionName();

  if (isLiveMode()) {
    if (!fnName) {
      throw new Error(
        "PAYMENT_INTEGRATION_FUNCTION_NAME_NOT_CONFIGURED: [REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION]"
      );
    }

    const res = await cloud.callFunction({
      name: fnName,
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
        refundId: res.result.refund_id || res.result.refundId,
        raw: res.result,
      };
    }
    throw new Error("QUERY_REFUND_FAILED");
  }

  if (fnName && cloud && typeof cloud.callFunction === "function") {
    try {
      const res = await cloud.callFunction({
        name: fnName,
        data: {
          action: "wxpay_refund_query",
          data: { out_refund_no: outRefundNo },
        },
      });
      if (res && res.result) {
        return {
          status: res.result.status,
          refundId: res.result.refund_id || res.result.refundId,
          raw: res.result,
        };
      }
    } catch (err) {
      console.warn("[paymentGateway.queryRefund] Integration call warning:", err.message);
    }
  }

  return {
    status: "UNKNOWN",
    sub_code: "REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION",
    message: "TEST_MODE: 模拟退款查询结果",
  };
}

module.exports = {
  createPayment,
  queryPayment,
  createRefund,
  queryRefund,
  isLiveMode,
  getIntegrationFunctionName,
};
