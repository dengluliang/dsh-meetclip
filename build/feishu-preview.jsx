// 「设置 → 飞书」预览：用假的 status 快照渲染真实组件。
// 用法：node build/build-feishu-preview.mjs && node build/feishu-preview-shot.mjs [state] [outfile]
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import { SettingsFeishu } from '../client-src/components/SettingsFeishu.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React
const style = document.createElement('style')
style.textContent = css
document.head.append(style)

const theme = new URLSearchParams(location.search).get('theme') || 'light'
const tokens = theme === 'dark' ? {
  '--dsw-alias-bg-base': '#151517',
  '--dsw-alias-bg-layer-1': '#232323',
  '--dsw-alias-bg-layer-2': '#2c2c2e',
  '--dsw-alias-bg-overlay': '#2c2c2e',
  '--dsw-alias-label-primary': '#f2f2f2',
  '--dsw-alias-label-secondary': '#b3b3b8',
  '--dsw-alias-label-tertiary': '#86868c',
  '--dsw-alias-label-caption': '#6f6f75',
  '--dsw-alias-border-l1': 'rgba(255,255,255,.08)',
  '--dsw-alias-border-l2': 'rgba(255,255,255,.14)',
  '--dsw-alias-border-l4': 'rgba(255,255,255,.22)',
  '--dsw-alias-brand-primary': '#f2f2f2',
  '--dsw-alias-button-primary-fill': '#f2f2f2',
  '--dsw-alias-button-primary-hover': '#ffffff',
  '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,.06)',
  '--dsw-alias-interactive-bg-active': 'rgba(255,255,255,.1)',
  '--dsw-alias-state-success-primary': '#4fbf7d',
  '--dsw-alias-state-warn-primary': '#d8a441',
  '--dsw-alias-state-error-primary': '#e66a63',
  '--mc-line': 'rgba(255,255,255,.12)',
  '--mc-serif': '"Songti SC", "STSong", "Noto Serif SC", Georgia, serif'
} : {
  '--dsw-alias-bg-base': '#f7f6f3',
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-bg-layer-2': '#ffffff',
  '--dsw-alias-bg-overlay': '#ffffff',
  '--dsw-alias-label-primary': '#1d1d1f',
  '--dsw-alias-label-secondary': '#6b6b70',
  '--dsw-alias-label-tertiary': '#929298',
  '--dsw-alias-label-caption': '#b0b0b5',
  '--dsw-alias-border-l1': 'rgba(0,0,0,.08)',
  '--dsw-alias-border-l2': 'rgba(0,0,0,.12)',
  '--dsw-alias-border-l4': 'rgba(0,0,0,.18)',
  '--dsw-alias-brand-primary': '#1d1d1f',
  '--dsw-alias-button-primary-fill': '#1d1d1f',
  '--dsw-alias-button-primary-hover': '#333333',
  '--dsw-alias-interactive-bg-hover': 'rgba(0,0,0,.045)',
  '--dsw-alias-interactive-bg-active': 'rgba(0,0,0,.075)',
  '--dsw-alias-state-success-primary': '#2f9d62',
  '--dsw-alias-state-warn-primary': '#b0801f',
  '--dsw-alias-state-error-primary': '#d24b45',
  '--mc-line': 'rgba(0,0,0,.12)',
  '--mc-serif': '"Songti SC", "STSong", "Noto Serif SC", Georgia, serif'
}
for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value)
document.body.style.background = tokens['--dsw-alias-bg-base']
document.body.style.color = tokens['--dsw-alias-label-primary']

const BASE = {
  ok: true,
  runtime: { node: '/usr/local/bin/node', nodeVersion: '24.19.0', nodeOk: true, npx: '/Users/me/bin/npx', npxOk: true },
  dsh: {
    entryPresent: true, entryLive: true, patchScope: 'home',
    patchPath: '/Users/me/.dsh/cordis.patch.yml', serverName: 'feishu', conflict: null
  },
  auth: {
    present: true, loggedIn: true, expired: false, openId: 'ou_0****c1ca',
    refreshExpiresAt: 1796521037
  },
  pinnedVersion: '0.27.4',
  job: null
}

const STATES = {
  ready: BASE,
  login: { ...BASE, auth: { ...BASE.auth, loggedIn: false, expired: false, openId: '', refreshExpiresAt: null } },
  expired: { ...BASE, auth: { ...BASE.auth, loggedIn: false, expired: true, openId: '' } },
  fresh: {
    ...BASE,
    dsh: { ...BASE.dsh, entryPresent: false, entryLive: null, patchPath: '/Users/me/.dsh/cordis.patch.yml' },
    auth: { ...BASE.auth, present: false, loggedIn: false, openId: '', refreshExpiresAt: null },
    pinnedVersion: ''
  },
  nonode: {
    ...BASE,
    runtime: { ...BASE.runtime, node: '', nodeVersion: '', nodeOk: false, npxOk: false },
    dsh: { ...BASE.dsh, entryPresent: false, entryLive: null },
    auth: { ...BASE.auth, present: false, loggedIn: false, openId: '' },
    pinnedVersion: ''
  },
  conflict: {
    ...BASE,
    dsh: { ...BASE.dsh, conflict: 'feishu-mcp', entryLive: null }
  },
  busy: {
    ...BASE,
    job: {
      action: 'login', state: 'running', step: '等待浏览器授权', done: false, error: '',
      url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_a1b2c3&state=xyz',
      log: '› 启动授权流程\n› 已打开浏览器，等待回调…\n› 本地回调端口 42119'
    }
  }
}

const state = new URLSearchParams(location.search).get('state') || 'ready'
const status = STATES[state] || STATES.ready

window.fetch = async (url) => {
  const target = String(url)
  const body = target.includes('/feishu/status') ? status : { ok: true, job: status.job }
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

const t = translator('zh-CN')

function Frame() {
  return (
    <div className="mc-settings-shell" style={{ padding: '26px 32px', maxWidth: 820, margin: '0 auto' }}>
      <header className="mc-settings-hero"><h2 className="mc-settings-title">会摘设置</h2></header>
      <nav className="mc-settings-tabs" role="tablist" aria-label="会摘设置">
        <button type="button" role="tab" className="mc-settings-tab" aria-selected="false">模型</button>
        <button type="button" role="tab" className="mc-settings-tab" aria-selected="false">采集</button>
        <button type="button" role="tab" className="mc-settings-tab" aria-selected="true">飞书</button>
      </nav>
      <SettingsFeishu t={t} />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Frame />)

if (state === 'more') {
  setTimeout(() => {
    const button = Array.from(document.querySelectorAll('.mc-feishu-tools button')).find((b) => b.textContent.trim() === '更多')
    if (button) button.click()
  }, 300)
}
