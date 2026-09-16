# Phase 2 核心架构纠偏与稳健性全链路验收测试报告 (TEST_REPORT)

## 1. 测试综述

- **测试执行环境**：Node.js v20.x, CloudBase Mock Runtime
- **测试脚本位置**：`scripts/test-phase2-architecture-verification.cjs`
- **执行时间**：2026-09-16
- **总测试场景数**：10 大核心业务与异常场景
- **断言总数**：44 项严格状态机与边界断言
- **测试结果**：**44 PASS / 0 FAIL (通过率 100%)**

---

## 2. 场景化详细执行明细

| 场景编号 | 场景名称 | 关键输入与触发动作 | 预期行为与核心断言 | 校验结果 |
| :--- | :--- | :--- | :--- | :--- |
| **Scenario 1** | 正常 LOSE 流程 | 用户按压 3250ms (超出成功区间)，提交结果 | 1. 结果判为 `LOSE`<br>2. 订单主状态保持 `PENDING_DELIVERY`<br>3. `fulfillmentHold = 'NONE'` 立即释放<br>4. `erpStatus = 'READY'`<br>5. 不生成任何退款单据 | **PASS** (6/6 断言通过) |
| **Scenario 2** | 正常 WIN 流程与退款前禁止发货 | 用户按压 3004ms 命中目标，提交结果 | 1. 结果判为 `WIN`<br>2. 订单主状态保持 `PENDING_DELIVERY`<br>3. 履约进入 `REFUND_PENDING` 严格暂扣<br>4. `erpStatus = 'HOLD'`<br>5. 调用发货接口强行拦截阻断 | **PASS** (6/6 断言通过) |
| **Scenario 3** | 微信退款成功回调 (refundCallback SUCCESS) | 接收微信退款成功异步通知 | 1. `refund.status = 'SUCCESS'`<br>2. `challengeRefundStatus = 'SUCCESS'`<br>3. `fulfillmentHold = 'NONE'` 解锁<br>4. `erpStatus = 'READY'`<br>5. 订单发货接口顺畅通过 | **PASS** (5/5 断言通过) |
| **Scenario 4** | 退款失败 (refundCallback FAILED) 防漏发拦截 | 模拟第三方支付账户余额不足或退款失败 | 1. `refund.status = 'FAILED'`<br>2. `challengeRefundStatus = 'FAILED'`<br>3. `fulfillmentHold` 继续保持 `REFUND_PENDING`<br>4. `erpStatus = 'HOLD'`<br>5. 发货依然被严密拦截阻断 | **PASS** (5/5 断言通过) |
| **Scenario 5** | 网络/系统异常中断 (INTERRUPTED) 与恢复 | 挑战中发生网络闪断，上报技术异常后恢复 | 1. 状态转为 `INTERRUPTED`，绝不判为 LOSE<br>2. 调用 `challengeResume` 重新下发有效 Ticket<br>3. 恢复后正常挑战并顺利判定 | **PASS** (3/3 断言通过) |
| **Scenario 6** | 用户主动跳过 (USER_SKIPPED) | 用户弹窗二次确认放弃挑战 | 1. `challengeStatus = 'LOSE'`<br>2. 标记原因 `USER_SKIPPED`<br>3. `fulfillmentHold = 'NONE'` 立即释放<br>4. 订单直接放行发货 | **PASS** (5/5 断言通过) |
| **Scenario 7** | Timing Delta 异常风控拦截 (PENDING_REVIEW) | 伪造篡改计时（总网络耗时 200ms 报按压 3000ms） | 1. 命中异常时钟漂移，自动进入 `PENDING_REVIEW`<br>2. 不得自动判 LOSE 或 WIN<br>3. 履约置为 `SAFE_SETTLEMENT`<br>4. 发货与推单全部被拦截 | **PASS** (5/5 断言通过) |
| **Scenario 8** | 重复 challengeFinish 提交幂等性 | 对已结算会话发起重复提交 | 1. 识别已结算终态<br>2. 幂等拦截，保持首次结果不变<br>3. 无二次副作用 | **PASS** (3/3 断言通过) |
| **Scenario 9** | 重复 refundCallback 回调幂等性 | 微信支付发送重复的退款成功通知 | 1. 识别 `refund.status === 'SUCCESS'`<br>2. 幂等放行并返回，杜绝重复处理 | **PASS** (2/2 断言通过) |
| **Scenario 10** | fulfillmentHold 全枚举发货防呆 | 遍历 `CHALLENGE_PENDING`, `REFUND_PENDING`, `SAFE_SETTLEMENT`, `NONE` | 1. 前三类非 NONE 状态 100% 阻断发货与提货<br>2. 唯有 `NONE` 状态允许履约 | **PASS** (4/4 断言通过) |

---

## 3. 架构纠偏结论

1. **原订单主状态机完好保护**：所有电商主链路订单状态全部严格保持标准状态机（`PENDING_DELIVERY` 等），彻底清除了 `WINNER_REFUNDED` 脏状态。
2. **免单与售后彻底解耦**：免单全额返款已完全转移至专属 `refunds` 集合（`sourceType = 'CHALLENGE_FREE_ORDER'`），普通消费者售后业务无任何混淆。
3. **退款前禁止发货得到铁律保障**：只要退款未返回明确的 `SUCCESS`，`fulfillmentHold` 始终为 `REFUND_PENDING`，阻断发货和 ERP 推单。
4. **时钟安全性显著增强**：服务端持有唯一 `HMAC_SECRET`，通过单调时钟结合服务端双向耗时审计，可疑时钟自动进入 `PENDING_REVIEW`，杜绝任何前端作弊。
