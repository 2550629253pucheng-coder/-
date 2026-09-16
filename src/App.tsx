import React, { useState } from 'react';
import { 
  ShoppingBag, 
  Clock, 
  CheckCircle2, 
  Truck, 
  RotateCcw, 
  ShieldCheck, 
  Package, 
  Layers, 
  Database,
  ArrowRight,
  ExternalLink,
  Smartphone
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'goods' | 'flow'>('overview');

  const skus = [
    {
      id: 'spu-tissue-01',
      name: '原生木浆加厚抽纸 4层柔韧亲肤',
      category: '纸品清洁 / 抽纸卷纸',
      spec: '8包轻享装 / 24包整箱装',
      price: '19.90',
      linePrice: '29.90',
      stock: 1200,
      tags: ['3秒免单', '原生木浆', '加厚4层'],
      image: 'https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=400&auto=format&fit=crop&q=80'
    },
    {
      id: 'spu-garbage-02',
      name: '加厚手提式点断垃圾袋 承重防刺穿',
      category: '居家日化 / 垃圾袋保鲜',
      spec: '5卷100只 / 10卷200只加大装',
      price: '12.90',
      linePrice: '19.90',
      stock: 1500,
      tags: ['3秒免单', '自动收口', '加厚韧性'],
      image: 'https://images.unsplash.com/photo-1610557892470-55d9e80c0bce?w=400&auto=format&fit=crop&q=80'
    },
    {
      id: 'spu-wipes-03',
      name: 'EDI纯水加厚柔湿巾 婴儿级无添加',
      category: '纸品清洁 / 湿巾湿厕纸',
      spec: '80抽*3包 / 80抽*6包带盖装',
      price: '16.90',
      linePrice: '25.90',
      stock: 900,
      tags: ['3秒免单', 'EDI纯水', '弱酸性配方'],
      image: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=400&auto=format&fit=crop&q=80'
    },
    {
      id: 'spu-laundry-04',
      name: '深层洁净抑菌洗衣液 植萃持久留香',
      category: '居家日化 / 衣物清洁',
      spec: '2kg日常瓶装 / 5kg量贩装',
      price: '29.90',
      linePrice: '49.90',
      stock: 800,
      tags: ['3秒免单', '99%除菌', '温和低泡'],
      image: 'https://images.unsplash.com/photo-1585421514738-01798e348b17?w=400&auto=format&fit=crop&q=80'
    },
    {
      id: 'spu-kitchen-05',
      name: '吸油锁水加厚厨房纸巾 强效去油污',
      category: '纸品清洁 / 厨房清洁纸',
      spec: '4卷尝鲜装 / 12卷囤货装',
      price: '15.90',
      linePrice: '22.90',
      stock: 1000,
      tags: ['3秒免单', '食品级接触', '吸油不掉屑'],
      image: 'https://images.unsplash.com/photo-1607344645866-009c320c5ab8?w=400&auto=format&fit=crop&q=80'
    }
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans">
      {/* 顶部系统状态与导航 */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-sm font-bold text-lg">
              3s
            </div>
            <div>
              <div className="font-semibold text-slate-900 leading-tight">3秒挑战免单日用商城</div>
              <div className="text-xs text-slate-500">微信原生小程序 + CloudBase 架构管控台</div>
            </div>
          </div>

          <div className="flex items-center space-x-1 bg-slate-100 p-1 rounded-xl text-sm">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeTab === 'overview'
                  ? 'bg-white text-slate-900 font-medium shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              项目概况
            </button>
            <button
              onClick={() => setActiveTab('goods')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeTab === 'goods'
                  ? 'bg-white text-slate-900 font-medium shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              测试商品池 (5个SKU)
            </button>
            <button
              onClick={() => setActiveTab('flow')}
              className={`px-3 py-1.5 rounded-lg transition-all ${
                activeTab === 'flow'
                  ? 'bg-white text-slate-900 font-medium shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              核心业务闭环
            </button>
          </div>
        </div>
      </header>

      {/* 主体区域 */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* 顶栏卡片 */}
            <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 mb-3">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    Phase 1 基础就绪 · 已完成调优
                  </div>
                  <h1 className="text-2xl font-bold text-slate-900">商城底座与日用品多租户环境配置</h1>
                  <p className="text-slate-600 mt-1 max-w-2xl text-sm leading-relaxed">
                    租户配置已切换为「3秒挑战免单日用商城」，配送运费调整为「满39包邮/基础运费6元」，已建立纸品日化5种首发SPU/SKU高频日用底座。
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-center">
                    <div className="text-xs text-slate-500">运费标准</div>
                    <div className="text-lg font-bold text-slate-900">满 ¥39 包邮</div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-center">
                    <div className="text-xs text-slate-500">挑战目标</div>
                    <div className="text-lg font-bold text-emerald-600">精确 3.00 秒</div>
                  </div>
                </div>
              </div>
            </div>

            {/* 架构就绪指标卡 */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-xs">
                <div className="flex items-center justify-between text-slate-500 text-xs mb-1">
                  <span>多租户配置</span>
                  <Layers className="w-4 h-4 text-emerald-600" />
                </div>
                <div className="text-base font-semibold text-slate-900">tenants/default</div>
                <div className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> 已同步到小程序运行时
                </div>
              </div>

              <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-xs">
                <div className="flex items-center justify-between text-slate-500 text-xs mb-1">
                  <span>商品与类目池</span>
                  <Database className="w-4 h-4 text-blue-600" />
                </div>
                <div className="text-base font-semibold text-slate-900">5款SPU / 10款SKU</div>
                <div className="text-xs text-blue-600 mt-1 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> 纸品清洁 + 居家日化
                </div>
              </div>

              <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-xs">
                <div className="flex items-center justify-between text-slate-500 text-xs mb-1">
                  <span>履约拦截机制</span>
                  <Truck className="w-4 h-4 text-amber-600" />
                </div>
                <div className="text-base font-semibold text-slate-900">fulfillmentHold: true</div>
                <div className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> 订单支付后锁定履约
                </div>
              </div>

              <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-xs">
                <div className="flex items-center justify-between text-slate-500 text-xs mb-1">
                  <span>逆向免单通道</span>
                  <RotateCcw className="w-4 h-4 text-purple-600" />
                </div>
                <div className="text-base font-semibold text-slate-900">CHALLENGE_WIN 退款</div>
                <div className="text-xs text-purple-600 mt-1 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> 独立于普通售后流程
                </div>
              </div>
            </div>

            {/* 核心业务流程全景 */}
            <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs">
              <h2 className="text-base font-bold text-slate-900 mb-4">业务基石与合规铁律</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-sm mb-3">
                    01
                  </div>
                  <div className="font-semibold text-sm text-slate-900">商品即正义</div>
                  <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                    用户购买的是高频真实日用品（抽纸、垃圾袋、洗衣液），不是购买游戏机会；无论挑战成功与否，商品照常发货履约。
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm mb-3">
                    02
                  </div>
                  <div className="font-semibold text-sm text-slate-900">真技巧·零前端信任</div>
                  <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                    挑战结果判定、时间差结算、单号绑定、退款单生成完全在 CloudBase 服务端执行，客户端仅作时间采集，杜绝作弊。
                  </p>
                </div>

                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                  <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-sm mb-3">
                    03
                  </div>
                  <div className="font-semibold text-sm text-slate-900">状态机与履约解耦</div>
                  <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                    新增 <code className="text-indigo-600 bg-indigo-50 px-1 py-0.5 rounded">fulfillmentHold</code> 字段暂扣发货，待挑战结算或超时释放后再推送 ERP Adapter，不侵入原生订单状态机。
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'goods' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">日用爆品首发测试池</h2>
                <p className="text-xs text-slate-500">已导入 cloudbase/bootstrap 并与小程序商品服务适配完毕</p>
              </div>
              <div className="text-xs text-slate-500">共 5 款真实日用商品，各附带多级包装规格</div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {skus.map((item) => (
                <div key={item.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs hover:border-slate-300 transition-all flex flex-col">
                  <div className="h-44 bg-slate-100 overflow-hidden relative">
                    <img 
                      src={item.image} 
                      alt={item.name} 
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute top-2 left-2 flex gap-1 flex-wrap">
                      {item.tags.map((tag, idx) => (
                        <span key={idx} className="bg-emerald-600/90 text-white text-[10px] font-medium px-2 py-0.5 rounded-full shadow-xs">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="p-4 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="text-xs text-slate-400 mb-1">{item.category}</div>
                      <h3 className="font-semibold text-slate-900 text-sm leading-snug">{item.name}</h3>
                      <div className="text-xs text-slate-500 mt-2 bg-slate-50 p-2 rounded-lg border border-slate-100">
                        <span className="font-medium text-slate-700">规格: </span>{item.spec}
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                      <div>
                        <span className="text-xs text-red-600 font-bold">¥</span>
                        <span className="text-lg font-bold text-red-600">{item.price}</span>
                        <span className="text-xs text-slate-400 line-through ml-1.5">¥{item.linePrice}</span>
                      </div>
                      <div className="text-xs text-slate-500 font-medium">
                        库存: <span className="text-slate-800">{item.stock}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'flow' && (
          <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-xs space-y-6">
            <div>
              <h2 className="text-lg font-bold text-slate-900">核心链路验证情况 (通过自动化测试脚本)</h2>
              <p className="text-xs text-slate-500 mt-0.5">从浏览到支付回调的 7 大环节数据流全部校验通过</p>
            </div>

            <div className="relative border-l-2 border-slate-200 pl-6 space-y-6 ml-2">
              <div className="relative">
                <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-emerald-500 ring-4 ring-white"></div>
                <div className="text-sm font-bold text-slate-900">1. 首页推荐与 Tab 切换</div>
                <p className="text-xs text-slate-600 mt-1">
                  读取 home_config 配置，首屏展示「3秒免单爆款」Tab，聚合展示抽纸、垃圾袋、洗衣液等主推日用品。
                </p>
              </div>

              <div className="relative">
                <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-emerald-500 ring-4 ring-white"></div>
                <div className="text-sm font-bold text-slate-900">2. 分类检索与多层级导航</div>
                <p className="text-xs text-slate-600 mt-1">
                  「纸品清洁」「居家日化」两层分类完整映射，支持二级分类精确过滤对应 SPU 列表。
                </p>
              </div>

              <div className="relative">
                <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-emerald-500 ring-4 ring-white"></div>
                <div className="text-sm font-bold text-slate-900">3. 详情与购物车加购</div>
                <p className="text-xs text-slate-600 mt-1">
                  动态聚合 SPU、Spec 规格与 SKU 价格，校验登录后通过云函数 manageCart 正确持久化购物车状态。
                </p>
              </div>

              <div className="relative">
                <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-emerald-500 ring-4 ring-white"></div>
                <div className="text-sm font-bold text-slate-900">4. 结算中心与满额免邮</div>
                <p className="text-xs text-slate-600 mt-1">
                  订单金额满 ¥39 免除运费（低于 ¥39 收取 ¥6），支持收货地址提取与发票信息确认。
                </p>
              </div>

              <div className="relative">
                <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-emerald-500 ring-4 ring-white"></div>
                <div className="text-sm font-bold text-slate-900">5. 订单创建与事务扣减库存</div>
                <p className="text-xs text-slate-600 mt-1">
                  <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">createOrder</code> 通过 db.startTransaction() 锁定对应 SKU 扣减库存，预置 fulfillmentHold 标记。
                </p>
              </div>

              <div className="relative">
                <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-emerald-500 ring-4 ring-white"></div>
                <div className="text-sm font-bold text-slate-900">6. 微信支付成功回调 (下阶段切入点)</div>
                <p className="text-xs text-slate-600 mt-1">
                  支付回调确认后，订单流转至待发货；将由 Phase 2 开启 3秒挑战并生成独立会话凭据。
                </p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
