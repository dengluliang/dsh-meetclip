import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePickedPaths, pickerScript } from '../src/host/files.js'

test('媒体单选不再按 UTI 过滤视频容器', () => {
  const script = pickerScript('media', false)
  assert.match(script, /choose file/)
  assert.doesNotMatch(script, /of type/)
  assert.doesNotMatch(script, /multiple selections allowed/)
})

test('媒体多选开启 multiple selections allowed 且仍不过滤 UTI', () => {
  const script = pickerScript('media', true)
  assert.match(script, /with multiple selections allowed/)
  assert.match(script, /character id 31/)
  assert.doesNotMatch(script, /of type/)
  assert.doesNotMatch(script, /public\.movie|public\.audio/)
})

test('目录选择保持原来的单目录脚本', () => {
  const script = pickerScript('directory', true)
  assert.match(script, /choose folder/)
  assert.doesNotMatch(script, /choose file|multiple selections allowed/)
})

test('解析单选路径', () => {
  assert.deepEqual(parsePickedPaths('/Users/me/Movies/会议录像.mp4\n'), ['/Users/me/Movies/会议录像.mp4'])
})

test('解析多选路径：空格、中文、逗号都保留，空项跳过', () => {
  const stdout = [
    '/Users/me/Movies/产品评审 第 1 场.mp4',
    '/Users/me/Movies/产品评审，第 2 场.mkv',
    '/Users/me/Movies/产品评审 第 3 场.flv'
  ].join('\u001f') + '\n'
  assert.deepEqual(parsePickedPaths(stdout), [
    '/Users/me/Movies/产品评审 第 1 场.mp4',
    '/Users/me/Movies/产品评审，第 2 场.mkv',
    '/Users/me/Movies/产品评审 第 3 场.flv'
  ])
  assert.deepEqual(parsePickedPaths('\n\u001f\n'), [])
  assert.deepEqual(parsePickedPaths(''), [])
})
