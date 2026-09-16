# 微信支付与回调安全规范 (Payment Security V1)

**版本**: V1.0  
**适用模块**: `cloudfunctions/paymentCallback/`, `cloudfunctions/manageChallenge/`

---

## 一、支付回调安全防护体系

微信支付是整个商城资金与免单交易的核心入口。生产环境中杜绝“只认返回字符串，不验金额与来源”的伪支付逻辑。

### 1. 严格信道隔离与伪造拦截
- **生产环境 (LIVE / Production)**:
  - 回调必须来源于微信官方云开发安全触发器 (`event.wxpayTrigger`)；
  - 必须使用服务端私有 APIv3 密钥（`input.apiV3key`）解密 `ciphertext` 与 `nonce`，并校验 GCM AuthTag；
  - **拦截非安全调用**: 若处于生产环境但未检测到合法的微信触发器解密载荷，直接返回 `UNTRUSTED_CALL_SOURCE` 错误并阻断处理，禁止外部随意伪造请求完成支付。
- **演练测试环境 (TEST)**:
  - 允许传入模拟支付凭据用于单元测试与回归测试。

### 2. 金额一致性双向强核验 (Anti-Tampering)
恶意攻击者常见的手段为：利用 0.01 元的测试支付单号覆盖数十万元的高价值订单。
- `paymentCallback` 获取微信通知的实际扣款金额 `totalFee`（单位：分）；
- 必须对比订单原系统应付款：
  ```javascript
  const expectedCents = Math.round(Number(order.orderSummary.totalPayAmount) * 100);
  if (Math.abs(actualCents - expectedCents) > 1) {
    // 立即拦截！记录 paymentAnomaly 日志，坚决不扭转订单状态！
    return { errcode: 1, errmsg: "PAYMENT_AMOUNT_MISMATCH" };
  }
  ```

### 3. 状态单向扭转守护 (Forward-Only State Machine)
- 仅允许将订单从 `PENDING_PAYMENT` 推进至 `PENDING_DELIVERY`；
- 若微信服务器发生网络抖动重复回调，且当前订单已是 `PENDING_DELIVERY`，直接安全幂等返回 `SUCCESS`；
- 若当前订单已被商家在管理后台推单发货（`PENDING_RECEIPT`）或已签收（`COMPLETE`），**严禁倒退回待发货**，返回 `ORDER_ALREADY_ADVANCED`。

### 4. 活动参与资格准入控制 (Activity Eligibility)
并非全商城任意商品均可参与 3 秒挑战免单：
- `paymentCallback` 会实时扫描 `activities` 集合；
- 条件：`type == 'THREE_SECOND_CHALLENGE' && status == 'ACTIVE' && startTime <= now <= endTime`；
- 若活动限制特定商品范围（`applicableSpuIds`），则校验订单内商品；
- **命中者**: 赋予 `challengeEligible: true`, `challengeStatus: "ELIGIBLE"`, `fulfillmentHold: "CHALLENGE_PENDING"`, `erpStatus: "HOLD"`；
- **未命中者**: 赋予 `challengeEligible: false`, `challengeStatus: "NONE"`, `fulfillmentHold: "NONE"`, `erpStatus: "READY"`，正常流转无需等待挑战。

---

## 二、HMAC 零信任 Ticket 安全规格

1. **绝对密钥保管**:
   - `CHALLENGE_HMAC_SECRET` 仅存在于服务端云函数环境变量中；
   - 严禁任何硬编码备用默认值（Fallback Secret），若环境变量未配置，云函数直接拒绝服务。
2. **防时序攻击**:
   - 验签必须使用 Node.js 原生 `crypto.timingSafeEqual(bufA, bufB)`，且强制校验两 Buffer 长度相同。
3. **载荷防重放与防换单**:
   - Ticket 签名载荷包含：`challengeId` (会话ID)、`orderId` (订单ID)、`openid` (微信身份)、`ruleVersion` (锁定规则版本)、`nonce` (随机数)、`issuedAt` (下发时间戳)、`maxRoundDurationMs` (单轮上限)；
   - 客户端试图篡改目标时间或版本号将立刻被截获。
