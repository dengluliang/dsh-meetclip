import { activateLibrary, listLibraries, status } from '../lib/api.js'
import { beginEngineRestart, endEngineRestart } from '../lib/status-bus.js'
import { activeOf, libraryLoadErrorText } from '../lib/libraries.js'
import { LibraryPanel } from './libraries/LibraryPanel.jsx'

/**
 * 设置 → 资料空间：列表、新建、共享账号，以及原来的「存储位置」高级操作。
 *
 * 切换会停/重启本地引擎，因此这里复用 status-bus：面板那边会等这次重启提交后
 * 再刷新，不会把中途的 stopped 当成「未配置」。
 */
export function SettingsLibraries({ t }) {
  const [rows, setRows] = React.useState([])
  const [sharedDir, setSharedDir] = React.useState('')
  const [dataDir, setDataDir] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [loadError, setLoadError] = React.useState(null)
  const [pending, setPending] = React.useState(null)
  const [work, setWork] = React.useState([])

  const load = React.useCallback(async () => {
    try {
      const [list, state] = await Promise.all([listLibraries(), status().catch(() => null)])
      setRows(list?.libraries || [])
      setSharedDir(list?.sharedDir || '')
      setDataDir(state?.locations?.dataDir || activeOf(list?.libraries)?.dataDir || '')
      setLoadError(null)
      setError('')
    } catch (failure) {
      // 宿主还是旧版时这里会 404：交给面板显示一条能动手的提示，别把 HTTP 码摊给用户。
      setLoadError(failure?.status ? { status: failure.status } : null)
      setError(failure?.status ? '' : libraryLoadErrorText(failure))
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  async function runSwitch(entry, interrupt = false) {
    setBusy(true)
    setError('')
    beginEngineRestart()
    try {
      await activateLibrary({ id: entry.id, interrupt })
      setPending(null)
      setWork([])
      await load()
    } catch (failure) {
      if (failure?.data?.code === 'library_busy') {
        setPending(entry)
        setWork(failure.data?.detail?.work || [])
      } else {
        setError(failure?.message || String(failure))
      }
    } finally {
      endEngineRestart()
      setBusy(false)
    }
  }

  return (
    <>
      {pending ? (
        <div className="mc-card">
          <div className="mc-section-title">还有任务在跑</div>
          <p className="mc-foot-meta">
            切换到「{pending.name}」需要先停本地引擎。这些任务会受影响：
          </p>
          <ul className="mc-foot-meta">
            {work.map((item) => (
              <li key={item.id}>{item.title}（{item.status === 'recording' ? '采集中' : item.status === 'processing' ? '处理中' : '排队中'}）</li>
            ))}
          </ul>
          <div className="mc-actions">
            <button type="button" className="mc-button" disabled={busy} onClick={() => { setPending(null); setWork([]) }}>
              取消
            </button>
            <button type="button" className="mc-button" data-variant="primary" disabled={busy}
              onClick={() => runSwitch(pending, true)}>
              {busy ? '正在收尾并切换…' : '停止采集并切换'}
            </button>
          </div>
        </div>
      ) : null}

      <LibraryPanel
        t={t}
        rows={rows}
        active={activeOf(rows)}
        sharedDir={sharedDir}
        dataDir={dataDir}
        busy={busy}
        loadError={loadError}
        onSwitch={(entry) => runSwitch(entry)}
        onChanged={load}
      />

      {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
    </>
  )
}
