// 「设置 → 关于」预览：版本、检查更新按钮和下载进度。
// 用法：node build/build-about-preview.mjs && node build/about-preview-shot.mjs [state] [outfile] [--theme=light]
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import settingsCss from '../client-src/settings-spacing.css'
import updateCss from '../client-src/update.css'
import { SettingsAbout } from '../client-src/components/SettingsAbout.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React
const style = document.createElement('style')
style.textContent = css + settingsCss + updateCss
document.head.append(style)

const theme = new URLSearchParams(location.search).get('theme') === 'light'
if (theme) {
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
    '--dsw-alias-state-warn-primary': '#b7791f',
    '--dsw-alias-state-error-primary': '#d24b45',
    '--mc-line': 'rgba(0,0,0,.12)',
    '--mc-glass': 'rgba(255,255,255,.72)',
    '--mc-shadow': '0 10px 30px -18px rgba(0,0,0,.18)'
  }
  for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value)
  document.body.style.background = tokens['--dsw-alias-bg-base']
  document.body.style.color = tokens['--dsw-alias-label-primary']
}

const state = new URLSearchParams(location.search).get('state') || 'downloading'
const now = Date.now()
const notes = [
  '## 0.9.5 供应商前缀与引导验证',
  '',
  '发布日期：2026-11-10。',
  '',
  '- **修复**：模型名按 `owned_by` 补全供应商前缀，语音与文字共用一套规则。',
  '- **引导**：先验证再保存，选中第一个真正能调通的模型。',
  '- **部署**：meetclip config 新增 `aiBaseUrl`，公共包默认仍为空。',
  '',
  'Release: https://github.com/dengluliang/dsh-meetclip/releases'
].join('\n')

const base = {
  ok: true,
  currentVersion: '0.9.0',
  installedVersion: '0.9.0',
  restartRequired: false,
  repo: 'dengluliang/dsh-meetclip',
  target: {
    path: '/Users/me/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip',
    kind: 'installed',
    writable: true
  },
  latest: {
    version: '0.9.1',
    tag: 'v0.9.1',
    publishedAt: '2026-11-10T04:00:00.000Z',
    url: 'https://github.com/dengluliang/dsh-meetclip/releases/tag/v0.9.1',
    notes,
    asset: {
      name: 'dsh-meetclip-0.9.1.tgz',
      url: 'https://github.com/dengluliang/dsh-meetclip/releases/download/v0.9.1/dsh-meetclip-0.9.1.tgz',
      size: 704007,
      sha256: 'a'.repeat(64)
    }
  },
  updateAvailable: true,
  lastCheckAt: now,
  rollback: {
    available: [{ version: '0.8.11', at: now - 172_800_000, direction: 'older' }],
    canRollback: true
  },
  job: null
}

function snapshot() {
  if (state === 'downloading') {
    return {
      ...base,
      job: {
        state: 'downloading', phase: '下载中', percent: 42.3,
        received: 297795, total: 704007, speed: 839680,
        version: '0.9.1', error: '', message: '', startedAt: now, updatedAt: now, finishedAt: 0
      }
    }
  }
  if (state === 'done') {
    return {
      ...base,
      installedVersion: '0.9.1',
      restartRequired: true,
      updateAvailable: false,
      job: {
        state: 'done', phase: '更新完成', percent: 100,
        received: 704007, total: 704007, speed: 0,
        version: '0.9.1', error: '', message: '已安装 v0.9.1，重启 DeepSeek Harness 后生效',
        startedAt: now, updatedAt: now, finishedAt: now
      }
    }
  }
  if (state === 'uptodate') {
    return {
      ...base,
      latest: { ...base.latest, version: '0.9.0', tag: 'v0.9.0' },
      updateAvailable: false,
      job: {
        state: 'done', phase: '已是最新版本', percent: null,
        received: 0, total: 0, speed: 0, version: '0.9.0', error: '',
        message: '当前 v0.9.0 已经是最新版本', startedAt: now, updatedAt: now, finishedAt: now
      }
    }
  }
  if (state === 'update-ready') {
    // 查到新版本、还没点升级：主按钮应该是「点击升级」。
    return { ...base, job: null }
  }
  if (state === 'rollback') {
    return {
      ...base,
      job: {
        state: 'installing', phase: '回退中', kind: 'rollback', percent: null,
        received: 0, total: 0, speed: 0, version: '0.9.0', error: '',
        message: '把 v0.9.0 的备份换回插件目录…',
        startedAt: now, updatedAt: now, finishedAt: 0
      }
    }
  }
  if (state === 'rollback-done') {
    return {
      ...base,
      installedVersion: '0.9.0',
      restartRequired: true,
      restartDirection: 'rollback',
      updateAvailable: false,
      rollback: {
        available: [{ version: '0.9.1', at: now, direction: 'newer' }],
        canRollback: true
      },
      job: {
        state: 'done', phase: '回退完成', kind: 'rollback', percent: 100,
        received: 0, total: 0, speed: 0, version: '0.9.0', error: '',
        message: '已回退到 v0.9.0，重启 DeepSeek Harness 后生效',
        startedAt: now, updatedAt: now, finishedAt: now
      }
    }
  }
  if (state === 'rollback-none') {
    return {
      ...base,
      rollback: { available: [], canRollback: false }
    }
  }
  if (state === 'rollback-ready' || state === 'rollback-confirm') {
    return {
      ...base,
      installedVersion: '0.9.1',
      restartRequired: true,
      restartDirection: 'update',
      updateAvailable: false,
      rollback: {
        available: [{ version: '0.9.0', at: now - 86_400_000, direction: 'older' }],
        canRollback: true
      }
    }
  }
  if (state === 'error') {
    return {
      ...base,
      job: {
        state: 'error', phase: '更新失败', percent: null,
        received: 0, total: 0, speed: 0, version: '0.9.1',
        error: '连不上 GitHub，请检查网络或代理', message: '连不上 GitHub，请检查网络或代理',
        startedAt: now, updatedAt: now, finishedAt: now
      }
    }
  }
  return { ...base, updateAvailable: false, latest: null, lastCheckAt: 0 }
}

window.fetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(snapshot())
})

const t = translator('zh-CN')

function Frame() {
  return (
    <div className="mc-settings-shell" style={{ padding: '22px 24px', maxWidth: 860, margin: '0 auto' }}>
      <header className="mc-settings-hero"><h2 className="mc-settings-title">会摘设置</h2></header>
      <nav className="mc-settings-tabs" role="tablist">
        {['模型', '资料空间', '采集', '飞书', '关于'].map((label) => (
          <button key={label} type="button" role="tab" className="mc-settings-tab"
            aria-selected={label === '关于'}>{label}</button>
        ))}
      </nav>
      <SettingsAbout t={t} />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Frame />)

if (state === 'rollback-confirm') {
  setTimeout(() => {
    const button = document.querySelector('[data-action="rollback"]')
    if (button) button.click()
  }, 50)
}
