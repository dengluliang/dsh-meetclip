import { boardImageUrl, fileUrl } from '../../lib/api.js'
import { clock, dateTime, kindInfo, statusText } from '../../lib/format.js'

function cleanText(value, limit = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function coverToUrl(item, cover) {
  if (!cover?.value) return null
  return cover.type === 'remote' ? cover.value : fileUrl(item.id, cover.value)
}

function coverSources(item) {
  if (!item) return []
  return [...new Set([
    coverToUrl(item, item.cover),
    coverToUrl(item, item.cover?.fallback)
  ].filter(Boolean))]
}

function memberLabel(member) {
  if (!member) return ''
  if (member.type === 'session') return kindInfo(member.kind).label
  if (member.type === 'batch') return '批次'
  if (member.type === 'highlight') return '标记'
  if (member.type === 'note') return member.kind === 'todo' ? '待办' : '便利签'
  if (member.type === 'image') return '图片'
  if (member.type === 'doc') return '文档'
  return '卡片'
}

function todoLines(text) {
  return String(text || '').split('\n')
    .map((line) => line.match(/^\s*-\s+(.*)$/))
    .filter(Boolean)
    .map((match) => match[1].replace(/^\[[ xX]\]\s*/, '').trim())
    .filter(Boolean)
}

function SessionFace({ entry, member, t }) {
  const item = entry?.item || member
  const info = kindInfo(member.kind)
  const sources = coverSources(entry?.item)
  const [sourceIndex, setSourceIndex] = React.useState(0)
  const source = sources[sourceIndex]
  return (
    <div className={`mc-home-card mc-pack-front-card${source ? '' : ' is-text'}`} data-kind={info.tone}>
      {source ? (
        <div className="mc-home-cover" data-kind={info.tone}>
          <img src={source} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer"
            onError={() => {
              if (sourceIndex + 1 < sources.length) setSourceIndex(sourceIndex + 1)
              else setSourceIndex(sources.length)
            }} />
        </div>
      ) : null}
      <div className="mc-home-card-body">
        <div className="mc-home-card-top">
          <span className={`mc-home-type-inline mc-home-tone-${info.tone}`}>{info.label}</span>
          <span className="mc-home-status" data-status={member.status}>
            <i />{statusText(member.status, t)}
          </span>
        </div>
        <h3 className="mc-home-card-title">{cleanText(item.title, 90) || '未命名记录'}</h3>
        {item.snippet ? <p className="mc-home-card-snippet">{cleanText(item.snippet, 100)}</p> : null}
        <div className="mc-home-card-foot">
          <span>{item.platform && item.platform !== 'bilibili' ? item.platform : info.label}</span>
          <span>{dateTime(member.created_at)}{member.duration ? ` · ${clock(member.duration)}` : ''}</span>
        </div>
      </div>
    </div>
  )
}

function NoteFace({ entry, member }) {
  const item = entry?.item || {}
  const text = item.text || member.title || ''
  const todos = member.kind === 'todo' ? todoLines(text) : []
  const body = text.split('\n').filter((line) => !/^\s*-\s+/.test(line)).join('\n').trim()
  return (
    <div className="mc-sticky-card mc-pack-front-card" data-kind={member.kind || 'note'}>
      <div className="mc-sticky-head"><span>{member.kind === 'todo' ? '待办清单' : '便利签'}</span></div>
      {body ? <p className="mc-sticky-text">{cleanText(body, 140)}</p> : null}
      {todos.length ? (
        <div className="mc-pack-todo-preview">
          {todos.slice(0, 4).map((textLine, index) => (
            <span key={`${index}-${textLine}`} data-done={Boolean(item.checked?.[index])}>
              <i />{cleanText(textLine, 60)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function HighlightFace({ entry, member }) {
  const item = entry?.item || member
  return (
    <div className="mc-home-card mc-home-quote mc-pack-front-card">
      <div className="mc-home-quote-mark">“</div>
      <blockquote>{cleanText(item.note || member.title, 120)}</blockquote>
      <div className="mc-home-card-foot">
        <span>{cleanText(item.session_title || member.subtitle, 60)}</span>
        <span>{clock(item.ts ?? member.ts ?? 0)}</span>
      </div>
    </div>
  )
}

function DocFace({ entry, member, t }) {
  const item = entry?.item || member
  const label = item.doc_type === 'wiki' ? '飞书知识库' : item.doc_type === 'sheet' ? '飞书表格'
    : item.doc_type === 'base' ? '飞书多维表格' : '飞书文档'
  return (
    <div className="mc-doc-wall-card mc-pack-front-card">
      <span className="mc-doc-wall-top"><span>{label}</span><span>{dateTime(item.updated_at || member.created_at)}</span></span>
      <strong className="mc-doc-wall-title">{cleanText(item.title || member.title, 90) || '飞书文档'}</strong>
      <span className="mc-doc-wall-foot">
        <span>{item.has_content === false ? '仅链接' : '有正文快照'}</span>
        <span>{t?.('home.docs.open') || '打开'} ↗</span>
      </span>
    </div>
  )
}

function ImageFace({ entry, member }) {
  return (
    <div className="mc-image-card mc-pack-front-card">
      <img src={boardImageUrl(member.id)} alt="" loading="lazy" draggable={false} />
    </div>
  )
}

function BatchFace({ entry, member }) {
  const item = entry?.item || member
  const total = Number(item.total) || Number(member.count) || 0
  const done = Number(item.counts?.done) || 0
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="mc-batch-card mc-pack-front-card">
      <div className="mc-batch-head">
        <span className="mc-batch-tag">批次</span>
        <span className="mc-batch-head-meta">{dateTime(member.created_at)}</span>
      </div>
      <h3 className="mc-batch-title">{cleanText(item.title || member.title, 80) || '批量视频'}</h3>
      <div className="mc-batch-progress" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
      <div className="mc-batch-counts">
        <span>{done}/{total} 完成</span>
        {Number(item.active) ? <span className="is-active">{item.active} 进行中</span> : null}
      </div>
      <div className="mc-batch-foot"><span>查看 {total} 条</span><span>{Number(item.active) ? '处理中' : '已完成'}</span></div>
    </div>
  )
}

function UnknownFace({ member }) {
  return (
    <div className="mc-home-card is-text mc-pack-front-card">
      <div className="mc-home-card-body">
        <div className="mc-home-card-top"><span className="mc-home-type-inline">{memberLabel(member)}</span></div>
        <h3 className="mc-home-card-title">{cleanText(member.title, 90) || '卡片'}</h3>
      </div>
    </div>
  )
}

function FrontFace({ entry, member, t }) {
  if (member.type === 'session') return <SessionFace entry={entry} member={member} t={t} />
  if (member.type === 'note') return <NoteFace entry={entry} member={member} />
  if (member.type === 'highlight') return <HighlightFace entry={entry} member={member} />
  if (member.type === 'doc') return <DocFace entry={entry} member={member} t={t} />
  if (member.type === 'image') return <ImageFace entry={entry} member={member} />
  if (member.type === 'batch') return <BatchFace entry={entry} member={member} />
  return <UnknownFace member={member} />
}

function BackFace({ entry, member, slot }) {
  const item = entry?.item || {}
  const type = member.type
  const cover = type === 'session'
    ? coverSources(item)[0]
    : type === 'image' ? boardImageUrl(member.id)
      : type === 'doc' ? null : null
  const backgroundImage = cover ? `linear-gradient(180deg, rgba(0,0,0,.02), rgba(0,0,0,.12)), url("${cover}")` : undefined
  return (
    <span
      className="mc-pack-back"
      data-type={type}
      data-kind={member.kind || type}
      data-slot={slot}
      style={{ ...(backgroundImage ? { backgroundImage } : {}), zIndex: 3 - slot }}
      aria-hidden="true"
    />
  )
}

export function PackCard({ item, memberEntries = null, t, onOpen, onMenu }) {
  const members = Array.isArray(item?.members) ? item.members : []
  const count = Number(item?.count) || members.length
  const active = Number(item?.active_count) || members.filter((member) => member.active).length
  const empty = count === 0
  const frontMember = members[0] || null
  const frontEntry = frontMember ? memberEntries?.get?.(`${frontMember.type}-${frontMember.id}`) : null
  const backs = members.slice(1, 3)
  return (
    <article
      className={`mc-pack-card${empty ? ' is-empty' : ''}${active ? ' is-active' : ''}`}
      data-pack-id={item?.id}
      role="button"
      tabIndex={0}
      aria-label={`卡包：${item?.title || '未命名卡包'}，${count} 张卡片`}
      onClick={() => onOpen?.(item)}
      onContextMenu={(event) => onMenu?.(event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen?.(item)
        }
      }}>
      <span className="mc-pack-tab">
        {!/^卡包/.test(item?.title || '') ? <span className="mc-pack-tab-label">卡包</span> : null}
        <strong>{item?.title || '未命名卡包'}</strong>
        <em>{count} 张</em>
        {active ? <i className="mc-pack-tab-active" aria-label="包含进行中的卡片" /> : null}
      </span>

      {empty ? (
        <div className="mc-pack-empty-face">
          <span>卡包</span>
          <strong>{item?.title || '未命名卡包'}</strong>
          <em>把卡片拖到这里</em>
        </div>
      ) : (
        <>
          {backs.map((member, index) => (
            <BackFace
              key={`${member.type}-${member.id}`}
              entry={memberEntries?.get?.(`${member.type}-${member.id}`)}
              member={member}
              slot={index + 1}
            />
          ))}
          <div className="mc-pack-front" aria-hidden="true">
            <FrontFace entry={frontEntry} member={frontMember} t={t} />
          </div>
        </>
      )}
    </article>
  )
}
