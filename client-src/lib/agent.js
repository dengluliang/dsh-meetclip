import { ensureWorkspace, workspaceStatus } from './api.js'

// DSH 客户端桥：把首页 Hero 的一段原文送到会摘默认工作区的新会话里，
// 然后切到那个会话。这里只依赖 sessions / uiWorkspace 两个客户端服务，
// 老 shell 缺服务时保持静默降级，由 Hero 显示可操作的错误。
const SOURCE = 'meetclip'
const DEFAULT_API = { workspaceStatus, ensureWorkspace }

export class AgentBridgeError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'AgentBridgeError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

let active = null

/** 安装当前桥；返回的清理函数只清理自己安装的那一座，避免热更新误清新桥。 */
export function installAgentBridge(bridge) {
  active = bridge || null
  return () => {
    if (active === bridge) active = null
  }
}

export function agentBridgeAvailable() {
  return Boolean(active)
}

/** Hero 统一入口：去掉首尾空白后按原文发送。 */
export async function sendPromptToAgent(text, { path = '' } = {}) {
  const value = String(text ?? '').trim()
  if (!value) throw new AgentBridgeError('empty', '还没有输入内容。')
  if (!active) {
    throw new AgentBridgeError('unavailable', '当前界面不支持把内容发给会摘 Agent，请在 DSH Web 中使用。')
  }
  return active.send(value, { path })
}

/**
 * 用 DSH 客户端服务组装「建会话 → 发原文 → 打开会话」。
 * `api` 可注入，单测不需要真的打 Host 接口。
 */
export function createAgentBridge({ sessions, uiWorkspace, api = DEFAULT_API } = {}) {
  return {
    async send(text, { path = '' } = {}) {
      const value = String(text ?? '').trim()
      if (!value) throw new AgentBridgeError('empty', '还没有输入内容。')
      if (!sessions || typeof sessions.create !== 'function' || typeof uiWorkspace?.openSession !== 'function') {
        throw new AgentBridgeError('unavailable', '当前界面不支持把内容发给会摘 Agent，请在 DSH Web 中使用。')
      }
      const dataDir = String(path || '').trim()
      if (!dataDir) {
        throw new AgentBridgeError('no-data-dir', '找不到会摘的数据目录，无法定位默认工作区。')
      }

      const workspace = await resolveWorkspace(api, dataDir)
      let sessionId
      try {
        sessionId = await sessions.create({ workspaceId: workspace.id })
      } catch (failure) {
        throw new AgentBridgeError('session-create', `无法新建 Agent 会话：${errorMessage(failure)}`, failure)
      }
      if (!sessionId) {
        throw new AgentBridgeError('session-create', '无法新建 Agent 会话：DSH 没有返回会话 id。')
      }

      try {
        await withSession(sessions, sessionId, async (reference) => {
          const session = reference?.binding?.session
          if (!session || typeof session.prompt !== 'function') {
            throw new AgentBridgeError('session-prompt', '当前 DSH 会话不支持发送消息。')
          }
          const result = await session.prompt([{ type: 'text', text: value }], 'queue')
          if (result && result.ok === false) {
            throw new AgentBridgeError('prompt', `Agent 没有接受这条内容：${errorMessage(result.error)}`, result.error)
          }
        })
      } catch (failure) {
        if (failure instanceof AgentBridgeError) throw failure
        throw new AgentBridgeError('prompt', `发送给 Agent 失败：${errorMessage(failure)}`, failure)
      }

      try {
        uiWorkspace.openSession(sessionId)
      } catch (failure) {
        throw new AgentBridgeError(
          'open',
          `内容已经发出，但没能自动打开会话；请在左侧栏打开它。${errorMessage(failure)}`,
          failure
        )
      }
      return { sessionId }
    }
  }
}

async function resolveWorkspace(api, path) {
  let info
  try {
    info = await api.workspaceStatus(path)
  } catch (failure) {
    throw new AgentBridgeError('workspace', `无法读取会摘工作区：${errorMessage(failure)}`, failure)
  }
  if (info?.available === false) {
    throw new AgentBridgeError('unsupported', '当前 DSH 不支持从会摘创建工作区。')
  }
  if (info?.workspace?.id) return info.workspace

  let ensured
  try {
    ensured = await api.ensureWorkspace({ path })
  } catch (failure) {
    throw new AgentBridgeError('workspace', `无法打开会摘工作区：${errorMessage(failure)}`, failure)
  }
  const workspace = ensured?.workspace
  if (!workspace?.id) {
    throw new AgentBridgeError('workspace', '无法定位会摘的工作区。')
  }
  return workspace
}

/** 优先用 sessions.using（自带 ready 等待与 release）；老版本回落到 retain。 */
async function withSession(sessions, sessionId, operation) {
  if (typeof sessions.using === 'function') {
    return sessions.using(sessionId, { source: SOURCE }, operation)
  }
  if (typeof sessions.retain !== 'function') {
    throw new AgentBridgeError('unavailable', '当前 DSH 不支持打开 Agent 会话。')
  }
  const reference = sessions.retain(sessionId, { source: SOURCE })
  try {
    if (reference?.ready && typeof reference.ready.then === 'function') await reference.ready
    return await operation(reference)
  } finally {
    try { reference?.release?.() } catch {}
  }
}

function errorMessage(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  const value = error.message || error.detail || error.code
  return value ? String(value) : String(error)
}
