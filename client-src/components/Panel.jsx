import { activateLibrary, status } from '../lib/api.js'
import {
  beginEngineRestart, endEngineRestart, getLibraryHint, getStatusSignal,
  subscribeLibraryHint, subscribeStatusSignal
} from '../lib/status-bus.js'
import { busyWorkText } from '../lib/libraries.js'
import { LibraryPanel } from './libraries/LibraryPanel.jsx'
import { RecordsBrowser } from './RecordsBrowser.jsx'
import { NewCaptureDialog } from './NewCaptureDialog.jsx'
import { GlobalSearchDialog } from './GlobalSearchDialog.jsx'
import { TopBar } from './shell/TopBar.jsx'
import { HomePage } from './home/HomePage.jsx'
import { SetupWizard } from './SetupWizard.jsx'

export function Panel({ t }) {
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [revision, setRevision] = React.useState(0)
  const [view, setView] = React.useState('home')
  const [newOpen, setNewOpen] = React.useState(false)
  const [newInitialUrl, setNewInitialUrl] = React.useState('')
  const [newInitialKind, setNewInitialKind] = React.useState('')
  const [batchFocus, setBatchFocus] = React.useState(null)
  const [homeRevision, setHomeRevision] = React.useState(0)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [focus, setFocus] = React.useState(null)
  const [notice, setNotice] = React.useState('')
  const [setupMode, setSetupMode] = React.useState(false)
  const [signal, setSignal] = React.useState(getStatusSignal)
  // 资料空间：切换会停/重启引擎，所以单独维护状态，避免把中途的 stopped 当成未配置。
  const [libraryBusy, setLibraryBusy] = React.useState(false)
  const [libraryTarget, setLibraryTarget] = React.useState(null)
  const [libraryWork, setLibraryWork] = React.useState([])
  const [libraryManage, setLibraryManage] = React.useState(false)
  const [libraryHint, setLibraryHint] = React.useState(getLibraryHint)

  React.useEffect(() => subscribeStatusSignal(setSignal), [])
  React.useEffect(() => subscribeLibraryHint(setLibraryHint), [])

  // A committed engine restart (storage switch) refreshes both the panel status
  // and the home feed without a page reload.
  React.useEffect(() => {
    if (!signal.revision) return
    setRevision((value) => value + 1)
    setHomeRevision((value) => value + 1)
  }, [signal.revision])

  // Status fetched before the latest committed engine restart must not decide that
  // the install is unconfigured; only a snapshot taken at/after that revision may.
  const loadedRevision = React.useRef(0)

  const load = React.useCallback(async (quiet = true) => {
    if (!quiet) setLoading(true)
    try {
      const next = await status()
      loadedRevision.current = getStatusSignal().revision
      setData(next)
      setError('')
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load(false)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true)
    }, 8000)
    return () => clearInterval(timer)
  }, [load, revision])

  React.useEffect(() => {
    if (!data) return
    // The storage switch stops the engine inside one host request; do not mistake
    // that transient stop for an unconfigured install.
    if (signal.restarting) return
    if (loadedRevision.current < signal.revision) return
    const backendState = data.backend?.state
    if (data.env?.ready === false || backendState === 'stopped' || backendState === 'error') setSetupMode(true)
  }, [data, signal.restarting, signal.revision])

  const libraries = data?.libraries || []
  const activeLibrary = data?.library || null

  const reloadLibraries = React.useCallback(async () => {
    await load(true)
  }, [load])

  /**
   * 切到另一个资料空间。返回 409 library_busy 时先问用户：
   * 有采集/转写在跑，需要确认才能停引擎。
   */
  const switchLibrary = React.useCallback(async (entry, interrupt = false) => {
    if (!entry?.id || libraryBusy) return
    setLibraryBusy(true)
    beginEngineRestart()
    try {
      const result = await activateLibrary({ id: entry.id, interrupt })
      setLibraryTarget(null)
      setLibraryWork([])
      setFocus(null)
      setBatchFocus(null)
      setRevision((value) => value + 1)
      setHomeRevision((value) => value + 1)
      if (result?.switched === false) setNotice(`当前已经在「${entry.name}」`)
      else setNotice(`已切换到「${entry.name}」`)
    } catch (failure) {
      if (failure?.data?.code === 'library_busy') {
        setLibraryTarget(entry)
        setLibraryWork(failure.data?.detail?.work || [])
      } else {
        setNotice(failure?.message || String(failure))
      }
    } finally {
      endEngineRestart()
      setLibraryBusy(false)
    }
  }, [libraryBusy])

  React.useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  React.useEffect(() => {
    function onKey(event) {
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && (event.key.toLowerCase() === 'k' || (event.shiftKey && event.key.toLowerCase() === 'f'))) {
        const root = document.querySelector('.mc-root')
        const active = document.activeElement
        if (root && active && root.contains(active)) {
          event.preventDefault()
          setSearchQuery('')
          setSearchOpen(true)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const setupBlocked = Boolean(data) && !signal.restarting && (
    setupMode || data.env?.ready === false ||
    ['stopped', 'error'].includes(data.backend?.state)
  )

  // 打开记录的落点统一是资料库：设置一次性 focus（选中 + 可选时间点），
  // 由 RecordsBrowser 消费后清空，避免旧时间点被带到之后选中的其它记录上。
  const focusSeq = React.useRef(0)
  const consumeFocus = React.useCallback(() => setFocus(null), [])
  const openRecord = React.useCallback((record, time) => {
    const id = record && typeof record === 'object' ? record.id : record
    if (!id) return
    focusSeq.current += 1
    setView('library')
    setFocus({
      id,
      title: (record && typeof record === 'object' && record.title) || '',
      kind: (record && typeof record === 'object' && record.kind) || '',
      time: typeof time === 'number' ? time : null,
      nonce: focusSeq.current
    })
  }, [])

  function openSearchResult(result) {
    const target = result?.target || {}
    if (!target.session_id) {
      setNotice('无法定位该结果。')
      return
    }
    setSearchOpen(false)
    setSearchQuery('')
    openRecord({
      id: target.session_id,
      title: result.title || result.name || '记录',
      kind: result.kind || ''
    }, typeof target.time === 'number' ? target.time : null)
  }

  const handleCaptureCreated = React.useCallback((payload) => {
    setHomeRevision((value) => value + 1)
    setRevision((value) => value + 1)
    if (payload && typeof payload === 'object' && payload.kind === 'doc') {
      const card = payload.card || {}
      const name = card.title || '飞书文档'
      if (payload.warning) setNotice(`已登记链接卡片《${name}》：${payload.warning}`)
      else if (payload.link_only) setNotice(`已登记链接卡片《${name}》，首页摘录墙和会话 @ 都能看到。`)
      else setNotice(`已生成会摘卡片《${name}》，首页摘录墙和会话 @ 都能看到。`)
      return
    }
    if (payload && typeof payload === 'object' && payload.batch) {
      setView('home')
      setBatchFocus({ id: payload.batch.id, nonce: Date.now() })
      const summary = payload.summary || {}
      if (summary.added || summary.duplicates || summary.failed) {
        const parts = [`已加入 ${summary.added || 0} 条`]
        if (summary.duplicates) parts.push(`${summary.duplicates} 条重复`)
        if (summary.failed) parts.push(`${summary.failed} 条失败`)
        setNotice(parts.join('，'))
      }
      return
    }
    const id = payload && typeof payload === 'object' ? payload.id : payload
    if (!id) return
    const summary = payload && typeof payload === 'object' ? payload.summary : null
    if (summary?.duplicates || summary?.failed) {
      setNotice([summary.duplicates ? `${summary.duplicates} 条重复` : '',
        summary.failed ? `${summary.failed} 条失败` : ''].filter(Boolean).join('，'))
    }
    openRecord({ id, title: '正在处理…' })
  }, [openRecord])

  return (
    <div className="mc-root">
      <div className="mc-ambient" aria-hidden="true"><i /><i /><i /></div>
      <TopBar
        t={t}
        view={view}
        onView={(next) => { setView(next); setFocus(null); setBatchFocus(null) }}
        libraries={libraries}
        activeLibrary={activeLibrary}
        libraryBusy={libraryBusy}
        onLibrarySelect={(entry) => switchLibrary(entry)}
        onLibraryCreate={() => setLibraryManage(true)}
        onLibraryManage={() => setLibraryManage(true)}
        onSearch={() => { setSearchQuery(''); setSearchOpen(true) }}
      />

      {libraryHint && !setupBlocked ? (
        <div className="mc-lib-hint" role="status">
          <span>
            当前工作区属于「{libraryHint.name}」资料空间，正在显示「
            {activeLibrary?.name || '当前空间'}」的数据。
          </span>
          <button type="button" disabled={libraryBusy}
            onClick={() => switchLibrary({ id: libraryHint.id, name: libraryHint.name })}>
            切换到「{libraryHint.name}」
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="mc-error" role="alert">
          <p className="mc-error-title">{t('status.hostError')}</p>
          <p className="mc-error-text">{error}</p>
          <p className="mc-error-text">{t('status.errorHint')}</p>
          <button type="button" className="mc-button" onClick={() => setRevision((value) => value + 1)}>
            {t('common.retry')}
          </button>
        </div>
      ) : null}

      {!error && data && !setupBlocked && data.locations?.dataDirWritable === false ? (
        <div className="mc-banner mc-banner-warn">
          <span>数据目录不可写</span>
          <span className="mc-banner-hint">
            请给 DeepSeek Harness 完全磁盘访问权限后完全退出（⌘Q）再打开；
            或在「设置 → 采集 → 存储位置」换一个可写目录。
          </span>
        </div>
      ) : null}

      {!error && !data ? (
        <div className="mc-setup-loading">
          <span className="mc-setup-spinner" />
          <span>正在检查本地环境…</span>
        </div>
      ) : null}

      {!error && setupBlocked ? (
        <SetupWizard
          t={t}
          status={data}
          onComplete={() => {
            setSetupMode(false)
            setRevision((value) => value + 1)
            setView('home')
            load(false)
          }}
        />
      ) : null}

      {!error && data && !setupBlocked && view === 'home' ? (
        <HomePage
          t={t}
          revision={homeRevision}
          onOpenRecord={openRecord}
          onNewCapture={({ url = '', kind = '' } = {}) => {
            setNewInitialUrl(url)
            setNewInitialKind(kind)
            setNewOpen(true)
          }}
          onToast={setNotice}
          onCaptureCreated={handleCaptureCreated}
          batchFocus={batchFocus}
          onBatchFocusHandled={() => setBatchFocus(null)}
          library={activeLibrary}
          dataDir={data?.locations?.dataDirCanonical || data?.locations?.dataDir || data?.library?.dataDir || ''}
        />
      ) : null}

      {!error && data && !setupBlocked && view === 'library' ? (
        <RecordsBrowser
          t={t}
          statusData={data}
          focus={focus}
          onFocusConsumed={consumeFocus}
          onStatusRefresh={() => setRevision((value) => value + 1)}
        />
      ) : null}

      {libraryTarget ? (
        <div className="mc-modal-layer" role="dialog" aria-modal="true" aria-label="切换资料空间">
          <div className="mc-modal" style={{ width: 'min(460px, 100%)' }}>
            <div className="mc-section-title">还有任务在跑</div>
            <p className="mc-foot-meta">
              切到「{libraryTarget.name}」需要先停本地引擎。{busyWorkText(libraryWork)}会受影响；
              正在采集的直播会先保存已经录到的部分，再如实结束。
            </p>
            <div className="mc-actions">
              <button type="button" className="mc-button" disabled={libraryBusy}
                onClick={() => { setLibraryTarget(null); setLibraryWork([]) }}>取消</button>
              <button type="button" className="mc-button" data-variant="primary" disabled={libraryBusy}
                onClick={() => switchLibrary(libraryTarget, true)}>
                {libraryBusy ? '正在收尾并切换…' : '停止采集并切换'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {libraryManage ? (
        <div className="mc-modal-layer" role="dialog" aria-modal="true" aria-label="资料空间">
          <div className="mc-modal mc-lib-modal">
            <div className="mc-lib-modal-head">
              <span className="mc-lib-modal-title">资料空间</span>
              <button type="button" className="mc-icon-button" onClick={() => setLibraryManage(false)}
                aria-label="关闭">×</button>
            </div>
            <LibraryPanel
              t={t}
              rows={libraries}
              active={activeLibrary}
              sharedDir={data?.sharedDir || ''}
              dataDir={data?.locations?.dataDir || ''}
              busy={libraryBusy}
              showSharing={false}
              variant="dialog"
              onSwitch={(entry) => switchLibrary(entry)}
              onChanged={reloadLibraries}
            />
          </div>
        </div>
      ) : null}

      {notice ? <div className="mc-banner">{notice}</div> : null}

      {!setupBlocked && searchOpen ? (
        <GlobalSearchDialog
          t={t}
          initialQuery={searchQuery}
          onClose={() => { setSearchOpen(false); setSearchQuery('') }}
          onOpenResult={openSearchResult}
        />
      ) : null}

      {!setupBlocked && newOpen ? (
        <NewCaptureDialog
          t={t}
          statusData={data}
          initialUrl={newInitialUrl}
          initialKind={newInitialKind}
          onClose={() => { setNewOpen(false); setNewInitialUrl(''); setNewInitialKind('') }}
          onSubmitted={() => {
            // 批量表单会保持打开继续加下一批；先刷新墙上的批次卡，完成后只差定位。
            setHomeRevision((value) => value + 1)
            setRevision((value) => value + 1)
          }}
          onCreated={(payload) => {
            setNewOpen(false)
            setNewInitialUrl('')
            setNewInitialKind('')
            handleCaptureCreated(payload)
          }}
        />
      ) : null}
    </div>
  )
}
