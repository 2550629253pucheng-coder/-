const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");

// Mock wx-server-sdk before requiring cloud functions
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "wx-server-sdk") {
    return {
      init: () => {},
      DYNAMIC_CURRENT_ENV: "test-env",
      getWXContext: () => ({ OPENID: "default_mock_openid" }),
      database: () => ({
        command: {
          inc: (n) => n,
          in: (arr) => arr,
          lte: (val) => val,
          gte: (val) => val,
        },
      }),
    };
  }
  return originalRequire.apply(this, arguments);
};

process.env.CHALLENGE_HMAC_SECRET = "production_grade_hmac_secret_for_test_mode_1234567890";

const Collections = require("../cloudfunctions/shared/collections");
const paymentGateway = require("../cloudfunctions/shared/paymentGateway");
const unifiedOrderModule = require("../cloudfunctions/unifiedOrder/index");
const createOrderModule = require("../cloudfunctions/createOrder/index");
const paymentCallbackModule = require("../cloudfunctions/paymentCallback/index");
const manageChallengeModule = require("../cloudfunctions/manageChallenge/index");

console.log("===============================================================");
console.log("🚀 开始执行 Phase 5 最终收口 P0 验证自动化测试");
console.log("===============================================================");

// Mock DB helper
function createMockDb() {
  const store = {
    order: new Map(),
    goods_sku: new Map(),
    goods_spu: new Map(),
    activities: new Map(),
    challenge_rules: new Map(),
    challenge_session: new Map(),
    risk_logs: new Map(),
    refunds: new Map(),
    refund_tasks: new Map(),
    cart: new Map(),
  };

  function getCollection(name) {
    if (!store[name]) {
      store[name] = new Map();
    }
    const map = store[name];

    return {
      doc: (id) => ({
        get: async () => {
          if (!map.has(id)) {
            const err = new Error("Document not found");
            err.code = "DOCUMENT_NOT_FOUND";
            throw err;
          }
          return { data: map.get(id) };
        },
        set: async ({ data }) => {
          map.set(id, { _id: id, ...data });
          return { _id: id };
        },
        update: async ({ data }) => {
          if (!map.has(id)) throw new Error("Document not found");
          const existing = map.get(id);
          const updated = { ...existing, ...data };
          map.set(id, updated);
          return { stats: { updated: 1 } };
        },
      }),
      where: (query) => ({
        get: async () => {
          const results = [];
          for (const item of map.values()) {
            let match = true;
            for (const [k, v] of Object.entries(query)) {
              if (v && typeof v === "object") {
                // skip command objects like _.lte, _.gte
                continue;
              }
              if (item[k] !== v) {
                match = false;
                break;
              }
            }
            if (match) results.push(item);
          }
          return { data: results };
        },
        limit: (n) => ({
          get: async () => {
            const results = [];
            for (const item of map.values()) {
              let match = true;
              for (const [k, v] of Object.entries(query)) {
                if (v && typeof v === "object") {
                  continue;
                }
                if (item[k] !== v) {
                  match = false;
                  break;
                }
              }
              if (match) results.push(item);
              if (results.length >= n) break;
            }
            return { data: results };
          },
        }),
      }),
      add: async ({ data }) => {
        const id = data._id || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        map.set(id, { _id: id, ...data });
        return { _id: id };
      },
    };
  }

  const db = {
    collection: (name) => getCollection(name),
    command: {
      inc: (n) => ({ _cmd: "inc", n }),
      in: (arr) => ({ _cmd: "in", arr }),
      lte: (val) => ({ _cmd: "lte", val }),
      gte: (val) => ({ _cmd: "gte", val }),
    },
    startTransaction: async () => ({
      collection: (name) => getCollection(name),
      commit: async () => true,
      rollback: async () => true,
    }),
    _store: store,
  };

  return db;
}

// -------------------------------------------------------------
// Test 1: unifiedOrder 身份鉴权与防篡改
// -------------------------------------------------------------
async function testUnifiedOrderSecurity() {
  console.log("\n[Test 1] unifiedOrder 支付身份防冒用与越权校验");
  const db = createMockDb();
  const callerOpenId = "USER_AUTHENTICATED_123";
  const spoofedOpenId = "HACKER_SPOOFED_999";
  const orderId = "ORD_001";

  // 1. 注入待支付订单，属于 callerOpenId
  db._store.order.set(orderId, {
    _id: orderId,
    _openid: callerOpenId,
    status: "PENDING_PAYMENT",
    orderSummary: { totalPayAmount: "19.90" },
    goodsList: [{ title: "测试商品", quantity: 1 }],
  });

  let capturedPaymentParams = null;
  const mockGateway = {
    createPayment: async (cloud, params) => {
      capturedPaymentParams = params;
      return { success: true, prepayId: "prepay_mock" };
    },
  };

  const mockCloud = {
    getWXContext: () => ({ OPENID: callerOpenId }),
    database: () => db,
  };

  const handler = unifiedOrderModule.createHandler({
    cloud: mockCloud,
    db,
    paymentGateway: mockGateway,
  });

  // 用户尝试传入恶意伪造的 payerOpenId
  const res = await handler({
    orderId,
    payerOpenId: spoofedOpenId,
    totalFee: 1990,
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(
    capturedPaymentParams.openId,
    callerOpenId,
    "Payment gateway openId 必须严格取自鉴权上下文 wxContext.OPENID，杜绝外部传入的 payerOpenId！"
  );
  console.log("✓ unifiedOrder 严格强制使用 wxContext.OPENID 发起支付，忽略客户端 payerOpenId");

  // 用户尝试支付别人的订单
  const attackerCloud = {
    getWXContext: () => ({ OPENID: spoofedOpenId }),
    database: () => db,
  };
  const attackerHandler = unifiedOrderModule.createHandler({
    cloud: attackerCloud,
    db,
    paymentGateway: mockGateway,
  });
  const crossUserRes = await attackerHandler({
    orderId,
    totalFee: 1990,
  });
  assert.strictEqual(crossUserRes.code, -1);
  assert.strictEqual(crossUserRes.message, "订单不存在或无法支付");
  console.log("✓ 跨用户越权支付被严格拦截 (订单属主匹配)");
}

// -------------------------------------------------------------
// Test 2: paymentGateway 真实 CloudBase 集成模式
// -------------------------------------------------------------
async function testPaymentGatewayConfig() {
  console.log("\n[Test 2] paymentGateway 环境变量配置驱动与 LIVE Fail-Closed 校验");

  // LIVE 模式下未配置 PAYMENT_INTEGRATION_FUNCTION_NAME 必须抛错 Fail-Closed
  const origEnv = process.env.NODE_ENV;
  const origMode = process.env.ACTIVITY_MODE;
  const origFn = process.env.PAYMENT_INTEGRATION_FUNCTION_NAME;

  try {
    process.env.NODE_ENV = "production";
    process.env.ACTIVITY_MODE = "LIVE";
    delete process.env.PAYMENT_INTEGRATION_FUNCTION_NAME;

    const mockCloud = {
      callFunction: async () => {},
    };

    let liveError = null;
    try {
      await paymentGateway.createPayment(mockCloud, {
        orderId: "ORD_LIVE",
        totalFee: 100,
        openId: "USER_LIVE",
      });
    } catch (err) {
      liveError = err;
    }

    assert(liveError !== null, "LIVE 模式下缺少配置必须报错");
    assert.strictEqual(liveError.code, "PAYMENT_INTEGRATION_FUNCTION_NAME_NOT_CONFIGURED");
    console.log("✓ LIVE 模式下缺少 PAYMENT_INTEGRATION_FUNCTION_NAME 时严格 Fail-Closed 抛错");

    // 配置环境变量后，必须通过 cloud.callFunction 调用该云函数
    process.env.PAYMENT_INTEGRATION_FUNCTION_NAME = "my_custom_pay_integration";
    let calledFnName = null;
    let calledAction = null;
    mockCloud.callFunction = async ({ name, data }) => {
      calledFnName = name;
      calledAction = data.action;
      return { result: { success: true, prepayId: "live_prepay_id" } };
    };

    const liveRes = await paymentGateway.createPayment(mockCloud, {
      orderId: "ORD_LIVE",
      totalFee: 100,
      openId: "USER_LIVE",
    });

    assert.strictEqual(calledFnName, "my_custom_pay_integration");
    assert.strictEqual(calledAction, "wxpay_order");
    assert.strictEqual(liveRes.success, true);
    console.log("✓ 配置环境变量后，真实路由至 CloudBase Integration 云函数");

  } finally {
    process.env.NODE_ENV = origEnv;
    process.env.ACTIVITY_MODE = origMode;
    if (origFn) process.env.PAYMENT_INTEGRATION_FUNCTION_NAME = origFn;
    else delete process.env.PAYMENT_INTEGRATION_FUNCTION_NAME;
  }
}

// -------------------------------------------------------------
// Test 3: createOrder Canonical SPU 强约束
// -------------------------------------------------------------
async function testCreateOrderCanonicalGoods() {
  console.log("\n[Test 3] createOrder Canonical Goods 强校验：SPU 缺失时直接拒绝下单");
  const db = createMockDb();
  const openId = "USER_GOODS_TEST";

  // 写入存在 SKU，但关联的 SPU 在数据库中不存在
  db._store.goods_sku.set("SKU_ORPHAN", {
    _id: "SKU_ORPHAN",
    skuId: "SKU_ORPHAN",
    spuId: "SPU_NON_EXISTENT",
    price: "29.90",
    stock: 100,
  });

  const mockCloud = {
    getWXContext: () => ({ OPENID: openId }),
    database: () => db,
  };

  const handler = createOrderModule.createHandler({
    cloud: mockCloud,
    db,
  });

  const res = await handler({
    orderData: {
      goodsList: [
        {
          skuId: "SKU_ORPHAN",
          quantity: 1,
          title: "客户端伪造标题",
          primaryImage: "http://hacker.com/image.jpg",
        },
      ],
      deliveryType: 1,
    },
  });

  assert.strictEqual(res.success, false);
  assert(res.message.includes("PRODUCT_DATA_INCONSISTENT"), "SPU 不存在时必须抛出 PRODUCT_DATA_INCONSISTENT 拒绝下单");
  console.log("✓ SPU 不存在时严格 Fail-Closed，绝不 fallback 使用客户端传入的标题与主图");
}

// -------------------------------------------------------------
// Test 4: paymentCallback 规则快照 LIVE Fail-Closed
// -------------------------------------------------------------
async function testPaymentCallbackLiveRuleSnapshot() {
  console.log("\n[Test 4] paymentCallback 规则快照在 LIVE 模式下 Fail-Closed 校验");
  const db = createMockDb();
  const orderId = "ORD_PAY_CB_1";

  // 准备订单
  db._store.order.set(orderId, {
    _id: orderId,
    status: "PENDING_PAYMENT",
    orderSummary: { totalPayAmount: "29.90" },
    goodsList: [{ skuId: "SKU_1", spuId: "SPU_1", quantity: 1 }],
  });

  // 准备活动：配置了活动，但在 challenge_rules 中找不到对应的 ACTIVE 规则
  const now = Date.now();
  db._store.activities.set("ACT_TEST", {
    _id: "ACT_TEST",
    type: "THREE_SECOND_CHALLENGE",
    status: "ACTIVE",
    startTime: now - 10000,
    endTime: now + 10000,
    ruleVersion: "RULE_NON_EXISTENT",
  });

  const origEnv = process.env.NODE_ENV;
  const origMode = process.env.ACTIVITY_MODE;

  try {
    // 1. LIVE 模式下
    process.env.NODE_ENV = "production";
    process.env.ACTIVITY_MODE = "LIVE";
    const apiV3Key = "12345678901234567890123456789012"; // 32 bytes
    process.env.WX_PAY_APIV3_KEY = apiV3Key;

    const mockCloud = {
      getWXContext: () => ({}),
      database: () => db,
    };

    const handler = paymentCallbackModule.createHandler({
      cloud: mockCloud,
      db,
    });

    // 微信支付 V3 真实加密回调结构
    const plainPayload = {
      out_trade_no: orderId,
      transaction_id: "TX_12345",
      success_time: "2026-09-16T12:00:00+08:00",
      amount: {
        total: 2990,
        payer_total: 2990,
      },
    };
    const nonce = crypto.randomBytes(12).toString("hex").slice(0, 12);
    const associatedData = "transaction";
    const cipher = crypto.createCipheriv(
      "aes-256-gcm",
      Buffer.from(apiV3Key, "utf-8"),
      Buffer.from(nonce, "utf-8")
    );
    cipher.setAAD(Buffer.from(associatedData, "utf-8"));
    const enc = Buffer.concat([
      cipher.update(JSON.stringify(plainPayload), "utf-8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([enc, authTag]).toString("base64");

    const cbRes = await handler({
      event_type: "TRANSACTION.SUCCESS",
      resource: {
        ciphertext,
        nonce,
        associated_data: associatedData,
      },
    });

    const updatedOrder = db._store.order.get(orderId);
    assert.strictEqual(updatedOrder.status, "PENDING_DELIVERY");
    assert.strictEqual(updatedOrder.challengeEligible, false, "LIVE模式缺少规则时 challengeEligible 必须为 false");
    assert.strictEqual(updatedOrder.fulfillmentHold, "NONE", "未获挑战资格时履约暂扣必须为 NONE");
    assert.strictEqual(updatedOrder.erpStatus, "READY", "未获挑战资格时 ERP 状态必须为 READY");

    // 检查 risk_logs
    assert.strictEqual(db._store.risk_logs.size, 1, "必须写入 risk_logs 审计事件");
    const log = Array.from(db._store.risk_logs.values())[0];
    assert.strictEqual(log.type, "CHALLENGE_RULE_NOT_FOUND");
    console.log("✓ LIVE 模式下 challenge_rules 缺失时严格 Fail-Closed：取消免单资格，记录 risk_logs，正常放行发货");

  } finally {
    process.env.NODE_ENV = origEnv;
    process.env.ACTIVITY_MODE = origMode;
  }
}

// -------------------------------------------------------------
// Test 5: 集合命名统一校验
// -------------------------------------------------------------
function testCollectionUnification() {
  console.log("\n[Test 5] 集合命名统一：Collections.CHALLENGE_SESSION 为单数形式");
  assert.strictEqual(Collections.CHALLENGE_SESSION, "challenge_session");
  assert.strictEqual(Collections.ORDER, "order");
  assert.strictEqual(Collections.GOODS_SKU, "goods_sku");
  assert.strictEqual(Collections.GOODS_SPU, "goods_spu");
  assert.strictEqual(Collections.REFUNDS, "refunds");
  assert.strictEqual(Collections.REFUND_TASKS, "refund_tasks");
  assert.strictEqual(Collections.RISK_LOGS, "risk_logs");
  console.log("✓ 所有集合命名常量声明正确且完全统一");
}

async function runAllTests() {
  try {
    await testUnifiedOrderSecurity();
    await testPaymentGatewayConfig();
    await testCreateOrderCanonicalGoods();
    await testPaymentCallbackLiveRuleSnapshot();
    testCollectionUnification();

    console.log("\n===============================================================");
    console.log("🎉 ALL FINAL P0 VERIFICATION TESTS PASSED 100%!");
    console.log("READY_FOR_DEVICE_TEST_MODE = YES");
    console.log("===============================================================");
  } catch (err) {
    console.error("❌ TEST RUN FAILED:", err);
    process.exit(1);
  }
}

runAllTests();
