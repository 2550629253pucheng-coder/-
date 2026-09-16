# 3秒挑战免单系统状态机与履约控制全景规格 (State Machine V2)

**规范版本**: V2.0 (生产锁定版)  
**目标原则**: 主订单状态机绝不受污染，履约暂扣状态正交解耦，终态严格单向不可篡改。

---

## 一、三层正交状态机设计理念

为了确保电商交易主干、免单活动挑战、以及仓储 ERP 履约发货互不干扰，系统采用三层正交分离状态：

1. **电商订单主状态 (`order.status`)**:
   - `PENDING_PAYMENT` (待支付)
   - `PENDING_DELIVERY` (待发货 —— 无论免单挑战成功与否，只要用户已付钱且要收货，主状态均保持 `PENDING_DELIVERY`)
   - `PENDING_RECEIPT` (待收货)
   - `COMPLETE` (已完成)
   - `CANCELED` (已取消)

2. **挑战活动状态 (`challengeStatus`) 与退款状态 (`challengeRefundStatus`)**:
   - `challengeStatus`:
     - `ELIGIBLE`: 订单已付款，具备挑战资格，尚未启动。
     - `IN_PROGRESS`: 用户点击【开始挑战】，时钟与防作弊 Ticket 已激活。
     - `WIN`: 挑战用时精准落在规则区间内，免单达成。
     - `LOSE`: 挑战用时超出区间，或用户主动跳过（`USER_SKIPPED`）。
     - `PENDING_REVIEW`: 时钟严重漂移、违背因果律或频繁中断，转入人工风控审计。
     - `INTERRUPTED`: 网络断连、小程序意外切出等偶发技术中断，保护资格。
     - `EXPIRED`: 超过活动有效挑战期未参与。
   - `challengeRefundStatus`:
     - `NONE`: 无免单退款（如 LOSE 或普通商品）。
     - `PENDING`: 挑战 WIN，退款单已创建，等待提交微信支付。
     - `PROCESSING`: 微信退款受理中。
     - `SUCCESS`: 微信退款成功到账。
     - `FAILED`: 微信退款异常或失败。

3. **履约暂扣锁 (`fulfillmentHold`) 与 ERP推单状态 (`erpStatus`)**:
   - `fulfillmentHold`:
     - `NONE`: 无暂扣，仓库正常打单、配货、出库。
     - `CHALLENGE_PENDING`: 挑战进行中，禁止仓储发货。
     - `REFUND_PENDING`: 免单已获胜，但在退款真实成功前，严格禁止仓储发货！
     - `SAFE_SETTLEMENT`: 风控异常审查中暂扣。
   - `erpStatus`:
     - `HOLD`: 暂扣中，禁止将订单推送到 ERP。
     - `READY`: 条件全部满足（LOSE直接放行，WIN则退款成功后放行），可安全推送 ERP。
     - `SYNCED`: ERP 已成功拉取并创建下游出库单。

---

## 二、状态转移白名单矩阵 (Allowed Transitions)

由 `cloudfunctions/manageChallenge/lib/stateMachine.js` 强制断言：

```
                    ┌──────────────┐
                    │   ELIGIBLE   │
                    └──────┬───────┘
                           │ (challengeStart)
                           ▼
                    ┌──────────────┐◄───────┐ (challengeResume
                    │ IN_PROGRESS  │        │  resumeCount <= max)
                    └──────┬───────┘────────┘
                           │
       ┌───────────────────┼───────────────────┬──────────────────┐
       │ (Hit Rule)        │ (Miss Rule)       │ (Anomaly / Drift)│ (Network Err)
       ▼                   ▼                   ▼                  ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐   ┌──────────────┐
│     WIN      │    │     LOSE     │    │PENDING_REVIEW│   │ INTERRUPTED  │
└──────────────┘    └──────────────┘    └──────────────┘   └──────────────┘
  (终态·不可逆)       (终态·不可逆)       (风控队列锁存)      (仅允许恢复或过期)
```

### 转移白名单定义：
- **`ELIGIBLE`** 允许转移至: `IN_PROGRESS`, `LOSE` (用户主动放弃), `EXPIRED`
- **`IN_PROGRESS`** 允许转移至: `WIN`, `LOSE`, `PENDING_REVIEW`, `INTERRUPTED`, `EXPIRED`
- **`INTERRUPTED`** 允许转移至: `IN_PROGRESS` (受 `resumeCount` 约束), `PENDING_REVIEW`, `EXPIRED`
- **`WIN`**: **终态**，禁止转移（同态幂等放行）。
- **`LOSE`**: **终态**，禁止转移（同态幂等放行）。
- **`PENDING_REVIEW`**: 仅限管理员/风控脚本处理，客户端接口禁止篡改。
- **`EXPIRED`**: **终态**，禁止恢复。

---

## 三、履约门禁裁决表 (Fulfillment Gate Matrix)

在订单发货接口及 ERP 推单服务中，必须前置检查 `fulfillmentHold`：

| 场景 | challengeStatus | challengeRefundStatus | fulfillmentHold | erpStatus | 发货动作响应 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **未开始挑战** | `ELIGIBLE` | `NONE` | `CHALLENGE_PENDING` | `HOLD` | ❌ 拦截：等待挑战完成 |
| **挑战进行中** | `IN_PROGRESS` | `NONE` | `CHALLENGE_PENDING` | `HOLD` | ❌ 拦截：正在挑战中 |
| **挑战失败 (LOSE)** | `LOSE` | `NONE` | `NONE` | `READY` | ✅ 放行：商品正常发货 |
| **主动跳过 (SKIP)** | `LOSE` | `NONE` | `NONE` | `READY` | ✅ 放行：商品正常发货 |
| **挑战成功 (WIN)** | `WIN` | `PENDING` / `PROCESSING` | `REFUND_PENDING` | `HOLD` | ❌ 拦截：退款未完成严禁发货！ |
| **退款成功到账** | `WIN` | `SUCCESS` | `NONE` | `READY` | ✅ 放行：款项已退，免单商品正常发货 |
| **退款失败报错** | `WIN` | `FAILED` | `REFUND_PENDING` | `HOLD` | ❌ 拦截：资金未闭环，阻断发货转人工 |
| **风控复核挂起** | `PENDING_REVIEW` | `NONE` | `SAFE_SETTLEMENT` | `HOLD` | ❌ 拦截：异常订单安全锁存 |
