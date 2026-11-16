import { saveAppSettings } from '../../lib/api.js'
import { openSettings } from '../../lib/settings-bus.js'
import { BilibiliLoginCard } from './BilibiliLoginCard.jsx'
import { DouyinLoginCard } from './DouyinLoginCard.jsx'

/**
 * 错误提示 + 修复入口。主文案来自后端分类，技术原文默认折叠。
 * 登录/授权成功后先重试一次，避免用户再去找「重新加载」。
 */
export function LoginRequiredNotice({ failure, platform = '', onRetry, onOpenSettings }) {
  const [expanded, setExpanded] = React.useState(false)
  const [busy, setBusy] = React.useState('')
  const [message, setMessage] = React.useState('')
  const action = failure?.action || null
  const actionId = action?.id || ''
  const targetPlatform = action?.platform || platform || ''
  const detail = failure?.detail || failure?.raw || ''

  function retryAfterLogin() {
    setMessage('登录完成，正在重试…')
    onRetry?.()
  }

  async function enableBrowserCookies() {
    setBusy('cookies')
    setMessage('')
    try {
      await saveAppSettings({ link_browser_cookies: true })
      setMessage('已允许读取浏览器登录状态，正在重试…')
      onRetry?.()
    } catch (error) {
      setMessage(error?.message || '开启浏览器登录状态失败，请到设置里手动打开')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="mc-login-notice" data-tone={failure?.status === 'login_required' ? 'warn' : 'error'}>
      <div className="mc-login-notice-main">
        <strong>{failure?.status === 'login_required' ? '需要登录后才能继续' : '这条内容暂时没有读到'}</strong>
        <span>{failure?.message || '请稍后重试'}</span>
      </div>
      {actionId === 'bilibili_login' || targetPlatform === 'bilibili' ? (
        <>
          <div className="mc-actions">
            <button type="button" className="mc-button" data-variant="primary" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起登录' : '扫码登录 B站'}
            </button>
          </div>
          {expanded ? <BilibiliLoginCard compact onLoggedIn={retryAfterLogin} /> : null}
        </>
      ) : null}
      {actionId === 'douyin_login' || targetPlatform === 'douyin' ? (
        <>
          <div className="mc-actions">
            <button type="button" className="mc-button" data-variant="primary" onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起登录' : '登录抖音'}
            </button>
          </div>
          {expanded ? <DouyinLoginCard compact onLoggedIn={retryAfterLogin} /> : null}
        </>
      ) : null}
      {actionId === 'browser_cookies' ? (
        <div className="mc-actions">
          <button type="button" className="mc-button" data-variant="primary" disabled={Boolean(busy)} onClick={enableBrowserCookies}>
            {busy === 'cookies' ? '正在开启…' : '允许读取浏览器登录状态并重试'}
          </button>
        </div>
      ) : null}
      {!actionId ? (
        <div className="mc-actions">
          <button type="button" className="mc-button" onClick={() => (onOpenSettings || openSettings)({ tab: 'account', reason: 'login' })}>
            打开账号设置
          </button>
        </div>
      ) : null}
      <div className="mc-actions">
        <button type="button" className="mc-button mc-button-small" onClick={onRetry} disabled={Boolean(busy)}>
          {actionId ? '登录后重试' : '重试'}
        </button>
      </div>
      {message ? <p className="mc-card-text mc-card-hint" role="status">{message}</p> : null}
      {detail ? (
        <details className="mc-tech-detail">
          <summary>技术详情</summary>
          <p>{detail}</p>
        </details>
      ) : null}
    </div>
  )
}
