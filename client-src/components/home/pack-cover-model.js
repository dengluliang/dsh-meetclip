// 卡包封面的纯模型：成员叫什么、包是什么颜色、封面写哪几行、底片条放哪几格。
// 和 pack-model.js 一样不碰 React 和 DOM，便于在 node:test 里直接验证边界。
import { kindInfo } from '../../lib/format.js'

export function memberLabel(member) {
  if (!member) return ''
  if (member.type === 'session') return kindInfo(member.kind).label
  if (member.type === 'batch') return '批次'
  if (member.type === 'highlight') return '标记'
  if (member.type === 'note') return member.kind === 'todo' ? '待办' : '便利签'
  if (member.type === 'image') return '图片'
  if (member.type === 'doc') return '链接'
  return '卡片'
}

/** 主题色取成员类型：直播红 / 视频橙 / 会议紫 / 标记紫 / 便签黄 / 待办蓝。 */
export function memberTone(member) {
  if (!member) return 'card'
  if (member.type === 'session') return kindInfo(member.kind).tone
  if (member.type === 'note') return member.kind === 'todo' ? 'todo' : 'note'
  if (member.type === 'highlight') return 'highlight'
  if (member.type === 'doc') return 'doc'
  if (member.type === 'image') return 'image'
  if (member.type === 'batch') return 'batch'
  return 'card'
}

/** 封面第二行：「2 视频 · 1 标记 · 1 待办」，按数量取前三类，只描述构成。 */
export function composition(members) {
  const counts = new Map()
  for (const member of Array.isArray(members) ? members : []) {
    const label = memberLabel(member)
    if (!label) continue
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([label, count]) => `${count} ${label}`)
    .join(' · ')
}

/** 封面的更新时间只给 M/D：年份和时刻对「找包」没有帮助。 */
export function updatedLabel(seconds) {
  const epoch = Number(seconds)
  if (!epoch) return ''
  const date = new Date(epoch * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()} 更新`
}

/**
 * 底片条最多四格：不超过四张就一格一人；超过四张时留三格，用「+N」收尾，
 * 避免小格子里挤满缩略图、也避免张数和格子数对不上。
 */
export function stripMembers(members, count) {
  const rows = (Array.isArray(members) ? members : []).filter(Boolean)
  const total = Math.max(Number(count) || 0, rows.length)
  const shown = rows.slice(0, total > 4 ? 3 : 4)
  return { shown, rest: Math.max(0, total - shown.length) }
}

export function packTone(members) {
  return memberTone((Array.isArray(members) ? members : [])[0])
}
