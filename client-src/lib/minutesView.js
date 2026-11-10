// 原生纪要视图的纯逻辑：节顺序、标签、合并节标题。
// 标签与顺序由后端 `minutes_scenarios` 随 payload 下发（labels / section_order），
// 前端只做兜底，避免两边各写一份模板。

export const DEFAULT_ORDER = {
  meeting: ['outcomes', 'summary', 'topics', 'terms'],
  video: ['summary', 'topics', 'conclusions', 'todos', 'terms'],
  live: ['summary', 'topics', 'conclusions', 'todos', 'terms']
}

const FALLBACK_LABELS = {
  zh: {
    outcomes: '结论和待办', conclusions: '结论', todos: '待办', summary: '总结',
    topics: '主题', terms: '人名和术语', heard: '听作', fishbone: '鱼骨图'
  },
  en: {
    outcomes: 'Conclusions and to-dos', conclusions: 'Conclusions', todos: 'To-dos',
    summary: 'Summary', topics: 'Topics', terms: 'Names and terms', heard: 'heard as',
    fishbone: 'Causes'
  }
}

export function labelLanguage(lang) {
  const text = String(lang || '').toLowerCase()
  if (!text) return 'zh'
  if (/chinese|mandarin|cantonese|中文|chinese/.test(text)) return 'zh'
  return 'en'
}

export function minutesSections(minutes) {
  const order = Array.isArray(minutes?.section_order) ? minutes.section_order : null
  if (order && order.length) return order
  return DEFAULT_ORDER[minutes?.scenario] || DEFAULT_ORDER.meeting
}

export function minutesLabels(minutes) {
  const fallback = FALLBACK_LABELS[labelLanguage(minutes?.lang)]
  return { ...fallback, ...(minutes?.labels || {}) }
}

export function hasMinutesContent(minutes) {
  if (!minutes) return false
  return Boolean(
    String(minutes.summary || '').trim() ||
    (minutes.topics || []).length ||
    (minutes.conclusions || []).length ||
    (minutes.todos || []).length ||
    (minutes.terms || []).length
  )
}

/** 会议模板把结论和待办放在同一节：两者都有时用合并标题，只剩一种时用各自的标题。 */
export function outcomesHeading(labels, conclusions, todos) {
  const hasConclusions = (conclusions || []).length > 0
  const hasTodos = (todos || []).length > 0
  if (hasConclusions && hasTodos) return labels.outcomes
  if (hasConclusions) return labels.conclusions
  return labels.todos
}

export function isWeak(support) {
  const value = Number(support)
  return !Number.isFinite(value) || value <= 0
}

/** 时间轴的分段：每段从本主题开始到下一个主题开始，最后一段到已覆盖的秒数。 */
export function timelineSegments(minutes) {
  const topics = (minutes?.topics || []).filter((topic) => topic && Number.isFinite(Number(topic.start)))
  if (topics.length < 2) return []
  const first = Number(topics[0].start) || 0
  const covered = Number(minutes?.covered)
  const total = Number.isFinite(covered) && covered > first ? covered : first + 60
  return topics.map((topic, index) => {
    const start = Number(topic.start) || 0
    const next = index + 1 < topics.length ? Number(topics[index + 1].start) : total
    const end = Number.isFinite(next) && next > start ? next : start + 1
    return {
      start,
      end,
      span: Math.max(1, end - start),
      title: String(topic?.title || ''),
      current: minutes?.final === false && index === topics.length - 1
    }
  })
}
