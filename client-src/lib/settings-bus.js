let request = null
let sequence = 0
const listeners = new Set()

/** 从任意界面请求打开设置弹层；底层表单/弹窗保持挂载。 */
export function openSettings({ tab = 'models', anchor = '', reason = '' } = {}) {
  sequence += 1
  request = { tab, anchor, reason, nonce: sequence }
  for (const listener of listeners) {
    try { listener(request) } catch {}
  }
  return request
}

export function getSettingsRequest() {
  return request
}

export function closeSettings() {
  request = null
  for (const listener of listeners) {
    try { listener(null) } catch {}
  }
}

export function subscribeSettings(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
