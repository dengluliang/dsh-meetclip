import test from 'node:test'
import assert from 'node:assert/strict'
import { qualifyModel } from '../src/host/models-probe.js'
import { candidateOrder, modelOptions, sortModels, splitModels, vendorOf } from '../client-src/lib/models.js'

test('splits gateway models into speech and text', () => {
  const { asr, text } = splitModels([
    'mimo-v2.5-asr',
    'ASR_NonStreaming',
    'gpt-transcribe',
    'whisper',
    'mimo-v2.5-tts',
    'mimo-v2.5-tts-voiceclone',
    'text-embedding-3-small',
    'bge-reranker-v2-m3',
    'PaddleOCR-VL-0.9B',
    'gpt-4o',
    'mimo-v2.6-flash',
    'gpt-image-2'
  ])
  assert.deepEqual(asr, ['mimo-v2.5-asr', 'ASR_NonStreaming', 'gpt-transcribe', 'whisper'])
  assert.deepEqual(text, ['gpt-4o', 'mimo-v2.6-flash'])
})

test('dedupes, trims and drops batch aliases', () => {
  const { asr, text } = splitModels([' gpt-4o ', 'gpt-4o', '', 'x:batch', 'mimo-v2.5-asr'])
  assert.deepEqual(text, ['gpt-4o'])
  assert.deepEqual(asr, ['mimo-v2.5-asr'])
})

test('current model stays first even when absent from the catalog', () => {
  const options = modelOptions(['demo-asr', 'gpt-4o'], 'vendor/demo-text')
  assert.equal(options[0].value, 'vendor/demo-text')
  assert.match(options[0].label, /当前/)
  assert.deepEqual(options.slice(1).map((item) => item.value), ['demo-asr', 'gpt-4o'])
})

test('sorts the configured provider family ahead of others', () => {
  // 族名来自当前配置，而不是源码里写死的厂商前缀。
  assert.deepEqual(sortModels(['gpt-4o', 'deepseek-v4-flash', 'demo-1.2-flash'], 'demo-2.0'), [
    'demo-1.2-flash', 'deepseek-v4-flash', 'gpt-4o'
  ])
  assert.deepEqual(sortModels(['gpt-4o', 'demo-1.2-flash'], 'vendor/demo-text'), [
    'demo-1.2-flash', 'gpt-4o'
  ])
  const options = modelOptions(['gpt-4o', 'mimo-v2.6-flash'], 'gpt-4o')
  assert.deepEqual(options.map((item) => item.value), ['gpt-4o', 'mimo-v2.6-flash'])
})

test('qualifyModel 按 owned_by 补供应商前缀', () => {
  assert.equal(qualifyModel('mimo-v2.5-asr', 'xiaomi'), 'xiaomi/mimo-v2.5-asr')
  assert.equal(qualifyModel('deepseek-v4-flash', 'volcengine_maas'), 'volcengine_maas/deepseek-v4-flash')
})

test('qualifyModel 不重复拼接已带供应商的名字', () => {
  assert.equal(qualifyModel('anthropic/claude-sonnet-5-5', 'ppio'), 'anthropic/claude-sonnet-5-5')
  assert.equal(qualifyModel('xiaomi/mimo-v2.6-flash', 'xiaomi'), 'xiaomi/mimo-v2.6-flash')
})

test('qualifyModel 没有供应商时保持裸名', () => {
  assert.equal(qualifyModel('gpt-4o', ''), 'gpt-4o')
  assert.equal(qualifyModel('', 'xiaomi'), '')
})

test('vendorOf 取模型名的供应商段', () => {
  assert.equal(vendorOf('xiaomi/mimo-v2.5-asr'), 'xiaomi')
  assert.equal(vendorOf('mimo-v2.5-asr'), '')
})

test('带前缀的模型也能正确分到语音与文字', () => {
  const { asr, text } = splitModels([
    'xiaomi/mimo-v2.5-asr',
    'xiaomi/mimo-v2.5-tts',
    'xiaomi/mimo-v2.6-flash',
    'deepseek/deepseek-v4-flash',
    'openai/gpt-4o',
    'openai/text-embedding-3-large'
  ])
  assert.deepEqual(asr, ['xiaomi/mimo-v2.5-asr'])
  assert.deepEqual(text, ['xiaomi/mimo-v2.6-flash', 'deepseek/deepseek-v4-flash', 'openai/gpt-4o'])
})

test('candidateOrder 当前选择最先，其次同供应商，最后其余', () => {
  const order = candidateOrder(
    ['deepseek/deepseek-v4-flash', 'xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash', 'openai/gpt-4o'],
    { current: 'xiaomi/mimo-v2.6-flash', vendor: 'xiaomi' }
  )
  assert.deepEqual(order, [
    'xiaomi/mimo-v2.6-flash',
    'xiaomi/mimo-v2.6-pro',
    'deepseek/deepseek-v4-flash',
    'openai/gpt-4o'
  ])
})

test('candidateOrder 没有当前选择时按供应商聚拢，不丢模型', () => {
  assert.deepEqual(candidateOrder(['a/one', 'b/two', 'c/three'], { vendor: 'c' }),
    ['c/three', 'a/one', 'b/two'])
  assert.deepEqual(candidateOrder([], {}), [])
  assert.deepEqual(candidateOrder(['m', 'm'], {}), ['m'])
})
