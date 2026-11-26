import { aiStatus, saveAIConfig, saveAppSettings, appSettings } from '../lib/api.js'

export function SettingsLive({ t }) {
  const [settings, setSettings] = React.useState(null)
  const [ai, setAi] = React.useState(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [sensitivity, setSensitivity] = React.useState(0.5)
  const [savingSensitivity, setSavingSensitivity] = React.useState(false)
  const timerRef = React.useRef(null)

  const load = React.useCallback(async () => {
    try {
      const [prefs, aiState] = await Promise.all([appSettings(), aiStatus()])
      setSettings(prefs)
      setAi(aiState)
      setSensitivity(Number(prefs.shot_sensitivity ?? 0.5))
      setError('')
    } catch (failure) {
      setError(failure?.message || String(failure))
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  function changeSensitivity(value) {
    setSensitivity(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      setSavingSensitivity(true)
      try {
        const next = await saveAppSettings({ shot_sensitivity: value })
        setSettings(next)
      } catch (failure) {
        setError(failure?.message || String(failure))
      } finally {
        setSavingSensitivity(false)
      }
    }, 450)
  }

  async function patchLive(body) {
    setBusy('live')
    setError('')
    try {
      setSettings(await saveAppSettings(body))
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy('')
    }
  }

  async function patchAutoEnd(body) {
    setBusy('auto-end')
    setError('')
    try {
      setAi(await saveAIConfig(body))
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy('')
    }
  }

  const silenceMode = ai?.auto_end_silence || 'prompt'
  const silenceMinutes = Math.round((Number(ai?.auto_end_after) || 600) / 60)

  return (
    <section className="mc-section">
      <div className="mc-section-title">{t('settings.live') || '发布会直播'}</div>
      <p className="mc-card-text">
        B站账号已移到「账号」页；这里只放直播画面的截图与自动结束设置。
      </p>

      <div className="mc-card">
        <div className="mc-form-row">
          <span>截图灵敏度</span>
          <div className="mc-slider-row">
            <input type="range" min="0" max="1" step="0.01" value={sensitivity}
              onChange={(event) => changeSensitivity(Number(event.target.value))} aria-label="截图灵敏度" />
            <span className="mc-mono">{sensitivity.toFixed(2)}</span>
            {savingSensitivity ? <span className="mc-foot-meta">保存中…</span> : null}
          </div>
        </div>
      </div>

      <div className="mc-card">
        <div className="mc-form-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={settings?.live_reconnect !== false}
              disabled={Boolean(busy)}
              onChange={(event) => patchLive({ live_reconnect: event.target.checked })} />
            <span>断流自动续录</span>
          </label>
          {busy === 'live' ? <span className="mc-foot-meta">保存中…</span> : null}
        </div>
        <p className="mc-card-text">
          B站取流地址约 60 分钟过期，CDN 也可能中途断开。开启后：到期前主动换地址、卡住 45 秒或掉线时自动重连，
          所有分段最后拼成同一条记录，不需要手动停止再重录。录制中也可以在详情页点「立即重连」。
          关掉则恢复旧行为（断流就结束这一条）。
        </p>
      </div>

      <div className="mc-card">
        <div className="mc-form-row">
          <span>没人说话</span>
          <select className="mc-input mc-select" value={silenceMode} disabled={Boolean(busy)}
            onChange={(event) => patchAutoEnd({ auto_end_silence: event.target.value })}>
            <option value="off">不自动结束</option>
            <option value="prompt">先问一句</option>
            <option value="end">直接结束</option>
          </select>
        </div>
        {silenceMode !== 'off' ? (
          <div className="mc-form-row mc-form-row-short">
            <span>静音分钟</span>
            <input className="mc-input" type="number" min="1" max="120" defaultValue={silenceMinutes}
              onBlur={(event) => patchAutoEnd({ auto_end_after: (Number(event.target.value) || 10) * 60 })} />
          </div>
        ) : null}
      </div>
      {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
    </section>
  )
}
