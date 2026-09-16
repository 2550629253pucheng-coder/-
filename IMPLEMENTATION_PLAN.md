# 挑战免单商城 — 分阶段实施演进路线 (IMPLEMENTATION_PLAN.md)

> 项目状态：FINAL MVP 实施规划  
> 原则：小步演进、每步可运行、每步可验证，禁止推倒重构，核心交易安全第一。

---

## 阶段规划概览

```text
Phase 0: 项目安全审计与合规基线确认
   ↓
Phase 1: 商城底座调优与多租户环境就绪
   ↓
Phase 2: 订单模型升级与履约挂起 (fulfillmentHold)
   ↓
Phase 3: Challenge 引擎与 Stage A 测试模式（0元校准网络分布）
   ↓
Phase 4: Hybrid Timing 校准与正式 WIN/LOSE 规则版本化落库
   ↓
Phase 5: 独立免单退款体系 (refunds) 与退款回调分发
   ↓
Phase 6: 抽象 ERP Adapter 与推单幂等发货
   ↓
Phase 7: 活动熔断中心 (Circuit Breaker) 与异常恢复 (SAFE_SETTLEMENT)
   ↓
Phase 8: 财务成本模型与运营告警看板
   ↓
Phase 9: 灰度上线验证与全流程端到端闭环
```

---

## Phase 0: 项目安全审计与合规基线确认

### 目标
- 全面审查 `mini-ecom-open` 开源底座的安全性，重点检查订单金额防篡改、库存扣减一致性、云函数权限与密钥安全。
- 确认合规核查清单与微信平台免单营销准入条款（文案严禁赌博词汇）。

### 修改文件
- 无业务代码修改（纯审计阶段）。

### 新增文件
- `docs/security_audit_report.md`
- `docs/compliance_checklist.md`

### 数据模型
- 验证现有 10 个集合的基础索引及权限规则：`goods_spu`, `goods_sku`, `order`, `cart`, `address`, `user_info`, `after-service`, `home_config`, `store`, `comments`。

### 接口与规则
- 检查 `rules/*.json` 中 `_openid` 与客户端写权限隔离配置。

### 验收标准
- 确认客户端不能直接更新订单状态、不能越权修改商品价格；
- 确认敏感支付与退款密钥绝不存储于客户端。

### 风险与规避
- 风险：原有代码中某些接口缺少强类型验证。
- 规避：在云函数入口加入显式参数边界校验。

---

## Phase 1: 商城底座调优与多租户环境就绪

### 目标
- 跑通 `mini-ecom-open` 原有完整电商全流程：首页浏览、分类联动、加购、地址管理、创建订单。
- 配置首发日用品 5 个测试 SKU（抽纸、垃圾袋、湿巾、洗衣液、厨房纸）。

### 修改文件
- `tenants/default/tenant.config.js`（配置日用品商城名称、运费与售后策略）
- `miniprogram/config/runtime.js`
- `miniprogram/app.json`

### 新增文件
- `cloudbase/init_goods_fixtures.js`（首发高频刚需日用品数据导入工具）

### 数据模型
- 初始化日用品测试数据至 `goods_spu`, `goods_sku`, `goods_spec`, `category1`, `category2`。

### 接口
- `services/good/fetchGoods.js`
- `cloudfunctions/createOrder/index.js`

### 验收标准
- 用户能在小程序内完整浏览 5 款真实日用品，可选择规格并顺利进入“确认订单”页面，商品价格和运费计算精确无误。

### 风险与规避
- 风险：多租户静态脚本生成可能发生覆盖。
- 规避：固定 `default` 租户配置，禁止多重动态重写。

---

## Phase 2: 订单模型升级与履约挂起 (fulfillmentHold)

### 目标
- 在 `order` 模型中扩展关键玩法字段，绝不破坏原有 `order.status` 生命周期。
- 改造 `paymentCallback`：支付成功后不仅置 `status = PENDING_DELIVERY`，并强行打上 `fulfillmentHold = 'CHALLENGE_PENDING'`，阻止发货。
- 改造管理员与发货接口：对持有未释放锁的订单禁止发货。

### 修改文件
- `cloudfunctions/paymentCallback/index.js`
- `cloudfunctions/adminManageOrder/index.js`
- `rules/order.json`
- `miniprogram/pages/order/order-detail/index.js`
- `miniprogram/pages/order/order-detail/index.wxml`

### 新增文件
- `miniprogram/services/order/orderChallengeState.js`

### 数据模型
- `order` 集合新增字段：
  - `challengeEnabled: Boolean`
  - `challengeId: String`
  - `challengeStatus: String` (`NONE`, `ELIGIBLE`, `STARTED`, `WIN`, `LOSE`, `PENDING_REVIEW`, `INTERRUPTED`, `EXPIRED`, `SAFE_SETTLEMENT`)
  - `fulfillmentHold: String` (`NONE`, `CHALLENGE_PENDING`, `REFUND_PENDING`, `SAFE_SETTLEMENT`)
  - `challengeRefundStatus: String` (`NONE`, `PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`)
  - `erpStatus: String` (`NOT_READY`, `READY`, `SYNCING`, `SYNCED`, `FAILED`)

### 接口
- 扩展 `paymentCallback` 处理流程。
- `adminManageOrder` 增加 `fulfillmentHold` 防御拦截。

### 验收标准
- 支付成功后，订单在后台显示“待发货”，但标识“挑战挂起中 (CHALLENGE_PENDING)”；
- 尝试发货时，系统拒绝并提示“订单履约被挑战锁定，禁止发货”。

### 风险与规避
- 风险：旧订单缺失字段导致空指针异常。
- 规避：在所有读写逻辑中提供安全默认值（`fulfillmentHold || 'NONE'`）。

---

## Phase 3: Challenge 引擎与 Stage A 测试模式

### 目标
- 构建独立的挑战引擎云函数和前端游戏交互界面。
- 实施 **Stage A 测试模式**（0元空跑测试），不涉及真实退款，用于采集 100~300 名测试用户的网络延迟与操作耗时。
- 收集：`client_elapsed_ms`, `server_observed_duration_ms`, `timing_delta_ms`, 网络与设备元数据。

### 修改文件
- `miniprogram/app.template.json`（注册挑战分包或页面路由）
- `miniprogram/pages/order/pay-result/index.js`（支付后引导至挑战页面）

### 新增文件
- `cloudfunctions/challengeCreate/index.js`
- `cloudfunctions/challengeStart/index.js`
- `cloudfunctions/challengeFinish/index.js`
- `cloudfunctions/challengeGet/index.js`
- `miniprogram/pages/challenge/index.js`
- `miniprogram/pages/challenge/index.wxml`
- `miniprogram/pages/challenge/index.wxss`
- `miniprogram/services/challenge/challengeService.js`

### 数据模型
- 新增 `challenges` 集合：
  - `challengeId`, `orderId`, `openid`, `activityId`, `gameType`, `ruleVersion`, `status`, `result`, `nonce`, `clientElapsedMs`, `serverObservedDurationMs`, `timingDeltaMs`, `network`, `device`, `createdAt`, `startedAt`, `finishedAt`
- 新增 `challenge_rules` 集合：
  - `ruleId`, `ruleVersion`, `targetTimeMs`, `successMinMs`, `successMaxMs`, `maxRoundDurationMs`, `timingToleranceMs`

### 接口
- `challengeCreate`: 幂等创建挑战会话
- `challengeStart`: 签发 Nonce 与记录起始时间
- `challengeFinish`: 测试模式下仅记录耗时指标，不触发退款
- `challengeGet`: 查询成绩与状态

### 验收标准
- 界面纯粹呈现“3秒免单挑战，尽可能停在3秒，开始/停”，没有多余复杂动画；
- 用户点击后能精确上报客户端耗时和服务端往返耗时，数据完整落入 `challenges` 表。

### 风险与规避
- 风险：客户端作弊或脚本快速触发。
- 规避：Nonce 动态加盐校验与会话一次性标记。

---

## Phase 4: Hybrid Timing 校准与正式 WIN/LOSE 规则版本化落库

### 目标
- 分析 Stage A 测试采集数据，计算 P95、P99、P99.5 耗时抖动，确定正式 `timing_tolerance_ms` 并形成 `RISK_CONFIG_V1`。
- 确定 `THREE_SECOND_V1` 正式成功判定区间（如 2880ms ~ 3120ms），由真实分布而非随机数决定。
- 激活真实 WIN / LOSE 判定；针对异常时钟偏差标记 `PENDING_REVIEW`，绝不直接判输。

### 修改文件
- `cloudfunctions/challengeFinish/index.js`
- `miniprogram/pages/challenge/index.js`

### 新增文件
- `miniprogram/pages/challenge-result/index.js`
- `miniprogram/pages/challenge-result/index.wxml`
- `cloudfunctions/challengeReview/index.js`（管理端复核）
- `rules/challenges.json`

### 数据模型
- `challenge_rules` 固化版本记录 `THREE_SECOND_V1`，包含有效时间段与容差配置。
- `challenges` 落库真实判定结果（`WIN`, `LOSE`, `PENDING_REVIEW`）。

### 接口
- `challengeFinish` 输出最终判定状态；
- `challengeReview` 提供人工复核接口。

### 验收标准
- 落在规则区间的诚实操作被判定为 WIN；未落入区间被判定为 LOSE；
- 时钟差超过容差的请求进入 `PENDING_REVIEW` 待审队列；
- 所有挑战与创建时的 `ruleVersion` 严格绑定，历史记录不受后续规则调整影响。

### 风险与规避
- 风险：极端弱网环境下时间差大幅波动。
- 规避：异常一律进待审队列，保护诚实用户利益。

---

## Phase 5: 独立免单退款体系 (refunds) 与退款回调分发

### 目标
- 建立独立的 `refunds` 数据模型，彻底杜绝伪造 `after-service` 售后单退款的做法。
- 实现 `challengeRefund` 微信退款工作流发起。
- 改造 `refundCallback`：根据 `sourceType` 自动分流，若为免单退款成功，置 `fulfillmentHold = NONE`, `erpStatus = READY`。

### 修改文件
- `cloudfunctions/refundCallback/index.js`
- `miniprogram/pages/order/order-detail/index.js`

### 新增文件
- `cloudfunctions/challengeRefund/index.js`
- `rules/refunds.json`

### 数据模型
- 新增 `refunds` 集合：
  - `refundId`, `orderId`, `sourceType` (`CHALLENGE_FREE_ORDER` / `AFTER_SALE`), `outRefundNo`, `amount`, `status`, `wechatRefundId`, `errorCode`, `errorMessage`, `createdAt`, `updatedAt`

### 接口
- `challengeRefund`: 触发免单微信退款（强校验 `challengeStatus === 'WIN'`）
- 改造后的 `refundCallback`: 识别免单退款成功并解除履约锁

### 验收标准
- WIN 订单自动触发免单退款，微信退款回调成功后，`fulfillmentHold` 自动释放为 `NONE`，`erpStatus` 更新为 `READY`；
- 普通售后退款走原流程，两者互不干扰。

### 风险与规避
- 风险：微信退款重复发起导致资损或报错。
- 规避：利用 `refunds` 中的唯一 `outRefundNo` 做到严格幂等，微信多次回调幂等去重。

---

## Phase 6: 抽象 ERP Adapter 与推单幂等发货

### 目标
- 实现解耦的 ERP Adapter，支持主流电商 ERP（聚水潭、旺店通等标准协议或抽象接口）。
- 仅当满足 `status == PENDING_DELIVERY && fulfillmentHold == NONE && erpStatus == READY` 时推单。
- 引入全局幂等键 `ERP_CREATE_ORDER:{orderId}`，彻底防止重复推单重复发货。

### 修改文件
- `cloudfunctions/adminManageOrder/index.js`

### 新增文件
- `cloudfunctions/erpCreateOrder/index.js`
- `cloudfunctions/erpCancelOrder/index.js`
- `cloudfunctions/erpSyncLogistics/index.js`
- `cloudfunctions/erpCallback/index.js`
- `rules/erp_sync_tasks.json`

### 数据模型
- 新增 `erp_sync_tasks` 集合：
  - `taskId`, `orderId`, `idempotencyKey`, `action`, `status` (`PENDING`, `SYNCING`, `SYNCED`, `FAILED`), `retryCount`, `payload`, `response`, `createdAt`, `updatedAt`

### 接口
- `erpCreateOrder`: 统一推单接口
- `erpCallback`: 接收 ERP 仓库发货运单回传

### 验收标准
- 未完成挑战或未退款成功的 WIN 订单绝对无法推至 ERP；
- 退款成功的 WIN 订单和正常 LOSE 订单顺利推单并成功拿到 ERP 运单回填；
- 并发或重复调用 `erpCreateOrder` 时，永远只生成一张外部 ERP 订单。

### 风险与规避
- 风险：ERP 服务偶发超时导致推单中断。
- 规避：`erp_sync_tasks` 记录推单重试队列与状态机，支持指数退避重试。

---

## Phase 7: 活动熔断中心 (Circuit Breaker) 与异常恢复 (SAFE_SETTLEMENT)

### 目标
- 实现活动管理与一键暂停（PAUSE）；
- 熔断时执行 `HOLD_AND_RESUME` 保全策略，冻结用户有效时间，活动恢复后继续挑战；
- 区分技术中断（`NETWORK_ERROR`, `SYSTEM_ERROR` 等）与用户超时，技术故障转 `INTERRUPTED`，支持通过 `challengeResume` 无损恢复。

### 修改文件
- `cloudfunctions/challengeFinish/index.js`

### 新增文件
- `cloudfunctions/activityPause/index.js`
- `cloudfunctions/activityResume/index.js`
- `cloudfunctions/challengeResume/index.js`
- `cloudfunctions/challengeTimeout/index.js`
- `rules/activities.json`
- `rules/compliance_events.json`

### 数据模型
- 新增 `activities` 集合：
  - `activityId`, `name`, `status` (`DRAFT`, `ACTIVE`, `PAUSED`, `STOPPED`), `productIds`, `ruleVersion`, `pauseDefaultPolicy` (`HOLD_AND_RESUME`), `dailyFreeOrderBudget`, `maxLoseReturnRate`
- 新增 `compliance_events` 集合：
  - `eventId`, `activityId`, `eventType`, `reason`, `operator`, `createdAt`

### 接口
- `activityPause` / `activityResume`: 活动熔断与重启
- `challengeResume`: 故障挑战恢复接口
- `challengeTimeout`: 超期有效结算

### 验收标准
- 后台一键点击 PAUSE，立即阻止新订单生成挑战资格，已支付用户权益被保全冻结，恢复后可顺利继续。

### 风险与规避
- 风险：暂停期间用户投诉。
- 规避：小程序前端展示温和的系统维护通知，明确告知用户资格已被保全。

---

## Phase 8: 财务成本模型与运营告警看板

### 目标
- 运营管理后台实现完整的经济模型动态测算器。
- 实时计算 Conservative 利润与可恢复库存利润，展示单均贡献 $ContributionPerPaidOrder$。
- 实现监控与自动报警：当 WIN 率偏差超标、LOSE 退货率超标、单均贡献为负时触发 ALERT。

### 修改文件
- `miniprogram/pages/admin/dashboard/index.js`
- `miniprogram/pages/admin/dashboard/index.wxml`

### 新增文件
- `miniprogram/pages/admin/finance/index.js`
- `miniprogram/pages/admin/finance/index.wxml`
- `cloudfunctions/complianceMonitor/index.js`
- `rules/promotion_records.json`
- `rules/risk_logs.json`

### 数据模型
- 新增 `promotion_records`（活动快照与规则备案存证）
- 新增 `risk_logs`（风控事件日志）

### 算法实现
$$\text{Profit\_adjusted} = N \cdot P(1-W)(1-R) - N(C_g+C_o) - N(1-W)R \cdot C_r - N \cdot C_p - N \cdot C_c + N(1-W)R \cdot C_g \cdot S$$
$$ContributionPerPaidOrder = \frac{\text{Profit\_adjusted}}{N}$$

### 验收标准
- 后台实时动态展示单均贡献、真实 WIN 率、免单成本消耗进度；
- 指标超出预设阈值时自动标记红线并支持自动触发熔断。

### 风险与规避
- 风险：统计聚合数据量大影响数据库性能。
- 规避：采用定时聚合计量与轻量级快照缓存。

---

## Phase 9: 灰度上线验证与全流程端到端闭环

### 目标
- 执行严谨的分阶段灰度放量（Stage A 0元校准 → Stage B 50~100真实单 → Stage C 200~300单 → Stage D 1000单）。
- 端到端贯穿“买日用品 → 真实支付 → 3秒挑战 → WIN免单退款照常发货 / LOSE正常成交发货 → ERP 履约出库”。

### 修改文件
- 全局细节联调与文案合规修饰。

### 验收标准
- 支付闭环、退款闭环、发货闭环、数据统计闭环 100% 验证通过；
- 无资损漏洞，无重复推单，无逻辑死锁。
