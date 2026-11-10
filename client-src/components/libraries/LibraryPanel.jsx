import {
  createLibrary, ensureLibraryWorkspace, forgetLibrary, inspectLibrary, listLibraries,
  pickFile, renameLibrary, shareLibraryAccounts
} from '../../lib/api.js'
import {
  libraryMeta, libraryNameError, libraryLoadErrorText, sortLibraries, suggestedLibraryDir
} from '../../lib/libraries.js'

function statusLabel(status) {
  if (status === 'recording') return '采集中'
  if (status === 'processing') return '处理中'
  if (status === 'queued') return '排队中'
  return '进行中'
}

/**
 * 资料空间管理面板：列表 + 新建 + 共享账号。
 * 设置页（variant="settings"）与面板里的「资料空间」弹层（variant="dialog"）共用。
 * 弹层自带标题，所以只在设置页里画「资料空间」小节标题。
 */
export function LibraryPanel({
  t, rows, active, sharedDir, dataDir, busy, onSwitch, onChanged,
  showSharing = true, variant = 'settings', loadError = null
}) {
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [name, setName] = React.useState('')
  const [target, setTarget] = React.useState('')
  const [probe, setProbe] = React.useState(null)
  const [force, setForce] = React.useState(false)
  const [working, setWorking] = React.useState('')
  const [renaming, setRenaming] = React.useState(null)
  const [renameValue, setRenameValue] = React.useState('')

  const list = sortLibraries(rows)
  const stale = loadError && [404, 405, 501].includes(Number(loadError.status))

  React.useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  // 名称变化时，如果用户还没手动改过位置，就跟着换建议路径。
  const autoPathRef = React.useRef('')
  React.useEffect(() => {
    if (!creating) return
    if (target && target !== autoPathRef.current) return
    const next = suggestedLibraryDir({ dataDir: active?.dataDir || dataDir, name })
    autoPathRef.current = next
    setTarget(next)
    setProbe(null)
  }, [creating, name, active?.dataDir, dataDir])

  async function inspect(path) {
    if (!path) {
      setProbe(null)
      return null
    }
    try {
      const info = await inspectLibrary(path)
      setProbe(info)
      return info
    } catch (failure) {
      setProbe(null)
      setError(failure?.message || String(failure))
      return null
    }
  }

  async function chooseDir() {
    setWorking('pick')
    setError('')
    try {
      const result = await pickFile('directory')
      if (!result?.ok) {
        if (!result?.cancelled) setError(result?.error || '选择文件夹失败')
        return
      }
      autoPathRef.current = ''
      setTarget(result.path)
      const info = await inspect(result.path)
      if (info && !name) {
        const leaf = String(result.path).split('/').filter(Boolean).pop() || ''
        if (leaf) setName(leaf === 'data' ? '' : leaf)
      }
    } finally {
      setWorking('')
    }
  }

  function startCreate() {
    setCreating(true)
    setError('')
    setNotice('')
    setName('')
    setTarget('')
    setProbe(null)
    setForce(false)
    autoPathRef.current = ''
  }

  async function submitCreate() {
    const nameError = libraryNameError(name)
    if (nameError) {
      setError(nameError)
      return
    }
    if (!target.trim()) {
      setError('请先选择资料空间的位置')
      return
    }
    setWorking('create')
    setError('')
    try {
      const result = await createLibrary({ name: name.trim(), dataDir: target, activate: false, force })
      setCreating(false)
      setNotice(`已创建「${result?.library?.name || name}」`)
      await onChanged?.()
      if (result?.library?.id) await onSwitch?.({ ...result.library, records: 0 })
    } catch (failure) {
      if (failure?.status === 409 && failure?.data?.code === 'library_not_empty') setForce(true)
      setError(libraryLoadErrorText(failure))
    } finally {
      setWorking('')
    }
  }

  async function submitRename(entry) {
    const nameError = libraryNameError(renameValue)
    if (nameError) {
      setError(nameError)
      return
    }
    setWorking(`rename:${entry.id}`)
    setError('')
    try {
      await renameLibrary({ id: entry.id, name: renameValue.trim() })
      setRenaming(null)
      setNotice('已改名')
      await onChanged?.()
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setWorking('')
    }
  }

  async function submitForget(entry) {
    setWorking(`forget:${entry.id}`)
    setError('')
    try {
      await forgetLibrary({ id: entry.id, confirmPath: entry.dataDir })
      setNotice(`已从列表移除「${entry.name}」，文件没有动`)
      await onChanged?.()
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setWorking('')
    }
  }

  async function submitWorkspace(entry) {
    setWorking(`workspace:${entry.id}`)
    setError('')
    try {
      const result = await ensureLibraryWorkspace({ id: entry.id, title: entry.name })
      setNotice(result?.created ? '已添加为 DSH 工作区' : '这个目录已经在工作区里')
    } catch (failure) {
      setError(failure?.status === 404
        ? '宿主还没重新加载：重启 DeepSeek Harness 后再试'
        : failure?.message || String(failure))
    } finally {
      setWorking('')
    }
  }

  async function submitSharing() {
    setWorking('share')
    setError('')
    try {
      const result = await shareLibraryAccounts({})
      setNotice(result?.copied?.length
        ? `已把 ${result.copied.length} 个账号/设置文件放进共享目录`
        : '共享目录已就绪')
      await onChanged?.()
    } catch (failure) {
      setError(libraryLoadErrorText(failure))
    } finally {
      setWorking('')
    }
  }

  const probeText = (() => {
    if (!probe) return ''
    if (probe.duplicate) return `这里已经是资料空间「${probe.duplicate.name}」`
    if (probe.nested) return '这个位置在一个已有资料空间里面'
    if (probe.contains) return '这个位置包含另一个资料空间'
    if (probe.exists && !probe.isDirectory) return '这个路径不是文件夹'
    if (!probe.writable) return '这个位置不可写，请换一个文件夹或先授予磁盘访问权限'
    if (probe.hasLibrary) return '这里已经有一份会摘资料；会直接收养它（文件不会被移动）'
    if (!probe.exists || probe.empty) return '空文件夹；会在这里新建一份资料'
    return `文件夹里已有 ${probe.entryCount} 项内容，但没有会摘资料`
  })()

  const dialog = variant === 'dialog'
  const countText = list.length
    ? `${list.length} 个空间${active?.name ? ` · 当前「${active.name}」` : ''}`
    : ''

  const body = (
    <>
      <div className="mc-lib-toolbar">
        <span className="mc-lib-count">{countText}</span>
        <span className="mc-lib-toolbar-gap" />
        <button type="button" className="mc-lib-tool" disabled={Boolean(working) || Boolean(busy)}
          onClick={() => onChanged?.()}>刷新</button>
        {list.length && !creating && !stale ? (
          <button type="button" className="mc-lib-tool" data-variant="primary"
            disabled={Boolean(busy) || Boolean(working)}
            onClick={startCreate}>＋ 新建资料空间</button>
        ) : null}
      </div>

      {stale ? (
        <div className="mc-lib-empty" data-tone="warn">
          <p className="mc-lib-empty-title">宿主还没加载多资料空间</p>
          <p className="mc-lib-empty-text">
            当前页面已经是新版，但宿主里还没有这个接口：通常是装完新版本后没有重启 DeepSeek Harness。
            完全退出（⌘Q）再打开即可；仍然不行就重新安装 <span className="mc-mono">dsh-meetclip-0.8.6.tgz</span>。
          </p>
          <div className="mc-actions">
            <button type="button" className="mc-lib-tool" onClick={() => onChanged?.()}>重试</button>
          </div>
        </div>
      ) : creating ? (
        <div className="mc-lib-form">
          <div className="mc-lib-form-head">新建资料空间</div>
          <label className="mc-lib-form-row">
            <span>名称</span>
            <input className="mc-input" value={name} autoFocus placeholder="例如 工作 / 生活"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submitCreate() }} />
          </label>
          <label className="mc-lib-form-row">
            <span>位置</span>
            <input className="mc-input mc-mono" value={target} readOnly title={target}
              onClick={() => inspect(target)} />
            <button type="button" className="mc-lib-tool" disabled={Boolean(working)} onClick={chooseDir}>
              {working === 'pick' ? '选择中…' : '选择…'}
            </button>
          </label>
          {probeText ? <p className="mc-lib-probe">{probeText}</p> : null}
          {force && probe && !probe.empty && !probe.hasLibrary ? (
            <label className="mc-check">
              <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
              就在这个文件夹里新建资料库（其他文件不会被动）
            </label>
          ) : null}
          <div className="mc-lib-form-actions">
            <button type="button" className="mc-button" disabled={Boolean(working)}
              onClick={() => { setCreating(false); setError('') }}>取消</button>
            <button type="button" className="mc-button" data-variant="primary"
              disabled={Boolean(working) || Boolean(libraryNameError(name)) || stale}
              onClick={submitCreate}>
              {working === 'create' ? '创建中…' : '创建并切换'}
            </button>
          </div>
        </div>
      ) : list.length ? (
        <div className="mc-lib-list">
          {list.map((entry) => (
            <div key={entry.id} className="mc-lib-row" data-active={entry.active ? 'true' : 'false'}>
              <div className="mc-lib-row-main">
                <div className="mc-lib-row-title">
                  {renaming === entry.id ? (
                    <input className="mc-input" autoFocus value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitRename(entry)
                        if (event.key === 'Escape') setRenaming(null)
                      }} />
                  ) : (
                    <>
                      <span className="mc-lib-row-name">{entry.name}</span>
                      {entry.active ? <span className="mc-lib-badge">正在使用</span> : null}
                      {entry.exists === false ? <span className="mc-lib-badge" data-tone="muted">位置不可用</span> : null}
                    </>
                  )}
                </div>
                <div className="mc-lib-row-path mc-mono" title={entry.dataDir}>{entry.dataDir}</div>
                <div className="mc-lib-row-meta">{libraryMeta(entry)}</div>
              </div>
              <div className="mc-lib-row-actions">
                {renaming === entry.id ? (
                  <>
                    <button type="button" data-variant="primary" disabled={Boolean(working)}
                      onClick={() => submitRename(entry)}>保存</button>
                    <button type="button" onClick={() => setRenaming(null)}>取消</button>
                  </>
                ) : (
                  <>
                    {entry.active ? null : (
                      <button type="button" data-variant="primary"
                        disabled={Boolean(busy) || Boolean(working) || entry.exists === false}
                        onClick={() => onSwitch?.(entry)}>切换</button>
                    )}
                    <button type="button" disabled={Boolean(working)}
                      onClick={() => { setRenaming(entry.id); setRenameValue(entry.name) }}>改名</button>
                    <button type="button" disabled={Boolean(working)}
                      onClick={() => submitWorkspace(entry)}>加入工作区</button>
                    <button type="button" data-variant="quiet" disabled={Boolean(working) || entry.active}
                      onClick={() => submitForget(entry)}>移除</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mc-lib-empty">
          <p className="mc-lib-empty-title">还没有第二个资料空间</p>
          <p className="mc-lib-empty-text">
            现在用的这份会留在列表里。再建一份就能把工作与生活分开，两边各有自己的记录、笔记与会摘卡片。
          </p>
          <div className="mc-actions">
            <button type="button" className="mc-button" data-variant="primary"
              disabled={Boolean(busy) || Boolean(working) || stale} onClick={startCreate}>＋ 新建资料空间</button>
          </div>
        </div>
      )}

      <p className="mc-lib-foot">
        {dialog
          ? '切换会停/重启本地引擎；移除只从列表拿掉，文件不会被删除。'
          : '每个资料空间是一份独立目录：记录、转写、笔记、AI 纪要与会摘卡片各归各的。切换时首页、资料库、搜索与 Agent 工具一起指向新空间；移除只是从列表里拿掉，文件不会被删除。'}
      </p>
      {notice ? <p className="mc-lib-foot" data-tone="ok" role="status">{notice}</p> : null}
      {error ? <p className="mc-error-text mc-lib-foot" role="alert">{error}</p> : null}
    </>
  )

  if (dialog) return <div className="mc-lib-panel">{body}</div>

  return (
    <div className="mc-settings-panel">
      <div className="mc-section">
        <div className="mc-section-title">资料空间</div>
        <div className="mc-card mc-lib-card">{body}</div>
      </div>

      {showSharing ? (
        <div className="mc-section">
          <div className="mc-section-title">账号与通用设置</div>
          <div className="mc-card">
            <div className="mc-lib-share">
              <div className="mc-lib-share-main">
                <div className="mc-lib-row-title">
                  <span className="mc-lib-row-name">共享目录</span>
                  {sharedDir
                    ? <span className="mc-lib-badge">已启用</span>
                    : <span className="mc-lib-badge" data-tone="muted">未启用</span>}
                </div>
                <div className="mc-lib-row-path mc-mono" title={sharedDir || ''}>
                  {sharedDir || '所有空间各自保存一份账号与设置'}
                </div>
                <div className="mc-lib-row-meta">B 站 / 抖音登录态、语音与画质设置</div>
              </div>
              <div className="mc-lib-row-actions">
                <button type="button" data-variant={sharedDir ? undefined : 'primary'}
                  disabled={Boolean(working) || Boolean(busy)} onClick={submitSharing}>
                  {working === 'share' ? '准备中…' : sharedDir ? '检查共享目录' : '启用共享'}
                </button>
              </div>
            </div>
            <p className="mc-lib-foot">
              云端 API Key 与日历密码保存在 macOS 钥匙串里，本来就所有空间共用；
              启用共享时只复制、不删除原文件。
            </p>
          </div>
        </div>
      ) : null}

      <p className="mc-lib-foot">
        这一份放在哪儿、怎么搬家：设置 → 采集 → 存储位置（那里还能把它加为 DSH 工作区）。
      </p>
    </div>
  )
}
