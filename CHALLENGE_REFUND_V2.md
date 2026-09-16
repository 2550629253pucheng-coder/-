# 3秒挑战免单退款链路规格说明书 (Challenge Refund V2)

**规范版本**: V2.0  
**适用模块**: `cloudfunctions/manageChallenge/lib/refund.js`, `cloudfunctions/refundCallback/index.js`

---

## 一、免单退款与普通售后的严格分流

在以往版本中，退款回调往往将所有退款混入 `after-service` 集合，这不仅污染售后退款数据，而且在财务核算、退款对账与履约解锁上引发混乱。

### 1. 独立集合与来源标识
- 挑战免单退款统一写入 `refunds` 集合；
- 单据字段 `sourceType: "CHALLENGE_FREE_ORDER"`；
- 普通售后单据保留在 `after-service` 集合（`sourceType: "AFTER_SALE"`）。

### 2. 回调引擎双支路分流结构
`cloudfunctions/refundCallback/index.js` 执行架构如下：

```
                    微信支付退款结果通知
                             │
                             ▼
                    解密出 outRefundNo / outTradeNo
                             │
                             ▼
                  查询 refunds 集合 (按 outRefundNo)
                             │
             ┌───────────────┴───────────────┐
             │ 是                            │ 否
             ▼                               ▼
  sourceType == CHALLENGE_FREE_ORDER ?     进入原有 after-service 集合查询
             │                               │
       ┌─────┴─────┐                         ▼
       │SUCCESS    │FAILED/ABNORMAL        处理普通售后退款、库存回滚
       ▼           ▼
  订单暂扣解除     保持 REFUND_PENDING
  fulfillmentHold  锁定发货，转人工
  = NONE           erpStatus = HOLD
  erpStatus=READY
```

---

## 二、确定性唯一退款单号 (Deterministic Idempotency)

为了防止并发结算或多次请求造成重复退款建单，系统采用**确定性单号生成算法**：
- **`outRefundNo`**: `CR_${orderId}`
- **`refundDocId` (`_id`)**: `CHALLENGE_REFUND_${sessionId}`

**防重复特性**:
即使网络超时重试，数据库基于 `_id` 唯一主键约束将直接拒绝重复插入；微信支付网关对于同一个商户退款单号（`out_refund_no`）也保证天然幂等。

---

## 三、退款金额不可篡改性

- **严禁前端上报金额**: 客户端在提交成绩时禁止携带任何退款金额字段；
- **服务端确定实付金**:
  云函数直接从订单中抽取已完成校验的不可变字段 `order.paidAmountCents`（或微信支付记录 `order.wechatPayInfo.totalFee`）；
  并进一步对比 `order.orderSummary.totalPayAmount`；
- 确保退还的款项 **不多一分，不少一分**，完全原路退还用户实际支付额。

---

## 四、测试模式与真实生产模式解耦

在 `cloudfunctions/manageChallenge/lib/refund.js` 与 `index.js` 中：
- **生产模式 (`ACTIVITY_MODE=LIVE`)**:
  挑战成功后创建 `refunds` 记录（状态为 `PROCESSING`），调用微信真实退款 API（`cloud.cloudPay.refund`）。此时订单严格保持 `fulfillmentHold = 'REFUND_PENDING'`，必须等待微信支付异步推送到 `refundCallback` 且确认退款成功到账后，才解除暂扣！
- **演练模式 (`ACTIVITY_MODE=TEST`)**:
  通过环境变量 `TEST_REFUND_MODE` 控制：
  - `AUTO_SUCCESS`: 模拟自动完成退款，同步释放发货锁（供开发验收）；
  - `MANUAL_SUCCESS`: 保持 `PROCESSING`，由研发手动触发回调验证异步解锁；
  - `FAILURE`: 模拟退款失败，验证发货拦截防线。
