// 无头 Chrome 端到端验证转写文字的拖选、全选与复制。
// 用法：node build/transcript-copy-e2e.mjs
// 需要先生成预览：node build/build-detail-preview.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = 9337
const profile = mkdtempSync(path.join(tmpdir(), 'dsh-transcript-'))
const page = `file://${path.join(here, 'detail-preview.html')}`
const screenshot = path.join(here, 'transcript-copy-preview.png')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeout = 15000, interval = 120) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeout) {
    try {
      const value = await fn()
      if (value) return value
    } catch (failure) {
      lastError = failure
    }
    await sleep(interval)
  }
  throw lastError || new Error('timed out')
}

const chromeProcess = spawn(chrome, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--no-first-run',
  '--force-prefers-reduced-motion',
  '--force-device-scale-factor=2',
  `--user-data-dir=${profile}`,
  '--window-size=1280,900',
  `--remote-debugging-port=${port}`,
  page
], { stdio: 'ignore' })

let socket = null
let nextId = 1
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  }
  return response.result?.value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function mouseClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

async function clickToolbar(label) {
  const box = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.mc-transcript-head button'))
      .find((item) => item.textContent.trim() === ${JSON.stringify(label)})
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  if (!box) throw new Error('toolbar action not found: ' + label)
  await mouseClick(box.x, box.y)
  await sleep(220)
}

try {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return null
    const list = await response.json()
    return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null
  })

  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  })

  await send('Page.enable')
  await send('Runtime.enable')

  await waitFor(() => evaluate(`Boolean(document.querySelector('.mc-tr .mc-tr-text'))`), 20000)

  // 把转写区滚进视口，并记录工具条与行的结构。
  const structure = await evaluate(`(() => {
    document.querySelector('.mc-transcript').scrollIntoView({ block: 'start' })
    const rows = Array.from(document.querySelectorAll('.mc-tr'))
    const tools = Array.from(document.querySelectorAll('.mc-transcript-head button')).map((button) => button.textContent.trim())
    return {
      rows: rows.length,
      tags: rows.slice(0, 2).map((row) => row.tagName),
      roles: rows.slice(0, 2).map((row) => row.getAttribute('role')),
      selectable: rows.slice(0, 2).map((row) => getComputedStyle(row).userSelect),
      tools,
      first: rows[0].querySelector('.mc-tr-text').textContent,
      last: rows[rows.length - 1].querySelector('.mc-tr-text').textContent
    }
  })()`)
  assert(structure.rows > 0, 'preview has no transcript rows')
  assert(structure.tags.every((tag) => tag === 'DIV'), 'transcript rows are still buttons: ' + structure.tags.join(','))
  assert(structure.roles.every((role) => role === 'button'), 'transcript rows lost their button role')
  assert(structure.selectable.every((value) => value === 'text'), 'transcript rows are not user-selectable: ' + structure.selectable.join(','))
  assert(structure.tools.includes('全选') && structure.tools.includes('复制转写'),
    'transcript toolbar actions missing: ' + structure.tools.join(','))
  console.log(`structure OK: ${structure.rows} rows, toolbar ${structure.tools.join(' / ')}`)

  // 真实鼠标拖选：在相邻几行文字上拖动，验证浏览器原生选区。
  const box = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.mc-tr'))
    const first = rows[0].querySelector('.mc-tr-text').getBoundingClientRect()
    const last = rows[Math.min(rows.length - 1, 4)].querySelector('.mc-tr-text').getBoundingClientRect()
    return { x: first.left + 12, y: first.top + 10, x2: last.left + 150, y2: last.top + 10 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 6; step += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.x + ((box.x2 - box.x) * step) / 6,
      y: box.y + ((box.y2 - box.y) * step) / 6,
      button: 'left', buttons: 1
    })
    await sleep(20)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x2, y: box.y2, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(200)

  const dragSelection = await evaluate(`window.getSelection().toString()`)
  assert(dragSelection.trim().length > 0, 'dragging over transcript rows selected nothing')
  assert(dragSelection.includes(structure.first.trim().slice(4, 16)), 'drag selection missed the first row text')
  console.log(`drag selection OK: ${dragSelection.length} chars`)

  const selectionLabel = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.mc-transcript-head button')).find((item) => /复制/.test(item.textContent))
    return button ? button.textContent.trim() : ''
  })()`)
  assert(selectionLabel === '复制所选', 'copy button did not switch to 复制所选: ' + selectionLabel)

  // 拦截剪贴板，用真实鼠标点击「复制所选」，验证复制拿到的是选区。
  await evaluate(`(() => {
    window.__copied = []
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { window.__copied.push(String(text)) } }
      })
    } catch {}
  })()`)
  await clickToolbar('复制所选')
  const copiedSelection = await evaluate(`window.__copied[0] || ''`)
  assert(copiedSelection.length > 0, 'copy selection produced no clipboard text')
  assert(copiedSelection.trim() === dragSelection.trim(), 'copy selection did not match the selected text')
  console.log(`copy selection OK: ${copiedSelection.length} chars`)

  // 右键菜单的「复制所选」在菜单打开时记住选区，点菜单项后仍复制选区。
  await evaluate(`window.__copied = []`)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: box.x + 40, y: box.y + 4, button: 'right', buttons: 2, clickCount: 1
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: box.x + 40, y: box.y + 4, button: 'right', buttons: 0, clickCount: 1
  })
  await sleep(220)
  const menuBox = await evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.mc-context button'))
      .find((button) => button.textContent.trim().startsWith('复制所选'))
    if (!item) return null
    const rect = item.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  assert(menuBox, 'transcript context menu is missing 复制所选 while text is selected')
  await mouseClick(menuBox.x, menuBox.y)
  await sleep(220)
  const copiedMenu = await evaluate(`window.__copied[0] || ''`)
  assert(copiedMenu.trim() === dragSelection.trim(), 'context menu copy did not keep the transcript selection')
  console.log('context menu copy OK')

  // 全选按钮：选中整段转写，包含时间码、首行与末行。
  await clickToolbar('全选')
  const allSelection = await evaluate(`window.getSelection().toString()`)
  assert(allSelection.length > dragSelection.length * 2, 'select-all selected far less than expected')
  assert(allSelection.includes(structure.first.trim().slice(4, 16)), 'select-all missed the first row')
  assert(allSelection.includes(structure.last.trim().slice(4, 16)), 'select-all missed the last row')
  assert(/\d{2}:\d{2}/.test(allSelection), 'select-all did not include time codes')
  console.log(`select all OK: ${allSelection.length} chars`)

  // 无选区时按钮回到「复制转写」，复制整段并带上 [时间码]。
  await evaluate(`window.getSelection().removeAllRanges()`)
  await sleep(220)
  const allLabel = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.mc-transcript-head button')).find((item) => /复制/.test(item.textContent))
    return button ? button.textContent.trim() : ''
  })()`)
  assert(allLabel === '复制转写', 'copy button did not return to 复制转写: ' + allLabel)
  await clickToolbar('复制转写')
  const copiedAll = await evaluate(`window.__copied[1] || ''`)
  assert(copiedAll.startsWith('[00:00] '), 'full transcript copy missing the leading time code: ' + copiedAll.slice(0, 20))
  assert(copiedAll.includes(structure.first.trim().slice(4, 16)), 'full transcript copy missed the first row')
  assert(copiedAll.includes(structure.last.trim().slice(4, 16)), 'full transcript copy missed the last row')
  console.log(`copy all OK: ${copiedAll.length} chars`)

  // 键盘 ⌘A：聚焦转写行后应选中整段转写。
  await evaluate(`(() => {
    window.getSelection().removeAllRanges()
    document.querySelector('.mc-tr').focus()
  })()`)
  await sleep(120)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 0 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 0 })
  await sleep(220)
  const shortcutSelection = await evaluate(`window.getSelection().toString()`)
  assert(shortcutSelection.length > 1000, '⌘A inside the transcript did not select the transcript')
  console.log(`⌘A selection OK: ${shortcutSelection.length} chars`)

  // 选区存在时单击某行只折叠选择，不把整段选区留在页面上。
  const rowBox = await evaluate(`(() => {
    const rect = document.querySelectorAll('.mc-tr')[1].getBoundingClientRect()
    return { x: rect.left + 60, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(rowBox.x, rowBox.y)
  await sleep(150)
  const afterClick = await evaluate(`window.getSelection().toString()`)
  assert(afterClick.length <= 1, 'clicking a row left the whole transcript selected')

  // 重新全选并截图，展示工具条与高亮选区。
  await clickToolbar('全选')
  await evaluate(`document.querySelector('.mc-transcript-head').scrollIntoView({ block: 'start' })`)
  await sleep(250)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(screenshot, Buffer.from(shot.data, 'base64'))
  console.log(`screenshot written: ${screenshot}`)

  console.log('transcript copy e2e OK')
} finally {
  try { socket?.close() } catch {}
  chromeProcess.kill('SIGTERM')
  await sleep(200)
  rmSync(profile, { recursive: true, force: true })
}
