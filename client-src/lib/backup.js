/**
 * 备份页的选择模型与进度文案（纯函数，node 测试直接引用）。
 *
 * 选择集是一个 `Set<"type:id">`：卡片类型有限、id 字符串稳定，比维护多个 Map
 * 简单，也方便「全选 / 清空 / 按类型」直接算。卡包、批次、标记是聚合卡片：
 * 选中它们时，真正的记录/便利签/图片/文档由 resolveSelection() 展开，导出请求
 * 仍然只带用户勾中的顶层卡片，后端会做同样的展开与去重。
 */
import { bytes } from './format.js'

export const SELECTABLE_TYPES = ['pack', 'session', 'note', 'highlight', 'image', 'doc', 'batch']

const TYPE_LABEL = {
  pack: '卡包',
  session: '记录',
  note: '便利签',
  highlight: '标记',
  image: '图片',
  doc: '飞书文档',
  batch: '批次'
}

export function typeLabel(type) {
  return TYPE_LABEL[type] || '卡片'
}

export function keyOf(type, id) {
  return `${type}:${id}`
}

export function parseKey(key) {
  const text = String(key || '')
  const index = text.indexOf(':')
  if (index <= 0) return null
  return { type: text.slice(0, index), id: text.slice(index + 1) }
}

export function isSelected(selection, type, id) {
  return selection instanceof Set && selection.has(keyOf(type, id))
}

export function toggle(selection, type, id) {
  const next = new Set(selection)
  const key = keyOf(type, id)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export function setChecked(selection, type, id, checked) {
  const next = new Set(selection)
  const key = keyOf(type, id)
  if (checked) next.add(key)
  else next.delete(key)
  return next
}

export function setGroup(selection, type, ids, checked) {
  const next = new Set(selection)
  for (const id of ids || []) {
    const key = keyOf(type, id)
    if (checked) next.add(key)
    else next.delete(key)
  }
  return next
}

export function emptySelection() {
  return new Set()
}

export function items(catalog) {
  const value = catalog?.items || {}
  return {
    packs: Array.isArray(value.packs) ? value.packs : [],
    records: Array.isArray(value.records) ? value.records : [],
    notes: Array.isArray(value.notes) ? value.notes : [],
    highlights: Array.isArray(value.highlights) ? value.highlights : [],
    images: Array.isArray(value.images) ? value.images : [],
    docs: Array.isArray(value.docs) ? value.docs : [],
    batches: Array.isArray(value.batches) ? value.batches : []
  }
}

export function indexCatalog(catalog) {
  const rows = items(catalog)
  const index = {
    records: new Map(),
    packs: new Map(),
    notes: new Map(),
    highlights: new Map(),
    images: new Map(),
    docs: new Map(),
    batches: new Map(),
    rows
  }
  for (const row of rows.records) index.records.set(String(row.id), row)
  for (const row of rows.packs) index.packs.set(String(row.id), row)
  for (const row of rows.notes) index.notes.set(String(row.id), row)
  for (const row of rows.highlights) index.highlights.set(String(row.id), row)
  for (const row of rows.images) index.images.set(String(row.id), row)
  for (const row of rows.docs) index.docs.set(String(row.key), row)
  for (const row of rows.batches) index.batches.set(String(row.id), row)
  return index
}

export function docMemberId(value) {
  const text = String(value || '')
  return text.startsWith('doc:') ? text.slice(4) : text
}

/** 展开聚合卡片，得到真正会被写进备份的记录/便利签/图片/文档/标记。 */
export function resolveSelection(selection, index) {
  const records = new Set()
  const notes = new Set()
  const images = new Set()
  const docs = new Set()
  const highlights = new Set()
  const batches = new Set()
  const packs = new Set()
  const sessionsFromHighlight = new Set()

  const addMember = (type, id) => {
    if (type === 'session') records.add(String(id))
    else if (type === 'note') notes.add(String(id))
    else if (type === 'image') images.add(String(id))
    else if (type === 'doc') docs.add(docMemberId(id))
    else if (type === 'batch') batches.add(String(id))
    else if (type === 'highlight') highlights.add(String(id))
  }

  for (const key of selection) {
    const parsed = parseKey(key)
    if (!parsed) continue
    if (parsed.type === 'session') records.add(parsed.id)
    else if (parsed.type === 'note') notes.add(parsed.id)
    else if (parsed.type === 'image') images.add(parsed.id)
    else if (parsed.type === 'doc') docs.add(docMemberId(parsed.id))
    else if (parsed.type === 'batch') batches.add(parsed.id)
    else if (parsed.type === 'highlight') highlights.add(parsed.id)
    else if (parsed.type === 'pack') packs.add(parsed.id)
  }

  for (const packId of packs) {
    const pack = index.packs.get(packId)
    for (const member of pack?.members || []) addMember(member.type, member.id)
  }
  for (const batchId of batches) {
    const batch = index.batches.get(batchId)
    for (const id of batch?.member_ids || []) records.add(String(id))
  }
  for (const markId of highlights) {
    const mark = index.highlights.get(markId)
    if (mark?.session_id) sessionsFromHighlight.add(String(mark.session_id))
  }
  for (const id of sessionsFromHighlight) records.add(id)

  return { records, notes, images, docs, highlights, batches, packs }
}

export function summary(selection, index) {
  const resolved = resolveSelection(selection, index)
  return {
    packs: resolved.packs.size,
    records: resolved.records.size,
    notes: resolved.notes.size,
    images: resolved.images.size,
    docs: resolved.docs.size,
    batches: resolved.batches.size,
    highlights: resolved.highlights.size,
    selected: selection.size
  }
}

/** 含媒体 / 不含媒体的体积估算（按能被选中的卡片本身，不重复计记录）。 */
export function estimate(selection, index, includeMedia) {
  const resolved = resolveSelection(selection, index)
  let base = 0
  let media = 0
  for (const id of resolved.records) {
    const row = index.records.get(id)
    if (!row) continue
    base += Number(row.base_bytes) || 0
    // 媒体体积始终算出来：勾选框旁边要显示「+1.2 GB」，切换时才不会跳成 0。
    media += Number(row.media_bytes) || 0
  }
  for (const id of resolved.notes) base += Number(index.notes.get(id)?.base_bytes) || 0
  for (const id of resolved.images) base += Number(index.images.get(id)?.base_bytes) || 0
  for (const key of resolved.docs) base += Number(index.docs.get(key)?.base_bytes) || 0
  return { base, media, includeMedia: Boolean(includeMedia), total: base + (includeMedia ? media : 0) }
}

export function hasAnyMedia(selection, index) {
  const resolved = resolveSelection(selection, index)
  for (const id of resolved.records) {
    if (Number(index.records.get(id)?.media_bytes) > 0) return true
  }
  return false
}

export function itemsForApi(selection) {
  const out = []
  for (const key of selection) {
    const parsed = parseKey(key)
    if (parsed && SELECTABLE_TYPES.includes(parsed.type)) out.push(parsed)
  }
  return out
}

export function allSelected(selection, type, ids) {
  if (!ids.length) return false
  for (const id of ids) {
    if (!selection.has(keyOf(type, id))) return false
  }
  return true
}

export function selectAllCards(catalog) {
  const selection = new Set()
  const rows = items(catalog)
  for (const row of rows.records) selection.add(keyOf('session', row.id))
  for (const row of rows.packs) selection.add(keyOf('pack', row.id))
  for (const row of rows.notes) selection.add(keyOf('note', row.id))
  for (const row of rows.highlights) selection.add(keyOf('highlight', row.id))
  for (const row of rows.images) selection.add(keyOf('image', row.id))
  for (const row of rows.docs) selection.add(keyOf('doc', row.key))
  for (const row of rows.batches) selection.add(keyOf('batch', row.id))
  return selection
}

export function selectionText(counts) {
  const parts = []
  if (counts.packs) parts.push(`${counts.packs} 个卡包`)
  if (counts.records) parts.push(`${counts.records} 条记录`)
  if (counts.batches) parts.push(`${counts.batches} 个批次`)
  if (counts.notes) parts.push(`${counts.notes} 张便利签`)
  if (counts.highlights) parts.push(`${counts.highlights} 条标记`)
  if (counts.images) parts.push(`${counts.images} 张图片`)
  if (counts.docs) parts.push(`${counts.docs} 篇文档`)
  return parts.length ? parts.join('、') : '还没有选择卡片'
}

export function estimateText(value) {
  const total = Math.max(0, Number(value?.total) || 0)
  const media = Math.max(0, Number(value?.media) || 0)
  if (!total && !media) return '—'
  return value?.includeMedia && media > 0
    ? `约 ${bytes(total)}（含媒体 ${bytes(media)}）`
    : `约 ${bytes(total)}`
}

export function jobPercent(job) {
  if (!job) return null
  if (job.state === 'done') return 100
  const value = Number(job.percent)
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

export function jobBytesText(job) {
  const done = Number(job?.bytes_done) || 0
  const total = Number(job?.bytes_total) || 0
  if (!total) return ''
  return `${bytes(done)} / ${bytes(total)}`
}

export function jobProgressText(job) {
  if (!job) return ''
  if (job.state === 'error') return job.error || '备份失败'
  if (job.state === 'cancelled') return job.error || '已取消'
  const percent = jobPercent(job)
  const phase = job.phase || (job.action === 'import' ? '正在导入' : '正在导出')
  if (job.state === 'done') return '已完成'
  return `${phase}${percent === null || percent >= 100 ? '' : ` ${Math.floor(percent)}%`}`
}

export function exportCountsText(counts) {
  if (!counts) return ''
  const parts = []
  if (counts.records) parts.push(`${counts.records} 条记录`)
  if (counts.packs) parts.push(`${counts.packs} 个卡包`)
  if (counts.batches) parts.push(`${counts.batches} 个批次`)
  if (counts.notes) parts.push(`${counts.notes} 张便利签`)
  if (counts.images) parts.push(`${counts.images} 张图片`)
  if (counts.docs) parts.push(`${counts.docs} 篇文档`)
  if (counts.transcripts) parts.push(`${counts.transcripts} 行转写`)
  return parts.length ? parts.join('、') : '没有内容'
}

export function importCountsText(result) {
  return exportCountsText(result?.counts)
}

export function skippedText(skipped) {
  if (!skipped) return ''
  const parts = []
  if (skipped.records) parts.push(`${skipped.records} 条记录`)
  if (skipped.packs) parts.push(`${skipped.packs} 个卡包`)
  if (skipped.notes) parts.push(`${skipped.notes} 张便利签`)
  if (skipped.images) parts.push(`${skipped.images} 张图片`)
  if (skipped.docs) parts.push(`${skipped.docs} 篇文档`)
  return parts.join('、')
}

/** 导入确认页的摘要：数量、体积、已导入情况。返回结构化行，组件负责排版。 */
export function inspectSummary(inspect) {
  if (!inspect) return { rows: [], mediaBytes: 0, counts: {} }
  const counts = inspect.counts || {}
  const rows = []
  if (counts.records) rows.push(`${counts.records} 条记录（${counts.transcripts || 0} 行转写）`)
  if (counts.packs) rows.push(`${counts.packs} 个卡包`)
  if (counts.batches) rows.push(`${counts.batches} 个批次`)
  if (counts.notes) rows.push(`${counts.notes} 张便利签`)
  if (counts.highlights) rows.push(`${counts.highlights} 条标记`)
  if (counts.images) rows.push(`${counts.images} 张图片`)
  if (counts.docs) rows.push(`${counts.docs} 篇文档`)
  return { rows, mediaBytes: Number(inspect.media_bytes) || 0, counts }
}
