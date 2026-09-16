# 数据模型变更与状态机解耦说明 (DATA_MODEL_CHANGES)

## 1. 废弃与禁止项 (Strict Anti-Patterns)

- ❌ **严禁篡改原订单主状态机**：
  - 严禁把 `order.status` 改写为 `WINNER_REFUNDED` 或其它非原生电商状态。
  - 原订单主状态机保持严谨定义：
    - `PENDING_PAYMENT` (待付款)
    - `PENDING_DELIVERY` (待发货)
    - `PENDING_RECEIPT` (待收货)
    - `COMPLETE` (已完成)
    - `CLOSED` (已关闭)
- ❌ **严禁将挑战退款写入 `after-service`**：
  - 废弃向 `after-service` 表注入假售后单的做法。
- ❌ **严禁布尔型 `fulfillmentHold`**：
  - 取消 `fulfillmentHold: true/false`，全面替换为严格枚举。

---

## 2. 订单表 (order 集合) 新增与改造字段

| 字段名 | 类型 | 取值范围 / 枚举 | 作用与生命周期说明 |
| :--- | :--- | :--- | :--- |
| `status` | String | `PENDING_PAYMENT`, `PENDING_DELIVERY`, `PENDING_RECEIPT`, `COMPLETE`, `CLOSED` | **原订单主状态机**，不可被玩法污染 |
| `challengeEligible` | Boolean | `true`, `false` | 是否具备 3 秒挑战免单资格（支付完成后置为 true） |
| `challengeStatus` | String | `NONE`, `ELIGIBLE`, `IN_PROGRESS`, `WIN`, `LOSE`, `PENDING_REVIEW`, `INTERRUPTED` | **挑战独立玩法状态** |
| `challengeRefundStatus`| String | `NONE`, `PENDING`, `SUCCESS`, `FAILED` | **免单专属退款状态** |
| `fulfillmentHold` | String (Enum) | `NONE`, `CHALLENGE_PENDING`, `REFUND_PENDING`, `SAFE_SETTLEMENT` | **履约暂扣状态**（仅为 `NONE` 时允许发货） |
| `erpStatus` | String | `HOLD`, `READY`, `SYNCED`, `FAILED` | **ERP 推单状态**（仅在 `READY` 且 hold 为 `NONE` 时允许推送） |
| `settlementReason` | String | `USER_SKIPPED`, `TIMEOUT`, `NORMAL` | 结算原因标记（如用户主动跳过） |
| `challengeRefundInfo` | Object | `{ refundId, outRefundNo, amountYuan, successTime }` | 免单退款成功凭据快照 |

---

## 3. 新建挑战规则表 (challenge_rules 集合)

```json
{
  "_id": "RULE_3S_TEST_V1",
  "ruleId": "RULE_3S_TEST_V1",
  "gameType": "THREE_SECOND_HOLD",
  "ruleVersion": "TEST_V1",
  "targetTimeMs": 3000,
  "successMinMs": 2990,
  "successMaxMs": 3010,
  "maxRoundDurationMs": 10000,
  "timingToleranceMs": 1000,
  "negativeToleranceMs": 100,
  "status": "ACTIVE",
  "effectiveFrom": 0,
  "effectiveTo": 4102444800000,
  "createdAt": 1773648000000,
  "updatedAt": 1773648000000
}
```

---

## 4. 挑战会话表 (challenge_session 集合) 改造

```json
{
  "_id": "cs_order_123_1773648000000",
  "orderId": "order_123",
  "_openid": "user_openid_abc",
  "activityMode": "TEST",
  "challengeStatus": "IN_PROGRESS",
  "ruleSnapshot": {
    "ruleId": "RULE_3S_TEST_V1",
    "gameType": "THREE_SECOND_HOLD",
    "ruleVersion": "TEST_V1",
    "targetTimeMs": 3000,
    "successMinMs": 2990,
    "successMaxMs": 3010,
    "maxRoundDurationMs": 10000,
    "timingToleranceMs": 1000,
    "negativeToleranceMs": 100
  },
  "serverStartResponseSentAt": 1773648001000,
  "latestTicketNonce": "8f3b21...",
  "attempts": 0,
  "maxAttempts": 1,
  "result": {
    "clientElapsedMs": 3002,
    "serverStartResponseSentAt": 1773648001000,
    "serverFinishRequestReceivedAt": 1773648004020,
    "serverObservedDurationMs": 3020,
    "timingDeltaMs": 18,
    "diffMs": 2,
    "isWinner": true,
    "ruleVersion": "TEST_V1",
    "riskLevel": "NORMAL"
  },
  "settledTime": 1773648004050,
  "createdAt": 1773648001000,
  "updatedAt": 1773648004050
}
```

---

## 5. 新建专属退款表 (refunds 集合)

```json
{
  "_id": "rf_order_123_1773648005000",
  "orderId": "order_123",
  "sourceType": "CHALLENGE_FREE_ORDER",
  "outRefundNo": "RF_CHALLENGE_1773648005000_123456",
  "amount": 3980,
  "amountYuan": "39.80",
  "status": "SUCCESS",
  "wechatRefundId": "wx_rf_500021389",
  "errorCode": null,
  "errorMessage": null,
  "testMode": true,
  "createdAt": 1773648005000,
  "updatedAt": 1773648005500
}
```
