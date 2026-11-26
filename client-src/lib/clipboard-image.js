// 把截图送进系统剪贴板。
//
// 截图是 JPEG 落盘的（backend/app/capture.py 写 shots/*.jpg，/api/files 也按
// image/jpeg 返回），而 Chromium 的异步剪贴板只接受 image/png（另加 text/plain、
// text/html）：
//   Failed to execute 'write' on 'Clipboard': Type image/jpeg not supported on write.
// 所以写入前先解码成位图，再用 canvas 重新编码成 PNG。分辨率原样保留，只换容器，
// 粘到飞书/微信/其他文档里得到的是同一张图，不是未解码的字节。

export const CLIPBOARD_IMAGE_TYPE = 'image/png'

const CLIPBOARD_IMAGE_TYPES = new Set([CLIPBOARD_IMAGE_TYPE])

export function mimeOf(value) {
  return String(value || '').toLowerCase().split(';')[0].trim()
}

/** 剪贴板只认 PNG：JPEG / WebP / GIF 都要先转码。 */
export function needsPngRewrite(type) {
  return !CLIPBOARD_IMAGE_TYPES.has(mimeOf(type))
}

function unsupported(message = '当前浏览器不支持复制图片') {
  const error = new Error(message)
  error.code = 'clipboard_unsupported'
  return error
}

function documentCanvas(width, height) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  const canvas = document.createElement('canvas')
  if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.toBlob !== 'function') return null
  canvas.width = width
  canvas.height = height
  return canvas
}

async function decodeWithImage(blob) {
  if (typeof Image !== 'function' || typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function') {
    throw unsupported()
  }
  const url = URL.createObjectURL(blob)
  const image = new Image()
  try {
    await new Promise((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('截图解码失败'))
      image.src = url
    })
  } catch (failure) {
    URL.revokeObjectURL(url)
    throw failure
  }
  return {
    source: image,
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
    close: () => URL.revokeObjectURL(url)
  }
}

async function decodeBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close?.()
      }
    } catch {
      // createImageBitmap 不认的格式（少数 HEIC/AVIF）退回 <img>，能解就还能复制。
    }
  }
  return decodeWithImage(blob)
}

/** 任意图片 blob -> PNG blob。测试可以注入 decode / createCanvas。 */
export async function pngBlobFromImage(blob, deps = {}) {
  const decode = deps.decode || decodeBitmap
  const makeCanvas = deps.createCanvas || documentCanvas
  const decoded = await decode(blob)
  try {
    if (!decoded?.width || !decoded?.height) throw new Error('截图解码失败')
    const canvas = makeCanvas(decoded.width, decoded.height)
    if (!canvas) throw unsupported()
    const context = canvas.getContext('2d')
    if (!context) throw unsupported()
    context.drawImage(decoded.source, 0, 0)
    return await new Promise((resolve, reject) => {
      canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('截图转码失败'))), CLIPBOARD_IMAGE_TYPE)
    })
  } finally {
    decoded.close?.()
  }
}

/** 要写进剪贴板的那份数据：本来就是 PNG 就原样用，其它格式转码。 */
export async function clipboardImageBlob(blob, deps = {}) {
  if (!blob) throw new Error('没有可复制的截图')
  if (!needsPngRewrite(blob.type)) return blob
  try {
    return await pngBlobFromImage(blob, deps)
  } catch (failure) {
    if (failure?.code === 'clipboard_unsupported') throw failure
    throw new Error('截图转码失败，可改用「下载图片」', { cause: failure })
  }
}

function clipboardWriteError(failure) {
  const name = String(failure?.name || '')
  const message = String(failure?.message || '')
  // 格式不支持时 Chrome 也会抛 NotAllowedError，名字不可靠，先看文案。
  if (/not supported on write/i.test(message)) {
    return new Error('当前浏览器不支持复制图片，可改用「下载图片」', { cause: failure })
  }
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotSupportedError') {
    return new Error('剪贴板被拒绝写入，请点一下页面再复制', { cause: failure })
  }
  return new Error('复制截图失败', { cause: failure })
}

/** 复制一张图片 blob；options 里的 clipboard / ClipboardItem / decode 供测试替换。 */
export async function copyImageToClipboard(blob, options = {}) {
  const clipboard = options.clipboard || globalThis.navigator?.clipboard
  const Item = options.ClipboardItem || globalThis.ClipboardItem
  if (!clipboard || typeof clipboard.write !== 'function' || typeof Item !== 'function') {
    throw unsupported()
  }
  const png = await clipboardImageBlob(blob, options)
  try {
    await clipboard.write([new Item({ [CLIPBOARD_IMAGE_TYPE]: png })])
  } catch (failure) {
    throw clipboardWriteError(failure)
  }
}

/** 读同源截图再复制；右键菜单和灯箱里的「复制图片」都走这里。 */
export async function copyImageFromUrl(url, options = {}) {
  if (!url) throw new Error('没有可复制的截图')
  const fetchImpl = options.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw unsupported()
  let response
  try {
    response = await fetchImpl(url, { credentials: 'same-origin' })
  } catch (failure) {
    throw new Error('读取截图失败', { cause: failure })
  }
  if (!response || response.ok === false) throw new Error('读取截图失败')
  const blob = await response.blob()
  await copyImageToClipboard(blob, options)
}
