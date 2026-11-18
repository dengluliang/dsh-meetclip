import { boardImageUrl, fileUrl } from '../../lib/api.js'
import { composition, memberTone, packTone, stripMembers, updatedLabel } from './pack-cover-model.js'

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

// 底片格里的一格：会话卡用真实封面，其它类型用类型色块 + 细节纹理，保证「看得出装了什么」。
function Thumb({ member, entry }) {
  const type = member?.type || 'card'
  const image = type === 'image'
    ? boardImageUrl(member.id)
    : type === 'session' ? coverSources(entry?.item)[0] : null
  const glyph = type === 'session' ? cleanText(entry?.item?.title || member?.title, 1) : ''
  return (
    <span className="mc-pack-thumb" data-type={type} data-tone={memberTone(member)}>
      {image ? <img src={image} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" /> : null}
      {!image && glyph ? <b>{glyph}</b> : null}
    </span>
  )
}

function CoverFace({ item, members, memberEntries }) {
  const title = cleanText(item?.title, 90) || '未命名卡包'
  const count = Number(item?.count) || members.length
  const active = Number(item?.active_count) > 0
    || members.some((member) => member.active)
  const tone = packTone(members)
  const comp = composition(members)
  const updated = updatedLabel(item?.updated_at)
  const { shown, rest } = stripMembers(members, count)
  return (
    <div className="mc-pack-cover" data-tone={tone}>
      <div className="mc-pack-cover-top">
        {!/^卡包/.test(title) ? <span className="mc-pack-cover-chip">卡包</span> : null}
        {active ? <i className="mc-pack-cover-dot" aria-label="包含进行中的卡片" /> : null}
        <span className="mc-pack-cover-count">{count} 张</span>
      </div>
      <h3 className="mc-pack-cover-title">{title}</h3>
      {comp ? <p className="mc-pack-cover-comp">{comp}</p> : null}
      {updated ? <p className="mc-pack-cover-updated">{updated}</p> : null}
      <div className="mc-pack-strip" aria-hidden="true">
        {shown.map((member) => (
          <Thumb
            key={`${member.type}-${member.id}`}
            member={member}
            entry={memberEntries?.get?.(`${member.type}-${member.id}`)}
          />
        ))}
        {rest ? <span className="mc-pack-strip-more">+{rest}</span> : null}
      </div>
    </div>
  )
}

function BackFace({ entry, member, slot }) {
  const item = entry?.item || {}
  const type = member?.type || 'card'
  const cover = type === 'session' ? coverSources(item)[0] : null
  const backgroundImage = cover ? `linear-gradient(180deg, rgba(0,0,0,.02), rgba(0,0,0,.12)), url("${cover}")` : undefined
  return (
    <span
      className="mc-pack-back"
      data-type={type}
      data-kind={member?.kind || type}
      data-slot={slot}
      style={{ ...(backgroundImage ? { backgroundImage } : {}), zIndex: 3 - slot }}
      aria-hidden="true"
    />
  )
}

export function PackCard({ item, memberEntries = null, onOpen, onMenu }) {
  const members = Array.isArray(item?.members) ? item.members : []
  const count = Number(item?.count) || members.length
  const active = Number(item?.active_count) > 0 || members.some((member) => member.active)
  const empty = count === 0
  const title = cleanText(item?.title, 90) || '未命名卡包'
  const backs = empty ? [] : members.slice(0, 2)
  return (
    <article
      className={`mc-pack-card${empty ? ' is-empty' : ''}${active ? ' is-active' : ''}`}
      data-pack-id={item?.id}
      role="button"
      tabIndex={0}
      aria-label={`卡包：${title}，${count} 张卡片`}
      onClick={() => onOpen?.(item)}
      onContextMenu={(event) => onMenu?.(event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen?.(item)
        }
      }}>
      {empty ? (
        <div className="mc-pack-empty-face">
          <span>卡包</span>
          <strong>{title}</strong>
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
          <CoverFace item={item} members={members} memberEntries={memberEntries} />
        </>
      )}
    </article>
  )
}
