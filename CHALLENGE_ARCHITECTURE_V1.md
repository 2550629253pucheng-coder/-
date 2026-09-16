# 3秒挑战免单核心架构规范 (CHALLENGE_ARCHITECTURE_V1)

## 1. 核心架构哲学与设计原则

1. **商品即正义**：用户支付购买的是高频真实日用商品（抽纸、垃圾袋、洗衣液等），挑战免单是附加营销激励，无论成败履约发货不受阻（除非获胜退款过程中暂扣）。
2. **零前端信任 (Zero-Trust Client)**：
   - 规则判断、判定毫秒差值、风控审计、单号绑定、退款执行全部在服务端云函数原子完成。
   - `HMAC_SECRET` 绝对只在服务端内存与环境变量中持有，绝不写入小程序前端。
   - 客户端只能原样传递由服务端签发的 `Ticket`，任何篡改均被阻断。
3. **主订单状态机严格解耦**：
   - 严禁篡改原电商主状态机 `order.status`（`PENDING_PAYMENT` -> `PENDING_DELIVERY` -> `PENDING_RECEIPT` -> `COMPLETE`）。
   - 严禁出现 `WINNER_REFUNDED` 污染主状态。
   - 新增独立正交状态集：`challengeStatus`、`challengeRefundStatus`、`fulfillmentHold`、`erpStatus`。
4. **履约暂扣强校验**：
   - `fulfillmentHold` 升级为严密枚举值：`NONE` | `CHALLENGE_PENDING` | `REFUND_PENDING` | `SAFE_SETTLEMENT`。
   - 仓储发货与 ERP 推单必须强校验 `fulfillmentHold === 'NONE'`，只要处于暂扣态，发货全链路阻断。

---

## 2. 规则配置化与版本锁定 (challenge_rules)

取消硬编码 `±10ms`，改由规则配置化驱动：

```json
{
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
  "effectiveTo": 4102444800000
}
```

### 规则版本锁定机制 (Rule Snapshotting)
- 在 `challengeStart` (即 `startSession`) 创建会话时，锁定当前生效规则的 `ruleSnapshot` 存入 `challenge_session`。
- 最终结果判定**只能**按照当前挑战创建时绑定的 `ruleSnapshot` 进行，后台后续的规则更新绝不影响已生成的在途挑战。

---

## 3. Hybrid Timing 混合计时架构

为了兼顾弱网网络延迟并杜绝客户端时间欺诈，采用单调时钟与服务端双向打点：

### 客户端单调计时 (Monotonic Timing)
- 使用 `wx.getPerformance().now()` 采集单调递增高精度时间戳，防范用户修改手机系统时钟或时区引发的时钟跃变。
- 采集：
  - `clientStartMonotonic`
  - `clientStopMonotonic`
  - `clientElapsedMs = clientStopMonotonic - clientStartMonotonic`
- 上报 `deviceInfo`（系统基准分、机型）与 `networkInfo`（WiFi / 5G 等）。

### 服务端高精度时钟 (Server Monotonic Clock)
- `serverStartResponseSentAt`：服务端签发 Ticket 并返回给客户端时刻的时间戳 (ms)。
- `serverFinishRequestReceivedAt`：服务端第一时间接收到客户端提交请求的时间戳 (ms)。
- 计算服务端观测耗时与时差偏差：
  - `serverObservedDurationMs = serverFinishRequestReceivedAt - serverStartResponseSentAt`
  - `timingDeltaMs = serverObservedDurationMs - clientElapsedMs`

---

## 4. 签名 Ticket 防篡改机制

- 仅服务端持有 `CHALLENGE_HMAC_SECRET`。
- `challengeStart` 颁发 Ticket：
  ```javascript
  const payloadStr = `${challengeId}:${orderId}:${openid}:${ruleVersion}:${nonce}:${issuedAt}:${maxRoundDurationMs}`;
  const signature = HMAC_SHA256(payloadStr, CHALLENGE_HMAC_SECRET);
  const ticket = { challengeId, orderId, openid, ruleVersion, nonce, issuedAt, maxRoundDurationMs, signature };
  ```
- 客户端提交时必须回传该 Ticket。服务端二次校验 signature，防止伪造任意参数。

---

## 5. 风控与异常审计 (Risk Assessment)

服务端比对 `timingDeltaMs` 与规则容差：
- `timingToleranceMs`: 1000ms（测试模式容忍阈值）
- `negativeToleranceMs`: 100ms（物理容差）

### 判定分支：
1. **可疑异常 (SUSPICIOUS)**：
   - 若 `clientElapsedMs > maxRoundDurationMs`，或 `timingDeltaMs < -negativeToleranceMs`（客户端耗时竟然大于服务端整个往返耗时），或 `|timingDeltaMs| > timingToleranceMs`。
   - **绝对不直接判 LOSE！**
   - 流转为 `challengeStatus = "PENDING_REVIEW"`, `riskLevel = "SUSPICIOUS"`, `fulfillmentHold = "SAFE_SETTLEMENT"`, `erpStatus = "HOLD"`。
   - 挂起人工审计或待风控复核，避免因网络抖动误杀真实用户。
2. **正常规则判定 (NORMAL)**：
   - 若 `successMinMs <= clientElapsedMs <= successMaxMs`：判定为 `WIN`。
   - 否则：判定为 `LOSE`。

---

## 6. 中断与恢复机制 (Interrupted / Resume)

- 针对客户端网络断开、App 意外切到后台或系统奔溃：
  - 上报 `recordInterrupted`，状态转为 `challengeStatus = "INTERRUPTED"`。
  - **绝不判定为 LOSE**，保留用户的挑战权益。
  - 用户重新进入页面可触发 `challengeResume`，在未超时范围内重新签发 Ticket 恢复计时。

---

## 7. 测试模式 (TEST_MODE)

- `ACTIVITY_MODE = "TEST"`
- 在 TEST 模式下：
  - 完整走通 Challenge 挑战、成绩记录、数据收集、风控审计、WIN/LOSE 结果。
  - 记录真实数据：`clientElapsedMs`、`serverObservedDurationMs`、`timingDeltaMs`、`deviceInfo`、`networkInfo`、`ruleVersion`、`riskLevel`。
  - 模拟退款流转（更新 `refunds` 集合但调过真实微信退款扣款，标记 `testMode: true`），模拟 ERP READY 但不发送第三方推送。
  - 满足首期 100~300 次真实按压数据收集与时钟基线校准。
