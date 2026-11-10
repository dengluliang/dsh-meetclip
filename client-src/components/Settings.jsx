import { SettingsAbout } from './SettingsAbout.jsx'
import { SettingsCapture } from './SettingsCapture.jsx'
import { SettingsFeishu } from './SettingsFeishu.jsx'
import { SettingsLibraries } from './SettingsLibraries.jsx'
import { SettingsLive } from './SettingsLive.jsx'
import { SettingsModels } from './SettingsModels.jsx'
import { SettingsVideo } from './SettingsVideo.jsx'

const TABS = [
  ['models', 'settings.tab.models', '模型'],
  ['libraries', 'settings.tab.libraries', '资料空间'],
  ['capture', 'settings.tab.capture', '采集'],
  ['feishu', 'settings.tab.feishu', '飞书'],
  ['about', 'settings.tab.about', '关于']
]

const VALID = new Set(TABS.map(([id]) => id))

export function Settings({ t }) {
  const [tab, setTab] = React.useState(() => {
    const saved = localStorage.getItem('meetclip.settingsTab')
    return VALID.has(saved) ? saved : 'models'
  })

  function selectTab(next) {
    setTab(next)
    localStorage.setItem('meetclip.settingsTab', next)
  }

  function label(key, fallback) {
    const value = typeof t === 'function' ? t(key) : ''
    return value && value !== key ? value : fallback
  }

  return (
    <div className="mc-settings-shell">
      <header className="mc-settings-hero">
        <h2 className="mc-settings-title">会摘设置</h2>
      </header>

      <nav className="mc-settings-tabs" role="tablist" aria-label="会摘设置">
        {TABS.map(([id, key, fallback]) => (
          <button key={id} type="button" role="tab" className="mc-settings-tab"
            aria-selected={tab === id} onClick={() => selectTab(id)}>
            {label(key, fallback)}
          </button>
        ))}
      </nav>

      {tab === 'models' ? <SettingsModels t={t} /> : null}
      {tab === 'libraries' ? <SettingsLibraries t={t} /> : null}
      {tab === 'capture' ? (
        <div className="mc-settings-panel">
          <SettingsCapture t={t} />
          <SettingsLive t={t} />
          <SettingsVideo t={t} />
        </div>
      ) : null}
      {tab === 'feishu' ? <SettingsFeishu /> : null}
      {tab === 'about' ? <SettingsAbout t={t} /> : null}
    </div>
  )
}
