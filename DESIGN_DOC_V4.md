# Phase 4 系统架构与状态机设计规范 (DESIGN_DOC_V4.md)

本文档定义了免单挑战商城 Phase 4 的权威系统架构、资金安全规范、时序校验模型与异常容灾体系。

---

## 1. 核心状态机与履约暂扣模型 (State Machine & Fulfillment Hold)

系统引入了三层正交状态机，保障资金与履约在任何极端情况下不出现单边账或提前发货：

```text
[支付完成] ──> Order.challengeStatus = ELIGIBLE
               Order.fulfillmentHold = CHALLENGE_PENDING
               Order.erpStatus = HOLD
                      │
           ┌──────────┴──────────┐
           ▼                     ▼
     [发起挑战]              [放弃挑战(Skip)]
           │                     │
           │ (startSession)      │ (handleSkipChallenge)
           ▼                     ▼
Session.challengeStatus    Order.challengeStatus = LOSE
    = IN_PROGRESS          Order.challengeEligible = false
           │               Order.fulfillmentHold = NONE
           │               Order.erpStatus = READY
           ▼
[客户端松开并提交]
           │ (CAS 乐观锁抢锁)
           ▼
Session.challengeStatus = SETTLING (互斥结算保护)
           │
           │ (Hybrid Timing & Risk 评估)
           │
     ┌─────┴─────────────────────┬─────────────────────┐
     ▼                           ▼                     ▼
   [WIN]                       [LOSE]           [PENDING_REVIEW]
     │                           │                     │
  事务写入:                   事务写入:             事务写入:
  - Session: WIN              - Session: LOSE       - Session: PENDING_REVIEW
  - Order: WIN                - Order: LOSE         - Order: PENDING_REVIEW
  - Hold: REFUND_PENDING      - Hold: NONE          - Hold: SAFE_SETTLEMENT
  - Refunds: PENDING          - ERP: READY          - ERP: HOLD
  - Tasks: PENDING
     │
 触发退款网关派发
     │
┌────┴────────────┐
▼                 ▼
[退款成功]       [退款失败/重试]
- Hold: NONE      - Hold: REFUND_PENDING (继续锁定)
- ERP: READY      - Tasks: RETRY / DEAD_LETTER
```

---

## 2. 确定性退款凭证与幂等体系 (Deterministic Refund IDs)

为彻底消灭重复退款风险与单号漂移，统一使用确定性键：
- **`refundDocId`**: `CHALLENGE_REFUND_${orderId}`
- **`outRefundNo`**: `CR_${orderId}`
- **`refundTaskId`**: `REFUND_TASK_${orderId}`

### 幂等保障：
1. **退款单据生成幂等**：一单仅允许生成唯一确定的退款单据。
2. **回调防倒退**：`refundCallback` 收到通知时，若该单据在本地数据库已为 `SUCCESS`，迟到的任何失败或未知通知均被直接忽略，绝不允许倒退修改已成功的退款终态。
3. **退款成功才释放发货**：只有在微信支付明确返回成功（或测试模式下模拟成功）后，`fulfillmentHold` 才被置为 `NONE`，`erpStatus` 才被置为 `READY`。

---

## 3. 会话容灾与异常恢复机制 (`challengeRecovery`)

`cloudfunctions/challengeRecovery` 作为专职运维调度器（可通过云开发定时触发器每 1 分钟执行一次）：

1. **`recoverSettlingSessions`**：
   - 检索 `challengeStatus === "SETTLING"` 且已持续超过 60 秒的异常滞留会话；
   - 检查关联订单是否已有终态裁决：若有，同步会话至终态；
   - 若关联订单尚未终结：
     - 若 `resumeCount < maxResumeCount`：回滚为 `READY_TO_RESTART`，清空 `serverStartResponseSentAt` 和旧 Nonce，让用户在稳定网络下重新发起；
     - 若重试机会已耗尽：会话及订单转入 `PENDING_REVIEW`，`fulfillmentHold` 设为 `SAFE_SETTLEMENT`，待客服核实。

2. **`processRefundTasks`**：
   - 检索状态为 `PROCESSING` 或 `RETRY` 的退款任务；
   - 对超期滞留任务主动调用微信支付退款查询接口，若微信侧已成功则主动推进订单解锁；
   - 对失败任务按指数退避策略执行重试，达到最大重试次数（5次）后标记为 `DEAD_LETTER` 并发出报警通知，绝不擅自释放发货锁。

---

## 4. 结论与真机测试标准

通过本轮修复，系统已实现：
1. **资金安全闭环**：服务端权威计价、退款前履约绝对锁定、单商品单件严格防套利；
2. **状态机强一致性**：基于数据库事务的原子状态流转、CAS 排他结算、确定性单据体系；
3. **高可用容灾能力**：超时自动回滚与自动对账补救。

项目已达到：**`READY_FOR_DEVICE_TEST_MODE = YES`**，可正式进入真机数据采集与测试校准阶段。
