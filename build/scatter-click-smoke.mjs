// 用真实鼠标事件验证散落画布上的卡片：单击打开、轻微抖动也算打开、拖动不打开。
// 依赖本机 Chrome（CHROME_PATH 可覆盖）与 build/scatter-preview.html。
// 用法：node build/build-client.mjs && node build/build-scatter-preview.mjs && node build/scatter-click-smoke.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const page_url = `file://${path.join(here, 'scatter-preview.html')}?theme=dark`
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-click-'))
const port = 9400 + Math.floor(Math.random() * 300)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
  '--force-prefers-reduced-motion', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1000', page_url
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 60 && !target; i += 1) {
  await sleep(200)
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    target = list.find((row) => row.type === 'page')
  } catch {}
}
if (!target) { chrome.kill(); throw new Error('找不到预览页面') }

const socket = new WebSocket(target.webSocketDebuggerUrl)
let messageId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
}
await new Promise((resolve) => { socket.onopen = resolve })

function send(method, params = {}) {
  const id = ++messageId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.result?.value
}

async function point(selector) {
  const raw = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return JSON.stringify([rect.x + rect.width / 2, rect.y + rect.height / 2])
  })()`)
  if (!raw) throw new Error(`找不到元素：${selector}`)
  return JSON.parse(raw)
}

async function moveTo(x, y, buttons = 0) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: buttons ? 'left' : 'none', buttons })
}

async function press(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
}

async function release(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
}

// 点卡片现在跳资料库两栏页：用右栏详情出现来判断「打开了记录」。
const opened = () => evaluate(`Boolean(document.querySelector('.mc-workspace') && document.querySelector('.mc-detail'))`)
const cardLeft = (key) => evaluate(`(document.querySelector(".mc-scatter-card[data-node='${key}']") || {}).style?.left || ''`)

async function reload() {
  await send('Page.reload', { ignoreCache: true })
  await sleep(3200)
}

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failures += 1
}

try {
  await sleep(3500)
  const key = 'session-s2'
  const titleSelector = `.mc-scatter-card[data-node='${key}'] .mc-home-card-title`

  // 1. 单击打开
  let spot = await point(titleSelector)
  await moveTo(spot[0], spot[1])
  await press(spot[0], spot[1])
  await release(spot[0], spot[1])
  await sleep(600)
  check('单击卡片打开记录', await opened())

  // 2. 手抖 2px 仍然打开
  await reload()
  spot = await point(titleSelector)
  await moveTo(spot[0], spot[1])
  await press(spot[0], spot[1])
  await moveTo(spot[0] + 2, spot[1] + 1, 1)
  await release(spot[0] + 2, spot[1] + 1)
  await sleep(600)
  check('抖动 2px 仍打开记录', await opened())

  // 3. 拖动 80px 只挪卡片，不打开
  await reload()
  spot = await point(titleSelector)
  const before = await cardLeft(key)
  await moveTo(spot[0], spot[1])
  await press(spot[0], spot[1])
  for (let step = 1; step <= 8; step += 1) {
    await moveTo(spot[0] + step * 10, spot[1] + step * 2, 1)
    await sleep(16)
  }
  await release(spot[0] + 80, spot[1] + 16)
  await sleep(700)
  const after = await cardLeft(key)
  check('拖动后不打开记录', !(await opened()))
  check('拖动确实移动了卡片', Boolean(before) && Boolean(after) && before !== after)
} finally {
  socket.close()
  chrome.kill()
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch {}
}

if (failures) {
  console.error(`scatter click smoke failed: ${failures}`)
  process.exit(1)
}
console.log('scatter click smoke OK')
