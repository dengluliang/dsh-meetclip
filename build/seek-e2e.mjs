// 会摘 seek 的真浏览器验证：真后端 + 真媒体文件，检查转写与纪要里的时间戳点击。
// 用法：node build/seek-e2e.mjs [sessionId ...]（默认跑一条会议录音和一条链接视频）
import { build } from 'esbuild'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const stateDir = path.join(process.env.HOME || '', '.dsh', 'meetclip')
const tokenFile = path.join(stateDir, 'data', '.api-token')
const backendPort = Number(process.env.MEETCLIP_PORT || 8321)
const token = fs.readFileSync(tokenFile, 'utf8').trim()
const chromePath = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sessions = process.argv.slice(2).filter(Boolean)
if (!sessions.length) sessions.push('3eb2a111bb6e', 'dfb8229ad18f')

await build({
  entryPoints: [path.join(here, 'seek-e2e-page.jsx')],
  absWorkingDir: root,
  nodePaths: [path.join(here, 'node_modules')],
  bundle: true,
  outfile: path.join(here, '.seek-e2e-page.js'),
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
})

const hlsDir = sessions.includes('live-demo')
  ? fs.mkdtempSync('/tmp/meetclip-e2e-hls-')
  : null
if (hlsDir) {
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=15:d=240',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=240',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '40',
    '-c:a', 'aac', '-b:a', '64k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.ts'),
    path.join(hlsDir, 'index.m3u8')
  ], { stdio: 'ignore' })
}
const results = new Map()
const liveInteractions = { todos: {}, highlights: [] }
const liveMinutes = {
  title: '直播剪辑测试', summary: '一句话总结直播内容。', state: 'idle', state_text: '',
  final: true, covered: 238, scenario: 'live', lang: '',
  topics: [
    { start: 8, title: '开场', summary: '主播和观众打招呼，介绍今天的直播主题。',
      points: [{ text: '介绍直播主题', t: 8, support: 1 }], fishbone: null },
    { start: 120, title: '中段', summary: '直播中段讨论了回放与时间戳。',
      points: [{ text: '中段要点', t: 120, support: 1 }], fishbone: null }
  ],
  conclusions: [{ text: '直播介绍了主题', t: 8, support: 1 }],
  todos: [{ text: '整理直播要点', owner: '主播', t: 150, support: 1 }],
  terms: [],
  labels: { summary: '总结', topics: '看点', conclusions: '结论', todos: '待办', terms: '人名和术语', heard: '听作' },
  section_order: ['summary', 'topics', 'conclusions', 'todos', 'terms']
}
function liveMinutesPayload() {
  return { ...liveMinutes, interactions: { ...liveInteractions, updated_at: Date.now() / 1000, version: 1 } }
}
let waiting = null
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>MeetClip seek e2e</title></head><body><div id="root"></div>
<script src="/page.js"></script></body></html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }
  if (url.pathname === '/page.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(fs.readFileSync(path.join(here, '.seek-e2e-page.js')))
    return
  }
  if (url.pathname === '/__result' && req.method === 'POST') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let payload = {}
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
    results.set(payload.sessionId || `unknown-${results.size}`, payload)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  if (url.pathname.startsWith('/meetclip/api/files/live-demo/live/')) {
    const name = path.basename(url.pathname)
    const file = path.join(hlsDir || '', name)
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return }
    const headers = name.endsWith('.m3u8')
      ? { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' }
      : { 'content-type': 'video/mp2t', 'cache-control': 'no-store' }
    res.writeHead(200, headers)
    fs.createReadStream(file).pipe(res)
    return
  }
  if (url.pathname === '/meetclip/api/sessions/live-demo/minutes/interactions') {
    if (req.method === 'PUT') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        liveInteractions.todos = body.todos && typeof body.todos === 'object' ? body.todos : {}
        // 故意按旧后端的行为做 NFKC：模拟已经存坏的"半角标点"高亮，验证客户端能兜底渲染。
        const nfkc = (text) => String(text || '').normalize('NFKC')
        liveInteractions.highlights = (Array.isArray(body.highlights) ? body.highlights : []).map((item) => ({
          ...item,
          quote: nfkc(item.quote),
          fragments: (item.fragments || []).map((fragment) => ({
            ...fragment, text: nfkc(fragment.text), before: nfkc(fragment.before), after: nfkc(fragment.after)
          }))
        }))
      } catch {}
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, interactions: liveMinutesPayload().interactions, notes_sync: { synced: false } }))
    return
  }
  if (url.pathname === '/meetclip/api/sessions/live-demo/minutes') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(liveMinutesPayload()))
    return
  }
  if (url.pathname === '/meetclip/api/sessions/live-demo') {
    const transcripts = []
    for (let start = 0; start < 238; start += 4) {
      transcripts.push({ id: transcripts.length + 1, session_id: 'live-demo', start, end: start + 4, text: `直播第 ${start} 秒的内容。`, speaker: null })
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({
      id: 'live-demo', title: '直播裁剪测试', kind: 'live', status: 'recording', duration: 0,
      created_at: 1793000000, started_at: 1793000000, notes: '', notes_version: 0,
      media_path: null, has_video: true, recording: true, processing: true, queued: false,
      live_hls_path: 'live/index.m3u8', live: { phase: 'recording', live_media_time: 238, phase_text: '' },
      transcripts, marks: [], screenshots: [], speakers: {},
      minutes: { state: 'idle', state_text: '', version: 1, updated_at: 1793000000, covered: 238, kind: 'live', queued: false }
    }))
    return
  }
  if (url.pathname.startsWith('/meetclip/api/')) {
    const suffix = url.pathname.slice('/meetclip'.length)
    const headers = { ...req.headers, host: `127.0.0.1:${backendPort}`, 'x-meetclip-token': token }
    delete headers.connection
    const upstream = http.request({
      host: '127.0.0.1', port: backendPort, method: req.method,
      path: `${suffix}${url.search}`, headers
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => { res.writeHead(502); res.end(String(error)) })
    req.pipe(upstream)
    return
  }
  if (url.pathname.startsWith('/meetclip/app/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const workDir = fs.mkdtempSync('/tmp/meetclip-seek-e2e-')
let chrome = null
const timeout = setTimeout(() => { try { chrome?.kill('SIGKILL') } catch {} }, 120000)

try {
  for (const sid of sessions) {
    const profile = path.join(workDir, `profile-${sid}`)
    chrome = spawn(chromePath, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${profile}`,
      `${origin}/?sid=${encodeURIComponent(sid)}`
    ], { stdio: 'ignore' })
    const started = Date.now()
    while (!results.has(sid) && Date.now() - started < 45000) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    try { chrome.kill('SIGKILL') } catch {}
    chrome = null
    if (!results.has(sid)) results.set(sid, { sessionId: sid, fatal: 'no result within 45s' })
  }
} finally {
  clearTimeout(timeout)
  try { chrome?.kill('SIGKILL') } catch {}
  server.close()
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.rmSync(path.join(here, '.seek-e2e-page.js'), { force: true })
  if (hlsDir) fs.rmSync(hlsDir, { recursive: true, force: true })
}

for (const [sid, payload] of results) {
  console.log(`\n=== ${sid} ${payload.title || ''} (${payload.kind || ''}) ===`)
  console.log(JSON.stringify(payload, null, 2))
}
