# 3秒免单退款流与履约解耦规范 (REFUND_FLOW_V1)

## 1. 架构原则：Challenge 免单不是售后

- **本质区别**：
  - 普通售后（`after-service`）：由于商品破损、质量问题、发货错误等由消费者发起的逆向退换货诉求。
  - 免单退款（`refunds`）：基于业务游戏玩法的履约全额返款营销事件。
- **拆分要求**：
  - 彻底废除向 `after-service` 写入 `CHALLENGE_WIN_REFUND` 的错误做法。
  - 新建专属 `refunds` 集合独立管理退款单据，支持 `sourceType = "CHALLENGE_FREE_ORDER"`。

---

## 2. 专属退款数据模型 (refunds 集合)

```typescript
interface RefundRecord {
  refundId: string;            // 退款记录主键
  orderId: string;             // 关联业务订单ID
  sourceType: "CHALLENGE_FREE_ORDER" | "AFTER_SALE"; // 退款业务来源
  outRefundNo: string;         // 商户系统内部唯一退款单号 (如 RF_CHALLENGE_xxx)
  amount: number;              // 退款金额 (单位: 分)
  amountYuan: string;          // 退款金额 (单位: 元，如 "39.80")
  status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED"; // 退款单状态
  wechatRefundId: string | null; // 微信退款单号
  errorCode: string | null;    // 错误码
  errorMessage: string | null; // 错误信息
  testMode: boolean;           // 是否为测试模式模拟退款
  createdAt: number;           // 创建时间戳
  updatedAt: number;           // 更新时间戳
}
```

---

## 3. WIN 与退款状态机全链路

```text
       [挑战提交 challengeFinish]
                 │
                 ▼
         判定获胜 isWinner = true
                 │
                 ├── 订单 challengeStatus = 'WIN'
                 ├── 订单 challengeRefundStatus = 'PENDING'
                 ├── 订单 fulfillmentHold = 'REFUND_PENDING' (必须锁定!)
                 └── 订单 erpStatus = 'HOLD' (禁止推单发货!)
                 │
                 ▼
     [创建 refunds 退款单]
     (sourceType: 'CHALLENGE_FREE_ORDER', status: 'PENDING')
                 │
                 ▼
      [调用微信退款 API / TEST模式模拟]
                 │
                 ├── 异步处理中 (仓储发货尝试 -> 强阻断!)
                 │
                 ▼
       [退款回调 refundCallback]
                 │
        ┌────────┴────────┐
        ▼                 ▼
   [SUCCESS 成功]     [FAILED 失败]
        │                 │
        ├── refund.status = 'SUCCESS'     ├── refund.status = 'FAILED'
        ├── challengeRefundStatus = 'SUCCESS' ├── challengeRefundStatus = 'FAILED'
        ├── fulfillmentHold = 'NONE'      ├── fulfillmentHold = 'REFUND_PENDING' (保持锁定!)
        └── erpStatus = 'READY'           └── erpStatus = 'HOLD' (禁止发货!)
        │
        ▼
   [允许 ERP 推单与仓储正常发货]
```

---

## 4. LOSE 与用户跳过状态机

### A. 挑战失败 (LOSE)
```text
challengeFinish -> LOSE
↓
challengeStatus = 'LOSE'
challengeRefundStatus = 'NONE'
fulfillmentHold = 'NONE' (立刻释放暂扣)
erpStatus = 'READY'
(不创建退款单，商品正常进入拣选发货流程)
```

### B. 用户主动跳过 (USER_SKIPPED)
```text
用户点击跳过并二次确认
↓
challengeStatus = 'LOSE'
settlementReason = 'USER_SKIPPED'
fulfillmentHold = 'NONE' (立刻释放暂扣)
erpStatus = 'READY'
(不创建退款单，商品正常进入拣选发货流程)
```

---

## 5. 幂等性与并发防护规范

1. **提交挑战幂等**：
   - 会话一经结算（`WIN` / `LOSE` / `PENDING_REVIEW`），后续重复调用 `submitChallenge` 直接返回既有结算结果，绝不产生二次退款或改写状态。
2. **退款回调幂等**：
   - 收到微信退款回调通知时，若 `refund.status === 'SUCCESS'`，直接返回成功并中断后续动作，防止重复执行订单解冻或更新。
3. **退款失败防漏发**：
   - 退款失败时，`fulfillmentHold` 必须持续保持为 `REFUND_PENDING`，严禁在未成功退款的情况下自动发货，保障商家财务安全与免单体验一致性。
