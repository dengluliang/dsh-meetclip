import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasMinutesContent, isWeak, labelLanguage, minutesLabels, minutesSections,
  outcomesHeading, timelineSegments
} from '../client-src/lib/minutesView.js'

test('uses the section order sent by the backend', () => {
  const minutes = { scenario: 'meeting', section_order: ['outcomes', 'summary', 'topics', 'terms'] }
  assert.deepEqual(minutesSections(minutes), ['outcomes', 'summary', 'topics', 'terms'])
})

test('falls back to the scenario order when the payload has none', () => {
  assert.deepEqual(minutesSections({ scenario: 'meeting' }), ['outcomes', 'summary', 'topics', 'terms'])
  assert.deepEqual(minutesSections({ scenario: 'video' }), ['summary', 'topics', 'conclusions', 'todos', 'terms'])
  assert.deepEqual(minutesSections({ scenario: 'live' }), ['summary', 'topics', 'conclusions', 'todos', 'terms'])
  assert.deepEqual(minutesSections(null), ['outcomes', 'summary', 'topics', 'terms'])
})

test('labels come from the payload and fall back by language', () => {
  const zh = minutesLabels({ lang: 'Simplified Chinese', labels: { outcomes: '结论和待办' } })
  assert.equal(zh.outcomes, '结论和待办')
  assert.equal(zh.topics, '主题')
  const en = minutesLabels({ lang: 'English' })
  assert.equal(en.summary, 'Summary')
  assert.equal(labelLanguage('Traditional Chinese'), 'zh')
  assert.equal(labelLanguage('Japanese'), 'en')
})

test('outcomes heading adapts to what is present', () => {
  const labels = { outcomes: '结论和待办', conclusions: '结论', todos: '待办' }
  assert.equal(outcomesHeading(labels, [{ text: 'a' }], [{ text: 'b' }]), '结论和待办')
  assert.equal(outcomesHeading(labels, [{ text: 'a' }], []), '结论')
  assert.equal(outcomesHeading(labels, [], [{ text: 'b' }]), '待办')
})

test('weak evidence is support <= 0 or missing', () => {
  assert.equal(isWeak(0), true)
  assert.equal(isWeak(undefined), true)
  assert.equal(isWeak(1), false)
  assert.equal(isWeak('2'), false)
})

test('hasMinutesContent ignores empty scaffolds', () => {
  assert.equal(hasMinutesContent(null), false)
  assert.equal(hasMinutesContent({ summary: '', topics: [], conclusions: [], todos: [], terms: [] }), false)
  assert.equal(hasMinutesContent({ summary: '有内容' }), true)
  assert.equal(hasMinutesContent({ topics: [{ title: 't' }] }), true)
})

test('timeline segments split by the next topic start and the covered second', () => {
  const minutes = {
    final: true,
    covered: 600,
    topics: [{ start: 5, title: '开场' }, { start: 200, title: '方案' }, { start: 480, title: '收尾' }]
  }
  const segments = timelineSegments(minutes)
  assert.equal(segments.length, 3)
  assert.deepEqual(segments.map((segment) => [segment.start, segment.end]), [[5, 200], [200, 480], [480, 600]])
  assert.equal(segments[0].span, 195)
  assert.equal(segments[2].span, 120)
  assert.deepEqual(segments.map((segment) => segment.current), [false, false, false])
})

test('timeline marks the last topic as current while live', () => {
  const segments = timelineSegments({ final: false, covered: 300, topics: [{ start: 0, title: 'a' }, { start: 120, title: 'b' }] })
  assert.equal(segments[1].current, true)
  assert.equal(segments[0].current, false)
})

test('timeline needs at least two topics', () => {
  assert.deepEqual(timelineSegments({ topics: [{ start: 0, title: 'only' }] }), [])
  assert.deepEqual(timelineSegments(null), [])
})

