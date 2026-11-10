import {
  formatDate,
  progressDetail,
  progressPercent,
  rollbackCandidates,
  updateSummary,
  useUpdate
} from '../lib/update.js'

function versionText(value) {
  return value ? `v${String(value).replace(/^v/i, '')}` : '—'
}

function dotTone(tone) {
  return tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'error' ? 'error' : 'idle'
}

export function SettingsAbout({ t }) {
  const { status, error, busy, notice, actions } = useUpdate()
  const tr = (key, fallback) => {
    const value = typeof t === 'function' ? t(key) : ''
    return value && value !== key ? value : fallback
  }

  const job = status?.job || null
  const latest = status?.latest || null
  const summary = updateSummary(status)
  const running = Boolean(job && ['checking', 'downloading', 'verifying', 'installing'].includes(job.state))
  const percent = progressPercent(job)
  const isSource = status?.target?.kind === 'source'
  const canCancel = running && (job.state === 'checking' || job.state === 'downloading')
  const restartRequired = Boolean(status?.restartRequired)
  const updateAvailable = Boolean(status?.updateAvailable && latest)
  const primaryLabel = running
    ? (job.phase || tr('about.working', '更新中…'))
    : updateAvailable && !isSource
      ? tr('about.install', '立即更新')
      : tr('about.check', '检查更新')
  const primaryDisabled = !status || Boolean(busy) || running
  const showProgress = Boolean(job && (running || job.state === 'error' || job.state === 'cancelled' || job.percent === 100))
  const repo = status?.repo || 'dengluliang/dsh-meetclip'

  const backups = rollbackCandidates(status)
  const [rollbackChoice, setRollbackChoice] = React.useState('')
  const [pendingRollback, setPendingRollback] = React.useState('')
  const selectedBackup = backups.find((row) => row.version === rollbackChoice) || backups[0] || null
  // 备份可能在别处被清理或已被换掉；这时确认条自动收起，避免对着过期版本操作。
  const pendingBackup = backups.find((row) => row.version === pendingRollback) || null
  const rollbackVerb = selectedBackup?.direction === 'newer'
    ? tr('about.rollbackRestoreTo', '切换回')
    : tr('about.rollbackTo', '回退到')
  const rollbackLabel = selectedBackup
    ? `${rollbackVerb} ${versionText(selectedBackup.version)}`
    : tr('about.rollbackDisabled', '回退到升级前版本')
  const rollbackDisabled = !status || !selectedBackup || running || Boolean(busy)
    || isSource || status?.target?.writable === false || Boolean(pendingRollback)

  function chooseRollback(version) {
    setPendingRollback('')
    setRollbackChoice(version)
  }

  async function confirmRollback() {
    const version = pendingRollback
    setPendingRollback('')
    await actions.rollback(version)
  }

  return (
    <div className="mc-settings-panel">
      <div className="mc-card mc-about-card">
        <div className="mc-about-head">
          <div>
            <h3 className="mc-card-title">{tr('about.title', '关于会摘')}</h3>
            <p className="mc-foot-meta">
              {tr('about.subtitle', '本地直播、视频与会议资料库，配套 DSH 工具与 AI 纪要。')}
            </p>
          </div>
          <div className="mc-about-version" aria-label={tr('about.currentVersion', '当前版本')}>
            {versionText(status?.currentVersion)}
          </div>
        </div>

        <div className="mc-rows">
          <div className="mc-row">
            <span className="mc-row-key">{tr('about.currentVersion', '当前运行版本')}</span>
            <span className="mc-row-value mc-mono">{versionText(status?.currentVersion)}</span>
          </div>
          <div className="mc-row">
            <span className="mc-row-key">{tr('about.installedVersion', '已安装版本')}</span>
            <span className="mc-row-value mc-mono" data-tone={restartRequired ? 'warn' : undefined}>
              {versionText(status?.installedVersion)}
              {restartRequired ? ` · ${tr('about.restartHintShort', '重启后生效')}` : ''}
            </span>
          </div>
          <div className="mc-row">
            <span className="mc-row-key">{tr('about.latestVersion', '最新版本')}</span>
            <span className="mc-row-value mc-mono" data-tone={updateAvailable ? 'warn' : undefined}>
              {latest ? versionText(latest.version) : tr('about.notChecked', '未检查')}
              {latest?.publishedAt ? <em className="mc-about-meta">{formatDate(Date.parse(latest.publishedAt))}</em> : null}
            </span>
          </div>
          <div className="mc-row">
            <span className="mc-row-key">{tr('about.rollbackRow', '可回退版本')}</span>
            <span className="mc-row-value">
              {backups.length ? (
                <select
                  className="mc-input mc-select mc-about-rollback-select"
                  value={selectedBackup.version}
                  disabled={running || Boolean(busy)}
                  aria-label={tr('about.rollbackRow', '可回退版本')}
                  onChange={(event) => chooseRollback(event.target.value)}
                >
                  {backups.map((row) => (
                    <option key={row.version} value={row.version}>
                      {`${versionText(row.version)}${row.at ? ` · ${formatDate(row.at)}` : ''}`}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="mc-foot-meta">
                  {isSource
                    ? tr('about.rollbackSource', '源码运行时没有升级备份，请用 git 切换版本')
                    : tr('about.rollbackNone', '没有升级前的本地备份；只有应用内升级会自动保留升级前的版本')}
                </span>
              )}
            </span>
          </div>
          <div className="mc-row">
            <span className="mc-row-key">{tr('about.repo', '发布仓库')}</span>
            <span className="mc-row-value">
              <button type="button" className="mc-link-button" onClick={actions.openRepo}
                title={`https://github.com/${repo}`}>
                github.com/{repo}
              </button>
            </span>
          </div>
          <div className="mc-row">
            <span className="mc-row-key">{tr('about.lastCheck', '上次检查')}</span>
            <span className="mc-row-value">{formatDate(status?.lastCheckAt) || tr('about.never', '还没有检查过')}</span>
          </div>
          <div className="mc-row">
            <span className="mc-row-key">{tr('about.installPath', '安装位置')}</span>
            <span className="mc-row-value mc-mono mc-about-path" title={status?.target?.path || ''}>
              {status?.target?.path || '—'}
            </span>
          </div>
        </div>

        <div className="mc-update-summary" data-tone={summary.tone}>
          <span className="mc-dot" data-state={dotTone(summary.tone)} />
          <strong>{summary.text}</strong>
          {summary.detail ? <span className="mc-foot-meta">{summary.detail}</span> : null}
        </div>

        <div className="mc-actions">
          <button
            type="button"
            className="mc-button"
            data-variant="primary"
            disabled={primaryDisabled}
            onClick={updateAvailable && !isSource ? actions.install : actions.check}
          >
            {primaryLabel}
          </button>
          {canCancel ? (
            <button type="button" className="mc-button" onClick={actions.cancel}>
              {tr('about.cancel', '取消')}
            </button>
          ) : null}
          <button
            type="button"
            className="mc-button"
            data-action="rollback"
            disabled={rollbackDisabled}
            title={selectedBackup?.at ? formatDate(selectedBackup.at) : undefined}
            onClick={() => setPendingRollback(selectedBackup.version)}
          >
            {rollbackLabel}
          </button>
          <button type="button" className="mc-button" disabled={Boolean(busy) || running}
            onClick={actions.refresh}>
            {tr('about.refresh', '刷新状态')}
          </button>
          {latest?.url ? (
            <button type="button" className="mc-button" onClick={actions.openRelease}>
              {tr('about.releaseNotes', '发布说明')}
            </button>
          ) : null}
        </div>

        {pendingBackup ? (
          <div className="mc-rollback-confirm">
            <p className="mc-about-warning" data-tone="warn">
              {tr('about.rollbackConfirm', '将把安装目录换回升级前保存在本地的')}{' '}
              <strong className="mc-mono">{versionText(pendingBackup.version)}</strong>
              {tr('about.rollbackConfirmDetail', '；当前版本也会另存为本地备份，重启 DeepSeek Harness 后生效。资料库、笔记和转写不受影响。')}
            </p>
            <div className="mc-actions">
              <button type="button" className="mc-button" data-variant="danger"
                disabled={Boolean(busy) || running} onClick={confirmRollback}>
                {tr('about.rollbackConfirmAction', '确认回退')}
              </button>
              <button type="button" className="mc-button" disabled={Boolean(busy) || running}
                onClick={() => setPendingRollback('')}>
                {tr('about.cancel', '取消')}
              </button>
            </div>
          </div>
        ) : null}

        {backups.length ? (
          <p className="mc-foot-meta">
            {tr('about.rollbackHint', '回退只在本地把安装目录换回升级前保存的副本，不联网、不从 GitHub 下载；资料库、笔记和转写都不动。')}
          </p>
        ) : null}

        {isSource ? (
          <p className="mc-about-warning" data-tone="warn">
            {tr('about.sourceHint', '当前从源码目录运行，自动更新已停用；请用 git pull 更新后重启。')}
          </p>
        ) : null}
        {restartRequired ? (
          <p className="mc-about-warning" data-tone="warn">
            {status?.restartDirection === 'rollback'
              ? tr('about.restartAfterRollback', '回退后的文件已就位，重启 DeepSeek Harness 后生效。')
              : tr('about.restart', '新版本文件已就位，重启 DeepSeek Harness 后生效。')}
          </p>
        ) : null}
        {notice ? <p className="mc-foot-meta" role="status">{notice}</p> : null}
        {error ? <p className="mc-error-text" role="alert">{error}</p> : null}

        <p className="mc-foot-meta">
          {tr('about.privacy', '检查更新只访问 GitHub，不上传资料库、笔记或转写。自动更新会替换 DSH 里已安装的插件副本，重启 DSH 后生效。')}
        </p>
      </div>

      {showProgress ? (
        <div className="mc-card mc-update-card">
          <div className="mc-update-head">
            {running ? <span className="mc-setup-spinner" /> : null}
            <strong>{job.phase || tr('about.working', '更新中…')}</strong>
            <span className="mc-update-percent">
              {percent === null ? '' : `${percent.toFixed(1)}%`}
            </span>
          </div>
          <div className="mc-progress mc-update-bar" role="progressbar"
            aria-valuemin="0" aria-valuemax="100"
            aria-valuenow={percent === null ? undefined : Math.round(percent)}>
            <span
              className={running && percent === null ? 'is-indeterminate' : undefined}
              style={running && percent === null ? undefined : { width: `${percent ?? 0}%` }}
            />
          </div>
          {(() => {
            const detail = job.state === 'done' && restartRequired ? '' : progressDetail(job)
            return detail ? <p className="mc-foot-meta">{detail}</p> : null
          })()}
          {job.state === 'error' ? <p className="mc-error-text" role="alert">{job.error}</p> : null}
        </div>
      ) : null}

      {latest?.notes ? (
        <div className="mc-card mc-update-notes-card">
          <h3 className="mc-card-title">{tr('about.notesTitle', `v${latest.version} 更新内容`)}</h3>
          <pre className="mc-update-notes">{latest.notes}</pre>
        </div>
      ) : null}
    </div>
  )
}
