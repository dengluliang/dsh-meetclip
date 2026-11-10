import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTools } from '../src/host/tools.js'

const minutesPayload = {
  ok: true,
  scenario: 'meeting',
  title: '预算评审',
  summary: '确认了预算缺口。',
  state: 'idle',
  final: true,
  covered: 300,
  topics: [],
  conclusions: [],
  todos: [
    { text: '补一份预算表', owner: '发言人 1', t: 30, support: 1 },
    { text: '确认采购清单', owner: '发言人 2', t: 40, support: 1 }
  ],
  terms: [],
  interactions: {
    todos: {
      '补一份预算表': { done: true, text: '补一份预算表', at: 1793000300 }
    },
    highlights: [{
      id: 'h1',
      quote: '预算缺口还有二十万',
      section: 'topics',
      topic: '预算缺口',
      t: 5,
      at: 1793000301
    }],
    updated_at: 1793000301,
    version: 1
  }
}

function setup(payload = minutesPayload) {
  const definitions = []
  const ctx = {
    get: (name) => (name === 'tools'
      ? { register: (definition) => { definitions.push(definition); return () => {} } }
      : undefined),
    effect: (callback) => callback()
  }
  const runtime = {
    settings: { tools: true },
    backend: {
      json: async (pathname) => {
        if (pathname.includes('/minutes')) return payload
        throw new Error(`unexpected path ${pathname}`)
      }
    }
  }
  registerTools(ctx, runtime)
  const tool = definitions.find((definition) => definition.name === 'meetclip_minutes')
  assert.ok(tool, 'meetclip_minutes should be registered')
  return tool
}

test('meetclip_minutes get marks user-checked todos and lists highlights', async () => {
  const tool = setup()
  const result = await tool.execute({ action: 'get', session_id: 's1' }, {})
  const checked = result.todos.find((item) => item.text === '补一份预算表')
  const unchecked = result.todos.find((item) => item.text === '确认采购清单')
  assert.equal(checked.done, true)
  assert.equal(unchecked.done, false)
  assert.equal(result.user_interactions.counts.todos, 1)
  assert.equal(result.user_interactions.counts.highlights, 1)
  assert.equal(result.user_interactions.checked_todos[0].text, '补一份预算表')
  assert.equal(result.user_interactions.highlights[0].quote, '预算缺口还有二十万')
  assert.equal(result.user_interactions.highlights[0].topic, '预算缺口')
  assert.equal(result.user_interactions.highlights[0].t, 5)
})

test('meetclip_minutes get tolerates a payload without interactions', async () => {
  const tool = setup({ ...minutesPayload, interactions: undefined })
  const result = await tool.execute({ action: 'get', session_id: 's1' }, {})
  assert.equal(result.todos.every((item) => item.done === false), true)
  assert.deepEqual(result.user_interactions.counts, { todos: 0, highlights: 0 })
})
