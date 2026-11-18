import { bytes, dateTime } from '../../lib/format.js'
import { importCountsText, inspectSummary, skippedText } from '../../lib/backup.js'
import { JobProgress } from './parts.jsx'

export function ImportPanel({
  libraryName, path, onPath, onPick, onInspect, inspecting, inspect, error,
  includeMedia, onIncludeMedia, skipExisting, onSkipExisting, onStart, onReset,
  job, onCancel, onClose, busy
}) {
  const summary = inspectSummary(inspect)
  const running = job?.action === 'import' && job.state === 'running'
  const done = job?.action === 'import' && job.state === 'done'
  const disabled = Boolean(running) || Boolean(busy)
  const source = inspect?.source?.library ? `来自「${inspect.source.library}」` : '别人发来的备份'
  const already = inspect?.already_imported || {}
  const alreadyTotal = Object.values(already).reduce((total, value) => total + (Number(value) || 0), 0)
  const hasMedia = Boolean(inspect?.media_included) && Number(summary.mediaBytes) > 0
  const stale = Boolean(inspect && inspect.path && path && inspect.path !== path)

  return (
    <section className="mc-card mc-backup-card">
      <div className="mc-section-title">导入备份</div>
      <p className="mc-foot-meta">
        把{source}的备份导入到当前资料空间「{libraryName || '当前资料空间'}」。
        导入会分配新的卡片标识，不会覆盖已有内容；备份里没有账号 Cookie、模型 Key 和本机设置。
      </p>

      <div className="mc-backup-path">
        <input className="mc-backup-search" type="text" value={path}
          placeholder="备份文件路径（例如 ~/Downloads/MeetClip备份-20261116-1102.zip）"
          aria-label="备份文件路径" disabled={disabled}
          onChange={(event) => onPath(event.target.value)} />
        <button type="button" className="mc-button" disabled={disabled} onClick={onPick}>选择文件…</button>
        <button type="button" className="mc-button" disabled={disabled || !path.trim() || inspecting}
          onClick={onInspect}>
          {inspecting ? '读取中…' : '读取'}
        </button>
      </div>

      {error ? <p className="mc-error-text" role="alert">{error}</p> : null}

      {inspect ? (
        <div className="mc-backup-inspect">
          <div className="mc-backup-inspect-head">
            <strong>{source}</strong>
            <span className="mc-foot-meta">
              {inspect.created_at ? dateTime(inspect.created_at) : ''}
              {inspect.app_version ? ` · 会摘 v${inspect.app_version}` : ''}
              {` · ${bytes(inspect.archive_bytes)}`}
            </span>
          </div>
          <ul className="mc-backup-inspect-list">
            {summary.rows.map((row) => <li key={row}>{row}</li>)}
            {hasMedia ? <li>视频/音频 {bytes(summary.mediaBytes)}</li> : null}
            {alreadyTotal ? (
              <li className="mc-backup-exists">
                这个备份里已有 {alreadyTotal} 张卡片导入过（默认跳过；需要再存一份时取消勾选下面的选项）
              </li>
            ) : null}
          </ul>
          {inspect.warnings?.length ? (
            <ul className="mc-backup-warnings">
              {inspect.warnings.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          ) : null}
          <label className="mc-backup-option" data-disabled={!hasMedia ? 'true' : undefined}>
            <input type="checkbox" checked={Boolean(includeMedia) && hasMedia} disabled={!hasMedia || disabled}
              onChange={(event) => onIncludeMedia(event.target.checked)} />
            <span>导入视频/音频</span>
            <span className="mc-backup-option-hint">
              {hasMedia ? `多占 ${bytes(summary.mediaBytes)}` : '这个备份不含视频/音频'}
            </span>
          </label>
          <label className="mc-backup-option">
            <input type="checkbox" checked={Boolean(skipExisting)} disabled={disabled}
              onChange={(event) => onSkipExisting(event.target.checked)} />
            <span>跳过已导入的卡片</span>
            <span className="mc-backup-option-hint">同一份备份重复导入时不会出现重复卡片</span>
          </label>
          {stale ? <p className="mc-foot-meta">路径已修改，先点「读取」确认新文件。</p> : null}
          <div className="mc-actions">
            <button type="button" className="mc-button" data-variant="primary"
              disabled={disabled || stale} onClick={onStart}>
              {running ? '正在导入…' : '开始导入'}
            </button>
            <button type="button" className="mc-button" disabled={disabled} onClick={onReset}>取消</button>
          </div>
        </div>
      ) : null}

      {!inspect && !done ? (
        <p className="mc-foot-meta">先选择备份文件；导入前会先读出里面有什么，不会立刻写资料库。</p>
      ) : null}

      {job?.action === 'import' ? <JobProgress job={job} onCancel={onCancel} /> : null}

      {done ? (
        <div className="mc-backup-result">
          <p className="mc-backup-result-line">
            导入完成{job.result?.archive?.source?.library ? `（来自「${job.result.archive.source.library}」）` : ''}：
            {importCountsText(job.result)}
          </p>
          {skippedText(job.result?.skipped) ? (
            <p className="mc-foot-meta">已跳过：{skippedText(job.result.skipped)}</p>
          ) : null}
          {job.result?.warnings?.length ? (
            <ul className="mc-backup-warnings">
              {job.result.warnings.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          ) : null}
          <div className="mc-actions">
            <button type="button" className="mc-button" onClick={onClose}>去首页看看</button>
            <button type="button" className="mc-button" onClick={onReset}>再导入一个</button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
