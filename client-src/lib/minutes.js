// AI 纪要段落的前端工具：边界检测、提取、场景名。
// 后端 `backend/app/minutes_notes.py` 使用同一组标记，改动时必须两边一起改。

export const MINUTES_BEGIN = '<!-- meetclip:minutes:begin -->'
export const MINUTES_END = '<!-- meetclip:minutes:end -->'

const BLOCK_RE = /^[ \t]*<!-- meetclip:minutes:begin -->[ \t]*\r?\n[\s\S]*?^[ \t]*<!-- meetclip:minutes:end -->[ \t]*(?:\r?\n)?/m

export const SCENARIO_KEYS = {
  meeting: 'minutes.scenario.meeting',
  video: 'minutes.scenario.video',
  live: 'minutes.scenario.live'
}

export const SCENARIO_FALLBACK = {
  meeting: '会议模板',
  video: '视频模板',
  live: '直播模板'
}

export function scenarioKey(kind) {
  return ({ meeting: 'meeting', link_video: 'video', live: 'live' })[kind] || 'meeting'
}

export function scenarioLabel(scenario, t) {
  const key = SCENARIO_KEYS[scenario] || SCENARIO_KEYS.meeting
  return (t && t(key)) || SCENARIO_FALLBACK[scenario] || SCENARIO_FALLBACK.meeting
}

export function hasMinutesBlock(text) {
  return BLOCK_RE.test(String(text || ''))
}

export function extractMinutesBlock(text) {
  const match = String(text || '').match(BLOCK_RE)
  return match ? match[0].trim() : ''
}

export function stripMinutesBlock(text) {
  const next = String(text || '').replace(BLOCK_RE, '')
  return next.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 草稿里没有 AI 段落、而服务端已经有时，把服务端段落并进草稿，避免保存时丢掉纪要。 */
export function mergeDraftWithBlock(serverNotes, draftText) {
  const block = extractMinutesBlock(serverNotes)
  if (!block || hasMinutesBlock(draftText)) return draftText
  return `${block}\n\n${String(draftText || '').trim()}`.trim()
}
