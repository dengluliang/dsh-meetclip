import {
  appSettings, backendAction, douyinImport, douyinLogout, douyinOpenLogin,
  douyinOpenPermission, douyinStatus, douyinTest, saveAppSettings
} from '../../lib/api.js'

const BROWSERS = [
  ['chrome', 'Chrome'],
  ['safari', 'Safari'],
  ['firefox', 'Firefox'],
  ['edge', 'Edge'],
  ['brave', 'Brave'],
  ['chromium', 'Chromium']
]

function explain(value) {
  const text = String(value || '')
  if (/not found|http 404/i.test(text)) {
    return '本地引擎还是旧版本，没有抖音接口：请重启本地引擎后再试。'
  }
  if (/failed to fetch|econnrefused|http 502|http 503|未启动/i.test(text)) {
    return '本地引擎未就绪：请先到会摘面板右上角「设置 → 采集」启动本地引擎。'
  }
  if (/could not find|operation not permitted|permission denied|not authorized|完全磁盘访问/i.test(text)) {
    return '读不到浏览器 Cookie：macOS 没有给 DeepSeek Harness 完全磁盘访问权限。请点「打开系统设置」授权，重启引擎后再读取。'
  }
  if (/没有抖音 Cookie|确认扫码登录的是当前选择的浏览器/i.test(text)) {
    return '浏览器里没有抖音登录信息：请确认扫码登录的是下面选中的浏览器，再点「读取登录状态」。'
  }
  return text || '抖音登录没有完成，请重试'
}

export function DouyinLoginCard({ compact = false, onLoggedIn }) {
  const [status, setStatus] = React.useState(null)
  const [browser, setBrowser] = React.useState('chrome')
  const [url, setUrl] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [tone, setTone] = React.useState('info')
  const [restartPrompt, setRestartPrompt] = React.useState(false)

  const load = React.useCallback(async () => {
    const [settings, state] = await Promise.all([appSettings(), douyinStatus()])
    setStatus(state)
    setBrowser(settings?.link_cookie_browser || state?.browser || 'chrome')
    setUrl((current) => current || state?.last_url || '')
    return state
  }, [])

  React.useEffect(() => {
    load().catch((failure) => {
      setTone('error')
      setMessage(explain(failure?.message || failure))
    })
  }, [load])

  function patch(next, nextTone = 'info') {
    setMessage(next)
    setTone(nextTone)
  }

  async function chooseBrowser(value) {
    setBrowser(value)
    try {
      await saveAppSettings({ link_cookie_browser: value })
      patch(`已选择 ${BROWSERS.find(([id]) => id === value)?.[1] || value}；扫码登录请用这个浏览器。`)
    } catch (failure) {
      patch(explain(failure?.message || failure), 'error')
    }
  }

  async function openLogin() {
    setBusy('open')
    patch('')
    try {
      const result = await douyinOpenLogin()
      patch(`已用 ${result?.browser || browser} 打开抖音。请在浏览器里用抖音 App 扫码登录，然后回来点「读取登录状态」。`)
      setTone('info')
    } catch (failure) {
      patch(explain(failure?.message || failure), 'error')
    } finally {
      setBusy('')
    }
  }

  async function readCookies() {
    setBusy('read')
    patch('')
    try {
      const result = await douyinImport(browser)
      const next = await load()
      patch(`已读取 ${result?.count || next?.count || 0} 条抖音登录信息，可以继续重试刚才的视频。`)
      setTone('info')
      onLoggedIn?.(next)
    } catch (failure) {
      patch(explain(failure?.message || failure), 'error')
    } finally {
      setBusy('')
    }
  }

  async function test() {
    setBusy('test')
    patch('')
    try {
      const result = await douyinTest(url.trim())
      if (result?.ok) patch(`测试通过：${result.title || result.url || '抖音链接'}`)
      else patch(`测试未通过：${result?.message || '未知原因'}`, 'error')
    } catch (failure) {
      patch(explain(failure?.message || failure), 'error')
    } finally {
      setBusy('')
    }
  }

  async function openPermission() {
    setBusy('permission')
    try {
      await douyinOpenPermission()
      patch('已打开系统设置。勾选 DeepSeek Harness 的完全磁盘访问权限，然后重启本地引擎再读取。')
    } catch (failure) {
      patch(explain(failure?.message || failure), 'error')
    } finally {
      setBusy('')
    }
  }

  async function restart() {
    setBusy('restart')
    setRestartPrompt(false)
    try {
      await backendAction('restart')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await load()
      patch('本地引擎已重启，可以重新读取抖音登录状态了。')
    } catch (failure) {
      patch(explain(failure?.message || failure), 'error')
    } finally {
      setBusy('')
    }
  }

  async function clear() {
    setBusy('clear')
    try {
      await douyinLogout()
      await load()
      patch('已清除抖音登录信息。')
    } catch (failure) {
      patch(explain(failure?.message || failure), 'error')
    } finally {
      setBusy('')
    }
  }

  const needsRestart = /旧版本|未就绪|完全磁盘访问|重启引擎/.test(message)
  const saved = Boolean(status?.saved)
  const when = status?.updated_at ? new Date(status.updated_at * 1000).toLocaleString('zh-CN', { hour12: false }) : ''

  return (
    <div className={`mc-login-card${compact ? ' is-compact' : ''}`}>
      <div className="mc-login-head">
        <strong>抖音账号</strong>
        <span className="mc-login-state" data-ok={saved ? 'true' : 'false'}>
          {saved ? `已读取 ${status.count || 0} 条` : '未登录'}
        </span>
      </div>
      <p className="mc-login-hint">
        抖音视频通常需要登录。按三步来：选浏览器 → 打开抖音扫码 → 读取登录状态。
      </p>
      <div className="mc-douyin-steps">
        <label className="mc-form-row">
          <span>1. 浏览器</span>
          <select className="mc-input mc-select" value={browser} disabled={Boolean(busy)}
            onChange={(event) => chooseBrowser(event.target.value)}>
            {BROWSERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <div className="mc-form-row">
          <span>2. 打开抖音</span>
          <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={openLogin}>
            {busy === 'open' ? '打开中…' : '打开登录页扫码'}
          </button>
        </div>
        <div className="mc-form-row">
          <span>3. 读取登录状态</span>
          <button type="button" className="mc-button mc-button-small" data-variant="primary"
            disabled={Boolean(busy)} onClick={readCookies}>
            {busy === 'read' ? '读取中…' : '读取登录状态'}
          </button>
        </div>
      </div>
      {when ? <p className="mc-foot-meta">上次读取：{when}</p> : null}
      <div className="mc-form-row">
        <span>测试链接</span>
        <div className="mc-model-row">
          <input className="mc-input" value={url} spellCheck={false} placeholder="粘贴一条抖音视频链接（可选）"
            onChange={(event) => setUrl(event.target.value)} />
          <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={test}>
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
        </div>
      </div>
      <div className="mc-actions">
        <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={openPermission}>打开完全磁盘访问设置</button>
        {needsRestart ? (
          <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={() => setRestartPrompt(true)}>
            重启引擎
          </button>
        ) : null}
        {saved ? (
          <button type="button" className="mc-button mc-button-small" disabled={Boolean(busy)} onClick={clear}>清除登录信息</button>
        ) : null}
      </div>
      {restartPrompt ? (
        <div className="mc-inline-confirm">
          <span>重启会中断正在进行的采集/转写，确定继续？</span>
          <button type="button" className="mc-button mc-button-small" onClick={() => setRestartPrompt(false)}>取消</button>
          <button type="button" className="mc-button mc-button-small" data-variant="primary" disabled={Boolean(busy)} onClick={restart}>
            {busy === 'restart' ? '重启中…' : '确认重启'}
          </button>
        </div>
      ) : null}
      {message ? (
        <p className={tone === 'error' ? 'mc-error-text mc-card-hint' : 'mc-card-text mc-card-hint'} role="status">
          {message}
        </p>
      ) : null}
    </div>
  )
}
