// 网关模型目录的客户端分类：语音 / 文本。
// 目录是只读提示，当前配置永远优先，不静默替换。

const SPEECH = /asr|transcribe|whisper/i
const SPEECH_DROP = /tts|voiceclone|voicedesign/i
const TEXT_DROP = /embed|rerank|ocr|tts|voiceclone|voicedesign|image|moderation|realtime|sora|dall-e|whisper|transcribe|asr/i

export function splitModels(ids = []) {
  const seen = new Set()
  const asr = []
  const text = []
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '').trim()
    if (!id || id.endsWith(':batch') || seen.has(id)) continue
    seen.add(id)
    if (SPEECH.test(id)) {
      if (!SPEECH_DROP.test(id)) asr.push(id)
    } else if (!TEXT_DROP.test(id)) {
      text.push(id)
    }
  }
  return { asr, text }
}

// 同一个网关里的模型通常是「同族 + 变体」（`vendor/xxx`、`xxx-flash`、`xxx-pro`）。
// 按当前配置的族名排前面，其余按字母序，避免把某一家的模型名写死在源码里。
function familyOf(id) {
  const value = String(id || '').trim()
  if (!value) return ''
  const slash = value.indexOf('/')
  if (slash > 0) return value.slice(0, slash).toLowerCase()
  return value.split(/[-_.]/)[0].toLowerCase()
}

export function sortModels(list = [], current = '') {
  const cur = String(current || '').trim()
  const family = familyOf(cur)
  return list.slice().sort((a, b) => {
    if (a === cur) return -1
    if (b === cur) return 1
    const am = family && familyOf(a) === family ? 0 : 1
    const bm = family && familyOf(b) === family ? 0 : 1
    return am - bm || String(a).localeCompare(String(b))
  })
}

export function modelOptions(list = [], current = '') {
  const cur = String(current || '').trim()
  const items = cur && !list.includes(cur) ? [cur, ...list] : list
  return sortModels(items, cur).map((id) => ({
    value: id,
    label: id === cur ? `${id}（当前）` : id
  }))
}

/**
 * 验证顺序：当前选择优先，其次同供应商（同一个 Key 的权限通常按供应商划分），
 * 最后才是其余模型。首次引导据此逐个试，选中第一个真正能调通的模型。
 */
export function candidateOrder(list = [], { current = '', vendor = '' } = {}) {
  const cur = String(current || '').trim()
  const own = String(vendor || '').trim()
  const vendorOf = (id) => (String(id || '').includes('/') ? String(id).split('/')[0] : '')
  const seen = new Set()
  const items = (Array.isArray(list) ? list : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && !seen.has(id) && seen.add(id))
  const rank = (id) => (id === cur ? 0 : own && vendorOf(id) === own ? 1 : 2)
  return items
    .map((id, index) => ({ id, index, rank: rank(id) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.id)
}

export function vendorOf(model) {
  const value = String(model || '').trim()
  return value.includes('/') ? value.split('/')[0] : ''
}

/**
 * 去掉「明确不可用」的模型（网关说没权限、或 5xx/HTML 这类明显没部署好的）。
 *
 * 探测里没能下结论的（例如 400 参数类）保持可见：宁可让用户在测试连接里看到
 * 真实原因，也不要把还能用的模型藏起来。过滤后为空时保留原列表，避免下拉变空。
 */
export function withoutHidden(list = [], hidden = []) {
  const items = Array.isArray(list) ? list : []
  const blocked = new Set(
    (Array.isArray(hidden) ? hidden : [])
      .map((row) => (typeof row === 'string' ? row : row?.model))
      .filter(Boolean)
  )
  if (!blocked.size) return items
  const kept = items.filter((id) => !blocked.has(id))
  return kept.length ? kept : items
}
