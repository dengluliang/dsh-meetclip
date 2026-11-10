// 会议音视频批量导入的前端纯模型：文件识别、去重、标题与提交载荷。
// 这里不碰 React/DOM，便于 node:test 直接验证边界。
// 扩展名白名单需与 src/host/files.js 的 MEDIA_EXTENSIONS 和
// backend/app/routes/sessions.py 的 IMPORT_RE 保持一致。
export const MAX_MEETING_FILES = 20

export const MEDIA_EXTENSIONS = [
  'mp4', 'mov', 'mkv', 'flv', 'webm', 'm4v', 'ts',
  'mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus'
]

const MEDIA_SET = new Set(MEDIA_EXTENSIONS)
const VIDEO_SET = new Set(['mp4', 'mov', 'mkv', 'flv', 'webm', 'm4v', 'ts'])

export function baseName(name) {
  return String(name || '').split(/[\\/]/).pop() || ''
}

export function mediaExtension(name) {
  const base = baseName(name)
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

export function isMediaName(name) {
  return MEDIA_SET.has(mediaExtension(name))
}

export function mediaKind(name) {
  const extension = mediaExtension(name)
  if (VIDEO_SET.has(extension)) return 'video'
  if (MEDIA_SET.has(extension)) return 'audio'
  return ''
}

export function isVideoName(name) {
  return mediaKind(name) === 'video'
}

export function titleFromName(name) {
  const base = baseName(name)
  const index = base.lastIndexOf('.')
  // 以点开头的隐藏文件没有扩展名，不要整个删光。
  const title = (index > 0 ? base.slice(0, index) : base).trim()
  return title || '未命名会议'
}

export function defaultPackTitle(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `会议录音 · ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fileFromPath(value, index = 0) {
  const path = String(value || '').trim()
  return {
    key: `path:${path}:${index}`,
    path,
    name: baseName(path) || path,
    bytes: 0,
    status: 'ready',
    progress: 0,
    error: ''
  }
}

export function filesFromPaths(paths) {
  return (Array.isArray(paths) ? paths : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value, index) => fileFromPath(value, index))
}

function sameFile(a, b) {
  if (!a || !b) return false
  if (a.path && b.path) return String(a.path) === String(b.path)
  const name = String(a.name || '')
  if (!name || name !== String(b.name || '')) return false
  return Number(a.bytes || 0) === Number(b.bytes || 0)
}

/**
 * 把新文件并入现有列表：按路径或 name+bytes 去重、过滤不支持的扩展名、
 * 截断到 MAX_MEETING_FILES。返回完整的下一版列表与统计信息。
 */
export function mergeMeetingFiles(current, incoming, limit = MAX_MEETING_FILES) {
  const rows = Array.isArray(current) ? [...current] : []
  const rejected = []
  let duplicates = 0
  let overflow = 0
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!item || !isMediaName(item.name)) {
      rejected.push(String(item?.name || '未知文件'))
      continue
    }
    if (rows.some((row) => sameFile(row, item))) {
      duplicates += 1
      continue
    }
    if (rows.length >= limit) {
      overflow += 1
      continue
    }
    rows.push(item)
  }
  return { files: rows, rejected, duplicates, overflow }
}

export function singleImportBody(file, { title = '', language = '' } = {}) {
  return {
    path: String(file?.path || ''),
    title: String(title || '').trim() || titleFromName(file?.name),
    language: String(language || '')
  }
}

export function batchImportBody(files, { language = '', packTitle = '' } = {}) {
  return {
    items: (Array.isArray(files) ? files : [])
      .filter((file) => file?.path)
      .map((file) => ({
        path: String(file.path),
        title: titleFromName(file.name)
      })),
    language: String(language || ''),
    pack_title: String(packTitle || '').trim()
  }
}
