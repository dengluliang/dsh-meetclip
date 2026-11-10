import assert from 'node:assert/strict'
import test from 'node:test'

import { highlightSpans, newHighlightId, todoKey } from '../client-src/lib/minutesInteractions.js'

test('todoKey 与后端归一化一致：空白/大小写/句末标点不影响勾选状态', () => {
  assert.equal(todoKey('补一份 预算表。'), todoKey('补一份预算表'))
  assert.equal(todoKey('补一份预算表！'), todoKey('补一份预算表'))
  assert.equal(todoKey('  Confirm  the plan? '), todoKey('confirm the plan'))
  assert.notEqual(todoKey('补一份预算表'), todoKey('补一份采购表'))
  assert.equal(todoKey(''), '')
})

test('高亮按原文片段与上下文定位，只命中选择的那一处', () => {
  const text = '预算缺口还有二十万，缺口比预期大。'
  const spans = highlightSpans(text, [{
    id: 'h1',
    quote: '缺口',
    fragments: [{ text: '缺口', before: '预算', after: '还有二十万' }]
  }])
  assert.equal(spans.length, 1)
  assert.equal(spans[0].start, 2)
  assert.equal(text.slice(spans[0].start, spans[0].end), '缺口')
})

test('上下文缺失时退回首次出现，重写后片段变化则不画', () => {
  const text = '第一段 预算缺口 第二段 缺口'
  const plain = highlightSpans(text, [{ id: 'h1', quote: '缺口', fragments: [{ text: '缺口' }] }])
  assert.equal(plain.length, 1)
  assert.equal(plain[0].start, text.indexOf('缺口'))
  const missing = highlightSpans(text, [{ id: 'h2', quote: '采购', fragments: [{ text: '采购' }] }])
  assert.deepEqual(missing, [])
})

test('重叠高亮只保留先出现的一段，相邻片段各自成段', () => {
  const text = '预算缺口还有二十万'
  const spans = highlightSpans(text, [
    { id: 'h1', quote: '预算缺口', fragments: [{ text: '预算缺口' }] },
    { id: 'h2', quote: '缺口', fragments: [{ text: '缺口' }] },
    { id: 'h3', quote: '二十万', fragments: [{ text: '二十万' }] }
  ])
  assert.deepEqual(spans.map((span) => span.id), ['h1', 'h3'])
  assert.deepEqual(spans.map((span) => text.slice(span.start, span.end)), ['预算缺口', '二十万'])
})

test('新的高亮 id 不重复', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newHighlightId()))
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^h-[a-z0-9]+-[a-z0-9]+$/)
})

test('老数据里被折成半角的标点仍能匹配回全角原文', () => {
  // 真实故障：后端曾用 NFKC 存片段，"，"被存成","，于是结构化视图一条高亮都画不出来。
  const text = '小爱语音入口+HTML前端页面是更易落地的合作方式，先建立双方信任再逐步深入'
  const spans = highlightSpans(text, [{
    id: 'h-legacy',
    quote: '小爱语音入口+HTML前端页面是更易落地的合作方式,先建立双方信任再逐步深入',
    fragments: [{
      text: '小爱语音入口+HTML前端页面是更易落地的合作方式,先建立双方信任再逐步深入',
      before: '',
      after: ''
    }]
  }])
  assert.equal(spans.length, 1)
  assert.equal(text.slice(spans[0].start, spans[0].end), text)
})

test('全角标点带上下文时命中位置仍准确', () => {
  const text = '先看第一段。结论：先建立信任，再谈合作。后面还有内容。'
  const spans = highlightSpans(text, [{
    id: 'h1',
    quote: '结论:先建立信任,再谈合作。',
    fragments: [{ text: '结论:先建立信任,再谈合作。', before: '先看第一段。', after: '后面还有内容。' }]
  }])
  assert.equal(spans.length, 1)
  assert.equal(text.slice(spans[0].start, spans[0].end), '结论：先建立信任，再谈合作。')
})
