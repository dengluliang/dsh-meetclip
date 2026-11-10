// 「设置 → 模型」预览：语音转文字 / 文字总结的「测试连接」按钮。
// 用法：node build/build-settings-preview.mjs && node build/settings-preview-shot.mjs [--light]
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import { SettingsModels } from '../client-src/components/SettingsModels.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React
const style = document.createElement('style')
style.textContent = css
document.head.append(style)

const light = new URLSearchParams(location.search).get('theme') === 'light'
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
    '--mc-line': 'rgba(0,0,0,.12)'
  }
  for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value)
  document.body.style.background = tokens['--dsw-alias-bg-base']
  document.body.style.color = tokens['--dsw-alias-label-primary']
}

const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })
window.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/api/asr/engines/test')) {
    return json({ ok: true, model: 'xiaomi/mimo-v2.5-asr', base_url: 'https://api.llm.mioffice.cn/v1',
      message: '已完成 1 秒测试音频请求；识别效果与直播延迟需使用真实音频验证', metrics: {}, capabilities: {} })
  }
  if (target.includes('/api/ai/test')) {
    return json({ ok: true, seconds: 0.42, provider: 'mimo', model: 'mimo-v2.6-flash',
      wire_model: 'xiaomi/mimo-v2.6-flash', base_url: 'https://api.llm.mioffice.cn/v1' })
  }
  if (target.includes('/api/asr/engines')) {
    return json({
      default_provider: 'mimo', base_url: 'https://api.llm.mioffice.cn/v1',
      model: 'xiaomi/mimo-v2.5-asr', mify_model: 'xiaomi/mimo-v2.5-asr',
      mify_has_key: true, has_api_key: true, has_key: true, credential_error: '', ready: true,
      custom: { base_url: '', enabled: false, has_key: false, model: '' }, providers: []
    })
  }
  if (target.includes('/api/ai/status')) {
    return json({
      provider: 'mimo', provider_name: 'Mify（MiMo）', base_url: 'https://api.llm.mioffice.cn/v1',
      model: 'mimo-v2.6-flash', has_key: true, own_key: false, key_masked: 'sk-••••••••••••AJ2g',
      credential_error: '', json_mode: true, providers: [], minutes_auto: 'final', minutes_interval: 120,
      notes_language: '简体中文', minutes_language: '简体中文', auto_end_silence: 'prompt',
      auto_end_after: 600, languages: ['简体中文']
    })
  }
  if (target.includes('/api/models/catalog')) {
    return json({ models: ['xiaomi/mimo-v2.5-asr', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'deepseek-v3.1'],
      count: 4, has_key: true, error: '' })
  }
  return json({ detail: `未模拟：${target}` })
}

function Frame() {
  return (
    <div className="mc-settings-shell" style={{ padding: '22px 24px', maxWidth: 860, margin: '0 auto' }}>
      <header className="mc-settings-hero"><h2 className="mc-settings-title">会摘设置</h2></header>
      <nav className="mc-settings-tabs" role="tablist">
        <button type="button" role="tab" className="mc-settings-tab" aria-selected="true">模型</button>
        <button type="button" role="tab" className="mc-settings-tab" aria-selected="false">采集</button>
      </nav>
      <SettingsModels t={t} />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Frame />)

// 截图前自动点两下「测试连接」，让结果行出现在图里。
if (!light) {
  const clickProbes = () => {
    const buttons = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === '测试连接')
    buttons.forEach((b) => b.click())
  }
  setTimeout(clickProbes, 600)
  setTimeout(clickProbes, 1400)
}
