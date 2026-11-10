import {
  feishuCancel, feishuConfig, feishuInstall, feishuLogin, feishuLogout, feishuProbe,
  feishuSetup, feishuStatus, feishuUpdate, openExternal
} from './api.js'

const RUNNING_POLL_MS = 1200
const IDLE_POLL_MS = 20000

function describeFailure(failure) {
  if (failure?.status === 404) return '宿主还没重新加载：退出并重新打开 DeepSeek Harness，或在插件管理里禁用再启用一次「会摘」'
  if (failure?.status === 409) return failure.message
  return failure?.message || String(failure)
}

/**
 * Shared state for the Feishu MCP onboarding: one status snapshot plus the
 * action helpers, polled while a host job is running so the log and the
 * authorization link stay live.
 */
export function useFeishu({ enabled = true } = {}) {
  const [status, setStatus] = React.useState(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const mounted = React.useRef(true)
  React.useEffect(() => () => { mounted.current = false }, [])

  const apply = React.useCallback((next) => {
    if (!mounted.current) return
    if (next && next.ok) setStatus(next)
  }, [])

  const load = React.useCallback(async ({ quiet = true } = {}) => {
    if (!enabled) return null
    if (!quiet) setBusy('status')
    try {
      const next = await feishuStatus()
      apply(next)
      if (mounted.current) setError('')
      return next
    } catch (failure) {
      if (mounted.current) setError(describeFailure(failure))
      return null
    } finally {
      if (mounted.current && !quiet) setBusy('')
    }
  }, [apply, enabled])

  React.useEffect(() => { load({ quiet: false }) }, [load])

  const jobRunning = status?.job?.state === 'running'
  React.useEffect(() => {
    if (!enabled) return undefined
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, jobRunning ? RUNNING_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, jobRunning, load])

  async function run(label, operation) {
    if (busy) return null
    setBusy(label)
    setError('')
    setNotice('')
    try {
      return await operation()
    } catch (failure) {
      if (mounted.current) setError(describeFailure(failure))
      return null
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  async function start(action, extra = {}) {
    const result = await run(action, async () => {
      const response = await extra.call()
      if (response?.job) apply({ ...(status || {}), ok: true, job: response.job })
      return response
    })
    await load()
    return result
  }

  const actions = {
    status: () => run('status', async () => apply(await feishuStatus())),
    install: () => start('install', { call: feishuInstall }),
    update: () => start('update', { call: feishuUpdate }),
    login: (mode = 'auto') => start('login', { call: () => feishuLogin(mode) }),
    logout: () => start('logout', { call: feishuLogout }),
    setup: () => start('setup', { call: feishuSetup }),
    probe: () => start('probe', { call: feishuProbe }),
    cancel: () => run('cancel', async () => {
      await feishuCancel()
      await load()
    }),
    removeConfig: () => run('remove', async () => {
      const result = await feishuConfig('remove')
      if (result?.status) apply(result.status)
      setNotice(result?.changed
        ? '已从 DSH 配置中移除飞书 MCP'
        : result?.scope === 'profile'
          ? `这段配置写在 profile 补丁里（${result.path}），请手动编辑移除`
          : 'DSH 配置里没有找到这段，未做改动')
      return result
    }),
    openDoc: () => openExternal('feishu-doc').catch(() => ({ ok: false })),
    openUrl: (url) => openExternal('url', url).catch(() => ({ ok: false }))
  }

  return { status, error, busy, notice, setNotice, load, actions }
}

export function formatDate(seconds) {
  const value = Number(seconds)
  if (!value) return ''
  try {
    return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

/**
 * One-line answer for "is this usable right now?". `detail` only shows up when
 * the user has to do something the line itself cannot say.
 */
export function feishuSummary(status) {
  if (!status) return { tone: 'pending', text: '读取中…' }
  const auth = status.auth || {}
  const dsh = status.dsh || {}
  const runtime = status.runtime || {}
  const pkg = status.package || {}
  // 包名与 npm 源不随插件发布：没配就直说要配在哪，而不是报「未安装」。
  if (!pkg.configured && !dsh.entryPresent) {
    return {
      tone: 'pending',
      text: '未配置 MCP 源',
      detail: '在 cordis.patch.yml 的 meetclip config 里填 feishuPackage 与 feishuRegistry（你组织的飞书 MCP 包名与 npm 源），再回来安装。'
    }
  }
  if (dsh.conflict) {
    return { tone: 'error', text: '配置冲突', detail: `serverName「${dsh.serverName}」已有其他条目在用` }
  }
  if (!runtime.npxOk) return { tone: 'error', text: '需要 Node.js 20+', detail: '没有找到 npx，装好 Node.js 后重试' }
  if (!runtime.nodeOk) {
    return {
      tone: 'error',
      text: '需要 Node.js 20+',
      detail: runtime.node ? `当前 Node ${runtime.nodeVersion}，需要 20 以上` : '装好 Node.js 后重试'
    }
  }
  if (!dsh.entryPresent) return { tone: 'pending', text: '未安装' }
  if (!auth.loggedIn) {
    return auth.expired
      ? { tone: 'warn', text: '登录已过期', detail: '重新登录后恢复' }
      : { tone: 'warn', text: '未登录' }
  }
  if (dsh.entryLive === false) return { tone: 'warn', text: '等待生效', detail: '配置已写入，DSH 正在载入' }
  if (dsh.entryLive === null) return { tone: 'warn', text: '已配置', detail: '如果 Agent 还用不了，重启 DeepSeek Harness' }
  return { tone: 'ok', text: '可以使用' }
}
