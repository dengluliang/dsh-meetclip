import { appSettings, saveAppSettings } from '../lib/api.js'

const BROWSERS = [
  ['chrome', 'Chrome'],
  ['safari', 'Safari'],
  ['firefox', 'Firefox'],
  ['edge', 'Edge'],
  ['brave', 'Brave'],
  ['chromium', 'Chromium']
]
const HEIGHTS = [0, 720, 1080, 1440, 2160]

export function SettingsVideo({ t }) {
  const [settings, setSettings] = React.useState(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    appSettings().then(setSettings).catch((failure) => setError(failure?.message || String(failure)))
  }, [])

  async function update(patch) {
    setBusy(true)
    setError('')
    try {
      setSettings(await saveAppSettings(patch))
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mc-section">
      <div className="mc-section-title">{t('settings.video') || '视频'}</div>
      <div className="mc-card">
        <p className="mc-card-text">
          这里只控制链接视频的通用画质与「B站/YouTube/X 是否允许读取浏览器登录态」。
          抖音登录已移到「账号」页，按三步完成。
        </p>
        <label className="mc-check">
          <input type="checkbox" checked={Boolean(settings?.link_browser_cookies)} disabled={busy}
            onChange={(event) => update({ link_browser_cookies: event.target.checked })} />
          允许链接视频读取浏览器登录状态
        </label>
        <label className="mc-form-row">
          <span>浏览器</span>
          <select className="mc-input mc-select" value={settings?.link_cookie_browser || 'chrome'} disabled={busy}
            onChange={(event) => update({ link_cookie_browser: event.target.value })}>
            {BROWSERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="mc-form-row">
          <span>最高画质</span>
          <select className="mc-input mc-select" value={settings?.link_max_height ?? 0} disabled={busy}
            onChange={(event) => update({ link_max_height: Number(event.target.value) })}>
            {HEIGHTS.map((value) => <option key={value} value={value}>{value === 0 ? '自动（最高）' : `${value}P`}</option>)}
          </select>
        </label>
        {error ? <p className="mc-error-text">{error}</p> : null}
      </div>
    </section>
  )
}
