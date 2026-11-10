import { dateTime } from '../../lib/format.js'
import { platformLabel } from '../../lib/links.js'

function platformCounts(batch) {
  const counts = {}
  for (const member of batch.members || []) {
    const platform = member.platform || 'link'
    counts[platform] = (counts[platform] || 0) + 1
  }
  return Object.entries(counts)
}

export function BatchCard({ item, focused = false, onOpen, onMenu, onDelete }) {
  const counts = item.counts || {}
  const total = Number(item.total) || (item.members || []).length
  const done = Number(counts.done) || 0
  const failed = Number(counts.error) || 0
  const active = Number(item.active) || 0
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const platforms = platformCounts(item)
  return (
    <article
      className={`mc-batch-card${focused ? ' is-focused' : ''}`}
      data-batch-id={item.id}
      role="button"
      tabIndex={0}
      aria-label={`批次：${item.title}，完成 ${done}/${total}`}
      onClick={() => onOpen?.(item)}
      onContextMenu={(event) => onMenu?.(event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen?.(item)
        }
      }}>
      <div className="mc-batch-head">
        <span className="mc-batch-tag">批次</span>
        <span className="mc-batch-head-meta">
          {dateTime(item.created_at)}
          {onDelete ? (
            <button type="button" className="mc-batch-delete" title="全部删除" aria-label="全部删除"
              onClick={(event) => { event.stopPropagation(); onDelete(item) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
              }}>×</button>
          ) : null}
        </span>
      </div>
      <h3 className="mc-batch-title">{item.title || '批量视频'}</h3>
      <div className="mc-batch-progress" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
        {failed && total > 0 ? <i style={{ width: `${Math.min(100 - percent, Math.round((failed / total) * 100))}%` }} /> : null}
      </div>
      <div className="mc-batch-counts">
        <span>{done}/{total} 完成</span>
        {active ? <span className="is-active">{active} 进行中</span> : null}
        {failed ? <span className="is-error">{failed} 失败</span> : null}
      </div>
      <div className="mc-batch-platforms">
        {platforms.map(([platform, count]) => (
          <span key={platform}>{platformLabel(platform)} {count}</span>
        ))}
      </div>
      <div className="mc-batch-foot">
        <span>查看 {total} 条</span>
        <span>{active ? '处理中' : failed ? '部分失败' : done >= total ? '已完成' : '等待中'}</span>
      </div>
    </article>
  )
}
