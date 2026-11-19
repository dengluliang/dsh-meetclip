import { bytes } from '../../lib/format.js'
import { estimateText, isSelected, selectionText } from '../../lib/backup.js'
import {
  CardRow, GroupSection, JobProgress, batchMeta, docMeta, highlightMeta,
  imageMeta, noteMeta, packMeta, packMembers, recordMeta
} from './parts.jsx'

const VISIBLE_ROWS = 50

function matches(row, query) {
  if (!query) return true
  const hay = [
    row.title, row.note, row.text, row.session_title, row.kind, row.doc_type,
    ...(row.members || []).map((member) => member.title)
  ].filter(Boolean).join(' ').toLowerCase()
  return hay.includes(query.toLowerCase())
}

function groupIds(rows, key = 'id') {
  return rows.map((row) => String(row[key]))
}

export function ExportPanel({
  catalog, index, selection, summary, estimate, query, onQuery,
  includeMedia, onIncludeMedia, mediaAvailable, dest, onChangeDest,
  onSelectAll, onClear, onToggle, onGroupChange, onExport, job, onCancel, onReveal
}) {
  const [open, setOpen] = React.useState({ pack: true, session: true, note: false, highlight: false, image: false, doc: false, batch: false })
  const [expanded, setExpanded] = React.useState({})
  const rows = index?.rows || { packs: [], records: [], notes: [], highlights: [], images: [], docs: [], batches: [] }
  const running = job?.action === 'export' && job.state === 'running'
  // 导入在跑时也不能再起导出：后端同一时刻只允许一个备份任务。
  const disabled = Boolean(job?.state === 'running')

  function visible(type, list) {
    const filtered = list.filter((row) => matches(row, query))
    const shown = query || expanded[type] ? filtered : filtered.slice(0, VISIBLE_ROWS)
    return { filtered, shown }
  }

  function group(type, list, label, key, renderRow) {
    const { filtered, shown } = visible(type, list)
    if (!filtered.length) return null
    const ids = groupIds(filtered, key)
    const selected = ids.filter((id) => selection.has(`${type}:${id}`)).length
    return (
      <GroupSection key={type}
        label={label}
        count={`${filtered.length}${selected ? ` · 已选 ${selected}` : ''}`}
        open={Boolean(open[type])}
        onToggleOpen={() => setOpen((current) => ({ ...current, [type]: !current[type] }))}
        checked={ids.length > 0 && selected === ids.length}
        partial={selected > 0 && selected < ids.length}
        onGroupChange={(checked) => onGroupChange(type, ids, checked)}
      >
        {shown.map((row) => renderRow(row))}
        {shown.length < filtered.length ? (
          <button type="button" className="mc-backup-more"
            onClick={() => setExpanded((current) => ({ ...current, [type]: true }))}>
            还有 {filtered.length - shown.length} 条，显示全部
          </button>
        ) : null}
      </GroupSection>
    )
  }

  function packRow(row) {
    const id = String(row.id)
    const checked = isSelected(selection, 'pack', id)
    return (
      <div key={id} className="mc-backup-package">
        <CardRow checked={checked} title={row.title} meta={packMeta(row)}
          badge={`${Number(row.count) || 0} 张`}
          onChange={() => onToggle('pack', id)} />
        {open.packs ? (
          <div className="mc-backup-chips">
            {packMembers(row).slice(0, 12).map((name, index2) => (
              <span key={`${id}-${index2}`} className="mc-backup-chip">{name}</span>
            ))}
            {packMembers(row).length > 12 ? <span className="mc-backup-chip">…</span> : null}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <section className="mc-card mc-backup-card">
      <div className="mc-section-title">导出备份</div>
      <p className="mc-foot-meta">
        把选中的卡片打包成一个备份文件。转写、AI 纪要、笔记、标记和截图都会跟着走；
        视频/音频默认不带（体积很大），需要连媒体一起带走时在下面勾选。
      </p>

      <div className="mc-backup-toolbar">
        <input className="mc-backup-search" type="search" value={query}
          placeholder="按标题搜索卡片" aria-label="搜索卡片"
          onChange={(event) => onQuery(event.target.value)} />
        <button type="button" className="mc-button" onClick={onSelectAll}>全选</button>
        <button type="button" className="mc-button" onClick={onClear}>清空</button>
      </div>
      <p className="mc-backup-summary">
        已选：{selectionText(summary)}
        <span className="mc-backup-estimate">{estimateText(estimate)}</span>
      </p>

      <div className="mc-backup-groups">
        {group('pack', rows.packs, '卡包', 'id', packRow)}
        {group('session', rows.records, '记录', 'id', (row) => (
          <CardRow key={row.id} checked={isSelected(selection, 'session', row.id)}
            title={row.title} meta={recordMeta(row)} active={row.active}
            badge={row.active ? '进行中' : ''}
            onChange={() => onToggle('session', String(row.id))} />
        ))}
        {group('note', rows.notes, '便利签', 'id', (row) => (
          <CardRow key={row.id} checked={isSelected(selection, 'note', row.id)}
            title={row.title} meta={noteMeta(row)}
            onChange={() => onToggle('note', String(row.id))} />
        ))}
        {group('highlight', rows.highlights, '标记', 'id', (row) => (
          <CardRow key={row.id} checked={isSelected(selection, 'highlight', row.id)}
            title={row.note || '标记'} meta={highlightMeta(row)}
            badge="带所属记录"
            onChange={() => onToggle('highlight', String(row.id))} />
        ))}
        {group('image', rows.images, '图片', 'id', (row) => (
          <CardRow key={row.id} checked={isSelected(selection, 'image', row.id)}
            title={row.title} meta={imageMeta(row)}
            onChange={() => onToggle('image', String(row.id))} />
        ))}
        {group('doc', rows.docs, '链接卡片', 'key', (row) => (
          <CardRow key={row.key} checked={isSelected(selection, 'doc', row.key)}
            title={row.title} meta={docMeta(row)}
            onChange={() => onToggle('doc', String(row.key))} />
        ))}
        {group('batch', rows.batches, '批次视频', 'id', (row) => (
          <CardRow key={row.id} checked={isSelected(selection, 'batch', row.id)}
            title={row.title} meta={batchMeta(row)}
            onChange={() => onToggle('batch', String(row.id))} />
        ))}
      </div>

      <label className="mc-backup-option" data-disabled={!mediaAvailable ? 'true' : undefined}>
        <input type="checkbox" checked={Boolean(includeMedia) && mediaAvailable}
          disabled={!mediaAvailable || disabled}
          onChange={(event) => onIncludeMedia(event.target.checked)} />
        <span>包含视频/音频文件</span>
        <span className="mc-backup-option-hint">
          {mediaAvailable
            ? (Number(estimate?.media) ? `+${bytes(estimate.media)}` : '选中项没有媒体')
            : '未选中有媒体的记录'}
        </span>
      </label>

      <div className="mc-backup-dest">
        <span className="mc-backup-dest-label">导出到</span>
        <code className="mc-backup-dest-path" title={dest}>{dest || '（默认：资料库/备份）'}</code>
        <button type="button" className="mc-button" disabled={disabled} onClick={onChangeDest}>更改…</button>
      </div>

      <div className="mc-actions">
        <button type="button" className="mc-button" data-variant="primary"
          disabled={disabled || !summary.selected} onClick={onExport}>
          {running ? '正在导出…' : '导出备份'}
        </button>
        {summary.selected ? (
          <button type="button" className="mc-button" disabled={disabled} onClick={onClear}>取消选择</button>
        ) : null}
      </div>

      {job?.action === 'export' ? <JobProgress job={job} onCancel={onCancel} /> : null}
      {job?.action === 'export' && job.state === 'done' && job.result?.path ? (
        <div className="mc-backup-result">
          <p className="mc-backup-result-line">
            已导出 {bytes(job.result.bytes)} 到 <code>{job.result.path}</code>
          </p>
          <p className="mc-foot-meta">
            含：{selectionText({
              packs: job.result.counts?.packs, records: job.result.counts?.records,
              batches: job.result.counts?.batches, notes: job.result.counts?.notes,
              highlights: job.result.counts?.highlights, images: job.result.counts?.images,
              docs: job.result.counts?.docs
            })}
            {job.result.sha256 ? ` · SHA-256 ${job.result.sha256.slice(0, 16)}…` : ''}
          </p>
          {job.result.warnings?.length ? (
            <ul className="mc-backup-warnings">
              {job.result.warnings.map((item, index2) => <li key={index2}>{item}</li>)}
            </ul>
          ) : null}
          <div className="mc-actions">
            <button type="button" className="mc-button" onClick={() => onReveal(job.result.path)}>在 Finder 中显示</button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
