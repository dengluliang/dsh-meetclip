// 链接解析：首页粘贴与视频批量表单共用。
// 平台域名与 backend/app/link_video.py 的 PLATFORMS 保持一致；只做入口层过滤，
// 真正的可达性、时长、字幕仍由后端预读/准备阶段判断。

export const MAX_BATCH_LINKS = 50

export const PLATFORMS = {
  bilibili: { domains: ['bilibili.com', 'b23.tv'], label: 'B站' },
  weibo: { domains: ['weibo.com', 'weibo.cn'], label: '微博' },
  douyin: { domains: ['douyin.com', 'iesdouyin.com'], label: '抖音' },
  youtube: { domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], label: 'YouTube' },
  x: { domains: ['x.com', 'twitter.com'], label: 'X' }
}

const LIVE_DOMAINS = ['live.bilibili.com', 'live.douyu.com', 'live.huya.com', 'live.kuaishou.com']
// URL 在引号、空白、括号、中文标点处截断；尾部再清一次常见包裹字符。
const URL_RE = /https?:\/\/[^\s"'<>()[\]{}（）【】《》〈〉「」『』，。；：！？、]+/gi
const TRAILING_RE = /[)"'“”‘’>\],.;:!?，。；：！？、]+$/
const LEADING_RE = /^[("'“”‘’<[\]{]+/

const PLATFORM_LABELS = Object.fromEntries(
  Object.entries(PLATFORMS).map(([id, value]) => [id, value.label])
)

export function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || platform || ''
}

/** 把跳过类别拼成一行短文案；不展开具体链接。 */
export function skipSummary(skipped = {}, liveCount = 0) {
  const parts = []
  if (skipped.unsupported) parts.push(`不支持 ${skipped.unsupported}`)
  if (skipped.invalid) parts.push(`格式错误 ${skipped.invalid}`)
  if (skipped.duplicate) parts.push(`重复 ${skipped.duplicate}`)
  if (skipped.overflow) parts.push(`超出上限 ${skipped.overflow}`)
  if (liveCount) parts.push(`直播 ${liveCount}`)
  return parts.join('、')
}

function hostOf(url) {
  return String(url?.hostname || '').toLowerCase().replace(/^www\./, '')
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`)
}

function liveHost(host) {
  return LIVE_DOMAINS.some((domain) => host === domain)
}

function platformOfHost(host) {
  for (const [id, value] of Object.entries(PLATFORMS)) {
    if (value.domains.some((domain) => hostMatches(host, domain))) return id
  }
  return ''
}

function cleanUrlText(value) {
  let text = String(value || '').trim()
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(LEADING_RE, '').replace(TRAILING_RE, '')
    if (next === text) break
    text = next
  }
  return text
}

function parseUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

// 只保留能确定视频身份的查询参数；其余（refer_flag、utm_*、分享追踪）全部丢掉。
function keepQuery(platform, url) {
  const allowed = platform === 'bilibili' ? ['p', 't']
    : platform === 'youtube' ? ['v', 't']
      : []
  const kept = []
  for (const key of allowed) {
    const value = url.searchParams.get(key)
    if (value) kept.push([key, value])
  }
  return new URLSearchParams(kept)
}

function videoPattern(platform, url) {
  const host = hostOf(url)
  const path = url.pathname || '/'
  if (platform === 'bilibili') {
    if (host === 'b23.tv') return /^\/[A-Za-z0-9]+/.test(path)
    return /^\/video\/(?:BV[0-9A-Za-z]+|av\d+)/i.test(path)
      || /^\/bangumi\/play\/(?:ep|ss)\d+/i.test(path)
  }
  if (platform === 'weibo') {
    return /^\/\d+\/[A-Za-z0-9]+/.test(path)
      || /^\/(?:detail|status)\/\d+/.test(path)
  }
  if (platform === 'douyin') {
    if (host === 'v.douyin.com') return /^\/[A-Za-z0-9]+/.test(path)
    if (host.endsWith('iesdouyin.com')) return /^\/share\/video\/\d+/.test(path)
    return /^\/video\/\d+/.test(path)
  }
  if (platform === 'youtube') {
    if (host === 'youtu.be') return /^\/[\w-]{6,}/.test(path)
    return path === '/watch'
      || /^\/(?:shorts|live|embed)\/[\w-]{6,}/.test(path)
  }
  if (platform === 'x') {
    return /^\/(?:(?:i\/web\/)?status(?:es)?\/\d+|[^/]+\/status\/\d+)/.test(path)
  }
  return false
}

function dedupeKey(platform, url) {
  const path = url.pathname.replace(/\/+$/, '')
  if (platform === 'bilibili') {
    const video = path.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i)
    if (video) return `bilibili:${video[1].toLowerCase()}`
    return `bilibili:${hostOf(url)}${path}`
  }
  if (platform === 'weibo') {
    const seg = path.split('/').filter(Boolean)
    return `weibo:${seg[seg.length - 1] || path}`
  }
  if (platform === 'douyin') {
    if (hostOf(url) === 'v.douyin.com') return `douyin:short:${path.split('/').filter(Boolean)[0] || ''}`
    const video = path.match(/video\/(\d+)/)
    return `douyin:${video ? video[1] : path}`
  }
  if (platform === 'youtube') {
    const id = url.searchParams.get('v') || path.split('/').filter(Boolean).pop() || ''
    return `youtube:${id}`
  }
  if (platform === 'x') {
    const status = path.match(/status(?:es)?\/(\d+)/)
    return `x:${status ? status[1] : path}`
  }
  return `${platform}:${hostOf(url)}${path}`
}

/**
 * 从任意文本里取出可采集的视频链接。
 * 只返回 supported + 格式合法 + 去重后的条目；其余按类别计数。
 */
export function parseLinks(text, { max = MAX_BATCH_LINKS } = {}) {
  const matched = String(text || '').match(URL_RE) || []
  const skipped = { invalid: 0, unsupported: 0, duplicate: 0, overflow: 0, live: 0 }
  const accepted = []
  const live = []
  const seen = new Set()

  for (const raw of matched) {
    const cleaned = cleanUrlText(raw)
    const url = parseUrl(cleaned)
    if (!url) {
      skipped.invalid += 1
      continue
    }
    const host = hostOf(url)
    if (!host) {
      skipped.invalid += 1
      continue
    }
    if (liveHost(host)) {
      live.push({ url: url.href, platform: 'live' })
      continue
    }
    const platform = platformOfHost(host)
    if (!platform) {
      skipped.unsupported += 1
      continue
    }
    if (!videoPattern(platform, url)) {
      skipped.invalid += 1
      continue
    }
    url.search = keepQuery(platform, url).toString()
    url.hash = ''
    const key = dedupeKey(platform, url)
    if (seen.has(key)) {
      skipped.duplicate += 1
      continue
    }
    seen.add(key)
    accepted.push({ url: url.href, platform, key })
  }

  const overflow = Math.max(0, accepted.length - Math.max(1, Number(max) || MAX_BATCH_LINKS))
  if (overflow) {
    skipped.overflow = overflow
    accepted.length -= overflow
  }
  return { accepted, live, skipped, total: matched.length }
}

/** 粘贴内容里是否有一段看起来像链接的文本（用于决定走搜索还是链接流程）。 */
export function hasLinkLike(text) {
  return /https?:\/\//i.test(String(text || ''))
}
