# CloudBase 微信支付真实集成配置操作指引 (CLOUDBASE_PAYMENT_SETUP.md)

> **当前集成状态**：`PAYMENT_INTEGRATION_STATUS = REQUIRES_CLOUDBASE_CONSOLE_CONFIGURATION`  
> **代码就绪状态**：`CODE_READY = YES`  
> **生产就绪状态**：`PAYMENT_LIVE_READY = NO` (阻塞于 CloudBase 控制台人工配置)  
> **真机测试状态**：`READY_FOR_DEVICE_TEST_MODE = YES` (可直接进行 100～300 次 TEST_MODE 挑战校准)

---

## 概述与架构安全原则

在腾讯云 CloudBase 云开发中，微信支付建议使用 **集成中心 (Integration Center)** 托管凭证与通信。  
核心原则：
1. **代码库零秘钥 (Zero Credentials in Repo)**：APIv3Key、商户私钥、证书、AppSecret 等绝不进入 Git 仓库或明文硬编码。
2. **配置驱动，禁止臆测函数名**：云开发控制台创建微信支付集成时会动态生成一个 HTTP/云函数名称（例如 `wxpay-prod-xyz123`），代码通过环境变量 `PAYMENT_INTEGRATION_FUNCTION_NAME` 引用，绝不写死假定的 `cloudbase_module` 或 `pay-common`。
3. **LIVE 严密 Fail-Closed**：正式生产环境下若未配置真实集成函数，系统拒绝任何预支付下单与退款，并抛出 `PAYMENT_INTEGRATION_FUNCTION_NAME_NOT_CONFIGURED`，严禁在生产隐式回退到 Mock 造成资金或货品损失。
4. **身份强绑定**：下单支付者 OpenID 严格取自 `cloud.getWXContext().OPENID`，彻底忽略客户端伪造的 `payerOpenId`。

---

## 控制台 8 步配置清单

若需上线正式真实支付（LIVE 模式），项目管理员需在微信云开发控制台完成以下步骤：

### 1. 登录并进入集成中心
- 打开 [微信开发者工具] -> [云开发控制台] -> 点击顶部导航 **「集成中心」 (Integration Center)**。
- 找到 **「微信支付」** 扩展集成，点击「立即添加」或「开启配置」。

### 2. 绑定小程序 AppID
- 将小程序实际 AppID 与云开发环境安全绑定。

### 3. 关联微信支付商户号 (MCH_ID)
- 输入小程序关联的微信支付商户号 (MchID)。
- 在微信支付商户平台完成商户授权确认。

### 4. 托管商户 APIv3 秘钥与支付证书
- 在集成中心安全上传微信支付商户 API 证书 (`apiclient_cert.pem` / `apiclient_key.pem`)。
- 输入 32 字节商户 APIv3 密钥。所有密钥均由腾讯云 KMS 硬件安全模块加密存储。

### 5. 获取生成的实际集成云函数名称
- 集成创建成功后，控制台会展示实际生成的云函数/工作流名称（例如 `wxpay-extension-xxxx`）。
- 复制该名称。

### 6. 配置云函数环境变量
- 打开 [云开发控制台] -> [云函数] -> 进入各核心云函数（`unifiedOrder`, `manageChallenge`, `challengeRecovery`）：
  - **`PAYMENT_INTEGRATION_FUNCTION_NAME`**: 设置为您在第 5 步获取的真实云函数名称（如 `wxpay-extension-xxxx`）。
  - **`ACTIVITY_MODE`**: 正式上线前设置为 `LIVE`（在 100~300 次真机测试阶段保持为 `TEST`）。
  - **`CHALLENGE_HMAC_SECRET`**: 设置 64 字符以上的强随机 HMAC 秘钥。

### 7. 配置支付结果回调 (Payment Callback)
- 在控制台集成设置中，将支付成功回调路由指向云函数：`paymentCallback`。
- `paymentCallback` 会在收到官方回调时严密核验商户号、订单金额、冻结商品规则快照（Fail-Closed 校验）。

### 8. 配置退款结果回调 (Refund Callback)
- 在集成设置中，将退款结果通知路由指向云函数：`refundCallback`。
- `refundCallback` 收到官方退款成功通知后，会原子解除订单的仓储发货锁（`fulfillmentHold` 释放为 `NONE`，`erpStatus` 更新为 `READY`）。
