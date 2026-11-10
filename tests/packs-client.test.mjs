import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PACK_ARM_DELAY_MS,
  PACK_SIZE,
  applyPacks,
  entryMember,
  fanPositions,
  hitTestPackTarget,
  isPackTargetEligible,
  nextPackTitle,
  packById,
  packKey,
  packMatchesFilter,
  packMemberKey,
  movePackMember
} from '../client-src/components/home/pack-model.js'
import { entryKey } from '../client-src/components/home/scatter-layout.js'

function session(id, extra = {}) {
  return { type: 'session', item: { id, title: id, kind: 'live', status: 'done', ...extra } }
}

function note(id) {
  return { type: 'note', item: { id, text: '便利签', kind: 'note' } }
}

function pack(id, members = [], extra = {}) {
  return {
    id,
    title: `卡包 ${id}`,
    created_at: 100,
    updated_at: 200,
    count: members.length,
    active_count: 0,
    members,
    ...extra
  }
}

function rect(x, y, w = 200, h = 160) {
  return { x, y, w, h }
}

test('默认卡包名按已有数字顺延', () => {
  assert.equal(nextPackTitle([]), '卡包 1')
  assert.equal(nextPackTitle([{ title: '卡包 2' }, { title: '手动命名' }]), '卡包 3')
  assert.equal(nextPackTitle([{ title: '卡包 9' }, { title: '卡包 3' }]), '卡包 10')
})

test('卡包 key 与普通卡片 key 同一套规则', () => {
  assert.equal(packKey('abc'), 'pack-abc')
  assert.equal(packMemberKey({ type: 'doc', id: 'doc:xyz' }), 'doc-doc:xyz')
  assert.equal(entryKey({ type: 'doc', item: { id: 'doc:xyz' } }), 'doc-doc:xyz')
  assert.equal(entryMember(session('s1')).id, 's1')
  assert.equal(packById([pack('p1')], 'p1').title, '卡包 p1')
})

test('applyPacks 收起成员并追加一个卡包占位', () => {
  const rows = [session('s1'), session('s2'), note('n1'), session('s3')]
  const p1 = pack('p1', [
    { type: 'session', id: 's1', kind: 'live' },
    { type: 'session', id: 's2', kind: 'meeting' },
    { type: 'note', id: 'n1' }
  ])
  const out = applyPacks(rows, [p1])
  assert.deepEqual(out.map(entryKey), ['session-s3', 'pack-p1'])
  const empty = applyPacks([], [p1])
  assert.equal(empty.length, 1)
  assert.equal(empty[0].item.id, 'p1')
  const duplicate = applyPacks([], [p1, { ...p1 }])
  assert.equal(duplicate.length, 1)
})

test('筛选：任一成员匹配就显示整包', () => {
  const mixed = pack('p1', [
    { type: 'session', id: 's1', kind: 'live', status: 'done' },
    { type: 'session', id: 's2', kind: 'meeting', status: 'recording' },
    { type: 'note', id: 'n1', kind: 'note' },
    { type: 'doc', id: 'doc:x', kind: 'doc' },
    { type: 'batch', id: 'b1', kind: 'link_video', active: 1 }
  ], { active_count: 2 })
  assert.equal(packMatchesFilter(mixed, 'all'), true)
  assert.equal(packMatchesFilter(mixed, 'live'), true)
  assert.equal(packMatchesFilter(mixed, 'meeting'), true)
  assert.equal(packMatchesFilter(mixed, 'link_video'), true)
  assert.equal(packMatchesFilter(mixed, 'doc'), true)
  assert.equal(packMatchesFilter(mixed, 'mark'), true)
  assert.equal(packMatchesFilter(mixed, 'active'), true)
  const docOnly = pack('p2', [{ type: 'doc', id: 'doc:y', kind: 'doc' }])
  assert.equal(packMatchesFilter(docOnly, 'live'), false)
  assert.equal(packMatchesFilter(docOnly, 'active'), false)
  assert.equal(packMatchesFilter(pack('p3', []), 'all'), true)
  assert.equal(packMatchesFilter(pack('p3', []), 'live'), true, '空卡包在筛选下仍要可见')
})

test('热区资格：自身、图钉、进行中、满包、源为卡包都不行', () => {
  const target = session('b')
  const source = session('a')
  assert.equal(isPackTargetEligible({ entry: target, sourceEntry: source }), true)
  assert.equal(isPackTargetEligible({ entry: target, sourceEntry: target }), false)
  assert.equal(isPackTargetEligible({ entry: target, sourceEntry: source, pins: { 'session-b': true } }), false)
  assert.equal(isPackTargetEligible({
    entry: session('b', { status: 'recording' }), sourceEntry: source
  }), false)
  assert.equal(isPackTargetEligible({
    entry: session('b'), sourceEntry: session('a', { status: 'processing' })
  }), false)
  assert.equal(isPackTargetEligible({
    entry: target, sourceEntry: { type: 'pack', item: { id: 'p' } }
  }), false)
  const full = { type: 'pack', item: pack('full', Array.from({ length: 60 }, (_, i) => ({ type: 'note', id: `n${i}` }))) }
  assert.equal(isPackTargetEligible({ entry: full, sourceEntry: source }), false)
})

test('指针必须在目标卡内缩 12px 的热区里', () => {
  const entries = [session('a'), session('b'), note('c')]
  const positions = {
    'session-a': rect(0, 0),
    'session-b': rect(400, 0),
    'note-c': rect(800, 0)
  }
  const hit = hitTestPackTarget({
    entries, positions, sourceKey: 'session-a', point: { x: 400, y: 0 }
  })
  assert.equal(hit.key, 'session-b')
  assert.equal(hit.mode, 'merge')
  assert.equal(hitTestPackTarget({
    entries, positions, sourceKey: 'session-a', point: { x: 306, y: 0 }
  }), null, '外框内但热区外不触发')
  assert.equal(hitTestPackTarget({
    entries, positions, sourceKey: 'session-a', point: { x: 400, y: 0 }, pins: { 'session-b': true }
  }), null)
  assert.equal(hitTestPackTarget({
    entries: [session('a', { status: 'recording' }), session('b')],
    positions: { 'session-a': rect(0, 0), 'session-b': rect(400, 0) },
    sourceKey: 'session-a',
    point: { x: 400, y: 0 }
  }), null)
})

test('拖到已有卡包上返回 add 模式', () => {
  const source = session('a')
  const target = {
    type: 'pack',
    item: pack('p1', [{ type: 'session', id: 's1' }])
  }
  const hit = hitTestPackTarget({
    entries: [source, target],
    positions: { 'session-a': rect(0, 0), 'pack-p1': rect(400, 0, 272, 208) },
    sourceKey: 'session-a',
    point: { x: 400, y: 0 }
  })
  assert.equal(hit.key, 'pack-p1')
  assert.equal(hit.mode, 'add')
})

test('解散铺开：单张落在中心，多张不重合且围绕中心', () => {
  assert.deepEqual(fanPositions({ x: 10, y: 20 }, 0), [])
  assert.deepEqual(fanPositions({ x: 10, y: 20 }, 1), [{ x: 10, y: 20 }])
  const spots = fanPositions({ x: 0, y: 0 }, 6)
  assert.equal(spots.length, 6)
  for (const spot of spots) assert.ok(Math.hypot(spot.x, spot.y) > 80)
  const unique = new Set(spots.map((spot) => `${spot.x},${spot.y}`))
  assert.equal(unique.size, 6)
})

test('供页面统一使用的常量', () => {
  assert.equal(PACK_SIZE.w, 272)
  assert.equal(PACK_SIZE.h, 208)
  assert.equal(PACK_ARM_DELAY_MS, 160)
})

test('拖拽排序：前/后插入、边界与无变化', () => {
  const rows = [
    { type: 'session', id: 'a' },
    { type: 'note', id: 'b' },
    { type: 'doc', id: 'doc:c' }
  ]
  assert.deepEqual(movePackMember(rows, 'session-a', 1, true).map((row) => row.id), ['b', 'a', 'doc:c'])
  assert.deepEqual(movePackMember(rows, 'session-a', 2, true).map((row) => row.id), ['b', 'doc:c', 'a'])
  assert.deepEqual(movePackMember(rows, 'doc-doc:c', 0, false).map((row) => row.id), ['doc:c', 'a', 'b'])
  assert.equal(movePackMember(rows, 'session-a', 0, false), rows, '原位拖动不制造新数组')
  assert.equal(movePackMember(rows, 'missing', 0, false), rows)
  assert.equal(movePackMember(rows, 'session-a', 99, false), rows)
})

