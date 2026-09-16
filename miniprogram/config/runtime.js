module.exports = {
  "app": {
    "name": "3秒挑战免单日用商城",
    "description": "高频日用品特惠专营，下单参与3秒真技巧免单挑战",
    "permissionDesc": "用于订单配送、地址选择和门店自提"
  },
  "cloud": {
    "envId": ""
  },
  "wechat": {
    "appId": "",
    "projectName": "retail-oss",
    "projectDescription": "3秒挑战免单商城"
  },
  "assets": {
    "cdnBase": "",
    "defaultGoodsDescImages": []
  },
  "afterService": {
    "returnAddress": {
      "name": "售后退货服务中心",
      "phone": "18888888888",
      "address": "广东省深圳市南山区高新科技园日用品供应链仓配中心"
    },
    "reasonList": [
      {
        "id": 1,
        "desc": "实际商品与描述不符"
      },
      {
        "id": 2,
        "desc": "质量问题"
      },
      {
        "id": 3,
        "desc": "少件/漏发"
      },
      {
        "id": 4,
        "desc": "包装或商品破损"
      },
      {
        "id": 5,
        "desc": "发货太慢"
      },
      {
        "id": 6,
        "desc": "商家发错货"
      },
      {
        "id": 8,
        "desc": "不喜欢/不想要"
      }
    ]
  },
  "customerService": {
    "phone": "400-888-9999",
    "serviceTimeDuration": "工作日 9:00 - 18:00 为你服务",
    "showOnlineChat": true
  },
  "features": {
    "distributor": false,
    "invoice": true,
    "pickup": false
  },
  "invoice": {
    "notice": [
      "请根据当地税务要求填写真实、有效的发票抬头信息。",
      "电子普通发票与纸质发票具有同等法律效力，可用于报销或售后凭证。",
      "如需开具特殊类型发票，请先联系商家客服确认。"
    ],
    "taxCodeNotice": [
      "纳税人识别号或统一社会信用代码通常可在营业执照或税务登记资料中查看。",
      "企业抬头发票请确认名称与税号一致，避免影响开票。"
    ]
  },
  "logistics": {
    "companies": [
      {
        "name": "中通快递",
        "code": "ZTO",
        "phone": "95311"
      },
      {
        "name": "圆通速递",
        "code": "YTO",
        "phone": "95554"
      },
      {
        "name": "韵达速递",
        "code": "YUNDA",
        "phone": "95546"
      },
      {
        "name": "申通快递",
        "code": "STO",
        "phone": "95543"
      },
      {
        "name": "极兔速递",
        "code": "JTSD",
        "phone": "956025"
      },
      {
        "name": "顺丰速运",
        "code": "SF",
        "phone": "95338"
      },
      {
        "name": "邮政快递包裹",
        "code": "EMS",
        "phone": "11183"
      },
      {
        "name": "京东物流",
        "code": "JD",
        "phone": "950616"
      },
      {
        "name": "德邦快递",
        "code": "DBL",
        "phone": "95353"
      },
      {
        "name": "百世快递",
        "code": "BEST",
        "phone": "95320"
      }
    ]
  },
  "order": {
    "shipping": {
      "defaultFee": 6,
      "freeShippingThreshold": 39
    }
  }
};
