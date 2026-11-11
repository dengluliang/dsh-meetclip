import path from 'node:path'
import { jsonResponse, readJsonBody, requireBrowser } from './http.js'
import { readLogTail } from './config.js'
import { openTarget, openUrl, pickFile, receiveUpload, revealSession } from './files.js'
import { receiveFallbackUpload } from './fallback.js'
import { FEISHU_DOC_URL, validOpenUrl } from './feishu.js'
import { createFeishuDocCard, previewFeishuDoc } from './doc-cards.js'
import { probeMimo } from './asr-probe.js'
import { probeModelCatalog, probeUsable } from './models-probe.js'
import { inspectDir } from './storage.js'
import { inspectLibraryDir } from './libraries.js'
import { ensureWorkspace, workspaceStatus } from './workspace.js'

export function registerAppRoutes(ctx, runtime) {
  runtime.attach(ctx)
  const definitions = [
    { path: '/meetclip/app/status', methods: { GET: handleStatus } },
    { path: '/meetclip/app/update', methods: { GET: handleUpdateStatus, POST: handleUpdateAction } },
    { path: '/meetclip/app/backend', methods: { POST: handleBackend } },
    { path: '/meetclip/app/logs', methods: { GET: handleLogs } },
    { path: '/meetclip/app/prefs', methods: { GET: handlePrefsGet, POST: handlePrefsSet } },
    { path: '/meetclip/app/data-dir/inspect', methods: { POST: handleDataDirInspect } },
    { path: '/meetclip/app/data-dir', methods: { POST: handleDataDirSwitch } },
    { path: '/meetclip/app/libraries', methods: { GET: handleLibraries, POST: handleLibraryCreate } },
    { path: '/meetclip/app/libraries/inspect', methods: { POST: handleLibraryInspect } },
    { path: '/meetclip/app/libraries/activate', methods: { POST: handleLibraryActivate } },
    { path: '/meetclip/app/libraries/rename', methods: { POST: handleLibraryRename } },
    { path: '/meetclip/app/libraries/forget', methods: { POST: handleLibraryForget } },
    { path: '/meetclip/app/libraries/shared', methods: { POST: handleLibraryShared } },
    { path: '/meetclip/app/libraries/workspace', methods: { POST: handleLibraryWorkspace } },
    { path: '/meetclip/app/workspace', methods: { GET: handleWorkspaceStatus, POST: handleWorkspaceEnsure } },
    { path: '/meetclip/app/setup', methods: { POST: handleSetup } },
    { path: '/meetclip/app/setup/status', methods: { GET: handleSetupStatus } },
    { path: '/meetclip/app/pick-file', methods: { POST: handlePickFile } },
    { path: '/meetclip/app/upload', methods: { POST: handleUpload } },
    { path: '/meetclip/app/fallback/upload', methods: { POST: handleFallbackUpload } },
    { path: '/meetclip/app/open', methods: { POST: handleOpen } },
    { path: '/meetclip/app/asr/test', methods: { POST: handleAsrTest } },
    { path: '/meetclip/app/models', methods: { POST: handleModels } },
    { path: '/meetclip/app/feishu/status', methods: { GET: handleFeishuStatus } },
    { path: '/meetclip/app/feishu/install', methods: { POST: handleFeishuInstall } },
    { path: '/meetclip/app/feishu/update', methods: { POST: handleFeishuUpdate } },
    { path: '/meetclip/app/feishu/login', methods: { POST: handleFeishuLogin } },
    { path: '/meetclip/app/feishu/logout', methods: { POST: handleFeishuLogout } },
    { path: '/meetclip/app/feishu/setup', methods: { POST: handleFeishuSetup } },
    { path: '/meetclip/app/feishu/probe', methods: { POST: handleFeishuProbe } },
    { path: '/meetclip/app/feishu/cancel', methods: { POST: handleFeishuCancel } },
    { path: '/meetclip/app/feishu/config', methods: { POST: handleFeishuConfig } },
    { path: '/meetclip/app/feishu/doc-card', methods: { POST: handleFeishuDocCard } },
    { path: '/meetclip/app/feishu/doc-preview', methods: { POST: handleFeishuDocPreview } }
  ]

  for (const definition of definitions) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: definition.path,
      handler: makeHandler(definition)
    }))
  }

  function makeHandler(definition) {
    return async (req, res) => {
      const rejection = requireBrowser(ctx, req)
      if (rejection) {
        jsonResponse(res, rejection, { detail: rejection === 401 ? '本地页面会话无效' : '请求来源不被信任' })
        return
      }
      const method = req.method === 'HEAD' && definition.methods.GET ? 'GET' : req.method
      const handler = definition.methods[method]
      if (!handler) {
        const allow = Object.keys(definition.methods).join(', ')
        jsonResponse(res, 405, { detail: `仅支持 ${allow}` }, { allow })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        if (res.headersSent) {
          try { res.end() } catch {}
          return
        }
        const status = error?.status && Number.isInteger(error.status) ? error.status : 500
        jsonResponse(res, status, {
          detail: error?.message || '请求失败',
          code: error?.code || 'error',
          hint: typeof error?.detail === 'string' ? error.detail : undefined
        })
      }
    }
  }

  async function handleStatus(_req, res) {
    jsonResponse(res, 200, await runtime.status())
  }

  async function handleUpdateStatus(_req, res) {
    jsonResponse(res, 200, runtime.update.status())
  }

  async function handleUpdateAction(req, res) {
    const body = await readJsonBody(req, 64 * 1024)
    const action = String(body.action || '')
    if (action === 'check') {
      // 「检查更新」只回报结果；下载安装必须显式带 auto_install: true，或用 install 动作。
      const job = runtime.update.startCheck({ autoInstall: body.auto_install === true })
      jsonResponse(res, 200, { ok: true, job })
      return
    }
    if (action === 'install') {
      const job = runtime.update.startInstall()
      jsonResponse(res, 200, { ok: true, job })
      return
    }
    if (action === 'rollback') {
      const job = runtime.update.startRollback(String(body.version || ''))
      jsonResponse(res, 200, { ok: true, job })
      return
    }
    if (action === 'cancel') {
      const result = runtime.update.cancel()
      jsonResponse(res, 200, { ok: true, ...result, job: runtime.update.jobSnapshot() })
      return
    }
    jsonResponse(res, 400, { detail: 'action 必须是 check / install / rollback / cancel' })
  }

  async function handleBackend(req, res) {
    const body = await readJsonBody(req)
    const action = String(body.action || '')
    if (!['start', 'stop', 'restart'].includes(action)) {
      jsonResponse(res, 400, { detail: 'action 必须是 start / stop / restart' })
      return
    }
    if (action === 'start') await runtime.backend.ensure()
    else if (action === 'stop') await runtime.backend.stop()
    else await runtime.backend.restart()
    if (action !== 'stop') {
      runtime.cards.reset()
      runtime.cards.sync().catch(() => {})
    }
    jsonResponse(res, 200, { ok: true, backend: runtime.backend.status(), env: await runtime.env.status() })
  }

  async function handleLogs(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const source = url.searchParams.get('source') === 'setup' ? 'setup' : 'backend'
    const lines = Math.max(10, Math.min(500, Number(url.searchParams.get('lines') || 200)))
    const text = source === 'setup'
      ? runtime.env.tail(lines)
      : readLogTail(runtime.settings.logPath, lines)
    jsonResponse(res, 200, { ok: true, source, lines, text })
  }

  async function handlePrefsGet(_req, res) {
    jsonResponse(res, 200, {
      ok: true,
      prefs: runtime.settings.prefs,
      effective: {
        dataDir: runtime.settings.dataDir,
        port: runtime.settings.port,
        stateDir: runtime.settings.stateDir,
        backendMode: runtime.settings.backendMode
      }
    })
  }

  async function handlePrefsSet(req, res) {
    const body = await readJsonBody(req)
    const status = await runtime.applyPrefs({
      dataDir: body.dataDir,
      port: body.port
    })
    jsonResponse(res, 200, { ok: true, status })
  }

  async function handleDataDirInspect(req, res) {
    const body = await readJsonBody(req)
    // Setup only needs the writability verdict; measuring a large existing
    // library would make the first-use dialog feel stuck.
    const measure = body.measure !== false
    jsonResponse(res, 200, { ok: true, ...inspectDir(runtime.settings, body.path, { measure }) })
  }

  async function handleLibraries(_req, res) {
    const payload = await runtime.libraries()
    const workspace = await workspaceStatus(ctx, runtime.settings.dataDir)
    jsonResponse(res, 200, {
      ...payload,
      activeWorkspace: workspace.workspace || null,
      workspaceAvailable: workspace.available !== false
    })
  }

  async function handleLibraryInspect(req, res) {
    const body = await readJsonBody(req)
    const registry = runtime.readRegistry()
    jsonResponse(res, 200, {
      ok: true,
      ...inspectLibraryDir(registry, body.path, { measure: body.measure === true })
    })
  }

  async function handleLibraryCreate(req, res) {
    const body = await readJsonBody(req)
    const result = await runtime.createLibrary({
      name: body.name,
      dataDir: body.dataDir || body.path,
      activate: body.activate !== false,
      force: body.force === true,
      interrupt: body.interrupt === true
    })
    jsonResponse(res, 200, { ok: true, ...result })
  }

  async function handleLibraryActivate(req, res) {
    const body = await readJsonBody(req)
    const result = await runtime.activateLibrary({ id: body.id, interrupt: body.interrupt === true })
    jsonResponse(res, 200, { ok: true, ...result, status: await runtime.status() })
  }

  async function handleLibraryRename(req, res) {
    const body = await readJsonBody(req)
    jsonResponse(res, 200, await runtime.renameLibrary({ id: body.id, name: body.name }))
  }

  async function handleLibraryForget(req, res) {
    const body = await readJsonBody(req)
    jsonResponse(res, 200, await runtime.forgetLibrary({ id: body.id, confirmPath: body.confirmPath }))
  }

  async function handleLibraryShared(req, res) {
    const body = await readJsonBody(req)
    const result = await runtime.enableSharing({ sharedDir: body.sharedDir, sourceDir: body.sourceDir })
    jsonResponse(res, 200, { ok: true, ...result, status: await runtime.status() })
  }

  async function handleLibraryWorkspace(req, res) {
    const body = await readJsonBody(req)
    const registry = runtime.readRegistry()
    const entry = registry.libraries.find((row) => row.id === String(body.id || ''))
      || registry.libraries.find((row) => row.id === registry.activeLibraryId)
    const target = entry ? entry.dataDir : runtime.settings.dataDir
    const result = await ensureWorkspace(ctx, target, body.title || entry?.name || '')
    const cards = entry?.active !== false
      ? await runtime.cards.sync().catch((error) => ({ skipped: 'error', error: error?.message || String(error) }))
      : { skipped: 'inactive' }
    jsonResponse(res, 200, { ok: true, path: target, ...result, cards })
  }

  async function handleDataDirSwitch(req, res) {
    const body = await readJsonBody(req)
    const result = await runtime.switchDataDir({ path: body.path, move: body.move === true })
    jsonResponse(res, 200, { ok: true, ...result })
  }

  async function handleWorkspaceStatus(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const target = url.searchParams.get('path') || runtime.settings.dataDir
    jsonResponse(res, 200, { ok: true, path: target, ...(await workspaceStatus(ctx, target)) })
  }

  async function handleWorkspaceEnsure(req, res) {
    const body = await readJsonBody(req)
    const target = typeof body.path === 'string' && body.path.trim()
      ? path.resolve(body.path.trim())
      : runtime.settings.dataDir
    const result = await ensureWorkspace(ctx, target, typeof body.title === 'string' ? body.title : '')
    // 工作区刚建好时就把卡片落盘；引擎未运行则跳过，@ 菜单/定时器之后会补。
    const cards = await runtime.cards.sync().catch((error) => ({
      skipped: 'error',
      error: error?.message || String(error)
    }))
    jsonResponse(res, 200, { ok: true, path: target, ...result, cards })
  }

  async function handleSetup(req, res) {
    const body = await readJsonBody(req)
    const action = String(body.action || '')
    if (action === 'cancel') {
      const cancelled = runtime.env.cancel()
      jsonResponse(res, 200, { ok: true, cancelled })
      return
    }
    if (runtime.backend.state === 'running' || runtime.backend.state === 'starting') {
      jsonResponse(res, 409, { detail: '请先停止本地引擎，再安装或更新运行环境' })
      return
    }
    jsonResponse(res, 200, { ok: true, job: await runtime.env.start(action) })
  }

  async function handleSetupStatus(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const force = url.searchParams.get('force') === '1'
    jsonResponse(res, 200, { ok: true, env: await runtime.env.status(force) })
  }

  async function handlePickFile(req, res) {
    const body = await readJsonBody(req)
    const kind = body.kind === 'directory' ? 'directory' : 'media'
    const result = await pickFile(kind, { multiple: kind === 'media' && body.multiple === true })
    jsonResponse(res, 200, result)
  }

  async function handleUpload(req, res) {
    await receiveUpload(req, res, runtime.settings)
  }

  async function handleFallbackUpload(req, res) {
    await receiveFallbackUpload(req, res, runtime)
  }

  async function handleAsrTest(req, res) {
    const body = await readJsonBody(req, 64 * 1024)
    try {
      const result = await probeMimo({
        apiKey: body.api_key,
        baseUrl: body.base_url,
        model: body.model
      })
      jsonResponse(res, 200, result)
    } catch (error) {
      jsonResponse(res, 502, { detail: error?.message || '云端语音测试失败' })
    }
  }

  async function handleModels(req, res) {
    const body = await readJsonBody(req, 256 * 1024)
    try {
      // probe=true：逐个验证候选模型是否真能用（首次引导在后端启动前就要跑）。
      const result = body.probe
        ? await probeUsable({
            apiKey: body.api_key,
            baseUrl: body.base_url,
            models: body.models
          })
        : await probeModelCatalog({
            apiKey: body.api_key,
            baseUrl: body.base_url
          })
      jsonResponse(res, 200, result)
    } catch (error) {
      jsonResponse(res, 502, { detail: error?.message || '获取模型列表失败' })
    }
  }

  async function handleFeishuStatus(_req, res) {
    jsonResponse(res, 200, await runtime.feishu.status())
  }

  async function handleFeishuInstall(_req, res) {
    jsonResponse(res, 200, { ok: true, job: runtime.feishu.start('install') })
  }

  async function handleFeishuUpdate(_req, res) {
    jsonResponse(res, 200, { ok: true, job: runtime.feishu.start('update') })
  }

  async function handleFeishuLogin(req, res) {
    const body = await readJsonBody(req, 64 * 1024)
    const mode = body.mode === 'device' ? 'device' : 'auto'
    jsonResponse(res, 200, { ok: true, job: runtime.feishu.start('login', { mode }) })
  }

  async function handleFeishuLogout(_req, res) {
    jsonResponse(res, 200, { ok: true, job: runtime.feishu.start('logout') })
  }

  async function handleFeishuSetup(_req, res) {
    jsonResponse(res, 200, { ok: true, job: runtime.feishu.start('setup') })
  }

  async function handleFeishuProbe(_req, res) {
    jsonResponse(res, 200, { ok: true, job: runtime.feishu.start('probe') })
  }

  async function handleFeishuCancel(_req, res) {
    jsonResponse(res, 200, { ok: true, cancelled: runtime.feishu.cancel() })
  }

  async function handleFeishuConfig(req, res) {
    const body = await readJsonBody(req, 64 * 1024)
    const action = String(body.action || '')
    if (action === 'remove') {
      const removed = runtime.feishu.removeEntry()
      jsonResponse(res, 200, { ok: true, ...removed, status: await runtime.feishu.status() })
      return
    }
    if (action === 'add') {
      const version = runtime.feishu.readState().version || ''
      if (!version) {
        jsonResponse(res, 409, { detail: '还没有安装记录，请先点「一键安装并配置」' })
        return
      }
      const added = runtime.feishu.writeEntry(version)
      jsonResponse(res, 200, { ok: true, ...added, status: await runtime.feishu.status() })
      return
    }
    jsonResponse(res, 400, { detail: 'action 必须是 add / remove' })
  }

  /** 预读飞书文档标题/正文长度，给表单自动填标题；不写卡片。 */
  async function handleFeishuDocPreview(req, res) {
    const body = await readJsonBody(req, 64 * 1024)
    try {
      const result = await previewFeishuDoc({
        tools: ctx.get('tools'),
        url: body.url
      })
      jsonResponse(res, 200, result)
    } catch (error) {
      if (error?.name === 'DocCardError') {
        jsonResponse(res, error.status || 500, {
          ok: false,
          code: error.code || 'doc_preview_failed',
          detail: error.message,
          hint: error.hint || undefined
        })
        return
      }
      throw error
    }
  }

  /**
   * 把一条飞书文档链接登记成会摘卡片。正文优先走已配置的飞书 MCP；
   * 读不到时仍允许落一张「仅链接」卡片，由界面提示原因。
   */
  async function handleFeishuDocCard(req, res) {
    const body = await readJsonBody(req, 256 * 1024)
    try {
      const result = await createFeishuDocCard({
        tools: ctx.get('tools'),
        backend: runtime.backend,
        url: body.url,
        title: body.title,
        linkOnly: body.link_only === true
      })
      jsonResponse(res, 200, result)
    } catch (error) {
      if (error?.name === 'DocCardError') {
        jsonResponse(res, error.status || 500, {
          ok: false,
          code: error.code || 'doc_card_failed',
          detail: error.message,
          hint: error.hint || undefined
        })
        return
      }
      throw error
    }
  }

  async function handleOpen(req, res) {
    const body = await readJsonBody(req, 64 * 1024)
    const target = String(body.target || '')
    if (target === 'feishu-doc') {
      const result = await openUrl(FEISHU_DOC_URL)
      jsonResponse(res, result.ok ? 200 : 400, result)
      return
    }
    if (target === 'url') {
      const url = String(body.url || '')
      if (!validOpenUrl(url)) {
        jsonResponse(res, 400, { ok: false, error: '这个链接不允许直接打开' })
        return
      }
      const result = await openUrl(url)
      jsonResponse(res, result.ok ? 200 : 400, result)
      return
    }
    const result = target === 'record'
      ? await revealSession(runtime.settings, body.sessionId)
      : await openTarget(runtime.settings, target)
    jsonResponse(res, result.ok ? 200 : 400, result)
  }
}
