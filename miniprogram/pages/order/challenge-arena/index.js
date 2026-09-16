import Toast from 'tdesign-miniprogram/toast/index';
import Dialog from 'tdesign-miniprogram/dialog/index';
import {
  getChallengeContext,
  startChallengeSession,
  submitChallengeResult,
  resumeChallengeSession,
  recordChallengeInterrupted,
  getMonotonicNow,
  preloadEnvironmentSnapshot,
  getEnvironmentSnapshot,
  skipChallenge,
} from '../../../services/challenge/challenge';

Page({
  data: {
    orderId: '',
    loading: true,
    session: null,
    status: 'READY', // READY, STARTING, RUNNING, SUBMITTING, COMPLETED, INTERRUPTED
    displayTime: '0.000',
    targetTime: '3.000',
    toleranceMs: 10,
    result: null,
    isWinner: false,
    isPendingReview: false,
    isInterrupted: false,
    clientStartMonotonic: 0,
    timerInterval: null,
    ruleSnapshot: null,
    activityMode: 'TEST',
  },

  onLoad(options) {
    const { orderId } = options;
    if (!orderId) {
      Toast({
        context: this,
        selector: '#t-toast',
        message: '订单号缺失',
        icon: 'error-circle',
      });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }

    this.setData({ orderId });

    // 后台无感预加载环境与网络快照，不阻塞页面，STOP瞬间 0ms 提交
    preloadEnvironmentSnapshot().catch((e) => console.warn('Preload env snapshot failed:', e));

    // 获取挑战上下文（只查资格与规则，不触发生命周期状态扭转）
    this.initContext(orderId);
  },

  onUnload() {
    this.clearTicker();
    // 如果在计时过程中突然切出或退出小程序，标记为技术中断，绝不直接判 LOSE
    if (this.data.status === 'RUNNING' && this.data.session) {
      recordChallengeInterrupted(this.data.session.sessionId, 'APP_TERMINATED');
    }
  },

  async initContext(orderId) {
    try {
      this.setData({ loading: true });
      const context = await getChallengeContext(orderId);
      const rule = context.ruleSnapshot || {};
      const targetSec = ((rule.targetTimeMs || 3000) / 1000).toFixed(3);
      const tolerance = Math.round(
        ((rule.successMaxMs || 3010) - (rule.successMinMs || 2990)) / 2
      );

      this.setData({
        loading: false,
        ruleSnapshot: rule,
        targetTime: targetSec,
        toleranceMs: tolerance || 10,
        activityMode: context.activityMode || 'TEST',
      });

      const existingSession = context.session;
      if (existingSession) {
        this.setData({ session: existingSession });
        const st = existingSession.challengeStatus;

        if (st === 'WIN' || st === 'LOSE' || st === 'PENDING_REVIEW' || st === 'EXPIRED') {
          this.setData({
            status: 'COMPLETED',
            result: existingSession.result,
            isWinner: st === 'WIN',
            isPendingReview: st === 'PENDING_REVIEW',
            displayTime: existingSession.result ? (existingSession.result.clientElapsedMs / 1000).toFixed(3) : targetSec,
          });
        } else if (st === 'INTERRUPTED') {
          this.setData({
            status: 'INTERRUPTED',
            isInterrupted: true,
          });
        }
      }
    } catch (err) {
      this.setData({ loading: false });
      Toast({
        context: this,
        selector: '#t-toast',
        message: err.message || '初始化挑战信息失败',
        icon: 'error-circle',
      });
    }
  },

  // 用户点击【开始挑战】
  async onStartClick() {
    if (this.data.status !== 'READY' || this.data.loading) {
      return;
    }

    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    this.setData({ status: 'STARTING' });

    try {
      // 服务端安全验资并记录 serverStartResponseSentAt，签发 Ticket
      const session = await startChallengeSession(this.data.orderId);

      // 收到服务端 ACK 后，立刻记录客户端单调基准时间并开始跑表
      const monotonicStart = getMonotonicNow();
      const dateStart = Date.now();

      this.setData({
        session,
        status: 'RUNNING',
        clientStartMonotonic: monotonicStart,
        displayTime: '0.000',
      });

      this.clearTicker();
      this.data.timerInterval = setInterval(() => {
        const elapsed = Date.now() - dateStart;
        this.setData({
          displayTime: (elapsed / 1000).toFixed(3),
        });
      }, 16); // ~60fps 跑表
    } catch (err) {
      this.setData({ status: 'READY' });
      Toast({
        context: this,
        selector: '#t-toast',
        message: err.message || '启动挑战失败，请重试',
        icon: 'error-circle',
      });
    }
  },

  // 用户点击【停！】
  async onStopClick() {
    if (this.data.status !== 'RUNNING') {
      return;
    }

    // 1. 瞬间截取单调时钟时间戳
    const monotonicStop = getMonotonicNow();
    this.clearTicker();

    const clientElapsedMs = monotonicStop - this.data.clientStartMonotonic;
    this.setData({
      displayTime: (clientElapsedMs / 1000).toFixed(3),
      status: 'SUBMITTING',
    });

    wx.vibrateShort && wx.vibrateShort({ type: 'medium' });

    // 2. STOP 后立即提交，使用预加载的环境快照，0ms 阻塞
    try {
      const envSnap = getEnvironmentSnapshot();
      const submitRes = await submitChallengeResult({
        sessionId: this.data.session.sessionId,
        orderId: this.data.orderId,
        ticket: this.data.session.ticket,
        clientElapsedMs,
        clientStartMonotonic: this.data.clientStartMonotonic,
        clientStopMonotonic: monotonicStop,
        deviceInfo: envSnap.deviceInfo,
        networkInfo: envSnap.networkInfo,
      });

      const isWin = submitRes.challengeStatus === 'WIN';
      const isReview = submitRes.challengeStatus === 'PENDING_REVIEW';

      this.setData({
        status: 'COMPLETED',
        result: submitRes.result,
        isWinner: isWin,
        isPendingReview: isReview,
      });

      if (isWin) {
        wx.vibrateLong && wx.vibrateLong();
      }
    } catch (err) {
      // 网络或提交异常时：严禁草率判 LOSE！进入 INTERRUPTED 留存资格
      await recordChallengeInterrupted(this.data.session.sessionId, 'SUBMIT_NETWORK_ERROR');
      this.setData({
        status: 'INTERRUPTED',
        isInterrupted: true,
      });
      Toast({
        context: this,
        selector: '#t-toast',
        message: '网络异常中断，挑战进度已安全保留，可点击恢复重试',
        icon: 'error-circle',
      });
    }
  },

  // 恢复异常中断的挑战会话
  async onResumeSession() {
    try {
      this.setData({ loading: true });
      const session = await resumeChallengeSession(this.data.session.sessionId);
      this.setData({
        session,
        loading: false,
        status: 'READY',
        isInterrupted: false,
        displayTime: '0.000',
      });
      Toast({
        context: this,
        selector: '#t-toast',
        message: '已安全恢复挑战，可点击【开始挑战】',
        icon: 'check-circle',
      });
    } catch (err) {
      this.setData({ loading: false });
      Toast({
        context: this,
        selector: '#t-toast',
        message: err.message || '恢复失败',
        icon: 'error-circle',
      });
    }
  },

  clearTicker() {
    if (this.data.timerInterval) {
      clearInterval(this.data.timerInterval);
      this.data.timerInterval = null;
    }
  },

  // 放弃/跳过挑战 (仅在未开始挑战前允许)
  onSkipChallenge() {
    Dialog.confirm({
      context: this,
      title: '放弃免单挑战？',
      content: '放弃后商品将直接进入仓库配货打包流程，此操作不可撤销。',
      confirmBtn: '确认放弃',
      cancelBtn: '再想想',
    }).then(async () => {
      try {
        await skipChallenge(this.data.orderId);
        Toast({
          context: this,
          selector: '#t-toast',
          message: '已解除履约拦截，商品将正常发货',
          icon: 'check-circle',
        });
        setTimeout(() => {
          this.onBackToOrder();
        }, 1200);
      } catch (err) {
        Toast({
          context: this,
          selector: '#t-toast',
          message: err.message || '操作失败',
          icon: 'error-circle',
        });
      }
    }).catch(() => {});
  },

  onBackToOrder() {
    wx.redirectTo({
      url: `/pages/order/order-detail/index?orderId=${this.data.orderId}`,
    });
  },
});
