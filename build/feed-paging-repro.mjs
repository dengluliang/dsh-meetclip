// 复现/回归：信息流翻到底时 IntersectionObserver 反复触发 loadMore，
// 页脚文字在「正在加载…」和「继续下滑」之间来回闪，同时不断打 /api/home。
//
// 用法：node build/feed-paging-repro.mjs
// 期望：请求数有限（首页 1 次 + 3 页 + 最多 1 次空页），且页脚进入终态后不再翻转。
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const React = require('react')
const TestRenderer = require('react-test-renderer')
const { act } = TestRenderer

const TOTAL = 164
const PAGE = 60
const BATCH_MEMBERS = 49

const sessions = Array.from({ length: TOTAL }, (_, index) => ({
  id: `s${index}`,
  title: `视频 ${index}`,
  kind: 'link_video',
  status: 'done',
  created_at: 1793000000 - index * 60,
  started_at: 1793000000 - index * 60,
  duration: 120,
  transcripts: 1,
  marks: 0,
  screenshots: 0,
  source_url: `https://example.com/v/${index}`
}))
// 末尾 49 条被批次卡收进浮层，墙上不单独显示（和截图里的「批量视频 · 45/49 完成」一致）。
const batchMemberIds = sessions.slice(TOTAL - BATCH_MEMBERS).map((row) => row.id)
const batches = [{
  id: 'batch-1',
  title: '批量视频 · 11-09 15:49',
  created_at: 1793000000,
  total: BATCH_MEMBERS,
  active: 2,
  counts: { queued: 1, processing: 1, done: BATCH_MEMBERS - 4, error: 2, cancelled: 0 },
  members: batchMemberIds.map((id, index) => ({
    id,
    title: `视频 ${TOTAL - BATCH_MEMBERS + index}`,
    status: index < BATCH_MEMBERS - 4 ? 'done' : 'processing',
    platform: 'bilibili',
    source_url: '',
    duration: 120,
    error: ''
  }))
}]

const homeRequests = []

function json(data, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(data) }
}

const SCENARIO = (process.argv.find((arg) => arg.startsWith('--scenario=')) || '--scenario=normal').split('=')[1]

function page(offset) {
  let rows = sessions.slice(offset, offset + PAGE)
  // 分页原地打转：不管 offset 多少都回同一页满数据（排序抖动/后端忽略 offset 时的真实形态）。
  if (SCENARIO === 'dupe') rows = sessions.slice(0, PAGE)
  return { stats: { total: TOTAL }, items: rows, highlights: [], batches, documents: [], packs: [] }
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
try {
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
} catch {}
globalThis.EventSource = class {
  constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; this.closed = false }
  close() { this.closed = true }
}
const statusPayload = {
  ok: true, version: '0.9.11',
  backend: { state: 'running', phase: 'ready', port: 8321, pid: 100, mode: 'managed', version: 3, restarts: 0, lastError: '' },
  env: { ready: true, mlx: true, version: '3.12', venvDir: '/tmp/venv', venvPython: '/tmp/venv/bin/python', python: '/tmp/venv/bin/python', exists: true, job: null },
  locations: { dataDir: '/tmp/data', dataDirCanonical: '/tmp/data', stateDir: '/tmp/state', port: 8321, venv: '/tmp/venv', tokenPresent: true, dataDirExists: true, dataDirWritable: true, venvReady: true },
  library: { id: 'work', name: '工作', dataDir: '/tmp/data', virtual: false },
  libraries: [],
  settings: {},
  update: { state: 'idle' }
}

globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/app/status')) return json(statusPayload)
  if (target.includes('/api/home')) {
    const offset = Number(new URL(target, 'http://127.0.0.1').searchParams.get('offset') || 0)
    homeRequests.push(offset)
    // 真实后端要几十到几百毫秒；同步返回会把 setMore(true) 和 setMore(false) 合进同一次渲染，掩盖闪烁。
    await new Promise((resolve) => setTimeout(resolve, 120))
    // 页码越界后的请求直接失败：前端应停在「加载失败，点击重试」，而不是继续自动重试。
    if (SCENARIO === 'error' && offset > 0) return json({ detail: 'boom' }, false, 500)
    return json(page(offset))
  }
  if (target.includes('/api/sticky-notes')) return json([])
  if (target.includes('/api/board/images')) return json([])
  if (target.includes('/api/packs')) return json([])
  if (target.includes('/api/status')) return json({ ok: true })
  return json({ detail: 'not mocked' }, false, 404)
}

// 记录每次重新 observe：真实容器里 observe() 会立即回调一次当前相交状态。
const observed = []
const disconnectCount = { value: 0 }
class FakeIntersectionObserver {
  constructor(callback) { this.callback = callback }
  observe(node) {
    observed.push(node)
    setTimeout(() => {
      if (this.disconnected) return
      this.callback([{ isIntersecting: true, target: node }], this)
    }, 0)
  }
  unobserve() {}
  disconnect() { this.disconnected = true; disconnectCount.value += 1 }
  takeRecords() { return [] }
}
globalThis.IntersectionObserver = FakeIntersectionObserver
globalThis.window.IntersectionObserver = FakeIntersectionObserver

// 默认被测当前构建产物；MC_CLIENT=… 可指向旧版本，做修复前后对照。
const clientPath = process.env.MC_CLIENT || fileURLToPath(new URL('../client.js', import.meta.url))
if (!fs.existsSync(clientPath)) throw new Error(`找不到 client.js：${clientPath}`)
vm.runInThisContext(fs.readFileSync(clientPath, 'utf8'))
if (!globalThis.__entry) throw new Error('loader not called')
const plugin = globalThis.__entry.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require ' + name)
})

const slots = {}
plugin.apply({
  get: () => undefined,
  effect: (callback) => callback(),
  inject: (names, callback) => {
    if (!names.includes('uiWorkspace')) return { dispose() {} }
    const services = {
      sessions: { async create() { return 'session-1' }, async using(_id, _options, operation) { return operation({ binding: { session: { async prompt() { return { ok: true } } } } }) } },
      uiWorkspace: { openSession() {} },
      conversation: { input: { shell() { return { setDraft() {}, focus() {} } } } }
    }
    callback({ ...services, get: (name) => services[name], effect: (fn) => fn() })
    return { dispose() {} }
  },
  slots: {
    inject: (_slot, callback) => callback(),
    register: (options, Component) => { slots[options.name] = { options, Component }; return () => {} }
  }
})

const t = (key) => key
const nodeMock = () => ({
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
  getClientRects: () => [{}],
  querySelector: () => null, querySelectorAll: () => [],
  scrollIntoView() {}, focus() {}, blur() {},
  style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
  dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0
})

let renderer
await act(async () => {
  renderer = TestRenderer.create(React.createElement(slots.main.Component, { t }), {
    createNodeMock: () => nodeMock()
  })
})

// 等首屏落地，切到「信息流」（默认是散落墙，滚动翻页只在信息流里有）。
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })
const feedTab = renderer.root.findAllByType('button')
  .find((node) => String(node.props?.children ?? '') === '信息流')
if (!feedTab) throw new Error('找不到「信息流」切换按钮')
await act(async () => { feedTab.props.onClick({ preventDefault() {} }) })

function textOf(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (value && typeof value === 'object' && value.props) return textOf(value.props.children)
  return ''
}
const footer = () => {
  const nodes = renderer.root.findAll((node) => String(node.props?.className || '') === 'mc-home-more')
  return nodes.length ? textOf(nodes[0].props.children) : ''
}

// 让翻页与观察器回调都跑完（真实网络约 0.1–0.3s/次），同时记录页脚文字的每次变化。
const footerSamples = []
for (let round = 0; round < 120; round += 1) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
  const value = footer()
  if (footerSamples[footerSamples.length - 1] !== value) footerSamples.push(value)
}
const last = footer()

const summary = {
  scenario: SCENARIO,
  homeRequests: homeRequests.length,
  offsets: homeRequests,
  footer: last,
  footerSequence: footerSamples,
  observes: observed.length,
  disconnects: disconnectCount.value
}
console.log(JSON.stringify(summary, null, 2))

await act(async () => { renderer.unmount() })

const EXPECTED = { normal: 3, dupe: 2, error: 2 }[SCENARIO]
if (typeof EXPECTED !== 'number') throw new Error(`unknown scenario ${SCENARIO}`)
if (homeRequests.length > EXPECTED + 1) {
  console.error(`FAIL 翻页没有收敛：/api/home 请求 ${homeRequests.length} 次（offsets=${homeRequests.join(',')}）`)
  process.exit(1)
}
if (SCENARIO === 'error') {
  if (!last.includes('点击重试')) { console.error(`FAIL 失败后页脚应是重试按钮，实际是「${last}」`); process.exit(1) }
} else if (last !== '没有更多了') {
  console.error(`FAIL 页脚终态应是「没有更多了」，实际是「${last}」`)
  process.exit(1)
}
if (observed.length !== disconnectCount.value) {
  console.error(`FAIL 观察器泄漏：observe ${observed.length} 次，disconnect ${disconnectCount.value} 次`)
  process.exit(1)
}
// 终态文案只应出现一次并且一直停在最后：再翻转就是截图里那种来回闪。
const terminalHits = footerSamples.filter((value) => value === last).length
if (terminalHits !== 1 || footerSamples[footerSamples.length - 1] !== last) {
  console.error(`FAIL 页脚在终态后仍在翻转：${footerSamples.join(' → ')}`)
  process.exit(1)
}
console.log(`PASS 翻页收敛，页脚序列：${footerSamples.join(' → ')}`)
