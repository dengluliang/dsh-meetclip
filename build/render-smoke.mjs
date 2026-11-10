import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

globalThis.window = { __ModuleLoader__: { load(entry) { globalThis.__entry = entry } } }
globalThis.styles = { insert() { return () => {} } }
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.document = {
  visibilityState: 'visible',
  createElement: () => ({ canPlayType: () => '' })
}
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' })

vm.runInThisContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
if (!globalThis.__entry) throw new Error('module loader was not called')
const plugin = globalThis.__entry.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected runtime require: ${name}`)
})
if (typeof plugin.apply !== 'function') throw new Error('client plugin has no apply')

const slots = {}
const ctx = {
  get: () => undefined,
  effect: (callback) => callback(),
  slots: {
    inject: (_slot, callback) => callback(),
    register: (options, Component) => {
      slots[options.name] = { options, Component }
      return () => {}
    }
  }
}
plugin.apply(ctx)

const expected = ['main', 'sidebar.panellist', 'settings.section']
for (const name of expected) {
  if (!slots[name]) throw new Error(`slot not registered: ${name}`)
}

for (const [name, entry] of Object.entries(slots)) {
  const props = { t: (key) => key }
  if (name === 'settings.section') props.close = () => {}
  const html = renderToStaticMarkup(React.createElement(entry.Component, props))
  if (!html || html.length < 20) throw new Error(`slot ${name} rendered too little`)
  if (name === 'settings.section' && !html.includes('飞书')) {
    throw new Error('settings section must expose the Feishu MCP tab')
  }
  console.log(`${name}: ${html.length} bytes html`)
}

console.log('render smoke OK')
