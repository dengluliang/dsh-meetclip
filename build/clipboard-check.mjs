// 真 Chrome 里验证「截图右键 → 复制图片」不再被剪贴板拒绝。
//
// 背景：截图按 JPEG 落盘，而 Chromium 的异步剪贴板只收 image/png，旧写法直接写
// image/jpeg 会报 `Failed to execute 'write' on 'Clipboard': Type image/jpeg not
// supported on write.`。这个脚本在同一台机器上跑真 Chrome，把两条路都走一遍：
//   1) 旧写法（JPEG 直接进 ClipboardItem）必须失败，证明问题真实存在；
//   2) 新写法（copyImageToClipboard 转码成 PNG）必须成功，并回读系统剪贴板核对
//      MIME、PNG 签名与分辨率。
//
// 用法：node build/clipboard-check.mjs
// 注意：会用一张测试图覆盖系统剪贴板。
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetclip-clipboard-check-'))

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>clipboard check</title>
<script type="module">
import { copyImageToClipboard, pngBlobFromImage } from '/client-src/lib/clipboard-image.js'

const hex = (bytes) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join(' ')

window.__check = async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 1920
  canvas.height = 1080
  const context = canvas.getContext('2d')
  context.fillStyle = '#0f62fe'
  context.fillRect(0, 0, 1920, 1080)
  context.fillStyle = '#ffffff'
  context.font = '96px -apple-system, "PingFang SC", sans-serif'
  context.fillText('会摘 · 发布会截图', 160, 580)
  const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  const png = await pngBlobFromImage(jpeg)
  const bitmap = await createImageBitmap(png)
  const out = {
    jpegType: jpeg.type,
    jpegBytes: jpeg.size,
    pngType: png.type,
    pngBytes: png.size,
    pngSignature: hex(new Uint8Array(await png.slice(0, 8).arrayBuffer())),
    pngSize: [bitmap.width, bitmap.height]
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/jpeg': jpeg })])
    out.jpegWrite = 'ok'
  } catch (failure) {
    out.jpegWrite = failure.name + ': ' + failure.message
  }
  try {
    await copyImageToClipboard(jpeg)
    out.copy = 'ok'
  } catch (failure) {
    out.copy = failure.name + ': ' + failure.message
  }
  try {
    const items = await navigator.clipboard.read()
    out.clipboardTypes = items.flatMap((item) => item.types)
    const item = items.find((entry) => entry.types.includes('image/png'))
    if (item) {
      const back = await item.getType('image/png')
      out.clipboardSignature = hex(new Uint8Array(await back.slice(0, 8).arrayBuffer()))
      out.clipboardBytes = back.size
      const backBitmap = await createImageBitmap(back)
      out.clipboardSize = [backBitmap.width, backBitmap.height]
    }
  } catch (failure) {
    out.readBack = failure.name + ': ' + failure.message
  }
  return out
}
window.__ready = true
</script>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(PAGE)
    return
  }
  const file = path.join(root, decodeURIComponent(url.pathname))
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
})

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
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
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed')
    }
    return result.result?.value
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('devtools websocket failed'))
  })
  return new Cdp(ws)
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found: ${chromePath}`)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const userDataDir = path.join(dir, 'chrome')
  const port = 9500 + Math.floor(Math.random() * 400)
  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--window-size=1280,900',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    `${origin}/`
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 100 && !target; i += 1) {
    await sleep(150)
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    } catch {}
  }
  if (!target) throw new Error('no devtools page target')

  // clipboard.write/read 要授权；Browser 域只在浏览器级连接上可用，单独开一条。
  let browser = null
  try {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json())
    browser = await connect(version.webSocketDebuggerUrl)
    await browser.send('Browser.grantPermissions', {
      origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
    })
    for (const name of ['clipboard-write', 'clipboard-read']) {
      await browser.send('Browser.setPermission', {
        origin, permission: { name }, setting: 'granted'
      }).catch((failure) => console.log(`· setPermission ${name}:`, failure.message))
    }
  } catch (failure) {
    console.log('· 剪贴板授权没拿到，回读会跳过：', failure.message)
  }

  const page = await connect(target.webSocketDebuggerUrl)
  await page.send('Runtime.enable')
  // headless 里页面拿不到焦点，clipboard.write 会报 "Document is not focused."，
  // 用 CDP 的焦点模拟绕开，不然验的不是我们的转换逻辑而是无头环境。
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.send('Page.bringToFront').catch(() => {})
  try {
    for (let i = 0; i < 100; i += 1) {
      if (await page.eval('Boolean(window.__ready)')) break
      await sleep(100)
    }
    // 真点一下页面：Chrome 把剪贴板写入绑在用户手势上，headless 没有真人点击就得补一个。
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 40, button: 'left', clickCount: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 40, button: 'left', clickCount: 1 })
    const result = await page.eval('window.__check()')
    console.log(JSON.stringify(result, null, 2))

    const problems = []
    if (result.pngSignature !== '89 50 4e 47 0d 0a 1a 0a') problems.push('转码结果不是 PNG')
    if (result.pngSize?.[0] !== 1920 || result.pngSize?.[1] !== 1080) problems.push('PNG 分辨率变了')
    if (!/not supported on write/i.test(String(result.jpegWrite))) problems.push('旧写法没有再复现失败')
    if (result.copy !== 'ok') problems.push('PNG 没写进剪贴板')
    if (result.clipboardTypes && !result.clipboardTypes.includes('image/png')) problems.push('剪贴板里没有 image/png')
    if (result.clipboardSignature && result.clipboardSignature !== '89 50 4e 47 0d 0a 1a 0a') problems.push('剪贴板里的字节不是 PNG')
    if (result.clipboardSize && (result.clipboardSize[0] !== 1920 || result.clipboardSize[1] !== 1080)) {
      problems.push('剪贴板里的图片分辨率变了')
    }
    if (problems.length) throw new Error(problems.join('；'))
    console.log(result.readBack ? 'clipboard check OK（回读被拒绝，只验证了写入）' : 'clipboard check OK')
  } finally {
    page.ws.close()
    try { browser?.ws.close() } catch {}
    try { chrome.kill('SIGKILL') } catch {}
  }
}

main()
  .catch((failure) => {
    console.error('clipboard check FAIL:', failure.message)
    process.exitCode = 1
  })
  .finally(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
