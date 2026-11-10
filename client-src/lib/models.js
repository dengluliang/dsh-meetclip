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

export function sortModels(list = [], current = '') {
  const cur = String(current || '').trim()
  return list.slice().sort((a, b) => {
    if (a === cur) return -1
    if (b === cur) return 1
    const am = /^mimo/i.test(a) ? 0 : 1
    const bm = /^mimo/i.test(b) ? 0 : 1
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
