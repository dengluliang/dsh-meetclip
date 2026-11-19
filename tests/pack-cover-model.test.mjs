import test from 'node:test'
import assert from 'node:assert/strict'
import { composition, memberLabel, memberTone, packTone, stripMembers, updatedLabel } from '../client-src/components/home/pack-cover-model.js'

// 封面第一行、主题色、底片条都只依赖「成员是什么」，边界错一格就会在小卡片上暴露：
// 张数写错、底片条多一格、主题色取了不存在的类型。

test('memberLabel covers every card type the pack can hold', () => {
  assert.equal(memberLabel({ type: 'session', kind: 'live' }), '直播')
  assert.equal(memberLabel({ type: 'session', kind: 'link_video' }), '视频')
  assert.equal(memberLabel({ type: 'session', kind: 'meeting' }), '会议')
  assert.equal(memberLabel({ type: 'highlight' }), '标记')
  assert.equal(memberLabel({ type: 'note', kind: 'todo' }), '待办')
  assert.equal(memberLabel({ type: 'note', kind: 'note' }), '便利签')
  assert.equal(memberLabel({ type: 'image' }), '图片')
  assert.equal(memberLabel({ type: 'doc' }), '链接')
  assert.equal(memberLabel({ type: 'batch' }), '批次')
  assert.equal(memberLabel(null), '')
})

test('memberTone keeps session kinds and note variants apart', () => {
  assert.equal(memberTone({ type: 'session', kind: 'live' }), 'live')
  assert.equal(memberTone({ type: 'session', kind: 'link_video' }), 'video')
  assert.equal(memberTone({ type: 'session', kind: 'meeting' }), 'meeting')
  assert.equal(memberTone({ type: 'note', kind: 'todo' }), 'todo')
  assert.equal(memberTone({ type: 'note' }), 'note')
  assert.equal(memberTone({ type: 'highlight' }), 'highlight')
  assert.equal(memberTone({ type: 'doc' }), 'doc')
  assert.equal(memberTone({ type: 'image' }), 'image')
  assert.equal(memberTone({ type: 'batch' }), 'batch')
  assert.equal(memberTone(null), 'card')
  // 主题色跟着包里的第一张卡走，换汤不换药：没有成员时退回中性色。
  assert.equal(packTone([]), 'card')
  assert.equal(packTone([{ type: 'session', kind: 'meeting' }, { type: 'note' }]), 'meeting')
})

test('composition sorts by count, keeps three groups and drops empty labels', () => {
  assert.equal(composition([
    { type: 'session', kind: 'live' },
    { type: 'session', kind: 'live' },
    { type: 'highlight' },
    { type: 'note', kind: 'todo' }
  ]), '2 直播 · 1 标记 · 1 待办')
  // 相同数量时按成员出现的先后排，不和成员顺序打架。
  assert.equal(composition([{ type: 'doc' }, { type: 'image' }]), '1 链接 · 1 图片')
  assert.equal(composition([]), '')
  assert.equal(composition(null), '')
})

test('updatedLabel only prints M/D and hides missing or invalid timestamps', () => {
  const epoch = 1793500000
  const date = new Date(epoch * 1000)
  assert.equal(updatedLabel(epoch), `${date.getMonth() + 1}/${date.getDate()} 更新`)
  assert.equal(updatedLabel(0), '')
  assert.equal(updatedLabel(null), '')
  assert.equal(updatedLabel('not-a-number'), '')
})

test('stripMembers keeps four cells for small packs and reserves a +N cell above four', () => {
  const members = Array.from({ length: 6 }, (_, index) => ({ type: 'session', id: `s${index}` }))
  const four = stripMembers(members.slice(0, 4), 4)
  assert.deepEqual(four.shown.map((member) => member.id), ['s0', 's1', 's2', 's3'])
  assert.equal(four.rest, 0)

  const six = stripMembers(members, 6)
  assert.deepEqual(six.shown.map((member) => member.id), ['s0', 's1', 's2'])
  assert.equal(six.rest, 3)

  // 张数比已加载到的成员多时，剩余张数仍然要算进 +N，否则封面会说少几张。
  const partial = stripMembers(members.slice(0, 2), 6)
  assert.equal(partial.shown.length, 2)
  assert.equal(partial.rest, 4)

  // count 缺失或为 0 但成员还在时，以成员数为准，不能出现 0 张的封面。
  const noCount = stripMembers(members.slice(0, 2), 0)
  assert.equal(noCount.shown.length, 2)
  assert.equal(noCount.rest, 0)
  assert.deepEqual(stripMembers([], 0), { shown: [], rest: 0 })
})
