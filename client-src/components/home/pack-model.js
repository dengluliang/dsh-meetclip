// 卡包前端纯模型：成员归属、筛选、热区命中、解散铺开。
// 这里不碰 React 和 DOM，便于在 node:test 里直接验证边界。
import { entryKey } from './scatter-layout.js'

export const PACK_TYPE = 'pack'
export const PACK_ARM_DELAY_MS = 160
export const PACK_SIZE = { w: 272, h: 208 }
export const PACK_MAX_MEMBERS = 60
export const PACK_HOT_INSET = 12

const ACTIVE_STATUSES = ['recording', 'processing', 'queued']
const FILTER_KINDS = ['live', 'link_video', 'meeting']

export function packKey(id) {
  return `${PACK_TYPE}-${String(id ?? '')}`
}

export function packMemberKey(member) {
  if (!member) return ''
  return `${member.type || ''}-${member.id ?? ''}`
}

export function packById(packs, id) {
  return (Array.isArray(packs) ? packs : []).find((pack) => String(pack?.id) === String(id)) || null
}

export function packByKey(packs, key) {
  return (Array.isArray(packs) ? packs : []).find((pack) => packKey(pack?.id) === key) || null
}

export function nextPackTitle(packs) {
  const numbers = []
  for (const pack of Array.isArray(packs) ? packs : []) {
    const match = /^卡包\s*(\d+)$/.exec(String(pack?.title || '').trim())
    if (match) numbers.push(Number(match[1]))
  }
  return `卡包 ${numbers.length ? Math.max(...numbers) + 1 : 1}`
}

export function isEntryActive(entry) {
  if (!entry) return false
  if (entry.type === 'session') return ACTIVE_STATUSES.includes(entry.item?.status)
  if (entry.type === 'batch') return Number(entry.item?.active) > 0
  if (entry.type === PACK_TYPE) return Number(entry.item?.active_count) > 0
  return false
}

export function entryMember(entry) {
  if (!entry?.item?.id) return null
  return { type: entry.type, id: String(entry.item.id) }
}

/** 卡包成员从墙面收起，卡包本身成为一个普通 entry。 */
export function applyPacks(entries, packs) {
  const rows = Array.isArray(entries) ? entries : []
  const list = Array.isArray(packs) ? packs : []
  const packed = new Set()
  for (const pack of list) {
    for (const member of pack?.members || []) packed.add(packMemberKey(member))
  }
  const out = rows.filter((entry) => !packed.has(entryKey(entry)))
  const seen = new Set()
  for (const pack of list) {
    if (!pack?.id || seen.has(String(pack.id))) continue
    seen.add(String(pack.id))
    out.push({
      type: PACK_TYPE,
      at: Number(pack.created_at) || 0,
      item: pack
    })
  }
  return out
}

/** 卡包是否响应某个筛选：任一成员匹配就显示整包。 */
export function packMatchesFilter(pack, kind) {
  if (kind === 'all' || !kind) return true
  const members = Array.isArray(pack?.members) ? pack.members : []
  // 空卡包是「等待装卡」的容器，任何筛选下都要能看到，否则建完就消失、也没法拖卡进去。
  if (!members.length) return true
  if (kind === 'active') {
    if (Number(pack?.active_count) > 0) return true
    return members.some((member) => (
      (member.type === 'session' && ACTIVE_STATUSES.includes(member.status))
      || (member.type === 'batch' && Boolean(member.active))
    ))
  }
  if (kind === 'mark') return members.some((member) => ['highlight', 'note', 'image'].includes(member.type))
  if (kind === 'doc') return members.some((member) => member.type === 'doc')
  if (FILTER_KINDS.includes(kind)) {
    return members.some((member) => (
      (member.type === 'session' && member.kind === kind)
      || (member.type === 'batch' && kind === 'link_video')
    ))
  }
  return false
}

/** 目标是否允许成为热区：自身、图钉、进行中、满包、源为卡包都不行。 */
export function isPackTargetEligible({ entry, sourceEntry, pins = {} } = {}) {
  if (!entry || !sourceEntry) return false
  const sourceKey = entryKey(sourceEntry)
  const targetKey = entryKey(entry)
  if (sourceKey === targetKey) return false
  if (sourceEntry.type === PACK_TYPE) return false
  if (isEntryActive(sourceEntry)) return false
  // 普通卡进行中不允许被收起；卡包只会显示进行中徽标，仍然可以继续收卡。
  if (entry.type !== PACK_TYPE && isEntryActive(entry)) return false
  if (pins && pins[targetKey]) return false
  if (entry.type === PACK_TYPE && Number(entry.item?.count) >= PACK_MAX_MEMBERS) return false
  return true
}

/**
 * 指针世界坐标命中哪张卡的热区。
 * 返回 { key, entry, mode: 'merge'|'add' } 或 null。
 */
export function hitTestPackTarget({ entries, positions, point, sourceKey, pins = {}, inset = PACK_HOT_INSET }) {
  const rows = Array.isArray(entries) ? entries : []
  const sourceEntry = rows.find((entry) => entryKey(entry) === sourceKey) || null
  if (!sourceEntry || sourceEntry.type === PACK_TYPE || isEntryActive(sourceEntry)) return null
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null
  for (const entry of rows) {
    const key = entryKey(entry)
    if (key === sourceKey) continue
    const position = positions?.[key]
    if (!position) continue
    const left = Number(position.x) - Number(position.w) / 2 + inset
    const right = Number(position.x) + Number(position.w) / 2 - inset
    const top = Number(position.y) - Number(position.h) / 2 + inset
    const bottom = Number(position.y) + Number(position.h) / 2 - inset
    if (point.x < left || point.x > right || point.y < top || point.y > bottom) continue
    if (!isPackTargetEligible({ entry, sourceEntry, pins })) continue
    return {
      key,
      entry,
      mode: entry.type === PACK_TYPE ? 'add' : 'merge'
    }
  }
  return null
}

/** 把某个成员移到目标成员的前/后；顺序未变时返回原数组，便于跳过无意义请求。 */
export function movePackMember(members, key, targetIndex, after = false) {
  const rows = Array.isArray(members) ? members : []
  const from = rows.findIndex((member) => packMemberKey(member) === key)
  const index = Number(targetIndex)
  if (from < 0 || !Number.isInteger(index) || index < 0 || index >= rows.length) return rows
  let to = index + (after ? 1 : 0)
  if (from < to) to -= 1
  to = Math.max(0, Math.min(rows.length - 1, to))
  if (to === from) return rows
  const next = rows.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** 解散/移出时成员从卡包中心向外铺开；真正的间距交给现有布局求解。 */
export function fanPositions(center, count) {
  const total = Math.max(0, Math.floor(Number(count) || 0))
  if (!total) return []
  const cx = Number(center?.x) || 0
  const cy = Number(center?.y) || 0
  if (total === 1) return [{ x: Math.round(cx), y: Math.round(cy) }]
  return Array.from({ length: total }, (_, index) => {
    const angle = index * 2.39996 - Math.PI / 2
    const radius = 118 + Math.sqrt(index + 1) * 26
    return {
      x: Math.round(cx + Math.cos(angle) * radius * 1.18),
      y: Math.round(cy + Math.sin(angle) * radius * 0.9)
    }
  })
}

