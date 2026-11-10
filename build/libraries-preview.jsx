// 资料空间预览：顶部切换器（展开态）+ 设置里的列表与新建表单。
// 用法：node build/build-libraries-preview.mjs && node build/libraries-preview-shot.mjs [--light]
import React from 'react'
import { createRoot } from 'react-dom/client'
import css from '../client-src/styles.css'
import libraryCss from '../client-src/libraries.css'
import settingsSpacingCss from '../client-src/settings-spacing.css'
import { TopBar } from '../client-src/components/shell/TopBar.jsx'
import { LibraryPanel } from '../client-src/components/libraries/LibraryPanel.jsx'
import { translator } from '../client-src/lib/i18n.js'

globalThis.React = React
const style = document.createElement('style')
style.textContent = css + libraryCss + settingsSpacingCss
document.head.append(style)

const light = new URLSearchParams(location.search).get('theme') === 'light'
const t = translator('zh-CN')

// 预览页面没有宿主 token：深色/浅色各给一份近似值，方便看排版与对比度。
const darkTokens = {
  '--dsw-alias-bg-base': '#191919',
  '--dsw-alias-bg-layer-1': '#232323',
  '--dsw-alias-bg-layer-2': '#2a2a2a',
  '--dsw-alias-bg-overlay': '#2a2a2a',
  '--dsw-alias-label-primary': '#f2f2f2',
  '--dsw-alias-label-secondary': '#a8a8ad',
  '--dsw-alias-label-tertiary': '#7d7d84',
  '--dsw-alias-label-primary-inverted': '#191919',
  '--dsw-alias-border-l1': 'rgba(255,255,255,.1)',
  '--dsw-alias-border-l2': 'rgba(255,255,255,.16)',
  '--dsw-alias-button-primary-fill': '#e8e8ea',
  '--dsw-alias-button-primary-hover': '#ffffff',
  '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,.07)',
  '--mc-line': 'rgba(255,255,255,.12)'
}
if (!light) {
  for (const [key, value] of Object.entries(darkTokens)) document.documentElement.style.setProperty(key, value)
}

if (light) {
  const tokens = {
    '--dsw-alias-bg-base': '#f7f6f3',
    '--dsw-alias-bg-layer-1': '#ffffff',
    '--dsw-alias-bg-layer-2': '#ffffff',
    '--dsw-alias-label-primary': '#1d1d1f',
    '--dsw-alias-label-secondary': '#6b6b70',
    '--dsw-alias-label-tertiary': '#929298',
    '--dsw-alias-border-l1': 'rgba(0,0,0,.08)',
    '--dsw-alias-border-l2': 'rgba(0,0,0,.12)',
    '--dsw-alias-border-l4': 'rgba(0,0,0,.18)',
    '--dsw-alias-button-primary-fill': '#1d1d1f',
    '--dsw-alias-button-primary-hover': '#333333',
    '--dsw-alias-label-primary-inverted': '#ffffff',
    '--dsw-alias-interactive-bg-hover': 'rgba(0,0,0,.045)',
    '--mc-line': 'rgba(0,0,0,.12)'
  }
  for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value)
  document.body.style.background = tokens['--dsw-alias-bg-base']
  document.body.style.color = tokens['--dsw-alias-label-primary']
}

const ROWS = [
  {
    id: 'work', name: '工作', active: true, records: 42, exists: true, hasLibrary: true,
    dataDir: '/Users/me/Documents/会摘/工作', lastOpenedAt: 100
  },
  {
    id: 'life', name: '生活', active: false, records: 8, exists: true, hasLibrary: true,
    dataDir: '/Users/me/Documents/会摘/生活', lastOpenedAt: 50
  },
  {
    id: 'old', name: '旧备份', active: false, records: 0, exists: false, hasLibrary: false,
    dataDir: '/Volumes/SSD/会摘-归档'
  }
]

function Label({ children }) {
  return (
    <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', opacity: .55, margin: '18px 0 6px' }}>
      {children}
    </div>
  )
}

// 关键：TopBar 必须是 .mc-root 的直接子元素，才能验证菜单真的盖在页面内容上。
function Preview() {
  return (
    <div>
      <Label>顶部未展开</Label>
      <div className="mc-root" style={{ padding: 20, minHeight: 90 }}>
        <TopBar t={t} view="home" onView={() => {}} libraries={ROWS}
          activeLibrary={ROWS[0]} libraryBusy={false} />
        <div style={{ opacity: .5, marginTop: 10 }}>首页内容…</div>
      </div>

      <Label>打开菜单（盖在页面内容之上）</Label>
      <div className="mc-root" style={{ padding: 20, minHeight: 330 }}>
        <TopBar t={t} view="library" onView={() => {}} libraries={ROWS}
          activeLibrary={ROWS[0]} libraryBusy={false} libraryMenuOpen />
        <div className="mc-lib-hint" role="status">
          <span>当前工作区属于「生活」资料空间，正在显示「工作」的数据。</span>
          <button type="button">切换到「生活」</button>
        </div>
        <div className="mc-card" style={{ marginTop: 10 }}>
          <div className="mc-rows">
            <div className="mc-row">
              <span className="mc-row-key">资料库</span>
              <span className="mc-row-value">当前 42 条记录（这一行用来确认菜单不会被内容盖住）</span>
            </div>
          </div>
        </div>
      </div>

      <Label>设置 → 资料空间</Label>
      <div className="mc-root" style={{ padding: 20 }}>
        <LibraryPanel t={t} rows={ROWS} active={ROWS[0]}
          sharedDir="/Users/me/.dsh/meetclip/shared" dataDir={ROWS[0].dataDir}
          busy={false} showSharing onChanged={() => {}} onSwitch={() => {}} />
      </div>

      <Label>面板里的资料空间弹层</Label>
      <div className="mc-root" style={{ padding: 20 }}>
        <div className="mc-lib-modal" style={{ margin: '0 auto' }}>
          <div className="mc-lib-modal-head">
            <span className="mc-lib-modal-title">资料空间</span>
            <button type="button" className="mc-icon-button">×</button>
          </div>
          <LibraryPanel t={t} rows={ROWS} active={ROWS[0]} dataDir={ROWS[0].dataDir}
            busy={false} variant="dialog" showSharing={false}
            onChanged={() => {}} onSwitch={() => {}} />
        </div>
      </div>

      <Label>典型卡片：行 → 按钮 → 说明（统一间距）</Label>
      <div className="mc-root" style={{ padding: 20 }}>
        <div className="mc-settings-panel">
          <section className="mc-section">
            <div className="mc-section-title">示例小节</div>
            <div className="mc-card" data-probe="spacing">
              <div className="mc-rows">
                <div className="mc-row"><span className="mc-row-key">当前状态</span><span className="mc-row-value">已启用</span></div>
                <div className="mc-row"><span className="mc-row-key">上次更新</span><span className="mc-row-value">今天 14:02</span></div>
              </div>
              <div className="mc-actions">
                <button type="button" className="mc-button" data-variant="primary">主操作</button>
                <button type="button" className="mc-button">次操作</button>
              </div>
              <p className="mc-foot-meta">这是一段说明文字：按钮与说明之间应当留出一致的间距，不再贴在一起。</p>
            </div>
          </section>
        </div>
      </div>

      <Label>空态 / 宿主未加载（旧插件 + 新页面）</Label>
      <div className="mc-root" style={{ padding: 20 }}>
        <LibraryPanel t={t} rows={[]} active={null} sharedDir="" dataDir="/tmp/data"
          busy={false} showSharing={false} variant="dialog"
          onChanged={() => {}} onSwitch={() => {}} />
        <LibraryPanel t={t} rows={[]} active={null} sharedDir="" dataDir="/tmp/data"
          busy={false} showSharing={false} variant="dialog" loadError={{ status: 404 }}
          onChanged={() => {}} onSwitch={() => {}} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Preview />)

/** 把关键间距写进隐藏节点，方便用无头 Chrome 的 --dump-dom 做数值核对。 */
setTimeout(() => {
  const panel = document.querySelector('.mc-settings-panel')
  const card = document.querySelector('[data-probe="spacing"]')
  const actions = card?.querySelector('.mc-actions')
  const section = document.querySelector('.mc-section')
  const rows = [
    ['panel-gap', panel && getComputedStyle(panel).rowGap],
    ['section-gap', section && getComputedStyle(section).rowGap],
    ['card-gap', card && getComputedStyle(card).rowGap],
    ['actions-gap', actions && getComputedStyle(actions).columnGap],
    ['actions-margin', actions && getComputedStyle(actions).marginTop],
    ['note-margin', card?.querySelector('.mc-foot-meta') && getComputedStyle(card.querySelector('.mc-foot-meta')).marginTop],
    ['note-size', card?.querySelector('.mc-foot-meta') && getComputedStyle(card.querySelector('.mc-foot-meta')).fontSize],
    ['card-padding', card && getComputedStyle(card).padding]
  ]
  const out = document.createElement('div')
  out.id = 'mc-metrics'
  out.style.display = 'none'
  out.textContent = rows.map(([key, value]) => `${key}=${value}`).join(' | ')
  document.body.append(out)
}, 60)
