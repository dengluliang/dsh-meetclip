import { feishuSummary, useFeishu } from '../lib/feishu.js'
import { FeishuJobPanel } from './feishu/FeishuParts.jsx'

const DOT_TONES = { ok: 'ok', warn: 'warn', error: 'error', pending: 'idle' }

function dayLabel(seconds) {
  const value = Number(seconds)
  if (!value) return ''
  const date = new Date(value * 1000)
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/**
 * One card, two states: the answer to "can I use Feishu right now?" plus the
 * action that fixes it. Everything else lives behind 更多.
 */
export function SettingsFeishu() {
  const { status, error, busy, notice, actions } = useFeishu()
  const [more, setMore] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState(false)

  const job = status?.job || null
  const running = job?.state === 'running'
  const summary = feishuSummary(status)
  const runtime = status?.runtime || {}
  const dsh = status?.dsh || {}
  const auth = status?.auth || {}
  const installed = Boolean(dsh.entryPresent)
  const signedIn = Boolean(auth.loggedIn)
  const disabled = Boolean(busy) || running
  const canInstall = Boolean(status) && runtime.npxOk && !dsh.conflict

  let primary = null
  if (status && !installed) {
    primary = {
      label: running && job?.action === 'install' ? '安装中…' : '安装并连接',
      disabled: disabled || !canInstall,
      run: actions.install
    }
  } else if (status && !signedIn) {
    primary = {
      label: busy === 'login' ? '等待授权…' : auth.expired ? '重新登录' : '登录飞书',
      disabled,
      run: () => actions.login('auto')
    }
  }

  function toggleMore() {
    setMore((open) => !open)
    setConfirmRemove(false)
  }

  const account = signedIn
    ? [auth.openId, auth.refreshExpiresAt ? `${dayLabel(auth.refreshExpiresAt)} 到期` : ''].filter(Boolean).join(' · ')
    : ''

  return (
    <div className="mc-settings-panel">
      <div className="mc-card mc-feishu-card">
        <div className="mc-feishu-head">
          <span className="mc-dot" data-state={DOT_TONES[summary.tone]} />
          <span className="mc-feishu-state" data-tone={summary.tone}>{summary.text}</span>
          {account ? <span className="mc-feishu-meta" title={account}>{account}</span> : null}
          <div className="mc-feishu-tools">
            {primary ? (
              <button type="button" className="mc-button" data-variant="primary"
                disabled={primary.disabled} onClick={primary.run}>{primary.label}</button>
            ) : signedIn && summary.tone === 'ok' ? (
              <button type="button" className="mc-button" disabled={disabled}
                onClick={() => actions.login('auto')}>{busy === 'login' ? '等待授权…' : '重新登录'}</button>
            ) : null}
            <button type="button" className="mc-button" aria-expanded={more}
              onClick={toggleMore}>{more ? '收起' : '更多'}</button>
          </div>
        </div>

        {status && !installed && canInstall ? (
          <p className="mc-feishu-note">安装后 Agent 就能读写飞书文档、多维表格、云盘与 Wiki。</p>
        ) : null}
        {summary.detail ? <p className="mc-feishu-note" data-tone={summary.tone}>{summary.detail}</p> : null}
        {notice ? <p className="mc-feishu-note" role="status">{notice}</p> : null}
        {error ? <p className="mc-error-text" role="alert">{error}</p> : null}

        <FeishuJobPanel job={job} actions={actions} />

        {more ? (
          <div className="mc-feishu-more">
            <div className="mc-actions">
              <button type="button" className="mc-button" disabled={disabled || !installed} onClick={actions.update}>
                {running && job?.action === 'update' ? '更新中…' : '检查更新'}
              </button>
              <button type="button" className="mc-button" disabled={disabled || !installed} onClick={actions.probe}>
                {running && job?.action === 'probe' ? '检测中…' : '检测连接'}
              </button>
              {installed ? (
                <button type="button" className="mc-button" disabled={disabled || !canInstall} onClick={actions.install}>
                  {running && job?.action === 'install' ? '安装中…' : '重新安装'}
                </button>
              ) : null}
              <button type="button" className="mc-button" disabled={disabled} onClick={() => actions.login('device')}>
                用设备码登录
              </button>
              {signedIn ? (
                <button type="button" className="mc-button" disabled={disabled} onClick={actions.logout}>
                  {busy === 'logout' ? '退出中…' : '退出登录'}
                </button>
              ) : null}
              <button type="button" className="mc-button" onClick={actions.openDoc}>官方文档</button>
            </div>

            <div className="mc-feishu-remove">
              <span>移除后 Agent 将不能访问飞书，登录状态保留。</span>
              {confirmRemove ? (
                <div className="mc-actions">
                  <button type="button" className="mc-button" data-variant="danger" disabled={disabled}
                    onClick={() => { setConfirmRemove(false); actions.removeConfig() }}>
                    确认移除
                  </button>
                  <button type="button" className="mc-button" onClick={() => setConfirmRemove(false)}>取消</button>
                </div>
              ) : (
                <button type="button" className="mc-button" disabled={disabled || !installed}
                  onClick={() => setConfirmRemove(true)}>移除 DSH 配置</button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
