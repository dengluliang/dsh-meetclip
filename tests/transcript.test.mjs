import assert from 'node:assert/strict'
import test from 'node:test'
import { transcriptLine, transcriptText } from '../client-src/lib/format.js'

const detail = { speakers: { S1: '发言人 1', S2: '张三' } }
const rows = [
  { id: 1, start: 0, end: 5, speaker: 'S1', text: '大家好，这是第一段。' },
  { id: 2, start: 5, end: 10, speaker: 'S1', text: '第二段内容。' },
  { id: 3, start: 3725, end: 3730, speaker: 'S2', text: '  一小时之后的内容  ' },
  { id: 4, start: 3730, end: 3731, speaker: null, text: '没有发言人的一段。' },
  { id: 5, start: 3731, end: 3732, speaker: 'S1', text: '   ' }
]

test('transcript line keeps the time code and the resolved speaker', () => {
  assert.equal(transcriptLine(rows[0], detail), '[00:00] 发言人 1：大家好，这是第一段。')
  assert.equal(transcriptLine(rows[2], detail), '[1:02:05] 张三：一小时之后的内容')
  assert.equal(transcriptLine(rows[3], detail), '[1:02:10] 没有发言人的一段。')
  assert.equal(transcriptLine({ start: 8, text: '' }, detail), '')
})

test('transcript text joins every readable row for copying', () => {
  const text = transcriptText(rows, detail)
  assert.equal(text.split('\n').length, 4)
  assert.ok(text.startsWith('[00:00] 发言人 1：大家好，这是第一段。\n'))
  assert.ok(text.endsWith('[1:02:10] 没有发言人的一段。'))
  assert.ok(!text.includes('   '))
  assert.equal(transcriptText(null, detail), '')
  assert.equal(transcriptText([], detail), '')
})
