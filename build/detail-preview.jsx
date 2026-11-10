// Temporary visual preview for the partial-transcription redesign.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SessionDetail } from '../client-src/components/SessionDetail.jsx'
import { translator } from '../client-src/lib/i18n.js'
import { installStyles } from '../client-src/lib/styles.js'
import css from '../client-src/styles.css'

installStyles(css)

const DURATION = 2746.62
const BANDS = [
  [782.7, 888.2], [988.8, 1089.1], [1243.0, 1341.5], [1484.2, 1585.2],
  [1702.4, 1812.2], [1965.7, 2043.6], [2177.4, 2269.7], [2371.2, 2457.2],
  [2555.8, 2696.2]
]

const LINES = [
  '还有的就是我们交付的时候呢，跟我们当时说的那个东西。',
  '也也有差距，这个是呃开发阶段，然后还有就是发布的阶段了。',
  '我们的白皮书其实是我们作为我们交付给市场最重要的那一份儿的东西。',
  '东西交付的时间也比较晚，质量呢也不是特别高。',
  '呃大家反馈的时候，我们跟市场之间其实有一个这样的交接的界面。',
  '就是执行的，我觉得说工作能够困扰。',
  '不能说叫做防微杜渐，因为有的时候就我们部门儿里啊。',
  '就是经常，因为我们也属于平台型或者集散地嘛。',
  '不是有的时候就是他会牵扯的很糊涂，就是分不清楚线。',
  '我们最近也在针对这个情况在重新努力嗯。'
]

const failures = []
const totalFailureSeconds = BANDS.reduce((sum, [start, end]) => sum + (end - start), 0)
let allocated = 0
BANDS.forEach(([start, end], bandIndex) => {
  const count = bandIndex === BANDS.length - 1
    ? 136 - allocated
    : Math.round(136 * (end - start) / totalFailureSeconds)
  allocated += count
  const step = (end - start) / count
  for (let index = 0; index < count; index += 1) {
    failures.push({
      chunk_id: `band-${bandIndex}-${index}`,
      start: start + step * index,
      end: start + step * (index + 1),
      error: 'MiMo 请求失败（HTTP 429）'
    })
  }
})

const done = []
let cursor = 0
for (const failure of failures) {
  if (failure.start > cursor + 0.05) done.push([cursor, failure.start])
  cursor = Math.max(cursor, failure.end)
}
if (DURATION > cursor + 0.05) done.push([cursor, DURATION])

const doneTotal = done.reduce((sum, [start, end]) => sum + (end - start), 0)
const transcripts = []
let assigned = 0
done.forEach(([start, end], regionIndex) => {
  const count = regionIndex === done.length - 1
    ? 334 - assigned
    : Math.max(1, Math.round(334 * (end - start) / doneTotal))
  assigned += count
  const step = (end - start) / count
  for (let index = 0; index < count; index += 1) {
    const rowStart = start + step * index
    const rowEnd = start + step * (index + 1)
    transcripts.push({
      id: transcripts.length + 1,
      session_id: 's3',
      start: rowStart,
      end: rowEnd,
      speaker: null,
      text: LINES[transcripts.length % LINES.length]
    })
  }
})

const detail = {
  id: 's3',
  title: 'OS 婵儿',
  kind: 'meeting',
  status: 'error',
  duration: DURATION,
  created_at: 1793857836,
  started_at: 1793857836,
  media_path: 'media.m4a',
  has_video: false,
  recording: false,
  processing: false,
  queued: false,
  notes: '',
  notes_version: 0,
  marks: [],
  screenshots: [],
  speakers: {},
  transcripts,
  transcript_previews: [],
  asr_status: 'partial',
  asr_failures: failures,
  error: `有 ${failures.length} 个音频片段未完成转录，可补转录`,
  asr_engine: { provider: 'mimo', base_url: 'https://api.llm.mioffice.cn/v1', model: 'xiaomi/mimo-v2.5-asr' },
  meta: {
    asr_engine: { provider: 'mimo', base_url: 'https://api.llm.mioffice.cn/v1', model: 'xiaomi/mimo-v2.5-asr' },
    diarize: true,
    hotwords: '',
    language_hint: '',
    cloud_run: { id: 'previewrun', state: 'running', replace_existing: false },
    asr_status: 'partial',
    asr_failures: failures
  },
  minutes: { state: 'idle', state_text: '', version: 0, updated_at: 0, covered: 0, kind: 'final' }
}

const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })
window.fetch = async (input) => {
  const target = String(input)
  if (target.includes('/api/sessions/s3')) return json(detail)
  return json({})
}
window.EventSource = class { close() {} }
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}

const t = translator('zh-CN')
createRoot(document.getElementById('root')).render(
  React.createElement(
    'div',
    { className: 'mc-root', style: { height: '100vh' } },
    React.createElement(
      'div',
      { className: 'mc-workspace' },
      React.createElement(
        'section',
        { className: 'mc-content' },
        React.createElement(SessionDetail, {
          sessionId: 's3',
          summary: { id: 's3', title: detail.title, duration: DURATION, status: detail.status, kind: detail.kind },
          t,
          backendStopped: false,
          onBackendRefresh: () => {},
          focus: null,
          onChanged: () => {},
          onToast: () => {}
        })
      )
    )
  )
)
