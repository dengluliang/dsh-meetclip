import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOARD_IMAGE_TYPES,
  STICKY_TEXT_MAX,
  imageFilesFromClipboard,
  isBoardImage,
  looksLikeImageFile,
  stickyFromClipboard,
  stripListMarker
} from '../client-src/lib/paste.js'

test('empty clipboard text creates nothing', () => {
  assert.equal(stickyFromClipboard(''), null)
  assert.equal(stickyFromClipboard('   \n\t\n'), null)
  assert.equal(stickyFromClipboard(null), null)
  assert.equal(stickyFromClipboard(undefined), null)
})

test('plain prose stays a plain note', () => {
  const draft = stickyFromClipboard('  下次直播开场先讲一个问题：\n你上一次翻回去看录播，是为了找什么？  ')
  assert.deepEqual(draft, {
    text: '下次直播开场先讲一个问题：\n你上一次翻回去看录播，是为了找什么？',
    kind: 'note',
    truncated: false
  })
})

test('dash bullets become a todo list', () => {
  const draft = stickyFromClipboard('- 收拾桌面\n- 写周报')
  assert.equal(draft.kind, 'todo')
  assert.equal(draft.text, '- 收拾桌面\n- 写周报')
})

test('checkbox, numbered and circled lines all normalize to "- " items', () => {
  const checkbox = stickyFromClipboard('[ ] 收拾桌面\n[x] 写周报')
  assert.deepEqual(checkbox, { text: '- 收拾桌面\n- 写周报', kind: 'todo', truncated: false })

  const numbered = stickyFromClipboard('1. 收拾桌面\n2、写周报\n3) 复盘')
  assert.equal(numbered.kind, 'todo')
  assert.equal(numbered.text, '- 收拾桌面\n- 写周报\n- 复盘')

  const circled = stickyFromClipboard('① 收拾桌面\n② 写周报')
  assert.equal(circled.text, '- 收拾桌面\n- 写周报')
})

test('a heading above a list stays prose while items become todos', () => {
  const draft = stickyFromClipboard('周末计划\n- 收拾桌面\n• 写周报')
  assert.equal(draft.kind, 'todo')
  assert.equal(draft.text, '周末计划\n- 收拾桌面\n- 写周报')
})

test('decimals, negative numbers and dates are not mistaken for list markers', () => {
  const draft = stickyFromClipboard('-9 度\n2026.11.06 复盘\n1.5 倍速度\n[链接](https://example.com)')
  assert.equal(draft.kind, 'note')
  assert.equal(draft.text, '-9 度\n2026.11.06 复盘\n1.5 倍速度\n[链接](https://example.com)')
})

test('blank lines collapse and are trimmed at both ends', () => {
  const draft = stickyFromClipboard('\n\n第一段\n\n\n\n第二段\n\n')
  assert.equal(draft.text, '第一段\n\n第二段')
})

test('long clipboard text is clipped to the sticky note limit', () => {
  const draft = stickyFromClipboard('字'.repeat(STICKY_TEXT_MAX + 240))
  assert.equal(draft.truncated, true)
  assert.equal(draft.text.length, STICKY_TEXT_MAX)
  assert.equal(draft.kind, 'note')
})

test('stripListMarker only removes real markers', () => {
  assert.equal(stripListMarker('- [x] 写完周报'), '写完周报')
  assert.equal(stripListMarker('  • 重点  '), '重点')
  assert.equal(stripListMarker('普通段落'), null)
  assert.equal(stripListMarker('-9 度'), null)
  assert.equal(stripListMarker(''), null)
})

test('image files are read from files first, then items, without duplicates', () => {
  const png = { type: 'image/png', name: 'shot.png' }
  const gif = { type: 'image/gif', name: 'anim.gif' }
  const heic = { type: 'image/heic', name: 'IMG_0001.HEIC' }
  const clipboard = {
    files: [png],
    items: [
      { kind: 'file', type: 'image/png', getAsFile: () => png },
      { kind: 'file', type: 'image/gif', getAsFile: () => gif },
      { kind: 'file', type: 'image/heic', getAsFile: () => heic },
      { kind: 'string', type: 'text/plain', getAsFile: () => null }
    ]
  }
  assert.deepEqual(imageFilesFromClipboard(clipboard), [png, gif, heic])
  assert.deepEqual(imageFilesFromClipboard({ files: [], items: [] }), [])
  assert.deepEqual(imageFilesFromClipboard(null), [])
})

test('HEIC files are recognized even when the browser reports no MIME', () => {
  const unknown = { type: '', name: 'IMG_1234.HEIC' }
  assert.deepEqual(imageFilesFromClipboard({ files: [unknown], items: [] }), [unknown])
  assert.equal(looksLikeImageFile(unknown), true)
  assert.equal(looksLikeImageFile({ type: 'image/webp', name: '' }), true)
  assert.equal(looksLikeImageFile({ type: '', name: 'clip.pdf' }), false)
})

test('supported board image formats match the backend whitelist', () => {
  assert.deepEqual(BOARD_IMAGE_TYPES, [
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'
  ])
  assert.equal(isBoardImage('image/png'), true)
  assert.equal(isBoardImage('IMAGE/JPEG'), true)
  assert.equal(isBoardImage('image/heic'), true)
  assert.equal(isBoardImage('image/heif'), true)
  assert.equal(isBoardImage('', 'IMG_0001.HEIC'), true)
  assert.equal(isBoardImage('', 'photo.heif'), true)
  assert.equal(isBoardImage('image/bmp'), false)
  assert.equal(isBoardImage('', 'notes.txt'), false)
  assert.equal(isBoardImage(''), false)
})
