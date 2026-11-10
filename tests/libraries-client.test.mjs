import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeOf, busyWorkText, defaultLibraryDir, dirLeaf, foreignLibraryFor, libraryMeta,
  libraryNameError, matchLibraryByDir, sortLibraries, suggestedLibraryDir
} from '../client-src/lib/libraries.js'

const ROWS = [
  { id: 'a', name: '工作', dataDir: '/Users/me/Documents/会摘/工作', active: true, records: 12, exists: true, hasLibrary: true },
  { id: 'b', name: '生活', dataDir: '/Users/me/Documents/会摘/生活', active: false, records: 3, exists: true, hasLibrary: true, lastOpenedAt: 200 },
  { id: 'c', name: '归档', dataDir: '/Volumes/SSD/old', active: false, records: 0, exists: false, hasLibrary: false, lastOpenedAt: 100 }
]

test('名称校验给出可操作的提示', () => {
  assert.equal(libraryNameError('工作'), '')
  assert.equal(libraryNameError('  生活  '), '')
  assert.equal(libraryNameError(''), '请先给资料空间起个名字')
  assert.equal(libraryNameError('   '), '请先给资料空间起个名字')
  assert.match(libraryNameError('a/b'), /不能出现/)
  assert.match(libraryNameError('名'.repeat(41)), /40/)
  assert.equal(libraryNameError('名'.repeat(40)), '')
})

test('菜单把当前空间排在最前，其余按最近使用', () => {
  const sorted = sortLibraries(ROWS)
  assert.deepEqual(sorted.map((row) => row.id), ['a', 'b', 'c'])
  const moved = sortLibraries([
    { id: 'x', name: '甲', active: false, lastOpenedAt: 10 },
    { id: 'y', name: '乙', active: false, lastOpenedAt: 30 }
  ])
  assert.deepEqual(moved.map((row) => row.id), ['y', 'x'])
  assert.equal(activeOf(ROWS)?.id, 'a')
  assert.equal(activeOf([]), null)
  assert.deepEqual(sortLibraries(null), [])
})

test('每行的说明如实反映条数与位置问题', () => {
  assert.equal(libraryMeta(ROWS[0]), '12 条记录')
  assert.equal(libraryMeta(ROWS[2]), '0 条记录 · 位置不可用')
  assert.equal(libraryMeta({ records: 0, exists: true, hasLibrary: false }), '0 条记录 · 还没有资料')
  assert.equal(libraryMeta(null), '')
})

test('目录能对上哪个资料空间', () => {
  assert.equal(matchLibraryByDir(ROWS, '/Users/me/Documents/会摘/工作/')?.id, 'a')
  assert.equal(matchLibraryByDir(ROWS, '/Users/me/Documents/会摘/工作/会摘卡片'), null, '子目录不算同一个空间')
  assert.equal(matchLibraryByDir(ROWS, ''), null)
  assert.equal(matchLibraryByDir(null, '/tmp'), null)
})

test('会话工作区属于别的资料空间时才提示', () => {
  assert.equal(foreignLibraryFor({ rows: ROWS, cwd: '/Users/me/Documents/会摘/工作' }), null)
  assert.equal(foreignLibraryFor({ rows: ROWS, cwd: '/Users/me/Documents/会摘/生活' })?.id, 'b')
  assert.equal(foreignLibraryFor({ rows: ROWS, cwd: '/Users/me/code/app' }), null)
  assert.equal(foreignLibraryFor({ rows: ROWS, cwd: '' }), null)
  assert.equal(foreignLibraryFor({ rows: [], cwd: '/Users/me/Documents/会摘/生活' }), null)
})

test('切换前的任务说明按类型归纳', () => {
  assert.equal(busyWorkText([]), '')
  assert.equal(busyWorkText([
    { kind: 'live' }, { kind: 'live' }, { kind: 'meeting' }
  ]), '直播 2 条、会议 1 条')
  assert.equal(busyWorkText([{ kind: 'link_video' }]), '视频 1 条')
  assert.equal(busyWorkText([{}]), '任务 1 条')
})

test('新建空间的建议位置跟着当前库走', () => {
  assert.equal(
    suggestedLibraryDir({ dataDir: '/Users/me/Documents/直播摘录/data', name: '工作' }),
    '/Users/me/Documents/会摘/工作'
  )
  assert.equal(
    suggestedLibraryDir({ dataDir: '/Volumes/SSD/mc/data', name: '生活' }),
    '/Volumes/SSD/mc/生活'
  )
  assert.equal(suggestedLibraryDir({ dataDir: '', name: 'x' }), '')
  assert.equal(suggestedLibraryDir({ dataDir: '/Volumes/SSD/mc/data', name: '  ' }), '/Volumes/SSD/mc/新资料空间')
  assert.equal(defaultLibraryDir('/Users/me', '工作'), '/Users/me/Documents/会摘/工作')
  assert.equal(dirLeaf('/Users/me/Documents/会摘/工作'), '工作')
  assert.equal(dirLeaf('/Users/me/Documents/会摘/data'), '')
})
