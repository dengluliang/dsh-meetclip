import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HERO_SIZE,
  SCATTER_GAP,
  buildLayout,
  entryKey,
  entrySize,
  nudgeOutOf,
  rectOverlap
} from '../client-src/components/home/scatter-layout.js'

const TOLERANCE = 1.5

function session(id, extra = {}) {
  return { type: 'session', item: { id, title: id, kind: 'live', ...extra } }
}

function highlight(id) {
  return { type: 'highlight', item: { id, note: '金句', session_id: 's1', ts: 1 } }
}

function note(id, extra = {}) {
  return { type: 'note', item: { id, text: '便利签', kind: 'note', ...extra } }
}

function image(id, extra = {}) {
  return { type: 'image', item: { id, width: 600, height: 400, ...extra } }
}

function batch(id) {
  return { type: 'batch', item: { id, title: '批量视频', created_at: 1, total: 2, active: 1, counts: { done: 1, queued: 1 }, members: [] } }
}

function rectOf(position) {
  return { x: position.x, y: position.y, w: position.w, h: position.h }
}

function heroRect() {
  return { x: 0, y: 0, w: HERO_SIZE.w, h: HERO_SIZE.h }
}

function assertClear(positions, gap = SCATTER_GAP) {
  const keys = Object.keys(positions)
  for (let i = 0; i < keys.length; i += 1) {
    const a = positions[keys[i]]
    assert.equal(rectOverlap(rectOf(a), heroRect(), gap - TOLERANCE), false, `${keys[i]} 压住了 Hero`)
    for (let j = i + 1; j < keys.length; j += 1) {
      const b = positions[keys[j]]
      assert.equal(
        rectOverlap(rectOf(a), rectOf(b), gap - TOLERANCE),
        false,
        `${keys[i]} 和 ${keys[j]} 间距不足`
      )
    }
  }
}

const mixed = [
  session('s1'),
  session('s2', { duration: 3600 }),
  session('s3', { cover: { value: 'cover.jpg' } }),
  highlight('h1'),
  highlight('h2'),
  note('n1'),
  note('n2', { kind: 'todo' }),
  image('i1'),
  image('i2', { width: 400, height: 900 })
]

test('混合卡片全部参与避让，彼此和 Hero 都留出间距', () => {
  const layout = buildLayout(mixed)
  assert.equal(Object.keys(layout.positions).length, mixed.length)
  assertClear(layout.positions)
})

test('同样的输入得到同样的结果，带 previous 再算一次不漂移', () => {
  const first = buildLayout(mixed)
  const second = buildLayout(mixed)
  assert.deepEqual(first.positions, second.positions)
  const third = buildLayout(mixed, { previous: first })
  assert.deepEqual(third.positions, first.positions)
})

test('拖过的卡片精确停在落点，其他卡片让开', () => {
  const base = buildLayout(mixed)
  const target = base.positions[entryKey(mixed[0])]
  const manual = { [entryKey(mixed[5])]: { x: target.x, y: target.y } }
  const layout = buildLayout(mixed, { manual, previous: base })
  const moved = layout.positions[entryKey(mixed[5])]
  assert.deepEqual({ x: moved.x, y: moved.y }, { x: target.x, y: target.y })
  assert.equal(rectOverlap(rectOf(layout.positions[entryKey(mixed[0])]), rectOf(moved), SCATTER_GAP - TOLERANCE), false)
  assertClear(layout.positions)
})

test('图钉卡片在新增和删除其他卡片后不动', () => {
  const base = buildLayout(mixed, { pins: { [entryKey(mixed[1])]: true } })
  const pinnedKey = entryKey(mixed[1])
  const pinnedPos = base.positions[pinnedKey]
  const added = buildLayout([session('s9'), ...mixed], {
    pins: { [pinnedKey]: true },
    previous: base
  })
  assert.deepEqual(added.positions[pinnedKey], pinnedPos)
  const removed = buildLayout(mixed.filter((entry) => entryKey(entry) !== 'session-s9'), {
    pins: { [pinnedKey]: true },
    previous: added
  })
  assert.deepEqual(removed.positions[pinnedKey], pinnedPos)
})

test('新增卡片只挤压发生重叠的旧卡，远处的卡片不动', () => {
  const base = buildLayout(mixed)
  const added = buildLayout([session('new'), ...mixed], { previous: base })
  for (const entry of mixed) {
    const key = entryKey(entry)
    const before = base.positions[key]
    const after = added.positions[key]
    const distance = Math.hypot(after.x - before.x, after.y - before.y)
    if (Math.hypot(before.x, before.y) > 500) {
      assert.ok(distance <= 1, `${key} 无故移动了 ${distance}px`)
    }
  }
  assertClear(added.positions)
})

test('两个手动落点重叠时，后来的卡片被顶开', () => {
  const entries = [session('a'), session('b')]
  const manual = {
    [entryKey(entries[0])]: { x: 0, y: 400 },
    [entryKey(entries[1])]: { x: 0, y: 400 }
  }
  const layout = buildLayout(entries, { manual })
  const a = layout.positions[entryKey(entries[0])]
  const b = layout.positions[entryKey(entries[1])]
  assert.deepEqual({ x: a.x, y: a.y }, { x: 0, y: 400 })
  assert.equal(rectOverlap(rectOf(a), rectOf(b), SCATTER_GAP - TOLERANCE), false)
})

test('nudgeOutOf 用最小位移把卡片顶出障碍', () => {
  const node = { x: 10, y: 0, w: 200, h: 160 }
  const obstacle = { x: 10, y: 0, w: 200, h: 160 }
  const pushed = nudgeOutOf(node, [obstacle], 20)
  assert.equal(rectOverlap({ ...node, ...pushed }, obstacle, 19), false)
  assert.ok(Math.abs(pushed.x - node.x) + Math.abs(pushed.y - node.y) < 300)
})

test('80 张卡片在 pass 上限内收敛且不重叠', () => {
  const entries = Array.from({ length: 80 }, (_, index) => {
    const id = `s${index}`
    if (index % 7 === 0) return note(id)
    if (index % 7 === 1) return image(id, { width: 500 + index * 3, height: 400 })
    if (index % 7 === 2) return highlight(id)
    return session(id, index % 3 === 0 ? { cover: { value: 'c.jpg' } } : {})
  })
  const started = Date.now()
  const layout = buildLayout(entries)
  const elapsed = Date.now() - started
  assert.equal(layout.converged, true)
  assertClear(layout.positions)
  assert.ok(elapsed < 1500, `求解耗时 ${elapsed}ms`)
})

test('空列表、单卡和全固定卡都不抛错', () => {
  assert.deepEqual(buildLayout([]).positions, {})
  const single = buildLayout([session('only')])
  assert.equal(Object.keys(single.positions).length, 1)
  const entries = [session('a'), note('b')]
  const manual = {
    [entryKey(entries[0])]: { x: 300, y: 300 },
    [entryKey(entries[1])]: { x: -300, y: 300 }
  }
  const layout = buildLayout(entries, { manual })
  const placed = layout.positions[entryKey(entries[0])]
  assert.equal(placed.x, 300)
  assert.equal(rectOverlap(rectOf(placed), heroRect(), SCATTER_GAP - TOLERANCE), false)
  assert.equal(placed.w, entrySize(entries[0]).w)
})

test('批次卡有固定尺寸并参与避让', () => {
  const entries = [session('s1'), batch('b1'), note('n1')]
  const layout = buildLayout(entries)
  assert.equal(Object.keys(layout.positions).length, entries.length)
  assert.equal(entrySize(batch('b1')).w, 268)
  assert.equal(entrySize(batch('b1')).h, 196)
  assertClear(layout.positions)
})
