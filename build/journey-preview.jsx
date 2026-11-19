import React from './journey-react.js'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import { translator } from '../client-src/lib/i18n.js'
import { Panel } from '../client-src/components/Panel.jsx'
import { Settings } from '../client-src/components/Settings.jsx'
import { SetupWizard } from '../client-src/components/SetupWizard.jsx'
import { SetupProgressCards } from '../client-src/components/home/SetupProgressCards.jsx'
import { LaunchForm, VideoForm } from '../client-src/components/NewCaptureDialog.jsx'
import { DocCardForm } from '../client-src/components/capture/DocCardForm.jsx'
import { SessionDetail } from '../client-src/components/SessionDetail.jsx'

const style = document.createElement('style')
style.textContent = css
document.head.append(style)

const params = new URLSearchParams(location.search)
const scene = params.get('scene') || 'home'
const light = params.get('theme') !== 'dark'
const t = translator('zh-CN')

if (light) {
  const tokens = {
    '--dsw-alias-bg-base': '#f7f6f3',
    '--dsw-alias-bg-layer-1': '#ffffff',
    '--dsw-alias-bg-layer-2': '#ffffff',
    '--dsw-alias-bg-overlay': '#ffffff',
    '--dsw-alias-label-primary': '#1d1d1f',
    '--dsw-alias-label-secondary': '#6b6b70',
    '--dsw-alias-label-tertiary': '#929298',
    '--dsw-alias-label-caption': '#b0b0b5',
    '--dsw-alias-label-primary-inverted': '#ffffff',
    '--dsw-alias-border-l1': 'rgba(0,0,0,.08)',
    '--dsw-alias-border-l2': 'rgba(0,0,0,.12)',
    '--dsw-alias-border-l4': 'rgba(0,0,0,.18)',
    '--dsw-alias-brand-primary': '#1d1d1f',
    '--dsw-alias-button-primary-fill': '#1d1d1f',
    '--dsw-alias-button-primary-hover': '#333333',
    '--dsw-alias-interactive-bg-hover': 'rgba(0,0,0,.045)',
    '--dsw-alias-interactive-bg-active': 'rgba(0,0,0,.075)',
    '--dsw-alias-state-success-primary': '#2f9d62',
    '--dsw-alias-state-error-primary': '#d24b45',
    '--dsw-alias-state-warn-primary': '#b7791f',
    '--mc-line': 'rgba(0,0,0,.12)'
  }
  for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value)
  document.body.style.background = tokens['--dsw-alias-bg-base']
  document.body.style.color = tokens['--dsw-alias-label-primary']
}

const json = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) })
const state = { setupReady: false, setupRunning: false, savedModels: false, account: false }
let docInput = ''

const statusPayload = () => ({
  ok: true, version: '0.9.15',
  backend: { state: 'running', phase: 'ready', port: 8321, pid: 1, mode: 'managed', lastError: '' },
  env: { ready: true, exists: true, version: '3.12', venvDir: '/tmp/venv', venvPython: '/tmp/venv/python', python: '/tmp/venv/python', job: null },
  locations: { dataDir: '/Users/me/Documents/会摘资料', dataDirCanonical: '/Users/me/Documents/会摘资料', stateDir: '/tmp/state', suggestedDataDir: '/Users/me/Documents/会摘资料', port: 8321, dataDirWritable: true },
  library: { id: 'work', name: '工作', dataDir: '/Users/me/Documents/会摘资料' },
  libraries: [{ id: 'work', name: '工作', dataDir: '/Users/me/Documents/会摘资料', active: true, exists: true, hasLibrary: true, records: 1 }],
  sharedDir: '/tmp/shared', prefs: {}, config: {},
  ai: { baseUrl: '', provider: 'mimo', model: '' }
})
const setupStatus = () => ({
  ok: true,
  env: {
    ...statusPayload().env,
    ready: state.setupReady,
    job: state.setupRunning ? { state: 'running', step: '安装 Python 环境', log: '→ 创建独立运行环境\n→ 安装依赖', done: false } : null
  },
  ai: { baseUrl: '' }
})
const feishuStatus = () => {
  const signed = scene === 'settings-feishu' || scene === 'settings-account'
  return {
    ok: true,
    package: { configured: true, name: 'feishu-mcp-pro' },
    runtime: { npxOk: true, nodeOk: true, node: '/opt/homebrew/bin/node', nodeVersion: '24.0.0' },
    dsh: { entryPresent: signed, entryLive: signed ? true : null, conflict: null, patchPath: '/tmp/dsh/cordis.patch.yml' },
    auth: signed
      ? { loggedIn: true, expired: false, accessExpired: true, openId: 'ou_1***cdef', refreshExpiresAt: 1893456000, accessExpiresAt: 1793000000 }
      : { loggedIn: false, expired: false, accessExpired: false, openId: '', refreshExpiresAt: null },
    pinnedVersion: signed ? '0.27.4' : '',
    job: null,
    lastDocReadAt: 0
  }
}
const record = {
  id: 's-login', title: '这条 B站视频', kind: 'link_video', status: 'error',
  created_at: 1793000000, started_at: 1793000000, duration: 120, source_url: 'https://www.bilibili.com/video/BV1login',
  platform: 'bilibili', error: '这条 B站视频需要登录后才能读取（可能是会员、充电、地区限制或平台风控）。请扫码登录 B站，登录后点「重试」。',
  link_error: { status: 'login_required', code: 'login_required', platform: 'bilibili', message: '这条 B站视频需要登录后才能读取。请扫码登录 B站，登录后点「重试」。', action: { id: 'bilibili_login', label: '扫码登录 B站', platform: 'bilibili' }, detail: 'ERROR: [BiliBili] HTTP Error 412' },
  link_job: { job_state: 'error', phase: 'error', error_code: 'login_required', error_message: '需要登录', retry_count: 0 },
  transcripts: [], marks: [], screenshots: [], speakers: {}, notes: '', notes_version: 0,
  minutes: null, minutes_enabled: true, asr_status: 'ready', has_video: true, media_path: 'media.mp4', recording: false, processing: false
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  const method = String(options.method || 'GET').toUpperCase()
  if (target.includes('/app/status')) return json(statusPayload())
  if (target.includes('/app/setup/status')) return json(setupStatus())
  if (target.includes('/app/setup')) {
    state.setupRunning = true
    setTimeout(() => { state.setupReady = true; state.setupRunning = false }, 120)
    return json({ ok: true, job: { state: 'running', step: '安装' } })
  }
  if (target.includes('/api/home')) {
    return json({ stats: { total: 1, week: 1, duration: 120, active: 0, live: 0, link_video: 1, meeting: 0, marks: 0 }, items: [], highlights: [], batches: [], documents: [], packs: [] })
  }
  if (target.includes('/api/asr/engines/test')) return json({ ok: true, model: 'demo-asr', message: '测试通过' })
  if (target.includes('/api/ai/test')) return json({ ok: true, model: 'demo-flash', seconds: 0.2 })
  if (target.includes('/app/models') || target.includes('/api/models/catalog') || target.includes('/api/models/usable')) {
    return json({
      ok: true, count: 4, models: ['demo-asr', 'demo-flash', 'mimo-v2.6-pro', 'gpt-4o'],
      entries: [
        { id: 'demo-asr', wire: 'demo-asr', kind: 'speech2text' },
        { id: 'demo-flash', wire: 'demo-flash', kind: 'llm' },
        { id: 'mimo-v2.6-pro', wire: 'mimo-v2.6-pro', kind: 'llm' },
        { id: 'gpt-4o', wire: 'gpt-4o', kind: 'llm' }
      ]
    })
  }
  if (target.includes('/api/asr/engines') && method === 'POST') {
    const body = JSON.parse(options.body || '{}')
    state.savedModels = true
    return json({ default_provider: 'mimo', base_url: body.base_url, model: body.model, default_model: body.model, default_has_key: true, has_api_key: true, ready: true, custom: { enabled: false }, providers: [] })
  }
  if (target.includes('/api/asr/engines')) {
    return json({ default_provider: 'mimo', base_url: state.savedModels ? 'https://gateway.example.test/v1' : '', model: state.savedModels ? 'demo-asr' : '', default_model: state.savedModels ? 'demo-asr' : '', default_has_key: state.savedModels, has_api_key: state.savedModels, has_key: state.savedModels, ready: state.savedModels, custom: { enabled: false, base_url: '', model: '', has_key: false }, providers: [] })
  }
  if (target.includes('/api/ai/status')) return json({ provider: 'mimo', base_url: state.savedModels ? 'https://gateway.example.test/v1' : '', model: state.savedModels ? 'demo-flash' : '', has_key: state.savedModels, own_key: false, providers: [], languages: [] })
  if (target.includes('/api/ai/config')) return json({ provider: 'mimo', base_url: 'https://gateway.example.test/v1', model: 'demo-flash', has_key: true, providers: [], languages: [] })
  if (target.includes('/api/settings')) return json({ shot_sensitivity: 0.5, link_browser_cookies: false, link_cookie_browser: 'chrome', link_max_height: 0 })
  if (target.includes('/api/bilibili/status')) return json({ logged_in: false, uname: '', error: '' })
  if (target.includes('/api/douyin/status')) return json({ saved: false, count: 0, updated_at: 0, browser: 'chrome', last_url: '' })
  if (target.includes('/app/feishu/status')) return json(feishuStatus())
  if (target.includes('/app/feishu/doc-preview')) return json({ ok: false, code: 'feishu_not_logged_in', detail: '飞书登录已失效或未登录', hint: '到会摘面板右上角「设置 → 飞书」重新登录后重试，或先仅登记链接。' }, 409)
  if (target.includes('/app/link/preview')) {
    const body = JSON.parse(options.body || '{}')
    if (String(body.url).includes('feishu.cn')) {
      return json({ ok: false, code: 'feishu_not_logged_in', detail: '飞书登录已失效或未登录', hint: '到会摘面板右上角「设置 → 飞书」重新登录后重试，或先仅登记链接。' }, 409)
    }
    if (String(body.url).includes('mp.weixin.qq.com')) {
      return json({
        ok: true, kind: 'wechat', doc_type: 'wechat',
        title: '小米发布会：一口气看完', site: '差评', author: '',
        published_at: '2026-11-03 20:00', excerpt: '手机、汽车和价格，一篇看完。',
        has_content: true, content_chars: 5200, link_only: false, warning: ''
      })
    }
    return json({
      ok: true, kind: 'web', doc_type: 'web', title: 'The Age of AI Hardware',
      site: 'example.com', author: 'Jane Doe', published_at: '2026-10-28 09:30',
      excerpt: 'Why the second wave of AI hardware may finally stick.',
      has_content: true, content_chars: 8600, link_only: false, warning: ''
    })
  }
  if (target.includes('/app/link/card')) return json({ ok: true, created: true, card: { title: '小米发布会：一口气看完', doc_type: 'wechat', site: '差评' } })
  if (target.includes('/app/feishu/')) return json({ ok: true, job: null })
  if (target.includes('/api/deps')) return json({ yt_dlp: true, ffmpeg: true, ready: true })
  if (target.includes('/api/meeting/options')) return json({ asr_ready: scene !== 'progress', languages: [] })
  if (target.includes('/api/link-videos/preview')) {
    const douyin = target.includes('douyin') || scene === 'video-douyin'
    return json({
      ok: false, status: 'login_required', code: 'login_required',
      platform: douyin ? 'douyin' : 'bilibili',
      message: douyin ? '抖音要求登录后才能下载这条视频。请打开抖音登录页，扫码后读取登录状态，再点「重试」。' : '这条 B站视频需要登录后才能读取。请扫码登录 B站，登录后点「重试」。',
      action: douyin ? { id: 'douyin_login', label: '登录抖音', platform: 'douyin' } : { id: 'bilibili_login', label: '扫码登录 B站', platform: 'bilibili' },
      detail: douyin ? 'ERROR: [Douyin] Fresh cookies are needed' : 'ERROR: [BiliBili] HTTP Error 412'
    })
  }
  if (target.includes('/api/precheck')) return json({ ok: false, status: 'unreachable', code: 'bilibili_live_blocked', message: 'B站接口暂时拒绝了这次查询（风控/频率限制）。请稍后重试；登录 B站可降低触发概率。', action: { id: 'bilibili_login', label: '扫码登录 B站', platform: 'bilibili' }, detail: 'code=-352 request blocked' })
  if (target.includes('/api/sessions/s-login')) return json(record)
  if (target.includes('/api/sessions')) return json([record])
  return json({})
}
globalThis.EventSource = class { close() {} }
globalThis.localStorage = {
  getItem: (key) => (key === 'meetclip.settingsTab' ? (scene.includes('feishu') ? 'feishu' : scene.includes('account') ? 'models' : scene.includes('live') || scene.includes('video') || scene.includes('storage') || scene.includes('capture') ? 'capture' : 'models') : null),
  setItem() {}, removeItem() {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clickText = (text) => {
  const button = [...document.querySelectorAll('button')].find((node) => String(node.textContent || '').includes(text))
  button?.click()
  return Boolean(button)
}
const clickLabel = (label) => {
  const button = document.querySelector(`button[aria-label="${label}"]`)
  button?.click()
  return Boolean(button)
}
const setNativeValue = (node, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

function frame(children, className = '') {
  return <div className={`mc-root ${className}`} style={{ height: '100vh' }}><div className="mc-ambient" aria-hidden="true"><i /><i /><i /></div>{children}</div>
}

function settingsScene(tab) {
  return frame(<div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}><div style={{ padding: '22px 24px', maxWidth: 1040, margin: '0 auto' }}><Settings t={t} initialTab={tab} onRestartSetup={() => {}} /></div></div>)
}

function panelScene() {
  return <Panel t={t} />
}

function setupScene() {
  return frame(<SetupWizard t={t} status={statusPayload()} onComplete={() => {}} />)
}

function progressScene() {
  return frame(<div style={{ padding: '28px', maxWidth: 760 }}><SetupProgressCards variant="feed" /></div>)
}

function videoScene(douyin = false) {
  return frame(<div style={{ padding: '32px', maxWidth: 860, margin: '0 auto' }}><div className="mc-modal mc-new-modal" style={{ width: '100%', maxHeight: 'none' }}><div className="mc-new-body"><VideoForm t={t} options={{ asr_ready: true, languages: [] }} initialUrl={douyin ? 'https://www.douyin.com/video/7300000000000000000' : 'https://www.bilibili.com/video/BV1login'} onClose={() => {}} onCreated={() => {}} /></div></div></div>)
}

function launchScene() {
  return frame(<div style={{ padding: '32px', maxWidth: 760, margin: '0 auto' }}><div className="mc-modal mc-new-modal" style={{ width: '100%', maxHeight: 'none' }}><div className="mc-new-body"><LaunchForm t={t} health={{ depsReady: true, asrReady: true, active: 0 }} initialUrl="https://live.bilibili.com/5146309" onClose={() => {}} onCreated={() => {}} /></div></div></div>)
}

function docScene() {
  return frame(<div style={{ padding: '32px', maxWidth: 760, margin: '0 auto' }}><div className="mc-modal mc-new-modal" style={{ width: '100%', maxHeight: 'none' }}><div className="mc-new-body"><DocCardForm t={t} onClose={() => {}} onCreated={() => {}} /></div></div></div>)
}

function recordScene() {
  return frame(<div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}><SessionDetail sessionId="s-login" summary={record} t={t} backendStopped={false} onBackendRefresh={() => {}} onChanged={() => {}} onDeleted={() => {}} onCreated={() => {}} /></div>)
}

function App() {
  React.useEffect(() => {
    const run = async () => {
      await sleep(120)
      if (scene === 'settings-feishu') clickText('飞书')
      if (scene === 'settings-about') clickText('关于')
      if (scene === 'settings-capture' || scene === 'settings-live' || scene === 'settings-video' || scene === 'storage') clickText('采集')
      if (scene === 'settings-account') clickText('账号')
      if (scene === 'settings-dialog') clickLabel('设置')
      if (scene === 'help') clickLabel('使用指南')
      if (scene === 'setup-step2') clickText('跳过')
      if (scene === 'setup-step3') {
        clickText('跳过')
        await sleep(100)
        clickText('一键安装并配置')
      }
      if (scene === 'progress') clickText('配置')
      if (scene === 'doc') {
        const input = document.querySelector('.mc-new-form input')
        if (input) setNativeValue(input, 'https://example.feishu.cn/docx/ExampleDocToken1')
        await sleep(900)
      }
      if (scene === 'doc-link') {
        const input = document.querySelector('.mc-new-form input')
        if (input) setNativeValue(input, 'https://mp.weixin.qq.com/s/AbCdEf123456')
        await sleep(1100)
      }
    }
    run()
  }, [])

  if (scene === 'home' || scene === 'settings-dialog' || scene === 'help') return panelScene()
  if (scene === 'settings-models') return settingsScene('models')
  if (scene === 'settings-account') return settingsScene('account')
  if (scene === 'settings-feishu') return settingsScene('feishu')
  if (scene === 'settings-about') return settingsScene('about')
  if (scene === 'settings-capture' || scene === 'settings-live' || scene === 'settings-video' || scene === 'storage') return settingsScene('capture')
  if (scene === 'setup-step1' || scene === 'setup-step2' || scene === 'setup-step3') return setupScene()
  if (scene === 'progress') return progressScene()
  if (scene === 'video-bili') return videoScene(false)
  if (scene === 'video-douyin') return videoScene(true)
  if (scene === 'launch') return launchScene()
  if (scene === 'doc' || scene === 'doc-link') return docScene()
  if (scene === 'record') return recordScene()
  return panelScene()
}

createRoot(document.getElementById('root')).render(<App />)
