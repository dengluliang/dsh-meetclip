import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePickedPaths, pickerScript, revealPath } from '../src/host/files.js'

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

test('备份文件选择框不过滤 UTI，也不允许多选', () => {
  const script = pickerScript('backup', false)
  assert.match(script, /choose file/)
  assert.match(script, /选择会摘备份文件/)
  assert.doesNotMatch(script, /of type/)
  assert.doesNotMatch(script, /multiple selections allowed/)
})

test('revealPath 只接受绝对且存在的路径', async () => {
  assert.equal((await revealPath('')).ok, false)
  assert.equal((await revealPath('relative/path.zip')).ok, false)
  const missing = await revealPath('/tmp/meetclip-no-such-backup-file.zip')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在/)
})
