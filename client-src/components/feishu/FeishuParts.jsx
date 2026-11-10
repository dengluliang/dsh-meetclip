import { formatDate } from '../../lib/feishu.js'

/** Status rows shared by the first-run step and the settings tab. */
export function FeishuStatusRows({ status, compact = false }) {
  const runtime = status?.runtime || {}
  const dsh = status?.dsh || {}
  const auth = status?.auth || {}

  let runtimeText = '读取中…'
  let runtimeTone = ''
  if (status) {
    if (!runtime.npx) {
      runtimeText = '没有找到 npx：先装 Node.js 20+（或 nvm）'
      runtimeTone = 'error'
    } else if (!runtime.node) {
      runtimeText = '没有找到 node：先装 Node.js 20+（或 nvm）'
      runtimeTone = 'error'
    } else if (!runtime.nodeOk) {
      runtimeText = `Node ${runtime.nodeVersion || '?'}，飞书 MCP 需要 20 以上`
      runtimeTone = 'error'
    } else {
      runtimeText = `Node ${runtime.nodeVersion} · npx ${runtime.npx}`
    }
  }

  let configText = '读取中…'
  let configTone = ''
  if (status) {
    if (dsh.conflict) {
      configText = `与已有条目冲突：${dsh.conflict} 已占用 serverName「${dsh.serverName}」`
      configTone = 'error'
    } else if (!dsh.entryPresent) {
      configText = '未写入'
    } else if (dsh.entryLive === true) {
      configText = '已写入并在 DeepSeek Harness 中生效'
    } else if (dsh.entryLive === false) {
      configText = '已写入，正在等待 DSH 载入'
    } else {
      configText = '已写入（重启 DeepSeek Harness 后生效）'
    }
  }

  let authText = '读取中…'
  let authTone = ''
  if (status) {
    if (auth.loggedIn) {
      authText = `已登录${auth.openId ? ` ${auth.openId}` : ''}${auth.refreshExpiresAt ? ` · 有效期至 ${formatDate(auth.refreshExpiresAt)}` : ''}`
    } else if (auth.expired) {
      authText = '登录已过期，需要重新登录'
      authTone = 'warn'
    } else {
      authText = '未登录'
      authTone = 'warn'
    }
  }

  return (
    <div className="mc-rows">
      <div className="mc-row">
        <span className="mc-row-key">运行条件</span>
        <span className="mc-row-value" data-tone={runtimeTone || undefined}>{runtimeText}</span>
      </div>
      <div className="mc-row">
        <span className="mc-row-key">DSH 配置</span>
        <span className="mc-row-value" data-tone={configTone || undefined}>
          {configText}
          {!compact && status ? (
            <em className="mc-mono mc-feishu-path" title={dsh.patchPath}>
              {`${dsh.patchScope === 'profile' ? 'profile 补丁' : 'home 补丁'}：${dsh.patchPath}`}
            </em>
          ) : null}
        </span>
      </div>
      <div className="mc-row">
        <span className="mc-row-key">飞书账号</span>
        <span className="mc-row-value" data-tone={authTone || undefined}>{authText}</span>
      </div>
      {status?.pinnedVersion ? (
        <div className="mc-row">
          <span className="mc-row-key">入口版本</span>
          <span className="mc-row-value mc-mono">@{status.pinnedVersion}（固定，可在需要时更新到最新）</span>
        </div>
      ) : null}
    </div>
  )
}

/** Live log, step and authorization link for a running (or failed) host job. */
export function FeishuJobPanel({ job, actions, describe = true }) {
  if (!job) return null
  const running = job.state === 'running'
  const failed = job.state === 'error' || job.state === 'cancelled'
  if (!running && !failed && !job.url) return null
  const tail = String(job.log || '').split('\n').filter(Boolean).slice(-14).join('\n')
  return (
    <div className="mc-job">
      <div className="mc-job-head">
        {running ? <span className="mc-setup-spinner" /> : null}
        <strong>{job.step || (running ? '进行中…' : '已结束')}</strong>
      </div>
      {describe && running && job.action === 'login' ? (
        <p className="mc-foot-meta">
          浏览器没弹出时，复制下面的链接到浏览器打开，完成授权后这里会自动刷新。
        </p>
      ) : null}
      {job.url && running ? (
        <div className="mc-feishu-auth">
          <button type="button" className="mc-button mc-button-small" onClick={() => actions.openUrl(job.url)}>
            打开授权页
          </button>
          <span className="mc-mono" title={job.url}>{job.url}</span>
        </div>
      ) : null}
      {tail ? <pre className="mc-log">{tail}</pre> : null}
      {running ? (
        <div className="mc-actions">
          <button type="button" className="mc-button" onClick={actions.cancel}>取消</button>
        </div>
      ) : null}
      {failed && job.error ? <p className="mc-error-text" role="alert">{job.error}</p> : null}
    </div>
  )
}

/** Login / logout controls; the caller decides which actions matter. */
export function FeishuLoginActions({ status, actions, busy, running }) {
  const auth = status?.auth || {}
  const disabled = Boolean(busy) || running
  return (
    <div className="mc-actions">
      <button type="button" className="mc-button" data-variant={auth.loggedIn ? undefined : 'primary'}
        disabled={disabled} onClick={() => actions.login('auto')}>
        {busy === 'login' ? '等待授权…' : auth.loggedIn ? '重新登录' : '登录飞书'}
      </button>
      <button type="button" className="mc-button" disabled={disabled} onClick={() => actions.login('device')}>
        用设备码登录
      </button>
      {auth.loggedIn ? (
        <button type="button" className="mc-button" disabled={disabled} onClick={actions.logout}>
          {busy === 'logout' ? '退出中…' : '退出登录'}
        </button>
      ) : null}
    </div>
  )
}
