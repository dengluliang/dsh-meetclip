import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allSelected, emptySelection, estimate, estimateText, hasAnyMedia, importCountsText,
  indexCatalog, inspectSummary, isSelected, itemsForApi, jobPercent, jobProgressText,
  keyOf, parseKey, selectAllCards, selectionText, setChecked, setGroup, skippedText,
  summary, toggle, typeLabel
} from '../client-src/lib/backup.js'

const catalog = {
  items: {
    packs: [{
      id: 'pack-1', title: '讨论合集', count: 5, created_at: 100,
      members: [
        { type: 'session', id: 's1', title: '记录一' },
        { type: 'note', id: 'n1', title: '便利签' },
        { type: 'doc', id: 'doc:dk1', title: '文档' },
        { type: 'batch', id: 'b1', title: '批次' },
        { type: 'highlight', id: '9', title: '标记' }
      ]
    }],
    records: [
      { id: 's1', title: '记录一', kind: 'meeting', base_bytes: 100, media_bytes: 1000 },
      { id: 's2', title: '记录二', kind: 'live', base_bytes: 50, media_bytes: 0, active: true }
    ],
    notes: [{ id: 'n1', title: '便利签', base_bytes: 10 }],
    highlights: [{ id: 9, session_id: 's2', note: '重点', session_title: '记录二' }],
    images: [{ id: 'i1', title: '图片卡', base_bytes: 30 }],
    docs: [{ key: 'dk1', title: '文档', base_bytes: 20 }],
    batches: [{ id: 'b1', title: '批次', count: 1, member_ids: ['s2'] }]
  }
}

const index = indexCatalog(catalog)

test('选择集是 type:id，切换与按类型选择互不影响', () => {
  assert.equal(keyOf('session', 's1'), 'session:s1')
  assert.deepEqual(parseKey('doc:dk1'), { type: 'doc', id: 'dk1' })
  assert.equal(parseKey('bogus'), null)

  let selection = emptySelection()
  selection = toggle(selection, 'session', 's1')
  assert.equal(isSelected(selection, 'session', 's1'), true)
  selection = toggle(selection, 'session', 's1')
  assert.equal(isSelected(selection, 'session', 's1'), false)

  selection = setChecked(selection, 'note', 'n1', true)
  selection = setGroup(selection, 'session', ['s1', 's2'], true)
  assert.equal(selection.size, 3)
  assert.equal(allSelected(selection, 'session', ['s1', 's2']), true)
  selection = setGroup(selection, 'session', ['s2'], false)
  assert.equal(allSelected(selection, 'session', ['s1', 's2']), false)
  assert.deepEqual(itemsForApi(selection).sort((a, b) => a.id.localeCompare(b.id)),
    [{ type: 'note', id: 'n1' }, { type: 'session', id: 's1' }])
})

test('全选包含卡包、记录、批次、便利签、标记、图片与文档', () => {
  const selection = selectAllCards(catalog)
  assert.equal(selection.size, 8)
  assert.equal(selection.has('pack:pack-1'), true)
  assert.equal(selection.has('session:s2'), true)
  assert.equal(selection.has('doc:dk1'), true)
  assert.equal(selection.has('batch:b1'), true)
  assert.equal(selection.has('image:i1'), true)
  assert.equal(selection.has('highlight:9'), true)
})

test('卡包、批次、标记会展开成真正会被备份的卡片', () => {
  let selection = emptySelection()
  selection = toggle(selection, 'pack', 'pack-1')
  const counts = summary(selection, index)
  assert.equal(counts.packs, 1)
  assert.equal(counts.records, 2, '包内记录 + 批次成员 + 包内提示的标记所属记录')
  assert.equal(counts.notes, 1)
  assert.equal(counts.docs, 1)
  assert.equal(counts.batches, 1)
  assert.equal(counts.highlights, 1)

  selection = toggle(toggle(emptySelection(), 'highlight', '9'), 'batch', 'b1')
  const onlyAggregates = summary(selection, index)
  assert.equal(onlyAggregates.records, 1)
  assert.equal(onlyAggregates.batches, 1)
})

test('体积估算区分含媒体与不含媒体', () => {
  const selection = toggle(emptySelection(), 'pack', 'pack-1')
  const plain = estimate(selection, index, false)
  assert.equal(plain.media, 1000, '未勾选媒体时体积仍然算出来，用于按钮旁的 +xxx 提示')
  assert.equal(plain.base, 100 + 50 + 10 + 20)
  assert.equal(plain.total, plain.base)

  const withMedia = estimate(selection, index, true)
  assert.equal(withMedia.media, 1000)
  assert.equal(withMedia.total, withMedia.base + 1000)

  assert.equal(hasAnyMedia(selection, index), true)
  assert.equal(hasAnyMedia(emptySelection(), index), false)
})

test('摘要、体积与空选择的文案', () => {
  assert.equal(selectionText(summary(emptySelection(), index)), '还没有选择卡片')
  const text = selectionText(summary(toggle(emptySelection(), 'pack', 'pack-1'), index))
  assert.match(text, /1 个卡包/)
  assert.match(text, /2 条记录/)
  assert.equal(estimateText({ base: 0, media: 0, total: 0 }), '—')
  assert.match(estimateText({ base: 2048, media: 0, total: 2048 }), /2 KB/)
  assert.match(estimateText({ base: 1024, media: 1024, total: 2048, includeMedia: true }), /含媒体 1 KB/)
  assert.doesNotMatch(estimateText({ base: 1024, media: 1024, total: 1024 }), /含媒体/)
  assert.equal(typeLabel('session'), '记录')
  assert.equal(typeLabel('unknown'), '卡片')
})

test('进度文案覆盖运行、完成、取消与失败', () => {
  assert.equal(jobPercent({ state: 'done' }), 100)
  assert.equal(jobPercent({ percent: 42.4, state: 'running' }), 42.4)
  assert.equal(jobPercent({ percent: 140, state: 'running' }), 100)
  assert.equal(jobPercent({}), null)
  assert.match(jobProgressText({ state: 'running', phase: '写入备份', percent: 42 }), /写入备份 42%/)
  assert.equal(jobProgressText({ state: 'done', phase: '完成' }), '已完成')
  assert.equal(jobProgressText({ state: 'cancelled', error: '已取消导入' }), '已取消导入')
  assert.equal(jobProgressText({ state: 'error', error: '磁盘空间不足' }), '磁盘空间不足')
})

test('导入摘要与计数文案', () => {
  const result = {
    counts: { records: 2, packs: 1, notes: 1, transcripts: 30 },
    skipped: { records: 1, notes: 2 }
  }
  assert.match(importCountsText(result), /2 条记录/)
  assert.match(importCountsText(result), /1 个卡包/)
  assert.equal(skippedText(result.skipped), '1 条记录、2 张便利签')

  const inspect = inspectSummary({
    counts: { records: 2, transcripts: 30, packs: 1, highlights: 3 },
    media_bytes: 1024
  })
  assert.equal(inspect.mediaBytes, 1024)
  assert.deepEqual(inspect.rows, ['2 条记录（30 行转写）', '1 个卡包', '3 条标记'])
  assert.deepEqual(inspectSummary(null), { rows: [], mediaBytes: 0, counts: {} })
})
