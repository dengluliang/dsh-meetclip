// 采集中的记录会通过 SSE 推很多「只是指示器」的事件：画面运动分数每 0.5 秒一条、
// 还有 noop / heartbeat。它们不该触发整份详情重拉——重拉一次要解析几百 KB 的
// 快照并重绘整页，采集时整个渲染进程都会被它占满（表现为整个 DSH 窗口点不动）。
// 这里把「哪些事件值得重拉」收成一条规则，方便测试。
const INDICATOR_EVENTS = new Set(['noop', 'closed', 'motion', 'heartbeat', 'ping', 'tick'])

export function isIndicatorEvent(payload) {
  if (!payload || typeof payload !== 'object') return true
  return INDICATOR_EVENTS.has(String(payload.kind || ''))
}

/** 只有带有内容变化的事件才值得重拉详情。 */
export function shouldReloadForEvent(payload) {
  if (!payload || typeof payload !== 'object') return false
  if (!payload.kind) return true
  return !isIndicatorEvent(payload)
}

/** motion 事件只驱动侧栏那根灵敏度指示条。 */
export function motionOf(payload) {
  if (payload?.kind !== 'motion') return null
  const score = Number(payload.score)
  if (!Number.isFinite(score)) return null
  const threshold = Number(payload.threshold)
  return { score, threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : null }
}
