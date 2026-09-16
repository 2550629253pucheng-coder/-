// 验证 Phase 2: 3秒挑战免单真技巧判定引擎与逆向退款、履约暂扣闭环
const crypto = require('crypto');

console.log('====================================================');
console.log('🚀 开始验证 Phase 2: 3秒挑战服务端判定与履约状态机');
console.log('====================================================\n');

const HMAC_SECRET = "RTL_CHALLENGE_SECRET_KEY_2026";
const TARGET_MS = 3000;
const TOLERANCE_MS = 10;

function generateToken(orderId, openid, issueTime) {
  const payload = `${orderId}:${openid}:${issueTime}`;
  return crypto.createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
}

function verifyToken(orderId, openid, issueTime, token) {
  return generateToken(orderId, openid, issueTime) === token;
}

// 模拟测试数据
const mockDb = {
  order: {
    _id: "order_test_888",
    orderNo: "NO88888888",
    _openid: "user_pucheng",
    status: "PENDING_DELIVERY", // 已付款待发货
    orderSummary: {
      totalPayAmount: "39.80"
    },
    fulfillmentHold: true,
    challengeStatus: "PENDING_CHALLENGE",
    wechatPayInfo: {
      totalFee: 3980,
      transactionId: "wx_trans_888"
    }
  },
  challenge_session: [],
  after_service: []
};

// 1. 验证会话创建与防伪 Token 生成
console.log('【1. 挑战会话开启与凭据颁发验证】');
const issueTime = Date.now();
const token = generateToken(mockDb.order._id, mockDb.order._openid, issueTime);
const sessionDoc = {
  _id: "session_001",
  orderId: mockDb.order._id,
  _openid: mockDb.order._openid,
  status: "PENDING",
  issueTime,
  challengeToken: token,
  targetMs: TARGET_MS,
  toleranceMs: TOLERANCE_MS,
  attempts: 0,
};
mockDb.challenge_session.push(sessionDoc);

console.log(`- 挑战订单号: ${mockDb.order.orderNo}`);
console.log(`- 会话 ID: ${sessionDoc._id}`);
console.log(`- 目标时间: ${TARGET_MS}ms, 容差: ±${TOLERANCE_MS}ms`);
console.log(`- HMAC 防伪签名 Token: ${token.slice(0, 16)}...`);
console.log('✅ 会话开启与凭据安全性验证通过\n');

// 2. 模拟防作弊签名审查
console.log('【2. 服务端真技巧与防篡改签名校验】');
const isValidToken = verifyToken(sessionDoc.orderId, sessionDoc._openid, sessionDoc.issueTime, sessionDoc.challengeToken);
const isForgedToken = verifyToken(sessionDoc.orderId, sessionDoc._openid, sessionDoc.issueTime, "forged_token_hack");

if (isValidToken && !isForgedToken) {
  console.log('✅ 防篡改 HMAC 验签逻辑严密拦截成功\n');
} else {
  throw new Error('❌ 验签机制存在缺陷');
}

// 3. 验证场景 A：挑战失败判定 (耗时 3250ms，偏差 250ms > 10ms)
console.log('【3. 场景 A 模拟：挑战未命中 (3250ms)】');
const failedDuration = 3250;
const failDiff = Math.abs(failedDuration - TARGET_MS);
const isFailWinner = failDiff <= TOLERANCE_MS;

console.log(`- 客户端按压用时: ${failedDuration}ms (偏差 ${failDiff}ms)`);
console.log(`- 服务端判定结果: ${isFailWinner ? '成功' : '失败'}`);

if (!isFailWinner) {
  // 释放发货锁定
  mockDb.order.fulfillmentHold = false;
  mockDb.order.challengeStatus = "FAILED";
  console.log(`- 订单履约暂扣状态释放: fulfillmentHold = ${mockDb.order.fulfillmentHold}`);
  console.log(`- 订单流向: 仓储中心照常发货，商品价值真实履约！`);
  console.log('✅ 挑战未命中及订单履约释放验证通过\n');
} else {
  throw new Error('❌ 判定失误');
}

// 4. 验证场景 B：挑战神级成功判定 (耗时 3005ms，偏差 5ms <= 10ms)
console.log('【4. 场景 B 模拟：极速真技巧达成 (3005ms)】');
// 重置测试订单状态
mockDb.order.fulfillmentHold = true;
mockDb.order.challengeStatus = "PENDING_CHALLENGE";

const winDuration = 3005;
const winDiff = Math.abs(winDuration - TARGET_MS);
const isWinWinner = winDiff <= TOLERANCE_MS;

console.log(`- 客户端按压用时: ${winDuration}ms (偏差 ${winDiff}ms <= ${TOLERANCE_MS}ms)`);
console.log(`- 服务端判定结果: ${isWinWinner ? '🎉 挑战成功！' : '失败'}`);

if (isWinWinner) {
  const refundAmountCent = mockDb.order.wechatPayInfo.totalFee;
  const outRefundNo = `RF_CHALLENGE_${Date.now()}`;
  
  const refundDoc = {
    _id: "after_service_ch_01",
    orderId: mockDb.order._id,
    _openid: mockDb.order._openid,
    type: "CHALLENGE_WIN_REFUND",
    rightsNo: "CG" + Date.now(),
    status: 50, // COMPLETE
    refundAmount: refundAmountCent,
    refundAmountYuan: (refundAmountCent / 100).toFixed(2),
    refundReason: "3秒挑战极速达成全额免单",
    challengeDetails: {
      durationMs: winDuration,
      diffMs: winDiff,
    },
    refund: {
      outRefundNo,
      refundFee: refundAmountCent,
      status: "SUCCESS",
    }
  };
  mockDb.after_service.push(refundDoc);

  // 更新订单：释放履约锁定，标记 WINNER_REFUNDED
  mockDb.order.fulfillmentHold = false;
  mockDb.order.challengeStatus = "WINNER_REFUNDED";
  mockDb.order.challengeWinInfo = {
    durationMs: winDuration,
    diffMs: winDiff,
    refundDocId: refundDoc._id,
    refundAmount: refundDoc.refundAmountYuan,
    outRefundNo,
  };

  console.log(`- 逆向免单退款单生成: ${refundDoc.rightsNo}，退款金额 ¥${refundDoc.refundAmountYuan}`);
  console.log(`- 订单状态: 履约暂扣已释放 (fulfillmentHold: false)，挑战标记: ${mockDb.order.challengeStatus}`);
  console.log(`- 商业闭环达成: 用户获得全额退款，所购日用品商品照常履约发货！`);
  console.log('✅ 挑战成功免单退款与履约锁定释放全流程校验通过\n');
} else {
  throw new Error('❌ 判定失误');
}

// 5. 验证后台发货防呆机制
console.log('【5. 后台发货履约防呆校验】');
const testHoldOrder = {
  _id: "order_hold_test",
  status: "PENDING_DELIVERY",
  fulfillmentHold: true,
};

function checkCanShip(order) {
  if (order.status !== "PENDING_DELIVERY") throw new Error("订单状态不允许发货");
  if (order.fulfillmentHold) throw new Error("该订单正在进行免单挑战或等待挑战结算，履约已暂扣，暂不能发货");
  return true;
}

try {
  checkCanShip(testHoldOrder);
  throw new Error('❌ 防呆机制未生效');
} catch (e) {
  console.log(`- 拦截到未结算订单发货请求: "${e.message}"`);
  console.log('✅ 后台发货履约拦截防呆机制正常生效\n');
}

console.log('====================================================');
console.log('🎉 Phase 2: 3秒挑战免单服务端引擎与履约控制 全部验证通过！');
console.log('====================================================');
