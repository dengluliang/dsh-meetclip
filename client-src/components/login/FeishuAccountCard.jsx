import { openExternal } from '../../lib/api.js'
import { feishuSummary, useFeishu } from '../../lib/feishu.js'
import { FeishuJobPanel } from '../feishu/FeishuParts.jsx'
import { FeishuDocProbe } from './FeishuDocProbe.jsx'

const TONES = { ok: 'ok', warn: 'warn', error: 'error', pending: 'idle' }

export function FeishuAccountCard({ compact = false }) {
  const { status, error, busy, actions } = useFeishu()
  const summary = feishuSummary(status)
  const runtime = status?.runtime || {}
  const dsh = status?.dsh || {}
  const auth = status?.auth || {}
  const installed = Boolean(dsh.entryPresent)
  const loggedIn = Boolean(auth.loggedIn)
  const job = status?.job || null
  const running = job?.state === 'running'
  const pkg = status?.package || {}
  const runtimeReady = runtime.ready === undefined ? Boolean(runtime.npxOk && runtime.nodeOk) : Boolean(runtime.ready)
  const canInstall = Boolean(status) && runtimeReady && !dsh.conflict && pkg.configured
  const disabled = Boolean(busy) || running
  const expiry = auth.refreshExpiresAt
    ? new Date(auth.refreshExpiresAt * 1000).toLocaleDateString('zh-CN')
    : ''
  const lastRead = status?.lastDocReadAt
    ? new Date(status.lastDocReadAt).toLocaleString('zh-CN', { hour12: false })
    : ''

  const primary = !status ? null
    : !installed
      ? { label: running && job?.action === 'install' ? '安装中…' : '安装并连接', run: actions.install, disabled: disabled || !canInstall, variant: 'primary' }
      : !loggedIn || auth.accessExpired
        ? { label: busy === 'login' ? '等待授权…' : auth.accessExpired ? '刷新飞书登录' : '登录飞书', run: () => actions.login('auto'), disabled, variant: 'primary' }
        : { label: running && job?.action === 'probe' ? '检测中…' : '检测连接', run: actions.probe, disabled }

  return (
    <div className={`mc-login-card mc-feishu-login${compact ? ' is-compact' : ''}`}>
      <div className="mc-login-head">
        <strong>飞书</strong>
        <span className="mc-login-state" data-ok={summary.tone === 'ok' ? 'true' : 'false'}>{summary.text}</span>
      </div>
      <p className="mc-login-hint">
        登录后 Agent 能读写飞书文档、多维表格、云盘与 Wiki；首页「＋ → 飞书文档」也能读取正文。
      </p>
      {summary.detail ? <p className="mc-form-note" data-tone={summary.tone}>{summary.detail}</p> : null}
      {loggedIn ? (
        <p className="mc-form-note">
          {expiry ? `登录有效期至 ${expiry}` : '已登录'}
          {lastRead ? ` · 上次成功读文档：${lastRead}` : ' · 还没有验证过读文档'}
        </p>
      ) : null}
      {!runtimeReady ? (
        <div className="mc-form-note" data-tone="error">
          {runtime.mode === 'npx'
            ? '飞书 MCP 需要 Node.js 20+。装好后点「重新检测」。'
            : '找不到可用的 node 运行时（DSH 自带运行时异常）。点「重新检测」再试。'}
          <div className="mc-actions">
            {runtime.mode === 'npx' ? (
              <button type="button" className="mc-button mc-button-small" onClick={() => openExternal('url', 'https://nodejs.org/zh-cn').catch(() => {})}>安装 Node.js</button>
            ) : null}
            <button type="button" className="mc-button mc-button-small" onClick={actions.status}>重新检测</button>
          </div>
        </div>
      ) : null}
      <div className="mc-actions">
        {primary ? (
          <button type="button" className="mc-button" data-variant={primary.variant} disabled={primary.disabled} onClick={primary.run}>
            {primary.label}
          </button>
        ) : null}
        {installed ? (
          <button type="button" className="mc-button" disabled={disabled} onClick={() => actions.login('device')}>
            用设备码登录
          </button>
        ) : null}
        {installed ? (
          <button type="button" className="mc-button" disabled={disabled} onClick={actions.probe}>检测连接</button>
        ) : null}
        {loggedIn ? (
          <button type="button" className="mc-button" disabled={disabled} onClick={actions.logout}>退出登录</button>
        ) : null}
      </div>
      <FeishuJobPanel job={job} actions={actions} />
      {loggedIn && summary.tone !== 'pending' ? (
        <FeishuDocProbe compact onLogin={() => actions.login('auto')} />
      ) : null}
      {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
    </div>
  )
}
