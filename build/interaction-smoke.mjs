import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const TestRenderer = require('react-test-renderer')
const { act } = TestRenderer

const sessions = [
  {
    id: 's1', title: '发布会回放', kind: 'live', status: 'done', created_at: 1793000000,
    started_at: 1793000000, duration: 120, transcripts: 1, marks: 1, screenshots: 1,
    queue_position: null, source_url: 'https://example.com/live'
  },
  {
    id: 's2', title: '产品会议', kind: 'meeting', status: 'processing', created_at: 1792900000,
    duration: 300, transcripts: 0, marks: 0, screenshots: 0, queue_position: 2
  }
]

const notesBlock = `<!-- meetclip:minutes:begin -->
# 会议纪要 · 预算评审
> 由 AI 根据转写自动生成，可直接编辑；「重新整理」会覆盖本节。

## 结论和待办
1. 压缩开支 [00:20](meetclip://seek/20)
- [ ] 补预算表（发言人 1）

## 总结
确认了预算缺口。

## 主题
### [00:12](meetclip://seek/12) 预算缺口
缺口二十万
- [00:12](meetclip://seek/12) 缺口二十万

## 人名和术语
- **会摘** 产品名（听作：会窄）
<!-- meetclip:minutes:end -->

这里有笔记`

const detail = {
  id: 's1', title: '发布会回放', kind: 'live', status: 'done', duration: 120,
  created_at: 1793000000, started_at: 1793000000, notes: notesBlock, notes_version: 3,
  minutes: { state: 'idle', state_text: '', version: 3, updated_at: 1793000300, covered: 120,
    kind: 'final', scenario: 'meeting', queued: false },
  minutes_notes_version: 3, minutes_scenario: 'meeting',
  source_url: 'https://example.com/live', media_path: 'media.mp4', has_video: true,
  recording: false, processing: false, queue_position: null,
  speakers: { S1: '发言人 1' },
  transcripts: [
    { id: 1, session_id: 's1', start: 0, end: 5, text: '大家好，这是第一段。', speaker: 'S1' },
    { id: 2, session_id: 's1', start: 5, end: 10, text: '第二段内容。', speaker: 'S1' }
  ],
  marks: [{ id: 1, session_id: 's1', ts: 2, note: '重点', created_at: 1793000010 }],
  screenshots: [{ id: 1, session_id: 's1', ts: 3, path: 'shots/a.jpg', ocr_text: 'OCR' }],
  live: null, asr_status: 'ready'
}

const homePayload = {
  stats: { total: 2, week: 1, duration: 7200, recording: 0, unreviewed: 1, marks: 1 },
  items: [
    { id: 's1', title: '发布会回放', kind: 'live', status: 'done', duration: 120, created_at: 1793000000, started_at: 1793000000, source_url: 'https://example.com/live', platform: 'bilibili', transcripts: 2, marks: 1, screenshots: 1, has_notes: true, unreviewed: false, cover: null, snippet: '大家好，这是第一段。' },
    { id: 's2', title: '产品会议', kind: 'meeting', status: 'done', duration: 3600, created_at: 1792900000, started_at: 1792900000, source_url: '', platform: '', transcripts: 0, marks: 0, screenshots: 0, has_notes: false, unreviewed: true, cover: null, snippet: '' }
  ],
  highlights: [{ id: 1, session_id: 's1', session_title: '发布会回放', kind: 'live', ts: 2, note: '重点', created_at: 1793000010 }],
  batches: [],
  documents: [{
    id: 'doc:doc-1', key: 'doc-1', title: '会议纪要：物模型白皮书',
    url: 'https://example.feishu.cn/docx/ExampleDocToken1',
    doc_type: 'docx', has_content: true, updated_at: 1793000500,
    path: '会摘卡片/会议纪要：物模型白皮书.md'
  }],
  packs: []
}
const packState = homePayload.packs
let packCounter = 0

function packMemberSnapshot(type, id) {
  if (type === 'session') {
    const item = homePayload.items.find((row) => row.id === id)
    return item ? {
      type, id, title: item.title, kind: item.kind, status: item.status,
      duration: item.duration, created_at: item.created_at, active: false
    } : null
  }
  if (type === 'highlight') {
    const item = homePayload.highlights.find((row) => String(row.id) === String(id))
    return item ? {
      type, id: String(id), title: item.note, subtitle: item.session_title, kind: item.kind,
      status: 'done', session_id: item.session_id, session_title: item.session_title,
      ts: item.ts, created_at: item.created_at
    } : null
  }
  if (type === 'note') return { type, id, title: '临时便利签', subtitle: '便利签', kind: 'note', status: 'done', created_at: 1793000100 }
  if (type === 'image') return { type, id, title: '图片卡', kind: 'image', status: 'done', width: 600, height: 400, created_at: 1793000200 }
  if (type === 'batch') {
    const item = homePayload.batches.find((row) => row.id === id)
    return item ? { type, id, title: item.title, kind: 'link_video', status: 'done', count: item.total, active: item.active, created_at: item.created_at } : null
  }
  if (type === 'doc') {
    const item = homePayload.documents.find((row) => row.id === id)
    return item ? {
      type, id, title: item.title, subtitle: item.doc_type, kind: 'doc', status: 'done',
      url: item.url, doc_type: item.doc_type, has_content: item.has_content, created_at: item.updated_at
    } : null
  }
  return null
}

function packFromMembers(pack, members) {
  const rows = (members || []).map((member) => packMemberSnapshot(member.type, member.id)).filter(Boolean)
  pack.members = rows
  pack.count = rows.length
  pack.active_count = rows.filter((row) => row.active).length
  pack.updated_at = Date.now() / 1000
  return pack
}

function packFor(id) {
  return packState.find((row) => String(row.id) === String(id)) || null
}

const nowSeconds = Math.floor(Date.now() / 1000)
const todayKey = new Date().toISOString().slice(0, 10)
const calendarEvent = {
  id: 'e1', title: '联调会议', source: 'local', start: nowSeconds, end: nowSeconds + 3600,
  all_day: false, start_date: todayKey, end_date: todayKey, timezone: 'Asia/Shanghai',
  location: '会议室', description: '', cancelled: false, deleted: false, notes: '',
  notes_version: 0, record_count: 0, response_status: null, is_recurring: false
}

const statusPayload = {
  ok: true, version: '0.1.0',
  backend: { state: 'running', phase: 'ready', port: 8321, pid: 100, mode: 'managed', version: 3, restarts: 0, lastError: '' },
  env: { ready: true, mlx: true, version: '3.12', venvDir: '/tmp/venv', venvPython: '/tmp/venv/bin/python', python: '/tmp/venv/bin/python', exists: true, job: null },
  locations: { dataDir: '/tmp/data', dataDirCanonical: '/tmp/data-store', stateDir: '/tmp/state', port: 8321, venv: '/tmp/venv', tokenPresent: true, dataDirExists: true, dataDirWritable: true, venvReady: true },
  library: { id: 'work', name: '工作', dataDir: '/tmp/data', virtual: false },
  libraries: [
    { id: 'work', name: '工作', dataDir: '/tmp/data', active: true, exists: true, hasLibrary: true, records: 2, lastOpenedAt: 1793000000 },
    { id: 'life', name: '生活', dataDir: '/tmp/life', active: false, exists: true, hasLibrary: true, records: 5, lastOpenedAt: 1792900000 }
  ],
  sharedDir: '/tmp/shared',
  prefs: {}, config: { backendMode: 'auto', autoStart: false, tools: true }
}

function json(data, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(data) }
}

globalThis.window = {
  __ModuleLoader__: { load(entry) { globalThis.__entry = entry } },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}
globalThis.self = globalThis.window
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.styles = { insert: () => () => {} }
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null,
  createElement: (tag) => tag === 'video' ? { canPlayType: () => '' } : { addEventListener() {}, removeEventListener() {} }
}
const clipboardWrites = []
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', clipboard: { writeText: async (text) => { clipboardWrites.push(String(text)) } } }, configurable: true })
} catch {}
const minutesPayload = {
  title: '预算评审', summary: '确认了预算缺口。', state: 'idle', state_text: '', final: true, covered: 120,
  topics: [{ start: 12, title: '预算缺口', summary: '缺口二十万', points: [{ text: '缺口二十万', t: 12, support: 2 }], fishbone: null }],
  conclusions: [{ text: '压缩开支', t: 20, support: 1 }],
  todos: [{ text: '补预算表', owner: '发言人 1', t: 30, support: 1 }],
  terms: [{ name: '会摘', note: '产品名', heard: ['会窄'] }],
  interactions: {
    todos: {},
    highlights: [{
      id: 'h-smoke', quote: '缺口二十万', fragments: [{ text: '缺口二十万', before: '', after: '' }],
      section: 'topics', topic: '预算缺口', t: 12, at: 1793000300
    }],
    updated_at: 1793000300, version: 1
  }
}

globalThis.EventSource = class {
  constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; this.closed = false }
  close() { this.closed = true }
}
const deleteCalls = []
const renameCalls = []
const interactionCalls = []
const linkBatchBodies = []
const meetingImportBodies = []
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  if (target.includes('/api/meetings/import-batch')) {
    const body = JSON.parse(String(options.body || '{}'))
    meetingImportBodies.push(body)
    const results = (body.items || []).map((item, index) => ({
      ok: true,
      id: `import-${meetingImportBodies.length}-${index}`,
      name: String(item.path || '').split('/').pop(),
      title: item.title,
      queue_position: index + 1
    }))
    return json({
      ok: true,
      results,
      ids: results.map((row) => row.id),
      pack: {
        id: 'pack-batch-import',
        title: body.pack_title || '会议录音 · 测试',
        count: results.length,
        active_count: results.length,
        created_at: 1793000600,
        members: results.map((row) => ({
          type: 'session', id: row.id, title: row.title, kind: 'meeting', status: 'queued', active: true
        }))
      },
      pack_error: ''
    })
  }
  if (target.includes('/api/link-videos/preview')) {
    return json({ ok: true, platform: 'bilibili', title: '预览视频', subtitle_status: 'none' })
  }
  if (target.includes('/api/link-videos/batch')) {
    const body = JSON.parse(String(options.body || '{}'))
    linkBatchBodies.push(body)
    const urls = (body.items || []).map((item) => item.url)
    if (urls.some((value) => value.includes('dupe')) && !body.items.every((item) => item.allow_duplicate)) {
      return json({
        ok: false,
        results: urls.map((value) => ({
          ok: false, duplicate: true, url: value, message: '已有相同链接，可确认后再次添加'
        }))
      }, false, 400)
    }
    const seed = linkBatchBodies.length
    const results = urls.map((value, index) => ({
      ok: true, id: `lb${seed}-${index}`, title: `批量视频 ${seed}-${index + 1}`, url: value
    }))
    const previous = body.batch_id
      ? homePayload.batches.find((batch) => batch.id === body.batch_id)
      : null
    const batch = previous
      ? { ...previous, total: previous.members.length + results.length }
      : { id: `batch-${seed}`, title: '批量视频 · 测试', created_at: 1793000400, total: results.length }
    const members = results.map((row) => ({
      id: row.id, title: row.title, status: 'pending', platform: 'bilibili',
      source_url: row.url, duration: 0, error: ''
    }))
    if (previous) {
      previous.members = [...previous.members, ...members]
      previous.total = previous.members.length
    } else {
      homePayload.batches = [{
        ...batch, active: members.length,
        counts: { queued: members.length, processing: 0, done: 0, error: 0, cancelled: 0 },
        members
      }, ...homePayload.batches]
    }
    return json({ ok: true, results, batch })
  }
  if (target.includes('/minutes/interactions')) {
    const method = String(options.method || 'GET').toUpperCase()
    if (method === 'PUT') {
      let body = {}
      try { body = JSON.parse(String(options.body || '{}')) } catch {}
      interactionCalls.push(body)
      return json({ ok: true, interactions: { ...minutesPayload.interactions, ...body }, notes_sync: { synced: false } })
    }
    if (method === 'DELETE') return json({ ok: true, interactions: { todos: {}, highlights: [] } })
    return json({ ok: true, interactions: minutesPayload.interactions })
  }
  if (target.includes('/api/packs')) {
    const method = String(options.method || 'GET').toUpperCase()
    let body = {}
    try { body = options.body ? JSON.parse(String(options.body)) : {} } catch {}
    const memberMatch = target.match(/\/api\/packs\/([^/]+)\/members(\/remove)?$/)
    if (memberMatch) {
      const pack = packFor(decodeURIComponent(memberMatch[1]))
      if (!pack) return json({ detail: '卡包不存在' }, false, 404)
      if (method === 'POST' && memberMatch[2]) {
        const wanted = body.members || []
        pack.members = pack.members.filter((row) => !wanted.some((member) => member.type === row.type && String(member.id) === String(row.id)))
        packFromMembers(pack, pack.members.map((row) => ({ type: row.type, id: row.id })))
        return json({ ok: true, pack })
      }
      if (method === 'POST') {
        const wanted = body.members || []
        for (const member of wanted) {
          if (!pack.members.some((row) => row.type === member.type && String(row.id) === String(member.id))) {
            const snap = packMemberSnapshot(member.type, member.id)
            if (snap) pack.members.push(snap)
          }
        }
        packFromMembers(pack, pack.members.map((row) => ({ type: row.type, id: row.id })))
        return json({ ok: true, pack })
      }
      if (method === 'DELETE') {
        const wanted = body.members || []
        pack.members = pack.members.filter((row) => !wanted.some((member) => member.type === row.type && String(member.id) === String(row.id)))
        packFromMembers(pack, pack.members.map((row) => ({ type: row.type, id: row.id })))
        return json({ ok: true, pack })
      }
      return json({ detail: 'not mocked' }, false, 404)
    }
    const idMatch = target.match(/\/api\/packs\/([^/]+)/)
    if (method === 'POST' && !idMatch) {
      const id = body.id || `pack-${++packCounter}`
      let pack = packFor(id)
      if (!pack) {
        pack = { id, title: body.title || `卡包 ${packState.length + 1}`, created_at: Date.now() / 1000, updated_at: Date.now() / 1000 }
        packFromMembers(pack, body.members || [])
        packState.push(pack)
      }
      homePayload.packs = packState
      return json({ ok: true, pack })
    }
    if (idMatch) {
      const pack = packFor(decodeURIComponent(idMatch[1]))
      if (!pack) return json({ detail: '卡包不存在' }, false, 404)
      if (method === 'GET') return json({ ok: true, pack })
      if (method === 'PATCH') {
        if (body.title) pack.title = String(body.title)
        pack.updated_at = Date.now() / 1000
        return json({ ok: true, pack })
      }
      if (method === 'DELETE') {
        const index = packState.indexOf(pack)
        if (index >= 0) packState.splice(index, 1)
        homePayload.packs = packState
        return json({ ok: true, id: pack.id, title: pack.title, members: pack.members.map((row) => ({ type: row.type, id: row.id })) })
      }
    }
    return json({ detail: 'not mocked' }, false, 404)
  }
  if (String(options.method || 'GET').toUpperCase() === 'DELETE') {
    deleteCalls.push(target)
    return json({ ok: true })
  }
  if (target.includes('/app/status')) return json(statusPayload)
  if (target.includes('/app/feishu/status')) {
    return json({
      ok: true,
      runtime: { npxOk: true, nodeOk: true, node: '/usr/bin/node', nodeVersion: '24.0.0' },
      dsh: { entryPresent: true, entryLive: true, conflict: false, serverName: 'feishu' },
      auth: { loggedIn: true, expired: false, openId: 'ou_****1234', accessExpiresAt: 1799999999, refreshExpiresAt: 1799999999 },
      job: null
    })
  }
  if (target.includes('/app/feishu/doc-preview')) {
    return json({
      ok: true,
      title: '会议纪要：物模型白皮书',
      doc_type: 'docx',
      document_id: 'ExampleDocToken1',
      revision: '2',
      has_content: true,
      content_chars: 2236,
      excerpt: '🎉 总结 传播策略与白皮书发布。',
      link_only: false,
      warning: ''
    })
  }
  if (target.includes('/app/feishu/doc-card')) {
    return json({ ok: true, created: true, link_only: false, warning: '', card: { title: '会议纪要：物模型白皮书', path: '会摘卡片/会议纪要：物模型白皮书.md' } })
  }
  if (target.includes('/app/workspace')) {
    const workspacePath = new URL(target, 'http://127.0.0.1').searchParams.get('path')
    if (workspacePath === '/tmp/data-store') {
      return json({ ok: true, available: true, path: workspacePath, workspace: { id: 'ws-meetclip', path: workspacePath, title: '会摘资料' } })
    }
    return json({ ok: true, available: true, workspace: null })
  }
  if (target.includes('/app/libraries')) {
    return json({
      ok: true, active: 'work', sharedDir: '/tmp/shared', virtual: false, maxLibraries: 24,
      libraries: [
        { id: 'work', name: '工作', dataDir: '/tmp/data', active: true, exists: true, hasLibrary: true, records: 2, lastOpenedAt: 1793000000 },
        { id: 'life', name: '生活', dataDir: '/tmp/life', active: false, exists: true, hasLibrary: true, records: 5, lastOpenedAt: 1792900000 }
      ]
    })
  }
  if (target.includes('/app/data-dir/inspect')) {
    return json({
      ok: true, path: '/tmp/new-store', exists: true, isDirectory: true, writable: true,
      hasLibrary: false, empty: true, entryCount: 0, sameDevice: true,
      isCurrent: false, insideCurrent: false, containsCurrent: false
    })
  }
  if (target.includes('/api/sticky-notes')) return json([{ id: 'n1', text: '临时便利签', kind: 'note', checked: [], x: 180, y: 420, created_at: 1793000100 }])
  if (target.includes('/api/board/images')) return json([{ id: 'img1', path: 'board-images/img1.png', width: 600, height: 400, x: 300, y: 300, created_at: 1793000200 }])
  if (target.includes('/api/home')) return json(homePayload)
  if (target.includes('/minutes')) return json(minutesPayload)
  if (target.includes('/speakers/plan')) return json({ speakers: [], has_numbers: false, total: 0, can_undo: false })
  if (target.includes('/api/models/catalog')) return json({ models: ['demo-asr', 'demo-flash', 'gpt-4o', 'text-embedding-3-small'], count: 4, has_key: true, error: '' })
  if (target.includes('/api/ai/status')) return json({ provider: 'mimo', provider_name: '默认网关（OpenAI 兼容）', base_url: 'https://gateway.example.test/v1', model: 'demo-text', has_key: false, key_masked: '', credential_error: '', json_mode: true, providers: [], minutes_auto: 'final', minutes_interval: 120, notes_language: '简体中文', minutes_language: '简体中文', auto_end_silence: 'prompt', auto_end_after: 600, languages: ['简体中文'] })
  if (String(options.method || 'GET').toUpperCase() === 'PATCH' && /\/api\/sessions\/[^/]+$/.test(target)) {
    let body = {}
    try { body = JSON.parse(String(options.body || '{}')) } catch {}
    const id = decodeURIComponent(target.split('/').pop())
    renameCalls.push({ id, title: body.title })
    const item = homePayload.items.find((row) => row.id === id)
    if (item) item.title = body.title
    const session = sessions.find((row) => row.id === id)
    if (session) session.title = body.title
    if (detail.id === id) detail.title = body.title
    return json({ ok: true, title: body.title })
  }
  if (target.includes('/api/sessions/s1')) return json(detail)
  if (target.includes('/api/sessions/s2')) return json({ ...detail, id: 's2', title: '产品会议', kind: 'meeting', status: 'processing' })
  if (target.includes('/api/sessions')) return json(sessions)
  if (target.includes('/app/pick-file')) return json({
    ok: true,
    path: '/tmp/meeting.mp4',
    paths: ['/tmp/meeting.mp4', '/tmp/meeting-2.m4a'],
    bytes: 1024
  })
  if (target.includes('/api/meeting/options')) return json({ languages: [{ id: '', name: '自动' }, { id: 'zh', name: '中文' }], aligner_ready: true, aligner_state: 'ready', asr_ready: true, asr_provider: 'mimo', hotwords_supported: false, diarize: { available: false, package: true, model_ready: false, model_state: 'ready', reason: '模型未下载' } })
  if (target.includes('/api/deps/install/status')) return json({ running: false, done: true, log: '', step: '完成', error: '' })
  if (target.includes('/api/deps')) return json({ yt_dlp: true, ffmpeg: true, asr: true, asr_runtime: true, ready: true })
  if (target.includes('/api/asr/engines')) return json({ default_provider: 'mimo', base_url: 'https://gateway.example.test/v1', model: 'demo-asr', default_model: 'demo-asr', default_has_key: true, has_api_key: true, custom: { base_url: '', model: '', enabled: false, has_key: false }, credential_error: '', ready: true })
  if (target.includes('/api/douyin/status')) return json({ saved: true, count: 3, updated_at: 1793000300, browser: 'chrome', last_url: 'https://v.douyin.com/6DFF61GmvhI/' })
  if (target.includes('/api/settings')) return json({ shot_sensitivity: 0.5, shot_threshold: 3.9, link_browser_cookies: false, link_cookie_browser: 'chrome', link_max_height: 0 })
  if (target.includes('/api/bilibili/status')) return json({ logged_in: false, uname: '', error: '' })
  if (target.includes('/api/asr/status') || target.includes('/api/aligner/status') || target.includes('/api/diarize/status')) return json({ state: 'ready', downloaded: 100, total: 100, speed: 0, eta: 0, error: '', endpoint: '', current_file: '', model: 'm', repo: 'r', runtime: true, runtime_message: '', ready: true, bundled: false, size_on_disk: 100 })
  if (target.includes('/api/cards/sync')) return json({ ok: true, total: 1, created: 0, updated: 1, removed: 0, skipped: 0 })
  if (target.includes('/api/cards')) {
    const parsed = new URL(target, 'http://127.0.0.1')
    const id = parsed.searchParams.get('id') || 's1'
    const isPack = id.startsWith('pack:')
    return json({
      ok: true, total: 1, returned: 1,
      cards: [{
        id,
        title: isPack ? '测试卡包' : '发布会回放',
        kind: isPack ? 'pack' : 'live',
        status: 'done',
        path: isPack ? `会摘卡片/卡包/${id.split(':')[1]}.md` : '会摘卡片/发布会回放.md'
      }]
    })
  }
  if (target.includes('/api/search')) return json({ total: 0, counts: {}, results: [], has_more: false })
  if (target.includes('/api/calendar/range')) return json({ events: [calendarEvent], records: [] })
  if (target.includes('/api/calendar/configuration')) return json({ account: null, calendars: [], sync: { running: false, progress: 0, message: '', error: '' } })
  if (target.includes('/api/calendar/events/e1')) return json({ ...calendarEvent, records: [], quotes: [] })
  return json({ detail: 'not mocked' }, false, 404)
}

vm.runInThisContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
if (!globalThis.__entry) throw new Error('loader not called')
const plugin = globalThis.__entry.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require ' + name)
})
const slots = {}
const agentCalls = []
const agentDrafts = []
let agentPromptResult = { ok: true }
const agentConversation = {
  input: {
    shell(sessionId) {
      agentCalls.push(['shell', sessionId])
      return {
        setDraft(draft) { agentDrafts.push(draft) },
        focus() { agentCalls.push(['focus', sessionId]) }
      }
    }
  }
}
const agentSessions = {
  async create(options) {
    agentCalls.push(['create', options])
    return 'session-agent-1'
  },
  async using(sessionId, options, operation) {
    agentCalls.push(['using', sessionId, options])
    return operation({
      binding: {
        session: {
          async prompt(content, mode) {
            agentCalls.push(['prompt', content, mode])
            return agentPromptResult
          }
        }
      }
    })
  }
}
const agentWorkspace = {
  openSession(sessionId) { agentCalls.push(['open', sessionId]) }
}
plugin.apply({
  get: () => undefined,
  effect: (callback) => callback(),
  inject: (names, callback) => {
    if (!names.includes('uiWorkspace')) return { dispose() {} }
    const services = { sessions: agentSessions, uiWorkspace: agentWorkspace, conversation: agentConversation }
    callback({
      ...services,
      get: (name) => services[name],
      effect: (fn) => { const dispose = fn(); return dispose }
    })
    return { dispose() {} }
  },
  slots: {
    inject: (_slot, callback) => callback(),
    register: (options, Component) => { slots[options.name] = { options, Component }; return () => {} }
  }
})

const t = (key) => key
function textOf(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (value && typeof value === 'object' && value.props) return textOf(value.props.children)
  return ''
}
async function flush(ms = 80) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }

let renderer
try {
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(slots.main.Component, { t }))
  })
  await flush(150)
  let text = JSON.stringify(renderer.toJSON())
  if (!renderer.root.findAll((node) => node.props?.className === 'mc-image-card').length) throw new Error('Board image card missing')
  for (const expected of ['你留下了', '发布会回放', '重点', '临时便利签', '会议纪要：物模型白皮书', '正文已收录']) {
    if (!text.includes(expected)) throw new Error('Home missing ' + expected)
  }
  if (text.includes('未整理')) throw new Error('Home still shows unreviewed')
  // 顶栏搜索入口：Hero 不再承担搜索，搜索由顶栏按钮与 ⌘K 提供。
  const searchTrigger = renderer.root.findAll((node) => node.props?.className === 'mc-search-trigger')[0]
  if (!searchTrigger) throw new Error('Top bar search trigger missing')
  await act(async () => { searchTrigger.props.onClick() })
  await flush(120)
  text = JSON.stringify(renderer.toJSON())
  if (!text.includes('搜索记录、转写与笔记')) throw new Error('Search dialog did not open')
  const closeSearch = renderer.root.findAllByType('button')
    .find((node) => node.props['aria-label'] === '关闭' && String(node.props.className || '').includes('mc-icon-button'))
  if (!closeSearch) throw new Error('Search dialog close missing')
  await act(async () => { closeSearch.props.onClick() })
  await flush(80)

  // ＋ 只弹三入口菜单，不再直接选文件；选「会议录音」后才走文件选择流程（支持多选）。
  let plusButton = renderer.root.findAllByType('button').find((node) => node.props['data-testid'] === 'hero-new-capture')
  if (!plusButton) throw new Error('Home plus button missing')
  await act(async () => { plusButton.props.onClick() })
  await flush(60)
  const plusMenu = renderer.root.findAll((node) => String(node.props?.className || '').includes('mc-home-plus-menu'))[0]
  if (!plusMenu) throw new Error('Hero capture menu missing')
  const menuKinds = plusMenu.findAllByType('button').map((node) => node.props['data-kind'])
  if (menuKinds.join(',') !== 'launch,video,meeting,doc') throw new Error('Hero capture menu entries wrong: ' + menuKinds)
  const meetingEntry = plusMenu.findAllByType('button').find((node) => node.props['data-kind'] === 'meeting')
  await act(async () => { meetingEntry.props.onClick() })
  await flush(150)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['会议录音', 'meeting.mp4', 'meeting-2.m4a', '会议录音 ·']) {
    if (!text.includes(expected)) throw new Error('Inline meeting panel missing ' + expected)
  }
  if (!renderer.root.findAllByType('button').some((node) => node.props['data-new-submit'] === 'true')) {
    throw new Error('Meeting import submit button missing')
  }
  if (text.includes('new.hotwords')) throw new Error('Inline meeting panel still renders hotwords')
  if (!renderer.root.findAll((node) => node.props?.className === 'mc-file-field').length) throw new Error('Meeting file row missing')
  const fileRow = renderer.root.findAll((node) => node.props?.className === 'mc-file-row')[0]
  if (!fileRow) throw new Error('Meeting file row content missing')
  if (renderer.root.findAll((node) => node.props?.className === 'mc-file-item').length !== 2) {
    throw new Error('Meeting batch file list should render two selected files')
  }
  const meetingSubmit = renderer.root.findAllByType('button').find((node) => node.props['data-new-submit'] === 'true')
  if (!meetingSubmit) throw new Error('Meeting batch submit button missing')
  await act(async () => { meetingSubmit.props.onClick() })
  await flush(250)
  if (meetingImportBodies.length !== 1) throw new Error('Batch meeting import request missing')
  const importBody = meetingImportBodies[0]
  if (importBody.items.length !== 2) throw new Error('Batch meeting import should carry two files')
  if (importBody.items[0].title !== 'meeting') throw new Error('Batch meeting title should default to the file stem')
  if (importBody.pack_title !== '') throw new Error('Batch meeting pack title should be left to the server default')
  text = JSON.stringify(renderer.toJSON())
  if (!text.includes('已导入 2 个文件')) throw new Error('Batch meeting toast missing import count')
  let closeCapture = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === '关闭采集面板')
  if (closeCapture) {
    await act(async () => { closeCapture.props.onClick() })
    await flush(50)
  }

  // 第四个入口：飞书文档表单；只验证入口/表单渲染，提交由 Host 单测覆盖。
  plusButton = renderer.root.findAllByType('button').find((node) => node.props['data-testid'] === 'hero-new-capture')
  await act(async () => { plusButton.props.onClick() })
  await flush(60)
  const docEntry = renderer.root.findAllByType('button').find((node) => node.props['data-kind'] === 'doc')
  if (!docEntry) throw new Error('Hero menu missing Feishu document entry')
  await act(async () => { docEntry.props.onClick() })
  await flush(150)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['飞书文档', '仅登记链接', 'example.feishu.cn/docx']) {
    if (!text.includes(expected)) throw new Error('Inline doc panel missing ' + expected)
  }
  // 粘链接后先预读标题并填入，用户可在预读结果上修改。
  const docUrlInput = renderer.root.findAllByType('input')
    .find((node) => String(node.props.placeholder || '').includes('example.feishu.cn/docx'))
  if (!docUrlInput) throw new Error('Doc URL input missing')
  await act(async () => {
    docUrlInput.props.onChange({ target: { value: 'https://example.feishu.cn/docx/ExampleDocToken1' } })
  })
  await flush(900)
  const docTitleInput = renderer.root.findAllByType('input')
    .find((node) => node.props.value === '会议纪要：物模型白皮书')
  if (!docTitleInput) throw new Error('Doc title was not auto-filled from preview')
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['2236 字正文', '传播策略与白皮书发布']) {
    if (!text.includes(expected)) throw new Error('Doc preview card missing ' + expected)
  }
  closeCapture = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === '关闭采集面板')
  await act(async () => { closeCapture.props.onClick() })
  await flush(50)

  // Hero = Agent 对话框：回车把原文送到假会话，成功后清空；失败保留文字。
  const heroForm = () => renderer.root.findAll((node) => node.props?.className === 'mc-home-capture')[0]
  const heroInput = () => renderer.root.findAllByType('input').find((node) => node.props['data-testid'] === 'hero-agent-input')
  const firstForm = heroForm()
  const firstInput = heroInput()
  if (!firstForm || !firstInput) throw new Error('Hero agent input missing')
  await act(async () => { firstInput.props.onChange({ target: { value: '帮我总结这条发布会' } }) })
  await act(async () => { firstForm.props.onSubmit({ preventDefault() {} }) })
  await flush(200)
  const createCall = agentCalls.find(([kind]) => kind === 'create')
  if (createCall?.[1]?.workspaceId !== 'ws-meetclip') throw new Error('Agent session created in wrong workspace: ' + JSON.stringify(createCall))
  const promptCall = agentCalls.find(([kind]) => kind === 'prompt')
  if (JSON.stringify(promptCall?.[1]) !== JSON.stringify([{ type: 'text', text: '帮我总结这条发布会' }])) {
    throw new Error('Agent prompt text wrong: ' + JSON.stringify(promptCall))
  }
  if (promptCall?.[2] !== 'queue') throw new Error('Agent prompt mode wrong: ' + promptCall?.[2])
  if (!agentCalls.some(([kind, id]) => kind === 'open' && id === 'session-agent-1')) throw new Error('Agent session was not opened')
  const clearedInput = heroInput()
  if (clearedInput?.props.value !== '') throw new Error('Hero input did not clear after sending')

  agentPromptResult = { ok: false, error: { code: 'model/missing', message: '模型不可用' } }
  const openCount = agentCalls.filter(([kind]) => kind === 'open').length
  const retryForm = heroForm()
  const retryInput = heroInput()
  await act(async () => { retryInput.props.onChange({ target: { value: '这次会失败' } }) })
  await act(async () => { retryForm.props.onSubmit({ preventDefault() {} }) })
  await flush(200)
  text = JSON.stringify(renderer.toJSON())
  if (!text.includes('模型不可用')) throw new Error('Agent failure message missing')
  const keptInput = heroInput()
  if (keptInput?.props.value !== '这次会失败') throw new Error('Hero input lost text after send failure')
  if (agentCalls.filter(([kind]) => kind === 'open').length !== openCount) throw new Error('Failed Agent send opened a session')
  agentPromptResult = { ok: true }

  // 卡片悬停操作：只有「删除」，点删除先确认，确认后才发 DELETE。
  const actionTexts = renderer.root.findAll((node) => node.props?.className === 'mc-home-card-actions')
    .flatMap((node) => node.findAllByType('button').map((button) => textOf(button.props.children)))
  if (actionTexts.includes('打开')) throw new Error('Card hover action still shows 打开')
  const deleteAction = renderer.root.findAll((node) => node.props?.className === 'mc-home-card-actions')
    .flatMap((node) => node.findAllByType('button'))
    .find((node) => textOf(node.props.children) === '删除')
  if (!deleteAction) throw new Error('Card hover delete action missing')
  await act(async () => { deleteAction.props.onClick({ stopPropagation() {} }) })
  await flush(50)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['删除「', '移到废纸篓']) {
    if (!text.includes(expected)) throw new Error('Delete confirm missing ' + expected)
  }
  if (deleteCalls.length) throw new Error('Delete fired before confirmation')
  const trashButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '移到废纸篓')
  await act(async () => { trashButton.props.onClick() })
  await flush(150)
  if (!deleteCalls.some((url) => url.includes('/api/sessions/'))) throw new Error('Delete request missing after confirm')

  // 便利签、待办与图片卡提供同一套「删除」动作，不再各自画 ×。
  const boardActions = renderer.root.findAll((node) => node.props?.className === 'mc-card-actions')
  if (!boardActions.length) throw new Error('Board card actions missing')
  for (const node of boardActions) {
    if (!node.findAllByType('button').some((button) => textOf(button.props.children) === '删除')) {
      throw new Error('Board card delete action missing')
    }
  }

  // 卡片删除走应用内确认弹层：按钮是「取消 / 确认」，取消不发请求，确认才发 DELETE。
  const cardDeleteButton = (label) => renderer.root.findAll((node) => node.props?.className === 'mc-card-actions')
    .flatMap((node) => node.findAllByType('button'))
    .find((node) => node.props['aria-label'] === label)
  const buttonLabelled = (label) => renderer.root.findAllByType('button')
    .find((node) => textOf(node.props.children) === label)
  const hits = (fragment) => deleteCalls.filter((url) => url.includes(fragment))

  const stickyDelete = cardDeleteButton('删除便利签')
  if (!stickyDelete) throw new Error('Sticky delete action missing')
  await act(async () => { stickyDelete.props.onClick({ stopPropagation() {} }) })
  await flush(50)
  if (!JSON.stringify(renderer.toJSON()).includes('删除这张便利签？')) throw new Error('Sticky delete confirm missing')
  for (const expected of ['取消', '确认']) {
    if (!buttonLabelled(expected)) throw new Error('Sticky delete confirm missing button ' + expected)
  }
  await act(async () => { buttonLabelled('取消').props.onClick() })
  await flush(50)
  if (hits('/sticky-notes/n1').length) throw new Error('Sticky delete fired before confirmation')
  if (buttonLabelled('确认')) throw new Error('Sticky delete confirm stayed open after 取消')

  await act(async () => { stickyDelete.props.onClick({ stopPropagation() {} }) })
  await flush(30)
  await act(async () => { buttonLabelled('确认').props.onClick() })
  await flush(150)
  if (!hits('/sticky-notes/n1').length) throw new Error('Sticky delete request missing after 确认')

  const imageDelete = cardDeleteButton('删除图片卡')
  if (!imageDelete) throw new Error('Image delete action missing')
  await act(async () => { imageDelete.props.onClick({ stopPropagation() {} }) })
  await flush(50)
  if (!JSON.stringify(renderer.toJSON()).includes('删除这张图片卡？')) throw new Error('Image delete confirm missing')
  for (const expected of ['取消', '确认']) {
    if (!buttonLabelled(expected)) throw new Error('Image delete confirm missing button ' + expected)
  }
  if (hits('/board/images/img1').length) throw new Error('Image delete fired before confirmation')
  await act(async () => { buttonLabelled('确认').props.onClick() })
  await flush(150)
  if (!hits('/board/images/img1').length) throw new Error('Image delete request missing after 确认')

  // 菜单里的「视频链接」入口进入现有视频采集表单。
  plusButton = renderer.root.findAllByType('button').find((node) => node.props['data-testid'] === 'hero-new-capture')
  await act(async () => { plusButton.props.onClick() })
  await flush(60)
  const videoMenu = renderer.root.findAll((node) => String(node.props?.className || '').includes('mc-home-plus-menu'))[0]
  const videoEntry = videoMenu?.findAllByType('button').find((node) => node.props['data-kind'] === 'video')
  if (!videoEntry) throw new Error('Hero video entry missing')
  await act(async () => { videoEntry.props.onClick() })
  await flush(150)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['视频链接', '加入队列']) {
    if (!text.includes(expected)) throw new Error('Inline video panel missing ' + expected)
  }
  closeCapture = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === '关闭采集面板')
  await act(async () => { closeCapture.props.onClick() })
  await flush(50)

  // 链接不再自动识别：贴链接回车就是把原文发给 Agent。
  const linkInput = heroInput()
  const linkForm = heroForm()
  await act(async () => { linkInput.props.onChange({ target: { value: 'https://www.bilibili.com/video/BV1xx411c7mD' } }) })
  await act(async () => { linkForm.props.onSubmit({ preventDefault() {} }) })
  await flush(200)
  const linkPrompt = agentCalls.filter(([kind]) => kind === 'prompt').pop()
  if (JSON.stringify(linkPrompt?.[1]) !== JSON.stringify([{ type: 'text', text: 'https://www.bilibili.com/video/BV1xx411c7mD' }])) {
    throw new Error('Link prompt text wrong: ' + JSON.stringify(linkPrompt))
  }
  const fakeEvent = () => ({ preventDefault() {}, stopPropagation() {}, clientX: 12, clientY: 16 })
  const homeCardMenu = renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-home-card') && node.props?.onContextMenu)[0]
  if (!homeCardMenu) throw new Error('Home card context menu target missing')
  await act(async () => { homeCardMenu.props.onContextMenu(fakeEvent()) })
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['打开记录', '复制链接', '图钉固定']) {
    if (!text.includes(expected)) throw new Error('Home context menu missing ' + expected)
  }
  const pinButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '图钉固定')
  if (!pinButton) throw new Error('Pin action missing')
  await act(async () => { pinButton.props.onClick() })
  await flush(80)
  if (!renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('is-pinned')).length) throw new Error('Pinned card state missing')
  await act(async () => { homeCardMenu.props.onContextMenu(fakeEvent()) })
  const unpinButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '取消图钉')
  if (!unpinButton) throw new Error('Unpin action missing')
  await act(async () => { unpinButton.props.onClick() })
  await flush(80)
  if (renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('is-pinned')).length) throw new Error('Unpin did not release card')

  // ---- 右键卡片「重命名」：就地编辑，写回同一条记录（PATCH /api/sessions/<id>） ----
  const renameCard = () => renderer.root.findAll((node) => typeof node.props?.className === 'string'
    && node.props.className.includes('mc-home-card') && node.props?.onContextMenu
    && String(node.props['aria-label'] || '').startsWith('直播：'))[0]
  const openMenuOn = async (node) => {
    await act(async () => { node.props.onContextMenu(fakeEvent()) })
    await flush(50)
  }
  const clickMenuItem = async (label) => {
    const button = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === label)
    if (!button) throw new Error('Home card menu missing ' + label)
    await act(async () => { button.props.onClick() })
    await flush(60)
    return button
  }
  const renameInput = () => renderer.root.findAllByType('input')
    .find((node) => node.props['aria-label'] === '记录标题')
  const renameTo = async (title) => {
    const input = renameInput()
    if (!input) throw new Error('Inline rename input missing')
    await act(async () => { input.props.onChange({ target: { value: title } }) })
    await act(async () => {
      input.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
    })
    await flush(160)
  }
  await openMenuOn(renameCard())
  await clickMenuItem('重命名')
  if (!renameInput()) throw new Error('Rename action did not open the inline title input')
  if (renameInput().props.value !== '发布会回放') throw new Error('Rename input did not start from the record title')
  await renameTo('重命名后的回放')
  if (!renameCalls.some((call) => call.id === 's1' && call.title === '重命名后的回放')) {
    throw new Error('Rename did not patch the same record id: ' + JSON.stringify(renameCalls))
  }
  if (!textOf(renameCard().props.children).includes('重命名后的回放')) throw new Error('Home card title did not update after rename')
  // 改回原名，后面的资料库断言仍按原数据走。
  await openMenuOn(renameCard())
  await clickMenuItem('重命名')
  await renameTo('发布会回放')
  if (!renameCalls.some((call) => call.id === 's1' && call.title === '发布会回放')) throw new Error('Rename back did not reach API mock')
  if (!textOf(renameCard().props.children).includes('发布会回放')) throw new Error('Home card title did not restore after rename')

  const closeMenuButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '×' && node.props.className?.includes?.('mc-icon-button'))
  if (closeMenuButton) await act(async () => { closeMenuButton.props.onClick() })
  const scatterTab = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '散落')
  if (!scatterTab) throw new Error('Scatter tab not found')
  await act(async () => { scatterTab.props.onClick() })
  await flush(80)
  if (!renderer.root.findAll((node) => node.props?.className === 'mc-scatter').length) throw new Error('Scatter canvas missing')
  const scatterCard = renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-home-card') && node.props?.onClick)[0]
  if (!scatterCard) throw new Error('Scatter card missing')
  await act(async () => { scatterCard.props.onClick() })
  await flush(150)
  if (!renderer.root.findAll((node) => node.props?.className === 'mc-workspace').length) {
    throw new Error('Scatter card did not open the library')
  }
  if (!renderer.root.findAll((node) => node.props?.className === 'mc-item' && node.props['data-active'] === true).length) {
    throw new Error('Scatter card did not select a library row')
  }
  const scatterBack = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '首页')
  if (!scatterBack) throw new Error('Home nav missing after opening a record')
  await act(async () => { scatterBack.props.onClick() })
  await flush(120)

  // 散落画布：便利签/图片卡也一起参与避让，拖动后面临的卡片让开。
  const cardNodes = () => renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-scatter-card'))
  const keyOf = (node) => node.props['data-node']
  const rectOf = (node) => {
    const style = node.props.style || {}
    return { left: Number(style.left), top: Number(style.top), width: Number(style.width), height: Number(style.height) }
  }
  const screenOf = (rect) => ({ x: 500 + (rect.left + rect.width / 2) * 0.8, y: 358 + (rect.top + rect.height / 2) * 0.8 })
  const assertClear = (cards, where) => {
    const hero = { left: -270, top: -186, width: 540, height: 372 }
    const list = cards.map((node) => ({ key: keyOf(node), ...rectOf(node) }))
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i]
      const gapX = Math.max(hero.left, a.left) - Math.min(hero.left + hero.width, a.left + a.width)
      const gapY = Math.max(hero.top, a.top) - Math.min(hero.top + hero.height, a.top + a.height)
      if (gapX < 22 && gapY < 22) throw new Error(`${where}: ${a.key} overlaps hero (${gapX}x${gapY})`)
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j]
        const gx = Math.max(a.left, b.left) - Math.min(a.left + a.width, b.left + b.width)
        const gy = Math.max(a.top, b.top) - Math.min(a.top + a.height, b.top + b.height)
        if (gx < 22 && gy < 22) throw new Error(`${where}: ${a.key} overlaps ${b.key} (${gx}x${gy})`)
      }
    }
  }
  const pointer = (x, y) => ({
    button: 0, pointerId: 1, clientX: x, clientY: y,
    target: { closest: () => null },
    currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
    preventDefault() {}, stopPropagation() {}
  })
  const initialCards = cardNodes()
  const types = initialCards.map((node) => node.props['data-type'])
  for (const expectedType of ['session', 'highlight', 'note', 'image']) {
    if (!types.includes(expectedType)) throw new Error(`Scatter missing ${expectedType} card`)
  }
  assertClear(initialCards, 'initial scatter')

  // 筛选只隐藏卡片，不重排：往返「直播」后位置完全一致。
  const positionMap = () => Object.fromEntries(cardNodes().map((node) => [keyOf(node), rectOf(node)]))
  const beforeFilter = positionMap()
  const chips = renderer.root.findAll((node) => node.props?.className === 'mc-home-chips')[0]
  const liveChip = chips.findAllByType('button').find((node) => textOf(node.props.children).startsWith('直播'))
  await act(async () => { liveChip.props.onClick() })
  await flush(80)
  const filteredMap = positionMap()
  for (const [key, rect] of Object.entries(filteredMap)) {
    if (JSON.stringify(rect) !== JSON.stringify(beforeFilter[key])) throw new Error(`Filter moved ${key}`)
  }
  const allChip = chips.findAllByType('button').find((node) => textOf(node.props.children) === '全部')
  await act(async () => { allChip.props.onClick() })
  await flush(80)
  const restoredMap = positionMap()
  for (const [key, rect] of Object.entries(beforeFilter)) {
    if (JSON.stringify(rect) !== JSON.stringify(restoredMap[key])) throw new Error(`Restore moved ${key}`)
  }

  // 图钉卡片不能被拖动。
  const pinnedTarget = cardNodes().find((node) => node.props['data-type'] === 'session')
  const pinnedKey = keyOf(pinnedTarget)
  const pinnedRect = rectOf(pinnedTarget)
  const openCardMenu = async (node) => {
    const menuTarget = node.findAll((item) => typeof item.props?.onContextMenu === 'function')[0]
    if (!menuTarget) throw new Error('Scatter card menu target missing')
    await act(async () => { menuTarget.props.onContextMenu(fakeEvent()) })
    await flush(60)
  }
  await openCardMenu(pinnedTarget)
  const pinAction = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '图钉固定')
  if (!pinAction) throw new Error('Scatter pin action missing')
  await act(async () => { pinAction.props.onClick() })
  await flush(80)
  const pinnedCard = cardNodes().find((node) => keyOf(node) === pinnedKey)
  if (!pinnedCard.props.className.includes('is-pinned')) throw new Error('Scatter pin state missing')
  const pinnedCenter = screenOf(rectOf(pinnedCard))
  await act(async () => {
    pinnedCard.props.onPointerDown(pointer(pinnedCenter.x, pinnedCenter.y))
    pinnedCard.props.onPointerMove(pointer(pinnedCenter.x + 220, pinnedCenter.y + 140))
    pinnedCard.props.onPointerUp(pointer(pinnedCenter.x + 220, pinnedCenter.y + 140))
  })
  await flush(80)
  const stillPinned = cardNodes().find((node) => keyOf(node) === pinnedKey)
  if (JSON.stringify(rectOf(stillPinned)) !== JSON.stringify(pinnedRect)) throw new Error('Pinned card was dragged')
  await openCardMenu(stillPinned)
  const unpinAction = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '取消图钉')
  await act(async () => { unpinAction.props.onClick() })
  await flush(80)

  // 把记录卡拖到便利签上：落点保留，便利签让开，整面墙仍不重叠。
  const sessionCard = cardNodes().find((node) => node.props['data-type'] === 'session')
  const noteCard = cardNodes().find((node) => node.props['data-type'] === 'note')
  const sessionKey = keyOf(sessionCard)
  const noteKey = keyOf(noteCard)
  const noteBefore = rectOf(noteCard)
  const sessionCenter = screenOf(rectOf(sessionCard))
  const noteCenter = screenOf(noteBefore)
  await act(async () => { sessionCard.props.onPointerDown(pointer(sessionCenter.x, sessionCenter.y)) })
  await act(async () => { sessionCard.props.onPointerMove(pointer(noteCenter.x, noteCenter.y)) })
  await flush(40)
  await act(async () => { sessionCard.props.onPointerUp(pointer(noteCenter.x, noteCenter.y)) })
  await flush(120)
  const stored = JSON.parse(localStorage.getItem('meetclip.scatter.layout.v2') || '{}')
  if (!stored[sessionKey]) throw new Error('Drop did not persist layout position')
  const afterDrop = cardNodes()
  assertClear(afterDrop, 'after drag')
  const noteAfter = rectOf(afterDrop.find((node) => keyOf(node) === noteKey))
  if (JSON.stringify(noteAfter) === JSON.stringify(noteBefore)) throw new Error('Neighbour card did not move away')
  const sessionAfter = rectOf(afterDrop.find((node) => keyOf(node) === sessionKey))
  if (Math.abs(sessionAfter.left - (noteBefore.left - (sessionAfter.width - noteBefore.width) / 2)) > 4) {
    throw new Error('Dragged card did not land near the drop point')
  }

  // ---- 右键卡片：基于此卡片提问，创建会话并只预填 @ 引用 ----
  const promptCountBeforeAsk = agentCalls.filter(([kind]) => kind === 'prompt').length
  const askSessionCard = cardNodes().find((node) => keyOf(node) === 'session-s1')
  if (!askSessionCard) throw new Error('Ask source card missing')
  const askMenuTarget = askSessionCard.findAll((node) => typeof node.props?.onContextMenu === 'function')[0]
  await act(async () => { askMenuTarget.props.onContextMenu(fakeEvent()) })
  await flush(50)
  const askCardButton = renderer.root.findAllByType('button')
    .find((node) => textOf(node.props.children).startsWith('基于此卡片提问'))
  if (!askCardButton) throw new Error('Ask card menu item missing')
  await act(async () => { askCardButton.props.onClick() })
  await flush(120)
  if (!agentDrafts.length) throw new Error('Ask card did not prepare an Agent draft')
  const askDraft = agentDrafts[agentDrafts.length - 1]
  if (!askDraft.references?.[0]?.ref?.includes('发布会回放.md')) throw new Error('Ask card draft missing reference')
  if (!agentCalls.some(([kind]) => kind === 'open')) throw new Error('Ask card did not open Agent session')
  if (agentCalls.filter(([kind]) => kind === 'prompt').length !== promptCountBeforeAsk) throw new Error('Ask card should not auto-send')

  // ---- 卡包：空白右键新建、拖卡入包、拖卡叠包、筛选、撤销、解散 ----
  const stageNode = renderer.root.findAll((node) => node.props?.className === 'mc-scatter')[0]
  if (!stageNode) throw new Error('Scatter stage missing for pack menu')
  const blankEvent = {
    ...fakeEvent(),
    clientX: 760,
    clientY: 500,
    target: { closest: () => null },
    currentTarget: {}
  }
  await act(async () => { stageNode.props.onContextMenu(blankEvent) })
  await flush(60)
  const newPackButton = renderer.root.findAllByType('button')
    .find((node) => textOf(node.props.children).startsWith('新建卡包'))
  if (!newPackButton) throw new Error('Blank context menu missing 新建卡包')
  await act(async () => { newPackButton.props.onClick() })
  await flush(140)
  const packNodes = () => cardNodes().filter((node) => node.props['data-type'] === 'pack')
  const packText = (node) => {
    const article = node?.findAll((child) => typeof child.props?.className === 'string' && child.props.className.includes('mc-pack-card'))[0]
    return article ? textOf(article.props.children) : ''
  }
  let currentPack = packNodes()[0]
  if (!currentPack) throw new Error('New empty pack card missing')
  const emptyPackKey = keyOf(currentPack)
  if (!packText(currentPack).includes('把卡片拖到这里')) throw new Error('Empty pack copy missing')
  if (packState.length !== 1) throw new Error('Pack was not created through API mock')
  const packMenuTarget = currentPack.findAll((node) => typeof node.props?.onContextMenu === 'function')[0]
  await act(async () => { packMenuTarget.props.onContextMenu(fakeEvent()) })
  await flush(50)
  const askPackButton = renderer.root.findAllByType('button')
    .find((node) => textOf(node.props.children).startsWith('基于此卡包提问'))
  if (!askPackButton) throw new Error('Ask pack menu item missing')
  await act(async () => { askPackButton.props.onClick() })
  await flush(120)
  const packDraft = agentDrafts[agentDrafts.length - 1]
  if (!packDraft?.references?.[0]?.ref?.includes('/卡包/')) throw new Error('Ask pack draft missing pack reference')

  // 把便利签拖进空卡包：上膛后松手，便利签消失、卡包计数 1。
  const noteSource = cardNodes().find((node) => keyOf(node) === 'note-n1')
  if (!noteSource) throw new Error('Note source missing for pack add')
  let packTarget = cardNodes().find((node) => keyOf(node) === emptyPackKey)
  const notePoint = screenOf(rectOf(noteSource))
  const packPoint = screenOf(rectOf(packTarget))
  await act(async () => { noteSource.props.onPointerDown(pointer(notePoint.x, notePoint.y)) })
  await act(async () => { noteSource.props.onPointerMove(pointer(packPoint.x, packPoint.y)) })
  await flush(230)
  packTarget = cardNodes().find((node) => keyOf(node) === emptyPackKey)
  if (!packTarget.props.className.includes('is-pack-ready')) throw new Error('Pack add hot zone did not arm')
  if (!JSON.stringify(renderer.toJSON()).includes('松手放进卡包')) throw new Error('Pack add hint missing')
  await act(async () => { noteSource.props.onPointerUp(pointer(packPoint.x, packPoint.y)) })
  await flush(140)
  if (cardNodes().some((node) => keyOf(node) === 'note-n1')) throw new Error('Note was not folded into pack')
  currentPack = cardNodes().find((node) => keyOf(node) === emptyPackKey)
  if (!packText(currentPack).includes('1 张')) throw new Error('Pack count did not become 1')
  if (packState[0].count !== 1) throw new Error('Pack add did not reach API mock')

  // 打开卡包浮层，能看到成员；关闭。
  let packArticle = currentPack.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-pack-card'))[0]
  await act(async () => { packArticle.props.onClick() })
  await flush(80)
  if (!renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-pack-modal')).length) {
    throw new Error('Pack overlay did not open')
  }
  const firstPackModal = renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-pack-modal'))[0]
  if (!firstPackModal) throw new Error('Pack modal root missing')
  if (firstPackModal.findAll((node) => node.props?.className === 'mc-pack-row').length !== 1) {
    throw new Error('Pack overlay should render one full-card row')
  }
  if (!firstPackModal.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-sticky-card')).length) {
    throw new Error('Pack overlay did not reuse the sticky card component')
  }
  const packTitleInput = renderer.root.findAll((node) => node.props?.['aria-label'] === '卡包名称')[0]
  if (!packTitleInput) throw new Error('Pack title input missing')
  await act(async () => { packTitleInput.props.onChange({ target: { value: '本周复盘' } }) })
  await act(async () => { packTitleInput.props.onBlur() })
  await flush(120)
  if (packState[0].title !== '本周复盘') throw new Error('Pack rename did not reach API mock')
  if (!JSON.stringify(renderer.toJSON()).includes('本周复盘')) throw new Error('Pack rename did not update card/overlay')
  const closePack = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === '关闭卡包')
  if (!closePack) throw new Error('Pack overlay close button missing')
  await act(async () => { closePack.props.onClick() })
  await flush(60)

  // 「标记」筛选下，包含便利签的卡包仍显示。
  const chipRow = () => renderer.root.findAll((node) => node.props?.className === 'mc-home-chips')[0]
  const markChip = chipRow().findAllByType('button').find((node) => textOf(node.props.children).startsWith('标记'))
  await act(async () => { markChip.props.onClick() })
  await flush(60)
  if (!packNodes().length) throw new Error('Pack missing under mark filter')
  const allChipAgain = chipRow().findAllByType('button').find((node) => textOf(node.props.children) === '全部')
  await act(async () => { allChip.props.onClick() })
  await flush(60)

  // 图片卡拖到直播卡上：热区上膛后合成第二个卡包。
  const imageSource = cardNodes().find((node) => keyOf(node) === 'image-img1')
  const liveTarget = cardNodes().find((node) => keyOf(node) === 'session-s1')
  if (!imageSource || !liveTarget) throw new Error('Pack merge source/target missing')
  const imagePoint = screenOf(rectOf(imageSource))
  const livePoint = screenOf(rectOf(liveTarget))
  await act(async () => { imageSource.props.onPointerDown(pointer(imagePoint.x, imagePoint.y)) })
  await act(async () => { imageSource.props.onPointerMove(pointer(livePoint.x, livePoint.y)) })
  await flush(230)
  const liveNode = cardNodes().find((node) => keyOf(node) === 'session-s1')
  if (!liveNode.props.className.includes('is-pack-ready')) throw new Error('Merge hot zone did not arm')
  if (!JSON.stringify(renderer.toJSON()).includes('松手叠成卡包')) throw new Error('Merge hint missing')
  await act(async () => { imageSource.props.onPointerUp(pointer(livePoint.x, livePoint.y)) })
  await flush(150)
  if (cardNodes().some((node) => keyOf(node) === 'session-s1' || keyOf(node) === 'image-img1')) {
    throw new Error('Merge did not fold source and target')
  }
  if (packState.length !== 2) throw new Error('Merge did not create a second pack')
  if (packState[1].count !== 2) throw new Error('Merged pack member count wrong')
  assertClear(cardNodes(), 'after pack merge')

  // 展开合并包：两张成员卡用原卡片平铺，并各自带排序把手。
  const mergedPackNode = packNodes().find((node) => packText(node).includes('2 张'))
  if (!mergedPackNode) throw new Error('Merged pack card missing')
  const mergedPackArticle = mergedPackNode.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-pack-card'))[0]
  await act(async () => { mergedPackArticle.props.onClick() })
  await flush(80)
  const mergedModal = renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-pack-modal'))[0]
  if (!mergedModal) throw new Error('Merged pack modal missing')
  if (mergedModal.findAll((node) => node.props?.className === 'mc-pack-row').length !== 2) {
    throw new Error('Merged pack overlay should render two full-card rows')
  }
  if (!mergedModal.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-image-card')).length) {
    throw new Error('Merged pack overlay missing image card')
  }
  if (mergedModal.findAll((node) => node.props?.['data-pack-member-key'] && typeof node.props?.onPointerDown === 'function').length !== 2) {
    throw new Error('Merged pack overlay rows are not draggable')
  }
  await act(async () => { mergedModal.findAllByType('button').find((node) => node.props['aria-label'] === '关闭卡包').props.onClick() })
  await flush(60)

  // 「直播」筛选：含直播成员的卡包显示，只含便利签的卡包隐藏。
  const liveChipPack = chipRow().findAllByType('button').find((node) => textOf(node.props.children).startsWith('直播'))
  await act(async () => { liveChipPack.props.onClick() })
  await flush(60)
  const livePacks = packNodes()
  if (livePacks.length !== 1) throw new Error('Pack filter did not show only live pack')
  if (!packText(livePacks[0]).includes('2 张')) throw new Error('Filtered pack is wrong one')
  await act(async () => { chipRow().findAllByType('button').find((node) => textOf(node.props.children) === '全部').props.onClick() })
  await flush(60)

  // 撤销合并：卡包消失，直播卡和图片卡回到墙面。
  const undoButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '撤销')
  if (!undoButton) throw new Error('Pack undo missing')
  await act(async () => { undoButton.props.onClick() })
  await flush(150)
  if (packNodes().length !== 1) throw new Error('Undo did not remove merged pack')
  if (!cardNodes().some((node) => keyOf(node) === 'session-s1')) throw new Error('Undo did not restore live card')
  if (!cardNodes().some((node) => keyOf(node) === 'image-img1')) throw new Error('Undo did not restore image card')

  // 解散空包（内含便利签）：卡片回到墙面，记录不被删除。
  const dissolveTarget = packNodes()[0]
  const dissolveMenu = dissolveTarget.findAll((node) => typeof node.props?.onContextMenu === 'function')[0]
  await act(async () => { dissolveMenu.props.onContextMenu(fakeEvent()) })
  await flush(60)
  const dissolveButton = renderer.root.findAllByType('button')
    .find((node) => textOf(node.props.children).startsWith('解散卡包'))
  if (!dissolveButton) throw new Error('Pack dissolve action missing')
  await act(async () => { dissolveButton.props.onClick() })
  await flush(150)
  if (packNodes().length) throw new Error('Dissolve did not remove pack')
  if (!cardNodes().some((node) => keyOf(node) === 'note-n1')) throw new Error('Dissolve did not return note card')
  if (packState.length !== 0) throw new Error('Dissolve did not delete via API mock')

  const feedTab = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '信息流')
  await act(async () => { feedTab.props.onClick() })
  await flush(80)
  if (!JSON.stringify(renderer.toJSON()).includes('会议纪要：物模型白皮书')) throw new Error('Feed wall missing Feishu document card')
  const feedMenuCard = renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-home-card') && node.props?.onContextMenu)[0]
  if (!feedMenuCard) throw new Error('Feed card menu target missing')
  await act(async () => { feedMenuCard.props.onContextMenu(fakeEvent()) })
  const feedPin = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '图钉固定')
  if (!feedPin) throw new Error('Feed pin action missing')
  await act(async () => { feedPin.props.onClick() })
  await flush(80)
  if (!renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('is-pinned')).length) throw new Error('Feed pin badge missing')
  const homeCard = renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-home-card') && node.props?.onClick)[0]
  if (!homeCard) throw new Error('Home card not found')
  await act(async () => { homeCard.props.onClick() })
  await flush(150)
  if (!renderer.root.findAll((node) => node.props?.className === 'mc-workspace').length) {
    throw new Error('Home card did not open the library')
  }
  const openedRow = renderer.root.findAll((node) => node.props?.className === 'mc-item' && node.props['data-active'] === true)[0]
  if (!openedRow) throw new Error('Home card did not select the record in the library')
  if (!textOf(openedRow.props.children).includes('发布会回放')) throw new Error('Home card opened the wrong library record')

  const firstBack = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '首页')
  if (!firstBack) throw new Error('Home nav missing after opening a record')
  await act(async () => { firstBack.props.onClick() })
  await flush(120)

  // 打开记录时若左列筛选把这条挡住，资料库会自动回到「全部」并把该行显示出来。
  localStorage.setItem('meetclip.filter', 'meeting')
  const filteredCard = renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-home-card') && node.props?.onClick)[0]
  await act(async () => { filteredCard.props.onClick() })
  await flush(150)
  const filterBar = renderer.root.findAll((node) => node.props?.className === 'mc-filters')[0]
  const allFilterChip = filterBar.findAllByType('button')
    .find((node) => textOf(node.props.children) === '全部')
  if (allFilterChip?.props['data-active'] !== true) throw new Error('Opening a filtered-out record did not reset the library filter')
  if (!renderer.root.findAll((node) => node.props?.className === 'mc-item' && node.props['data-active'] === true).length) {
    throw new Error('Filtered record is missing from the library list')
  }

  const back = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '首页')
  if (!back) throw new Error('Home nav missing after opening a record')
  await act(async () => { back.props.onClick() })
  await flush(120)
  if (renderer.root.findAllByType('button').some((node) => textOf(node.props.children) === '日历')) throw new Error('Calendar nav still present')
  // 顶部右侧的资料空间切换器：显示当前空间，点开列出全部空间。
  const switcher = renderer.root.findAll((node) => node.props?.className === 'mc-lib-trigger')[0]
  if (!switcher) throw new Error('Library switcher missing from the top bar')
  if (!textOf(switcher.props.children).includes('工作')) throw new Error('Library switcher does not show the active library')
  await act(async () => { switcher.props.onClick() })
  await flush(120)
  const menuText = JSON.stringify(renderer.toJSON())
  for (const expected of ['切换资料空间', '工作', '生活', '新建资料空间', '管理资料空间']) {
    if (!menuText.includes(expected)) throw new Error('Library menu missing ' + expected)
  }
  await act(async () => { switcher.props.onClick() })
  await flush(80)

  const navLibrary = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '资料库')
  if (!navLibrary) throw new Error('Library nav not found')
  await act(async () => { navLibrary.props.onClick() })
  await flush(120)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['发布会回放', '大家好，这是第一段。', '重点']) {
    if (!text.includes(expected)) throw new Error('Panel missing ' + expected)
  }

  // 转写文字要能原生拖选并复制：行不再是 <button>，工具条提供全选与复制。
  const transcriptRow = renderer.root.findAll((node) => node.props?.className === 'mc-tr')[0]
  if (!transcriptRow) throw new Error('Transcript row not found')
  if (transcriptRow.type !== 'div' || transcriptRow.props.role !== 'button' || transcriptRow.props.tabIndex !== 0) {
    throw new Error('Transcript row must be a focusable div so text can be selected')
  }
  const selectAllButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '全选')
  if (!selectAllButton) throw new Error('Transcript select-all action missing')
  const copyTranscriptButton = renderer.root.findAllByType('button')
    .find((node) => ['复制转写', '复制所选'].includes(textOf(node.props.children)))
  if (!copyTranscriptButton) throw new Error('Transcript copy action missing')
  await act(async () => { copyTranscriptButton.props.onClick() })
  await flush(60)
  const copiedTranscript = clipboardWrites.find((value) => value.includes('大家好，这是第一段。'))
  if (!copiedTranscript) throw new Error('Copy transcript did not reach the clipboard')
  for (const expected of ['[00:00]', '第二段内容。']) {
    if (!copiedTranscript.includes(expected)) throw new Error('Copied transcript missing ' + expected)
  }

  await act(async () => { transcriptRow.props.onContextMenu(fakeEvent()) })
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['复制这段', '复制全部转写', '全选转写']) {
    if (!text.includes(expected)) throw new Error('Transcript context menu missing ' + expected)
  }
  const copyRowAction = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '复制这段')
  await act(async () => { copyRowAction.props.onClick() })
  await flush(60)
  if (!clipboardWrites.some((value) => value === '[00:00] 发言人 1：大家好，这是第一段。')) {
    throw new Error('Copy single transcript row failed')
  }
  const closeTranscriptMenu = renderer.root.findAllByType('button')
    .find((node) => node.props.className?.includes?.('mc-icon-button') && textOf(node.props.children) === '×')
  if (closeTranscriptMenu) await act(async () => { closeTranscriptMenu.props.onClick() })

  const row = renderer.root.findAllByType('button').find((node) => node.props.title === '发布会回放')
  if (!row) throw new Error('Session row not found')
  await act(async () => { row.props.onContextMenu(fakeEvent()) })
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['复制标题与链接', '复制直播链接', '在 Finder 中显示', '删除…']) {
    if (!text.includes(expected)) throw new Error('Sidebar context menu missing ' + expected)
  }
  await act(async () => { renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === '关闭')?.props.onClick?.() })

  const markRow = renderer.root.findAll((node) => node.props?.className === 'mc-mark-item' && node.props?.onContextMenu)[0]
  if (!markRow) throw new Error('Mark row not found')
  await act(async () => { markRow.props.onContextMenu(fakeEvent()) })
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['编辑批注', '跳转']) {
    if (!text.includes(expected)) throw new Error('Mark context menu missing ' + expected)
  }

  const shotsTab = renderer.root.findAllByType('button').find((node) => node.props.role === 'tab' && textOf(node.props.children).startsWith('截图'))
  if (!shotsTab) throw new Error('Shots tab not found')
  await act(async () => { shotsTab.props.onClick() })
  await flush(60)
  const shotRow = renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('mc-shot') && node.props?.onContextMenu)[0]
  if (!shotRow) throw new Error('Shot row not found')
  await act(async () => { shotRow.props.onContextMenu(fakeEvent()) })
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['复制时间码', '跳转到']) {
    if (!text.includes(expected)) throw new Error('Shot context menu missing ' + expected)
  }

  const allButtons = renderer.root.findAllByType('button')
  if (allButtons.some((node) => textOf(node.props.children) === '笔记')) {
    throw new Error('Notes tab should be merged into Minutes')
  }
  const minutesTab = renderer.root.findAllByType('button')
    .find((node) => node.props.role === 'tab' && textOf(node.props.children) === '纪要')
  if (!minutesTab) throw new Error('Minutes tab not found')
  await act(async () => { minutesTab.props.onClick() })
  await flush(200)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['预算缺口', '缺口二十万', '补预算表', '会摘', '这里有笔记', '预算评审', '会议模板']) {
    if (!text.includes(expected)) throw new Error('Merged minutes tab missing ' + expected)
  }
  if (text.includes('meetclip:minutes:begin')) throw new Error('Minutes block markers should stay hidden in preview')
  if (renderer.root.findAllByType('textarea').length) throw new Error('Merged minutes tab should start in preview')

  const paper = renderer.root.findAll((node) => typeof node.props?.className === 'string'
    && node.props.className.includes('mc-jottings-paper'))[0]
  if (!paper) throw new Error('Minutes paper not found')
  const seekAnchor = renderer.root.findAllByType('button').find((node) => node.props.className === 'mc-minutes-time')
  if (!seekAnchor) throw new Error('Minutes seek anchor not rendered')
  // 用户互动：待办可以勾选完成（划掉并写回后端），已有高亮渲染成 mark。
  const marks = renderer.root.findAll((node) => node.type === 'mark' && node.props?.className === 'mc-hl')
  if (!marks.length) throw new Error('Persisted highlight should render as mark')
  const todoBox = renderer.root.findAllByType('button').find((node) => node.props.role === 'checkbox')
  if (!todoBox) throw new Error('Minutes todo should be a checkbox button')
  await act(async () => { todoBox.props.onClick() })
  await flush(320)
  if (!interactionCalls.some((call) => Object.values(call.todos || {}).some((item) => item && item.done))) {
    throw new Error('Toggling a minutes todo should persist done state')
  }
  const doneRow = renderer.root.findAll((node) => node.type === 'li' && node.props?.['data-done'] === 'true')[0]
  if (!doneRow) throw new Error('Checked minutes todo should be marked done')
  text = JSON.stringify(renderer.toJSON())
  if (text.includes('会摘助手可见') || text.includes('已勾选')) {
    throw new Error('Minutes should not surface agent-facing interaction trace text')
  }
  await act(async () => { todoBox.props.onClick() })
  await flush(320)
  if (!interactionCalls.some((call) => Object.keys(call.todos || {}).length === 0)) {
    throw new Error('Unchecking a minutes todo should clear done state')
  }
  // 结构化纪要默认只读；编辑入口在工具条「编辑原文」。
  const editSourceButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '编辑原文')
  if (!editSourceButton) throw new Error('Minutes edit-source action missing')
  await act(async () => { editSourceButton.props.onClick() })
  await flush(120)
  const editor = renderer.root.findAllByType('textarea')[0]
  if (!editor) throw new Error('Clicking the preview should enter edit mode')
  if (!String(editor.props.value).includes('这里有笔记') || !String(editor.props.value).includes('会议纪要')) {
    throw new Error('Edit mode lost notes content')
  }
  const previewAgain = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '预览')
  if (!previewAgain) throw new Error('Edit mode should offer preview')
  await act(async () => { previewAgain.props.onClick() })
  await flush(80)
  if (renderer.root.findAllByType('textarea').length) throw new Error('Preview toggle did not leave edit mode')

  let buttons = renderer.root.findAllByType('button')
  const homeNav = buttons.find((node) => textOf(node.props.children) === '首页')
  if (!homeNav) throw new Error('Home nav not found')
  await act(async () => { homeNav.props.onClick() })
  await flush(100)
  buttons = renderer.root.findAllByType('button')
  const plusButtonAgain = buttons.find((node) => node.props['data-testid'] === 'hero-new-capture')
  if (!plusButtonAgain) throw new Error('Home plus button missing after returning home')
  await act(async () => { plusButtonAgain.props.onClick() })
  await flush(60)
  const meetingAgain = renderer.root.findAll((node) => String(node.props?.className || '').includes('mc-home-plus-menu'))[0]
    ?.findAllByType('button').find((node) => node.props['data-kind'] === 'meeting')
  if (!meetingAgain) throw new Error('Hero meeting entry missing after returning home')
  await act(async () => { meetingAgain.props.onClick() })
  await flush(150)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['会议录音', 'meeting.mp4', 'meeting-2.m4a']) {
    if (!text.includes(expected)) throw new Error('Inline capture panel missing ' + expected)
  }
  const cancelDialog = renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === '关闭采集面板')
  if (cancelDialog) await act(async () => { cancelDialog.props.onClick() })
  renderer.unmount()

  // 批次卡与批次浮层
  homePayload.batches = [{
    id: 'batch1', title: '批量视频 · 测试', created_at: 1793000400, total: 2,
    counts: { queued: 1, processing: 0, done: 1, error: 0, cancelled: 0 }, active: 1,
    members: [
      { id: 'x1', title: '批次视频一', status: 'done', platform: 'bilibili', source_url: 'https://www.bilibili.com/video/BV1', duration: 120, error: '' },
      { id: 'x2', title: '批次视频二', status: 'queued', platform: 'weibo', source_url: 'https://weibo.com/1/a', duration: 0, error: '' }
    ]
  }]
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(slots.main.Component, { t }))
  })
  await flush(250)
  const batchCard = renderer.root.findAll((node) => String(node.props?.className || '').includes('mc-batch-card'))[0]
  if (!batchCard) throw new Error('Batch card missing')
  const batchText = textOf(batchCard.props.children)
  for (const expected of ['批次', '查看 2 条', '1/2 完成']) {
    if (!batchText.includes(expected)) throw new Error('Batch card missing ' + expected)
  }
  await act(async () => { batchCard.props.onClick() })
  await flush(80)
  const batchModal = renderer.root.findAll((node) => String(node.props?.className || '').includes('mc-batch-modal'))[0]
  if (!batchModal) throw new Error('Batch overlay missing')
  if (!textOf(batchModal.props.children).includes('批次视频一')) throw new Error('Batch overlay member missing')
  const batchMember = batchModal.findAllByType('button').find((node) => textOf(node.props.children).includes('批次视频一'))
  if (!batchMember) throw new Error('Batch overlay member button missing')
  await act(async () => { batchMember.props.onClick() })
  await flush(200)
  if (!renderer.root.findAll((node) => node.props?.className === 'mc-workspace').length) {
    throw new Error('Batch member did not open the library')
  }
  const batchBack = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '首页')
  if (!batchBack) throw new Error('Home nav missing after opening a batch member')
  await act(async () => { batchBack.props.onClick() })
  await flush(120)
  renderer.unmount()

  // Hero 的「N 条正在进行」：直接打开那条记录，不再把散落画布筛成「进行中」。
  homePayload.items = homePayload.items.map((item) => item.id === 's2' ? { ...item, status: 'processing' } : item)
  homePayload.stats.active = 1
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(slots.main.Component, { t }))
  })
  await flush(250)
  const activeLink = () => renderer.root.findAllByType('button')
    .find((node) => String(node.props?.className || '').includes('mc-home-alert-link'))
  if (!activeLink()) throw new Error('Hero active link missing')
  if (!textOf(activeLink().props.children).includes('1 条正在进行')) throw new Error('Hero active link count wrong')
  const filterChip = (label) => renderer.root.findAll((node) => node.props?.className === 'mc-home-chips')[0]
    .findAllByType('button').find((node) => textOf(node.props.children).startsWith(label))
  if (filterChip('进行中')?.props['aria-selected']) throw new Error('Hero active link still filters the canvas')
  if (!filterChip('全部')?.props['aria-selected']) throw new Error('Hero active link changed the filter')
  await act(async () => { activeLink().props.onClick() })
  await flush(250)
  const heroRow = () => renderer.root.findAll((node) => node.props?.className === 'mc-item' && node.props['data-active'] === true)[0]
  if (!heroRow()) throw new Error('Hero active link did not open the record')
  if (!textOf(heroRow().props.children).includes('产品会议')) throw new Error('Hero active link opened the wrong record')
  renderer.unmount()

  // 有多条进行中时，优先跳到正在录的那条。
  homePayload.items = homePayload.items.map((item) => item.id === 's1' ? { ...item, status: 'recording' } : item)
  homePayload.stats.active = 2
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(slots.main.Component, { t }))
  })
  await flush(250)
  if (!textOf(activeLink().props.children).includes('2 条正在进行')) throw new Error('Hero active link count did not update')
  await act(async () => { activeLink().props.onClick() })
  await flush(250)
  if (!textOf(heroRow().props.children).includes('发布会回放')) throw new Error('Hero active link did not prefer the recording')
  renderer.unmount()

  // 批量入队后视频表单保持打开：接着贴下一批即可；全部重复时按行说明，并支持确认后仍然加入。
  homePayload.batches = []
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(slots.main.Component, { t }))
  })
  await flush(250)
  const openVideoCapture = async () => {
    const plus = renderer.root.findAllByType('button').find((node) => node.props['data-testid'] === 'hero-new-capture')
    if (!plus) throw new Error('Home plus button missing for video capture')
    await act(async () => { plus.props.onClick() })
    await flush(60)
    const entry = renderer.root.findAll((node) => String(node.props?.className || '').includes('mc-home-plus-menu'))[0]
      ?.findAllByType('button').find((node) => node.props['data-kind'] === 'video')
    if (!entry) throw new Error('Hero video entry missing')
    await act(async () => { entry.props.onClick() })
    await flush(120)
  }
  const fillVideoLinks = async (value) => {
    const area = renderer.root.findAllByType('textarea')[0]
    if (!area) throw new Error('Video form textarea missing')
    await act(async () => { area.props.onChange({ target: { value } }) })
    await flush(120)
  }
  const addQueueButton = () => renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '加入队列')
  await openVideoCapture()
  await fillVideoLinks('https://www.bilibili.com/video/BV1batch\nhttps://www.bilibili.com/video/BV2batch')
  if (!addQueueButton()) throw new Error('Batch video form missing')
  await act(async () => { addQueueButton().props.onClick() })
  await flush(500)
  text = JSON.stringify(renderer.toJSON())
  if (!text.includes('关闭采集面板')) throw new Error('Video form closed after a batch add')
  if (!text.includes('继续粘贴链接可再加入一批')) throw new Error('Continue hint missing after a batch add')
  if (!text.includes('已加入 2 条')) throw new Error('Batch summary missing')
  if (renderer.root.findAllByType('textarea').some((node) => node.props.value)) throw new Error('Batch form textarea was not cleared')
  await act(async () => {
    renderer.root.findAllByType('textarea')[0].props.onChange({
      target: { value: 'https://www.bilibili.com/video/BV3batch\nhttps://www.bilibili.com/video/BV4batch' }
    })
  })
  await flush(200)
  await act(async () => { addQueueButton().props.onClick() })
  await flush(500)
  if (linkBatchBodies.length !== 2) throw new Error('Second batch was not submitted from the open form')
  if (linkBatchBodies[1].batch_id) throw new Error('Second batch should open a new batch card')
  const finishButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '完成')
  if (!finishButton) throw new Error('Finish button missing after batch adds')
  await act(async () => { finishButton.props.onClick() })
  await flush(400)
  if (JSON.stringify(renderer.toJSON()).includes('关闭采集面板')) throw new Error('Video form did not close after 完成')

  // 全部重复：不是只回一个 HTTP 400，而是列出每条原因并允许「仍然加入重复链接」。
  await openVideoCapture()
  await fillVideoLinks('https://www.bilibili.com/video/BVdupe1\nhttps://www.bilibili.com/video/BVdupe2')
  await act(async () => { addQueueButton().props.onClick() })
  await flush(500)
  text = JSON.stringify(renderer.toJSON())
  if (!text.includes('已有相同链接，可确认后再次添加')) throw new Error('Duplicate rows were not shown')
  const forceButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '仍然加入重复链接')
  if (!forceButton) throw new Error('Force duplicate action missing')
  await act(async () => { forceButton.props.onClick() })
  await flush(500)
  if (!linkBatchBodies.at(-1).items.every((item) => item.allow_duplicate)) throw new Error('Force duplicate request did not allow duplicates')
  if (!JSON.stringify(renderer.toJSON()).includes('已加入 2 条')) throw new Error('Forced duplicate batch was not added')
  const finishAgain = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '完成')
  await act(async () => { finishAgain.props.onClick() })
  await flush(400)

  // 批次浮层里追加新链接：请求带上 batch_id，提交后仍停在这个表单，完成回到成员列表。
  const seededBatchId = homePayload.batches[0].id
  const batchCards = renderer.root.findAll((node) => node.props?.className === 'mc-batch-card')
  const targetCard = renderer.root.findAll((node) => node.props?.['data-batch-id'] === seededBatchId
    && String(node.props?.className || '').includes('mc-batch-card'))[0]
  if (!batchCards.length || !targetCard) throw new Error('Seeded batch card missing')
  await act(async () => { targetCard.props.onClick() })
  await flush(120)
  const appendButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '批量加入新链接')
  if (!appendButton) throw new Error('Batch append action missing')
  await act(async () => { appendButton.props.onClick() })
  await flush(120)
  text = JSON.stringify(renderer.toJSON())
  if (!text.includes('加入批次') || !text.includes('加入本批次')) throw new Error('Batch append form missing')
  await act(async () => {
    renderer.root.findAllByType('textarea')[0].props.onChange({
      target: { value: 'https://www.bilibili.com/video/BV5batch\nhttps://www.bilibili.com/video/BV6batch' }
    })
  })
  await flush(200)
  const appendSubmit = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '加入本批次')
  await act(async () => { appendSubmit.props.onClick() })
  await flush(600)
  if (linkBatchBodies.at(-1).batch_id !== seededBatchId) throw new Error('Batch append request missing batch_id')
  if (!JSON.stringify(renderer.toJSON()).includes('继续粘贴链接可再加入一批')) throw new Error('Batch append form closed after submit')
  const appendDone = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '完成')
  await act(async () => { appendDone.props.onClick() })
  await flush(500)
  const updatedBatch = homePayload.batches.find((batch) => batch.id === seededBatchId)
  if (!updatedBatch || updatedBatch.members.length !== 4) throw new Error('Batch append did not refresh the member list')
  const batchModalAfter = renderer.root.findAll((node) => String(node.props?.className || '').includes('mc-batch-modal'))[0]
  if (!batchModalAfter) throw new Error('Batch overlay disappeared after append')
  if (!textOf(batchModalAfter.props.children).includes('4 条')) throw new Error('Batch overlay count did not update after append')
  if (batchModalAfter.findAll((node) => node.props?.className === 'mc-batch-member').length !== 4) {
    throw new Error('Batch overlay member list did not include appended links')
  }
  const closeBatch = () => renderer.root.findAllByType('button').find((node) => node.props['aria-label'] === '关闭批次')
  await act(async () => { closeBatch().props.onClick() })
  await flush(120)

  // 批次卡右键也能直接进入追加表单。
  const cardForMenu = renderer.root.findAll((node) => node.props?.['data-batch-id'] === seededBatchId
    && String(node.props?.className || '').includes('mc-batch-card'))[0]
  await act(async () => { cardForMenu.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 12, clientY: 16 }) })
  await flush(120)
  const appendMenuItem = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '加入新链接')
  if (!appendMenuItem) throw new Error('Batch context menu append action missing')
  await act(async () => { appendMenuItem.props.onClick() })
  await flush(150)
  if (!JSON.stringify(renderer.toJSON()).includes('加入批次')) throw new Error('Context menu did not open the append form')
  await act(async () => { closeBatch().props.onClick() })
  await flush(100)
  renderer.unmount()

  await act(async () => {
    renderer = TestRenderer.create(React.createElement(slots['settings.section'].Component, { t, close: () => {} }))
  })
  await flush(250)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['会摘设置', '模型', '采集', 'API Key']) {
    if (!text.includes(expected)) throw new Error('Settings missing ' + expected)
  }
  for (const forbidden of ['通用', '界面语言', '数据目录', '日志', '运行信息', 'PID', '端口', '数据与诊断']) {
    if (text.includes(forbidden)) throw new Error('Settings still shows diagnostics: ' + forbidden)
  }

  const modelsTab = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '模型')
  if (!modelsTab) throw new Error('Models tab missing')
  await act(async () => { modelsTab.props.onClick() })
  await flush(300)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['API Key', '拉取模型清单', '语音转文字', '文字总结', '自定义 API', 'Base URL', '模型 ID', 'demo-flash']) {
    if (!text.includes(expected)) throw new Error('Models tab missing ' + expected)
  }

  const captureTab = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '采集')
  if (!captureTab) throw new Error('Capture tab missing')
  await act(async () => { captureTab.props.onClick() })
  await flush(200)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['新建默认类型', '扫码登录', '截图灵敏度', '没人说话', '抖音账号', '扫码登录', '读取 Cookie']) {
    if (!text.includes(expected)) throw new Error('Capture tab missing ' + expected)
  }
  for (const expected of ['资料库', 'DSH 工作区', '在 Finder 中打开', '更换…', '添加为 DSH 工作区']) {
    if (!text.includes(expected)) throw new Error('Storage card missing ' + expected)
  }

  // The folder picker result feeds the inspection; the review panel appears without
  // touching the real data directory.
  const changeButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '更换…')
  if (!changeButton) throw new Error('Storage change action missing')
  await act(async () => { changeButton.props.onClick() })
  await flush(200)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['新位置', '/tmp/meeting.mp4', '确认切换', '取消']) {
    if (!text.includes(expected)) throw new Error('Storage review missing ' + expected)
  }
  const cancelButton = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '取消')
  await act(async () => { cancelButton.props.onClick() })
  await flush(80)
  if (JSON.stringify(renderer.toJSON()).includes('新位置')) throw new Error('Storage review did not close')

  // 设置 → 资料空间：多个空间一次用一个，账号与通用设置共享一份。
  const librariesTab = renderer.root.findAllByType('button').find((node) => textOf(node.props.children) === '资料空间')
  if (!librariesTab) throw new Error('Libraries tab missing')
  await act(async () => { librariesTab.props.onClick() })
  await flush(300)
  text = JSON.stringify(renderer.toJSON())
  for (const expected of ['资料空间', '工作', '生活', '正在使用', '新建资料空间', '账号与通用设置', '/tmp/shared']) {
    if (!text.includes(expected)) throw new Error('Libraries tab missing ' + expected)
  }
  renderer.unmount()
  console.log('interaction smoke OK')
} catch (error) {
  try { renderer?.unmount() } catch {}
  console.error('interaction smoke FAILED:', error?.stack || error)
  process.exit(1)
}
