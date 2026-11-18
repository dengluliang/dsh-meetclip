import {
  backupCancel, backupCatalog, backupExport, backupImport, backupInspect, backupJob,
  pickFile, revealFilePath
} from '../lib/api.js'
import { bumpRevision } from '../lib/status-bus.js'
import {
  emptySelection, estimate as estimateSelection, hasAnyMedia, indexCatalog, itemsForApi,
  selectAllCards, setGroup, summary as summarize, toggle
} from '../lib/backup.js'
import { ExportPanel } from './backup/ExportPanel.jsx'
import { ImportPanel } from './backup/ImportPanel.jsx'

/**
 * 设置 → 备份：导出选中的卡片给另一个人，或把别人发来的备份导入当前资料空间。
 *
 * 导出/导入都在后端后台线程里跑（同一时刻只允许一个），这里只负责选择、起任务、
 * 轮询进度与展示结果。导入完成后通过 status-bus 让首页立即刷新，不必等 30 秒轮询。
 */
export function SettingsBackup({ t, onClose = null }) {
  const [catalog, setCatalog] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState('')
  const [selection, setSelection] = React.useState(() => emptySelection())
  const [query, setQuery] = React.useState('')
  const [includeMedia, setIncludeMedia] = React.useState(false)
  const [dest, setDest] = React.useState('')
  const [job, setJob] = React.useState(null)
  const [notice, setNotice] = React.useState('')
  const [importPath, setImportPath] = React.useState('')
  const [inspect, setInspect] = React.useState(null)
  const [inspectError, setInspectError] = React.useState('')
  const [inspecting, setInspecting] = React.useState(false)
  const [includeMediaImport, setIncludeMediaImport] = React.useState(true)
  const [skipExisting, setSkipExisting] = React.useState(true)
  const [picking, setPicking] = React.useState('')
  const handledJob = React.useRef('')

  const index = React.useMemo(() => indexCatalog(catalog || {}), [catalog])
  const summary = React.useMemo(() => summarize(selection, index), [selection, index])
  const estimate = React.useMemo(
    () => estimateSelection(selection, index, includeMedia), [selection, index, includeMedia]
  )
  const mediaAvailable = React.useMemo(
    () => hasAnyMedia(selection, index), [selection, index]
  )
  const libraryName = catalog?.library?.name || ''

  const loadCatalog = React.useCallback(async () => {
    setLoading(true)
    try {
      const data = await backupCatalog()
      setCatalog(data)
      setDest((current) => current || data?.default_dest || '')
      setLoadError('')
    } catch (failure) {
      setLoadError(failure?.message || String(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    loadCatalog()
    backupJob().then((data) => {
      const next = data?.job
      if (next && next.state === 'running') setJob(next)
    }).catch(() => {})
  }, [loadCatalog])

  // 任务在跑时轮询；页面关掉再打开也能从 GET /api/backup/job 接回进度。
  React.useEffect(() => {
    if (job?.state !== 'running') return undefined
    let stopped = false
    const timer = setInterval(async () => {
      try {
        const data = await backupJob()
        if (stopped) return
        if (data?.job) setJob(data.job)
      } catch {}
    }, 600)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [job?.id, job?.state])

  React.useEffect(() => {
    if (!job || job.state !== 'done' || handledJob.current === job.id) return
    handledJob.current = job.id
    if (job.action === 'import') {
      bumpRevision()
      setInspect(null)
      setImportPath('')
      loadCatalog()
    }
  }, [job, loadCatalog])

  async function pickDest() {
    setPicking('dest')
    setNotice('')
    try {
      const result = await pickFile('directory')
      if (result?.ok && result.path) setDest(result.path)
      else if (!result?.cancelled) setNotice(result?.error || '选择文件夹失败')
    } catch (failure) {
      setNotice(failure?.message || String(failure))
    } finally {
      setPicking('')
    }
  }

  async function runInspect(nextPath) {
    const text = String(nextPath || importPath || '').trim()
    if (!text) return
    setInspecting(true)
    setInspectError('')
    try {
      const data = await backupInspect(text)
      setInspect(data)
      setImportPath(data?.path || text)
      setIncludeMediaImport(Boolean(data?.media_included))
      setSkipExisting(true)
    } catch (failure) {
      setInspect(null)
      setInspectError(failure?.message || String(failure))
    } finally {
      setInspecting(false)
    }
  }

  async function pickBackup() {
    setPicking('backup')
    setInspectError('')
    setNotice('')
    try {
      const result = await pickFile('backup')
      if (result?.ok && result.path) {
        await runInspect(result.path)
      } else if (!result?.cancelled) {
        setInspectError(result?.error || '选择备份文件失败')
      }
    } catch (failure) {
      setInspectError(failure?.message || String(failure))
    } finally {
      setPicking('')
    }
  }

  async function startExport() {
    if (!summary.selected) return
    setNotice('')
    try {
      const data = await backupExport({
        dest,
        include_media: Boolean(includeMedia) && mediaAvailable,
        items: itemsForApi(selection)
      })
      if (data?.job) setJob(data.job)
    } catch (failure) {
      setNotice(failure?.message || String(failure))
    }
  }

  async function startImport() {
    if (!inspect) return
    setInspectError('')
    try {
      const mediaBytes = Number(inspect?.media_bytes) || 0
      const data = await backupImport({
        path: importPath,
        include_media: Boolean(includeMediaImport) && mediaBytes > 0,
        skip_existing: Boolean(skipExisting)
      })
      if (data?.job) setJob(data.job)
    } catch (failure) {
      setInspectError(failure?.message || String(failure))
    }
  }

  async function cancel() {
    try {
      const data = await backupCancel()
      if (data?.job) setJob(data.job)
    } catch (failure) {
      setNotice(failure?.message || String(failure))
    }
  }

  async function reveal(path) {
    try {
      const result = await revealFilePath(path)
      if (result && result.ok === false) setNotice(result.error || '无法打开 Finder')
    } catch (failure) {
      setNotice(failure?.message || String(failure))
    }
  }

  function selectAll() {
    if (catalog) setSelection(selectAllCards(catalog))
  }

  function clear() {
    setSelection(emptySelection())
  }

  function onToggle(type, id) {
    setSelection((current) => toggle(current, type, id))
  }

  function onGroupChange(type, ids, checked) {
    setSelection((current) => setGroup(current, type, ids, checked))
  }

  function resetImport() {
    setInspect(null)
    setInspectError('')
    setImportPath('')
    if (job?.action === 'import' && job.state !== 'running') setJob(null)
  }

  function closeAndRefresh() {
    bumpRevision()
    onClose?.()
  }

  const busy = Boolean(picking) || (job?.state === 'running')

  if (loading && !catalog) {
    return (
      <div className="mc-settings-panel">
        <p className="mc-foot-meta">正在读取可备份的卡片…</p>
      </div>
    )
  }

  if (!catalog) {
    return (
      <div className="mc-settings-panel">
        <div className="mc-card">
          <div className="mc-section-title">备份</div>
          <p className="mc-error-text" role="alert">{loadError || '读取资料库失败'}</p>
          <div className="mc-actions">
            <button type="button" className="mc-button" onClick={loadCatalog}>重试</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mc-settings-panel mc-backup-panel">
      <ExportPanel
        catalog={catalog} index={index} selection={selection} summary={summary}
        estimate={estimate} query={query} onQuery={setQuery}
        includeMedia={includeMedia} onIncludeMedia={setIncludeMedia}
        mediaAvailable={mediaAvailable} dest={dest} onChangeDest={pickDest}
        onSelectAll={selectAll} onClear={clear}
        onToggle={onToggle} onGroupChange={onGroupChange}
        onExport={startExport} job={job} onCancel={cancel} onReveal={reveal}
      />
      <ImportPanel
        libraryName={libraryName} path={importPath} onPath={setImportPath}
        onPick={pickBackup} onInspect={() => runInspect()} inspecting={inspecting}
        inspect={inspect} error={inspectError}
        includeMedia={includeMediaImport} onIncludeMedia={setIncludeMediaImport}
        skipExisting={skipExisting} onSkipExisting={setSkipExisting}
        onStart={startImport} onReset={resetImport}
        job={job} onCancel={cancel} onClose={closeAndRefresh}
        busy={busy || Boolean(picking)}
      />
      <p className="mc-foot-meta">
        备份是普通 zip 文件，只包含选中的卡片内容；不含账号 Cookie、模型 Key、插件设置与本机路径。
        导入只会写到当前资料空间，不会合并或覆盖另一个空间。
      </p>
      {notice ? <p className="mc-error-text" role="alert">{notice}</p> : null}
    </div>
  )
}
