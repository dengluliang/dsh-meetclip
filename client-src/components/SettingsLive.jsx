import {
  aiStatus, bilibiliQrPoll, bilibiliQrStart, bilibiliRefresh, bilibiliStatus,
  bilibiliLogout, saveAIConfig, saveAppSettings, appSettings
} from '../lib/api.js'
import { QrCode } from './QrCode.jsx'

export function SettingsLive({ t }) {
  const [bili, setBili] = React.useState(null)
  const [settings, setSettings] = React.useState(null)
  const [ai, setAi] = React.useState(null)
  const [qr, setQr] = React.useState(null)
  const [qrState, setQrState] = React.useState(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [sensitivity, setSensitivity] = React.useState(0.5)
  const [savingSensitivity, setSavingSensitivity] = React.useState(false)
  const timerRef = React.useRef(null)

  const load = React.useCallback(async () => {
    try {
      const [status, prefs, aiState] = await Promise.all([bilibiliStatus(), appSettings(), aiStatus()])
      setBili(status)
      setSettings(prefs)
      setAi(aiState)
      setSensitivity(Number(prefs.shot_sensitivity ?? 0.5))
      setError('')
    } catch (failure) {
      setError(failure?.message || String(failure))
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  React.useEffect(() => {
    if (!qr?.key) return undefined
    const poll = setInterval(async () => {
      try {
        const result = await bilibiliQrPoll(qr.key)
        setQrState(result)
        if (result.state === 'ok') {
          clearInterval(poll)
          setQr(null)
          await load()
        }
        if (result.state === 'expired' || result.state === 'error') clearInterval(poll)
      } catch (failure) {
        setQrState({ state: 'error', message: failure?.message || String(failure) })
        clearInterval(poll)
      }
    }, 2000)
    return () => clearInterval(poll)
  }, [qr?.key, load])

  async function refreshChrome() {
    setBusy('refresh')
    setError('')
    try {
      const result = await bilibiliRefresh()
      setBili(result)
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy('')
    }
  }

  async function logout() {
    setBusy('logout')
    try { setBili(await bilibiliLogout()) } catch (failure) { setError(failure?.message || String(failure)) }
    finally { setBusy('') }
  }

  async function startQr() {
    setBusy('qr')
    setError('')
    setQrState(null)
    try {
      const result = await bilibiliQrStart()
      setQr(result)
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy('')
    }
  }

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
      <div className="mc-card">
        <div className="mc-rows">
          <Row label="B 站账号" value={bili?.logged_in ? (bili.uname || '已登录') : '未登录'} />
        </div>
        <div className="mc-actions">
          <button type="button" className="mc-button" onClick={startQr} disabled={Boolean(busy)}>扫码登录</button>
          <button type="button" className="mc-button" onClick={refreshChrome} disabled={Boolean(busy)}>
            {busy === 'refresh' ? '读取中…' : '读取 Chrome 登录'}
          </button>
          {bili?.logged_in ? <button type="button" className="mc-button" onClick={logout} disabled={Boolean(busy)}>退出</button> : null}
        </div>
        {qr ? (
          <div className="mc-qr-wrap">
            <QrCode value={qr.url} size={168} />
            <div className="mc-qr-info">
              <strong>请用 B站 App 扫码</strong>
              <span>{qrState?.message || '等待扫码…'}</span>
              <button type="button" className="mc-button mc-button-small" onClick={startQr}>刷新二维码</button>
            </div>
          </div>
        ) : null}
        {qrState?.state === 'expired' ? <p className="mc-warn">{qrState.message}</p> : null}
      </div>

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

function Row({ label, value }) {
  return (
    <div className="mc-row">
      <span className="mc-row-key">{label}</span>
      <span className="mc-row-value">{value}</span>
    </div>
  )
}
