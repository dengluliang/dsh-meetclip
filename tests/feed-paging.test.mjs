import test from 'node:test'
import assert from 'node:assert/strict'
import { FEED_PAGE_SIZE, feedPageExhausted, mergeFeedPage } from '../client-src/lib/feed-paging.js'

const row = (id) => ({ id })

test('短页和空页都算到底，满页才算还有下一页', () => {
  assert.equal(feedPageExhausted(Array.from({ length: FEED_PAGE_SIZE }, (_, index) => row(`s${index}`))), false)
  assert.equal(feedPageExhausted(Array.from({ length: FEED_PAGE_SIZE - 1 }, (_, index) => row(`s${index}`))), true)
  assert.equal(feedPageExhausted([]), true)
  assert.equal(feedPageExhausted(null), true)
  assert.equal(feedPageExhausted(undefined), true)
  assert.equal(feedPageExhausted(Array.from({ length: 3 }, (_, index) => row(`s${index}`)), 3), false)
})

test('追加分页时按 id 去重，重复页不会改变列表', () => {
  const current = [row('a'), row('b')]
  const merged = mergeFeedPage(current, [row('b'), row('c')])
  assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c'])
  assert.equal(mergeFeedPage(current, [row('a'), row('b')]), current, '全是旧卡片时返回原数组，避免多余重渲染')
  assert.deepEqual(mergeFeedPage(null, [row('a')]).map((item) => item.id), ['a'])
  assert.deepEqual(mergeFeedPage(null, null), [])
  assert.deepEqual(mergeFeedPage([row('a')], [{ id: 'a' }, null, {}]).map((item) => item.id), ['a'])
})
