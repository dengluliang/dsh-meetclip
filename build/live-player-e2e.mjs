// 直播播放器端到端验证：真 Chrome + 真 HLS（event playlist，2 秒分片，时间戳从 1.417s 起）。
// 覆盖：开始采集后自动播放（有声/静音兜底）、点击转写时间戳跳转、播放器就绪前的补跳。
// 用法：node build/live-player-e2e.mjs [--keep]
import { build } from 'esbuild'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ffmpeg = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg'
const keep = process.argv.includes('--keep')
const shots = process.argv.includes('--shot')

async function screenshot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  console.log('  shot', file)
}

const work = fs.mkdtempSync('/tmp/meetclip-live-e2e-')
const hlsDir = path.join(work, 'live')
fs.mkdirSync(hlsDir, { recursive: true })
const source = path.join(work, 'src.mp4')
const SID = 'live-e2e'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('· 生成测试片源')
await run(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '50', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', source
])

const pageEntry = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SessionDetail } from '../client-src/components/SessionDetail.jsx'
import { translator } from '../client-src/lib/i18n.js'
import { installStyles } from '../client-src/lib/styles.js'
import css from '../client-src/styles.css'

installStyles(css)

const params = new URLSearchParams(location.search)
const delay = Number(params.get('delay') || 0)
const hlsAt = Date.now() + delay
const rows = []
for (let index = 0; index < 8; index += 1) {
  rows.push({
    id: index + 1, session_id: '${SID}', start: index * 6, end: index * 6 + 6,
    speaker: null, text: '第 ' + (index + 1) + ' 段转写内容，用来验证时间戳跳转。'
  })
}
const base = {
  id: '${SID}', title: '发布会直播 · 自动播放验证', kind: 'live', status: 'recording',
  created_at: Math.floor(Date.now() / 1000) - 300, started_at: Math.floor(Date.now() / 1000) - 300,
  duration: 0, has_video: true, recording: true, processing: false, queued: false,
  media_path: null, live_preview_path: null, source_url: 'https://live.bilibili.com/1',
  live: { live_media_time: 120, asr_time: 100, audio_time: 120, motion: 1.2, motion_threshold: 3.2 },
  transcripts: rows, marks: [], screenshots: [], speakers: {}, notes_version: 0,
  minutes: { state: 'idle', version: 0 }, minutes_scenario: 'live', minutes_notes_version: 0,
  aligned: true, asr_status: 'running', stream_quality: '1080P · 1920×1080'
}
function detail() {
  return { ...base, live_hls_path: Date.now() >= hlsAt ? 'live/index.m3u8' : null }
}
window.__calls = { detail: 0 }
window.fetch = async (input) => {
  const target = String(input && input.url ? input.url : input)
  if (target.includes('/api/sessions/${SID}')) {
    window.__calls.detail += 1
    return { ok: true, status: 200, text: async () => JSON.stringify(detail()) }
  }
  if (target.includes('/app/status')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ backend: { state: 'running', phase: 'ready' }, env: { ready: true }, locations: {} }) }
  }
  return { ok: true, status: 200, text: async () => '{}' }
}
window.EventSource = class { constructor() { this.closed = false } close() { this.closed = true } }

const t = translator('zh-CN')
createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'mc-root', style: { height: '100vh' } },
    React.createElement('div', { className: 'mc-workspace' },
      React.createElement('section', { className: 'mc-content' },
        React.createElement(SessionDetail, {
          sessionId: '${SID}',
          summary: { id: '${SID}', title: base.title, duration: 0, status: 'recording', kind: 'live' },
          t, backendStopped: false, onBackendRefresh: () => {}, focus: null,
          onChanged: () => {}, onDeleted: () => {}, onCreated: () => {}
        })
      )
    )
  )
)
`.replaceAll('${SID}', SID)

const pageFile = path.join(here, '.live-player-e2e-page.jsx')
fs.writeFileSync(pageFile, pageEntry)
await build({
  entryPoints: [pageFile],
  absWorkingDir: root,
  nodePaths: [path.join(here, 'node_modules')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  loader: { '.css': 'text' },
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  inject: [path.join(root, 'client-src/react-shim.js')],
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: false,
  logLevel: 'error'
}).then((result) => {
  fs.writeFileSync(path.join(here, '.live-player-e2e-page.js'), result.outputFiles[0].text)
}).catch((error) => {
  throw error
})

console.log('· 启动直播 HLS 推流（-c copy，时间戳从 1.417s 开始）')
const streamer = spawn(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
  '-re', '-itsoffset', '1.417', '-i', source, '-t', '48',
  '-map', '0:v', '-map', '0:a', '-c', 'copy', '-avoid_negative_ts', 'make_zero',
  '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'event',
  '-hls_flags', 'independent_segments+temp_file',
  '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.ts'),
  path.join(hlsDir, 'index.m3u8')
], { stdio: ['ignore', 'ignore', 'pipe'] })
let streamerError = ''
streamer.stderr.on('data', (chunk) => { streamerError += chunk })

const pageJs = fs.readFileSync(path.join(here, '.live-player-e2e-page.js'), 'utf8')
let requestLog = 0
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (requestLog < 24 && url.pathname !== '/') {
    requestLog += 1
    console.log('  http', req.method, url.pathname)
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark'
    res.end(`<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><title>live e2e</title>
<style>
  :root[data-theme='dark'] {
    --dsw-alias-bg-base: #151517; --dsw-alias-bg-layer-1: #1f1f22; --dsw-alias-bg-layer-2: #2b2b2d;
    --dsw-alias-label-primary: #f6f6f7; --dsw-alias-label-secondary: #b6b6bb; --dsw-alias-label-tertiary: #8f8f94;
    --dsw-alias-label-caption: #6f6f74; --dsw-alias-label-primary-inverted: #151517;
    --dsw-alias-border-l1: rgba(255,255,255,.08); --dsw-alias-border-l2: rgba(255,255,255,.12);
    --dsw-alias-border-l4: rgba(255,255,255,.2); --dsw-alias-brand-primary: #f6f6f7;
    --dsw-alias-button-primary-fill: #f6f6f7; --dsw-alias-button-primary-hover: #e2e2e4;
    --dsw-alias-interactive-bg-hover: rgba(255,255,255,.06); --dsw-alias-interactive-bg-active: rgba(255,255,255,.1);
    --dsw-alias-state-success-primary: #4cc38a; --dsw-alias-state-warn-primary: #e0a43a;
    --dsw-alias-state-error-primary: #ff6b64; --dsw-alias-state-idle-primary: #6d6d72;
    --dsw-elevation-soft: 0 12px 34px -18px rgba(0,0,0,.8);
    --mc-panel-bg: #1f1f22; --mc-line: rgba(255,255,255,.12);
  }
  :root[data-theme='light'] {
    --dsw-alias-bg-base: #f7f6f3; --dsw-alias-bg-layer-1: #fff; --dsw-alias-bg-layer-2: #fff;
    --dsw-alias-label-primary: #1d1d1f; --dsw-alias-label-secondary: #6b6b70; --dsw-alias-label-tertiary: #929298;
    --dsw-alias-label-caption: #b0b0b5; --dsw-alias-label-primary-inverted: #fff;
    --dsw-alias-border-l1: rgba(0,0,0,.07); --dsw-alias-border-l2: rgba(0,0,0,.1);
    --dsw-alias-border-l4: rgba(0,0,0,.16); --dsw-alias-brand-primary: #1d1d1f;
    --dsw-alias-button-primary-fill: #1d1d1f; --dsw-alias-button-primary-hover: #333;
    --dsw-alias-interactive-bg-hover: rgba(0,0,0,.045); --dsw-alias-interactive-bg-active: rgba(0,0,0,.075);
    --dsw-alias-state-success-primary: #2f9d62; --dsw-alias-state-warn-primary: #c58a20;
    --dsw-alias-state-error-primary: #d24b45; --dsw-alias-state-idle-primary: #b5b5ba;
    --dsw-elevation-soft: 0 10px 30px -18px rgba(0,0,0,.28);
    --mc-panel-bg: #fff; --mc-line: rgba(0,0,0,.08);
  }
  html, body { margin: 0; height: 100%; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
  #root { height: 100vh; }
</style></head>
<body><div id="root"></div><script>${pageJs}</script></body></html>`)
    return
  }
  if (url.pathname.startsWith(`/meetclip/api/files/${SID}/live/`)) {
    const name = path.basename(url.pathname)
    const file = path.join(hlsDir, name)
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('missing'); return }
    res.writeHead(200, {
      'content-type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'cache-control': 'no-store'
    })
    fs.createReadStream(file).pipe(res)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
// 等第一个分片写出来
for (let i = 0; i < 80 && !fs.existsSync(path.join(hlsDir, 'index.m3u8')); i++) await sleep(200)
console.log(`· 页面地址 ${origin}`)

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exit ${code}\n${err}`))))
  })
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.events = []
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) {
        if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown') {
          this.events.push(JSON.stringify(message.params).slice(0, 400))
        }
        return
      }
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
    return result.result?.value
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
}

async function openPage(query) {
  const userDataDir = fs.mkdtempSync('/tmp/meetclip-live-e2e-chrome-')
  const port = 9400 + Math.floor(Math.random() * 400)
  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    `${origin}/?${query}`
  ], { stdio: 'ignore' })
  let target = null
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200)
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    } catch {}
  }
  if (!target) { try { chrome.kill('SIGKILL') } catch {}; throw new Error('no devtools page target') }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const cdp = new Cdp(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  return {
    cdp,
    async close() {
      try { ws.close() } catch {}
      try { chrome.kill('SIGKILL') } catch {}
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}

const VIDEO_STATE = `(() => {
  const video = document.querySelector('.mc-media-stage video')
  if (!video) return { present: false }
  const ranges = []
  try { const s = video.seekable; for (let i = 0; i < s.length; i++) ranges.push([+s.start(i).toFixed(2), +s.end(i).toFixed(2)]) } catch {}
  return {
    present: true, paused: video.paused, muted: video.muted, readyState: video.readyState,
    currentTime: +video.currentTime.toFixed(2), seekable: ranges,
    unmute: !!document.querySelector('.mc-media-unmute'),
    waiting: !!document.querySelector('.mc-media-waiting'),
    pausedHint: !!document.querySelector('.mc-media-play-hint')
  }
})()`

async function waitFor(cdp, expression, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await cdp.eval(expression)
    if (value) return value
    await sleep(200)
  }
  const dump = await cdp.eval(`({
    videos: document.querySelectorAll('video').length,
    stages: document.querySelectorAll('.mc-media-stage').length,
    waiting: document.querySelectorAll('.mc-media-waiting').length,
    media: document.querySelectorAll('.mc-media').length,
    empty: document.querySelector('.mc-media')?.innerText?.slice(0, 200) || '',
    calls: window.__calls,
    text: (document.body.innerText || '').slice(0, 500),
    ready: document.readyState
  })`).catch(() => null)
  console.log('[page dump]', JSON.stringify(dump))
  console.log('[console]', cdp.events.slice(-12).join('\n'))
  throw new Error(`等待超时：${label}`)
}

async function rowCenter(cdp, index) {
  const rect = await cdp.eval(`(() => {
    const row = document.querySelectorAll('.mc-tr')[${index}]
    if (!row) return null
    const box = row.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, start: row.querySelector('.mc-tr-time')?.textContent || '' }
  })()`)
  if (!rect) throw new Error('找不到转写行')
  return rect
}

const rowStart = (state) => state.currentTime
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${JSON.stringify(detail)}` : ''}`)
}

// ---- 用例 A：没有任何用户点击（自动播放被策略拦下 → 静音先播） ----
{
  const page = await openPage('delay=0')
  try {
    await waitFor(page.cdp, `!!document.querySelector('.mc-media-stage video')`, 25000, '直播播放器出现（无手势）')
    await waitFor(page.cdp, `(() => { const v = document.querySelector('.mc-media-stage video'); return v && !v.paused })()`, 25000, '无手势自动播放')
    await sleep(1200)
    const state = await page.cdp.eval(VIDEO_STATE)
    check('无手势时静音自动播放', !state.paused && state.muted === true, state)
    check('静音兜底有「开启声音」入口', state.unmute === true, { unmute: state.unmute })
    if (shots) await screenshot(page.cdp, path.join(here, 'live-player-muted.png'))
  } finally { await page.close() }
}

// ---- 用例 B：真实点击后自动播放（有声） ----
{
  const page = await openPage('delay=0')
  try {
    await sleep(600)
    // 模拟用户点「开始采集」后的粘性激活；如果第一次点击没拿到激活就补一次。
    await page.cdp.click(6, 6)
    await sleep(250)
    if (!await page.cdp.eval(`navigator.userActivation ? navigator.userActivation.hasBeenActive : false`)) {
      await page.cdp.click(420, 660)
      await sleep(250)
    }
    check('浏览器已获得用户激活（用于测试有声自动播放）',
      await page.cdp.eval(`navigator.userActivation ? navigator.userActivation.hasBeenActive : false`), {})
    await waitFor(page.cdp, `!!document.querySelector('.mc-media-stage video')`, 25000, '直播播放器出现（有点击）')
    await waitFor(page.cdp, `(() => { const v = document.querySelector('.mc-media-stage video'); return v && !v.paused })()`, 25000, '点击后自动播放')
    await sleep(1000)
    const state = await page.cdp.eval(VIDEO_STATE)
    check('有点击时自动播放且不是静音', !state.paused && state.muted === false, state)
    if (shots) await screenshot(page.cdp, path.join(here, 'live-player-playing.png'))

    const stop = await page.cdp.eval(`(() => {
      const button = document.querySelector('.mc-detail-actions [data-variant=stop]')
      if (!button) return null
      const style = getComputedStyle(button)
      const box = button.getBoundingClientRect()
      return {
        text: button.textContent, background: style.backgroundColor, color: style.color,
        weight: style.fontWeight, height: Math.round(box.height),
        x: box.left + box.width / 2, y: box.top + box.height / 2
      }
    })()`)
    const rgb = (stop?.background || '').match(/\d+/g)?.map(Number) || []
    const red = rgb.length >= 3 && rgb[0] > rgb[1] + 40 && rgb[0] > rgb[2] + 40
    check('停止按钮用红色填充且保持小按钮尺寸', red && stop?.height === 24, stop)
    if (stop) {
      await page.cdp.click(stop.x, stop.y)
      await sleep(500)
      const dialog = await page.cdp.eval(`(() => {
        const confirm = document.querySelector('.mc-confirm [data-variant=stop]')
        if (!confirm) return null
        const style = getComputedStyle(confirm)
        return { background: style.backgroundColor, label: confirm.textContent }
      })()`)
      const dialogRgb = (dialog?.background || '').match(/\d+/g)?.map(Number) || []
      const dialogRed = dialogRgb.length >= 3 && dialogRgb[0] > dialogRgb[1] + 40 && dialogRgb[0] > dialogRgb[2] + 40
      check('停止确认弹层的确认按钮同样用红色', dialogRed, dialog)
      if (shots) await screenshot(page.cdp, path.join(here, 'live-player-stop-confirm.png'))
      await page.cdp.click(await page.cdp.eval(`(() => {
        const cancel = [...document.querySelectorAll('.mc-confirm .mc-modal-actions .mc-button')][0]
        if (!cancel) return 0
        const box = cancel.getBoundingClientRect()
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      })()`).then((point) => (point && typeof point === 'object' ? point.x : 0)), await page.cdp.eval(`(() => {
        const cancel = [...document.querySelectorAll('.mc-confirm .mc-modal-actions .mc-button')][0]
        if (!cancel) return 0
        const box = cancel.getBoundingClientRect()
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      })()`).then((point) => (point && typeof point === 'object' ? point.y : 0)))
    }
  } finally { await page.close() }
}

// ---- 用例 C：播放器就绪前点时间戳 → 就绪后自动补跳 ----
{
  const page = await openPage('delay=6000')
  try {
    await waitFor(page.cdp, `!!document.querySelector('.mc-media-waiting')`, 15000, '连接中的占位界面')
    if (shots) await screenshot(page.cdp, path.join(here, 'live-player-waiting.png'))
    const row = await rowCenter(page.cdp, 1)
    await page.cdp.click(row.x, row.y)
    check('就绪前点击时间戳有提示而不是「没有媒体文件」', true, { row: row.start })
    await waitFor(page.cdp, `!!document.querySelector('.mc-media-stage video')`, 30000, '延迟出现的直播播放器')
    await waitFor(page.cdp, `(() => { const v = document.querySelector('.mc-media-stage video'); return v && !v.paused })()`, 25000, '延迟后自动播放')
    let landed = null
    const startedC = Date.now()
    while (Date.now() - startedC < 12000) {
      const state = await page.cdp.eval(VIDEO_STATE)
      if (state.currentTime >= 4.5 && state.currentTime <= 8) { landed = state; break }
      await sleep(150)
    }
    const state = landed || await page.cdp.eval(VIDEO_STATE)
    const toast = await page.cdp.eval(`document.body.innerText.includes('没有可播放的媒体文件')`)
    check('播放器就绪后补跳到 6 秒附近', Boolean(landed), state)
    check('不会误报没有媒体文件', toast === false, { toast })
  } finally { await page.close() }
}

// ---- 用例 E：浅色主题下停止按钮同样是红色，且与主按钮同尺寸 ----
{
  const page = await openPage('delay=0&theme=light')
  try {
    await waitFor(page.cdp, `(() => { const v = document.querySelector('.mc-media-stage video'); return v && !v.paused })()`, 30000, '浅色主题下的直播播放')
    const stop = await page.cdp.eval(`(() => {
      const button = document.querySelector('.mc-detail-actions [data-variant=stop]')
      if (!button) return null
      const style = getComputedStyle(button)
      const primary = document.querySelector('.mc-detail-actions .mc-button:not([data-variant])')
      return {
        background: style.backgroundColor, color: style.color,
        height: Math.round(button.getBoundingClientRect().height),
        primaryHeight: primary ? Math.round(primary.getBoundingClientRect().height) : null,
        radius: style.borderRadius
      }
    })()`)
    const rgb = (stop?.background || '').match(/\d+/g)?.map(Number) || []
    const red = rgb.length >= 3 && rgb[0] > rgb[1] + 40 && rgb[0] > rgb[2] + 40
    check('浅色主题的停止按钮也是红色且与主按钮等高', red && stop?.height === stop?.primaryHeight, stop)
    await sleep(1500)
    if (shots) await screenshot(page.cdp, path.join(here, 'live-player-light.png'))
  } finally { await page.close() }
}

// ---- 用例 D：播放中点后面（更早）的转写时间戳 → 精确跳转并继续播放 ----
{
  const page = await openPage('delay=0')
  try {
    await waitFor(page.cdp, `(() => { const v = document.querySelector('.mc-media-stage video'); return v && v.currentTime > 12 })()`, 40000, '直播播到 12 秒之后')
    const row = await rowCenter(page.cdp, 1)   // 6 秒
    const clickedAt = Date.now()
    const before = await page.cdp.eval(VIDEO_STATE)
    await page.cdp.click(row.x, row.y)
    let during = null
    while (Date.now() - clickedAt < 6000) {
      const state = await page.cdp.eval(VIDEO_STATE)
      if (state.currentTime < rowStart(state) + 1) { during = state; break }
      await sleep(120)
    }
    await sleep(400)
    const state = during || await page.cdp.eval(VIDEO_STATE)
    const elapsed = (Date.now() - clickedAt) / 1000
    const expected = 6 + elapsed
    check('点转写时间戳回跳到 6 秒', Math.abs(state.currentTime - expected) < 1.8, { state, expected: +expected.toFixed(2), before: before.currentTime })
    check('跳转后继续播放', state.paused === false, { paused: state.paused })
    const bar = await page.cdp.eval(`document.querySelector('.mc-player-time')?.textContent || ''`)
    const shown = Number((bar.match(/^(\d+):(\d+)/) || []).slice(1).reduce((sum, part) => sum * 60 + Number(part), 0))
    check('播放条时间与转写时间一致', Number.isFinite(shown) && Math.abs(shown - expected) < 1.8, { bar, expected: +expected.toFixed(2) })

    const full = await page.cdp.eval(`(() => {
      const button = document.querySelector('.mc-player-full')
      if (!button) return null
      const box = button.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    })()`)
    if (full) {
      await page.cdp.click(full.x, full.y)
      await sleep(700)
      const layout = await page.cdp.eval(`(() => ({
        fullscreen: !!document.fullscreenElement,
        height: Math.round(document.querySelector('.mc-media-stage video')?.getBoundingClientRect().height || 0),
        bar: !!document.querySelector('.mc-player-bar')
      }))()`)
      check('全屏后视频仍铺满且播放条在', layout.fullscreen && layout.height > 200 && layout.bar, layout)
    } else {
      check('直播播放器有全屏按钮', false, {})
    }
  } finally { await page.close() }
}

try { streamer.kill('SIGKILL') } catch {}
server.close()
fs.rmSync(pageFile, { force: true })
fs.rmSync(path.join(here, '.live-player-e2e-page.js'), { force: true })
if (!keep) fs.rmSync(work, { recursive: true, force: true })
if (streamerError.trim()) console.log('[ffmpeg]', streamerError.trim().slice(0, 600))

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length ? 1 : 0)
