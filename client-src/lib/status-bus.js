/**
 * Tiny cross-slot signal shared by the MeetClip views.
 *
 * Switching the storage location stops and restarts the local engine in one host
 * request, but the panel polls `/app/status` on its own timer and would briefly
 * see a stopped backend — which renders the first-use wizard over the settings
 * page. `restarting` tells the panel to keep the current view while that happens;
 * `revision` lets it refresh once the switch is committed.
 */
const listeners = new Set()
let state = { restarting: false, revision: 0 }

// 「当前工作区属于另一个资料空间」的提示：@ 卡片 source 发现目录对不上时发一条，
// 由面板渲染一行可点击的提示。同一条只发一次，切回当前空间时清空。
const hintListeners = new Set()
let libraryHint = null

function publish(next) {
  state = next
  for (const listener of [...listeners]) {
    try { listener(state) } catch {}
  }
}

export function getStatusSignal() {
  return state
}

export function subscribeStatusSignal(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function beginEngineRestart() {
  if (!state.restarting) publish({ ...state, restarting: true })
}

export function endEngineRestart() {
  publish({ restarting: false, revision: state.revision + 1 })
}

export function getLibraryHint() {
  return libraryHint
}

export function subscribeLibraryHint(listener) {
  hintListeners.add(listener)
  return () => hintListeners.delete(listener)
}

export function publishLibraryHint(next) {
  const value = next && next.id
    ? { id: String(next.id), name: String(next.name || ''), dataDir: String(next.dataDir || '') }
    : null
  if (value?.id === libraryHint?.id) return
  if (!value && !libraryHint) return
  libraryHint = value
  for (const listener of [...hintListeners]) {
    try { listener(libraryHint) } catch {}
  }
}
