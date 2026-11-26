import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIPBOARD_IMAGE_TYPE,
  clipboardImageBlob,
  copyImageFromUrl,
  copyImageToClipboard,
  mimeOf,
  needsPngRewrite,
  pngBlobFromImage
} from '../client-src/lib/clipboard-image.js'

class FakeItem {
  constructor(data) {
    this.data = data
    this.types = Object.keys(data)
  }

  async blob(type) {
    return this.data[type]
  }
}

function jpegBlob() {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' })
}

function pngBlob() {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
}

function recorder() {
  const drawn = []
  const closed = []
  const decode = async (blob) => {
    drawn.push({ decoded: blob.type })
    return {
      source: { kind: 'bitmap', type: blob.type },
      width: 1920,
      height: 1080,
      close: () => closed.push(true)
    }
  }
  const createCanvas = (width, height) => ({
    width,
    height,
    getContext: () => ({ drawImage: (source) => drawn.push({ drawn: source.type }) }),
    toBlob: (callback, type) => callback(new Blob(['png-bytes'], { type }))
  })
  return { drawn, closed, decode, createCanvas }
}

function clipboardRecorder() {
  const items = []
  return { items, clipboard: { write: async (written) => { items.push(...written) } } }
}

test('mimeOf strips parameters and lowercases', () => {
  assert.equal(mimeOf('image/JPEG; charset=binary'), 'image/jpeg')
  assert.equal(mimeOf(undefined), '')
  assert.equal(mimeOf('image/png'), CLIPBOARD_IMAGE_TYPE)
})

test('only PNG goes to the clipboard as-is', () => {
  assert.equal(needsPngRewrite('image/png'), false)
  assert.equal(needsPngRewrite('IMAGE/PNG'), false)
  assert.equal(needsPngRewrite('image/jpeg'), true)
  assert.equal(needsPngRewrite('image/webp'), true)
  assert.equal(needsPngRewrite(''), true)
  assert.equal(needsPngRewrite(undefined), true)
})

test('PNG blobs are not re-encoded', async () => {
  const blob = pngBlob()
  const converted = await clipboardImageBlob(blob, {
    decode: () => { throw new Error('decode must not run for PNG') },
    createCanvas: () => { throw new Error('canvas must not run for PNG') }
  })
  assert.equal(converted, blob)
})

test('JPEG screenshots are decoded and re-encoded as PNG', async () => {
  const { drawn, closed, decode, createCanvas } = recorder()
  const converted = await pngBlobFromImage(jpegBlob(), { decode, createCanvas })
  assert.equal(converted.type, CLIPBOARD_IMAGE_TYPE)
  assert.equal(await converted.text(), 'png-bytes')
  assert.deepEqual(drawn, [
    { decoded: 'image/jpeg' },
    { drawn: 'image/jpeg' }
  ])
  assert.equal(closed.length, 1, 'bitmap should be released')
})

test('copyImageToClipboard writes a single PNG clipboard item', async () => {
  const { drawn, decode, createCanvas } = recorder()
  const { items, clipboard } = clipboardRecorder()
  await copyImageToClipboard(jpegBlob(), { clipboard, ClipboardItem: FakeItem, decode, createCanvas })
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].types, [CLIPBOARD_IMAGE_TYPE])
  const written = await items[0].blob(CLIPBOARD_IMAGE_TYPE)
  assert.equal(written.type, CLIPBOARD_IMAGE_TYPE)
  assert.equal(await written.text(), 'png-bytes')
  assert.equal(drawn.length, 2)
})

test('copyImageToClipboard passes PNG through untouched', async () => {
  const { items, clipboard } = clipboardRecorder()
  const blob = pngBlob()
  await copyImageToClipboard(blob, {
    clipboard,
    ClipboardItem: FakeItem,
    decode: () => { throw new Error('decode must not run for PNG') }
  })
  assert.equal(await items[0].blob(CLIPBOARD_IMAGE_TYPE), blob)
})

test('missing clipboard API reports a friendly message', async () => {
  await assert.rejects(
    () => copyImageToClipboard(pngBlob(), { clipboard: null, ClipboardItem: undefined }),
    (failure) => failure.message === '当前浏览器不支持复制图片'
  )
  await assert.rejects(
    () => copyImageToClipboard(pngBlob(), { clipboard: { writeText: async () => {} }, ClipboardItem: FakeItem }),
    (failure) => failure.message === '当前浏览器不支持复制图片'
  )
})

test('clipboard write rejections become readable messages', async () => {
  const notSupported = Object.assign(new Error("Failed to execute 'write' on 'Clipboard': Type image/jpeg not supported on write."), { name: 'NotSupportedError' })
  await assert.rejects(
    () => copyImageToClipboard(pngBlob(), {
      clipboard: { write: async () => { throw notSupported } },
      ClipboardItem: FakeItem
    }),
    (failure) => {
      assert.match(failure.message, /不支持复制图片/)
      assert.equal(failure.cause, notSupported)
      return true
    }
  )

  // 真 Chrome 抛的是 NotAllowedError + 同一句文案，名字不可靠，按文案判。
  const misnamed = Object.assign(new Error("Failed to execute 'write' on 'Clipboard': Type image/jpeg not supported on write."), { name: 'NotAllowedError' })
  await assert.rejects(
    () => copyImageToClipboard(pngBlob(), {
      clipboard: { write: async () => { throw misnamed } },
      ClipboardItem: FakeItem
    }),
    (failure) => failure.message === '当前浏览器不支持复制图片，可改用「下载图片」'
  )

  const denied = Object.assign(new Error('Document is not focused.'), { name: 'NotAllowedError' })
  await assert.rejects(
    () => copyImageToClipboard(pngBlob(), {
      clipboard: { write: async () => { throw denied } },
      ClipboardItem: FakeItem
    }),
    (failure) => failure.message === '剪贴板被拒绝写入，请点一下页面再复制'
  )
})

test('a broken JPEG falls back to a message that points at 下载图片', async () => {
  await assert.rejects(
    () => clipboardImageBlob(jpegBlob(), {
      decode: async () => { throw new Error('截图解码失败') },
      createCanvas: () => null
    }),
    (failure) => failure.message === '截图转码失败，可改用「下载图片」'
  )
})

test('a browser without canvas keeps the unsupported message', async () => {
  await assert.rejects(
    () => clipboardImageBlob(jpegBlob(), {
      decode: async () => ({ source: {}, width: 4, height: 4, close() {} }),
      createCanvas: () => null
    }),
    (failure) => {
      assert.equal(failure.code, 'clipboard_unsupported')
      assert.equal(failure.message, '当前浏览器不支持复制图片')
      return true
    }
  )
})

test('node without canvas degrades to the unsupported message', async () => {
  await assert.rejects(
    () => copyImageToClipboard(jpegBlob(), {
      clipboard: { write: async () => {} },
      ClipboardItem: FakeItem
    }),
    (failure) => failure.message === '当前浏览器不支持复制图片'
  )
})

test('copyImageFromUrl reads the shot with same-origin credentials', async () => {
  const { decode, createCanvas } = recorder()
  const { items, clipboard } = clipboardRecorder()
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, blob: async () => jpegBlob() }
  }
  await copyImageFromUrl('/meetclip/api/files/s1/shots/a.jpg', {
    fetch: fetchImpl, clipboard, ClipboardItem: FakeItem, decode, createCanvas
  })
  assert.deepEqual(calls, [
    { url: '/meetclip/api/files/s1/shots/a.jpg', options: { credentials: 'same-origin' } }
  ])
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].types, [CLIPBOARD_IMAGE_TYPE])
})

test('copyImageFromUrl reports missing files instead of throwing a DOM error', async () => {
  await assert.rejects(
    () => copyImageFromUrl('/meetclip/api/files/s1/shots/missing.jpg', {
      fetch: async () => ({ ok: false, status: 404 }),
      clipboard: { write: async () => {} },
      ClipboardItem: FakeItem
    }),
    (failure) => failure.message === '读取截图失败'
  )
  await assert.rejects(
    () => copyImageFromUrl('/meetclip/api/files/s1/shots/a.jpg', {
      fetch: async () => { throw new TypeError('Failed to fetch') },
      clipboard: { write: async () => {} },
      ClipboardItem: FakeItem
    }),
    (failure) => failure.message === '读取截图失败'
  )
  await assert.rejects(
    () => copyImageFromUrl(''),
    (failure) => failure.message === '没有可复制的截图'
  )
})
