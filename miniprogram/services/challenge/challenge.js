/**
 * 3秒挑战免单前端服务层 (Hybrid Timing & 风控协同)
 */
import { runtimeConfig } from '../../config/index';

/**
 * 获取环境高精度单调时间戳 (ms)
 */
export function getMonotonicNow() {
  if (typeof wx !== 'undefined' && wx.getPerformance) {
    const perf = wx.getPerformance();
    if (perf && typeof perf.now === 'function') {
      return perf.now();
    }
  }
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * 获取当前设备和网络环境快照 (风控审计与基线校准用)
 */
export async function getEnvironmentSnapshot() {
  let deviceInfo = {};
  let networkInfo = {};

  try {
    if (wx.getSystemInfoSync) {
      const sys = wx.getSystemInfoSync();
      deviceInfo = {
        brand: sys.brand,
        model: sys.model,
        system: sys.system,
        platform: sys.platform,
        benchmarkLevel: sys.benchmarkLevel,
      };
    }
  } catch (e) {}

  try {
    const netRes = await new Promise((resolve) => {
      wx.getNetworkType({
        success: resolve,
        fail: () => resolve({ networkType: 'unknown' }),
      });
    });
    networkInfo = {
      networkType: netRes.networkType || 'unknown',
    };
  } catch (e) {}

  return { deviceInfo, networkInfo };
}

/**
 * 启动或获取挑战会话 (获取服务端 Ticket 与锁定的规则快照)
 * @param {string} orderId 订单ID
 */
export async function startChallengeSession(orderId) {
  if (!orderId) {
    throw new Error('缺少订单ID');
  }

  const res = await wx.cloud.callFunction({
    name: 'manageChallenge',
    data: {
      action: 'startSession',
      payload: { orderId },
    },
  });

  if (!res.result || !res.result.success) {
    throw new Error((res.result && res.result.message) || '获取挑战凭证失败');
  }

  return res.result.data;
}

/**
 * 提交挑战用时（服务端真技巧判定 + Hybrid Timing + 签名 Ticket）
 */
export async function submitChallengeResult({
  sessionId,
  ticket,
  clientElapsedMs,
  clientStartMonotonic,
  clientStopMonotonic,
  deviceInfo,
  networkInfo,
}) {
  if (!sessionId || !ticket || typeof clientElapsedMs !== 'number') {
    throw new Error('提交参数缺失');
  }

  const res = await wx.cloud.callFunction({
    name: 'manageChallenge',
    data: {
      action: 'submitChallenge',
      payload: {
        sessionId,
        ticket,
        clientElapsedMs: Math.round(clientElapsedMs),
        clientStartMonotonic,
        clientStopMonotonic,
        deviceInfo,
        networkInfo,
      },
    },
  });

  if (!res.result || !res.result.success) {
    throw new Error((res.result && res.result.message) || '挑战提交失败');
  }

  return res.result.data;
}

/**
 * 异常中断后恢复会话 (challengeResume)
 */
export async function resumeChallengeSession(sessionId) {
  if (!sessionId) throw new Error('缺少会话ID');

  const res = await wx.cloud.callFunction({
    name: 'manageChallenge',
    data: {
      action: 'resumeSession',
      payload: { sessionId },
    },
  });

  if (!res.result || !res.result.success) {
    throw new Error((res.result && res.result.message) || '恢复挑战会话失败');
  }

  return res.result.data;
}

/**
 * 上报技术异常中断 (不判 LOSE)
 */
export async function recordChallengeInterrupted(sessionId, reason) {
  if (!sessionId) return;
  try {
    await wx.cloud.callFunction({
      name: 'manageChallenge',
      data: {
        action: 'recordInterrupted',
        payload: { sessionId, reason },
      },
    });
  } catch (e) {
    console.warn('[recordChallengeInterrupted] failed:', e);
  }
}

/**
 * 获取指定挑战会话详情
 */
export async function getChallengeSession(orderId, sessionId) {
  const res = await wx.cloud.callFunction({
    name: 'manageChallenge',
    data: {
      action: 'getSession',
      payload: { orderId, sessionId },
    },
  });

  if (!res.result || !res.result.success) {
    return null;
  }

  return res.result.data;
}

/**
 * 用户主动放弃/跳过挑战，立即释放履约锁 (USER_SKIPPED)
 */
export async function skipChallenge(orderId) {
  const res = await wx.cloud.callFunction({
    name: 'manageChallenge',
    data: {
      action: 'skipChallenge',
      payload: { orderId },
    },
  });

  return res.result && res.result.success;
}
