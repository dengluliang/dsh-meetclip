import { bytes, clock, dateTime, kindInfo } from '../../lib/format.js'
import { jobBytesText, jobPercent, jobProgressText, typeLabel } from '../../lib/backup.js'

/** 进度条：导出/导入共用；完成后停留显示结果，失败给出后端原话。 */
export function JobProgress({ job, onCancel }) {
  if (!job) return null
  const percent = jobPercent(job)
  const running = job.state === 'running'
  const failed = job.state === 'error'
  return (
    <div className="mc-backup-job" data-tone={failed ? 'error' : job.state}>
      <div className="mc-backup-job-head">
        <span>{jobProgressText(job)}</span>
        <span className="mc-backup-job-bytes">{jobBytesText(job)}</span>
      </div>
      <div className="mc-progress mc-backup-bar" role="progressbar"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.round(percent)}>
        <span style={{ width: `${percent === null ? 15 : percent}%` }} />
      </div>
      {job.message && running ? <p className="mc-foot-meta">{job.message}</p> : null}
      {failed ? <p className="mc-error-text" role="alert">{job.error || '备份失败'}</p> : null}
      {running ? (
        <div className="mc-actions">
          <button type="button" className="mc-button" onClick={onCancel}>取消</button>
        </div>
      ) : null}
    </div>
  )
}

/** 一个可折叠分组：组头本身是「按类型全选」的三态勾选框。 */
export function GroupSection({
  label, count, open, onToggleOpen, checked, partial, onGroupChange, children
}) {
  const ref = React.useRef(null)
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(partial) && !checked
  }, [partial, checked])
  return (
    <section className="mc-backup-group">
      <header className="mc-backup-group-head">
        <label className="mc-backup-check">
          <input ref={ref} type="checkbox" checked={Boolean(checked)} onChange={(event) => onGroupChange?.(event.target.checked)} />
          <span>{label}</span>
        </label>
        <span className="mc-backup-count">{count}</span>
        <button type="button" className="mc-backup-link" onClick={onToggleOpen}>{open ? '收起' : '展开'}</button>
      </header>
      {open ? <div className="mc-backup-rows">{children}</div> : null}
    </section>
  )
}

export function CardRow({ checked, title, meta, badge, active, onChange, indent = false }) {
  return (
    <label className="mc-backup-row" data-active={active ? 'true' : undefined} data-indent={indent ? 'true' : undefined}>
      <input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange?.(event.target.checked)} />
      <span className="mc-backup-row-main">
        <span className="mc-backup-row-title">{title}</span>
        {meta ? <span className="mc-backup-row-meta">{meta}</span> : null}
      </span>
      {badge ? <span className="mc-backup-badge">{badge}</span> : null}
    </label>
  )
}

export function recordMeta(row) {
  const bits = [kindInfo(row.kind).label]
  const stamp = Number(row.created_at) || 0
  if (row.active) bits.push('进行中')
  if (stamp) bits.push(dateTime(stamp))
  if (row.transcripts) bits.push(`${row.transcripts} 行转写`)
  if (row.marks) bits.push(`${row.marks} 条标记`)
  if (row.has_minutes) bits.push('有纪要')
  if (row.has_notes) bits.push('有笔记')
  if (row.media_bytes) bits.push(`媒体 ${bytes(row.media_bytes)}`)
  return bits.join(' · ')
}

export function highlightMeta(row) {
  const bits = []
  if (row.session_title) bits.push(row.session_title)
  if (Number(row.ts) >= 0) bits.push(clock(row.ts))
  const stamp = Number(row.created_at) || 0
  if (stamp) bits.push(dateTime(stamp))
  return bits.join(' · ')
}

const DOC_TYPE_LABELS = {
  docx: '飞书文档', wiki: '飞书知识库', sheet: '飞书表格', base: '飞书多维表格', docs: '飞书文档',
  wechat: '公众号文章', web: '网页'
}

export function docMeta(row) {
  return [typeLabel('doc'), DOC_TYPE_LABELS[row.doc_type] || row.doc_type || '', row.has_content ? '有正文快照' : '仅链接']
    .filter(Boolean).join(' · ')
}

export function noteMeta(row) {
  return [row.kind === 'todo' ? '待办清单' : '便利签', Number(row.created_at) ? dateTime(row.created_at) : '']
    .filter(Boolean).join(' · ')
}

export function imageMeta(row) {
  const size = row.width && row.height ? `${row.width}×${row.height}` : ''
  return [size, Number(row.created_at) ? dateTime(row.created_at) : ''].filter(Boolean).join(' · ')
}

export function packMeta(row) {
  return [`${Number(row.count) || 0} 张卡片`, Number(row.created_at) ? dateTime(row.created_at) : '']
    .filter(Boolean).join(' · ')
}

export function batchMeta(row) {
  return [`${Number(row.count) || 0} 条视频`, Number(row.created_at) ? dateTime(row.created_at) : '']
    .filter(Boolean).join(' · ')
}

export function packMembers(row) {
  return (row.members || []).map((member) => member.title || member.id).filter(Boolean)
}
