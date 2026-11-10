import { openExternal, updateCancel, updateCheck, updateInstall, updateStatus } from './api.js'

const RUNNING_STATES = new Set(['checking', 'downloading', 'verifying', 'installing'])
const RUNNING_POLL_MS = 1200
const IDLE_POLL_MS = 30_000
const DEFAULT_REPO = 'dengluliang/dsh-meetclip'

export function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let amount = bytes / 1024
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  const digits = amount >= 10 ? 0 : 1
  return `${amount.toFixed(digits)} ${units[index]}`
}

export function formatSpeed(value) {
  const bytes = Number(value)
  return bytes > 0 ? `${formatBytes(bytes)}/s` : ''
}

export function formatDate(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return ''
  try {
    return new Date(number).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

export function progressPercent(job) {
  if (job?.percent === null || job?.percent === undefined || job?.percent === '') return null
  const value = Number(job.percent)
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/** Human-readable secondary line under the progress bar. */
export function progressDetail(job) {
  if (!job) return ''
  if (job.state === 'downloading' && job.total > 0) {
    const received = formatBytes(job.received)
    const total = formatBytes(job.total)
    const speed = formatSpeed(job.speed)
    return `${received} / ${total}${speed ? ` · ${speed}` : ''}`
  }
  if (job.state === 'downloading' && job.received > 0) {
    return formatBytes(job.received)
  }
  return job.message || ''
}

/** Title + detail + tone for the one-line status above the buttons. */
export function updateSummary(status) {
  if (!status) return { tone: 'pending', text: '读取版本信息…', detail: '' }
  const job = status.job
  if (job && RUNNING_STATES.has(job.state)) {
    const percent = progressPercent(job)
    const suffix = percent === null ? '' : ` ${percent.toFixed(1)}%`
    return { tone: 'pending', text: `${job.phase || '更新中'}${suffix}`, detail: '' }
  }
  if (job?.state === 'error') {
    return { tone: 'error', text: '更新失败', detail: job.error || job.message || '请重试' }
  }
  if (job?.state === 'cancelled') {
    return { tone: 'warn', text: '更新已取消', detail: '已下载的临时文件已清理' }
  }
  if (status.restartRequired) {
    return {
      tone: 'warn',
      text: `已安装 v${status.installedVersion || '?'}`,
      detail: ''
    }
  }
  if (status.updateAvailable && status.latest) {
    return { tone: 'warn', text: `发现新版本 v${status.latest.version}`, detail: '点击「立即更新」或重新检查' }
  }
  if (status.latest) {
    return { tone: 'ok', text: `已是最新版本 v${status.currentVersion}`, detail: '' }
  }
  return { tone: 'pending', text: '还没有检查过更新', detail: '' }
}

export function isUpdateRunning(status) {
  return Boolean(status?.job && RUNNING_STATES.has(status.job.state))
}

function describeFailure(failure) {
  if (failure?.status === 404) return '宿主还没有载入更新接口，请重启 DeepSeek Harness 后重试'
  if (failure?.status === 409) return failure.message || '已有更新任务在进行'
  if (failure?.status === 401 || failure?.status === 403) return failure.message || '本地页面会话无效，请刷新页面'
  return failure?.message || String(failure)
}

/**
 * One status snapshot plus the actions that drive it. Polls while a host job is
 * running so the progress bar, the phase text and the final result stay live.
 */
export function useUpdate({ enabled = true } = {}) {
  const [status, setStatus] = React.useState(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const mounted = React.useRef(true)

  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const apply = React.useCallback((next) => {
    if (mounted.current && next && next.ok) setStatus(next)
  }, [])

  const load = React.useCallback(async ({ quiet = true } = {}) => {
    if (!enabled) return null
    if (!quiet) setBusy('status')
    try {
      const next = await updateStatus()
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

  React.useEffect(() => {
    let cancelled = false
    load({ quiet: false }).then(() => { if (cancelled) return })
    return () => { cancelled = true }
  }, [load])

  const running = isUpdateRunning(status)
  React.useEffect(() => {
    if (!enabled) return undefined
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load()
    }, running ? RUNNING_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, running, load])

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

  async function start(action, call) {
    const result = await run(action, async () => {
      const response = await call()
      if (response?.job) apply({ ...(status || {}), ok: true, job: response.job })
      return response
    })
    await load()
    return result
  }

  const actions = {
    refresh: () => run('status', () => load({ quiet: false })),
    // A source checkout must not be overwritten; it still gets the check result.
    check: () => start('check', () => updateCheck({ autoInstall: status?.target?.kind !== 'source' })),
    install: () => start('install', updateInstall),
    cancel: () => run('cancel', async () => {
      const result = await updateCancel()
      if (result?.status === 'too-late') {
        if (mounted.current) setNotice('正在安装，已经不能取消')
      }
      await load()
      return result
    }),
    openRepo: () => openExternal('url', `https://github.com/${status?.repo || DEFAULT_REPO}`).catch(() => ({ ok: false })),
    openRelease: () => {
      const url = status?.latest?.url
      return url ? openExternal('url', url).catch(() => ({ ok: false })) : Promise.resolve({ ok: false })
    }
  }

  return { status, error, busy, notice, setNotice, load, actions }
}
