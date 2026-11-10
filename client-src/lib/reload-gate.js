// 详情快照的刷新闸门。
//
// 一条采集中的记录会被好几路同时触发「重拉详情」：SSE 推送、3 秒轮询、播放进度、
// 纪要状态。每份快照都不小（长记录 300 KB 上下，带几千行转写和上千张截图路径），
// 放任并发时渲染进程里同时排着好几份响应，主线程被占满，整个 DSH 窗口就点不动了。
//
// 这个闸门保证：
//   1. 同一时刻只有一个任务在跑；
//   2. 两次任务之间至少隔 gap 毫秒；
//   3. 期间被挡下的请求合并成一次补拉，不会丢；priority 请求（换记录、首次进入）
//      立刻执行，不排队。
export function createReloadGate({ gap = 0, task, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id) }) {
  if (typeof task !== 'function') throw new TypeError('createReloadGate 需要 task')
  const state = {
    running: false,
    last: -Infinity,
    timer: null,
    queued: false,
    queuedPriority: false,
    stopped: false
  }

  function run(priority) {
    state.running = true
    state.last = now()
    Promise.resolve()
      .then(() => task(priority))
      .catch(() => {})
      .then(() => {
        state.running = false
        if (state.stopped) return
        if (state.queued) flush()
      })
  }

  // 把「排队中的那次刷新」兑现：先清标记再发请求，跑的过程中新来的请求才能重新排队，
  // 否则一次补拉会自己把自己再排一遍，变成永远在刷。
  function flush() {
    if (state.stopped) return
    if (!state.queued) return
    const priority = state.queuedPriority
    state.queued = false
    state.queuedPriority = false
    request(priority)
  }

  function request(priority = false) {
    if (state.stopped) return
    if (state.running) {
      state.queued = true
      state.queuedPriority = state.queuedPriority || priority
      return
    }
    const wait = priority ? 0 : gap - (now() - state.last)
    if (wait > 0) {
      state.queued = true
      state.queuedPriority = state.queuedPriority || priority
      if (!state.timer) state.timer = schedule(() => { state.timer = null; flush() }, wait)
      return
    }
    if (state.timer) {
      cancel(state.timer)
      state.timer = null
    }
    state.queued = false
    state.queuedPriority = false
    run(priority)
  }

  return {
    request,
    stop() {
      state.stopped = true
      state.queued = false
      state.queuedPriority = false
      if (state.timer) {
        cancel(state.timer)
        state.timer = null
      }
    },
    get busy() { return state.running },
    get pending() { return state.queued }
  }
}
