// 日用品 5 种首发测试商品数据定义 (包含 SPU, SKU, 规格 Spec, 类目 Category)
module.exports = {
  categories: {
    category1: [
      {
        _id: "cat-c1-paper",
        category1Id: "C1-PAPER-CLEAN",
        category1Name: "纸品清洁",
        thumbnail: "https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=120&auto=format&fit=crop&q=80",
        createdAt: 1726444800000,
        updatedAt: 1726444800000,
      },
      {
        _id: "cat-c1-homecare",
        category1Id: "C1-HOME-CARE",
        category1Name: "居家日化",
        thumbnail: "https://images.unsplash.com/photo-1585421514738-01798e348b17?w=120&auto=format&fit=crop&q=80",
        createdAt: 1726444800000,
        updatedAt: 1726444800000,
      }
    ],
    category2: [
      {
        _id: "cat-c2-tissue",
        category2Id: "C2-TISSUE",
        category2Name: "抽纸卷纸",
        thumbnail: "https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=120&auto=format&fit=crop&q=80",
        category1Id: { _id: "cat-c1-paper" },
        createdAt: 1726444800000,
        updatedAt: 1726444800000,
      },
      {
        _id: "cat-c2-bags",
        category2Id: "C2-BAGS",
        category2Name: "垃圾袋保鲜",
        thumbnail: "https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=120&auto=format&fit=crop&q=80",
        category1Id: { _id: "cat-c1-homecare" },
        createdAt: 1726444800000,
        updatedAt: 1726444800000,
      },
      {
        _id: "cat-c2-wipes",
        category2Id: "C2-WIPES",
        category2Name: "湿巾湿厕纸",
        thumbnail: "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&auto=format&fit=crop&q=80",
        category1Id: { _id: "cat-c1-paper" },
        createdAt: 1726444800000,
        updatedAt: 1726444800000,
      },
      {
        _id: "cat-c2-laundry",
        category2Id: "C2-LAUNDRY",
        category2Name: "衣物清洁",
        thumbnail: "https://images.unsplash.com/photo-1585421514738-01798e348b17?w=120&auto=format&fit=crop&q=80",
        category1Id: { _id: "cat-c1-homecare" },
        createdAt: 1726444800000,
        updatedAt: 1726444800000,
      },
      {
        _id: "cat-c2-kitchen",
        category2Id: "C2-KITCHEN",
        category2Name: "厨房清洁纸",
        thumbnail: "https://images.unsplash.com/photo-1607344645866-009c320c5ab8?w=120&auto=format&fit=crop&q=80",
        category1Id: { _id: "cat-c1-paper" },
        createdAt: 1726444800000,
        updatedAt: 1726444800000,
      }
    ]
  },

  spus: [
    {
      _id: "spu-tissue-01",
      spuId: "SPU-TISSUE-01",
      title: "原生木浆加厚抽纸 4层柔韧亲肤",
      primaryImage: "https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=600&auto=format&fit=crop&q=80",
      images: [
        "https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=800&auto=format&fit=crop&q=80",
        "https://images.unsplash.com/photo-1607344645866-009c320c5ab8?w=800&auto=format&fit=crop&q=80"
      ],
      desc: [
        "https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=800&auto=format&fit=crop&q=80"
      ],
      minSalePrice: 1990, // 19.90 元 (分)
      maxLinePrice: 2990,
      soldNum: 3520,
      spuStockQuantity: 1200,
      isPutOnSale: true,
      tags: ["3秒免单", "原生木浆", "加厚4层"],
      categoryId: { _id: "cat-c2-tissue" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "spu-garbage-02",
      spuId: "SPU-GARBAGE-02",
      title: "加厚手提式点断垃圾袋 承重防刺穿",
      primaryImage: "https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=600&auto=format&fit=crop&q=80",
      images: [
        "https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=800&auto=format&fit=crop&q=80"
      ],
      desc: [
        "https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=800&auto=format&fit=crop&q=80"
      ],
      minSalePrice: 1290, // 12.90 元
      maxLinePrice: 1990,
      soldNum: 2180,
      spuStockQuantity: 1500,
      isPutOnSale: true,
      tags: ["3秒免单", "自动收口", "加厚韧性"],
      categoryId: { _id: "cat-c2-bags" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "spu-wipes-03",
      spuId: "SPU-WIPES-03",
      title: "EDI纯水加厚柔湿巾 婴儿级无添加",
      primaryImage: "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=600&auto=format&fit=crop&q=80",
      images: [
        "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&auto=format&fit=crop&q=80"
      ],
      desc: [
        "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=800&auto=format&fit=crop&q=80"
      ],
      minSalePrice: 1690, // 16.90 元
      maxLinePrice: 2590,
      soldNum: 1840,
      spuStockQuantity: 900,
      isPutOnSale: true,
      tags: ["3秒免单", "EDI纯水", "弱酸性配方"],
      categoryId: { _id: "cat-c2-wipes" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "spu-laundry-04",
      spuId: "SPU-LAUNDRY-04",
      title: "深层洁净抑菌洗衣液 植萃持久留香",
      primaryImage: "https://images.unsplash.com/photo-1585421514738-01798e348b17?w=600&auto=format&fit=crop&q=80",
      images: [
        "https://images.unsplash.com/photo-1585421514738-01798e348b17?w=800&auto=format&fit=crop&q=80"
      ],
      desc: [
        "https://images.unsplash.com/photo-1585421514738-01798e348b17?w=800&auto=format&fit=crop&q=80"
      ],
      minSalePrice: 2990, // 29.90 元
      maxLinePrice: 4990,
      soldNum: 4120,
      spuStockQuantity: 800,
      isPutOnSale: true,
      tags: ["3秒免单", "99%除菌", "温和低泡"],
      categoryId: { _id: "cat-c2-laundry" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "spu-kitchen-05",
      spuId: "SPU-KITCHEN-05",
      title: "吸油锁水加厚厨房纸巾 强效去油污",
      primaryImage: "https://images.unsplash.com/photo-1607344645866-009c320c5ab8?w=600&auto=format&fit=crop&q=80",
      images: [
        "https://images.unsplash.com/photo-1607344645866-009c320c5ab8?w=800&auto=format&fit=crop&q=80"
      ],
      desc: [
        "https://images.unsplash.com/photo-1607344645866-009c320c5ab8?w=800&auto=format&fit=crop&q=80"
      ],
      minSalePrice: 1590, // 15.90 元
      maxLinePrice: 2290,
      soldNum: 1690,
      spuStockQuantity: 1000,
      isPutOnSale: true,
      tags: ["3秒免单", "食品级接触", "吸油不掉屑"],
      categoryId: { _id: "cat-c2-kitchen" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    }
  ],

  specs: [
    {
      _id: "spec-tissue",
      specId: "SPEC-TISSUE",
      title: "包装规格",
      values: [
        { valueId: "VAL-TISSUE-8", value: "8包轻享装" },
        { valueId: "VAL-TISSUE-24", value: "24包整箱实惠装" }
      ],
      sortOrder: 1,
      spuId: { _id: "spu-tissue-01" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "spec-garbage",
      specId: "SPEC-GARBAGE",
      title: "规格数量",
      values: [
        { valueId: "VAL-GARBAGE-5", value: "5卷(共100只)" },
        { valueId: "VAL-GARBAGE-10", value: "10卷(共200只加大装)" }
      ],
      sortOrder: 1,
      spuId: { _id: "spu-garbage-02" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "spec-wipes",
      specId: "SPEC-WIPES",
      title: "规格",
      values: [
        { valueId: "VAL-WIPES-3", value: "80抽*3包" },
        { valueId: "VAL-WIPES-6", value: "80抽*6包带盖家庭装" }
      ],
      sortOrder: 1,
      spuId: { _id: "spu-wipes-03" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "spec-laundry",
      specId: "SPEC-LAUNDRY",
      title: "容量选择",
      values: [
        { valueId: "VAL-LAUNDRY-2KG", value: "2kg日常瓶装" },
        { valueId: "VAL-LAUNDRY-5KG", value: "5kg大容量量贩装" }
      ],
      sortOrder: 1,
      spuId: { _id: "spu-laundry-04" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "spec-kitchen",
      specId: "SPEC-KITCHEN",
      title: "规格",
      values: [
        { valueId: "VAL-KITCHEN-4", value: "4卷尝鲜装" },
        { valueId: "VAL-KITCHEN-12", value: "12卷整箱囤货装" }
      ],
      sortOrder: 1,
      spuId: { _id: "spu-kitchen-05" },
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    }
  ],

  skus: [
    // 抽纸 SKU
    {
      _id: "sku-tissue-8",
      skuId: "SKU-TISSUE-8",
      spuId: { _id: "spu-tissue-01" },
      image: "https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-TISSUE", specValueId: "VAL-TISSUE-8" }
      ],
      price: 1990,
      stock: 500,
      soldQuantity: 1200,
      isDefault: true,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "sku-tissue-24",
      skuId: "SKU-TISSUE-24",
      spuId: { _id: "spu-tissue-01" },
      image: "https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-TISSUE", specValueId: "VAL-TISSUE-24" }
      ],
      price: 4990,
      stock: 700,
      soldQuantity: 2320,
      isDefault: false,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },

    // 垃圾袋 SKU
    {
      _id: "sku-garbage-5",
      skuId: "SKU-GARBAGE-5",
      spuId: { _id: "spu-garbage-02" },
      image: "https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-GARBAGE", specValueId: "VAL-GARBAGE-5" }
      ],
      price: 1290,
      stock: 600,
      soldQuantity: 980,
      isDefault: true,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "sku-garbage-10",
      skuId: "SKU-GARBAGE-10",
      spuId: { _id: "spu-garbage-02" },
      image: "https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-GARBAGE", specValueId: "VAL-GARBAGE-10" }
      ],
      price: 2390,
      stock: 900,
      soldQuantity: 1200,
      isDefault: false,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },

    // 湿巾 SKU
    {
      _id: "sku-wipes-3",
      skuId: "SKU-WIPES-3",
      spuId: { _id: "spu-wipes-03" },
      image: "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-WIPES", specValueId: "VAL-WIPES-3" }
      ],
      price: 1690,
      stock: 400,
      soldQuantity: 840,
      isDefault: true,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "sku-wipes-6",
      skuId: "SKU-WIPES-6",
      spuId: { _id: "spu-wipes-03" },
      image: "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-WIPES", specValueId: "VAL-WIPES-6" }
      ],
      price: 2990,
      stock: 500,
      soldQuantity: 1000,
      isDefault: false,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },

    // 洗衣液 SKU
    {
      _id: "sku-laundry-2kg",
      skuId: "SKU-LAUNDRY-2KG",
      spuId: { _id: "spu-laundry-04" },
      image: "https://images.unsplash.com/photo-1585421514738-01798e348b17?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-LAUNDRY", specValueId: "VAL-LAUNDRY-2KG" }
      ],
      price: 2990,
      stock: 450,
      soldQuantity: 2100,
      isDefault: true,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "sku-laundry-5kg",
      skuId: "SKU-LAUNDRY-5KG",
      spuId: { _id: "spu-laundry-04" },
      image: "https://images.unsplash.com/photo-1585421514738-01798e348b17?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-LAUNDRY", specValueId: "VAL-LAUNDRY-5KG" }
      ],
      price: 5990,
      stock: 350,
      soldQuantity: 2020,
      isDefault: false,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },

    // 厨房纸 SKU
    {
      _id: "sku-kitchen-4",
      skuId: "SKU-KITCHEN-4",
      spuId: { _id: "spu-kitchen-05" },
      image: "https://images.unsplash.com/photo-1607344645866-009c320c5ab8?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-KITCHEN", specValueId: "VAL-KITCHEN-4" }
      ],
      price: 1590,
      stock: 450,
      soldQuantity: 790,
      isDefault: true,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    },
    {
      _id: "sku-kitchen-12",
      skuId: "SKU-KITCHEN-12",
      spuId: { _id: "spu-kitchen-05" },
      image: "https://images.unsplash.com/photo-1607344645866-009c320c5ab8?w=600&auto=format&fit=crop&q=80",
      specValues: [
        { specId: "SPEC-KITCHEN", specValueId: "VAL-KITCHEN-12" }
      ],
      price: 3990,
      stock: 550,
      soldQuantity: 900,
      isDefault: false,
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    }
  ],

  homeConfig: [
    {
      searchPlaceholder: "搜索抽纸、垃圾袋、柔湿巾、洗衣液",
      swiper: [
        {
          image: "https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=800&auto=format&fit=crop&q=80",
          spuId: "spu-tissue-01",
          linkType: "spu",
          poi: null
        },
        {
          image: "https://images.unsplash.com/photo-1585421514738-01798e348b17?w=800&auto=format&fit=crop&q=80",
          spuId: "spu-laundry-04",
          linkType: "spu",
          poi: null
        }
      ],
      tabList: [
        {
          text: "3秒免单爆款",
          spuIds: ["spu-tissue-01", "spu-garbage-02", "spu-laundry-04"]
        },
        {
          text: "纸品清洁",
          spuIds: ["spu-tissue-01", "spu-wipes-03", "spu-kitchen-05"]
        },
        {
          text: "日化洗护",
          spuIds: ["spu-garbage-02", "spu-laundry-04"]
        }
      ],
      createdAt: 1726444800000,
      updatedAt: 1726444800000,
    }
  ],

  comments: [
    {
      _id: "comment-tissue-1",
      spuId: "spu-tissue-01",
      skuId: "SKU-TISSUE-8",
      specs: "8包轻享装",
      commentContent: "纸质非常柔韧厚实，沾水不破，包装完好发货神速！",
      commentScore: 5,
      userName: "居家好物家",
      userHeadUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80",
      commentResources: [],
      isAnonymity: false,
      isAutoComment: false,
      sellerReply: "感谢您的支持，原生木浆品质保证！",
      goods: {
        title: "原生木浆加厚抽纸 4层柔韧亲肤",
        thumb: "https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=600&auto=format&fit=crop&q=80",
        specInfo: [
          {
            specId: "SPEC-TISSUE",
            specValueId: "VAL-TISSUE-8",
            specTitle: "包装规格",
            specValue: "8包轻享装"
          }
        ]
      },
      createdAt: 1726444800000,
      updatedAt: 1726444800000
    },
    {
      _id: "comment-garbage-1",
      spuId: "spu-garbage-02",
      skuId: "SKU-GARBAGE-5",
      specs: "5卷(共100只)",
      commentContent: "手提自动收口非常方便，拉力很强不漏汤水，无限次回购。",
      commentScore: 5,
      userName: "生活管家小李",
      userHeadUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&auto=format&fit=crop&q=80",
      commentResources: [],
      isAnonymity: false,
      isAutoComment: false,
      sellerReply: "感谢您的认可，加厚承重更安心！",
      goods: {
        title: "加厚手提式点断垃圾袋 承重防刺穿",
        thumb: "https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=600&auto=format&fit=crop&q=80",
        specInfo: [
          {
            specId: "SPEC-GARBAGE",
            specValueId: "VAL-GARBAGE-5",
            specTitle: "规格数量",
            specValue: "5卷(共100只)"
          }
        ]
      },
      createdAt: 1726444800000,
      updatedAt: 1726444800000
    }
  ]
};
