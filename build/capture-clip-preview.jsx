// 内联采集面板「底部操作行被裁掉」的真机布局验证：渲染真实 HomePage，
// 走一遍「＋ → 视频链接 → 贴两条链接 → 预读」，再用 elementFromPoint 检查主按钮是否真的点得到。
// 用法：
//   node build/build-capture-clip-preview.mjs
//   node build/capture-clip-shots.mjs            # 生成修复前/后对比截图
//   ?mode=feed  切到信息流；?old=1 摘掉夹高度（模拟修复前）；?shot=1 只打开到预读后便于截图
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import { HomePage } from '../client-src/components/home/HomePage.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React
const style = document.createElement('style')
style.textContent = css + '\n[data-capture-old="true"] .mc-capture-inline { max-height: min(68vh, 660px) !important; }'
document.head.append(style)

const query = new URLSearchParams(location.search)
const oldBehavior = query.get('old') === '1'
const activeTask = query.get('active') === '1'
const shotOnly = query.get('shot') === '1'
// 模拟修复前：用 !important 把面板钉回 CSS 里的 68vh，组件写进来的 max-height 就不生效了。
if (oldBehavior) document.documentElement.dataset.captureOld = 'true'

const t = translator('zh-CN')
const now = Math.floor(Date.now() / 1000)
const homePayload = {
  stats: { total: 2, week: 1, duration: 7200, recording: 0, unreviewed: 1, marks: 1 },
  items: [
    { id: 's1', title: '发布会回放', kind: 'live', status: 'done', duration: 120, created_at: now - 300, started_at: now - 400, source_url: 'https://example.com/live', platform: 'bilibili', transcripts: 2, marks: 1, screenshots: 1, has_notes: true, unreviewed: false, cover: null, snippet: '大家好，这是第一段。' },
    { id: 's2', title: '产品会议', kind: 'meeting', status: 'done', duration: 3600, created_at: now - 900, started_at: now - 900, source_url: '', platform: '', transcripts: 0, marks: 0, screenshots: 0, has_notes: false, unreviewed: true, cover: null, snippet: '' }
  ],
  highlights: [],
  batches: [],
  documents: [],
  packs: []
}
const batchBodies = []
let batchSeq = 0
// ?active=1：模拟「已经有一个正在下载的批次卡」——首页多一条活跃记录、一张进行中的批次卡，
// 面板里会出现「已有 N 个任务在运行」提示，Hero 会多一行「N 条正在进行」。
if (activeTask) {
  homePayload.stats.active = 2
  homePayload.stats.recording = 1
  homePayload.items = [
    { ...homePayload.items[0], id: 's0', title: '正在下载的批量视频', kind: 'link_video', status: 'processing', active: true },
    ...homePayload.items
  ]
  homePayload.batches = [{
    id: 'batch-live', title: '批量视频 · 正在下载', created_at: now - 120, updated_at: now - 30, total: 2, active: 1,
    counts: { queued: 1, processing: 1, done: 0, error: 0, cancelled: 0 },
    members: [
      { id: 'bl1', title: '正在下载的视频', status: 'processing', platform: 'bilibili', source_url: 'https://www.bilibili.com/video/BVlive1', duration: 0, error: '' },
      { id: 'bl2', title: '排队的视频', status: 'queued', platform: 'bilibili', source_url: 'https://www.bilibili.com/video/BVlive2', duration: 0, error: '' }
    ]
  }]
}

const json = (value, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(value) })
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  const body = options.body ? JSON.parse(String(options.body)) : null
  if (target.includes('/api/link-videos/preview')) {
    return json({ ok: true, platform: 'bilibili', title: `预览视频 ${String(body?.url || '').slice(-5)}`, subtitle_status: 'none' })
  }
  if (target.includes('/api/link-videos/batch')) {
    batchBodies.push(body)
    const results = (body.items || []).map((item, index) => ({ ok: true, id: `lb${batchBodies.length}-${index}`, title: item.url, url: item.url }))
    const members = results.map((row) => ({
      id: row.id, title: row.title, status: 'pending', platform: 'bilibili', source_url: row.url, duration: 0, error: ''
    }))
    batchSeq += 1
    const batch = {
      id: `batch-${batchSeq}`, title: `批量视频 · 测试${batchSeq}`, created_at: now, updated_at: now,
      total: members.length, active: members.length,
      counts: { queued: members.length, processing: 0, done: 0, error: 0, cancelled: 0 },
      members
    }
    homePayload.batches = [batch, ...homePayload.batches]
    return json({ ok: true, results, batch })
  }
  if (target.includes('/api/home')) return json(homePayload)
  if (target.includes('/api/meeting/options')) return json({ languages: [{ id: '', name: '自动' }], asr_ready: true })
  if (target.includes('/api/deps')) return json({ yt_dlp: true, ffmpeg: true, ready: true })
  if (target.includes('/api/sessions')) {
    return json(activeTask
      ? [{ id: 's0', title: '正在下载的批量视频', kind: 'link_video', status: 'processing', created_at: now - 60, duration: 0, transcripts: 0, marks: 0, screenshots: 0, queue_position: 1 }]
      : [])
  }
  if (target.includes('/api/sticky-notes')) return json([])
  if (target.includes('/api/board-images')) return json([])
  if (target.includes('/api/settings')) return json({ shot_sensitivity: 0.5, shot_threshold: 3.9 })
  if (target.includes('/api/cards')) return json({ ok: true, cards: [], total: 0 })
  if (target.includes('/api/packs')) return json({ packs: [] })
  return json({ detail: 'not mocked' }, false, 404)
}

createRoot(document.getElementById('root')).render(
  <div className="mc-root">
    <HomePage t={t} onToast={() => {}} onOpenRecord={() => {}} onNewCapture={() => {}} />
  </div>
)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lines = []
const log = (line) => { lines.push(line); console.log(line) }
const buttonByText = (text) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === text)
function describe(node) {
  if (!node) return 'null'
  return `${node.tagName.toLowerCase()}.${(node.className || '')}` + (node.textContent ? `「${node.textContent.trim().slice(0, 10)}」` : '')
}
function setValue(area, value) {
  const proto = area.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(area, value)
  area.dispatchEvent(new Event('input', { bubbles: true }))
}
// 面板中心点真正命中的元素是不是那个按钮——被裁掉/被底部工具条盖住时这里会露馅。
function probeButton(label) {
  const button = buttonByText(label)
  if (!button) return { ok: false, text: `[${label}] missing` }
  const rect = button.getBoundingClientRect()
  const cx = Math.round(rect.left + rect.width / 2)
  const cy = Math.round(rect.top + rect.height / 2)
  const hit = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight
    ? document.elementFromPoint(cx, cy)
    : null
  const reachable = Boolean(hit) && (hit === button || button.contains(hit))
  const text = `[${label}] rect=${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
    + ` disabled=${button.disabled} hit=${describe(hit)} reachable=${reachable}`
  return { ok: reachable && !button.disabled, text, rect }
}

async function run() {
  await wait(600)
  if (query.get('mode') === 'feed') {
    buttonByText('信息流')?.click()
    await wait(400)
  }
  const home = document.querySelector('.mc-home')
  log(`mode=${home ? home.className : 'none'} viewport=${window.innerWidth}x${window.innerHeight}`)
  document.querySelector('[data-testid="hero-new-capture"]')?.click()
  await wait(200)
  const videoEntry = [...document.querySelectorAll('[data-kind]')].find((node) => node.dataset.kind === 'video')
  if (!videoEntry) { log('FAIL video entry missing'); return }
  videoEntry.click()
  await wait(300)
  const area = document.querySelector('.mc-capture-inline textarea')
  if (!area) { log('FAIL inline textarea missing'); return }
  setValue(area, 'https://www.bilibili.com/video/BVaaa\nhttps://www.bilibili.com/video/BVbbb')
  await wait(250)
  buttonByText('预读全部')?.click()
  await wait(1000)
  const panel = document.querySelector('.mc-capture-inline')
  await wait(300)
  const homeRect = document.querySelector('.mc-home')?.getBoundingClientRect()
  const panelRect = panel?.getBoundingClientRect()
  log(`panel=${Math.round(panelRect?.top ?? -1)}..${Math.round(panelRect?.bottom ?? -1)} home=${Math.round(homeRect?.top ?? -1)}..${Math.round(homeRect?.bottom ?? -1)}`)
  const probe = probeButton('加入队列')
  log((probe.ok ? 'PASS ' : 'FAIL ') + probe.text)
  if (shotOnly) return
  // 真点一下，确认能提交（走的是同一个 submit 路径）。
  probe.rect && buttonByText('加入队列')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  await wait(700)
  log(`batchBodies=${batchBodies.length}`)
  // ?round2=1：第一批还在下载时，在同一个面板里再贴一批（新开一张批次卡）。
  if (query.get('round2') === '1') {
    const next = document.querySelector('.mc-capture-inline textarea')
    if (!next) { log('FAIL panel closed after first round'); return }
    setValue(next, 'https://www.bilibili.com/video/BVccc\nhttps://www.bilibili.com/video/BVddd')
    await wait(250)
    buttonByText('预读全部')?.click()
    await wait(1000)
    const second = probeButton('加入队列')
    log('round2 ' + (second.ok ? 'PASS ' : 'FAIL ') + second.text)
    if (!second.ok) return
    buttonByText('加入队列')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    await wait(800)
    log(`round2 batchBodies=${batchBodies.length} batches=${homePayload.batches.length}`)
  }
}

run().then(() => {
  const pre = document.createElement('pre')
  pre.id = 'probe'
  pre.textContent = lines.join('\n')
  document.body.append(pre)
}).catch((error) => {
  const pre = document.createElement('pre')
  pre.id = 'probe'
  pre.textContent = 'ERROR ' + (error?.stack || error) + '\n' + lines.join('\n')
  document.body.append(pre)
})
