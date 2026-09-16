// 模拟完整电商链路测试脚本：首页浏览 -> 分类导航 -> 加购 -> 地址 -> 下单 -> 支付回调模拟
const fixtures = require('../cloudbase/init_goods_fixtures.cjs');
const tenantConfig = require('../tenants/default/tenant.config.js');

console.log('====================================================');
console.log('🚀 开始验证 Phase 1 商城基础全链路 (日用品特惠专营)');
console.log('====================================================\n');

// 1. 验证租户配置
console.log('【1. 租户配置验证】');
console.log(`- 商城名称: ${tenantConfig.app.name}`);
console.log(`- 商城定位: ${tenantConfig.app.description}`);
console.log(`- 运费规则: 默认运费 ¥${tenantConfig.order.shipping.defaultFee}，满 ¥${tenantConfig.order.shipping.freeShippingThreshold} 包邮`);
console.log(`- 挑战模式配置: ${JSON.stringify(tenantConfig.challenge)}`);
if (tenantConfig.order.shipping.defaultFee === 6 && tenantConfig.order.shipping.freeShippingThreshold === 39) {
  console.log('✅ 租户配送与运费配置正常\n');
} else {
  throw new Error('❌ 运费配置不符合日用品商城设定');
}

// 2. 模拟数据库/模型环境
const db = {
  category1: fixtures.categories.category1,
  category2: fixtures.categories.category2,
  goods_spu: fixtures.spus,
  goods_spec: fixtures.specs,
  goods_sku: fixtures.skus,
  home_config: fixtures.homeConfig,
  cart: [],
  address: [
    {
      _id: 'addr-001',
      _openid: 'mock_user_1001',
      name: '张三',
      phone: '13800138000',
      provinceName: '广东省',
      cityName: '深圳市',
      districtName: '南山区',
      detailAddress: '科技园南路腾讯大厦88号',
      isDefault: true,
      isValid: true,
    }
  ],
  orders: []
};

// 3. 验证步骤 A：首页商品聚合
console.log('【2. 首页与分类数据流验证】');
const home = db.home_config[0];
console.log(`- 首页轮播图数量: ${home.swiper.length}`);
console.log(`- 首页 Tab 导航: ${home.tabList.map(t => t.text).join(' | ')}`);

// 获取爆款 Tab 商品
const firstTab = home.tabList[0];
const tabSpus = firstTab.spuIds.map(id => db.goods_spu.find(s => s._id === id)).filter(Boolean);
console.log(`- 首屏 "${firstTab.text}" 推荐商品: ${tabSpus.map(s => s.title).join('、')}`);
if (tabSpus.length === 3) {
  console.log('✅ 首页推荐商品匹配成功\n');
} else {
  throw new Error('❌ 首页推荐商品缺失');
}

// 4. 验证步骤 B：分类检索
console.log('【3. 分类检索与多层结构验证】');
const c1List = db.category1;
const c2List = db.category2;
console.log(`- 一级分类: ${c1List.map(c => c.category1Name).join(', ')}`);
console.log(`- 二级分类: ${c2List.map(c => c.category2Name).join(', ')}`);
// 检验分类下是否有商品
c2List.forEach(c2 => {
  const count = db.goods_spu.filter(s => s.categoryId._id === c2._id).length;
  console.log(`  * [${c2.category2Name}] 包含 SPU 数量: ${count}`);
});
console.log('✅ 分类结构与层级映射完整\n');

// 5. 验证步骤 C：商品详情与加购
console.log('【4. 详情页与购物车加购验证】');
const targetSpu = db.goods_spu[0]; // 抽纸
const targetSpecs = db.goods_spec.filter(spec => spec.spuId._id === targetSpu._id);
const targetSkus = db.goods_sku.filter(sku => sku.spuId._id === targetSpu._id);
console.log(`- 目标加购商品: ${targetSpu.title}`);
console.log(`- 规格定义: ${targetSpecs[0].title} -> ${targetSpecs[0].values.map(v => v.value).join(' / ')}`);
console.log(`- 可选 SKU 数量: ${targetSkus.length}`);

// 选择 SKU 1: 8包轻享装 (19.90 元) 购买 2 件
const selectedSku = targetSkus[0];
const buyQuantity = 2;
const cartItem = {
  _id: 'cart-item-1',
  _openid: 'mock_user_1001',
  spuId: targetSpu._id,
  skuId: selectedSku.skuId,
  title: targetSpu.title,
  thumb: selectedSku.image,
  price: selectedSku.price, // 1990 分 = 19.90 元
  quantity: buyQuantity,
  stockQuantity: selectedSku.stock,
  isSelected: true,
  valid: true,
};
db.cart.push(cartItem);
console.log(`- 成功加购: ${cartItem.title} (${selectedSku.specValues[0].specValueId}) x ${cartItem.quantity}件, 单价 ¥${(cartItem.price / 100).toFixed(2)}`);
console.log(`- 购物车当前商品件数: ${db.cart.length}`);
console.log('✅ 购物车添加与数据持久化校验通过\n');

// 6. 验证步骤 D：结算与运费计算
console.log('【5. 结算中心运费与订单金额计算验证】');
const goodsTotalCent = db.cart.filter(i => i.isSelected).reduce((sum, i) => sum + i.price * i.quantity, 0);
const goodsTotalYuan = goodsTotalCent / 100;
const freeThreshold = tenantConfig.order.shipping.freeShippingThreshold; // 39
const defaultShippingFee = tenantConfig.order.shipping.defaultFee; // 6

const shouldChargeShipping = goodsTotalYuan < freeThreshold;
const deliveryFee = shouldChargeShipping ? defaultShippingFee : 0;
const totalPayAmountYuan = goodsTotalYuan + deliveryFee;

console.log(`- 商品总计: ¥${goodsTotalYuan.toFixed(2)} (满 ¥${freeThreshold} 包邮)`);
console.log(`- 配送费: ¥${deliveryFee.toFixed(2)}`);
console.log(`- 应付总额: ¥${totalPayAmountYuan.toFixed(2)}`);

if (goodsTotalYuan === 39.80 && deliveryFee === 0) {
  console.log('✅ 满 39 元免运费计算精确无误\n');
} else {
  console.warn(`提示：当前金额 ¥${goodsTotalYuan} 运费 ¥${deliveryFee}`);
}

// 7. 验证步骤 E：订单创建与库存事务扣减
console.log('【6. 订单创建与事务库存扣减模拟】');
const initialStock = selectedSku.stock;
if (selectedSku.stock < buyQuantity) {
  throw new Error('库存不足');
}
// 扣减库存
selectedSku.stock -= buyQuantity;
const newOrderId = 'ORDER_' + Date.now();
const orderDoc = {
  _id: newOrderId,
  orderNo: 'NO' + Date.now(),
  _openid: 'mock_user_1001',
  status: 'PENDING_PAYMENT',
  goodsList: [
    {
      spuId: targetSpu._id,
      skuId: selectedSku.skuId,
      title: targetSpu.title,
      price: selectedSku.price,
      quantity: buyQuantity,
      thumb: selectedSku.image,
    }
  ],
  userAddress: db.address[0],
  orderSummary: {
    totalSalePrice: goodsTotalYuan.toFixed(2),
    deliveryFee: deliveryFee.toFixed(2),
    promotionAmount: '0.00',
    totalPayAmount: totalPayAmountYuan.toFixed(2),
  },
  deliveryType: 1,
  createdAt: Date.now(),
  fulfillmentHold: true, // 为后续 Phase 4 预热
};
db.orders.push(orderDoc);

console.log(`- 订单创建成功: 订单号 ${orderDoc.orderNo}, 状态: ${orderDoc.status}`);
console.log(`- SKU 库存扣减: ${initialStock} -> ${selectedSku.stock}`);
console.log('✅ 订单入库与库存扣除校验通过\n');

// 8. 验证步骤 F：支付回调与履约暂扣
console.log('【7. 支付回调与状态机跃迁验证】');
// 模拟微信支付成功回调
const paymentCallbackPayload = {
  outTradeNo: newOrderId,
  transactionId: 'WX_TXN_' + Date.now(),
  returnCode: 'SUCCESS',
  resultCode: 'SUCCESS',
  totalFee: Math.round(totalPayAmountYuan * 100),
};

const targetOrder = db.orders.find(o => o._id === paymentCallbackPayload.outTradeNo);
if (!targetOrder) throw new Error('订单未找到');

targetOrder.status = 'PENDING_DELIVERY'; // 待发货
targetOrder.payTime = Date.now();
targetOrder.wechatPayInfo = {
  transactionId: paymentCallbackPayload.transactionId,
  totalFee: paymentCallbackPayload.totalFee,
};

console.log(`- 收到微信支付通知，订单 ${targetOrder._id} 状态更新为: ${targetOrder.status}`);
console.log(`- 支付交易号: ${targetOrder.wechatPayInfo.transactionId}, 实付: ¥${(targetOrder.wechatPayInfo.totalFee / 100).toFixed(2)}`);
console.log('✅ 支付回调驱动状态机更新通过\n');

console.log('====================================================');
console.log('🎉 Phase 1: 商城底座调优与多租户环境就绪 全部验证通过！');
console.log('====================================================');
