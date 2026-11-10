/**
 * @ 会摘卡片的同步管理器。
 *
 * 卡片文件由 backend/app/cards.py 生成；Host 只负责在合适的时机触发同步：
 * 引擎启动、DSH 工作区创建、以及一个低频定时器。客户端 @ 菜单打开时也会
 * 走 /api/cards 触发一次节流同步，所以这里不做阻塞式轮询。
 */
const DEFAULT_INTERVAL_MS = 60_000

export class CardSyncManager {
  constructor(runtime, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    this.runtime = runtime
    this.intervalMs = intervalMs
    this.timer = null
    this.unsupported = false
    this.last = { at: 0, ok: null, error: '', result: null }
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.sync().catch(() => {})
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 引擎重启或数据目录切换后，重新给旧后端一次机会。 */
  reset() {
    this.unsupported = false
    this.last = { at: 0, ok: null, error: '', result: null }
  }

  snapshot() {
    return {
      at: this.last.at,
      ok: this.last.ok,
      error: this.last.error,
      result: this.last.result,
      unsupported: this.unsupported
    }
  }

  /**
   * 触发一次卡片同步。后端未运行时不主动拉起引擎；由 @ 菜单或引擎启动路径负责。
   * @param {{force?: boolean}} options - force 会重建所有卡片。
   * @returns {Promise<object>} backend 的同步结果，或 {skipped}。
   */
  async sync({ force = false } = {}) {
    if (this.unsupported) return { skipped: 'unsupported' }
    const state = this.runtime?.backend?.state
    if (!['running', 'starting'].includes(state)) {
      return { skipped: 'backend_down' }
    }
    try {
      const path = force ? '/api/cards/sync?force=1' : '/api/cards/sync'
      const result = await this.runtime.backend.json(path, { method: 'POST', body: '{}' })
      this.unsupported = false
      this.last = { at: Date.now(), ok: true, error: '', result: summarize(result) }
      return result
    } catch (error) {
      if (error?.status === 404) this.unsupported = true
      this.last = {
        at: Date.now(),
        ok: false,
        error: error?.message || String(error),
        result: null
      }
      return { skipped: 'error', error: this.last.error }
    }
  }

  dispose() {
    this.stop()
  }
}

function summarize(result) {
  if (!result || typeof result !== 'object') return null
  return {
    total: Number(result.total) || 0,
    created: Number(result.created) || 0,
    updated: Number(result.updated) || 0,
    removed: Number(result.removed) || 0,
    skipped: Number(result.skipped) || 0,
    errors: Array.isArray(result.errors) ? result.errors.length : 0,
    updated_at: result.updated_at || null
  }
}
