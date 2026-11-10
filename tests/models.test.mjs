import test from 'node:test'
import assert from 'node:assert/strict'
import { modelOptions, sortModels, splitModels } from '../client-src/lib/models.js'

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
