/**
 * 链接卡片：把任意 http(s) 链接读成可在会摘工作区 @ 的 Markdown 卡片。
 *
 * 飞书文档仍复用 doc-cards.js 的读取链（飞书 MCP → Open API → 仅链接）；
 * 公众号文章和普通网页在这里抓一次 HTML，抽出标题、站点、作者、发布时间和正文。
 * 登录墙、防抓取、非 HTML、超时这类「环境性」失败不阻塞登记：调用方可以只存链接，
 * 卡片上写明没读到正文的原因。
 *
 * 本模块只读；抓取有域名/体积/时长上限，不写 token，也不把页面内容写日志。
 */
import {
  DocCardError,
  createFeishuDocCard,
  parseFeishuDocUrl,
  previewFeishuDoc
} from './doc-cards.js'

export const MAX_LINK_URL = 2_000
export const MAX_LINK_CONTENT_CHARS = 24_000

const MAX_HTML_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TITLE = 300
const MAX_SITE = 120
const MAX_AUTHOR = 80
const MAX_PUBLISHED = 40
const MAX_EXCERPT = 240
const MIN_ARTICLE_CHARS = 400

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
// 小红书桌面 UA 会被重定向到登录页；移动 UA 才能拿到笔记详情。
const MOBILE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const MOBILE_HOSTS = ['xiaohongshu.com', 'xhslink.com']

const WECHAT_HOSTS = ['mp.weixin.qq.com']
// 与 client-src/lib/links.js、backend/app/link_video.py 的平台表保持一致；这里只用于提示。
const VIDEO_HOSTS = [
  'bilibili.com', 'b23.tv', 'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'douyin.com', 'iesdouyin.com', 'weibo.com', 'weibo.cn', 'x.com', 'twitter.com'
]

// 这些失败只说明「这次没读到」，不代表链接本身不可登记；调用方会降级成仅链接卡片。
const ENVIRONMENTAL = new Set([
  'link_timeout',
  'link_network',
  'link_forbidden',
  'link_blocked',
  'link_unsupported',
  'link_too_large',
  'link_read_failed'
])

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
  times: '×', divide: '÷', plusmn: '±', deg: '°', copy: '©', reg: '®', trade: '™',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '', zwnj: '', lrm: '', rlm: ''
}

function fail(code, message, { status = 0, hint = '', cause = null } = {}) {
  return new DocCardError(code, message, { status, hint, cause })
}

export function isEnvironmentalLinkError(error) {
  return ENVIRONMENTAL.has(error?.code)
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ------------------------------------------------------------------ URL

function privateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const a = Number(match[1])
  const b = Number(match[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return a >= 224
}

/** 只拦明显的本机/内网字面地址；不做 DNS 解析，避免误伤内网文档站。 */
export function isPrivateHost(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true
  if (privateIpv4(host)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true
  return false
}

/** http(s) URL → URL；拒绝内网、带账号密码和超长链接，去掉 #片段。 */
export function parseLinkUrl(value) {
  const text = String(value || '').trim()
  if (!text || text.length > MAX_LINK_URL) return null
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  if (!parsed.hostname || isPrivateHost(parsed.hostname)) return null
  parsed.hash = ''
  return parsed
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`)
}

function hostIn(host, domains) {
  return domains.some((domain) => hostMatches(host, domain))
}

/** 链接分类：飞书文档 / 公众号 / 视频 / 普通网页 / 无效。 */
export function linkKind(value) {
  const url = parseLinkUrl(value)
  if (!url) return { kind: 'invalid', url: null }
  const host = url.hostname.toLowerCase()
  if (parseFeishuDocUrl(url.href)) return { kind: 'feishu-doc', url }
  if (hostIn(host, WECHAT_HOSTS)) return { kind: 'wechat', url }
  if (hostIn(host, VIDEO_HOSTS)) return { kind: 'video', url }
  return { kind: 'web', url }
}

/** 链接卡片的兜底标题：站点 + 路径末段，避免用一串 hash 当标题。 */
export function fallbackLinkTitle(value) {
  const url = value instanceof URL ? value : parseLinkUrl(value)
  if (!url) return '链接卡片'
  const host = url.hostname.replace(/^www\./, '')
  let tail = ''
  try {
    const segments = decodeURIComponent(url.pathname || '/').split('/').filter(Boolean)
    tail = segments.length ? segments[segments.length - 1] : ''
  } catch {
    tail = ''
  }
  if (!tail || tail.length > 48) return host.slice(0, MAX_TITLE)
  return `${host} · ${tail}`.slice(0, MAX_TITLE)
}

// ------------------------------------------------------------------ HTML

function decodeEntities(text) {
  if (!text || text.indexOf('&') < 0) return text
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const name = body.toLowerCase()
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : whole
  })
}

const NOISE_TAGS = /<(script|style|noscript|template|svg|canvas|iframe|object|embed|select|textarea|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const BLOCK_CLOSE = /<\/(p|div|section|article|header|footer|main|aside|li|ul|ol|dl|dd|dt|h[1-6]|tr|table|blockquote|pre|figure|figcaption|form|nav)\s*>/gi
const INLINE_TAG = /<\/?(?:a|span|strong|em|b|i|u|s|small|sub|sup|code|mark|font|label|abbr|cite|q|time|img|input|hr|br)\b[^>]*>/gi

/** HTML 片段 → 纯文本：块级标签换行，行内标签直接去掉，避免中文被空格切开。 */
export function htmlToText(html) {
  let text = String(html || '')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(NOISE_TAGS, ' ')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(BLOCK_CLOSE, '\n')
  text = text.replace(/<li\b[^>]*>/gi, '\n- ')
  text = text.replace(INLINE_TAG, '')
  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
  text = text.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
  text = text.replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
  text = text.replace(/\r\n?/g, '\n')
  text = text.split('\n').map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim()).join('\n')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

function metaTags(html) {
  const out = []
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || []
  for (const tag of tags) {
    const attrs = {}
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
    let match
    while ((match = attrRe.exec(tag))) {
      attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? ''
    }
    out.push(attrs)
  }
  return out
}

function metaMap(html) {
  const map = {}
  for (const attrs of metaTags(html)) {
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase()
    if (!key || map[key] !== undefined) continue
    const value = decodeEntities(attrs.content || '').trim()
    if (value) map[key] = value
  }
  return map
}

function elementInnerAt(html, openIndex, tag) {
  const headEnd = html.indexOf('>', openIndex)
  if (headEnd < 0) return ''
  const contentStart = headEnd + 1
  const tagRe = new RegExp(`<(/?)${escapeRegExp(tag)}\\b[^>]*>`, 'gi')
  tagRe.lastIndex = openIndex
  let depth = 0
  let match
  while ((match = tagRe.exec(html))) {
    if (match[1]) {
      depth -= 1
      if (depth === 0) return html.slice(contentStart, match.index)
    } else if (!/\/>$/.test(match[0])) {
      depth += 1
    }
  }
  return html.slice(contentStart)
}

function innerById(html, id) {
  const re = new RegExp(`<([a-zA-Z][\\w:-]*)\\b[^>]*\\bid\\s*=\\s*(["'])${escapeRegExp(id)}\\2[^>]*>`, 'i')
  const match = re.exec(html)
  if (!match) return ''
  return elementInnerAt(html, match.index, match[1])
}

function innerByClass(html, token) {
  const re = new RegExp(`<([a-zA-Z][\\w:-]*)\\b[^>]*\\bclass\\s*=\\s*(["'])[^"']*\\b${escapeRegExp(token)}\\b[^"']*\\2[^>]*>`, 'i')
  const match = re.exec(html)
  if (!match) return ''
  return elementInnerAt(html, match.index, match[1])
}

function innerByTag(html, tag) {
  const re = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>`, 'i')
  const match = re.exec(html)
  if (!match) return ''
  return elementInnerAt(html, match.index, tag)
}

/** 同一 class 可能出现多次（正文、提示框、脚注）；最多取 40 个候选。 */
function allByClass(html, token, limit = 40) {
  const re = new RegExp(`<([a-zA-Z][\\w:-]*)\\b[^>]*\\bclass\\s*=\\s*(["'])[^"']*\\b${escapeRegExp(token)}\\b[^"']*\\2[^>]*>`, 'gi')
  const out = []
  let match
  while ((match = re.exec(html)) && out.length < limit) {
    out.push(elementInnerAt(html, match.index, match[1]))
  }
  return out
}

function allByTag(html, tag, limit = 40) {
  const re = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>`, 'gi')
  const out = []
  let match
  while ((match = re.exec(html)) && out.length < limit) {
    out.push(elementInnerAt(html, match.index, tag))
  }
  return out
}

function textOfFirst(html, selectors) {
  for (const selector of selectors) {
    let raw = ''
    if (selector.startsWith('#')) raw = innerById(html, selector.slice(1))
    else if (selector.startsWith('.')) raw = innerByClass(html, selector.slice(1))
    else raw = innerByTag(html, selector)
    const text = htmlToText(raw)
    if (text) return text
  }
  return ''
}

function xhsPageTitle(html) {
  const raw = (String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
  return decodeEntities(raw).split(/[\t\n\r]+/).map((part) => clean(part)).find(Boolean) || ''
}

function stripSiteSuffix(title, site) {
  let value = clean(title)
  if (!value) return ''
  const names = clean(site).split(/\s+[-–—|_]\s+/).map((part) => clean(part)).filter((part) => part.length >= 2)
  for (const name of names) {
    const trimmed = value.replace(new RegExp(`\\s*[-_|—–·:：]\\s*${escapeRegExp(name)}$`, 'i'), '').trim()
    if (trimmed.length >= 4) value = trimmed
  }
  return value
}

function normalizePublished(value) {
  const text = clean(value)
  if (!text) return ''
  if (/^\d{10,13}$/.test(text)) {
    const milliseconds = text.length === 13 ? Number(text) : Number(text) * 1000
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) {
      const pad = (part) => String(part).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
  }
  const iso = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2}))?/)
  if (iso) {
    const pad = (part) => String(part).padStart(2, '0')
    return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}${iso[4] ? ` ${pad(iso[4])}:${iso[5]}` : ''}`
  }
  return text.slice(0, MAX_PUBLISHED)
}

function wechatPublished(html, meta) {
  const direct = textOfFirst(html, ['#publish_time'])
  if (direct) return normalizePublished(direct)
  const scripted = String(html || '').match(/\b(?:var\s+)?(?:ct|create_time|ori_create_time|publish_time)\s*[=:]\s*["']?(\d{10,13})/)
  if (scripted) return normalizePublished(scripted[1])
  return normalizePublished(meta['article:published_time'] || meta.pubdate || meta.publishdate || meta.date || '')
}

const CONTENT_SELECTORS = [
  '#js_content', '.rich_media_content', '.mw-parser-output', '#mw-content-text',
  'article', 'main', '#article', '.article-content', '.article__content',
  '.article-body', '.post-content', '.entry-content', '.markdown-body',
  '.content-body', '.story-body', '.post-body', '.article_body', '.content', '#content'
]

function contentScore(raw) {
  const text = htmlToText(raw)
  if (!text) return { text: '', score: 0, ratio: 1 }
  const linkText = (String(raw).match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [])
    .map((anchor) => htmlToText(anchor)).join('')
  const ratio = text.length ? Math.min(1, linkText.length / text.length) : 1
  return { text, score: text.length * (1 - ratio), ratio }
}

function bodyText(html) {
  const stripped = String(html || '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(NOISE_TAGS, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  return htmlToText(stripped)
}

/**
 * 从页面 HTML 抽标题/站点/作者/发布时间/正文。
 * 正文按选择器优先级取第一个「够长」的容器，都不够长时取最长的那块。
 */
export function extractArticle(html, url) {
  const parsedUrl = url instanceof URL ? url : new URL(String(url))
  const meta = metaMap(html)
  const host = parsedUrl.hostname.toLowerCase()
  const wechat = hostIn(host, WECHAT_HOSTS)
  const xhs = hostIn(host, MOBILE_HOSTS)

  const account = wechat ? textOfFirst(html, ['#js_name', '.rich_media_meta_nickname']) : ''
  const site = wechat
    ? clean(account || meta['og:site_name'] || '微信公众号').slice(0, MAX_SITE)
    : clean(meta['og:site_name'] || meta['application-name'] || (xhs ? '小红书' : host.replace(/^www\./, ''))).slice(0, MAX_SITE)

  // 小红书没有 og:title，<title> 往往把标题和整篇笔记用制表符拼在一起；标题只取第一段。
  const pageTitle = xhs ? xhsPageTitle(html) : textOfFirst(html, ['title'])
  // 小红书的 og:title / <title> 会把标题和整篇笔记拼在一起，只认第一段。
  let title = xhs
    ? stripSiteSuffix(xhsPageTitle(html), site).slice(0, MAX_TITLE)
    : stripSiteSuffix(clean(meta['og:title'] || meta['twitter:title'] || ''), site).slice(0, MAX_TITLE)
  if (!title && !xhs) title = stripSiteSuffix(textOfFirst(html, ['#activity-name', 'h1']), site).slice(0, MAX_TITLE)
  if (!title && !xhs) title = stripSiteSuffix(pageTitle, site).slice(0, MAX_TITLE)

  const author = (wechat
    ? textOfFirst(html, ['#js_author_name', '.rich_media_meta_text.rich_media_meta_nickname'])
    : clean(meta.author || '')).slice(0, MAX_AUTHOR)

  const publishedAt = wechat
    ? wechatPublished(html, meta)
    : normalizePublished(meta['article:published_time'] || meta.pubdate || meta.publishdate || meta.date || '')

  let content = ''
  let best = { text: '', score: 0, ratio: 1 }
  for (const selector of CONTENT_SELECTORS) {
    const values = selector.startsWith('#') ? [innerById(html, selector.slice(1))]
      : selector.startsWith('.') ? allByClass(html, selector.slice(1))
        : allByTag(html, selector)
    const scored = values
      .filter((raw) => raw && raw.length >= 120)
      .map((raw) => contentScore(raw))
      .filter((candidate) => candidate.text)
    if (!scored.length) continue
    // 同一选择器可能命中多个块；取得分最高的那个。
    const local = scored.reduce((a, b) => (b.score > a.score ? b : a))
    if (local.score > best.score) best = local
    if (local.text.length >= MIN_ARTICLE_CHARS && local.ratio <= 0.6) {
      content = local.text
      break
    }
  }
  if (!content) content = best.text
  if (!wechat && content.length < 200) {
    const fallback = bodyText(html)
    if (fallback.length > content.length) content = fallback
  }
  // 小红书的笔记正文就在 meta description 里（通常比 DOM 里能抽到的更完整）。
  const description = clean(meta['og:description'] || meta.description || '')
  if (xhs && description.length >= 120 && description.length > content.length) {
    content = description
  }
  if (content.length > MAX_LINK_CONTENT_CHARS) {
    content = `${content.slice(0, MAX_LINK_CONTENT_CHARS).trimEnd()}\n\n_（正文较长，已截断。）_`
  }
  // article 容器通常把 h1 标题也包进正文；卡片标题已经单独写过，从标题行之后开始。
  const lines = content.split('\n')
  const titleLine = lines.findIndex((line) => clean(line) === clean(title))
  if (titleLine >= 0 && titleLine <= 8 && lines.length > titleLine + 1) {
    content = lines.slice(titleLine + 1).join('\n').trim()
  }

  const excerpt = (description || clean(content)).slice(0, MAX_EXCERPT)

  const blocked = looksBlocked({ title, content })
  return { title, site, author, publishedAt, excerpt, content, blocked, wechat }
}

function looksMissing({ title, content }) {
  if (String(content || '').length > 800) return false
  return /(^|\s)404(\s|$)|页面不存在|页面不见了|找不到(该|此)?页面|Page not found|Not Found/i.test(String(title || ''))
}

function looksBlocked({ title, content }) {
  const text = String(content || '').trim()
  if (!text) return true
  const sample = `${title || ''}\n${text}`.slice(0, 800)
  if (/环境异常|完成验证|访问过于频繁|请输入验证码|人机验证|安全验证|访问被拒绝|Just a moment|Enable JavaScript/i.test(sample)) {
    return true
  }
  return text.length < 40
}

// ------------------------------------------------------------------ 抓取

function mapStatus(status) {
  if (status === 401 || status === 403) {
    return fail('link_forbidden', `这个页面需要登录或拒绝访问（HTTP ${status}）`, {
      status: 403,
      hint: '可以在浏览器确认能打开后再试，或先仅登记链接。'
    })
  }
  if (status === 404 || status === 410) {
    return fail('link_not_found', `页面不存在或已删除（HTTP ${status}）`, {
      status: 404,
      hint: '检查链接是否完整，或先仅登记链接。'
    })
  }
  if (status === 429) {
    return fail('link_blocked', '站点要求限流验证（HTTP 429）', {
      status: 429,
      hint: '稍后重试，或先仅登记链接。'
    })
  }
  if (status >= 500) {
    return fail('link_network', `站点暂时不可用（HTTP ${status}）`, {
      status: 502,
      hint: '稍后重试，或先仅登记链接。'
    })
  }
  return fail('link_read_failed', `页面返回 HTTP ${status}`, {
    status: 502,
    hint: '可以稍后重试，或先仅登记链接。'
  })
}

function mapFetchError(error, timeoutMs) {
  if (error?.code) return error
  const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''))
  if (aborted) {
    return fail('link_timeout', `读取页面超时（${Math.round(timeoutMs / 1000)} 秒）`, {
      status: 504,
      hint: '可以稍后重试，或先仅登记链接。'
    })
  }
  return fail('link_network', clean(error?.message) || '网络请求失败', {
    status: 502,
    hint: '检查网络或链接，也可以先仅登记链接。'
  })
}

function charsetFrom(contentType) {
  const match = String(contentType || '').match(/charset\s*=\s*["']?([\w-]+)/i)
  return match ? match[1] : ''
}

function sniffCharset(buffer) {
  const head = Buffer.from(buffer).subarray(0, 2048).toString('latin1')
  const meta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)
  if (meta) return meta[1]
  const httpEquiv = head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i)
  return httpEquiv ? httpEquiv[1] : ''
}

function normalizeCharset(label) {
  const value = String(label || '').trim().toLowerCase()
  if (!value) return 'utf-8'
  if (value === 'gb2312' || value === 'gbk' || value === 'x-gbk' || value === 'gb18030') return 'gb18030'
  if (value === 'utf8') return 'utf-8'
  return value
}

/** 按 Content-Type / <meta charset> 解码，兼容公众号常见 UTF-8 与老站点 GBK。 */
export function decodeHtml(buffer, contentType = '') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const label = normalizeCharset(charsetFrom(contentType) || sniffCharset(bytes) || 'utf-8')
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

async function readBody(response, maxBytes) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.length
      if (total > maxBytes) {
        try { await reader.cancel() } catch {}
        throw fail('link_too_large', `页面太大（超过 ${Math.round(maxBytes / 1024 / 1024)} MB）`, {
          status: 413,
          hint: '可以只登记链接。'
        })
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      throw fail('link_too_large', `页面太大（超过 ${Math.round(maxBytes / 1024 / 1024)} MB）`, {
        status: 413,
        hint: '可以只登记链接。'
      })
    }
    return buffer
  }
  const text = typeof response.text === 'function' ? await response.text() : ''
  return Buffer.from(String(text || ''), 'utf8')
}

/**
 * 抓一个网页：跟随跳转、按字符集解码、限制体积与时长。
 * @returns {Promise<{html:string, finalUrl:string, contentType:string}>}
 */
export async function fetchLinkPage(url, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_HTML_BYTES
} = {}) {
  const target = url instanceof URL ? url : parseLinkUrl(url)
  if (!target) throw fail('invalid_url', '链接格式不正确，只支持 http(s) 网页链接', { status: 400 })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    let response
    try {
      response = await fetchImpl(target.href, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': hostIn(String(target.hostname || '').toLowerCase(), MOBILE_HOSTS) ? MOBILE_USER_AGENT : USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
          // 公众号等站点会参考来源；用站点首页当 referer 比不带更接近正常浏览。
          referer: `${target.origin}/`
        }
      })
    } catch (failure) {
      throw mapFetchError(failure, timeoutMs)
    }
    const finalUrl = String(response.url || target.href)
    try {
      const parsed = new URL(finalUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw fail('link_private', '跳转到了不支持的地址', { status: 400 })
      }
      if (isPrivateHost(parsed.hostname)) {
        throw fail('link_private', '不允许读取本机或内网地址', {
          status: 400,
          hint: '换一个公开链接，或先仅登记链接。'
        })
      }
    } catch (failure) {
      if (failure?.code) throw failure
      throw fail('link_read_failed', '跳转后的地址无法解析', { status: 502 })
    }
    if (!response.ok) throw mapStatus(Number(response.status || 0))
    const contentType = String(response.headers?.get?.('content-type') || '')
    const buffer = await readBody(response, maxBytes)
    return { html: decodeHtml(buffer, contentType), finalUrl, contentType }
  } finally {
    clearTimeout(timer)
  }
}

async function readWebPage(url, options = {}) {
  const { html, finalUrl, contentType } = await fetchLinkPage(url, options)
  if (contentType && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
    throw fail('link_unsupported', `这个链接不是网页（${clean(contentType.split(';')[0])}）`, {
      status: 415,
      hint: '可以只登记链接，之后在浏览器查看。'
    })
  }
  const article = extractArticle(html, finalUrl)
  if (looksMissing(article)) {
    throw fail('link_not_found', '页面不存在或已删除', {
      status: 404,
      hint: '检查链接是否完整，或先仅登记链接。'
    })
  }
  if (article.blocked) {
    throw fail('link_blocked', article.content
      ? '页面要求验证或登录，没有读到正文'
      : '页面没有可读正文（可能需要登录或启用了防抓取）', {
      status: 409,
      hint: '可以在浏览器打开确认后再试，或先仅登记链接。'
    })
  }
  if (!article.content) {
    throw fail('link_read_failed', '页面没有可读正文', {
      status: 422,
      hint: '可以先仅登记链接。'
    })
  }
  return {
    linkOnly: false,
    title: article.title,
    content: article.content,
    site: article.site,
    author: article.author,
    publishedAt: article.publishedAt,
    excerpt: article.excerpt,
    finalUrl
  }
}

// ------------------------------------------------------------------ 预览 / 落卡

function emptyRead() {
  return { linkOnly: true, title: '', content: '', site: '', author: '', publishedAt: '', excerpt: '' }
}

/**
 * 预读一条链接：飞书文档走 doc-cards，其余抓网页。
 * 网页抓不到时返回 link_only=true 的预览（带 warning），不抛错；
 * 无效链接、404 这类内容性错误仍然抛出，由表单显示。
 */
export async function previewLinkCard({
  tools = null,
  url = '',
  fetchImpl = fetch,
  readToken,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const link = linkKind(url)
  if (link.kind === 'invalid') {
    throw fail('invalid_url', '只支持 http(s) 网页链接', {
      status: 400,
      hint: '例如 https://mp.weixin.qq.com/s/… 或 https://example.feishu.cn/docx/…'
    })
  }
  if (link.kind === 'feishu-doc') {
    const preview = await previewFeishuDoc({ tools, url: link.url.href, fetchImpl, readToken, timeoutMs })
    return {
      ...preview,
      kind: 'feishu-doc',
      site: '飞书',
      author: '',
      published_at: '',
      excerpt: preview.excerpt || ''
    }
  }
  const base = {
    ok: true,
    kind: link.kind,
    doc_type: link.kind === 'wechat' ? 'wechat' : 'web',
    title: fallbackLinkTitle(link.url),
    site: link.url.hostname.replace(/^www\./, ''),
    author: '',
    published_at: '',
    excerpt: '',
    has_content: false,
    content_chars: 0,
    link_only: true,
    warning: ''
  }
  try {
    const read = await readWebPage(link.url, { fetchImpl, timeoutMs })
    return {
      ...base,
      title: read.title || base.title,
      site: read.site || base.site,
      author: read.author,
      published_at: read.publishedAt,
      excerpt: read.excerpt,
      has_content: true,
      content_chars: read.content.length,
      link_only: false
    }
  } catch (failure) {
    if (!isEnvironmentalLinkError(failure)) throw failure
    return { ...base, warning: failure.message || '没有读到正文，已改为仅登记链接。' }
  }
}

/**
 * 登记一张链接卡片（飞书文档 / 公众号文章 / 普通网页）。
 * 读正文的环境性失败会降级为仅链接卡片，并把原因写进 warning。
 */
export async function createLinkCard({
  tools = null,
  backend = null,
  url = '',
  title = '',
  linkOnly = false,
  fetchImpl = fetch,
  readToken,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const link = linkKind(url)
  if (link.kind === 'invalid') {
    throw fail('invalid_url', '只支持 http(s) 网页链接', {
      status: 400,
      hint: '例如 https://mp.weixin.qq.com/s/… 或 https://example.feishu.cn/docx/…'
    })
  }
  if (link.kind === 'feishu-doc') {
    const result = await createFeishuDocCard({
      tools, backend, url: link.url.href, title, linkOnly, fetchImpl, readToken, timeoutMs
    })
    return { ...result, kind: 'feishu-doc' }
  }
  if (!backend || typeof backend.json !== 'function') {
    throw fail('backend_unavailable', '本地引擎还没有就绪', { status: 503 })
  }

  const wantedLinkOnly = Boolean(linkOnly)
  let read = emptyRead()
  let warning = ''
  if (!wantedLinkOnly) {
    try {
      read = await readWebPage(link.url, { fetchImpl, timeoutMs })
    } catch (failure) {
      if (!isEnvironmentalLinkError(failure)) throw failure
      warning = `${failure.message}；已先登记链接卡片。`
    }
  }

  const content = String(read.content || '')
  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE) || read.title || fallbackLinkTitle(link.url)
  if (!wantedLinkOnly && !content && !warning) warning = '页面没有可读正文，已登记链接卡片。'
  const payload = {
    url: link.url.href,
    title: cleanTitle,
    content,
    document_id: '',
    revision: '',
    meta: {
      site: read.site || '',
      author: read.author || '',
      published_at: read.publishedAt || '',
      excerpt: read.excerpt || ''
    }
  }
  let result
  try {
    result = await backend.json('/api/cards/doc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
  } catch (failure) {
    const detail = failure?.data?.detail
    const message = Array.isArray(detail)
      ? detail.map((item) => {
        const where = Array.isArray(item?.loc) ? item.loc.join('.') : ''
        return [where, item?.msg || ''].filter(Boolean).join(': ')
      }).filter(Boolean).join('；')
      : (typeof detail === 'string' && detail) || failure?.message || '写入会摘卡片失败'
    throw fail('card_write_failed', message, {
      status: failure?.status || 502,
      hint: '本地引擎可能未运行，稍后重试。',
      cause: failure
    })
  }
  return {
    ok: true,
    kind: link.kind,
    created: Boolean(result?.created),
    card: result?.card || null,
    link_only: !content,
    warning
  }
}
