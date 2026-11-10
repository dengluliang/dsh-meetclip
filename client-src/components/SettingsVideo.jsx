import {
  appSettings, backendAction, douyinImport, douyinLogout, douyinOpenLogin, douyinOpenPermission,
  douyinStatus, douyinTest, saveAppSettings
} from '../lib/api.js'

const BROWSERS = ['chrome', 'safari', 'firefox', 'edge', 'brave', 'chromium']
const HEIGHTS = [0, 720, 1080, 1440, 2160]

function douyinError(failure) {
  const text = failure?.message || String(failure || '')
  if (/not found|http 404/i.test(text)) {
    return '本地引擎还是旧版本，没有抖音接口：请到 设置 → 采集 重启本地引擎后再试。'
  }
  if (/failed to fetch|econnrefused|http 502|http 503|未启动/i.test(text)) {
    return '本地引擎未就绪：请先在 设置 → 采集 启动本地引擎。'
  }
  if (/could not find|operation not permitted|permission denied|not authorized|完全磁盘访问/i.test(text)) {
    return '读不到浏览器 Cookie 数据库：macOS 没有给 DeepSeek Harness 完全磁盘访问权限。请到 系统设置 → 隐私与安全性 → 完全磁盘访问权限 勾选 DeepSeek Harness，重启引擎后再试。'
  }
  return text
}

export function SettingsVideo({ t }) {
  const [settings, setSettings] = React.useState(null)
  const [douyin, setDouyin] = React.useState(null)
  const [douyinBusy, setDouyinBusy] = React.useState('')
  const [douyinMessage, setDouyinMessage] = React.useState('')
  const [douyinTone, setDouyinTone] = React.useState('info')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    appSettings().then(setSettings).catch((failure) => setError(failure?.message || String(failure)))
    douyinStatus().then((value) => { setDouyin(value); setDouyinTone('info'); setDouyinMessage('') }).catch((failure) => {
      setDouyin(null)
      setDouyinMessage(douyinError(failure))
      setDouyinTone('error')
    })
  }, [])

  async function refreshDouyin() {
    try {
      setDouyin(await douyinStatus())
      setDouyinTone('info')
      setDouyinMessage('')
    } catch (failure) {
      setDouyinTone('error')
      setDouyinMessage(douyinError(failure))
    }
  }

  async function openDouyinLogin() {
    setDouyinBusy('open')
    setDouyinMessage('')
    try {
      const result = await douyinOpenLogin()
      setDouyinTone('info')
      setDouyinMessage(`已用 ${result?.browser || '默认浏览器'} 打开抖音；扫码登录后回来点「读取 Cookie」`)
    } catch (failure) {
      setDouyinTone('error')
      setDouyinMessage(douyinError(failure))
    } finally {
      setDouyinBusy('')
    }
  }

  async function importDouyinCookies() {
    setDouyinBusy('import')
    setDouyinMessage('')
    try {
      const result = await douyinImport(settings?.link_cookie_browser || 'chrome')
      await refreshDouyin()
      setDouyinTone('info')
      setDouyinMessage(`已导入 ${result?.count || 0} 条抖音 Cookie`)
    } catch (failure) {
      setDouyinTone('error')
      setDouyinMessage(douyinError(failure))
    } finally {
      setDouyinBusy('')
    }
  }

  async function testDouyin() {
    setDouyinBusy('test')
    setDouyinMessage('')
    try {
      const result = await douyinTest(douyin?.last_url || '')
      setDouyinTone(result?.ok ? 'info' : 'error')
      setDouyinMessage(result?.ok
        ? `测试通过：${result.title || result.url || '抖音链接'}`
        : `测试失败：${result?.message || '未知原因'}`)
    } catch (failure) {
      setDouyinTone('error')
      setDouyinMessage(douyinError(failure))
    } finally {
      setDouyinBusy('')
    }
  }

  async function clearDouyin() {
    setDouyinBusy('clear')
    setDouyinMessage('')
    try {
      await douyinLogout()
      await refreshDouyin()
      setDouyinTone('info')
      setDouyinMessage('已清除抖音 Cookie')
    } catch (failure) {
      setDouyinTone('error')
      setDouyinMessage(douyinError(failure))
    } finally {
      setDouyinBusy('')
    }
  }

  const douyinNeedsRestart = /旧版本|未就绪|完全磁盘访问|重启引擎/.test(douyinMessage)
  const douyinNeedsPermission = /完全磁盘访问|权限/.test(douyinMessage)

  async function openPermissionSettings() {
    setDouyinBusy('permission')
    try {
      await douyinOpenPermission()
      setDouyinTone('info')
      setDouyinMessage('已打开系统设置：勾选 DeepSeek Harness 的完全磁盘访问权限，然后点「重启引擎」再读取。')
    } catch (failure) {
      setDouyinTone('error')
      setDouyinMessage(douyinError(failure))
    } finally {
      setDouyinBusy('')
    }
  }

  async function restartBackend() {
    if (typeof window !== 'undefined' && !window.confirm('重启会中断正在进行的采集/转写，确定继续？')) return
    setDouyinBusy('restart')
    setDouyinMessage('正在重启本地引擎…')
    setDouyinTone('info')
    try {
      await backendAction('restart')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await refreshDouyin()
      setDouyinTone('info')
      setDouyinMessage('本地引擎已重启，可以扫码登录抖音了')
    } catch (failure) {
      setDouyinTone('error')
      setDouyinMessage(douyinError(failure))
    } finally {
      setDouyinBusy('')
    }
  }

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
        <label className="mc-check">
          <input type="checkbox" checked={Boolean(settings?.link_browser_cookies)} disabled={busy}
            onChange={(event) => update({ link_browser_cookies: event.target.checked })} />
          允许读取浏览器 Cookie
        </label>
        <label className="mc-form-row">
          <span>浏览器</span>
          <select className="mc-input mc-select" value={settings?.link_cookie_browser || 'chrome'} disabled={busy}
            onChange={(event) => update({ link_cookie_browser: event.target.value })}>
            {BROWSERS.map((value) => <option key={value} value={value}>{value}</option>)}
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
        <div className="mc-card-divider" />
        <div className="mc-rows">
          <div className="mc-row">
            <span className="mc-row-key">抖音账号</span>
            <span className="mc-row-value">
              {douyin?.saved ? `已导入 ${douyin.count || 0} 条 Cookie` : '未导入 Cookie'}
            </span>
          </div>
        </div>
        <div className="mc-actions">
          <button type="button" className="mc-button" onClick={openDouyinLogin}
            disabled={Boolean(douyinBusy)}>扫码登录</button>
          <button type="button" className="mc-button" onClick={importDouyinCookies}
            disabled={Boolean(douyinBusy)}>{douyinBusy === 'import' ? '读取中…' : '读取 Cookie'}</button>
          <button type="button" className="mc-button" onClick={testDouyin}
            disabled={Boolean(douyinBusy) || !douyin?.last_url}>{douyinBusy === 'test' ? '测试中…' : '测试连接'}</button>
          {douyinNeedsPermission ? (
            <button type="button" className="mc-button" onClick={openPermissionSettings}
              disabled={Boolean(douyinBusy)}>打开权限设置</button>
          ) : null}
          {douyinNeedsRestart ? (
            <button type="button" className="mc-button" onClick={restartBackend}
              disabled={Boolean(douyinBusy)} title="重启会中断正在进行的采集/转写">
              {douyinBusy === 'restart' ? '重启中…' : '重启引擎'}
            </button>
          ) : null}
          {douyin?.saved ? (
            <button type="button" className="mc-button" onClick={clearDouyin}
              disabled={Boolean(douyinBusy)}>清除</button>
          ) : null}
        </div>
        <p className="mc-card-text mc-card-hint">
          在打开的浏览器里用抖音 App 扫码登录，再点「读取 Cookie」；只保存 douyin.com 域。
        </p>
        {douyinMessage ? (
          <p className={douyinTone === 'error' ? 'mc-error-text mc-card-hint' : 'mc-card-text mc-card-hint'} role="status">
            {douyinMessage}
          </p>
        ) : null}
      </div>
    </section>
  )
}
