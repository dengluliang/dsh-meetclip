import fs from 'node:fs'
import path from 'node:path'
import { BackendManager } from './backend.js'
import { CardSyncManager } from './cards.js'
import { EnvironmentManager } from './setup.js'
import { FeishuManager } from './feishu.js'
import { UpdateManager } from './update.js'
import {
  ensureDir, packageVersion, publicLocations, readPrefs, resolveSettings
} from './config.js'
import {
  activeLibraryOf, canonicalPath, ensureSharedDir, readRegistry, recordDirectoryCount,
  summarizeLibrary, uniqueName, validateLibraryName, validateNewLibrary, writeMarker,
  writeRegistry
} from './libraries.js'
import { httpError, moveLibrary, validateDataDirSwitch } from './storage.js'

// 只有真的在跑/在排队的任务才拦切换；pending 只是建了记录还没开始。
const ACTIVE_STATUSES = new Set(['queued', 'recording', 'processing'])
const STOP_TIMEOUT_MS = 12_000

export class MeetClipRuntime {
  constructor(rawConfig) {
    this.rawConfig = rawConfig || {}
    this.settings = resolveSettings(this.rawConfig)
    this.backend = new BackendManager(this.settings)
    this.env = new EnvironmentManager(this.settings)
    this.feishu = new FeishuManager(this.settings)
    this.update = new UpdateManager(this.settings)
    this.cards = new CardSyncManager(this)
    // prefs.json 的读改写在进程内串行，避免并发建库/切换互相覆盖。
    this.prefsChain = Promise.resolve()
  }

  /** Host context, needed to tell whether a freshly written MCP row has loaded. */
  attach(ctx) {
    this.feishu.attach(ctx)
  }

  refresh() {
    this.settings = resolveSettings(this.rawConfig)
    this.backend.refresh(this.settings)
    this.env.refresh(this.settings)
    this.feishu.refresh(this.settings)
    this.update.refresh(this.settings)
    this.cards.reset()
    return this.settings
  }

  serialize(work) {
    const run = this.prefsChain.then(work, work)
    this.prefsChain = run.then(() => {}, () => {})
    return run
  }

  readRegistry() {
    return readRegistry(this.settings.stateDir)
  }

  /** 注册表行 + 目录现状 + 便宜的记录数；还没有落盘时把当前空间列成一条虚拟行。 */
  libraryRows(registry) {
    const rows = registry.libraries.map((entry) => ({
      ...summarizeLibrary(registry, entry),
      records: recordDirectoryCount(entry.dataDir)
    }))
    if (!rows.length && this.settings.library) {
      rows.push({
        id: this.settings.library.id,
        name: this.settings.library.name,
        dataDir: this.settings.dataDir,
        active: true,
        exists: fs.existsSync(this.settings.dataDir),
        hasLibrary: fs.existsSync(path.join(this.settings.dataDir, 'zhibo.db')),
        createdAt: null,
        lastOpenedAt: null,
        records: recordDirectoryCount(this.settings.dataDir),
        virtual: true
      })
    }
    return rows
  }

  /** 写注册表并立刻刷新设置，让后续调用看到新的激活空间。 */
  persist(registry) {
    writeRegistry(this.settings.stateDir, registry)
    this.refresh()
    return registry
  }

  async status() {
    const env = await this.env.status()
    const locations = publicLocations(this.settings)
    locations.venvReady = env.ready
    locations.dataDirWritable = writable(this.settings.dataDir)
    const registry = this.readRegistry()
    return {
      ok: true,
      version: packageVersion,
      backend: this.backend.status(),
      cards: this.cards.snapshot(),
      env,
      locations,
      library: {
        id: this.settings.library?.id || null,
        name: this.settings.library?.name || '',
        dataDir: this.settings.dataDir,
        virtual: Boolean(this.settings.library?.virtual)
      },
      libraries: this.libraryRows(registry),
      sharedDir: this.settings.sharedDir || null,
      prefs: readPrefs(this.settings.stateDir),
      config: {
        backendMode: this.settings.backendMode,
        autoStart: this.settings.autoStart,
        tools: this.settings.tools
      }
    }
  }

  // ---------------------------------------------------------------- 资料空间

  /**
   * 空间列表：注册表 + 目录现状 + 便宜的记录数。
   * 激活空间的记录数以引擎为准（读一次 /api/sessions），失败时回落到目录数。
   */
  async libraries() {
    const registry = this.readRegistry()
    const rows = this.libraryRows(registry)
    let liveRecords = null
    if (['running', 'starting'].includes(this.backend.state)) {
      try {
        const sessions = await this.backend.json('/api/sessions')
        if (Array.isArray(sessions)) liveRecords = sessions.length
      } catch {}
    }
    for (const row of rows) {
      if (row.active && liveRecords !== null) row.records = liveRecords
    }
    return {
      ok: true,
      active: registry.activeLibraryId,
      sharedDir: this.settings.sharedDir || registry.sharedDir || null,
      libraries: rows,
      virtual: Boolean(this.settings.library?.virtual),
      maxLibraries: 24
    }
  }

  /** 新建或收养一个资料空间；默认立刻切过去。 */
  async createLibrary(input = {}) {
    // 先只落注册表，再由 activateLibrary 统一负责停引擎/换目录/重启；
    // 否则 prefs 先指向新库而引擎还跑着旧目录，会短暂处于不一致状态。
    const created = await this.serialize(() => this.createLibrarySync({ ...input, activate: false }))
    if (input.activate === false) {
      return { ok: true, created: true, ...created, activated: false }
    }
    const activation = await this.activateLibrary({ id: created.library.id, interrupt: input.interrupt })
    return { ok: true, created: true, ...created, activated: true, ...activation }
  }

  /**
   * 把当前正在用的目录补进注册表。
   *
   * 首次安装时 dataDir 来自部署配置或默认值，注册表还是空的；这时如果直接切到
   * 另一个空间，原来的目录会从列表里消失。只收养「盘上真的存在」的目录，
   * 免得把还没创建的默认目录写成一条假空间。
   */
  ensureCurrentAdopted() {
    const registry = this.readRegistry()
    const current = this.settings.dataDir
    const canonical = canonicalPath(current)
    if (registry.libraries.some((row) => canonicalPath(row.dataDir) === canonical)) return registry
    if (!fs.existsSync(current)) return registry
    const entry = {
      id: this.settings.library?.id || libraryIdFor(current),
      name: this.settings.library?.name || defaultLibraryName(current),
      dataDir: current,
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    }
    return {
      ...registry,
      libraries: [entry, ...registry.libraries],
      activeLibraryId: registry.activeLibraryId || entry.id
    }
  }

  /**
   * 只做注册表层面的新建（同步、持锁）；不碰引擎。
   * 同一个目录重复「新建」是幂等的：返回已有条目，并按请求改名。
   */
  createLibrarySync(input = {}) {
    const registry = this.ensureCurrentAdopted()
    const existing = findLibraryAt(registry, input.dataDir || input.path || '')
    if (existing) {
      const renamed = input.name ? uniqueName(registry, input.name, existing.id) : existing.name
      const updated = { ...existing, name: renamed }
      writeMarker(updated.dataDir, updated)
      const libraries = registry.libraries.map((row) => (row.id === existing.id ? updated : row))
      this.persist({
        ...registry,
        libraries,
        activeLibraryId: input.activate === true ? existing.id : registry.activeLibraryId
      })
      return { library: updated, adopt: true, created: false, existing: true, name: renamed, sharing: null }
    }
    const validated = validateNewLibrary(registry, {
      name: input.name,
      dataDir: input.dataDir || input.path,
      force: input.force === true
    })
    ensureDir(validated.dataDir)
    const name = uniqueName(registry, validated.name, validated.id)
    const entry = {
      id: validated.id,
      name,
      dataDir: validated.dataDir,
      createdAt: validated.createdAt || Date.now(),
      lastOpenedAt: null
    }
    writeMarker(validated.dataDir, entry)
    const next = {
      ...registry,
      libraries: [...registry.libraries.filter((row) => row.id !== entry.id), entry]
    }
    // 第一次拥有多个空间时才准备共享目录：账号与通用设置从此只有一份。
    let sharing = null
    if (!next.sharedDir) {
      sharing = this.enableSharingSync(next, { sourceDir: this.settings.dataDir })
      next.sharedDir = sharing.sharedDir
    }
    next.activeLibraryId = input.activate === true ? entry.id : registry.activeLibraryId
    this.persist(next)
    return { library: entry, adopt: validated.adopt, sharing, name }
  }

  async renameLibrary({ id, name } = {}) {
    const targetId = String(id || '').trim()
    if (!targetId) throw httpError(400, 'library_id_required', '请选择要改名的资料空间')
    const next = validateLibraryName(name)
    return this.serialize(() => {
      const registry = this.readRegistry()
      const entry = registry.libraries.find((row) => row.id === targetId)
      if (!entry) throw httpError(404, 'library_not_found', '这个资料空间不在列表里')
      const renamed = { ...entry, name: uniqueName(registry, next, entry.id) }
      writeMarker(entry.dataDir, renamed)
      const libraries = registry.libraries.map((row) => (row.id === entry.id ? renamed : row))
      this.persist({ ...registry, libraries })
      return { ok: true, library: renamed }
    })
  }

  /**
   * 只从列表移除，不删任何文件。正在使用的空间不允许移除；
   * 盘上确实还有资料库时必须回传确认路径，避免误点。
   */
  async forgetLibrary({ id, confirmPath } = {}) {
    const targetId = String(id || '').trim()
    if (!targetId) throw httpError(400, 'library_id_required', '请选择要移除的资料空间')
    return this.serialize(() => {
      const registry = this.readRegistry()
      const entry = registry.libraries.find((row) => row.id === targetId)
      if (!entry) throw httpError(404, 'library_not_found', '这个资料空间不在列表里')
      if (entry.id === registry.activeLibraryId) {
        throw httpError(409, 'library_active', '正在使用的资料空间不能移除，请先切到另一个')
      }
      if (registry.libraries.length <= 1) {
        throw httpError(409, 'library_last', '至少保留一个资料空间')
      }
      if (fs.existsSync(entry.dataDir) && fs.existsSync(path.join(entry.dataDir, 'zhibo.db'))) {
        if (String(confirmPath || '') !== entry.dataDir) {
          const error = httpError(409, 'library_confirm_required', '移除前请确认这个空间的位置')
          error.detail = { dataDir: entry.dataDir }
          throw error
        }
      }
      const libraries = registry.libraries.filter((row) => row.id !== entry.id)
      this.persist({ ...registry, libraries })
      return { ok: true, removed: entry, deleted: false }
    })
  }

  /** 共享目录：账号与通用设置放这里，所有空间读同一份。 */
  async enableSharing({ sharedDir, sourceDir } = {}) {
    const result = await this.serialize(() => {
      const registry = this.readRegistry()
      const sharing = this.enableSharingSync(registry, { sharedDir, sourceDir })
      this.persist({ ...registry, sharedDir: sharing.sharedDir })
      return sharing
    })
    // 引擎在生成时读取共享目录环境变量，因此开启后必须重启才生效。
    const wasRunning = ['running', 'starting'].includes(this.backend.state)
    if (wasRunning) {
      try {
        await this.backend.restart()
        this.cards.reset()
        this.cards.sync().catch(() => {})
      } catch (error) {
        return { ...result, restarted: false, error: error?.message || String(error) }
      }
    }
    return { ...result, restarted: wasRunning }
  }

  enableSharingSync(registry, { sharedDir, sourceDir } = {}) {
    const target = sharedDir || registry.sharedDir || path.join(this.settings.stateDir, 'shared')
    return ensureSharedDir({ sharedDir: target, sourceDir: sourceDir || this.settings.dataDir })
  }

  async activateLibrary({ id, interrupt = false } = {}) {
    const targetId = String(id || '').trim()
    if (!targetId) throw httpError(400, 'library_id_required', '请选择要切换的资料空间')
    return this.serialize(() => this.activateLibraryInner(targetId, { interrupt: interrupt === true }))
  }

  /**
   * 切换激活空间：先确认没有正在跑的活（或用户确认中断），再停引擎、换目录、重启。
   * 任何一步失败都回滚 prefs 并尽量把原引擎拉回来。
   */
  async activateLibraryInner(targetId, { interrupt }) {
    const registry = this.ensureCurrentAdopted()
    const target = registry.libraries.find((row) => row.id === targetId)
    if (!target) throw httpError(404, 'library_not_found', '这个资料空间不在列表里')
    const previous = this.settings.dataDir
    if (target.id === registry.activeLibraryId && path.resolve(target.dataDir) === path.resolve(previous)) {
      return { ok: true, switched: false, library: target, dataDir: target.dataDir }
    }
    if (this.backend.attached) {
      throw httpError(409, 'library_locked',
        '本地引擎由外部进程托管（可能是 macOS 版会摘正在运行），请先退出它再切换资料空间')
    }
    if (!fs.existsSync(target.dataDir)) {
      throw httpError(409, 'library_missing',
        `资料空间「${target.name}」的位置不存在：${target.dataDir}。可能是目录被移动，或外置磁盘没有挂载`)
    }

    const work = await this.runningWork()
    if (work.length && !interrupt) {
      const error = httpError(409, 'library_busy', '还有采集或转写在跑，需要先停下来才能切换')
      error.detail = { work }
      throw error
    }
    const stopped = await this.interruptWork(work, { interrupt })
    const wasRunning = ['running', 'starting'].includes(this.backend.state)
    if (wasRunning) await this.backend.stop()
    try {
      const live = this.ensureCurrentAdopted()
      const libraries = live.libraries.map((row) => (
        row.id === target.id ? { ...row, lastOpenedAt: Date.now() } : row
      ))
      this.persist({ ...live, activeLibraryId: target.id, libraries })
      let cards = { skipped: wasRunning ? 'pending' : 'backend_down' }
      if (wasRunning) {
        await this.backend.ensure()
        this.cards.reset()
        cards = await this.cards.sync().catch((error) => ({ skipped: 'error', error: error?.message || String(error) }))
      }
      return {
        ok: true,
        switched: true,
        library: target,
        previous,
        dataDir: target.dataDir,
        restarted: wasRunning,
        stopped: stopped.stopped,
        interrupted: stopped.interrupted,
        cards
      }
    } catch (error) {
      try {
        const live = this.readRegistry()
        this.persist({ ...live, activeLibraryId: registry.activeLibraryId })
      } catch {}
      if (wasRunning) {
        try { await this.backend.ensure() } catch {}
      }
      throw error
    }
  }

  /** 引擎里的进行中任务；引擎没跑就当作没有。 */
  async runningWork() {
    if (!['running', 'starting'].includes(this.backend.state)) return []
    let rows
    try {
      rows = await this.backend.json('/api/sessions')
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    return rows
      .filter((row) => ACTIVE_STATUSES.has(row.status) || row.queue_position !== null && row.queue_position !== undefined)
      .map((row) => ({
        id: row.id,
        title: row.title || row.id,
        kind: row.kind || 'live',
        status: row.status,
        queue_position: row.queue_position ?? null
      }))
  }

  /**
   * 让采集干净收尾：直播采集直接杀进程会在下次启动时被标成「上次应用异常退出」，
   * 所以先走 /stop 让后端自己保存媒体，再等它离开 recording。
   */
  async interruptWork(work, { interrupt }) {
    if (!interrupt || !work.length) return { stopped: [], interrupted: false }
    const stopped = []
    for (const item of work) {
      if (item.status !== 'recording') continue
      try {
        await this.backend.json(`/api/sessions/${encodeURIComponent(item.id)}/stop`, {
          method: 'POST',
          body: '{}'
        })
        stopped.push(item.id)
      } catch {}
    }
    if (!stopped.length) return { stopped, interrupted: false }
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (Date.now() < deadline) {
      await delay(500)
      let rows
      try {
        rows = await this.backend.json('/api/sessions')
      } catch {
        return { stopped, interrupted: true }
      }
      const stillRunning = Array.isArray(rows)
        && rows.some((row) => stopped.includes(row.id) && row.status === 'recording')
      if (!stillRunning) return { stopped, interrupted: false }
    }
    return { stopped, interrupted: true }
  }

  async applyPrefs(patch) {
    if (this.backend.state === 'running' || this.backend.state === 'starting') {
      const error = new Error('请先停止本地引擎，再修改数据目录或端口')
      error.status = 409
      throw error
    }
    if (patch.dataDir !== undefined) {
      if (typeof patch.dataDir !== 'string' || !patch.dataDir.trim()) {
        const error = new Error('数据目录不能为空')
        error.status = 400
        throw error
      }
      const target = path.resolve(patch.dataDir.trim())
      if (!path.isAbsolute(target)) {
        const error = new Error('数据目录必须是绝对路径')
        error.status = 400
        throw error
      }
      try {
        fs.mkdirSync(target, { recursive: true })
        fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK)
      } catch (failure) {
        const error = new Error(`数据目录不可写：${failure?.message || failure}`)
        error.status = 400
        throw error
      }
      // 目录即资料空间：已存在就切过去，没有就收养/新建一个。
      await this.serialize(() => {
        const registry = this.readRegistry()
        const known = registry.libraries.find((row) => canonicalPath(row.dataDir) === canonicalPath(target))
        if (known) {
          const libraries = registry.libraries.map((row) => (
            row.id === known.id ? { ...row, lastOpenedAt: Date.now() } : row
          ))
          this.persist({ ...registry, activeLibraryId: known.id, libraries })
          return known
        }
        return this.createLibrarySync({ name: '', dataDir: target, force: true, activate: true })
      })
    }
    if (patch.port !== undefined) {
      const port = Number(patch.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        const error = new Error('端口必须是 1–65535 的整数')
        error.status = 400
        throw error
      }
      await this.serialize(() => {
        const registry = this.readRegistry()
        this.persist({ ...registry, port })
      })
    }
    return this.status()
  }

  /**
   * 兼容旧接口：把「存储位置」理解为「资料空间」。
   *
   * 校验与错误码仍然走 storage.js，回包字段（dataDir / previous / moved / restarted）
   * 也保持原样，老客户端与首次引导都不需要改；真正的落盘变成注册表的一次切换。
   * move=true 时先把当前空间整体搬到目标目录（同盘原子 rename），再切过去。
   */
  async switchDataDir({ path: rawPath, move = false } = {}) {
    const moving = move === true
    const target = validateDataDirSwitch(this.settings, rawPath, { move: moving })
    if (this.backend.attached) {
      throw httpError(409, 'storage_backend_external',
        '本地引擎由外部进程托管（可能是 macOS 版会摘正在运行），请先退出它再切换存储位置')
    }
    const registry = this.readRegistry()
    const previous = this.settings.dataDir
    const active = activeLibraryOf(registry) || this.settings.library || null

    if (!moving) {
      const known = findLibraryAt(registry, target)
      const activation = known
        ? await this.activateLibrary({ id: known.id })
        : await this.createLibrary({ name: '', dataDir: target, activate: false })
          .then((created) => this.activateLibrary({ id: created.library.id }))
      return {
        ...activation,
        dataDir: target,
        previous,
        moved: false,
        restarted: Boolean(activation.restarted)
      }
    }

    const duplicate = findLibraryAt(registry, target)
    if (duplicate) {
      throw httpError(409, 'library_exists', `这里已经是资料空间「${duplicate.name}」`)
    }
    const wasRunning = ['running', 'starting'].includes(this.backend.state)
    if (wasRunning) await this.backend.stop()
    let moved = false
    try {
      moveLibrary(previous, target)
      moved = true
      const live = this.readRegistry()
      const libraries = live.libraries.map((row) => (
        row.id === active?.id ? { ...row, dataDir: target, lastOpenedAt: Date.now() } : row
      ))
      if (!libraries.some((row) => row.id === active?.id)) {
        libraries.push({
          id: active?.id || canonicalPath(target),
          name: active?.name || '资料空间',
          dataDir: target,
          createdAt: Date.now(),
          lastOpenedAt: Date.now()
        })
      }
      this.persist({ ...live, activeLibraryId: active?.id || libraries[0].id, libraries })
      if (active?.id) {
        writeMarker(target, { id: active.id, name: active.name, createdAt: active.createdAt || Date.now() })
      }
      if (wasRunning) await this.backend.ensure()
      return {
        dataDir: target,
        previous,
        moved,
        restarted: wasRunning,
        status: await this.status()
      }
    } catch (error) {
      if (moved) {
        try { fs.renameSync(target, previous) } catch {}
      }
      try {
        const live = this.readRegistry()
        this.persist({
          ...live,
          activeLibraryId: registry.activeLibraryId,
          libraries: live.libraries.map((row) => (
            row.id === active?.id ? { ...row, dataDir: previous } : row
          ))
        })
      } catch {}
      if (wasRunning) {
        try { await this.backend.ensure() } catch {}
      }
      throw error
    }
  }

  async dispose() {
    try { this.cards.dispose() } catch {}
    try { this.feishu.dispose() } catch {}
    try { this.update.dispose() } catch {}
    try { await this.backend.dispose() } catch {}
  }
}

function findLibraryAt(registry, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null
  const wanted = canonicalPath(rawPath)
  return registry.libraries.find((row) => canonicalPath(row.dataDir) === wanted) || null
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writable(dir) {
  // A first-use data directory does not exist yet. Walk up to the nearest
  // existing ancestor instead of treating ENOENT as a permission failure;
  // otherwise a clean install reports "not writable" until the folder exists.
  let target = path.resolve(String(dir || '.'))
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const stat = fs.statSync(target)
      if (!stat.isDirectory()) return false
      fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK)
      return true
    } catch (error) {
      if (error?.code !== 'ENOENT') return false
      const parent = path.dirname(target)
      if (parent === target) return false
      target = parent
    }
  }
  return false
}
