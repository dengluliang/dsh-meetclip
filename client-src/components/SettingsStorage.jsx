import {
  ensureWorkspace, inspectDataDir, listSessions, pickFile, revealPath, status,
  switchDataDir, workspaceStatus
} from '../lib/api.js'
import { beginEngineRestart, endEngineRestart } from '../lib/status-bus.js'

function describeProbe(probe) {
  if (!probe) return ''
  if (probe.isCurrent) return '这就是当前存储位置。'
  if (probe.insideCurrent) return '这个文件夹在当前存储位置里面，不能作为新的存储位置。'
  if (probe.containsCurrent) return '这个文件夹包含当前存储位置，不能作为新的存储位置。'
  if (probe.exists && !probe.isDirectory) return '这个路径不是一个文件夹。'
  if (!probe.writable) return '这个位置不可写，请换一个文件夹，或先给 DeepSeek Harness 完全磁盘访问权限。'
  if (probe.hasLibrary) return `这里已经有一份会摘资料；切换后直接打开它，原目录保持不动。`
  if (!probe.exists || probe.empty) return '空文件夹；切换后从这里开始一份新的资料库，原目录不受影响。'
  return `文件夹里已有 ${probe.entryCount} 项其他内容，但没有会摘资料；会在这里新建资料库，其他文件不会被动。`
}

function moveHint(probe) {
  if (!probe) return ''
  if (!probe.sameDeviceKnown || !probe.sameDevice) {
    return '新位置在不同磁盘，不能自动移动；可以先在 Finder 里拷贝过去，再用「只切换」指向它。'
  }
  if (probe.exists && !probe.empty) return '这里不是空文件夹，只能切换，不能自动搬家。'
  return ''
}

export function SettingsStorage({ t }) {
  const [statusData, setStatusData] = React.useState(null)
  const [workspace, setWorkspace] = React.useState(null)
  const [records, setRecords] = React.useState(null)
  const [stage, setStage] = React.useState('idle')
  const [target, setTarget] = React.useState('')
  const [probe, setProbe] = React.useState(null)
  const [move, setMove] = React.useState(false)
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')

  const dataDir = statusData?.locations?.dataDir || ''

  const load = React.useCallback(async () => {
    try {
      const next = await status()
      setStatusData(next)
      const dir = next?.locations?.dataDir || ''
      try {
        setWorkspace(await workspaceStatus(dir))
      } catch (failure) {
        // 404 means this page already carries the new client but the host module is
        // still the previous release; 501 means the host really has no registry.
        setWorkspace({
          available: false,
          workspace: null,
          reason: failure?.status === 501 ? 'unsupported' : failure?.status === 404 ? 'stale' : 'error'
        })
      }
      try {
        const rows = await listSessions()
        setRecords(Array.isArray(rows) ? rows.length : null)
      } catch {
        setRecords(null)
      }
      setError('')
    } catch (failure) {
      setError(failure?.message || String(failure))
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  async function choose() {
    setBusy('pick')
    setError('')
    setNotice('')
    try {
      const result = await pickFile('directory')
      if (!result?.ok) {
        if (!result?.cancelled) setError(result?.error || '选择文件夹失败')
        return
      }
      const info = await inspectDataDir(result.path)
      setTarget(result.path)
      setProbe(info)
      setMove(false)
      setStage('review')
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setBusy('')
    }
  }

  async function confirmSwitch() {
    if (!probe || busy) return
    setBusy('switch')
    setError('')
    setNotice('')
    beginEngineRestart()
    try {
      const result = await switchDataDir({ path: target, move })
      setStage('idle')
      setProbe(null)
      setNotice(result?.moved
        ? `已把资料移动到 ${result.dataDir}`
        : `已切换到 ${result.dataDir}`)
      await load()
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      endEngineRestart()
      setBusy('')
    }
  }

  async function addWorkspace() {
    setBusy('workspace')
    setError('')
    setNotice('')
    try {
      const result = await ensureWorkspace({})
      setWorkspace({ available: true, workspace: result?.workspace || null })
      setNotice(result?.created
        ? '已在 DSH 工作区中添加这个目录'
        : '这个目录已经在 DSH 工作区中')
    } catch (failure) {
      setError(failure?.status === 404
        ? '宿主还没重新加载：重启 DeepSeek Harness，或在插件管理里禁用再启用一次「会摘」后重试'
        : failure?.message || String(failure))
    } finally {
      setBusy('')
    }
  }

  const canConfirm = Boolean(probe) && !probe.isCurrent && !probe.insideCurrent &&
    !probe.containsCurrent && probe.writable && !(probe.exists && !probe.isDirectory)
  const canMove = Boolean(probe) && canConfirm && probe.sameDevice &&
    (!probe.exists || probe.empty) && !probe.hasLibrary
  const workspaceText = !workspace
    ? '检查中…'
    : workspace.available === false
      ? workspace.reason === 'stale'
        ? '需要重启 DeepSeek Harness 后才能自动添加'
        : workspace.reason === 'unsupported'
          ? '当前 DSH 不支持自动添加，可在左侧栏手动添加这个目录'
          : '暂时读不到工作区状态，稍后重试'
      : workspace.workspace
        ? `已在工作区中：${workspace.workspace.title}`
        : '尚未加入工作区'

  return (
    <div className="mc-card">
      <div className="mc-rows">
        <div className="mc-row">
          <span className="mc-row-key">{t('settings.storage') || '存储位置'}</span>
          <span className="mc-row-value mc-mono" title={dataDir}>{dataDir || '读取中…'}</span>
        </div>
        <div className="mc-row">
          <span className="mc-row-key">资料库</span>
          <span className="mc-row-value">{records === null ? '—' : `当前 ${records} 条记录`}</span>
        </div>
        <div className="mc-row">
          <span className="mc-row-key">DSH 工作区</span>
          <span className="mc-row-value">{workspaceText}</span>
        </div>
      </div>

      {stage === 'review' ? (
        <div className="mc-storage-review">
          <div className="mc-row">
            <span className="mc-row-key">新位置</span>
            <span className="mc-row-value mc-mono" title={target}>{target}</span>
          </div>
          <p className="mc-foot-meta">{describeProbe(probe)}</p>
          {canMove ? (
            <label className="mc-check">
              <input type="checkbox" checked={move} disabled={Boolean(busy)}
                onChange={(event) => setMove(event.target.checked)} />
              把现有资料移动到新位置（同一磁盘，立即完成）
            </label>
          ) : (
            <p className="mc-foot-meta">{moveHint(probe)}</p>
          )}
          <p className="mc-warn">
            切换会先停止、再重启本地引擎。如果 macOS 版会摘正在使用同一目录，请先退出它，否则会提示引擎被占用。
          </p>
          <div className="mc-actions">
            <button type="button" className="mc-button" disabled={Boolean(busy)}
              onClick={() => { setStage('idle'); setProbe(null); setError('') }}>取消</button>
            <button type="button" className="mc-button" data-variant="primary"
              disabled={Boolean(busy) || !canConfirm} onClick={confirmSwitch}>
              {busy === 'switch' ? '正在切换并重启引擎…' : '确认切换'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mc-actions">
            <button type="button" className="mc-button" onClick={() => revealPath('data')}>
              在 Finder 中打开
            </button>
            <button type="button" className="mc-button" disabled={Boolean(busy)} onClick={choose}>
              {busy === 'pick' ? '选择中…' : '更换…'}
            </button>
            <button type="button" className="mc-button"
              disabled={Boolean(busy) || workspace?.available === false || Boolean(workspace?.workspace)}
              onClick={addWorkspace}>
              {workspace?.workspace ? '已加入工作区' : busy === 'workspace' ? '添加中…' : '添加为 DSH 工作区'}
            </button>
          </div>
          <p className="mc-foot-meta">
            录音、转写、笔记、标记与数据库都保存在这里。切换后界面只显示新目录里的资料，原目录不会被删除；
            在这个工作区里新建会话，Agent 就能直接读到你采集的录音、截图和转写。
          </p>
        </>
      )}

      {notice ? <p className="mc-foot-meta" role="status">{notice}</p> : null}
      {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
    </div>
  )
}
