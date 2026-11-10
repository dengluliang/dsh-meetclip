/**
 * 飞书文档卡片：把一条飞书文档链接读取成可在会摘工作区 @ 的 Markdown 卡片。
 *
 * 正文来源首选 DSH 已配置的飞书 MCP（`mcp__feishu__doc_read`），这样登录、
 * 换 token、私有域名都由 MCP 自己处理；MCP 不可用/被策略拒绝时，docx 还可以
 * 用本地 `~/.feishu-mcp-pro/auth.json` 里未过期的用户 token 走一次只读 Open API。
 * 两者都失败则仍然登记一张「仅链接」卡片，由用户决定是否去设置里登录后重试。
 *
 * 本模块不新增飞书授权、不写 auth.json、不把 token/正文写日志。
 */
import { readAccessToken, validOpenUrl } from './feishu.js'

const DOC_TOOL = 'mcp__feishu__doc_read'
const WIKI_TOOL = 'mcp__feishu__wiki_get_node'
const DEFAULT_TIMEOUT_MS = 25_000
const OPEN_API_BASE = 'https://open.feishu.cn/open-apis'
const MAX_TITLE = 300

const PATH_TYPES = {
  docx: 'docx',
  wiki: 'wiki',
  sheets: 'sheet',
  base: 'base',
  docs: 'docs'
}

const TYPE_LABELS = {
  docx: '飞书文档',
  wiki: '飞书知识库',
  sheet: '飞书表格',
  base: '飞书多维表格',
  docs: '飞书文档'
}

const ENVIRONMENTAL = new Set([
  'feishu_unavailable',
  'feishu_not_logged_in',
  'feishu_timeout',
  'feishu_denied',
  'feishu_read_failed'
])

export class DocCardError extends Error {
  constructor(code, message, { status = 0, hint = '', cause = null } = {}) {
    super(message)
    this.name = 'DocCardError'
    this.code = code
    this.status = status
    this.hint = hint
    if (cause) this.cause = cause
  }
}

/** 飞书文档 URL → {url,type,token}；只接受文档链接，不联网。 */
export function parseFeishuDocUrl(value) {
  const text = String(value || '').trim()
  if (!text || !validOpenUrl(text)) return null
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  const match = String(parsed.pathname || '').match(/^\/(docx|wiki|sheets|base|docs)\/([A-Za-z0-9_-]+)(?:\/|$)/)
  if (!match) return null
  const token = match[2]
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(token)) return null
  return { url: parsed.toString(), type: PATH_TYPES[match[1]], token }
}

function labelFor(type) {
  return TYPE_LABELS[type] || '飞书文档'
}

function fallbackTitle(type, token) {
  return `${labelFor(type)} ${String(token || '').slice(0, 8)}`
}

function pushError(code, message, options = {}) {
  return new DocCardError(code, message, options)
}

function abortError(error, timeoutMs) {
  if (error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''))) {
    return pushError('feishu_timeout', `读取飞书文档超时（${Math.round(timeoutMs / 1000)} 秒）`, {
      status: 504,
      hint: '可以稍后重试，或先仅登记链接。'
    })
  }
  return null
}

function mapToolError(error, timeoutMs) {
  const aborted = abortError(error, timeoutMs)
  if (aborted) return aborted
  const text = String(error?.message || error || '')
  const lower = text.toLowerCase()
  if (/unknown tool|tool .*not|cannot find tool|no such tool/.test(lower)) {
    return pushError('feishu_unavailable', '飞书 MCP 还没有载入，稍等几秒再试', {
      status: 409,
      hint: '可以在设置 → 飞书里检查「是否生效」，或点「仅登记链接」。'
    })
  }
  if (/login|log in|not logged|unauthor|401|授权|登录|令牌|token.*(expired|invalid)/.test(lower)) {
    return pushError('feishu_not_logged_in', '飞书登录已失效或未登录', {
      status: 409,
      hint: '到设置 → 飞书重新登录后重试，或先仅登记链接。'
    })
  }
  if (/permission|forbidden|403|无权限|没有权限/.test(lower)) {
    return pushError('feishu_forbidden', '当前飞书账号没有这篇文档的阅读权限', {
      status: 403,
      hint: '换一个有权限的账号，或先仅登记链接。'
    })
  }
  if (/not found|not exist|404|不存在/.test(lower)) {
    return pushError('feishu_not_found', '飞书文档不存在或已被删除', {
      status: 404,
      hint: '检查链接是否完整，或先仅登记链接。'
    })
  }
  if (/denied|blocked|approval|reject|拒绝|策略/.test(lower)) {
    return pushError('feishu_denied', '读取被权限策略拒绝', {
      status: 403,
      hint: '可以先仅登记链接，或到 DSH 权限设置里允许飞书只读工具。'
    })
  }
  return pushError('feishu_read_failed', text || '读取飞书文档失败', {
    status: 502,
    hint: '可以重试，或先仅登记链接。'
  })
}

function batchText(batch) {
  const result = batch?.results?.[0]?.result
  if (!result) return { text: '', isError: true, error: '飞书工具没有返回结果' }
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (text) return { text, isError: Boolean(result.isError) }
  if (result.structuredContent !== undefined) {
    try {
      return { text: JSON.stringify(result.structuredContent), isError: Boolean(result.isError) }
    } catch {
      return { text: String(result.structuredContent), isError: Boolean(result.isError) }
    }
  }
  return { text: '', isError: Boolean(result.isError), error: result.error?.message || '飞书工具返回为空' }
}

/** 调一个已注册的 MCP 工具；独立调用，不需要 Agent。 */
export async function callFeishuTool(tools, name, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!tools || typeof tools.execute !== 'function') {
    throw pushError('feishu_unavailable', '当前宿主没有可调用的工具服务', {
      status: 409,
      hint: '请确认 DSH 已加载飞书 MCP；或先仅登记链接。'
    })
  }
  if (typeof tools.executable === 'function') {
    let available = true
    try {
      available = Boolean(tools.executable(name))
    } catch {
      available = true
    }
    if (!available) {
      throw pushError('feishu_unavailable', '飞书 MCP 还没有载入，稍等几秒再试', {
        status: 409,
        hint: '可以在设置 → 飞书里检查「是否生效」，或点「仅登记链接」。'
      })
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const batch = await tools.execute({
      calls: [{
        id: `meetclip-doc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        name,
        arguments: JSON.stringify(args || {})
      }],
      signal: controller.signal
    })
    const { text, isError, error } = batchText(batch)
    if (isError || error) throw new Error(error || text || '飞书工具返回错误')
    return text
  } catch (failure) {
    throw mapToolError(failure, timeoutMs)
  } finally {
    clearTimeout(timer)
  }
}

function parseDocRead(text) {
  try {
    const data = JSON.parse(text)
    const doc = data?.document && typeof data.document === 'object' ? data.document : data
    const title = String(data?.title || doc?.title || '').trim()
    const raw = data?.content ?? doc?.content ?? ''
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw)
    const revision = data?.revision_id ?? doc?.revision_id ?? ''
    return { title, content, revision: revision === undefined || revision === null ? '' : String(revision) }
  } catch {
    return { title: '', content: String(text || ''), revision: '' }
  }
}

function parseWikiNode(text) {
  try {
    const data = JSON.parse(text)
    const node = data?.node && typeof data.node === 'object' ? data.node : data
    return {
      objToken: String(node?.obj_token || node?.objToken || '').trim(),
      objType: String(node?.obj_type || node?.objType || '').trim(),
      title: String(node?.title || node?.name || '').trim()
    }
  } catch {
    return { objToken: '', objType: '', title: '' }
  }
}

async function readViaMcp(tools, doc, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (doc.type === 'sheet' || doc.type === 'base' || doc.type === 'docs') {
    return {
      linkOnly: true,
      title: '',
      documentId: doc.token,
      warning: `${labelFor(doc.type)}本期只登记链接；需要正文时请打开原文档。`
    }
  }

  let documentId = doc.token
  let title = ''
  if (doc.type === 'wiki') {
    const text = await callFeishuTool(tools, WIKI_TOOL, { token: doc.token }, { timeoutMs })
    const node = parseWikiNode(text)
    if (!node.objToken) {
      return {
        linkOnly: true,
        title: node.title,
        documentId: doc.token,
        warning: '这篇 Wiki 节点没有解析出可读的文档 ID，已登记链接。'
      }
    }
    if (node.objType && node.objType !== 'docx') {
      return {
        linkOnly: true,
        title: node.title,
        documentId: node.objToken,
        warning: `${labelFor(node.objType)}本期只登记链接；需要正文时请打开原文档。`
      }
    }
    documentId = node.objToken
    title = node.title
  }

  const text = await callFeishuTool(tools, DOC_TOOL, { document_id: documentId }, { timeoutMs })
  const parsed = parseDocRead(text)
  return {
    linkOnly: false,
    title: parsed.title || title,
    content: parsed.content,
    documentId,
    revision: parsed.revision
  }
}

function mapOpenApiCode(code, message) {
  const numeric = Number(code)
  const text = String(message || '')
  if (numeric === 99991661 || numeric === 99991663 || numeric === 99991668 || /token|授权|登录/.test(text)) {
    return pushError('feishu_not_logged_in', '飞书登录已失效或未登录', {
      status: 409,
      hint: '到设置 → 飞书重新登录后重试，或先仅登记链接。'
    })
  }
  if (numeric === 1770002 || numeric === 1770003 || /not found|不存在/.test(text)) {
    return pushError('feishu_not_found', '飞书文档不存在或已被删除', {
      status: 404,
      hint: '检查链接是否完整，或先仅登记链接。'
    })
  }
  if (numeric === 1770033 || numeric === 1770034 || /permission|forbidden|权限/.test(text)) {
    return pushError('feishu_forbidden', '当前飞书账号没有这篇文档的阅读权限', {
      status: 403,
      hint: '换一个有权限的账号，或先仅登记链接。'
    })
  }
  return pushError('feishu_read_failed', text || `飞书 Open API 返回 ${code}`, {
    status: 502,
    hint: '可以重试，或先仅登记链接。'
  })
}

async function openApiJson(path, token, { fetchImpl, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchImpl(`${OPEN_API_BASE}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (!response.ok) {
      throw mapOpenApiCode(data?.code ?? response.status, data?.msg || `HTTP ${response.status}`)
    }
    if (Number(data?.code) !== 0) throw mapOpenApiCode(data?.code, data?.msg)
    return data?.data || {}
  } catch (failure) {
    const aborted = abortError(failure, timeoutMs)
    if (aborted) throw aborted
    if (failure instanceof DocCardError) throw failure
    throw pushError('feishu_read_failed', failure?.message || '飞书 Open API 请求失败', {
      status: 502,
      hint: '可以重试，或先仅登记链接。'
    })
  } finally {
    clearTimeout(timer)
  }
}

async function readViaOpenApi(doc, { fetchImpl = fetch, timeoutMs = 12_000, accessToken = '' } = {}) {
  const access = accessToken
  if (!access) {
    throw pushError('feishu_not_logged_in', '飞书登录已失效或未登录', {
      status: 409,
      hint: '到设置 → 飞书重新登录后重试，或先仅登记链接。'
    })
  }
  const encoded = encodeURIComponent(doc.token)
  const meta = await openApiJson(`/docx/v1/documents/${encoded}`, access, { fetchImpl, timeoutMs })
  const raw = await openApiJson(`/docx/v1/documents/${encoded}/raw_content`, access, { fetchImpl, timeoutMs })
  const document = meta?.document || {}
  return {
    linkOnly: false,
    title: String(document.title || '').trim(),
    content: typeof raw?.content === 'string' ? raw.content : '',
    documentId: doc.token,
    revision: document.revision_id === undefined ? '' : String(document.revision_id)
  }
}

function shouldFallback(error) {
  return ENVIRONMENTAL.has(error?.code)
}

/**
 * 读一篇飞书文档：MCP →(仅 docx) Open API → 抛出可降级的错误。
 * 返回 {linkOnly,title,content,documentId,revision,warning}。
 */
export async function readFeishuDoc(doc, {
  tools = null,
  fetchImpl = fetch,
  readToken = readAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const errors = []
  if (tools && typeof tools.execute === 'function') {
    try {
      return await readViaMcp(tools, doc, { timeoutMs })
    } catch (failure) {
      errors.push(failure)
    }
  } else {
    errors.push(pushError('feishu_unavailable', '飞书 MCP 还没有载入', {
      status: 409,
      hint: '到设置 → 飞书安装/检查连接，或先仅登记链接。'
    }))
  }

  const fallbackable = !errors.length || shouldFallback(errors[0])
  if (doc.type === 'docx' && fallbackable) {
    try {
      return await readViaOpenApi(doc, {
        fetchImpl,
        timeoutMs: Math.min(timeoutMs, 12_000),
        accessToken: readToken()
      })
    } catch (failure) {
      errors.push(failure)
    }
  }

  const preferred = errors.find((item) => item?.code === 'feishu_not_found' || item?.code === 'feishu_forbidden')
    || errors.find((item) => !shouldFallback(item))
    || errors[errors.length - 1]
    || pushError('feishu_read_failed', '读取飞书文档失败', { status: 502 })
  throw preferred
}

/**
 * 预读一篇飞书文档：只返回标题、类型、正文长度和一小段摘要，不落卡片。
 * 给「＋ → 飞书文档」表单在用户粘贴链接后自动填标题用。
 */
export async function previewFeishuDoc({
  tools = null,
  url = '',
  fetchImpl = fetch,
  readToken = readAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const doc = parseFeishuDocUrl(url)
  if (!doc) {
    throw pushError('invalid_url', '只支持飞书文档链接（/docx、/wiki、/sheets、/base）', {
      status: 400,
      hint: '例如 https://example.feishu.cn/docx/XXXX。'
    })
  }
  const read = await readFeishuDoc(doc, { tools, fetchImpl, readToken, timeoutMs })
  const content = String(read.content || '')
  return {
    ok: true,
    title: read.title || '',
    doc_type: doc.type,
    document_id: read.documentId || (doc.type === 'docx' ? doc.token : ''),
    revision: read.revision || '',
    has_content: Boolean(content.trim()),
    content_chars: content.length,
    excerpt: content.replace(/\s+/g, ' ').trim().slice(0, 160),
    link_only: Boolean(read.linkOnly) || !content.trim(),
    warning: read.warning || ''
  }
}

/**
 * 登记一张飞书文档卡片。
 * @returns {Promise<{ok:true,created:boolean,card:object,link_only:boolean,warning:string}>}
 */
export async function createFeishuDocCard({
  tools = null,
  backend = null,
  url = '',
  title = '',
  linkOnly = false,
  fetchImpl = fetch,
  readToken = readAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const doc = parseFeishuDocUrl(url)
  if (!doc) {
    throw pushError('invalid_url', '只支持飞书文档链接（/docx、/wiki、/sheets、/base）', {
      status: 400,
      hint: '例如 https://example.feishu.cn/docx/XXXX。'
    })
  }
  if (!backend || typeof backend.json !== 'function') {
    throw pushError('backend_unavailable', '本地引擎还没有就绪', { status: 503 })
  }

  let read = { linkOnly: true, title: '', content: '', documentId: '', revision: '', warning: '' }
  let warning = ''
  const wantedLinkOnly = Boolean(linkOnly)
  if (!wantedLinkOnly) {
    try {
      read = await readFeishuDoc(doc, { tools, fetchImpl, readToken, timeoutMs })
      if (read.warning) warning = read.warning
    } catch (failure) {
      if (!shouldFallback(failure)) throw failure
      warning = `${failure.message}；已先登记链接卡片。`
      read = { linkOnly: true, title: '', content: '', documentId: doc.type === 'docx' ? doc.token : '', revision: '' }
    }
  }

  const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE) || read.title || fallbackTitle(doc.type, doc.token)
  const content = String(read.content || '')
  if (!wantedLinkOnly && !content && !warning) warning = '文档正文为空，已登记链接卡片。'
  const payload = {
    url: doc.url,
    title: cleanTitle,
    content,
    document_id: read.documentId || (doc.type === 'docx' ? doc.token : ''),
    revision: read.revision || ''
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
    throw pushError('card_write_failed', message, {
      status: failure?.status || 502,
      hint: '本地引擎可能未运行，稍后重试。',
      cause: failure
    })
  }
  return {
    ok: true,
    created: Boolean(result?.created),
    card: result?.card || null,
    link_only: !content,
    warning: warning || (wantedLinkOnly ? '' : '')
  }
}
