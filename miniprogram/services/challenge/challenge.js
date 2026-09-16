/**
 * 3秒挑战免单前端服务层 (Hybrid Timing & 风控协同)
 */

let cachedEnvSnapshot = null;

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
 * 预加载环境与网络快照（在页面 onLoad 时无感后台缓存，绝不阻塞 STOP 瞬间提交）
 */
export async function preloadEnvironmentSnapshot() {
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

  cachedEnvSnapshot = { deviceInfo, networkInfo, timestamp: Date.now() };
  return cachedEnvSnapshot;
}

/**
 * 获取环境快照（优先返回预缓存数据，耗时 0ms）
 */
export function getEnvironmentSnapshot() {
  if (cachedEnvSnapshot) {
    return cachedEnvSnapshot;
  }
  return { deviceInfo: {}, networkInfo: { networkType: 'unknown' } };
}

/**
 * 1. 页面加载获取挑战上下文与规则快照 (只查不打点，不进入 IN_PROGRESS)
 */
export async function getChallengeContext(orderId) {
  if (!orderId) {
    throw new Error('缺少订单ID');
  }

  const res = await wx.cloud.callFunction({
    name: 'manageChallenge',
    data: {
      action: 'getChallengeContext',
      payload: { orderId },
    },
  });

  if (!res.result || !res.result.success) {
    throw new Error((res.result && res.result.message) || '获取挑战资格失败');
  }

  return res.result.data;
}

/**
 * 2. 用户真正点击【开始挑战】时调用 (服务端签发 Ticket 并记录基准打点)
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
    throw new Error((res.result && res.result.message) || '启动挑战失败');
  }

  return res.result.data;
}

/**
 * 3. 提交挑战用时（STOP 立即提交，毫秒级无等待）
 */
export async function submitChallengeResult({
  sessionId,
  orderId,
  ticket,
  clientElapsedMs,
  clientStartMonotonic,
  clientStopMonotonic,
  deviceInfo,
  networkInfo,
}) {
  if ((!sessionId && !orderId) || !ticket || typeof clientElapsedMs !== 'number') {
    throw new Error('提交参数缺失');
  }

  const res = await wx.cloud.callFunction({
    name: 'manageChallenge',
    data: {
      action: 'submitChallenge',
      payload: {
        sessionId,
        orderId,
        ticket,
        clientElapsedMs,
        clientStartMonotonic,
        clientStopMonotonic,
        deviceInfo,
        networkInfo,
      },
    },
  });

  if (!res.result || !res.result.success) {
    throw new Error((res.result && res.result.message) || '提交成绩失败');
  }

  return res.result.data;
}

/**
 * 4. 恢复会话 (challengeResume)
 */
export async function resumeChallengeSession(sessionId) {
  if (!sessionId) {
    throw new Error('缺少会话ID');
  }

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
 * 5. 上报技术异常 (recordInterrupted)
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
    console.warn('recordChallengeInterrupted silent fail:', e);
  }
}

/**
 * 6. 主动跳过/放弃挑战
 */
export async function skipChallenge(orderId) {
  if (!orderId) {
    throw new Error('缺少订单ID');
  }

  const res = await wx.cloud.callFunction({
    name: 'manageChallenge',
    data: {
      action: 'skipChallenge',
      payload: { orderId },
    },
  });

  if (!res.result || !res.result.success) {
    throw new Error((res.result && res.result.message) || '放弃挑战失败');
  }

  return res.result;
}
