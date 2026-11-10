// 不预置网关地址：模型清单必须由用户填写服务地址后自行获取。
const DEFAULT_BASE_URL = ''
const MAX_KEY = 4096
const TIMEOUT_MS = 20_000

function normalizeBase(value) {
  const base = String(value || DEFAULT_BASE_URL).trim()
  if (!base) throw new Error('请先填写服务地址（Base URL）')
  let url
  try { url = new URL(base) } catch { throw new Error('网关地址无效') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('网关地址必须是 HTTPS，且不能包含凭证、查询参数或片段')
  }
  return url.toString().replace(/\/$/, '')
}

/**
 * 把目录里的裸 id 补成可调用模型名。
 *
 * OpenAI 兼容网关的 `/models` 会给每个模型一个 `owned_by`（供应商），但要求调用时
 * 写成 `供应商/模型名`；同一个 id 还可能由不同供应商提供。这里按 `owned_by` 补全，
 * 已经带供应商的保持原样，避免用户在引导里选中一个“看起来对、实际调不通”的裸 id。
 */
export function qualifyModel(id, vendor) {
  const name = String(id || '').trim()
  const owner = String(vendor || '').trim()
  if (!name || name.includes('/') || !owner) return name
  return `${owner}/${name}`
}

/** 只读列出网关模型；Key 只在本进程内存中使用，不落盘、不写日志。 */export async function probeModelCatalog({ apiKey, baseUrl = DEFAULT_BASE_URL } = {}) {
  const key = String(apiKey || '').trim()
  if (!key || key.length > MAX_KEY || /\s/.test(key)) {
    throw new Error('API Key 不能为空、不能包含空白字符，且最多 4096 字符')
  }
  const target = normalizeBase(baseUrl) + '/models'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(target, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal
    })
    if (response.status >= 300 && response.status < 400) throw new Error('网关发生重定向，已拒绝发送凭证')
    if (response.status === 401 || response.status === 403) throw new Error('API Key 无效或没有模型权限')
    if (!response.ok) throw new Error(`网关返回 HTTP ${response.status}`)
    let data
    try { data = JSON.parse(await response.text()) } catch { throw new Error('网关没有返回模型列表') }
    const seen = new Set()
    const models = []
    const entries = []
    for (const item of Array.isArray(data?.data) ? data.data : []) {
      const id = String(item?.id || '').trim()
      if (!id || id.endsWith(':batch')) continue
      const vendor = String(item?.owned_by || '').trim()
      const wire = qualifyModel(id, vendor)
      if (!wire || seen.has(wire)) continue
      seen.add(wire)
      models.push(wire)
      entries.push({ id, vendor, wire, kind: String(item?.model_type || '').trim() })
    }
    return { ok: true, models, entries, count: models.length }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('连接网关超时，请稍后重试')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const CHAT_TIMEOUT_MS = 8_000
const PROBE_CONCURRENCY = 8
const DENIED_HINTS = ['不在 Key 的可用模型范围', '未指定供应商', 'invalid api key']

/** 把一次探测失败分成 denied / broken / unknown 三类，只有前两类会从列表里去掉。 */
export function verdictOf(status, detail) {
  const text = String(detail || '')
  if (status === 401 || status === 403 || DENIED_HINTS.some((hint) => text.includes(hint))) return 'denied'
  const missing = /not supported model|model not found|does not exist|invalid_model|unsupported model|不支持/i
  if (status === 404 || status >= 500 || /<html|bad gateway/i.test(text) || missing.test(text)) return 'broken'
  return 'unknown'
}

/**
 * 逐个探测文本模型：网关明确拒绝（没权限 / 没部署）的收进 `hidden`。
 *
 * 与后端 `/api/models/usable` 同一套判断：探测不出结论的（例如 400 参数问题）
 * 保持可见，避免把还能用的模型藏起来。
 */
export async function probeUsable({ apiKey, baseUrl, models, concurrency = PROBE_CONCURRENCY } = {}) {
  const key = String(apiKey || '').trim()
  if (!key || key.length > MAX_KEY || /\s/.test(key)) {
    throw new Error('API Key 不能为空、不能包含空白字符，且最多 4096 字符')
  }
  const base = normalizeBase(baseUrl)
  const list = (Array.isArray(models) ? models : []).map((item) => String(item || '').trim()).filter(Boolean)
  const started = Date.now()
  const hidden = []
  let cursor = 0

  async function probeOne(model) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS)
    let status = 0
    let detail = ''
    try {
      const response = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '好' }], max_tokens: 1, stream: false }),
        redirect: 'manual',
        signal: controller.signal
      })
      status = response.status
      if (status !== 200) {
        const raw = await response.text()
        try {
          const payload = JSON.parse(raw)
          detail = String(payload?.error?.message || payload?.detail || '').trim()
        } catch {
          detail = raw.slice(0, 160)
        }
      }
    } catch (error) {
      return { model, kind: 'unknown', reason: error?.name === 'AbortError' ? '探测超时' : '连不上网关' }
    } finally {
      clearTimeout(timer)
    }
    if (status === 200) return { model, kind: 'usable', reason: '' }
    return { model, kind: verdictOf(status, detail), reason: (detail || `HTTP ${status}`).slice(0, 160) }
  }

  async function worker() {
    while (cursor < list.length) {
      const model = list[cursor]
      cursor += 1
      const result = await probeOne(model)
      if (result.kind === 'denied' || result.kind === 'broken') hidden.push(result)
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker))
  return { ok: true, hidden, checked: list.length, elapsed: (Date.now() - started) / 1000 }
}
