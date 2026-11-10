import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../src/host/config.js'
import { BackendManager } from '../src/host/backend.js'

test('aiBaseUrl 默认空，部署配置只做去尾斜杠', () => {
  assert.equal(normalizeConfig({}).aiBaseUrl, '')
  assert.equal(normalizeConfig({ aiBaseUrl: '  https://gateway.example.com/v1/  ' }).aiBaseUrl,
    'https://gateway.example.com/v1')
  assert.equal(normalizeConfig({ aiBaseUrl: 42 }).aiBaseUrl, '')
})

test('配置了 aiBaseUrl 时后端带上模型服务地址环境变量', () => {
  const settings = normalizeConfig({
    aiBaseUrl: 'https://gateway.example.com/v1',
    stateDir: '/tmp/meetclip-ai-config-test',
    dataDir: '/tmp/meetclip-ai-config-test/data'
  })
  const manager = new BackendManager({ ...settings, sharedDir: '' })
  const env = manager.buildEnv()
  assert.equal(env.MEETCLIP_AI_BASE_URL, 'https://gateway.example.com/v1')
  assert.equal(env.MEETCLIP_ASR_BASE_URL, 'https://gateway.example.com/v1')
})

test('没有配置 aiBaseUrl 时不注入地址，保持公共包去敏', () => {
  const settings = normalizeConfig({ stateDir: '/tmp/meetclip-ai-config-test' })
  const manager = new BackendManager({ ...settings, sharedDir: '' })
  const env = manager.buildEnv()
  assert.equal(env.MEETCLIP_AI_BASE_URL, undefined)
  assert.equal(env.MEETCLIP_ASR_BASE_URL, undefined)
})
