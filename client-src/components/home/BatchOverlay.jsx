import { clock, dateTime, statusText } from '../../lib/format.js'
import { platformLabel } from '../../lib/links.js'
import { VideoForm } from '../NewCaptureDialog.jsx'

export function BatchOverlay({ batch, t, onClose, onOpenRecord, onDeleteAll, onRefresh, initialAppending = false }) {
  const [appending, setAppending] = React.useState(Boolean(initialAppending))

  React.useEffect(() => {
    setAppending(Boolean(initialAppending))
  }, [initialAppending, batch?.id])

  React.useEffect(() => {
    function onKey(event) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      // 正在追加链接时先退出表单，避免把整张批次浮层一起关掉。
      if (appending) setAppending(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, appending])

  if (!batch) return null
  const members = batch.members || []
  const counts = batch.counts || {}
  return (
    <div className="mc-modal-layer" role="dialog" aria-modal="true" aria-label={batch.title || '批次'}>
      <div className="mc-modal mc-batch-modal" data-appending={appending ? 'true' : undefined}>
        <div className="mc-modal-head mc-batch-modal-head">
          <div>
            <h3>{appending ? t('batch.appendTitle') : (batch.title || '批量视频')}</h3>
            <span className="mc-foot-meta">
              {appending
                ? `${batch.title || '批量视频'} · 现有 ${members.length} 条`
                : (
                  <>
                    {members.length} 条 · {dateTime(batch.created_at)}
                    {batch.updated_at && batch.updated_at > Number(batch.created_at || 0) + 60
                      ? ` · 更新 ${dateTime(batch.updated_at)}` : ''}
                    {counts.done ? ` · 完成 ${counts.done}` : ''}
                    {counts.error ? ` · 失败 ${counts.error}` : ''}
                    {counts.cancelled ? ` · 取消 ${counts.cancelled}` : ''}
                  </>
                )}
            </span>
          </div>
          <button type="button" className="mc-icon-button" onClick={onClose} aria-label="关闭批次">×</button>
        </div>

        {appending ? (
          <div className="mc-batch-append">
            <VideoForm t={t} batch={batch}
              onSubmitted={() => onRefresh?.()}
              onCreated={() => setAppending(false)}
              onClose={() => setAppending(false)} />
          </div>
        ) : (
          <>
            <div className="mc-batch-list">
              {members.map((member) => (
                <button key={member.id} type="button" className="mc-batch-member"
                  onClick={() => onOpenRecord?.(member)}>
                  <span className="mc-batch-dot" data-status={member.status} aria-hidden="true" />
                  <span className="mc-batch-member-main">
                    <strong>{member.title || member.source_url || member.id}</strong>
                    <span>
                      {[platformLabel(member.platform), statusText(member.status, t),
                        member.duration ? clock(member.duration) : ''].filter(Boolean).join(' · ')}
                    </span>
                    {member.error ? <em className="mc-batch-member-error">{member.error}</em> : null}
                  </span>
                  <span className="mc-batch-member-open">打开</span>
                </button>
              ))}
              {members.length === 0 ? <p className="mc-foot-meta">这批记录已全部删除。</p> : null}
            </div>
            <div className="mc-modal-actions">
              {onDeleteAll ? (
                <button type="button" className="mc-button" data-variant="danger"
                  onClick={() => onDeleteAll(batch)}>全部删除</button>
              ) : null}
              <button type="button" className="mc-button" data-variant="primary"
                onClick={() => setAppending(true)}>{t('batch.append')}</button>
              <button type="button" className="mc-button" onClick={onClose}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
