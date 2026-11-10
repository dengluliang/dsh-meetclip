import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const React = require('react')
const TestRenderer = require('react-test-renderer')
const { act } = TestRenderer

// Renders the settings slot with the Feishu tab selected and drives the whole
// one-click flow against a fake host, so a broken tab is caught without a GUI.
const feishu = { installed: false, loggedIn: false, job: null }
const json = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) })

function finishJob(delay = 40, patch = {}) {
  setTimeout(() => {
    if (!feishu.job) return
    feishu.job = { ...feishu.job, state: 'done', step: '完成', done: true, ...patch }
  }, delay)
}

globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
globalThis.__ModuleLoader__ = { load(entry) { globalThis.__entry = entry } }
globalThis.styles = { insert() { return () => {} } }
globalThis.localStorage = {
  getItem: (key) => (key === 'meetclip.settingsTab' ? 'feishu' : null),
  setItem() {},
  removeItem() {}
}
globalThis.document = { visibilityState: 'visible', querySelector: () => null, activeElement: null }
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true })
const calls = []
globalThis.fetch = async (url) => {
  const path = String(url)
  calls.push(path)
  if (path.includes('/app/feishu/status')) {
    return json({
      ok: true,
      package: { name: 'feishu-mcp-pro', registry: 'https://npm.example.test/', configured: true, serverName: 'feishu', entryId: 'mcp-feishu-pro', minNodeMajor: 20 },
      runtime: { node: '/opt/homebrew/bin/node', nodeVersion: '24.19.0', nodeMajor: 24, nodeOk: true, npx: '/opt/homebrew/bin/npx', npxOk: true },
      dsh: {
        patchPath: '/tmp/dsh/cordis.patch.yml', patchScope: 'home', entryId: 'mcp-feishu-pro', serverName: 'feishu',
        entryPresent: feishu.installed, entryLive: feishu.installed ? true : null, conflict: null
      },
      auth: {
        loggedIn: feishu.loggedIn, openId: feishu.loggedIn ? 'ou_1****cdef' : '',
        refreshExpiresAt: feishu.loggedIn ? 1893456000 : null, expired: false, needsLogin: !feishu.loggedIn
      },
      pinnedVersion: feishu.installed ? '0.27.4' : '',
      installedAt: feishu.installed ? 1793000000000 : null,
      job: feishu.job
    })
  }
  if (path.includes('/app/feishu/install')) {
    feishu.job = { action: 'install', state: 'running', step: '写入 DSH 配置', log: '→ 写入 DSH 配置\n✔ 已写入 /tmp/dsh/cordis.patch.yml', url: '', error: '', done: false }
    setTimeout(() => { feishu.installed = true }, 40)
    finishJob(40)
    return json({ ok: true, job: feishu.job })
  }
  if (path.includes('/app/feishu/login')) {
    feishu.job = { action: 'login', state: 'running', step: '等待浏览器授权', log: '→ 等待浏览器授权', url: '', error: '', done: false }
    setTimeout(() => { feishu.loggedIn = true }, 40)
    finishJob(40)
    return json({ ok: true, job: feishu.job })
  }
  if (path.includes('/app/feishu/')) return json({ ok: true, job: feishu.job })
  return json({ ok: true })
}
globalThis.EventSource = class { close() {} }

vm.runInThisContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
const plugin = globalThis.__entry.factory((name) => { if (name === 'react') return React; throw new Error(name) })
let Settings
plugin.apply({
  get: () => undefined,
  effect: (cb) => cb(),
  slots: { inject: (_n, cb) => cb(), register: (o, C) => { if (o.name === 'settings.section') Settings = C; return () => {} } }
})
setTimeout(() => { console.error('feishu smoke timeout'); process.exit(1) }, 20000).unref()

let renderer
await act(async () => {
  renderer = TestRenderer.create(React.createElement(Settings, { t: (key) => key, close: () => {} }))
})
await new Promise((r) => setTimeout(r, 150))
const text = () => JSON.stringify(renderer.toJSON())
const buttons = () => renderer.root.findAllByType('button')
const buttonWith = (label) => buttons().find((n) => JSON.stringify(n.props.children).includes(label))

if (!text().includes('飞书 MCP Pro')) throw new Error('Feishu settings card missing: ' + text().slice(0, 600))
if (!text().includes('运行条件') || !text().includes('DSH 配置') || !text().includes('飞书账号')) {
  throw new Error('Feishu status rows missing')
}
if (!text().includes('/tmp/dsh/cordis.patch.yml')) throw new Error('Patch path missing')
if (!text().includes('还没有安装')) throw new Error('Summary must say the MCP is not installed yet')
if (!buttonWith('一键安装并配置')) throw new Error('Install action missing')

const install = buttonWith('一键安装并配置')
await act(async () => { install.props.onClick() })
await new Promise((r) => setTimeout(r, 1600))
if (!feishu.installed) throw new Error('Install job never reported success')
if (!text().includes('已配置，还需要登录飞书')) throw new Error('Summary did not move to "needs login": ' + text().slice(0, 900))
if (!buttonWith('登录飞书')) throw new Error('Login action missing after install')

const login = buttonWith('登录飞书')
await act(async () => { login.props.onClick() })
await new Promise((r) => setTimeout(r, 1600))
if (!text().includes('已配置并登录')) throw new Error('Login result missing: ' + text().slice(0, 900))
if (!text().includes('入口版本') || !text().includes('0.27.4')) throw new Error('Pinned version row missing')

const doc = buttonWith('打开官方文档')
if (!doc) throw new Error('Documentation action missing')
await act(async () => { doc.props.onClick() })
await new Promise((r) => setTimeout(r, 60))
if (!calls.some((item) => item.includes('/app/open'))) throw new Error('Opening the documentation must go through the host')

console.log('feishu smoke OK')
process.exit(0)
