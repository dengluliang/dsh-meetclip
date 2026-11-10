import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const React = require('react')
const TestRenderer = require('react-test-renderer')
const { act } = TestRenderer

const state = { env: false, backend: false, key: false }
const feishu = { installed: false, loggedIn: false, job: null }
const saved = []
const baseStatus = () => ({
  ok: true, version: '0.2.1',
  backend: { state: state.backend ? 'running' : 'stopped', phase: state.backend ? 'ready' : 'stopped', mode: state.backend ? 'managed' : 'stopped', port: 8321, pid: 1, lastError: '', tokenPresent: true },
  env: { ready: state.env, exists: state.env, mlx: true, version: '3.12', venvDir: '/tmp/venv', venvPython: '/tmp/venv/python', python: '/tmp/venv/python', job: null },
  locations: { dataDir: '/tmp/data', stateDir: '/tmp/state', port: 8321, dataDirWritable: true },
  prefs: {}, config: { backendMode: 'auto', autoStart: false, tools: true }
})
const json = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) })

function finishJob(delay = 40, patch = {}) {
  setTimeout(() => {
    if (!feishu.job) return
    feishu.job = { ...feishu.job, state: 'done', step: '完成', done: true, ...patch }
  }, delay)
}

const feishuStatus = () => json({
  ok: true,
  package: { name: '@mi/feishu-mcp-pro', serverName: 'feishu', entryId: 'mcp-feishu-pro', minNodeMajor: 20 },
  runtime: { node: '/opt/homebrew/bin/node', nodeVersion: '24.19.0', nodeMajor: 24, nodeOk: true, npx: '/opt/homebrew/bin/npx', npxOk: true },
  dsh: { patchPath: '/tmp/dsh/cordis.patch.yml', entryId: 'mcp-feishu-pro', serverName: 'feishu', entryPresent: feishu.installed, entryLive: feishu.installed ? true : null, conflict: null },
  auth: { loggedIn: feishu.loggedIn, openId: feishu.loggedIn ? 'ou_1****cdef' : '', refreshExpiresAt: feishu.loggedIn ? 1893456000 : null, expired: false, needsLogin: !feishu.loggedIn },
  pinnedVersion: feishu.installed ? '0.27.4' : '',
  installedAt: feishu.installed ? 1793000000000 : null,
  job: feishu.job
})

globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
globalThis.__ModuleLoader__ = { load(entry) { globalThis.__entry = entry } }
globalThis.styles = { insert() { return () => {} } }
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.document = { visibilityState: 'visible', querySelector: () => null, activeElement: null }
const calls = []
globalThis.fetch = async (url, options = {}) => {
  const path = String(url)
  calls.push(path)
  if (path.includes('/app/asr/test')) return json({ ok: true, message: 'API Key 验证通过' })
  if (path.includes('/app/models')) return json({ ok: true, models: ['mimo-v2.5-asr', 'ASR_NonStreaming', 'gpt-4o', 'mimo-v2.6-flash'], count: 4 })
  if (path.includes('/app/status')) return json(baseStatus())
  if (path.includes('/app/setup/status')) {
    state.env = true
    return json({ ok: true, env: { ...baseStatus().env, job: { state: 'done', step: '完成', log: 'ready' } } })
  }
  if (path.includes('/app/setup')) return json({ ok: true, job: { state: 'running', step: '安装' } })
  if (path.includes('/app/backend')) { state.backend = true; return json({ ok: true }) }
  if (path.includes('/app/workspace')) {
    return json({ ok: true, created: true, workspace: { id: 'w1', title: '会摘资料', path: '/tmp/data' } })
  }
  if (path.includes('/app/feishu/status')) return feishuStatus()
  if (path.includes('/app/feishu/install')) {
    feishu.job = { action: 'install', state: 'running', step: '写入 DSH 配置', log: '→ 写入 DSH 配置', url: '', error: '', done: false }
    finishJob(40, { step: '完成' })
    setTimeout(() => { feishu.installed = true }, 40)
    return json({ ok: true, job: feishu.job })
  }
  if (path.includes('/app/feishu/login')) {
    feishu.job = { action: 'login', state: 'running', step: '等待浏览器授权', log: '→ 等待浏览器授权', url: '', error: '', done: false }
    finishJob(40)
    setTimeout(() => { feishu.loggedIn = true }, 40)
    return json({ ok: true, job: feishu.job })
  }
  if (path.includes('/app/feishu/')) return json({ ok: true, job: feishu.job })
  if (path.includes('/api/asr/engines/test')) { state.key = true; return json({ ok: true, message: '云端语音测试通过' }) }
  if (path.includes('/api/asr/engines') && String(options.method || '').toUpperCase() === 'POST') {
    saved.push(JSON.parse(options.body || '{}'))
    state.key = true
    return json({ default_provider: 'mimo', base_url: 'https://api.llm.mioffice.cn/v1', model: JSON.parse(options.body || '{}').model, has_api_key: true, ready: true })
  }
  if (path.includes('/api/asr/engines')) return json({ default_provider: state.key ? 'mimo' : 'local', base_url: 'https://api.llm.mioffice.cn/v1', model: 'xiaomi/mimo-v2.5-asr', has_api_key: state.key, ready: state.key })
  if (path.includes('/api/ai/config')) { saved.push(JSON.parse(options.body || '{}')); return json({ provider: 'mimo', base_url: 'https://api.llm.mioffice.cn/v1', model: JSON.parse(options.body || '{}').model, has_key: true, minutes_auto: 'final', minutes_language: '简体中文', auto_end_silence: 'prompt', auto_end_after: 600, providers: [], languages: [] }) }
  if (path.includes('/api/deps/install/status')) return json({ running: false, done: true, log: '', step: '' })
  if (path.includes('/api/deps')) return json({ yt_dlp: true, ffmpeg: true, asr: true, ready: true })
  if (path.includes('/api/aligner/status')) return json({ state: 'ready', ready: true })
  if (path.includes('/api/diarize/status')) return json({ state: 'ready', ready: true, package: true })
  if (path.includes('/api/home')) return json({ stats: { total: 0 }, items: [], highlights: [] })
  if (path.includes('/api/meeting/options')) return json({ asr_ready: state.key, aligner_ready: true, diarize: { ready: true, package: true }, languages: [] })
  return json({})
}
globalThis.EventSource = class { close() {} }
vm.runInThisContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
const plugin = globalThis.__entry.factory((name) => { if (name === 'react') return React; throw new Error(name) })
let Main
plugin.apply({ get: () => undefined, effect: (cb) => cb(), slots: { inject: (_n, cb) => cb(), register: (o, C) => { if (o.name === 'main') Main = C; return () => {} } } })
setTimeout(() => { console.error('setup smoke timeout'); process.exit(1) }, 30000).unref()
let renderer
await act(async () => { renderer = TestRenderer.create(React.createElement(Main, { t: (k) => k })) })
await new Promise((r) => setTimeout(r, 120))
const text = () => JSON.stringify(renderer.toJSON())
const buttons = () => renderer.root.findAllByType('button')
const buttonWith = (label) => buttons().find((n) => JSON.stringify(n.props.children).includes(label))

if (!text().includes('连接 Mify') || !text().includes('获取模型')) throw new Error('Cloud setup step did not render')
if (!text().includes('跳过')) throw new Error('Skip action must be visible before testing')
if (text().includes('下一步')) throw new Error('Next must stay hidden until the API key is tested')
if (!text().includes('云端模型') || !text().includes('安装环境') || !text().includes('完成')) {
  throw new Error('Wizard must advertise three steps')
}
if (text().includes('飞书 MCP') && !text().includes('云端模型')) throw new Error('Unexpected wizard state')
const keyInput = renderer.root.findAllByType('input').find((n) => n.props.type === 'password')
if (!keyInput) throw new Error('API key input missing')
await act(async () => { keyInput.props.onChange({ target: { value: 'sk-test-key-1234567890' } }) })
const testButton = buttonWith('获取模型')
await act(async () => { testButton.props.onClick() })
await new Promise((r) => setTimeout(r, 320))
if (!text().includes('已获取 4 个模型')) throw new Error('Model catalog count missing: ' + text().slice(0, 500))
if (!text().includes('语音转文字') || !text().includes('文字总结')) throw new Error('Model selectors missing')
const modelSelects = renderer.root.findAllByType('select')
if (modelSelects.length < 2) throw new Error('Both model lists must be selects: ' + text().slice(0, 500))
const [asrSelect, textSelect] = modelSelects
const textValues = textSelect.findAllByType('option').map((n) => n.props.value)
if (!textValues.includes('gpt-4o') || !textValues.includes('mimo-v2.6-flash')) {
  throw new Error('Text model list did not include the whole catalog: ' + JSON.stringify(textValues))
}
await act(async () => { asrSelect.props.onChange({ target: { value: 'ASR_NonStreaming' } }) })
await act(async () => { textSelect.props.onChange({ target: { value: 'gpt-4o' } }) })
// 回归：失焦 API Key 不应重拉清单，否则点开下拉时列表会消失再出现。
const catalogCalls = () => calls.filter((item) => item.includes('/app/models')).length
const beforeBlur = catalogCalls()
await act(async () => { keyInput.props.onBlur() })
if (!text().includes('文字总结')) throw new Error('Model list disappeared when the key input blurred')
await new Promise((r) => setTimeout(r, 60))
if (catalogCalls() !== beforeBlur) throw new Error('Blurring the API key refetched the catalog')
const nextButton = buttonWith('下一步')
if (!nextButton) throw new Error('Next step missing')
if (text().includes('跳过')) throw new Error('Skip should disappear after a successful test')
await act(async () => { nextButton.props.onClick() })
await new Promise((r) => setTimeout(r, 100))
if (!text().includes('存储位置')) throw new Error('Storage location row missing in step 2: ' + text().slice(0, 500))
if (!text().includes('/tmp/data')) throw new Error('Storage location did not default to the host suggestion')
// Merged step: the Feishu MCP block lives inside the install step now.
if (!text().includes('飞书 MCP（可选）')) throw new Error('Feishu block missing from the install step: ' + text().slice(0, 900))
const feishuInstall = buttonWith('安装飞书 MCP')
if (!feishuInstall) throw new Error('Feishu install action missing from step 2')
await act(async () => { feishuInstall.props.onClick() })
await new Promise((r) => setTimeout(r, 1600))
if (!text().includes('登录飞书')) throw new Error('Login action missing after the Feishu install: ' + text().slice(0, 1200))
const loginButton = buttonWith('登录飞书')
await act(async () => { loginButton.props.onClick() })
await new Promise((r) => setTimeout(r, 1800))
if (!text().includes('已配置并登录')) throw new Error('Login result missing: ' + text().slice(0, 1200))
const installButton = buttonWith('一键安装并配置')
if (!installButton) throw new Error('Install button missing')
await act(async () => { installButton.props.onClick() })
await new Promise((r) => setTimeout(r, 80))
if (!buttonWith('后台完成')) throw new Error('Background finish button missing while installing')
await new Promise((r) => setTimeout(r, 4500))
if (!text().includes('环境已就绪') && !text().includes('已可进入会摘')) throw new Error('Setup did not finish: ' + text().slice(0, 800))
if (!text().includes('进入主界面')) throw new Error('Setup done action missing')
if (!text().includes('已添加 DSH 工作区：') || !text().includes('会摘资料')) {
  throw new Error('Workspace result missing: ' + text().slice(0, 800))
}
if (!text().includes('飞书 MCP（可选）') || !text().includes('已配置并登录')) {
  throw new Error('Feishu block missing on the done step: ' + text().slice(0, 900))
}
if (!saved.some((item) => item.model === 'ASR_NonStreaming')) throw new Error('Selected ASR model was not saved: ' + JSON.stringify(saved))
if (!saved.some((item) => item.model === 'gpt-4o')) throw new Error('Selected text model was not saved: ' + JSON.stringify(saved))
console.log('setup smoke OK')
process.exit(0)
