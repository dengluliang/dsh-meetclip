export function pad(value) {
  return String(Math.max(0, Math.floor(value))).padStart(2, '0')
}

export function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  if (total >= 3600) return `${Math.floor(total / 3600)}:${pad((total % 3600) / 60)}:${pad(total % 60)}`
  return `${pad(total / 60)}:${pad(total % 60)}`
}

export function duration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  if (total >= 3600) return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`
  if (total >= 60) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
  return `${total} 秒`
}

export function bytes(value) {
  const size = Number(value) || 0
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${size} B`
}

export function dateTime(epochSeconds, locale = 'zh-CN') {
  if (!epochSeconds) return ''
  try {
    return new Intl.DateTimeFormat(locale, {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(new Date(epochSeconds * 1000))
  } catch {
    return new Date(epochSeconds * 1000).toLocaleString()
  }
}

export function dayLabel(epochSeconds, locale = 'zh-CN') {
  if (!epochSeconds) return ''
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' })
      .format(new Date(epochSeconds * 1000))
  } catch {
    return new Date(epochSeconds * 1000).toLocaleDateString()
  }
}

export function statusText(status, t, partial = false) {
  if (partial) return t('status.partial')
  const map = {
    pending: '待开始',
    queued: '排队中',
    recording: '采集中',
    processing: '处理中',
    done: '已完成',
    error: '出错',
    cancelled: '已取消'
  }
  return map[status] || status || ''
}

export function kindInfo(kind) {
  switch (kind) {
    case 'meeting': return { label: '会议', tone: 'meeting' }
    case 'link_video': return { label: '视频', tone: 'video' }
    default: return { label: '直播', tone: 'live' }
  }
}

export function statusTone(status) {
  if (status === 'done') return 'ok'
  if (status === 'error') return 'error'
  if (status === 'recording' || status === 'processing') return 'busy'
  if (status === 'queued' || status === 'pending') return 'warn'
  return 'idle'
}

export function groupSessions(sessions) {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
  const startOfYesterday = startOfToday - 86400
  const weekday = (new Date(startOfToday * 1000).getDay() + 6) % 7
  const startOfWeek = startOfToday - weekday * 86400
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000
  const groups = [
    { id: 'active', label: '进行中', items: [] },
    { id: 'today', label: '今天', items: [] },
    { id: 'yesterday', label: '昨天', items: [] },
    { id: 'week', label: '本周', items: [] },
    { id: 'month', label: '本月', items: [] },
    { id: 'earlier', label: '更早', items: [] }
  ]
  const byId = Object.fromEntries(groups.map((group) => [group.id, group]))
  for (const session of sessions) {
    const active = session.status === 'recording' || session.status === 'processing' || session.status === 'queued'
    const stamp = session.started_at || session.created_at || 0
    if (active) byId.active.items.push(session)
    else if (stamp >= startOfToday) byId.today.items.push(session)
    else if (stamp >= startOfYesterday) byId.yesterday.items.push(session)
    else if (stamp >= startOfWeek) byId.week.items.push(session)
    else if (stamp >= startOfMonth) byId.month.items.push(session)
    else byId.earlier.items.push(session)
  }
  return groups.filter((group) => group.items.length > 0)
}

export function mergeTranscripts(detail) {
  if (!detail) return []
  const saved = Array.isArray(detail.transcripts) ? detail.transcripts : []
  const previews = (Array.isArray(detail.transcript_previews) ? detail.transcript_previews : [])
    .filter((part) => (part.text || '').trim().length > 0)
  if (previews.length === 0) return saved
  const overlaps = (row, part) =>
    (row.start < part.end && part.start < row.end) || Math.abs(row.start - part.start) < 0.001
  const recording = detail.recording || detail.processing
  const keptSaved = recording
    ? saved.filter((row) => !previews.some((part) => overlaps(row, part)))
    : saved
  const keptPreviews = recording
    ? previews
    : previews.filter((part) => !saved.some((row) => overlaps(row, part)))
  const mapped = keptPreviews.map((part, index) => ({
    id: `preview-${part.chunk_id || index}`,
    start: part.start,
    end: part.end,
    text: part.text,
    speaker: part.speaker || null,
    preview: true
  }))
  return [...keptSaved, ...mapped].sort((a, b) => (a.start === b.start ? a.id - b.id : a.start - b.start))
}

export function speakerName(detail, raw) {
  if (!raw) return ''
  return detail?.speakers?.[raw] || raw
}

// One transcript row as plain text, matching what the reading view shows:
// time code first, then the speaker name when known.
export function transcriptLine(row, detail) {
  const text = String(row?.text || '').trim()
  if (!text) return ''
  const speaker = speakerName(detail, row?.speaker)
  const time = clock(row?.start)
  return speaker ? `[${time}] ${speaker}：${text}` : `[${time}] ${text}`
}

export function transcriptText(rows, detail) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => transcriptLine(row, detail))
    .filter(Boolean)
    .join('\n')
}
