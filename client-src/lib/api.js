async function request(path, options = {}) {
  const response = await fetch(`/meetclip${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  })
  const text = await response.text()
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!response.ok) {
    const message = (data && (data.detail || data.error || data.message)) || `HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.data = data
    throw error
  }
  return data
}

export function status() {
  return request('/app/status')
}

export function app(path, options) {
  return request(`/app${path}`, options)
}

export function api(path, options) {
  return request(`/api${path}`, options)
}

export function backendAction(action) {
  return app('/backend', { method: 'POST', body: JSON.stringify({ action }) })
}

export function listSessions() {
  return api('/sessions')
}

/** @ 菜单的会摘卡片：q 匹配标题与卡片摘要关键词。 */
export function listCards(query = '', { signal, id = '', limit = 20 } = {}) {
  const params = new URLSearchParams({ q: String(query || ''), limit: String(limit) })
  if (id) params.set('id', String(id))
  return api(`/cards?${params.toString()}`, { signal })
}

/** 把记录/文档/便利签/标记/图片/批次/卡包落成可 @ 的 Markdown 卡片。 */
export function syncCards(force = false) {
  return api(`/cards/sync${force ? '?force=1' : ''}`, { method: 'POST', body: JSON.stringify({}) })
}

export function homeFeed({ limit = 60, offset = 0 } = {}) {
  return api(`/home?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`)
}

export function getSession(id) {
  return api(`/sessions/${encodeURIComponent(id)}`)
}

const DIRECT_MEDIA_SUFFIXES = /\.(mp4|m4v|mov|webm|m4a|mp3|wav|aac|flac|ogg|opus)$/i

export function fileUrl(sessionId, relativePath) {
  const parts = String(relativePath || '').split('/').filter(Boolean).map(encodeURIComponent)
  const url = `/meetclip/api/files/${encodeURIComponent(sessionId)}/${parts.join('/')}`
  // 桌面端（dsh-app://）的流式转发会丢 Content-Length，导致媒体不可 seek。
  // 点播媒体多带 direct=1，让后端 307 到本地 http 地址；浏览器/Web 端不受影响。
  const desktop = typeof window !== 'undefined' && window.location?.protocol === 'dsh-app:'
  return desktop && DIRECT_MEDIA_SUFFIXES.test(String(relativePath || '').split('?')[0]) ? `${url}?direct=1` : url
}

export function exportMarkdown(sessionId) {
  return api(`/sessions/${encodeURIComponent(sessionId)}/export`)
}

export function exportZipUrl(sessionId) {
  return `/meetclip/api/sessions/${encodeURIComponent(sessionId)}/export.zip`
}

export function setupStatus() {
  return app('/setup/status')
}

export function startSetup(action) {
  return app('/setup', { method: 'POST', body: JSON.stringify({ action }) })
}

export function readLogs(source = 'backend', lines = 200) {
  return app(`/logs?source=${encodeURIComponent(source)}&lines=${lines}`)
}

export function savePrefs(patch) {
  return app('/prefs', { method: 'POST', body: JSON.stringify(patch) })
}

export function inspectDataDir(path, { measure = true } = {}) {
  return app('/data-dir/inspect', { method: 'POST', body: JSON.stringify({ path, measure }) })
}

export function switchDataDir({ path, move = false }) {
  return app('/data-dir', { method: 'POST', body: JSON.stringify({ path, move }) })
}

export function workspaceStatus(path = '') {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return app(`/workspace${query}`)
}

export function ensureWorkspace(body = {}) {
  return app('/workspace', { method: 'POST', body: JSON.stringify(body) })
}

export function precheckLive(url) {
  return api('/precheck', { method: 'POST', body: JSON.stringify({ url }) })
}

export function previewLink(url) {
  return api('/link-videos/preview', { method: 'POST', body: JSON.stringify({ url }) })
}

export function addLinks(items, { batchId = '' } = {}) {
  const body = { items }
  if (batchId) body.batch_id = batchId
  return api('/link-videos/batch', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export function createSession(body) {
  return api('/sessions', { method: 'POST', body: JSON.stringify(body) })
}

export function startSession(id) {
  return api(`/sessions/${encodeURIComponent(id)}/start`, { method: 'POST', body: '{}' })
}

export function stopSession(id) {
  return api(`/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' })
}

export function cancelSession(id) {
  return api(`/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' })
}

export function retranscribeSession(id, body = {}) {
  return api(`/sessions/${encodeURIComponent(id)}/retranscribe`, { method: 'POST', body: JSON.stringify(body) })
}

export function addMark(id, ts, note) {
  return api(`/sessions/${encodeURIComponent(id)}/marks`, { method: 'POST', body: JSON.stringify({ ts, note }) })
}

export function updateMark(markId, ts, note) {
  return api(`/marks/${markId}`, { method: 'PATCH', body: JSON.stringify({ ts, note }) })
}

export function deleteMark(markId) {
  return api(`/marks/${markId}`, { method: 'DELETE' })
}

export function meetingOptions() {
  return api('/meeting/options')
}

export function importMeeting(body) {
  return api('/meetings/import', { method: 'POST', body: JSON.stringify(body) })
}

export function importMeetings(body) {
  return api('/meetings/import-batch', { method: 'POST', body: JSON.stringify(body) })
}

export function retryLink(id) {
  return api(`/link-videos/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' })
}

export function cancelLink(id) {
  return api(`/link-videos/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' })
}

export function deps() {
  return api('/deps')
}

export function installDeps() {
  return api('/deps/install', { method: 'POST', body: '{}' })
}

export function depsInstallStatus() {
  return api('/deps/install/status')
}

export function bilibiliStatus() {
  return api('/bilibili/status')
}

export function bilibiliRefresh() {
  return api('/bilibili/refresh', { method: 'POST', body: '{}' })
}

export function bilibiliLogout() {
  return api('/bilibili/logout', { method: 'POST', body: '{}' })
}

export function bilibiliQrStart() {
  return api('/bilibili/qr', { method: 'POST', body: '{}' })
}

export function bilibiliQrPoll(key) {
  return api(`/bilibili/qr/${encodeURIComponent(key)}`)
}

export function douyinStatus() {
  return api('/douyin/status')
}

export function douyinOpenLogin() {
  return api('/douyin/open', { method: 'POST', body: '{}' })
}

export function douyinOpenPermission() {
  return api('/douyin/permission', { method: 'POST', body: '{}' })
}

export function douyinImport(browser = '') {
  return api('/douyin/import', { method: 'POST', body: JSON.stringify({ browser }) })
}

export function douyinLogout() {
  return api('/douyin/logout', { method: 'POST', body: '{}' })
}

export function douyinTest(url = '') {
  return api('/douyin/test', { method: 'POST', body: JSON.stringify({ url }) })
}

export function appSettings() {
  return api('/settings')
}

export function saveAppSettings(body) {
  return api('/settings', { method: 'POST', body: JSON.stringify(body) })
}

export function asrEngines() {
  return api('/asr/engines')
}

export function saveAsrEngine(body) {
  return api('/asr/engines', { method: 'POST', body: JSON.stringify(body) })
}

export function testAsrEngine(probe) {
  return api('/asr/engines/test', { method: 'POST', body: JSON.stringify(probe || {}) })
}

export function pickFile(kind = 'media', { multiple = false } = {}) {
  return app('/pick-file', { method: 'POST', body: JSON.stringify({ kind, multiple: Boolean(multiple) }) })
}

export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/meetclip/app/upload')
    xhr.withCredentials = true
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'upload'))
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total, event.loaded, event.total)
    }
    xhr.onload = () => {
      let data = null
      try { data = JSON.parse(xhr.responseText || '{}') } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) resolve(data)
      else {
        const error = new Error(data?.detail || `HTTP ${xhr.status}`)
        error.status = xhr.status
        reject(error)
      }
    }
    xhr.onerror = () => reject(new Error('上传失败'))
    xhr.onabort = () => reject(new Error('上传已取消'))
    xhr.send(file)
  })
}

export function saveRecordNotes(id, notes, version) {
  return api(`/sessions/${encodeURIComponent(id)}/notes`, {
    method: 'PATCH', body: JSON.stringify({ notes, version })
  })
}

export function renameSession(id, title) {
  return api(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) })
}

export function duplicateSession(id) {
  return api(`/sessions/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: '{}' })
}

export function deleteSession(id) {
  return api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function deleteSessions(ids) {
  return api('/sessions/batch_delete', { method: 'POST', body: JSON.stringify({ ids }) })
}

export function revealRecord(id) {
  return app('/open', { method: 'POST', body: JSON.stringify({ target: 'record', sessionId: id }) })
}

export function revealPath(target = 'data') {
  return app('/open', { method: 'POST', body: JSON.stringify({ target }) })
}

export function updateSpeakers(id, names = {}, merge = {}) {
  return api(`/sessions/${encodeURIComponent(id)}/speakers`, {
    method: 'PATCH', body: JSON.stringify({ names, merge })
  })
}

export function updateOptions(id, body) {
  return api(`/sessions/${encodeURIComponent(id)}/options`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function searchRecord(id, query) {
  return api(`/sessions/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}`)
}

export function globalSearch(query, type = 'all', offset = 0, limit = 50) {
  return api(`/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&offset=${offset}&limit=${limit}`)
}

export function fallbackStart(id) {
  return api(`/link-videos/${encodeURIComponent(id)}/fallback/start`, { method: 'POST', body: '{}' })
}

export function fallbackStop(id) {
  return api(`/link-videos/${encodeURIComponent(id)}/fallback/stop`, { method: 'POST', body: '{}' })
}

export function stickyNotes() {
  return api('/sticky-notes')
}

export function createStickyNote(body) {
  return api('/sticky-notes', { method: 'POST', body: JSON.stringify(body) })
}

export function updateStickyNote(id, body) {
  return api(`/sticky-notes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function deleteStickyNote(id) {
  return api(`/sticky-notes/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function boardImages() {
  return api('/board/images')
}

export async function uploadBoardImage(file, { x = 0, y = 0, width = 0, height = 0 } = {}) {
  const form = new FormData()
  form.append('file', file)
  form.append('x', String(x))
  form.append('y', String(y))
  form.append('width', String(width))
  form.append('height', String(height))
  const response = await fetch('/meetclip/api/board/images', {
    method: 'POST',
    credentials: 'same-origin',
    body: form
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!response.ok) throw new Error((data && (data.detail || data.message)) || `HTTP ${response.status}`)
  return data
}

export function boardImageUrl(id) {
  return `/meetclip/api/board/images/${encodeURIComponent(id)}/file`
}

export function deleteBoardImage(id) {
  return api(`/board/images/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function createPack(body) {
  return api('/packs', { method: 'POST', body: JSON.stringify(body) })
}

export function getPack(id) {
  return api(`/packs/${encodeURIComponent(id)}`)
}

export function renamePack(id, title) {
  return api(`/packs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) })
}

export function addPackMembers(id, members) {
  return api(`/packs/${encodeURIComponent(id)}/members`, {
    method: 'POST',
    body: JSON.stringify({ members })
  })
}

export function removePackMembers(id, members) {
  // 本地 Host 代理对带 body 的 DELETE 会发出非法请求，移除走 POST 兼容路由。
  return api(`/packs/${encodeURIComponent(id)}/members/remove`, {
    method: 'POST',
    body: JSON.stringify({ members })
  })
}
export function reorderPackMembers(id, members) {
  return api(`/packs/${encodeURIComponent(id)}/members`, {
    method: 'PATCH',
    body: JSON.stringify({ members })
  })
}


export function deletePack(id) {
  return api(`/packs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function testMimoKey(apiKey, { baseUrl, model } = {}) {
  return app('/asr/test', {
    method: 'POST',
    body: JSON.stringify({ api_key: apiKey, base_url: baseUrl, model })
  })
}

export function probeModels({ apiKey, baseUrl } = {}) {
  return app('/models', {
    method: 'POST',
    body: JSON.stringify({ api_key: apiKey, base_url: baseUrl })
  })
}

export function modelCatalog() {
  return api('/models/catalog')
}

/**
 * 逐个探测候选模型，返回这个 Key 明确调不通的那些（可能为空）。
 *
 * 走 Host（`/app/models`）而不是后端：首次引导第 1 步后端还没启动，
 * 但 Host 已经在了，探测要能在这一步跑起来。
 */
export function probeUsableModels({ apiKey, baseUrl, models = [] } = {}) {
  return app('/models', {
    method: 'POST',
    body: JSON.stringify({ probe: true, api_key: apiKey, base_url: baseUrl, models })
  })
}

/** 设置页里用已保存的 Key 跑同一轮探测（后端接口，从钥匙串取 Key）。 */
export function probeUsableCatalog() {
  return api('/models/usable', { method: 'POST', body: JSON.stringify({}) })
}

// ---------------- AI 纪要 ----------------
export function getMinutes(id) {
  return api(`/sessions/${encodeURIComponent(id)}/minutes`)
}

/** 结构化纪要的 Markdown 投影（不带笔记边界）；复制全部与分享都走这一份。 */
export function minutesMarkdown(id, links = false) {
  return api(`/sessions/${encodeURIComponent(id)}/minutes.md?links=${links ? 1 : 0}`)
}

export function generateMinutes(id, mode = 'final') {
  return api(`/sessions/${encodeURIComponent(id)}/minutes`, {
    method: 'POST', body: JSON.stringify({ mode })
  })
}

export function deleteMinutes(id) {
  return api(`/sessions/${encodeURIComponent(id)}/minutes`, { method: 'DELETE' })
}

/** 用户在纪要上的互动：勾选完成的待办、选中文字加的高亮（会同步给 Agent）。 */
export function getMinutesInteractions(id) {
  return api(`/sessions/${encodeURIComponent(id)}/minutes/interactions`)
}

export function saveMinutesInteractions(id, interactions) {
  return api(`/sessions/${encodeURIComponent(id)}/minutes/interactions`, {
    method: 'PUT', body: JSON.stringify(interactions || {})
  })
}

export function clearMinutesInteractions(id) {
  return api(`/sessions/${encodeURIComponent(id)}/minutes/interactions`, { method: 'DELETE' })
}

export function syncMinutesNotes(id, force = false) {
  return api(`/sessions/${encodeURIComponent(id)}/minutes/notes${force ? '?force=1' : ''}`, {
    method: 'POST'
  })
}

export function recordMetrics(id) {
  return api(`/sessions/${encodeURIComponent(id)}/metrics`)
}

export function exportFormatUrl(id, format) {
  return `/meetclip/api/sessions/${encodeURIComponent(id)}/export.${format}`
}

export function aiStatus() {
  return api('/ai/status')
}

export function saveAIConfig(body) {
  return api('/ai/config', { method: 'POST', body: JSON.stringify(body) })
}

export function saveAIKey(apiKey) {
  return api('/ai/key', { method: 'POST', body: JSON.stringify({ api_key: apiKey }) })
}

export function removeAIKey() {
  return api('/ai/key', { method: 'DELETE' })
}

export function checkAI() {
  return api('/ai/check', { method: 'POST', body: '{}' })
}

export function testAIModel(probe) {
  return api('/ai/test', { method: 'POST', body: JSON.stringify(probe || {}) })
}

export function listAIModels() {
  return api('/ai/models')
}

// ---------------- 说话人猜名 ----------------
export function speakersPlan(id) {
  return api(`/sessions/${encodeURIComponent(id)}/speakers/plan`)
}

export function guessSpeakers(id) {
  return api(`/sessions/${encodeURIComponent(id)}/speakers/guess`, { method: 'POST', body: '{}' })
}

export function acceptSpeakerGuess(id, raw, name) {
  return api(`/sessions/${encodeURIComponent(id)}/speakers/guess/accept`, {
    method: 'POST', body: JSON.stringify({ raw, name: name || null })
  })
}

export function rejectSpeakerGuess(id, raw) {
  return api(`/sessions/${encodeURIComponent(id)}/speakers/guess/reject`, {
    method: 'POST', body: JSON.stringify({ raw })
  })
}

export function undoSpeakers(id) {
  return api(`/sessions/${encodeURIComponent(id)}/speakers/undo`, { method: 'POST', body: '{}' })
}

export function keepGoing(id) {
  return api(`/sessions/${encodeURIComponent(id)}/keep-going`, { method: 'POST', body: '{}' })
}

// ---------------- 飞书 MCP Pro ----------------
export function feishuStatus() {
  return app('/feishu/status')
}

export function feishuInstall() {
  return app('/feishu/install', { method: 'POST', body: '{}' })
}

export function feishuUpdate() {
  return app('/feishu/update', { method: 'POST', body: '{}' })
}

export function feishuLogin(mode = 'auto') {
  return app('/feishu/login', { method: 'POST', body: JSON.stringify({ mode }) })
}

export function feishuLogout() {
  return app('/feishu/logout', { method: 'POST', body: '{}' })
}

export function feishuSetup() {
  return app('/feishu/setup', { method: 'POST', body: '{}' })
}

export function feishuProbe() {
  return app('/feishu/probe', { method: 'POST', body: '{}' })
}

export function feishuCancel() {
  return app('/feishu/cancel', { method: 'POST', body: '{}' })
}

export function feishuConfig(action) {
  return app('/feishu/config', { method: 'POST', body: JSON.stringify({ action }) })
}

/** 预读飞书文档标题与正文长度，不落卡片。 */
export function previewFeishuDoc({ url, signal } = {}) {
  return app('/feishu/doc-preview', {
    method: 'POST',
    body: JSON.stringify({ url }),
    signal
  })
}

/** 把一条飞书文档链接登记成会摘卡片；linkOnly 时只存链接、不读正文。 */
export function addFeishuDocCard({ url, title = '', linkOnly = false } = {}) {
  return app('/feishu/doc-card', {
    method: 'POST',
    body: JSON.stringify({ url, title, link_only: Boolean(linkOnly) })
  })
}

// ------------------------------------------------------------------ 资料空间

/** 全部资料空间 + 当前激活的那个。 */
export function listLibraries() {
  return app('/libraries')
}

/** 预检一个候选目录：是否已有资料库、是否与现有空间冲突。 */
export function inspectLibrary(path) {
  return app('/libraries/inspect', { method: 'POST', body: JSON.stringify({ path }) })
}

export function createLibrary({ name, dataDir, activate = true, force = false, interrupt = false }) {
  return app('/libraries', {
    method: 'POST',
    body: JSON.stringify({ name, dataDir, activate, force, interrupt })
  })
}

export function activateLibrary({ id, interrupt = false }) {
  return app('/libraries/activate', { method: 'POST', body: JSON.stringify({ id, interrupt }) })
}

export function renameLibrary({ id, name }) {
  return app('/libraries/rename', { method: 'POST', body: JSON.stringify({ id, name }) })
}

/** 只从列表移除，不会删除任何文件。 */
export function forgetLibrary({ id, confirmPath }) {
  return app('/libraries/forget', { method: 'POST', body: JSON.stringify({ id, confirmPath }) })
}

/** 准备共享目录：账号与通用设置从此所有空间共用一份。 */
export function shareLibraryAccounts({ sharedDir } = {}) {
  return app('/libraries/shared', { method: 'POST', body: JSON.stringify({ sharedDir }) })
}

/** 把某个资料空间添加为 DSH 工作区。 */
export function ensureLibraryWorkspace({ id, title } = {}) {
  return app('/libraries/workspace', { method: 'POST', body: JSON.stringify({ id, title }) })
}

export function openExternal(target, url) {
  return app('/open', { method: 'POST', body: JSON.stringify(url ? { target, url } : { target }) })
}

// ------------------------------------------------------------------ 更新

/** 当前版本、磁盘已安装版本、最新 Release 和更新任务。 */
export function updateStatus() {
  return app('/update')
}

/** 检查 GitHub 最新版本；autoInstall 为真时发现新版本会直接下载并安装。 */
export function updateCheck({ autoInstall = true } = {}) {
  return app('/update', {
    method: 'POST',
    body: JSON.stringify({ action: 'check', auto_install: Boolean(autoInstall) })
  })
}

/** 安装已经检查到的最新版本。 */
export function updateInstall() {
  return app('/update', { method: 'POST', body: JSON.stringify({ action: 'install' }) })
}

/** 把更新器留下的某个旧版本备份换回安装目录；不传版本时用最近的一份。 */
export function updateRollback(version = '') {
  return app('/update', {
    method: 'POST',
    body: JSON.stringify({ action: 'rollback', version: String(version || '') })
  })
}

export function updateCancel() {
  return app('/update', { method: 'POST', body: JSON.stringify({ action: 'cancel' }) })
}
