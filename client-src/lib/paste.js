// 主界面 ⌘V：把剪贴板内容变成散落画板上的卡片。
// 图片 -> 图片卡（走 board images 上传流程）；文字 -> 便利签，列表型文字自动转待办。
// 这里只做剪贴板内容的纯判定，焦点/弹层归属由 HomePage 判断。

export const STICKY_TEXT_MAX = 5000
// HEIC/HEIF 由后端转成 JPEG 后再存成图片卡；浏览器拖动时 MIME 可能为空，所以也认扩展名。
export const BOARD_IMAGE_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'
]
const BOARD_IMAGE_EXT = /\.(?:png|jpe?g|webp|gif|heic|heif|hif)$/i
const HEIF_EXT = /\.(?:heic|heif|hif)$/i

// 行首标记：- * • ·、[ ]/[x] 勾选框、1. / 1、/ 1)、①、□/☐/✓/✔。
const BULLET = /^[-*•·]\s+/
const LOOSE_BULLET = /^[•·]\s*/
const CHECKBOX = /^\[\s?[xX]?\s?\](?:\s+|$)/
const NUMBERED = /^\d{1,3}(?:[.．](?!\d)|[、)）])\s*/
const CIRCLED = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*/
const CHECK_MARK = /^[□☐✓✔]\s*/

function stripOne(value) {
  for (const pattern of [BULLET, LOOSE_BULLET, CHECKBOX, NUMBERED, CIRCLED, CHECK_MARK]) {
    if (pattern.test(value)) return value.replace(pattern, '')
  }
  return null
}

/** 去掉行首列表标记；不是列表行返回 null，普通段落保持原样。 */
export function stripListMarker(line) {
  let value = String(line ?? '').trim()
  if (!value) return null
  let changed = false
  // "- [x] 写完周报" 这类复合标记需要剥两层。
  for (let pass = 0; pass < 2; pass += 1) {
    const next = stripOne(value)
    if (next === null) break
    value = next
    changed = true
  }
  return changed ? value.trim() : null
}

function tidyLines(lines) {
  const out = []
  for (const line of lines) {
    const blank = !String(line).trim()
    if (blank && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(blank ? '' : String(line).replace(/\s+$/, ''))
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

/**
 * 把剪贴板文字整理成便利签内容。
 * 任意一行带列表标记就整体按清单处理：标记行改写成 “- 条目”，
 * 普通行（标题、说明）原样保留，这样一张卡里可以既有说明又有勾选项。
 * @returns {{ text: string, kind: 'note'|'todo', truncated: boolean } | null}
 */
export function stickyFromClipboard(raw) {
  const source = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
  if (!source.trim()) return null
  const lines = []
  let items = 0
  for (const line of source.split('\n')) {
    const body = stripListMarker(line)
    if (body === null) {
      lines.push(line.replace(/\s+$/, ''))
      continue
    }
    if (!body.trim()) continue
    lines.push(`- ${body.trim()}`)
    items += 1
  }
  const text = tidyLines(lines).join('\n').trim()
  if (!text) return null
  const truncated = text.length > STICKY_TEXT_MAX
  const clipped = truncated ? text.slice(0, STICKY_TEXT_MAX).replace(/\s+$/, '') : text
  return { text: clipped, kind: items > 0 ? 'todo' : 'note', truncated }
}

export function isBoardImage(type, name = '') {
  const mime = String(type || '').toLowerCase()
  if (BOARD_IMAGE_TYPES.includes(mime)) return true
  return BOARD_IMAGE_EXT.test(String(name || ''))
}

/** 图片文件判定：MIME 优先；Chrome 拖动 .heic 时 MIME 可能为空，用扩展名兜住。 */
export function looksLikeImageFile(file) {
  const mime = String(file?.type || '').toLowerCase()
  if (mime.startsWith('image/')) return true
  return HEIF_EXT.test(String(file?.name || ''))
}

/** 从 paste 事件的 clipboardData 里取图片文件；files 和 items 两条路都兜住。 */
export function imageFilesFromClipboard(clipboard) {
  const out = []
  const seen = new Set()
  const push = (file) => {
    if (!file || seen.has(file)) return
    if (!looksLikeImageFile(file)) return
    seen.add(file)
    out.push(file)
  }
  const files = clipboard?.files
  if (files) for (const file of Array.from(files)) push(file)
  const items = clipboard?.items
  if (items) {
    for (const item of Array.from(items)) {
      if (item?.kind !== 'file') continue
      try {
        push(typeof item.getAsFile === 'function' ? item.getAsFile() : null)
      } catch {
        // 某些 WebView 的 DataTransferItem 不可读，忽略即可。
      }
    }
  }
  return out
}
