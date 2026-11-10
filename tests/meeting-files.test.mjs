import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_MEETING_FILES,
  baseName,
  batchImportBody,
  defaultPackTitle,
  fileFromPath,
  filesFromPaths,
  isMediaName,
  isVideoName,
  mediaExtension,
  mediaKind,
  mergeMeetingFiles,
  singleImportBody,
  titleFromName
} from '../client-src/lib/meetingFiles.js'

function media(name, extra = {}) {
  return { name, path: `/tmp/${name}`, bytes: 1024, ...extra }
}

test('识别音频与视频扩展名', () => {
  for (const name of ['会议.mp4', '会议.MOV', 'a.mkv', 'a.flv', 'a.webm', 'a.m4v', 'a.ts']) {
    assert.equal(isMediaName(name), true, name)
    assert.equal(isVideoName(name), true, name)
    assert.equal(mediaKind(name), 'video', name)
  }
  for (const name of ['a.mp3', 'a.M4A', 'a.wav', 'a.aac', 'a.flac', 'a.ogg', 'a.opus']) {
    assert.equal(isMediaName(name), true, name)
    assert.equal(isVideoName(name), false, name)
    assert.equal(mediaKind(name), 'audio', name)
  }
  for (const name of ['a.pdf', 'a.png', 'a.txt', 'no-extension']) {
    assert.equal(isMediaName(name), false, name)
    assert.equal(mediaKind(name), '', name)
  }
  assert.equal(mediaExtension('/Users/me/会议录像.MP4'), 'mp4')
  assert.equal(mediaExtension('无扩展名'), '')
})

test('从路径取文件名与默认标题', () => {
  assert.equal(baseName('/Users/me/Movies/产品评审.mkv'), '产品评审.mkv')
  assert.equal(baseName('C:\\Meet\\产品评审.mp4'), '产品评审.mp4')
  assert.equal(titleFromName('产品评审.mkv'), '产品评审')
  assert.equal(titleFromName('产品评审'), '产品评审')
  assert.equal(titleFromName('.hidden'), '.hidden')
  assert.equal(titleFromName(''), '未命名会议')
})

test('默认卡包名带本地时间且可预测', () => {
  const title = defaultPackTitle(new Date(2026, 10, 10, 14, 5))
  assert.equal(title, '会议录音 · 11-10 14:05')
  assert.match(defaultPackTitle(), /^会议录音 · \d\d-\d\d \d\d:\d\d$/)
})

test('filesFromPaths 生成可提交条目，并保留文件名中的空格', () => {
  const files = filesFromPaths(['/tmp/产品评审 第 1 场.mp4', '', '/tmp/会议.m4a'])
  assert.equal(files.length, 2)
  assert.equal(files[0].name, '产品评审 第 1 场.mp4')
  assert.equal(files[0].path, '/tmp/产品评审 第 1 场.mp4')
  assert.equal(files[0].status, 'ready')
  assert.equal(files[1].name, '会议.m4a')
  assert.equal(fileFromPath('/tmp/a.mp4', 3).key, 'path:/tmp/a.mp4:3')
})

test('合并时跳过不支持的扩展名与重复文件', () => {
  const existing = [media('会议.mp4')]
  const result = mergeMeetingFiles(existing, [
    media('会议.mp4'),
    media('会议.mp3'),
    media('说明.pdf'),
    media('没有扩展名')
  ])
  assert.deepEqual(result.files.map((file) => file.name), ['会议.mp4', '会议.mp3'])
  assert.equal(result.duplicates, 1)
  assert.deepEqual(result.rejected, ['说明.pdf', '没有扩展名'])
  assert.equal(result.overflow, 0)
})

test('拖拽上传行没有 path 时按 name+bytes 去重', () => {
  const dropped = { name: '录音.m4a', path: '', bytes: 2048 }
  const first = mergeMeetingFiles([], [dropped])
  const second = mergeMeetingFiles(first.files, [{ name: '录音.m4a', path: '', bytes: 2048 }])
  assert.equal(second.files.length, 1)
  assert.equal(second.duplicates, 1)
  // 上传完成后带 path 的同一行仍视为重复。
  const uploaded = { ...second.files[0], path: '/uploads/abc.m4a' }
  const third = mergeMeetingFiles([uploaded], [{ name: '录音.m4a', path: '', bytes: 2048 }])
  assert.equal(third.files.length, 1)
  assert.equal(third.duplicates, 1)
})

test('超过上限只保留前 20 个并返回 overflow', () => {
  const incoming = Array.from({ length: MAX_MEETING_FILES + 3 }, (_, index) => media(`会议-${index}.mp4`))
  const result = mergeMeetingFiles([], incoming)
  assert.equal(result.files.length, MAX_MEETING_FILES)
  assert.equal(result.overflow, 3)
})

test('批量导入载荷用文件名作为每条记录标题', () => {
  const body = batchImportBody([
    media('产品评审 第 1 场.mp4'),
    { name: '访谈.m4a', path: '/tmp/访谈.m4a' }
  ], { language: 'Chinese', packTitle: '  周会  ' })
  assert.equal(body.language, 'Chinese')
  assert.equal(body.pack_title, '周会')
  assert.deepEqual(body.items, [
    { path: '/tmp/产品评审 第 1 场.mp4', title: '产品评审 第 1 场' },
    { path: '/tmp/访谈.m4a', title: '访谈' }
  ])
})

test('单文件导入载荷保留自定义标题，留空时退回文件名', () => {
  const file = { path: '/tmp/周会.mp4', name: '周会.mp4' }
  assert.deepEqual(singleImportBody(file, { title: '  产品评审  ', language: 'Chinese' }), {
    path: '/tmp/周会.mp4', title: '产品评审', language: 'Chinese'
  })
  assert.equal(singleImportBody(file).title, '周会')
  assert.equal(singleImportBody({ name: '会议.mkv' }).title, '会议')
})
