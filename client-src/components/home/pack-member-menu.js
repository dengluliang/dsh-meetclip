// 卡包浮层里右键卡片：沿用首页右键的「基于此卡片提问」，只保留浮层里能做的动作。
// 纯函数，交给 ContextMenu 渲染；不碰 React 与 DOM，便于 node:test 直接验证。
const OPEN_LABELS = {
  session: '打开记录',
  highlight: '打开记录',
  batch: '打开批次',
  doc: '打开文档'
}

/**
 * @param {object} member 卡包成员（含 type / id，来自 GET /api/packs）
 * @param {object} options
 * @param {boolean} options.locked 正在保存（移出/改名/排序）时禁用会改动卡包的动作
 * @param {(member: object) => void} options.onAsk
 * @param {(member: object) => void} options.onOpen
 * @param {(member: object) => void} options.onRemove
 * @returns {Array<object>} ContextMenu 的 items
 */
export function packMemberMenuItems(member, { locked = false, onAsk, onOpen, onRemove } = {}) {
  if (!member) return []
  const items = [{
    id: 'ask-member',
    label: '基于此卡片提问',
    hint: '在 Agent中 @它',
    onSelect: () => onAsk?.(member)
  }]
  const openLabel = OPEN_LABELS[member.type]
  if (openLabel) {
    items.push({
      id: 'open-member',
      label: openLabel,
      disabled: locked,
      onSelect: () => onOpen?.(member)
    })
  }
  items.push({ separator: true })
  items.push({
    id: 'remove-member',
    label: '移出卡包',
    hint: '不删除记录',
    disabled: locked,
    onSelect: () => onRemove?.(member)
  })
  return items
}
