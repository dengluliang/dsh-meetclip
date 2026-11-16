import { bilibiliQrPoll, bilibiliQrStart, bilibiliRefresh, bilibiliStatus } from '../../lib/api.js'
import { QrCode } from '../QrCode.jsx'

function explain(value) {
  const text = String(value || '')
  if (/failed to fetch|econnrefused|http 502|http 503|未启动/i.test(text)) {
    return '本地引擎未就绪：请先在会摘面板右上角「设置 → 采集」启动本地引擎。'
  }
  if (/timed out|timeout|network|连接/i.test(text)) {
    return '连不上 B站登录服务，请检查网络后重试。'
  }
  if (/完全磁盘访问|operation not permitted|permission denied/i.test(text)) {
    return '读不到浏览器登录信息：请给 DeepSeek Harness 完全磁盘访问权限后再试，或改用扫码登录。'
  }
  return text || '登录没有完成，请重试'
}

export function BilibiliLoginCard({ compact = false, onLoggedIn }) {
  const [status, setStatus] = React.useState(null)
  const [qr, setQr] = React.useState(null)
  const [qrState, setQrState] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const timerRef = React.useRef(null)
  const loggedInRef = React.useRef(onLoggedIn)
  loggedInRef.current = onLoggedIn

  const load = React.useCallback(async () => {
    try {
      const next = await bilibiliStatus()
      setStatus(next)
      setError('')
      return next
    } catch (failure) {
      setError(explain(failure?.message || failure))
      return null
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  React.useEffect(() => {
    if (!qr?.key) return undefined
    const timer = setInterval(async () => {
      try {
        const result = await bilibiliQrPoll(qr.key)
        setQrState(result)
        if (result.state === 'ok') {
          clearInterval(timer)
          setQr(null)
          const next = await load()
          if (next?.logged_in) loggedInRef.current?.(next)
        }
        if (result.state === 'expired' || result.state === 'error') clearInterval(timer)
      } catch (failure) {
        setQrState({ state: 'error', message: explain(failure?.message || failure) })
        clearInterval(timer)
      }
    }, 2000)
    timerRef.current = timer
    return () => clearInterval(timer)
  }, [qr?.key, load])

  React.useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current) }, [])

  async function startQr() {
    setBusy('qr')
    setError('')
    setQrState(null)
    try {
      setQr(await bilibiliQrStart())
    } catch (failure) {
      setError(explain(failure?.message || failure))
    } finally {
      setBusy('')
    }
  }

  async function readChrome() {
    setBusy('chrome')
    setError('')
    try {
      const next = await bilibiliRefresh()
      setStatus(next)
      if (next?.logged_in) loggedInRef.current?.(next)
      else setError('Chrome 里没有找到已登录的 B站账号，请改用扫码登录。')
    } catch (failure) {
      setError(explain(failure?.message || failure))
    } finally {
      setBusy('')
    }
  }

  const loggedIn = Boolean(status?.logged_in)
  return (
    <div className={`mc-login-card${compact ? ' is-compact' : ''}`}>
      <div className="mc-login-head">
        <strong>B站账号</strong>
        <span className="mc-login-state" data-ok={loggedIn ? 'true' : 'false'}>
          {status ? (loggedIn ? `已登录${status.uname ? ` · ${status.uname}` : ''}` : '未登录') : '读取中…'}
        </span>
      </div>
      <p className="mc-login-hint">
        登录后可录直播原画，也能下载会员、充电和私享视频。公开视频不登录也能试。
      </p>
      <div className="mc-actions">
        <button type="button" className="mc-button" data-variant={loggedIn ? undefined : 'primary'}
          disabled={Boolean(busy)} onClick={startQr}>
          {busy === 'qr' ? '生成二维码…' : loggedIn ? '重新扫码登录' : '扫码登录 B站'}
        </button>
        <button type="button" className="mc-button" disabled={Boolean(busy)} onClick={readChrome}>
          {busy === 'chrome' ? '读取中…' : 'Chrome 里已登录？读取登录态'}
        </button>
      </div>
      <p className="mc-foot-meta">
        读取 Chrome 登录态可能弹出系统钥匙串授权，需要等十几秒；没有反应就用扫码登录。
      </p>
      {qr ? (
        <div className="mc-qr-wrap">
          <QrCode value={qr.url} size={168} />
          <div className="mc-qr-info">
            <strong>请用 B站 App 扫码</strong>
            <span>{qrState?.message || '等待扫码…'}</span>
            <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={startQr}>刷新二维码</button>
          </div>
        </div>
      ) : null}
      {qrState?.state === 'expired' ? <p className="mc-warn">{qrState.message}</p> : null}
      {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
    </div>
  )
}
