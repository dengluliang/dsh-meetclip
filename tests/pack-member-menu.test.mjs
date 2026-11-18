import assert from 'node:assert/strict'
import test from 'node:test'
import { packMemberMenuItems } from '../client-src/components/home/pack-member-menu.js'

function member(type, id = `${type}-1`) {
  return { type, id, title: `${type} 卡片` }
}

function labels(items) {
  return items.filter((item) => !item.separator).map((item) => item.label)
}

test('卡包成员右键菜单第一项是「基于此卡片提问」', () => {
  const asked = []
  const items = packMemberMenuItems(member('session', 's1'), { onAsk: (target) => asked.push(target) })
  assert.equal(items[0].id, 'ask-member')
  assert.equal(items[0].label, '基于此卡片提问')
  assert.equal(items[0].hint, '在 Agent中 @它')
  items[0].onSelect()
  assert.deepEqual(asked.map((row) => row.id), ['s1'])
})

test('可打开的成员才有「打开」，文案按类型区分', () => {
  const opened = []
  const onOpen = (target) => opened.push(target)
  assert.deepEqual(labels(packMemberMenuItems(member('session'), { onOpen })), ['基于此卡片提问', '打开记录', '移出卡包'])
  assert.deepEqual(labels(packMemberMenuItems(member('highlight'), { onOpen })), ['基于此卡片提问', '打开记录', '移出卡包'])
  assert.deepEqual(labels(packMemberMenuItems(member('batch'), { onOpen })), ['基于此卡片提问', '打开批次', '移出卡包'])
  assert.deepEqual(labels(packMemberMenuItems(member('doc', 'doc:abc'), { onOpen })), ['基于此卡片提问', '打开文档', '移出卡包'])
  // 便利签与图片卡在墙面上也没有「打开」动作。
  assert.deepEqual(labels(packMemberMenuItems(member('note'), { onOpen })), ['基于此卡片提问', '移出卡包'])
  assert.deepEqual(labels(packMemberMenuItems(member('image'), { onOpen })), ['基于此卡片提问', '移出卡包'])
  const openItem = packMemberMenuItems(member('batch'), { onOpen }).find((item) => item.id === 'open-member')
  openItem.onSelect()
  assert.equal(opened[0].type, 'batch')
})

test('「移出卡包」在最后并说明不删记录', () => {
  const removed = []
  const items = packMemberMenuItems(member('note', 'n1'), { onRemove: (target) => removed.push(target) })
  assert.equal(items.at(-1).id, 'remove-member')
  assert.equal(items.at(-1).label, '移出卡包')
  assert.equal(items.at(-1).hint, '不删除记录')
  assert.ok(items.slice(0, -1).some((item) => item.separator), '动作与移出之间要有一条分隔线')
  items.at(-1).onSelect()
  assert.equal(removed[0].id, 'n1')
})

test('保存中只锁住会改动卡包的动作，仍可提问', () => {
  const items = packMemberMenuItems(member('session'), { locked: true })
  assert.equal(items.find((item) => item.id === 'ask-member').disabled, undefined)
  assert.equal(items.find((item) => item.id === 'open-member').disabled, true)
  assert.equal(items.find((item) => item.id === 'remove-member').disabled, true)
})

test('没有成员时不生成菜单项', () => {
  assert.deepEqual(packMemberMenuItems(null), [])
  assert.deepEqual(packMemberMenuItems(undefined), [])
})
