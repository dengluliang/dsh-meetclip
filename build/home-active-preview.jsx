// 静态预览：用假数据把「会摘」首页的散落画布渲染出来，供 Chrome 截图核对视觉。
import React from 'react'
import { createRoot } from 'react-dom/client'
import { translator } from '../client-src/lib/i18n.js'

const now = Math.floor(Date.now() / 1000)
const day = 86400

function cover(hue, letter) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 72% 86%)"/><stop offset="1" stop-color="hsl(${hue + 46} 58% 62%)"/></linearGradient></defs><rect width="640" height="420" fill="url(#g)"/><text x="50%" y="57%" font-size="132" text-anchor="middle" font-family="Songti SC, serif" fill="rgba(255,255,255,.58)">${letter}</text></svg>`
  return { type: 'remote', value: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }
}

const sessions = [
  { id: 's1', title: '苹果秋季发布会：iPhone 17 全系上手', kind: 'live', status: 'recording', duration: 3820, cover: cover(210, '苹'), snippet: '这次最大的变化不是外观，而是端侧模型真正进入了系统层级。', platform: 'bilibili', started_at: now - day * 0.3, marks: 6, screenshots: 84 },
  { id: 's2', title: '周五选题会 · 从灵感走到排期', kind: 'meeting', status: 'processing', duration: 2680, cover: cover(268, '周'), snippet: '先把要做的东西收窄，再决定这一周发什么。', started_at: now - day * 0.8, marks: 4, screenshots: 12, unreviewed: true },
  { id: 's3', title: 'DeepSeek 开发者日 · 长上下文与 Agent 实践', kind: 'link_video', status: 'queued', duration: 5210, cover: cover(160, 'D'), snippet: '真正难的从来不是把上下文拉长，而是让模型知道哪一段值得记住。', platform: 'youtube', started_at: now - day * 1.2, marks: 7, screenshots: 0 },
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

const notes = [
  { id: 'n1', text: '周末把散落画布的拖拽手感再调一遍：\n- 松手后邻居让开\n- 图钉固定不动\n- 回到中心要有惯性', kind: 'todo', checked: [true, false, false], x: 620, y: -260, created_at: now - 3600 },
  { id: 'n2', text: '下次直播开场先讲一个问题：你上一次翻回去看录播，是为了找什么？', kind: 'note', checked: [], x: -700, y: 320, created_at: now - 7200 }
]

const homePayload = {
  stats: { total: 42, week: 3, duration: 66600, recording: 1, active: 3, unreviewed: 5, marks: 37, live: 18, link_video: 12, meeting: 12 },
  items: sessions,
  highlights,
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

window.fetch = async (input) => {
  const target = String(input)
  if (target.includes('/app/status')) return json(statusPayload)
  if (target.includes('/api/home')) return json(homePayload)
  if (target.includes('/api/sticky-notes')) return json(notes)
  if (target.includes('/api/board/images')) return json([])
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

if (window.location.search.includes('mode=feed')) {
  setTimeout(() => {
    const button = [...document.querySelectorAll('.mc-home-seg button')].find((node) => node.textContent === '信息流')
    button?.click()
  }, 900)
}
if (window.location.search.includes('filter=active')) {
  setTimeout(() => {
    const chip = [...document.querySelectorAll('.mc-home-chips button')].find((node) => node.textContent.includes('进行中'))
    chip?.click()
  }, 1500)
}

if (window.location.search.includes('menu=1')) {
  setTimeout(() => {
    document.querySelector('[data-testid="hero-new-capture"]')?.click()
  }, 1400)
}

createRoot(document.getElementById('root')).render(
  React.createElement(
    'div',
    { style: { height: '100vh', overflow: 'hidden' } },
    React.createElement(slots.main, { t: translator('zh-CN') })
  )
)
