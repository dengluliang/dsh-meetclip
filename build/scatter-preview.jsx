// 静态预览：用假数据把「会摘」首页的散落画布渲染出来，供 Chrome 截图核对视觉。
import React from 'react'
import { createRoot } from 'react-dom/client'

const now = Math.floor(Date.now() / 1000)
const day = 86400

function cover(hue, letter) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 72% 86%)"/><stop offset="1" stop-color="hsl(${hue + 46} 58% 62%)"/></linearGradient></defs><rect width="640" height="420" fill="url(#g)"/><text x="50%" y="57%" font-size="132" text-anchor="middle" font-family="Songti SC, serif" fill="rgba(255,255,255,.58)">${letter}</text></svg>`
  return { type: 'remote', value: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }
}

const sessions = [
  { id: 's1', title: '苹果秋季发布会：iPhone 17 全系上手', kind: 'live', status: 'done', duration: 3820, cover: cover(210, '苹'), snippet: '这次最大的变化不是外观，而是端侧模型真正进入了系统层级。', platform: 'bilibili', started_at: now - day * 0.3, marks: 6, screenshots: 84 },
  { id: 's2', title: '周五选题会 · 从灵感走到排期', kind: 'meeting', status: 'done', duration: 2680, cover: cover(268, '周'), snippet: '先把要做的东西收窄，再决定这一周发什么。', started_at: now - day * 0.8, marks: 4, screenshots: 12, unreviewed: true },
  { id: 's3', title: 'DeepSeek 开发者日 · 长上下文与 Agent 实践', kind: 'link_video', status: 'done', duration: 5210, cover: cover(160, 'D'), snippet: '真正难的从来不是把上下文拉长，而是让模型知道哪一段值得记住。', platform: 'youtube', started_at: now - day * 1.2, marks: 7, screenshots: 0 },
  { id: 's4', title: '和产品团队聊「会摘」的下一版', kind: 'meeting', status: 'done', duration: 4120, cover: cover(32, '和'), snippet: '用户不是想要更多按钮，而是想打开的一瞬间就知道自己摘过什么。', started_at: now - day * 1.9, marks: 11, screenshots: 7 },
  { id: 's5', title: '产品观察：AI 硬件的第二次尝试', kind: 'live', status: 'done', duration: 2100, cover: cover(300, '观'), snippet: '硬件只是壳，真正被比较的是它替用户记住了什么。', platform: 'bilibili', started_at: now - day * 2.6, marks: 3, screenshots: 21 },
  { id: 's6', title: '一口气看完本周科技新闻', kind: 'link_video', status: 'done', duration: 1480, cover: cover(12, '新'), snippet: '五条新闻里，只有一条值得单独做一期。', platform: 'bilibili', started_at: now - day * 3.1, marks: 2, screenshots: 0 },
  { id: 's7', title: '人物访谈：一个人做产品的第三百天', kind: 'link_video', status: 'done', duration: 6320, cover: cover(230, '人'), snippet: '最难的不是做出来，是每天都知道今天该做什么。', platform: 'youtube', started_at: now - day * 4.2, marks: 9, screenshots: 0 },
  { id: 's8', title: '凌晨的复盘会：这一期为什么没起来', kind: 'meeting', status: 'done', duration: 3200, cover: cover(348, '复'), snippet: '标题没有问题，问题在第三分钟之后没有继续给理由。', started_at: now - day * 5.4, marks: 5, screenshots: 3, unreviewed: true },
  { id: 's9', title: '工具流直播：把会议录音变成可检索的笔记', kind: 'live', status: 'done', duration: 5400, cover: cover(140, '工'), snippet: '先把时间戳对齐，再谈结构化。', platform: 'bilibili', started_at: now - day * 6.3, marks: 8, screenshots: 46 },
  { id: 's10', title: '周末读书会：注意力与创作', kind: 'meeting', status: 'done', duration: 2900, cover: cover(40, '书'), snippet: '好的选题不是想出来的，是被反复抱怨出来的。', started_at: now - day * 7.1, marks: 4, screenshots: 2 }
]

const highlights = [
  { id: 1, session_id: 's3', session_title: 'DeepSeek 开发者日', kind: 'link_video', ts: 1240, note: '上下文不是仓库，是工作台。', created_at: now - day * 1.1 },
  { id: 2, session_id: 's4', session_title: '和产品团队聊「会摘」的下一版', kind: 'meeting', ts: 3020, note: '打开的一瞬间，应该先看到自己摘过什么，而不是一个空列表。', created_at: now - day * 1.8 },
  { id: 3, session_id: 's1', session_title: '苹果秋季发布会', kind: 'live', ts: 2150, note: '真正的护城河不是参数，而是用户愿意把每天交给你。', created_at: now - day * 0.2 }
]

// ?showcase=1 只是截图用的居中布景，默认布局保持不变（click smoke 依赖固定位置）。
const showcase = new URLSearchParams(window.location.search).get('showcase') === '1'
const notes = [
  { id: 'n1', text: '周末把散落画布的拖拽手感再调一遍：\n- 松手后邻居让开\n- 图钉固定不动\n- 回到中心要有惯性', kind: 'todo', checked: [true, false, false], x: showcase ? 400 : 620, y: showcase ? -250 : -260, created_at: now - 3600 },
  { id: 'n2', text: '下次直播开场先讲一个问题：你上一次翻回去看录播，是为了找什么？', kind: 'note', checked: [], x: showcase ? -390 : -700, y: showcase ? 250 : 320, created_at: now - 7200 }
]

// 默认预览不带图片卡，避免改变既有散落布局（click smoke 依赖固定位置）；
// 需要看图片卡时用 ?board=1 或 ?paste=image。
const showBoardImage = new URLSearchParams(window.location.search).get('board') === '1'
const images = showBoardImage
  ? [{ id: 'i1', path: 'board-images/i1.png', width: 840, height: 620, x: showcase ? 400 : -380, y: 300, created_at: now - 1800 }]
  : []

const previewPacks = new URLSearchParams(window.location.search).get('packs') === '1'
  ? [{
    id: 'pack-preview-1',
    title: '发布会复盘',
    created_at: now - day * 0.5,
    updated_at: now - day * 0.2,
    count: 4,
    active_count: 0,
    members: [
      { type: 'session', id: 's1', title: sessions[0].title, kind: 'live', status: 'done', created_at: sessions[0].started_at, duration: sessions[0].duration, active: false },
      { type: 'session', id: 's2', title: sessions[1].title, kind: 'meeting', status: 'done', created_at: sessions[1].started_at, duration: sessions[1].duration, active: false },
      { type: 'highlight', id: '1', title: highlights[0].note, subtitle: highlights[0].session_title, kind: 'link_video', status: 'done', session_id: highlights[0].session_id, session_title: highlights[0].session_title, ts: highlights[0].ts, created_at: highlights[0].created_at },
      { type: 'note', id: 'n1', title: '周末把散落画布的拖拽手感再调一遍', subtitle: '待办清单', kind: 'todo', status: 'done', created_at: notes[0].created_at }
    ]
  }]
  : []

const homePayload = {
  stats: { total: 42, week: 3, duration: 66600, recording: 0, unreviewed: 5, marks: 37, live: 18, link_video: 12, meeting: 12 },
  items: sessions,
  highlights,
  packs: previewPacks,
  has_more: false
}

const statusPayload = {
  ok: true,
  version: '0.3.1',
  backend: { state: 'running', phase: 'ready', mode: 'managed', port: 8321, pid: 100, lastError: '', tokenPresent: true, version: 3, restarts: 0 },
  env: { ready: true, exists: true, mlx: true, version: '3.12', venvDir: '/tmp/venv', venvPython: '/tmp/venv/bin/python', python: '/tmp/venv/bin/python', job: null },
  locations: { dataDir: '/tmp/data', stateDir: '/tmp/state', port: 8321, dataDirWritable: true },
  prefs: {},
  config: { backendMode: 'auto', autoStart: false, tools: true }
}

const json = (data, ok = true, code = 200) => ({ ok, status: code, text: async () => JSON.stringify(data) })

window.__pasteRequests = []
window.fetch = async (input, init = {}) => {
  const target = String(input)
  const method = String(init.method || 'GET').toUpperCase()
  if (method !== 'GET') window.__pasteRequests.push(`${method} ${target}`)
  if (target.includes('/app/status')) return json(statusPayload)
  if (target.includes('/api/home')) return json(homePayload)
  if (target.includes('/api/sticky-notes')) {
    if (method === 'POST') {
      const body = JSON.parse(init.body || '{}')
      const lines = String(body.text || '').split('\n').filter((line) => /^\s*-\s+/.test(line))
      const note = {
        id: `paste-note-${Date.now()}`,
        text: body.text || '',
        kind: lines.length ? 'todo' : 'note',
        checked: lines.map(() => false),
        x: Number(body.x) || 0,
        y: Number(body.y) || 0,
        created_at: Math.floor(Date.now() / 1000)
      }
      notes.push(note)
      return json(note)
    }
    if (method === 'PATCH') {
      const id = decodeURIComponent(target.split('/api/sticky-notes/')[1] || '')
      const note = notes.find((row) => row.id === id)
      if (!note) return json({ detail: '便利签不存在' }, false, 404)
      const body = JSON.parse(init.body || '{}')
      const text = String(body.text || note.text)
      const lines = text.split('\n').filter((line) => /^\s*-\s+/.test(line))
      const checked = Array.isArray(body.checked) ? body.checked.slice(0, lines.length) : []
      while (checked.length < lines.length) checked.push(false)
      note.text = text
      note.kind = lines.length ? 'todo' : 'note'
      note.checked = lines.length ? checked : []
      return json(note)
    }
    return json(notes)
  }
  if (target.includes('/api/board/images')) {
    if (method === 'POST') {
      const form = init.body
      const file = form?.get?.('file')
      const heif = /\.(?:heic|heif|hif)$/i.test(String(file?.name || ''))
        || /hei[cf]/i.test(String(file?.type || ''))
      const measuredWidth = Number(form?.get?.('width')) || 0
      const measuredHeight = Number(form?.get?.('height')) || 0
      const row = {
        id: `paste-image-${Date.now()}`,
        path: heif ? 'board-images/paste.jpg' : 'board-images/paste.png',
        width: measuredWidth || (heif ? 900 : 0),
        height: measuredHeight || (heif ? 620 : 0),
        x: Number(form?.get?.('x')) || 0,
        y: Number(form?.get?.('y')) || 0,
        created_at: Math.floor(Date.now() / 1000)
      }
      images.push(row)
      return json(row)
    }
    return json(images)
  }
  if (target.includes('/api/packs/')) {
    const pack = previewPacks[0]
    if (!pack) return json({ ok: false, detail: '卡包不存在' }, false, 404)
    if (method === 'PATCH' && target.split('/api/packs/')[1]?.includes('/members')) {
      const body = JSON.parse(init.body || '{}')
      const order = Array.isArray(body.members) ? body.members : []
      const byKey = new Map(pack.members.map((member) => [`${member.type}-${member.id}`, member]))
      const next = order.map((member) => byKey.get(`${member.type}-${member.id}`)).filter(Boolean)
      for (const member of pack.members) if (!next.includes(member)) next.push(member)
      pack.members = next
      pack.updated_at = Math.floor(Date.now() / 1000)
      return json({ ok: true, pack })
    }
    return json({ ok: true, pack })
  }
  if (target.includes('/api/deps/install/status')) return json({ running: false, done: true, log: '', step: '完成', error: '' })
  if (target.includes('/api/deps')) return json({ yt_dlp: true, ffmpeg: true, asr: true, asr_runtime: true, ready: true })
  if (target.includes('/api/asr/engines')) return json({ default_provider: 'mimo', base_url: 'https://gateway.example.test/v1', model: 'demo-asr', has_api_key: true, ready: true })
  if (target.includes('/api/meeting/options')) return json({ languages: [{ id: '', name: '自动' }], aligner_ready: true, asr_ready: true, asr_provider: 'mimo', diarize: { available: true, package: true, model_ready: true, model_state: 'ready' } })
  if (target.includes('/api/asr/status') || target.includes('/api/aligner/status') || target.includes('/api/diarize/status')) {
    return json({ state: 'ready', ready: true, downloaded: 100, total: 100, runtime: true, bundled: false })
  }
  if (target.includes('/api/settings')) return json({ shot_sensitivity: 0.5, link_browser_cookies: false })
  if (target.includes('/api/bilibili/status')) return json({ logged_in: false })
  if (target.includes('/api/search')) return json({ total: 0, counts: {}, results: [], has_more: false })
  // 点卡片会跳到资料库：补上列表与详情，预览里也能看到真实的两栏页。
  if (target.includes('/api/sessions/')) {
    const id = decodeURIComponent(target.split('/api/sessions/')[1] || '').split('/')[0]
    const row = sessions.find((item) => item.id === id) || sessions[0]
    return json({
      ...row,
      notes: '', notes_version: 0, marks: [], screenshots: [], speakers: {}, transcripts: [],
      media_path: '', has_video: false, recording: false, processing: false, queued: false,
      queue_position: null, asr_status: 'ready',
      minutes: { state: 'idle', state_text: '', version: 0, updated_at: 0, covered: 0, kind: 'final' }
    })
  }
  if (target.includes('/api/sessions')) return json(sessions)
  return json({})
}

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
}
window.EventSource = class {
  close() {}
}

try {
  localStorage.removeItem('meetclip.scatter.layout.v2')
  localStorage.removeItem('meetclip.scatter.pins.v1')
} catch {
  // file:// 下可能禁用存储，预览不依赖它。
}

const plugin = window.__entry.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require ${name}`)
})
const slots = {}
plugin.apply({
  get: () => undefined,
  effect: (callback) => callback(),
  slots: {
    inject: (_slot, callback) => callback(),
    register: (options, Component) => {
      slots[options.name] = Component
      return () => {}
    }
  }
})

if (window.location.search.includes('demo=pack-hotzone')) {
  // 截图用：把一张卡拖到另一张卡中央并停留，展示上膛后的热区与提示。
  setTimeout(() => {
    const cards = [...document.querySelectorAll('.mc-scatter-card')]
    const inView = cards.filter((node) => {
      const box = node.getBoundingClientRect()
      const cx = box.left + box.width / 2
      const cy = box.top + box.height / 2
      return box.width > 80 && cx > 130 && cx < window.innerWidth - 130 && cy > 120 && cy < window.innerHeight - 120
    })
    const from = inView.find((node) => node.dataset.type === 'session')
    const to = inView.find((node) => node !== from && ['note', 'session', 'highlight'].includes(node.dataset.type)) || inView.find((node) => node !== from)
    if (!from || !to) return
    const a = from.getBoundingClientRect()
    const b = to.getBoundingClientRect()
    const start = { x: a.left + a.width / 2, y: a.top + a.height / 2 }
    const end = { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    const fire = (type, x, y) => from.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y
    }))
    fire('pointerdown', start.x, start.y)
    for (let index = 1; index <= 8; index += 1) {
      fire('pointermove', start.x + (end.x - start.x) * index / 8, start.y + (end.y - start.y) * index / 8)
    }
    // 不松手：让 160ms 上膛动画和提示停在截图里。
  }, 1500)
}

if (window.location.search.includes('demo=pack-overlay')) {
  setTimeout(() => {
    const pack = document.querySelector('.mc-pack-card')
    if (!pack) return
    pack.click()
  }, 1500)
}

if (window.location.search.includes('demo=drag-hold')) {
  // 截图用：真的按住一张便利签拖动一半，保持拖动态，检查卡片四角的接缝。
  setTimeout(() => {
    const cards = [...document.querySelectorAll('.mc-scatter-card')].filter((node) => node.dataset.type === 'note')
    const card = cards.find((node) => {
      const box = node.getBoundingClientRect()
      const cx = box.left + box.width / 2
      const cy = box.top + box.height / 2
      return cx > 20 && cx < window.innerWidth - 20 && cy > 90 && cy < window.innerHeight - 110
    }) || cards[0] || document.querySelector('.mc-scatter-card')
    if (!card) return
    const box = card.getBoundingClientRect()
    const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    const fire = (type, x, y, buttons = 1) => card.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y
    }))
    fire('pointerdown', start.x, start.y)
    for (let step = 1; step <= 8; step += 1) {
      fire('pointermove', start.x + step * 22, start.y - step * 14)
    }
  }, 1400)
}

if (window.location.search.includes('demo=drag')) {
  // 浏览器里真拖一次：把一张记录卡拖到便利签上，检查落点持久化和其他卡片让位。
  setTimeout(() => {
    const cards = [...document.querySelectorAll('.mc-scatter-card')]
    const from = cards.find((node) => node.dataset.type === 'session')
    const to = cards.find((node) => node.dataset.type === 'note')
    if (!from || !to) return
    const a = from.getBoundingClientRect()
    const b = to.getBoundingClientRect()
    const start = { x: a.left + a.width / 2, y: a.top + a.height / 2 }
    const end = { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    const fire = (type, x, y) => from.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y
    }))
    fire('pointerdown', start.x, start.y)
    for (let index = 1; index <= 10; index += 1) {
      fire('pointermove', start.x + (end.x - start.x) * index / 10, start.y + (end.y - start.y) * index / 10)
    }
    fire('pointerup', end.x, end.y)
  }, 1200)
  setTimeout(() => {
    const rows = [...document.querySelectorAll('.mc-scatter-card')].map((node) => ({
      key: node.dataset.node,
      left: Number.parseFloat(node.style.left),
      top: Number.parseFloat(node.style.top),
      width: Number.parseFloat(node.style.width),
      height: Number.parseFloat(node.style.height)
    }))
    const pre = document.createElement('pre')
    pre.id = 'scatter-demo'
    pre.textContent = JSON.stringify({
      stored: localStorage.getItem('meetclip.scatter.layout.v2'),
      rows
    })
    document.body.appendChild(pre)
  }, 2600)
}

if (window.location.search.includes('debug')) {
  setTimeout(() => {
    const rows = [...document.querySelectorAll('.mc-scatter-card')].map((node) => {
      const rect = node.getBoundingClientRect()
      const style = node.style
      return {
        key: node.dataset.node,
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        styleLeft: style.left,
        styleTop: style.top,
        styleWidth: style.width,
        styleHeight: style.height
      }
    })
    const pre = document.createElement('pre')
    pre.id = 'scatter-debug'
    pre.textContent = JSON.stringify(rows)
    document.body.appendChild(pre)
  }, 2500)
}

const pasteMode = new URLSearchParams(window.location.search).get('paste')
if (pasteMode) {
  const firePaste = (clipboard) => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: clipboard })
    document.body.dispatchEvent(event)
  }
  async function demoImageFile(name, type) {
    const canvas = document.createElement('canvas')
    canvas.width = 900
    canvas.height = 620
    const ctx = canvas.getContext('2d')
    const grad = ctx.createLinearGradient(0, 0, 900, 620)
    grad.addColorStop(0, '#3a3f4b')
    grad.addColorStop(1, '#8a6a48')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 900, 620)
    ctx.fillStyle = 'rgba(255,255,255,.84)'
    ctx.font = '600 58px "Songti SC", serif'
    ctx.fillText('Live Moment', 60, 320)
    ctx.font = '24px -apple-system, sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,.6)'
    ctx.fillText('⌘V 粘贴的截图', 62, 370)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    return new File([blob], name, { type })
  }

  setTimeout(async () => {
    if (pasteMode === 'guard') {
      // 粘贴落在输入框里时不能被首页接管成卡片。
      const input = document.querySelector('.mc-home-capture input')
      try { input?.focus() } catch {}
      firePaste({ files: [], items: [], getData: (type) => (type === 'text/plain' ? '这段文字应该留在输入框里' : '') })
      setTimeout(() => {
        const pre = document.createElement('pre')
        pre.id = 'paste-guard'
        pre.textContent = JSON.stringify({
          sticky: document.querySelectorAll('.mc-sticky-card').length,
          images: document.querySelectorAll('.mc-image-card').length,
          active: document.activeElement?.tagName || '',
          requests: window.__pasteRequests || []
        })
        document.body.appendChild(pre)
      }, 800)
      return
    }
    if (pasteMode === 'image') {
      firePaste({ files: [await demoImageFile('paste.png', 'image/png')], items: [], getData: () => '' })
      return
    }
    if (pasteMode === 'heic') {
      // 模拟 iPhone 拖来的 HEIC：MIME 是 image/heic，浏览器本身不解码，后端转 JPEG。
      firePaste({ files: [await demoImageFile('IMG_0001.HEIC', 'image/heic')], items: [], getData: () => '' })
      return
    }
    firePaste({
      files: [],
      items: [],
      getData: (type) => (type === 'text/plain' ? '今晚复盘\n- 标题的吸引力\n- 前 3 分钟的钩子\n- 结尾的号召' : '')
    })
  }, 1800)
}

createRoot(document.getElementById('root')).render(
  React.createElement(
    'div',
    { style: { height: '100vh', overflow: 'hidden' } },
    React.createElement(slots.main, { t: (key) => key })
  )
)
