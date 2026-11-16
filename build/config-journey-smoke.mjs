import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const TestRenderer = require('react-test-renderer')
const { act } = TestRenderer

// 「设置 → 模型」全新环境：先填地址和 Key，再连接并保存。旧版本会在这里
// 要求先有模型 ID 才能保存地址，必须先由本 smoke 把死锁打掉。
const state = { saved: false }
const saved = []
const json = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) })

globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
globalThis.__ModuleLoader__ = { load(entry) { globalThis.__entry = entry } }
globalThis.styles = { insert() { return () => {} } }
globalThis.localStorage = {
  getItem: (key) => (key === 'meetclip.settingsTab' ? 'models' : null),
  setItem() {}, removeItem() {}
}
globalThis.document = { visibilityState: 'visible', querySelector: () => null, activeElement: null }
globalThis.fetch = async (url, options = {}) => {
  const path = String(url)
  if (path.includes('/api/asr/engines/test')) return json({ ok: true, model: 'demo-asr', message: '测试通过' })
  if (path.includes('/api/ai/test')) return json({ ok: true, model: 'demo-flash', seconds: 0.2 })
  if (path.includes('/app/models')) {
    return json({
      ok: true,
      count: 4,
      models: ['demo-asr', 'ASR_NonStreaming', 'demo-flash', 'gpt-4o'],
      entries: [
        { id: 'demo-asr', wire: 'demo-asr', kind: 'speech2text' },
        { id: 'ASR_NonStreaming', wire: 'ASR_NonStreaming', kind: 'speech2text' },
        { id: 'demo-flash', wire: 'demo-flash', kind: 'llm' },
        { id: 'gpt-4o', wire: 'gpt-4o', kind: 'llm' }
      ]
    })
  }
  if (path.includes('/api/asr/engines') && String(options.method || 'GET').toUpperCase() === 'POST') {
    const body = JSON.parse(options.body || '{}')
    saved.push(body)
    state.saved = true
    return json({ default_provider: 'mimo', base_url: body.base_url, model: body.model, default_model: body.model, default_has_key: true, has_api_key: true, ready: true, custom: { enabled: false, base_url: '', model: '', has_key: false }, providers: [] })
  }
  if (path.includes('/api/asr/engines')) {
    return json({
      default_provider: 'mimo', base_url: state.saved ? 'https://gateway.example.test/v1' : '',
      model: state.saved ? 'demo-asr' : '', default_model: state.saved ? 'demo-asr' : '',
      default_has_key: state.saved, has_api_key: state.saved, ready: state.saved,
      custom: { enabled: false, base_url: '', model: '', has_key: false }, providers: []
    })
  }
  if (path.includes('/api/ai/config')) {
    const body = JSON.parse(options.body || '{}')
    saved.push(body)
    return json({ provider: 'mimo', base_url: body.base_url, model: body.model, has_key: true, own_key: false, providers: [], languages: [] })
  }
  if (path.includes('/api/ai/status')) {
    return json({
      provider: 'mimo', base_url: state.saved ? 'https://gateway.example.test/v1' : '',
      model: state.saved ? 'demo-flash' : '', has_key: state.saved, own_key: false,
      providers: [], languages: [], minutes_language: '简体中文'
    })
  }
  return json({})
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
setTimeout(() => { console.error('config smoke timeout'); process.exit(1) }, 20000).unref()
let renderer
await act(async () => { renderer = TestRenderer.create(React.createElement(Settings, { t: (k) => k })) })
await new Promise((r) => setTimeout(r, 200))
const text = () => JSON.stringify(renderer.toJSON())
const buttons = () => renderer.root.findAllByType('button')
const buttonWith = (label) => buttons().find((n) => String(JSON.stringify(n.props.children)).includes(label))

if (!text().includes('连接模型服务')) throw new Error('Model connection block missing')
if (text().includes('请先填写语音模型 ID')) throw new Error('Legacy deadlock copy is still present')
const inputs = renderer.root.findAllByType('input')
const base = inputs.find((n) => String(n.props.placeholder || '').includes('your-gateway'))
const key = inputs.find((n) => n.props.type === 'password')
if (!base || !key) throw new Error('Base URL or API Key input missing')
await act(async () => { base.props.onChange({ target: { value: 'https://gateway.example.test/v1' } }) })
await act(async () => { key.props.onChange({ target: { value: 'sk-test-key-1234567890' } }) })
const connect = buttonWith('连接并获取模型')
if (!connect) throw new Error('Connect action missing')
await act(async () => { connect.props.onClick() })
await new Promise((r) => setTimeout(r, 400))
if (!text().includes('已获取 4 个模型')) throw new Error('Catalog was not shown: ' + text().slice(0, 900))
const selects = renderer.root.findAllByType('select')
if (selects.length < 2) throw new Error('Model selectors missing after catalog')
const values = selects.map((node) => node.findAllByType('option').map((option) => option.props.value))
if (!values.some((list) => list.includes('demo-asr'))) throw new Error('ASR models missing: ' + JSON.stringify(values))
if (!values.some((list) => list.includes('demo-flash'))) throw new Error('Text models missing: ' + JSON.stringify(values))
const save = buttonWith('保存并测试')
if (!save) throw new Error('Save action missing')
await act(async () => { save.props.onClick() })
await new Promise((r) => setTimeout(r, 500))
if (!saved.some((row) => row.base_url === 'https://gateway.example.test/v1' && row.model === 'demo-asr' && row.api_key === 'sk-test-key-1234567890')) {
  throw new Error('ASR base/key/model were not saved atomically: ' + JSON.stringify(saved))
}
if (!saved.some((row) => row.base_url === 'https://gateway.example.test/v1' && row.model)) {
  throw new Error('Text model config was not saved: ' + JSON.stringify(saved))
}
console.log('config journey smoke OK')
process.exit(0)
