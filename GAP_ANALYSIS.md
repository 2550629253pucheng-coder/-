# 挑战免单商城 — 功能差距与风险审计分析 (GAP_ANALYSIS.md)

> 对照基准：最终版 MVP 需求规范 & 商业/技术约束  
> 审计日期：2026-09-16  
> 核心原则：严守 MVP 功能边界，不破坏原有订单电商状态机，杜绝虚假售后退款，杜绝客户端信任漏洞。

---

## 一、功能对照总览矩阵

| 核心领域 | MVP 需求基准 | 原仓库现状 (`mini-ecom-open`) | 改造定位 | 关键技术要求 |
| :--- | :--- | :--- | :--- | :--- |
| **订单状态机** | 电商履约与玩法解耦，保留原订单状态，引入独立状态字段 | 仅有单维 `order.status` (`PENDING_PAYMENT` 等) | **需要修改** | 新增 `challengeStatus`, `fulfillmentHold`, `erpStatus`, `challengeRefundStatus` |
| **履约锁拦截** | 支付成功后挂起履约，禁止立即发货，待挑战结算后放行 | 支付成功即为 `PENDING_DELIVERY`，管理员可立即发货 | **需要修改** | `paymentCallback` 必须置 `fulfillmentHold = CHALLENGE_PENDING`，ERP与手动发货需校验该锁 |
| **挑战引擎** | 3秒真技巧判定，禁止随机数，严禁客户端判赢 | 完全无挑战模块 | **需要新增** | 独立云函数集合：`challengeCreate`, `challengeStart`, `challengeFinish`, `challengeResume` 等 |
| **计时方案** | Hybrid Timing（客户端单调时钟 + 服务端往返观测时钟） | 无 | **需要新增** | 客户端 `client_elapsed_ms`，服务端 `timing_delta_ms`，动态容差计算 |
| **风控与审核** | 异常延迟/时间差超过容差时进入 `PENDING_REVIEW`，严禁直接判负 | 无 | **需要新增** | `risk_logs` 记录设备与网络环境，人工风险复核工作流 |
| **规则版本化** | 挑战绑定创建时的 `ruleVersion`，历史挑战永久锁定规则 | 无 | **需要新增** | `challenge_rules` 集合，多版本发布与版本锁定 |
| **免单退款** | 挑战免单独立退款，禁止伪装成售后单，独立退款凭据 | 仅有 `after-service` 售后退款，无独立退款模型 | **需要新增** | 新增 `refunds` 集合（`sourceType: CHALLENGE_FREE_ORDER`），解耦售后流程 |
| **退款回调** | 识别 `outRefundNo`，区分免单与售后，免单退款成功放行履约 | `refundCallback` 硬编码查询 `after-service` | **需要修改** | 回调先查 `refunds`，若为免单则解除 `fulfillmentHold`，置 `erpStatus = READY` |
| **ERP Adapter** | 接口解耦适配器，保证推单幂等 (`idempotencyKey`)，自动发货 | 仅有管理员在小程序内手动输入快递单号发货 | **需要新增** | `erpCreateOrder`, `erpSyncShipment` 抽象适配器，幂等重试表 `erp_sync_tasks` |
| **安全结算机制** | 活动暂停时遵循 `HOLD_AND_RESUME`，技术故障转 `INTERRUPTED`，严禁全判负 | 无活动概念，无熔断与异常保护 | **需要新增** | `activities` 状态机，`SAFE_SETTLEMENT` 处理策略，断点恢复能力 |
| **财务成本模型** | 运营后台内置 $N, P, W, R, C_g, C_o, C_r, C_p, C_c, S$ 利润测算 | 仅有简单的订单交易额与商品销量统计 | **需要新增** | 动态保守利润与调整利润公式计算，单均贡献实时追踪 |
| **运营看板告警** | 实时监测 WIN 率偏离、LOSE 退货率超标、单均贡献为负等并触发熔断 | 仅有普通销售报表页面 | **需要新增** | 指标阈值监控与自动报警，支持一键 PAUSE 活动 |

---

## 二、详细分类清单

### 1. 已有功能 (可以直接复用)
- **商品层**：SPU/SKU 模型定义、商品列表瀑布流、详情页规格弹窗选择器。
- **交易层**：购物车全生命周期操作、地址簿管理、订单金额核算（运费规则）、`createOrder` 事务下单库存扣减。
- **支付层**：`unifiedOrder` 微信统一下单参数获取、微信支付客户端调起、微信 V3 回调解密。
- **用户层**：微信免密登录体系、个人中心菜单入口、管理员角色鉴权 (`user_info.role === 'admin'`)。
- **售后底座**：LOSE 用户收货后如发起正常商品质量维权，原 `after-service` 模块完整可用。

---

### 2. 缺失功能 (当前仓库完全空白，必须实现)
1. **Challenge Engine (挑战核心引擎)**：
   - 挑战会话创建、资格校验、防重入检查。
   - 3 秒倒计时真技巧挑战交互界面。
   - 客户端单调计时与报文组装。
   - 服务端规则命中判断与结果落库。
2. **Hybrid Timing 计时双向校准引擎**：
   - `server_start_response_sent_at` 与 `server_finish_request_received_at` 记录。
   - 计算服务端观测耗时 `server_observed_duration_ms` 与时间差 `timing_delta_ms`。
3. **独立退款调度模型 (`refunds`)**：
   - 支持免单退款业务标识 `sourceType = CHALLENGE_FREE_ORDER`。
   - 独立退款流水生成、状态追踪与错误重试记录。
4. **ERP 履约适配器体系 (ERP Adapter)**：
   - 抽象 ERP 接口契约：`erpCreateOrder`, `erpCancelOrder`, `erpSyncInventory`, `erpQueryShipment`, `erpSyncLogistics`, `erpCallback`。
   - 幂等推单保障机制：`ERP_CREATE_ORDER:{orderId}`。
5. **活动中枢与熔断控制 (`activities` & `compliance_events`)**：
   - 活动状态机（`DRAFT`, `ACTIVE`, `PAUSED`, `STOPPED`）。
   - 一键熔断与 `HOLD_AND_RESUME` 自动保全机制。
   - 异常中断识别（网络中断、系统停机）与恢复接口。
6. **财务看板与止损监控**：
   - 保守利润 `Profit_conservative` 与库存可恢复利润 `Profit_adjusted` 动态计算器。
   - 关键指标实时监控看板（WIN 率、LOSE 退款率、单均贡献、免单总预算消耗）。

---

### 3. 需要修改功能 (对原代码进行局部解耦与扩展)
1. **`cloudfunctions/paymentCallback`**：
   - **现状**：支付成功直接将订单置为待发货。
   - **修改点**：
     - 保留 `order.status = PENDING_DELIVERY`；
     - 写入 `challengeEnabled = true`, `challengeStatus = ELIGIBLE`, `fulfillmentHold = CHALLENGE_PENDING`, `erpStatus = NOT_READY`；
     - 自动触发创建 `challenges` 待开始记录。
2. **`cloudfunctions/refundCallback`**：
   - **现状**：强制根据 `outRefundNo` 查 `after-service` 集合，假定所有退款均为售后。
   - **修改点**：
     - 重构为双轨分发：先查 `refunds` 集合确认 `sourceType`；
     - 若为 `CHALLENGE_FREE_ORDER`：更新订单 `challengeRefundStatus = SUCCESS`，解除履约锁 `fulfillmentHold = NONE`，变更 `erpStatus = READY`，激活 ERP 推单流；
     - 若为 `AFTER_SALE`：保持原售后更新逻辑不变。
3. **`cloudfunctions/adminManageOrder` & 发货拦截**：
   - **现状**：管理员可对任意 `PENDING_DELIVERY` 订单调用 `ship`。
   - **修改点**：必须增加防卫式前置校验：若 `fulfillmentHold !== NONE`，直接阻断发货并返回明确的业务拦截提示（如“该订单处于挑战免单或退款流程中，履约已锁定”）。
4. **前端订单确认与支付结果页 (`order-confirm`, `pay-result`, `order-detail`)**：
   - **修改点**：
     - 支付成功后引导用户直接进入 3 秒挑战页；
     - 订单详情页清晰展示 Challenge 状态、挑战成绩、免单退款进度与履约锁定标签；
     - 杜绝“博彩/赌博/下注/赢钱”等敏感违规文案，采用严谨的“3秒技巧挑战/免单优惠”合规表述。

---

### 4. 需要新增功能 (新建代码与资源)
1. **新增云函数清单**：
   - `challengeCreate`: 创建或重入检查挑战记录（强幂等保证）。
   - `challengeStart`: 签发 Nonce，锁定当前活动绑定的 `ruleVersion`，记录起始时间。
   - `challengeFinish`: 校验 Hybrid Timing、判定 WIN/LOSE/PENDING_REVIEW，执行状态落库。
   - `challengeGet`: 获取订单关联的挑战状态与成绩。
   - `challengeResume`: 处理小程序闪退、网络重连后的挑战恢复。
   - `challengeTimeout`: 轮询或延迟处理挑战超时未操作订单。
   - `challengeReview`: 管理员对可疑订单人工复核（通过或驳回）。
   - `challengeRefund`: 对 WIN 订单执行微信全额免单退款工作流。
   - `erpCreateOrder` 等 ERP 适配器接口云函数。
   - `complianceMonitor`: 自动告警及阈值检测云函数。
2. **新增小程序端页面**：
   - `pages/challenge/index`: 简洁醒目的 3 秒免单挑战交互页面。
   - `pages/challenge-result/index`: WIN / LOSE / PENDING_REVIEW 差异化结果页。
   - `pages/admin/challenge/list/index`: 管理端挑战记录与风控审核列表。
   - `pages/admin/activity/index`: 管理端活动控制、一键熔断与规则配置面板。
   - `pages/admin/finance/index`: 运营后台财务看板与成本模型计算器。

---

## 三、九大重点模块专项深度检查

### 1. Challenge Engine (挑战引擎)
- **风险点**：并发重入导致一个订单产生多次挑战。
- **防护设计**：在 `challenges` 中建立 `orderId` 唯一索引（或原子事务查询）；同一个 `orderId` 无论调用多少次，只能有一条有效挑战记录。
- **结果判定**：严禁客户端传胜负布尔值！客户端仅上传 `client_elapsed_ms` 和系统环境元数据，服务端结合 `challenge_rules` 的区间进行数学区间包含计算：`successMinMs <= client_elapsed_ms <= successMaxMs`。

### 2. Challenge Refund (免单退款隔离)
- **风险点**：将免单当成售后退款会导致财务账目混乱，且售后退款通常伴随库存退回，而免单必须正常发货。
- **防护设计**：建立独立 `refunds` 集合，免单退款单号采用 `FREE_{orderNo}_{timestamp}` 规范。退款成功时，订单保持待发货，商品不作售后标记，库存不退回。

### 3. Hybrid Timing (双向校准授信)
- **风险点**：移动端网络偶发高延迟或抖动，若直接使用服务端收到时间差可能误杀诚实用户；若完全信任客户端耗时则容易被抓包篡改。
- **防护设计**：
  - 客户端使用 `performance.now()` 记录单调时钟；
  - 服务端记录 `server_start_response_sent_at` 与 `server_finish_request_received_at`；
  - 计算偏差 $\Delta = server\_observed\_duration - client\_elapsed$；
  - 若 $\Delta > timing\_tolerance\_ms$ 或 $\Delta < -negative\_tolerance\_ms$，进入 `PENDING_REVIEW`，**严禁直接判 LOSE**。

### 4. fulfillmentHold (履约状态锁)
- **风险点**：支付成功与挑战之间存在时间差，若 ERP 自动化同步轮询过快，可能在用户挑战前把货发走，随后用户 WIN 导致资损。
- **防护设计**：`paymentCallback` 写入订单的第一瞬间必须设置 `fulfillmentHold = 'CHALLENGE_PENDING'` 且 `erpStatus = 'NOT_READY'`。ERP 扫描任务必须增加三元与条件：`status == 'PENDING_DELIVERY' && fulfillmentHold == 'NONE' && erpStatus == 'READY'`。

### 5. ERP Adapter (解耦与防重复发货)
- **风险点**：网络重试可能导致同一张订单在第三方 ERP 系统中被重复推单，导致多次发货与运费损失。
- **防护设计**：适配器强制要求幂等键：`idempotencyKey = ERP_CREATE_ORDER:${orderId}`。推单前在 `erp_sync_tasks` 中记录状态，若已有 `SYNCED` 则直接幂等返回已存在的 ERP 外部订单号。

### 6. SAFE_SETTLEMENT (安全结算与保全)
- **风险点**：系统维护或活动紧急暂停时，用户支付成功但无法进行挑战，极易引发客诉与监管风险。
- **防护设计**：遵循预设策略 `HOLD_AND_RESUME`。暂停时自动冻结该挑战的有效期计时，等系统恢复后允许用户按原来的规则版本无损继续挑战；若达到最终终止条件，则走合规保障结算方案。

### 7. 活动熔断 (Circuit Breaker)
- **风险点**：若发生群体作弊脚本或参数配置失误导致 WIN 率骤升至 80%+，企业面临瞬间资金穿底。
- **防护设计**：`complianceMonitor` 实时计算过去 50~100 单的滚动 WIN 率，一旦超过设定阈值（如偏差超过目标 $\pm 10\%$）或单日免单预算触顶，系统自动触发熔断将 `activities.status` 切为 `PAUSED`，停止发放新挑战资格。

### 8. 风险审核 (Human-in-the-Loop)
- **风险点**：因弱网造成的 `PENDING_REVIEW` 订单若被遗忘，会导致订单既不发货也不退款。
- **防护设计**：管理后台设专门的“风险待审”红点角标队列。管理员可查看客户端上传的网络类型、系统上报时间线、单调耗时差。审核通过则转 WIN 并发起退款，审核判定作弊则按规则转 LOSE 并正常发货，每个操作均写入 `risk_logs`。

### 9. 财务成本模型 (Unit Economics Tracking)
- **风险点**：忽视正向包邮运费、包装破损、逆向退货物流成本对真实利润的侵蚀。
- **防护设计**：后台内置精确数学模型：
  $$\text{Revenue} = N \times P \times (1-W) \times (1-R)$$
  $$\text{Profit} = \text{Revenue} - N(C_g + C_o) - N(1-W)R \cdot C_r - N \cdot C_p - N \cdot C_c + N(1-W)R \cdot C_g \cdot S$$
  后台运营直接输入当前采购价与履约费用，系统毫秒级测算单均贡献 $ContributionPerPaidOrder$。
