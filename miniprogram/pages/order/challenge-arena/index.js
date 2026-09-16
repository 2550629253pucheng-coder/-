import Toast from 'tdesign-miniprogram/toast/index';
import Dialog from 'tdesign-miniprogram/dialog/index';
import {
  startChallengeSession,
  submitChallengeResult,
  resumeChallengeSession,
  recordChallengeInterrupted,
  getMonotonicNow,
  getEnvironmentSnapshot,
  skipChallenge,
} from '../../../services/challenge/challenge';

Page({
  data: {
    orderId: '',
    loading: true,
    session: null,
    status: 'READY', // READY, PRESSING, SUBMITTING, COMPLETED, INTERRUPTED, PENDING_REVIEW
    displayTime: '0.000',
    targetTime: '3.000',
    toleranceMs: 10,
    result: null,
    isWinner: false,
    isPendingReview: false,
    isInterrupted: false,
    pressStartMonotonic: 0,
    timerInterval: null,
    hasAttempted: false,
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
    this.initSession(orderId);
  },

  onUnload() {
    this.clearTicker();
    // 如果在按压或就绪中突然切出退出，标记技术中断而不判 LOSE
    if (this.data.status === 'PRESSING' && this.data.session && !this.data.hasAttempted) {
      recordChallengeInterrupted(this.data.session.sessionId, 'APP_TERMINATED');
    }
  },

  async initSession(orderId) {
    try {
      this.setData({ loading: true });
      const session = await startChallengeSession(orderId);
      const rule = session.ruleSnapshot || {};
      const targetSec = ((rule.targetTimeMs || 3000) / 1000).toFixed(3);
      const tolerance = Math.round(
        ((rule.successMaxMs || 3010) - (rule.successMinMs || 2990)) / 2
      );

      this.setData({
        session,
        ruleSnapshot: rule,
        loading: false,
        targetTime: targetSec,
        toleranceMs: tolerance || 10,
        activityMode: session.activityMode || 'TEST',
      });

      if (session.challengeCompleted) {
        const isWin = session.challengeStatus === 'WIN';
        const isReview = session.challengeStatus === 'PENDING_REVIEW';
        this.setData({
          status: 'COMPLETED',
          hasAttempted: true,
          result: session.result,
          isWinner: isWin,
          isPendingReview: isReview,
          displayTime: session.result ? (session.result.clientElapsedMs / 1000).toFixed(3) : targetSec,
        });
      } else if (session.challengeStatus === 'INTERRUPTED') {
        this.setData({
          status: 'INTERRUPTED',
          isInterrupted: true,
        });
      }
    } catch (err) {
      this.setData({ loading: false });
      Toast({
        context: this,
        selector: '#t-toast',
        message: err.message || '初始化挑战失败',
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
        message: '已恢复挑战，可重新按压',
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

  // 用户按下挑战按钮 (高精度单调时钟基准)
  onTouchStart(e) {
    if (
      this.data.status !== 'READY' ||
      this.data.hasAttempted ||
      this.data.loading ||
      this.data.isInterrupted
    ) {
      return;
    }

    wx.vibrateShort && wx.vibrateShort({ type: 'light' });

    const monotonicStart = getMonotonicNow();
    const dateStart = Date.now();

    this.setData({
      status: 'PRESSING',
      pressStartMonotonic: monotonicStart,
    });

    this.clearTicker();
    this.data.timerInterval = setInterval(() => {
      const elapsed = Date.now() - dateStart;
      this.setData({
        displayTime: (elapsed / 1000).toFixed(3),
      });
    }, 16); // ~60fps
  },

  // 用户松开按钮 (瞬时捕获单调差值与服务端联调验证)
  async onTouchEnd(e) {
    if (this.data.status !== 'PRESSING') {
      return;
    }

    const monotonicStop = getMonotonicNow();
    this.clearTicker();

    const clientElapsedMs = monotonicStop - this.data.pressStartMonotonic;
    this.setData({
      displayTime: (clientElapsedMs / 1000).toFixed(3),
      status: 'SUBMITTING',
      hasAttempted: true,
    });

    wx.vibrateShort && wx.vibrateShort({ type: 'medium' });

    try {
      const envSnap = await getEnvironmentSnapshot();
      const submitRes = await submitChallengeResult({
        sessionId: this.data.session.sessionId,
        ticket: this.data.session.ticket,
        clientElapsedMs,
        clientStartMonotonic: this.data.pressStartMonotonic,
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
      // 客户端网络或提交异常时：严禁草率判 LOSE！
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

  clearTicker() {
    if (this.data.timerInterval) {
      clearInterval(this.data.timerInterval);
      this.data.timerInterval = null;
    }
  },

  // 放弃/跳过挑战 (二次确认防误触)
  async onSkipChallenge() {
    Dialog.confirm({
      context: this,
      title: '跳过挑战',
      content: '确认跳过本次免单挑战吗？放弃后订单将立即解除履约暂扣，进入正常分拣发货流程。',
      confirmBtn: '确认跳过',
      cancelBtn: '继续挑战',
    }).then(async () => {
      try {
        await skipChallenge(this.data.orderId);
        wx.redirectTo({
          url: `/pages/order/order-detail/index?orderId=${this.data.orderId}`,
        });
      } catch (e) {
        wx.navigateBack();
      }
    });
  },

  onViewOrder() {
    wx.redirectTo({
      url: `/pages/order/order-detail/index?orderId=${this.data.orderId}`,
    });
  },

  onGoHome() {
    wx.switchTab({
      url: '/pages/home/home',
    });
  },
});
