/**
 * 全局共享数据库集合名称常量定义
 * 统一所有云函数与管理后台的集合引用，杜绝单复数不一致与拼写错误
 */
module.exports = {
  ORDER: "order",
  CHALLENGE_SESSION: "challenge_session",
  CHALLENGE_RULES: "challenge_rules",
  ACTIVITIES: "activities",
  REFUNDS: "refunds",
  REFUND_TASKS: "refund_tasks",
  RISK_LOGS: "risk_logs",
  COMPLIANCE_EVENTS: "compliance_events",
  GOODS_SPU: "goods_spu",
  GOODS_SKU: "goods_sku",
  CART: "cart",
  AFTER_SERVICE: "after_service",
};
