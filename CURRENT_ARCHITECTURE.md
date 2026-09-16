# 挑战免单商城 — 当前系统架构审计文档 (CURRENT_ARCHITECTURE.md)

> 文档版本：V1.0  
> 审计基线：`menlong999/mini-ecom-open` (Commit: `3e7b2a746fab1775a4f7bc71dfefe7b364cf9fc0`)  
> 技术栈：微信原生小程序 + TDesign 1.12.1 + 微信云开发 CloudBase (Node.js 18+) + FlexDB 数据模型

---

## 一、当前项目完整目录拓扑

```text
/app/applet/
├── DATA_MODELS.md                 # CloudBase 数据模型字段真值说明
├── cloudbaserc.json               # CloudBase 项目与多租户配置
├── project.config.template.json   # 微信开发者工具配置模板
├── tenants/                       # 多租户静态配置
│   ├── default/
│   │   └── tenant.config.js       # 默认租户配置（名称、运费规则、售后配置、物流公司列表）
│   └── example/
├── cloudbase/                     # 数据库初始化/迁移脚本
├── rules/                         # CloudBase 数据库集合安全权限规则
│   ├── order.json
│   ├── goods_spu.json
│   ├── goods_sku.json
│   ├── cart.json
│   ├── address.json
│   ├── user_info.json
│   └── after-service.json
├── cloudfunctions/                # 后端云函数集合 (Node.js)
│   ├── createOrder/               # 订单创建（事务扣减SKU与SPU库存、校验价格）
│   ├── unifiedOrder/              # 微信统一下单（校验订单金额与归属，调用工作流）
│   ├── paymentCallback/           # 微信支付成功回调（解密报文，更新订单待发货）
│   ├── refundCallback/            # 微信退款回调（解密报文，更新售后单与订单商品状态）
│   ├── manageOrder/               # 用户端订单操作（取消、删除、确认收货）
│   ├── adminManageOrder/          # 管理员端订单操作（列表、详情、发货、自提核销、更新物流）
│   ├── manageAfterService/        # 用户端售后申请与撤销
│   ├── adminManageAfterService/   # 管理员端售后审核、收货、发起微信退款工作流
│   ├── getLogisticsTrack/         # 物流轨迹查询（对接微信物流助手）
│   ├── cancelOrderTimer/          # 定时器：超时未支付订单自动取消
│   ├── confirmReceiptTimer/       # 定时器：超时未确认收货自动完成
│   ├── adminManageGoods/          # 管理员商品管理
│   ├── adminManageStock/          # 管理员库存管理
│   ├── adminManageCategory/       # 管理员分类管理
│   ├── adminManageHomeConfig/     # 管理员首页配置
│   ├── adminManageReport/         # 管理员基础统计报表
│   ├── adminManageDistributor/    # 管理员分销管理
│   ├── manageCart/                # 购物车读写
│   ├── manageAddress/             # 收货地址管理
│   ├── manageUser/                # 用户信息与权限
│   ├── manageComments/            # 评价管理
│   ├── generateQRCode/            # 生成小程序码
│   └── login/                     # 微信登录与用户初始化
└── miniprogram/                   # 微信原生小程序工程
    ├── app.js                     # 小程序入口（初始化 wx.cloud 与数据模型 SDK）
    ├── app.json                   # 页面与分包路由注册（由脚本生成）
    ├── app.template.json          # 路由注册源模板
    ├── config/                    # 运行时配置（runtime.js）
    ├── custom-tab-bar/            # 自定义底部导航（首页、分类、购物车、我的）
    ├── components/                # 通用 UI 组件（价格、商品卡、状态标签、轮播等）
    ├── services/                  # 全局业务 Service
    │   ├── common/                # 登录、上传
    │   ├── good/                  # 商品查询、分类、SKU Helper
    │   ├── home/                  # 首页配置与推荐流
    │   ├── cart/                  # 购物车操作
    │   ├── order/                 # 物流配置、订单通用状态映射
    │   └── usercenter/            # 用户中心、二维码
    ├── pages/                     # 小程序页面结构
    │   ├── home/                  # 首页
    │   ├── category/              # 分类页
    │   ├── cart/                  # 购物车
    │   ├── usercenter/            # 个人中心（个人资料、地址管理等）
    │   ├── goods/                 # [分包] 商品（list, details, comments）
    │   ├── order/                 # [分包] 订单（order-confirm, pay-result, order-list, order-detail, apply-service, after-service-*）
    │   └── admin/                 # [分包] 管理端（dashboard, goods, order, stock, report, after-service）
    └── scripts/                   # 租户同步与静态检查脚本
```

---

## 二、小程序页面结构

| 页面路径 | 包归属 | 功能描述 | 现状与交互 |
| :--- | :--- | :--- | :--- |
| `pages/home/home` | 主包 | 商城首页 | 展示轮播图、公告、Tab商品分组、瀑布流商品列表 |
| `pages/category/index` | 主包 | 二级商品分类 | 左侧一级分类、右侧二级子分类与商品 |
| `pages/cart/index` | 主包 | 购物车 | 勾选结算、数量加减、失效商品过滤、跳转确认单 |
| `pages/usercenter/index` | 主包 | 个人中心 | 用户信息、订单状态角标（待付款/待发货/待收货/售后）、管理入口 |
| `pages/usercenter/address/list/index` | 主包 | 收货地址列表 | 设置默认地址、编辑、删除 |
| `pages/goods/details/index` | 分包(goods) | 商品详情页 | 轮播主图、SPU信息、规格弹窗(SKU选择器)、立即购买/加购 |
| `pages/order/order-confirm/index` | 分包(order) | 订单确认页 | 地址选择/自提门店、运费与满减核算、提交订单并唤起支付 |
| `pages/order/pay-result/index` | 分包(order) | 支付结果页 | 支付成功反馈、金额展示、查看订单/返回首页按钮 |
| `pages/order/order-list/index` | 分包(order) | 我的订单列表 | 状态Tab过滤、订单卡片、操作按钮（去支付、确认收货、申请售后） |
| `pages/order/order-detail/index` | 分包(order) | 订单详情页 | 订单全流程状态展示、商品清单、收货地址、物流单号、操作面板 |
| `pages/order/apply-service/index` | 分包(order) | 售后申请页 | 选择退款类型（仅退款/退货退款）、原因、金额、上传凭证 |
| `pages/order/after-service-list/index`| 分包(order) | 售后列表页 | 售后单审核状态跟踪 |
| `pages/order/after-service-detail/index`| 分包(order)| 售后详情页 | 协商历史、退货物流填写、退款处理状态 |
| `pages/admin/dashboard/index` | 分包(admin) | 管理员控制台 | 关键统计指标导航、快捷操作 |
| `pages/admin/order/list/index` | 分包(admin) | 订单履约管理 | 订单列表、筛选发货状态、进入发货流程 |
| `pages/admin/order/ship/index` | 分包(admin) | 订单发货页 | 填报快递公司与快递单号，触发发货 |
| `pages/admin/after-service/list/index`| 分包(admin) | 售后审核列表 | 审核退款、拒绝售后、发起退款工作流 |

---

## 三、Service 层结构

1. **商品层 (`services/good/`)**:
   - `fetchGoods.js`: 分页拉取 SPU 列表与 SPU 详情，支持分类与排序。
   - `skuHelper.js`: 处理多规格 SKU 匹配，计算最高/最低价格与总库存。
   - `fetchCategoryList.js`: 树状类目加载。
2. **订单与交易层 (`miniprogram/pages/order/services/`)**:
   - `createOrder.js`: 封装 `wx.cloud.callFunction({ name: 'createOrder' })`。
   - `payment.js`: 封装 `dispatchCommitPay`，调用 `unifiedOrder` 获取微信支付拉起参数并做规范化。
   - `orderDetail.js`: 获取订单详情、取消订单、确认收货、删除订单。
   - `orderList.js`: 订单列表分页查询与状态统计。
   - `afterService.js`: 售后单列表与详情查询。
   - `applyService.js`: 构造售后申请报文。
3. **管理层 (`miniprogram/pages/admin/services/`)**:
   - `orderMgr.js`: 订单列表拉取、发货调用 `adminManageOrder`。
   - `afterServiceMgr.js`: 售后审核、确认收货、触发退款工作流。
   - `goodsMgr.js` & `stockMgr.js`: 商品上下架与库存调校。

---

## 四、Cloud Functions 深度剖析

### 1. `createOrder` (下单云函数)
- **事务保护**：开启 `db.startTransaction()`。
- **库存操作**：循环 `goodsList`，检查 `goods_sku.stock`，通过 `_.inc(-quantity)` 扣减 SKU 库存并同步更新 `goods_spu.spuStockQuantity`。
- **价格校验**：严格比对前端传入价格与数据库 SKU 售价（允许 0.01 浮动），防止客户端篡改价格。
- **金额计算**：按服务端配置（运费门槛 `freeShippingThreshold`）重新计算总金额。
- **订单入库**：写入集合 `order`，初始状态 `PENDING_PAYMENT`，返回 `orderId` 与生成唯一的 `orderNo`。
- **清理购物车**：若包含 `cartId`，事务内同步删除用户购物车记录。

### 2. `unifiedOrder` (统一下单)
- **所有权安全**：`_openid: openId` 强绑定，且限定只能支付当前用户处于 `PENDING_PAYMENT` 的订单。
- **金额重算**：服务端依据订单快照 `order.orderSummary.totalPayAmount` 转换分为单位，拒绝客户端篡改。
- **调用支付工作流**：通过配置的 `workflowName` 调用微信支付统一下单，返回签名参数。

### 3. `paymentCallback` (微信支付回调)
- **解密处理**：支持 AES-256-GCM 解密微信 V3 回调报文，提取 `outTradeNo`、`transactionId`、`totalFee`。
- **幂等防护**：若订单状态已为 `PENDING_DELIVERY`，直接返回成功。
- **状态流转**：更新订单 `status = PENDING_DELIVERY`，记录 `payTime` 与 `wechatPayInfo`。

### 4. `refundCallback` (退款回调)
- **当前设计局限**：原仓库退款回调完全硬编码绑定在 `after-service` 售后单维度。通过 `outRefundNo` 查找售后单 `after-service`，更新售后状态为 `COMPLETE`，并将对应订单中商品的 `afterServiceStatus` 置为退款完成。

### 5. `manageOrder` & `adminManageOrder`
- **用户操作**：支持未付款取消 `CANCELED_NOT_PAYMENT`、付款后取消 `CANCELED_PAYMENT`（需转售后）、确认收货 `COMPLETE`。
- **管理员发货**：`action = 'ship'`，将订单状态从 `PENDING_DELIVERY` 推进到 `PENDING_RECEIPT`，记录物流公司编码、快递单号与发货时间。

---

## 五、当前数据模型 (FlexDB)

| 集合名称 | 主键/关键索引 | 核心字段 | 业务职责 |
| :--- | :--- | :--- | :--- |
| `goods_spu` | `spuId`, `_id` | `title`, `primaryImage`, `images`, `minSalePrice`, `spuStockQuantity`, `isPutOnSale`, `categoryId` | 标准商品SPU基础库 |
| `goods_sku` | `skuId`, `spuId` | `price` (分), `stock`, `specValues`, `isDefault`, `image` | SKU库存与具体价格 |
| `goods_spec` | `specId` | `title`, `values` (valueId, value) | 规格属性维度 |
| `order` | `orderNo`, `_id`, `_openid` | `userId`, `status`, `goodsList`, `orderSummary`, `userAddress`, `deliveryType`, `payTime`, `wechatPayInfo` | 核心交易订单模型 |
| `cart` | `_id`, `_openid` | `spuId`, `skuId`, `quantity`, `isSelected`, `valid` | 购物车暂存表 |
| `address` | `_id`, `_openid` | `name`, `phone`, `fullAddress`, `detailAddress`, `isDefault` | 收货地址簿 |
| `user_info` | `_id`, `_openid` | `nickName`, `avatarUrl`, `role` (`admin`/`distributor`/`user`) | 用户身份与角色 |
| `after-service` | `rightsNo`, `orderId` | `status`, `amount`, `reason`, `refund`, `history` | 传统用户售后退款单 |
| `home_config` | `_id` | `searchPlaceholder`, `swiper`, `tabList` | 首页运营装修配置 |
| `store` | `_id` | `name`, `address`, `phone`, `businessHours`, `status` | 线下自提门店 |

---

## 六、当前各业务系统现状分析

1. **商品系统**：SPU/SKU 体系完整，价格与库存拆解合理，具备分类与详情页交互，完全满足日用品销售底座。
2. **订单系统**：订单生命周期（`PENDING_PAYMENT` → `PENDING_DELIVERY` → `PENDING_RECEIPT` → `COMPLETE`）规范清晰，事务创建订单保障了库存与价格安全。
3. **支付系统**：具备服务端金额校验与防篡改机制，具备 V3 报文解密与支付回调幂等防护。
4. **退款系统**：已有退款回调逻辑，但完全与 `after-service`（售后）强耦合，尚无系统级独立退款调度模型。
5. **售后系统**：包含完整的申请、商家审核、拒绝、退货物流追踪、退款完成闭环。
6. **发货/物流系统**：管理端具备手动录入运单发货、结合微信物流助手查询轨迹的能力。
7. **管理端结构**：小程序内建 `pages/admin` 分包，采用基于 `user_info.role === 'admin'` 的权限保护，具备订单、售后、商品管理能力。

---

## 七、当前可直接复用的能力清单

- [x] 商品 SPU / SKU 浏览、类目联动与详情渲染
- [x] 购物车添加、勾选、结算与清空机制
- [x] 微信原生收货地址簿管理与选择
- [x] `createOrder` 事务扣减库存与防低价篡改算法
- [x] `unifiedOrder` 订单归属权限校验与金额换算逻辑
- [x] 微信支付前端拉起交互组件及回调解析框架
- [x] 订单生命周期基础状态机及订单列表/详情渲染
- [x] 基础售后管理能力（针对 LOSE 用户的普通商品售后）
- [x] 管理员权限鉴权机制与管理员分包页面框架
- [x] 微信物流助手轨迹查询接口 (`getLogisticsTrack`)
