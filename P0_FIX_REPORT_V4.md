# Phase 4 P0 核心安全与交易闭环修复报告 (P0_FIX_REPORT_V4.md)

**当前状态评估：`READY_FOR_DEVICE_TEST_MODE = YES`**  
本阶段（Phase 4）全面严格按照生产级资金安全与高并发状态机一致性规范，对免单挑战商城进行了端到端核心安全修复，所有 10 项核心自动化集成测试 100% 通过。

---

## 一、本次修复的核心问题与落地架构

### 1. Challenge 结算真正事务化 (`runWithTransaction`)
- **根因分析**：旧版结算逻辑中，更新 `challenge_sessions`、更新 `orders`、写入 `refunds` 与 `refund_tasks` 分布在多个独立的数据库调用中。若中间发生网络抖动或超时，会导致订单状态已变为 `WIN` 但退款未排队，或 Session 状态更新失败但订单被扣除资格。
- **修复方案**：
  - 在 `cloudfunctions/manageChallenge/index.js` 中封装了 `runWithTransaction(db, txHandler)`，原生支持 CloudBase 事务 `db.startTransaction()`，并具备针对开发/轻量环境的优雅回退与一致性保障。
  - 在 `handleSubmitChallenge` 中，将 **Session 状态终态推进**、**Order 状态/履约锁推进**、**Refunds 记录写入**、**RefundTasks 队列写入** 四大动作全部包进同一个事务上下文内。
  - 只有当事务完全 Commit 成功后，才触发外部异步退款派发流程，彻底消除了中间状态漂移。

### 2. SETTLING 状态防重入与卡死容灾恢复引擎 (`challengeRecovery`)
- **根因分析**：在高并发或客户端重复上报场景下，若无原子互斥锁，会导致多次触发结算；若结算过程中云函数发生不可恢复的崩溃或宿主超时，会话可能永久滞留在 `SETTLING` 状态。
- **修复方案**：
  - **CAS 互斥推进**：通过 `where({ challengeStatus: 'IN_PROGRESS' }).update({ challengeStatus: 'SETTLING' })` 进行乐观排他抢锁，抢锁失败的请求直接返回幂等结算中提示或已有终态结果。
  - **专职恢复 Worker (`cloudfunctions/challengeRecovery`)**：
    - 定期扫描滞留在 `SETTLING` 状态超过 60 秒的会话。
    - 若关联订单已处于终态，自动同步 Session；若订单仍在等待，根据 `resumeCount` 与 `maxResumeCount`，将可恢复会话安全回滚至 `READY_TO_RESTART` 并作废所有时序凭证，若已耗尽重试次数则转入 `PENDING_REVIEW` 安全风控人工审核，坚决不让资金链悬空。

### 3. 全局统一确定性退款单号体系与单流向防死锁
- **根因分析**：散落的退款单据编号（如带随机串的 out_refund_no）会导致重试时产生多个退款单号，引发微信支付重复扣款或微信回调无法确定性关联。
- **修复方案**：
  - 建立统一确定性退款单号算法 `buildDeterministicRefundKeys({ sessionId, orderId })`：
    - 退款记录 ID: `CHALLENGE_REFUND_${orderId}`
    - 外部商户退款单号: `CR_${orderId}`
    - 退款任务 ID: `REFUND_TASK_${orderId}`
  - 在 `refundCallback` 中实现双向索引查询，优先匹配免单挑战退款，状态严格防倒退（严禁迟到的失败回调覆盖已 `SUCCESS` 的终态）。

### 4. 支付与退款网关抽象 (`paymentGateway`) 与密钥隔离
- **根因分析**：直接在业务代码内硬编码凭证或零散调用底层支付接口，存在密钥泄露风险且不利于环境隔离。
- **修复方案**：
  - 提取 `cloudfunctions/shared/paymentGateway.js` 统一门面，封装统一下单、退款、退款查询。
  - 优先调用微信官方 CloudBase 集成支付模块（免密钥云端直连），同时支持环境变量与测试桩模式，严格禁止任何明文秘钥进入代码仓库。

### 5. Order 商品数据服务端 Canonical 化（彻底防客户端篡改）
- **根因分析**：旧版 `createOrder` 依赖客户端传入的商品标题与价格计算应付金额，攻击者可抓包篡改 `price: 1` 仅付 1 分钱即可下单套利。
- **修复方案**：
  - 客户端仅允许提供 `skuId` 和 `quantity`。
  - 服务端在 `createOrder` 中强制根据 `skuId` 查数据库 `goods_sku` 与 `goods_spu`，获取权威定价与活动标记，由服务端独立计算商品总额、运费与应付金额。
  - 强行校验单活动商品、单件限购防套利规则。

### 6. 支付成功时规则快照冻结（订单级不可篡改规则）
- **根因分析**：若游戏规则直接读取当前全局后台配置，当运营在后台修改容差范围时，老订单挑战可能使用新规则，导致规则漂移与客诉争议。
- **修复方案**：
  - 在 `paymentCallback` 中，订单支付成功时，冻结当前生效的完整 `challengeRuleSnapshot` 到 `order` 文档中。
  - 挑战发起 `handleStartSession` 强制读取 `order.challengeRuleSnapshot`，终生与订单绑定，不受后续运营全局调整影响。

### 7. Skip 放弃挑战与 Session 事务原子清退
- **根因分析**：用户主动跳过挑战时，若仅更新 Order 未更新 Session，已有的 Session 依然可能被恶意调用提交挑战结果。
- **修复方案**：
  - 在 `runWithTransaction` 事务中，原子性地将 `order` 与 `challenge_session` 同步置为 `LOSE` 并打上 `USER_SKIPPED` 标记，永久设置 `challengeEligible: false`，释放 `fulfillmentHold` 解锁正常仓储发货。

---

## 二、10 项核心自动化集成测试验证结果

测试脚本：`test/integration.test.cjs`

| 序号 | 测试项 | 验证内容 | 结果 |
| :--- | :--- | :--- | :--- |
| 1 | Canonical 商品结算 | 客户端提交伪造 1 分钱和假标题，服务端强制使用真实数据库覆盖 | **PASS** |
| 2 | 单商品单件挑战限制 | 混合购物车或多件活动商品购买时自动拒绝并报错 | **PASS** |
| 3 | 支付成功规则快照锁定 | 修改 live 全局规则，已支付订单仍严格使用支付时刻冻结的快照 | **PASS** |
| 4 | Start 检查 Order 状态 | 未支付、资格已消费、履约状态非 CHALLENGE_PENDING 坚决拒绝 | **PASS** |
| 5 | Session 与 Order 状态冲突 | Order 已结束而 Session 尝试伪造启动被拦截 | **PASS** |
| 6 | 正常 WIN 结算 | 事务中原子写入 Session, Order, Refunds, RefundTasks，履约保持锁定 | **PASS** |
| 7 | 正常 LOSE 结算 | 事务中写入 Session 与 Order，永久消费资格并释放履约发货 | **PASS** |
| 8 | SETTLING 防重入与并发阻断 | CAS 抢锁机制保证仅单次结算，并发请求安全幂等响应 | **PASS** |
| 9 | SETTLING Recovery 容灾恢复 | 超过 60s 滞留会话根据剩余次数安全回滚 READY_TO_RESTART 或转审核 | **PASS** |
| 10 | Skip 事务同步清退 | 原子清退 Order 和 Session，彻底杜绝孤立会话套利 | **PASS** |

**执行命令输出**：
```text
node test/challenge-core.test.cjs && node test/payment-and-resume.test.cjs && node test/integration.test.cjs
🎉 所有 10 项 P0 核心集成自动化测试全部 100% 验证通过！
READY_FOR_DEVICE_TEST_MODE = YES
```

---

## 三、真机 TEST_MODE 校准测试准备建议

1. **环境变量与模式推荐**：
   - `CHALLENGE_ACTIVITY_MODE = TEST`
   - `CHALLENGE_TEST_REFUND_MODE = AUTO_SUCCESS`
   - `CHALLENGE_HMAC_SECRET = <已配置生产级强密钥>`
2. **测试建议路径**：
   - 使用微信开发者工具或真机体验版，进行 100～300 次挑战：
     - 测试正常中奖与退款全链路闭环；
     - 测试未中奖即时解锁发货状态；
     - 测试中途退出、熄屏后通过恢复资格重新启动流程；
     - 观察 `refund_tasks` 与 `challenge_sessions` 数据表一致性。
