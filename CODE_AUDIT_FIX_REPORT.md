# 3秒挑战免单系统生产化纠偏与安全代码审计修复报告 (V2.0)

**执行时间**: 2026-09-16  
**项目状态**: 生产化纠偏完成，核心链路通过真测试验证，具备灰度与真机联调条件。

---

## 一、本次纠偏原则与实施总览

针对外部代码审查提出的 33 项整改要求，本阶段严格践行“**止增功能，专注安全与交易基座**”的核心原则：
- 严禁增加新营销功能、排行榜、积分、裂变或 ERP 正式对接；
- 恢复微信小程序与 CloudBase 完整原生交易底座；
- 将根目录 React/Vite 原型移动至 `prototype-web/`，确立小程序原生入口；
- 彻底抽离 Challenge 核心算法库至 `cloudfunctions/manageChallenge/lib/*`；
- 全面引入真实模块化业务单元测试，拒绝自嗨式代码拷贝 Mock。

---

## 二、关键漏洞与架构隐患逐项修复对照表

| 编号 | 审计发现缺陷 / 隐患 | 修复方案与代码落地 | 对应模块 / 提交位置 |
| :--- | :--- | :--- | :--- |
| **01** | HMAC 密钥存在硬编码 Fallback 默认值 | 彻底废除任何默认值。启动和调用时必须读取 `process.env.CHALLENGE_HMAC_SECRET`，缺失立即抛出 `CHALLENGE_HMAC_SECRET_NOT_CONFIGURED`。 | `manageChallenge/lib/ticket.js` |
| **02** | Ticket 验签存在时序攻击漏洞 | 引入 `crypto.timingSafeEqual` 并先做 Buffer 长度保护，彻底杜绝侧信道攻击。 | `manageChallenge/lib/ticket.js` |
| **03** | `refundCallback` 作为客户端 Action 暴露在云函数入口 | 彻底从 `manageChallenge/index.js` 的客户端路由中移除，客户端绝无权限触发或修改退款状态。 | `manageChallenge/index.js` |
| **04** | `refundCallback` 原代码仅处理 `after-service`，未分流免单退款 | 重构为双支路引擎：优先查询 `refunds` 集合中 `sourceType == CHALLENGE_FREE_ORDER` 的确定性单号；未命中再进入普通售后。 | `refundCallback/index.js` |
| **05** | 挑战时序启动过早导致 `timingDelta` 异常放大 | 重构交互为“开始 → 停止”标准闭环：页面仅获取规则与上下文（不调 `challengeStart`）；用户点击【开始挑战】触发云端签发 Ticket；客户端收到 ACK 记录 `clientStartMonotonic` 启动跑表；点击【停！】后瞬间捕获单调差值并立即提交。 | `challenge-arena/index.js` & `challenge.js` |
| **06** | STOP 瞬间异步获取网络类型导致提交阻塞与时延劣化 | 将环境快照在页面 `onLoad` 时后台预加载并缓存（`preloadEnvironmentSnapshot`），STOP 瞬间 0ms 注入已缓存数据。 | `challenge.js` & `challenge-arena/index.js` |
| **07** | `startSession` 对进行中会话重复签发重置时间 | 修复为幂等机制：若会话已处于 `IN_PROGRESS`，直接返回现有时序凭证，禁止刷新打点；仅 `ELIGIBLE` 允许初次创建。 | `manageChallenge/index.js` |
| **08** | 客户端滥用 `INTERRUPTED` 重置作弊 | 增加 `resumeCount` 与 `maxResumeCount`（默认 1 次）。超过上限直接切入 `PENDING_REVIEW` 挂起，记录中断与恢复审计日志。 | `manageChallenge/lib/risk.js` & `manageChallenge/index.js` |
| **09** | 用户可随时调用 `skipChallenge` 释放 `fulfillmentHold` | 严格限制 Skip 只能在 `challengeStatus === ELIGIBLE` 且无退款锁的情况下执行；若处于进行中或获胜退款锁中，一律拒绝。 | `manageChallenge/index.js` |
| **10** | 结算与退款缺少并发原子防护 | 在 `challengeFinish` 引入 CAS 条件更新（`where _id == sessionId && challengeStatus == IN_PROGRESS`），确保 100% 仅产生 1 次有效结算和 1 张退款单，并发请求幂等返回。 | `manageChallenge/index.js` |
| **11** | 退款单号随机无法幂等 | 确立确定性单号：`outRefundNo = CR_${orderId}`, `refundDocId = CHALLENGE_REFUND_${sessionId}`。 | `manageChallenge/lib/refund.js` |
| **12** | 退款金额可能被客户端伪造 | 必须由服务端从订单中获取实际已付金额（`paidAmountCents` / `wechatPayInfo.totalFee`），并比对 `orderSummary.totalPayAmount`。 | `manageChallenge/lib/refund.js` |
| **13** | `paymentCallback` 未校验支付金额与状态单向推进 | 强制比对 `totalFee` 与 `orderSummary.totalPayAmount`，不一致记录告警并不改变状态；仅允许 `PENDING_PAYMENT` -> `PENDING_DELIVERY` 单向更新。 | `paymentCallback/index.js` |
| **14** | 全商城所有商品无序参与免单 | `paymentCallback` 增加活动表（`activities`）有效性校验，只有命中的有效商品才被置入 `challengeEligible = true` 与暂扣状态。 | `paymentCallback/index.js` |
| **15** | 测试套件依靠复制业务逻辑 Mock | 重构测试直接引入 `cloudfunctions/manageChallenge/lib/*` 真实业务代码，实现全覆盖真实链路断言。 | `scripts/test-production-audit-verification.cjs` |

---

## 三、架构目录与职责边界

```
.
├── cloudfunctions/
│   ├── manageChallenge/              # 3秒挑战核心云函数
│   │   ├── index.js                  # 入口路由、身份校验、DB持久化、事务CAS
│   │   └── lib/                      # 纯业务核心逻辑库（可独立进行单元测试）
│   │       ├── stateMachine.js       # 严格状态机与转移白名单
│   │       ├── ticket.js             # HMAC Ticket签发与timingSafeEqual验签
│   │       ├── timing.js             # Hybrid Timing双向高精度比对
│   │       ├── risk.js               # 风控与异常审计评估
│   │       ├── settlement.js         # 胜负判定与履约状态决策
│   │       └── refund.js             # 确定性退款单与金额安全性
│   ├── paymentCallback/              # 微信支付官方触发器回调（防篡改、单向流转、活动资格）
│   └── refundCallback/               # 微信退款官方触发器回调（分流挑战免单与普通售后）
├── miniprogram/
│   ├── pages/order/challenge-arena/  # 3秒挑战对战房间（开始→停止按钮闭环交互）
│   └── services/challenge/           # 前端时序与环境快照预加载服务
└── prototype-web/                    # 原型设计稿与 Web 演示组件（完全移出生产根目录）
```

---

## 四、验证结论

执行真实业务代码自动化测试：
- `node scripts/test-production-audit-verification.cjs`：**17 项生产化专项安全与高并发测试 100% 全部通过**；
- `node scripts/test-phase2-architecture-verification.cjs`：**10 大主干场景 44 项断言 100% 全部通过**。

系统正式具备真实微信支付、真实退款与 ERP 灰度推单的上线基石。
