// 纪要互动的前端工具：待办稳定键、选区片段、高亮定位。
//
// 待办键必须与后端 minutes_interactions.todo_key 完全一致：
// NFKC → 去掉所有空白 → 小写 → 去掉句末标点。这样笔记投影、结构化视图与 Agent
// 看到的是同一份"已完成"状态，重新整理纪要后也不会因为标点/空格变化而丢失。

const EDGE_PUNCT = new Set(Array.from('。．.!！?？,，;；:：、·-—_~～…"\'“”‘’()（）[]【】<>《》'))
const CONTEXT_CHARS = 24
const SKIP_SELECTOR = 'button, a, mark, [data-no-highlight]'

export function todoKey(text) {
  let value
  try { value = String(text || '').normalize('NFKC') } catch { value = String(text || '') }
  value = value.replace(/\s+/g, '').toLowerCase()
  let end = value.length
  while (end > 0 && EDGE_PUNCT.has(value[end - 1])) end -= 1
  return value.slice(0, end).slice(0, 120)
}

export function doneTodoCount(interactions) {
  const todos = interactions?.todos || {}
  return Object.values(todos).filter((item) => item && item.done).length
}

export function highlightCount(interactions) {
  return Array.isArray(interactions?.highlights) ? interactions.highlights.length : 0
}

export function todoDone(interactions, text) {
  const key = todoKey(text)
  if (!key) return false
  const entry = (interactions?.todos || {})[key]
  return Boolean(entry && entry.done)
}

function elementOf(node) {
  if (!node) return null
  return node.nodeType === 3 ? node.parentElement : node
}

function clipContext(value) {
  const text = String(value || '')
  return text.length > CONTEXT_CHARS * 2 ? text : text
}

/**
 * 把当前选区拆成若干文本片段，带上前后文；跨行/跨元素选择也能恢复到原位。
 * 返回 { quote, fragments, section, topic, t } 或 null。
 */
export function selectionHighlight(root, selection = null) {
  if (!root || typeof window === 'undefined') return null
  let value = selection
  if (!value) {
    try { value = window.getSelection?.() } catch { value = null }
  }
  if (!value || value.isCollapsed || !value.rangeCount) return null
  let range
  try { range = value.getRangeAt(0) } catch { return null }
  if (!range || !root.contains(range.commonAncestorContainer)) return null
  const filter = typeof NodeFilter !== 'undefined' ? NodeFilter : null
  if (!filter) return null
  const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, null)
  const fragments = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (!node?.data || !range.intersectsNode(node)) continue
    const parent = node.parentElement
    if (parent?.closest?.(SKIP_SELECTOR)) continue
    const offsetStart = node === range.startContainer ? range.startOffset : 0
    const offsetEnd = node === range.endContainer ? Math.min(range.endOffset, node.data.length) : node.data.length
    if (offsetEnd <= offsetStart) continue
    const raw = node.data.slice(offsetStart, offsetEnd)
    const lead = raw.length - raw.trimStart().length
    const tail = raw.length - raw.trimEnd().length
    const text = raw.trim()
    if (text.length < 2) continue
    fragments.push({
      text,
      before: clipContext(node.data.slice(Math.max(0, offsetStart + lead - CONTEXT_CHARS), offsetStart + lead)),
      after: clipContext(node.data.slice(offsetEnd - tail, offsetEnd - tail + CONTEXT_CHARS))
    })
    if (fragments.length >= 20) break
  }
  if (!fragments.length) return null
  const quote = fragments.map((fragment) => fragment.text).join(' ').slice(0, 500)
  const startElement = elementOf(range.startContainer)
  const section = startElement?.closest?.('[data-section]')?.getAttribute('data-section') || ''
  const topic = startElement?.closest?.('[data-topic]')?.getAttribute('data-topic') || ''
  const timeValue = startElement?.closest?.('[data-t]')?.getAttribute('data-t')
  const fallbackTime = startElement?.closest?.('[data-topic]')?.getAttribute('data-t')
  const parsed = Number(timeValue ?? fallbackTime)
  return {
    quote,
    fragments,
    section,
    topic,
    t: Number.isFinite(parsed) ? parsed : null
  }
}

function nfkc(value) {
  try { return String(value || '').normalize('NFKC') } catch { return String(value || '') }
}

/**
 * 逐字做 NFKC 并记录"规范化后的第 i 个字符来自原文哪个下标"。
 * 全角逗号/冒号/加号会被折成半角，长度通常不变；个别字符会展开成多个字符，
 * 用 map 能把命中位置准确映射回原文，避免把 mark 画偏。
 */
function normalizedIndex(text) {
  const chars = []
  const map = []
  for (let index = 0; index < text.length; index += 1) {
    const piece = nfkc(text[index])
    for (const char of piece) {
      chars.push(char)
      map.push(index)
    }
  }
  return { text: chars.join(''), map }
}

function matchOnce(text, needle, before, after) {
  const attempts = [
    { body: `${before}${needle}${after}`, prefix: before.length },
    { body: `${before}${needle}`, prefix: before.length },
    { body: `${needle}${after}`, prefix: 0 },
    { body: needle, prefix: 0 }
  ]
  for (const attempt of attempts) {
    if (!attempt.body) continue
    const at = text.indexOf(attempt.body)
    if (at < 0) continue
    const start = at + attempt.prefix
    return { start, end: start + needle.length }
  }
  return null
}

function matchNormalized(text, needle, before, after) {
  const index = normalizedIndex(text)
  const normalizedNeedle = nfkc(needle)
  if (!normalizedNeedle) return null
  const normalizedBefore = nfkc(before)
  const normalizedAfter = nfkc(after)
  const attempts = [
    { body: `${normalizedBefore}${normalizedNeedle}${normalizedAfter}`, prefix: normalizedBefore.length },
    { body: `${normalizedBefore}${normalizedNeedle}`, prefix: normalizedBefore.length },
    { body: `${normalizedNeedle}${normalizedAfter}`, prefix: 0 },
    { body: normalizedNeedle, prefix: 0 }
  ]
  for (const attempt of attempts) {
    if (!attempt.body) continue
    const at = index.text.indexOf(attempt.body)
    if (at < 0) continue
    const normalizedStart = at + attempt.prefix
    const normalizedEnd = normalizedStart + normalizedNeedle.length
    if (normalizedStart < 0 || normalizedEnd <= normalizedStart) continue
    const start = index.map[normalizedStart]
    const last = index.map[Math.min(normalizedEnd - 1, index.map.length - 1)]
    if (start === undefined || last === undefined) continue
    return { start, end: last + 1 }
  }
  return null
}

function locateFragment(text, fragment) {
  const needle = String(fragment?.text || '')
  if (!needle) return null
  const before = String(fragment.before || '').slice(-CONTEXT_CHARS)
  const after = String(fragment.after || '').slice(0, CONTEXT_CHARS)
  // 先按原文精确匹配；老数据存过 NFKC 折半的标点，再走一次规范化匹配兜底。
  return matchOnce(text, needle, before, after) || matchNormalized(text, needle, before, after)
}

/** 在一段文字里找出所有高亮区间；重叠时以先出现/先加入的为准。 */
export function highlightSpans(text, highlights) {
  const source = String(text || '')
  if (!source || !Array.isArray(highlights) || !highlights.length) return []
  const spans = []
  for (const highlight of highlights) {
    for (const fragment of highlight?.fragments || []) {
      const span = locateFragment(source, fragment)
      if (!span) continue
      if (span.end <= span.start) continue
      spans.push({ start: span.start, end: span.end, id: highlight.id, quote: highlight.quote, at: highlight.at, topic: highlight.topic })
    }
  }
  spans.sort((left, right) => left.start - right.start || right.end - left.end)
  const out = []
  let cursor = -1
  for (const span of spans) {
    if (span.start < cursor) continue
    out.push(span)
    cursor = span.end
  }
  return out
}

export function newHighlightId() {
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
