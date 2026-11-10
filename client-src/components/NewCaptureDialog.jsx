import {
  addLinks, createSession, deps, importMeeting, listSessions, meetingOptions, pickFile,
  precheckLive, previewLink, startSession, uploadFile
} from '../lib/api.js'
import { bytes, clock, dateTime, duration } from '../lib/format.js'
import { DocCardForm } from './capture/DocCardForm.jsx'
import { MAX_BATCH_LINKS, parseLinks, platformLabel, skipSummary } from '../lib/links.js'

const KINDS = ['launch', 'video', 'meeting', 'doc']

export function NewCaptureDialog({ t, onClose, onCreated, onSubmitted, statusData, initialUrl = '', initialKind = '' }) {
  const [kind, setKind] = React.useState(() => {
    if (initialKind) return initialKind
    if (initialUrl) return 'launch'
    const preferred = localStorage.getItem('meetclip.newKindDefault') || 'remember'
    if (preferred !== 'remember') return preferred
    return localStorage.getItem('meetclip.newKind') || 'launch'
  })
  const [options, setOptions] = React.useState(null)
  const [optionsError, setOptionsError] = React.useState('')
  const [health, setHealth] = React.useState({ depsReady: null, asrReady: null, active: 0 })

  React.useEffect(() => {
    let cancelled = false
    let timer = null
    async function load() {
      try {
        const value = await meetingOptions()
        if (cancelled) return
        setOptions(value)
        setOptionsError('')
        if (!value?.asr_ready) timer = setTimeout(load, 3000)
      } catch (failure) {
        if (!cancelled) {
          setOptionsError(failure?.message || String(failure))
          timer = setTimeout(load, 4000)
        }
      }
    }
    load()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    async function loadHealth() {
      const next = { depsReady: null, asrReady: null, active: 0 }
      try {
        const value = await deps()
        next.depsReady = Boolean(value?.ready ?? (value?.yt_dlp && value?.ffmpeg))
      } catch {}
      try {
        const options = await meetingOptions()
        next.asrReady = Boolean(options?.asr_ready)
      } catch {}
      try {
        const rows = await listSessions()
        next.active = (Array.isArray(rows) ? rows : []).filter((row) => ['queued', 'recording', 'processing'].includes(row.status)).length
      } catch {}
      if (!cancelled) setHealth(next)
    }
    loadHealth()
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      const target = event.target
      const typingLong = target && (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      if (event.key === 'Enter' && !typingLong && !event.shiftKey) {
        const submit = [...document.querySelectorAll('.mc-new-body [data-new-submit="true"]')]
          .find((button) => !button.disabled && !button.closest('[hidden]'))
        if (submit) { event.preventDefault(); submit.click() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="mc-modal-layer" role="dialog" aria-modal="true" aria-label={t('new.title')}>
      <div className="mc-modal mc-new-modal">
        <div className="mc-modal-head">
          <div className="mc-new-tabs" role="tablist">
            {KINDS.map((id) => (
              <button key={id} type="button" role="tab" className="mc-tab mc-new-tab"
                data-active={kind === id} aria-selected={kind === id} onClick={() => { setKind(id); localStorage.setItem('meetclip.newKind', id) }}>
                {t(`new.${id}`)}
              </button>
            ))}
          </div>
          <button type="button" className="mc-icon-button" onClick={onClose} aria-label={t('new.close')}>×</button>
        </div>

        <div className="mc-new-body">
          {health.depsReady === false && (kind === 'launch' || kind === 'video') ? (
            <div className="mc-notice" data-tone="error">缺少采集组件（yt-dlp / ffmpeg），请在首页「配置进度」中安装。</div>
          ) : null}
          {health.asrReady === false && kind !== 'video' && kind !== 'doc' ? (
            <div className="mc-notice" data-tone="warn">云端语音未配置：仍可保存音视频与截图，配置后可重新转写。</div>
          ) : null}
          {health.active > 0 && kind !== 'doc' ? (
            <div className="mc-notice" data-tone="info">已有 {health.active} 个任务在运行，新任务会排队；直播轮到后才开始采集。</div>
          ) : null}
          <div hidden={kind !== 'launch'}>
            <LaunchForm t={t} health={health} initialUrl={initialUrl} onClose={onClose} onCreated={onCreated} />
          </div>
          <div hidden={kind !== 'video'}>
            <VideoForm t={t} options={options} initialUrl={initialUrl} onClose={onClose}
              onCreated={onCreated} onSubmitted={onSubmitted} />
          </div>
          <div hidden={kind !== 'meeting'}>
            <MeetingForm t={t} options={options} optionsError={optionsError} onClose={onClose} onCreated={onCreated} />
          </div>
          <div hidden={kind !== 'doc'}>
            <DocCardForm t={t} onClose={onClose} onCreated={onCreated} />
          </div>
        </div>
      </div>
    </div>
  )
}

export function LaunchForm({ t, health, initialUrl = '', onClose, onCreated }) {
  const [url, setUrl] = React.useState(initialUrl)
  const [result, setResult] = React.useState(null)
  const [checking, setChecking] = React.useState(false)
  const [error, setError] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [createdId, setCreatedId] = React.useState('')
  const [checkNonce, setCheckNonce] = React.useState(0)

  React.useEffect(() => {
    const value = url.trim()
    if (!value || value.length < 10) {
      setResult(null)
      return undefined
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setChecking(true)
      setError('')
      try {
        const preview = await precheckLive(value)
        if (!cancelled) setResult(preview)
      } catch (failure) {
        if (!cancelled) {
          setResult(null)
          setError(failure?.message || String(failure))
        }
      } finally {
        if (!cancelled) setChecking(false)
      }
    }, 700)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [url, checkNonce])

  async function submit() {
    setSubmitting(true)
    setError('')
    try {
      const created = await createSession({ url: url.trim() })
      setCreatedId(created.id)
      try {
        await startSession(created.id)
        onCreated?.(created.id)
        onClose()
      } catch (failure) {
        setError(`${failure?.message || failure}（记录已创建，可在列表中打开）`)
      }
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = Boolean(result?.ok) && !checking && !submitting && health?.depsReady !== false

  return (
    <div className="mc-new-form">
      <p className="mc-card-text">{t('new.launchHint')}</p>
      <label className="mc-form-row">
        <span>{t('new.url')}</span>
        <input className="mc-input" value={url} onChange={(event) => setUrl(event.target.value)}
          placeholder="https://live.bilibili.com/…" spellCheck={false} autoFocus />
      </label>

      {checking ? <div className="mc-inline-note">{t('new.checking')}</div> : null}
      {error ? (
        <div className="mc-error-row">
          <span className="mc-error-text" role="alert">{error}</span>
          <button type="button" className="mc-button mc-button-small" onClick={() => setCheckNonce((value) => value + 1)}>重试预检</button>
        </div>
      ) : null}

      {result ? (
        <div className="mc-preview-card">
          {result.thumbnail ? <img src={result.thumbnail} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : null}
          <div className="mc-preview-main">
            <strong>{result.title || t('new.noPreview')}</strong>
            <span>{[result.uploader, result.category, result.message].filter(Boolean).join(' · ')}</span>
            {result.started_at ? <span>开播 {dateTime(result.started_at)}</span> : null}
            {result.status ? <span>{({ live: '直播中', not_started: '尚未开播', replay: '轮播回放', invalid: '链接无效', unreachable: '暂时无法连接' })[result.status] || result.status}</span> : null}
            {result.ok ? <span className="mc-ok-text">{t('new.ready')}</span> : <span className="mc-error-text">{result.message || t('new.failed')}</span>}
          </div>
        </div>
      ) : null}

      {createdId ? <div className="mc-inline-note">{t('new.openRecord')}：{createdId}</div> : null}

      <div className="mc-modal-actions">
        <button type="button" className="mc-button" onClick={onClose}>{t('new.cancel')}</button>
        <button type="button" className="mc-button" data-variant="primary" data-new-submit="true" disabled={!canSubmit} onClick={submit}>
          {submitting ? t('new.checking') : t('new.start')}
        </button>
      </div>
    </div>
  )
}

export function VideoForm({ t, options, initialUrl = '', batch = null, onClose, onCreated, onSubmitted }) {
  const [text, setText] = React.useState(initialUrl)
  const [entries, setEntries] = React.useState([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState(null)
  const [lastCreated, setLastCreated] = React.useState(null)
  const [previewingAll, setPreviewingAll] = React.useState(false)
  const textareaRef = React.useRef(null)
  const autoPreviewRef = React.useRef('')
  const parsed = React.useMemo(() => parseLinks(text), [text])
  const skippedText = skipSummary(parsed.skipped)
  const appendBatch = Boolean(batch?.id)
  const batchTotal = Number(batch?.total) || (batch?.members || []).length

  React.useEffect(() => {
    const rows = parsed.accepted.slice(0, MAX_BATCH_LINKS)
    setEntries((current) => rows.map((row) => {
      const existing = current.find((entry) => entry.url === row.url)
      return existing
        ? { ...existing, platform: row.platform }
        : { url: row.url, platform: row.platform, loading: false, preview: null, error: '', mode: 'auto', trackId: '' }
    }))
  }, [parsed])

  React.useEffect(() => {
    const first = entries[0]
    if (!initialUrl || !first || first.preview || first.loading || autoPreviewRef.current === initialUrl) return
    autoPreviewRef.current = initialUrl
    previewEntry(0)
  }, [entries, initialUrl])

  async function previewEntry(index) {
    const entry = entries[index]
    if (!entry || entry.loading) return
    setEntries((current) => current.map((item, i) => i === index ? { ...item, loading: true, error: '' } : item))
    try {
      const preview = await previewLink(entry.url)
      setEntries((current) => current.map((item, i) => i === index ? {
        ...item,
        loading: false,
        preview,
        error: preview?.ok ? '' : (preview?.message || t('new.notSupported')),
        trackId: preview?.default_subtitle_track_id || ''
      } : item))
    } catch (failure) {
      setEntries((current) => current.map((item, i) => i === index ? {
        ...item, loading: false, error: failure?.message || String(failure)
      } : item))
    }
  }

  async function previewAll() {
    setPreviewingAll(true)
    for (let index = 0; index < entries.length; index += 1) {
      if (!entries[index].preview && !entries[index].loading) {
        await previewEntry(index)
      }
    }
    setPreviewingAll(false)
  }

  function updateText(next) {
    setText(next)
    // 上一轮全部成功的结果只是提示；开始贴下一批时收起，避免误以为新链接已经加入。
    if (result?.summary?.added && !result.summary.duplicates && !result.summary.failed) setResult(null)
  }

  function addLink() {
    updateText(`${text.trimEnd()}${text.trim() ? '\n' : ''}`)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  function removeEntry(index) {
    const urls = parsed.accepted.map((row) => row.url)
    urls.splice(index, 1)
    updateText(urls.join('\n'))
  }

  function pasteLinks(event) {
    const value = String(event.clipboardData?.getData('text') || '')
    const result = parseLinks(value)
    if (!result.accepted.length) return
    event.preventDefault()
    updateText(result.accepted.map((row) => row.url).join('\n'))
  }

  /**
   * 提交一批链接。
   * - `allowDuplicate` / `onlyUrls`：结果里的重复行可以确认后再次加入。
   * - 一次提交即开启“连续添加”模式：批次卡或追加模式下表单不关闭，方便接着贴下一批。
   */
  async function submit({ allowDuplicate = false, onlyUrls = null } = {}) {
    const source = Array.isArray(onlyUrls)
      ? entries.filter((entry) => onlyUrls.includes(entry.url))
      : entries
    setSubmitting(true)
    setError('')
    try {
      const items = source
        .filter((entry) => entry.url)
        .map((entry) => ({
          url: entry.url,
          title: entry.preview?.title || '',
          thumbnail: entry.preview?.thumbnail || '',
          transcription_mode: entry.mode,
          subtitle_track_id: entry.trackId || null,
          allow_duplicate: Boolean(allowDuplicate)
        }))
      if (items.length === 0) throw new Error(t('new.maxLinks'))
      const multiRound = appendBatch || Boolean(lastCreated)
      const response = await addLinks(items, { batchId: batch?.id })
      const rows = response?.results || []
      const created = rows.filter((row) => row.ok && row.id)
      const summary = {
        added: created.length,
        duplicates: rows.filter((row) => row.duplicate).length,
        failed: rows.filter((row) => !row.ok && !row.duplicate).length
      }
      const stayOpen = Boolean(response?.batch) || multiRound
      setResult({ ok: response?.ok, rows, summary, stayOpen })
      if (!created.length) return
      // 已加入的行从输入框移走；失败/重复行留着，改完或确认后可以直接再提交。
      const keep = new Set(rows.filter((row) => !row.ok).map((row) => row.url))
      setText(entries.filter((entry) => keep.has(entry.url)).map((entry) => entry.url).join('\n'))
      if (stayOpen) {
        const payload = response.batch
          ? { batch: response.batch, summary, appended: appendBatch }
          : { id: created[0].id, summary }
        setLastCreated(payload)
        onSubmitted?.(payload)
        return
      }
      onCreated?.({ id: created[0].id, summary })
      onClose?.()
    } catch (failure) {
      const rows = failure?.data?.results
      if (Array.isArray(rows) && rows.length) {
        // 全部重复/失败时后端回 400；照样按行展示原因，而不是只留一个 HTTP 400。
        setResult({
          ok: false,
          rows,
          summary: {
            added: 0,
            duplicates: rows.filter((row) => row.duplicate).length,
            failed: rows.filter((row) => !row.ok && !row.duplicate).length
          },
          stayOpen: false
        })
        setError('')
      } else {
        setError(failure?.message || String(failure))
      }
    } finally {
      setSubmitting(false)
    }
  }

  function finish() {
    if (lastCreated) onCreated?.(lastCreated)
    onClose?.()
  }

  const canSubmit = entries.length > 0 && !submitting && entries.every((entry) => !entry.loading)
  const duplicateUrls = result?.rows?.filter((row) => row.duplicate).map((row) => row.url) || []
  const summaryParts = []
  if (result?.summary) {
    if (result.summary.added) summaryParts.push(t('new.addedCount').replace('{n}', String(result.summary.added)))
    if (result.summary.duplicates) summaryParts.push(t('new.duplicateCount').replace('{n}', String(result.summary.duplicates)))
    if (result.summary.failed) summaryParts.push(t('new.failedCount').replace('{n}', String(result.summary.failed)))
  }

  return (
    <div className="mc-new-form">
      <p className="mc-card-text">
        {appendBatch
          ? t('new.batchVideoHint').replace('{title}', batch?.title || '批量视频').replace('{n}', String(batchTotal))
          : t('new.videoHint')}
      </p>
      <textarea ref={textareaRef} className="mc-input mc-textarea" value={text}
        onChange={(event) => updateText(event.target.value)} onPaste={pasteLinks}
        placeholder={'https://www.bilibili.com/video/…\nhttps://www.youtube.com/watch?v=…'} spellCheck={false} rows={4} />
      <div className="mc-actions">
        <button type="button" className="mc-button mc-button-small" onClick={addLink} disabled={entries.length >= MAX_BATCH_LINKS}>增加链接</button>
        <button type="button" className="mc-button" onClick={previewAll} disabled={entries.length === 0 || previewingAll}>
          {previewingAll ? t('new.checking') : t('new.previewAll')}
        </button>
        <span className="mc-foot-meta">{entries.length} / {MAX_BATCH_LINKS}</span>
      </div>
      {parsed.total ? (
        <p className="mc-foot-meta" role="status">
          已识别 {entries.length} 条视频链接{skippedText ? ` · 自动跳过：${skippedText}` : ''}
          {entries.length >= MAX_BATCH_LINKS && parsed.skipped.overflow ? ` · 单次最多 ${MAX_BATCH_LINKS} 条` : ''}
        </p>
      ) : null}
      {entries.some((entry) => entry.platform === 'douyin') ? (
        <div className="mc-notice" data-tone="info">
          抖音需要浏览器 Cookie：请在「设置 → 采集 → 视频」打开扫码登录页，用抖音 App 扫码登录后读取浏览器 Cookie。
        </div>
      ) : null}

      {entries.map((entry, index) => (
        <VideoEntry key={`${entry.url}-${index}`} t={t} entry={entry} index={index}
          removable={entries.length > 1}
          onRemove={() => removeEntry(index)}
          onChangeTrack={(trackId) => setEntries((current) => current.map((item, i) => i === index ? { ...item, trackId } : item))}
          onChangeMode={(mode) => setEntries((current) => current.map((item, i) => i === index ? { ...item, mode } : item))}
          onPreview={() => previewEntry(index)} />
      ))}

      {error ? <div className="mc-error-text" role="alert">{error}</div> : null}
      {result ? (
        <div className="mc-result-list">
          {summaryParts.length || duplicateUrls.length ? (
            <div className="mc-result-summary">
              <span>
                {summaryParts.join(' · ')}
                {result.stayOpen && result.summary?.added ? ` · ${t('new.continueHint')}` : ''}
                {!result.summary?.added && result.summary?.duplicates ? ` · ${t('new.forceHint')}` : ''}
              </span>
              {duplicateUrls.length ? (
                <button type="button" className="mc-button mc-button-small" disabled={submitting}
                  onClick={() => submit({ allowDuplicate: true, onlyUrls: duplicateUrls })}>
                  {t('new.forceDuplicates')}
                </button>
              ) : null}
            </div>
          ) : null}
          {result.rows.map((row, index) => (
            <div key={index} className="mc-result-row">
              <span className={row.ok ? 'mc-ok-text' : 'mc-error-text'}>{row.ok ? '✓' : '×'}</span>
              <span className="mc-result-title">{row.title || row.url}</span>
              <span>{row.ok ? (row.duplicate ? t('new.duplicate') : t('new.queueAdded')) : row.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mc-modal-actions">
        <button type="button" className="mc-button" onClick={lastCreated ? finish : onClose}>
          {lastCreated ? t('new.finish') : result ? t('new.close') : t('new.cancel')}
        </button>
        <button type="button" className="mc-button" data-variant="primary" data-new-submit="true" disabled={!canSubmit} onClick={() => submit()}>
          {submitting ? t('new.checking') : appendBatch ? t('new.batchAdd') : t('new.add')}
        </button>
      </div>
    </div>
  )
}

function VideoEntry({ t, entry, removable, onRemove, onChangeTrack, onChangeMode, onPreview }) {
  const preview = entry.preview
  const tracks = preview?.subtitle_tracks || []
  const needsTrack = preview?.subtitle_status === 'available' && tracks.length > 0 && !entry.trackId
  const [thumbFailed, setThumbFailed] = React.useState(false)
  React.useEffect(() => { setThumbFailed(false) }, [preview?.thumbnail])
  const thumbnail = thumbFailed ? '' : (preview?.thumbnail || '')
  return (
    <div className="mc-preview-card mc-preview-entry">
      {thumbnail ? (
        <img src={thumbnail} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
          onError={() => setThumbFailed(true)} />
      ) : (
        <span className="mc-preview-thumb-placeholder">{platformLabel(preview?.platform || entry.platform)}</span>
      )}
      <div className="mc-preview-main">
        <strong>{preview?.title && preview.title !== '未命名视频' ? preview.title : entry.url}</strong>
        <span>{[platformLabel(preview?.platform || entry.platform), preview?.uploader, preview?.duration ? duration(preview.duration) : '', preview?.filesize ? bytes(preview.filesize) : '', preview?.ok ? preview?.message : ''].filter(Boolean).join(' · ')}</span>
        {entry.loading ? <span>{t('new.checking')}</span> : null}
        {entry.error ? <span className="mc-error-text">{entry.error}</span> : null}
        <div className="mc-entry-controls">
          {preview?.ok && preview?.subtitle_status === 'available' ? (
            <>
              <select className="mc-input mc-select" value={entry.mode} onChange={(event) => onChangeMode(event.target.value)} aria-label="转写方式">
                <option value="auto">字幕优先</option>
                <option value="asr">语音识别</option>
              </select>
              {entry.mode === 'auto' && tracks.length > 1 ? (
                <select className={`mc-input mc-select${needsTrack ? ' mc-invalid' : ''}`} value={entry.trackId} onChange={(event) => onChangeTrack(event.target.value)}>
                  <option value="">请选择字幕语言</option>
                  {tracks.map((track) => <option key={track.id} value={track.id}>{track.title || track.language}</option>)}
                </select>
              ) : null}
            </>
          ) : null}
          {entry.error || preview?.ok === false ? (
            <button type="button" className="mc-button mc-button-small" onClick={onPreview} disabled={entry.loading}>重试</button>
          ) : !preview ? (
            <button type="button" className="mc-button mc-button-small" onClick={onPreview} disabled={entry.loading}>{t('new.preview')}</button>
          ) : null}
        </div>
        {preview?.ok && preview?.subtitle_status !== 'available' ? (
          <span className="mc-foot-meta">未发现可用字幕，将使用云端 ASR 转写。</span>
        ) : null}
      </div>
    </div>
  )
}

export function MeetingForm({ t, options, optionsError, initialFile = null, onClose, onCreated }) {
  const [file, setFile] = React.useState(initialFile)
  const [uploading, setUploading] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  const [title, setTitle] = React.useState(() => initialFile?.name ? initialFile.name.replace(/\.[^.]+$/, '') : '')
  const [language, setLanguage] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')

  const asrReady = options?.asr_ready !== false
  const MEDIA_EXT = ['mp4', 'mov', 'mkv', 'flv', 'webm', 'm4v', 'ts', 'mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus']

  async function choose() {
    setError('')
    try {
      const result = await pickFile('media')
      if (result?.ok && result.path) {
        const name = result.path.split('/').pop()
        setFile({ path: result.path, name })
        if (!title) setTitle(name.replace(/\.[^.]+$/, ''))
      } else if (result && !result.cancelled) {
        setError(result.error || t('settings.pickFailed'))
      }
    } catch (failure) {
      setError(failure?.message || String(failure))
    }
  }

  async function upload(files) {
    const chosen = files?.[0]
    if (!chosen) return
    const extension = String(chosen.name || '').split('.').pop()?.toLowerCase()
    if (!MEDIA_EXT.includes(extension)) {
      setError(`不支持的文件格式：.${extension || '未知'}`)
      return
    }
    setUploading(0.001)
    setError('')
    try {
      const result = await uploadFile(chosen, (ratio) => setUploading(ratio))
      setFile({ path: result.path, name: result.name, bytes: result.bytes })
      if (!title) setTitle((result.name || '').replace(/\.[^.]+$/, ''))
      setUploading(0)
    } catch (failure) {
      setUploading(0)
      setError(failure?.message || String(failure))
    }
  }

  async function submit() {
    setSubmitting(true)
    setError('')
    try {
      const created = await importMeeting({
        path: file.path,
        title: title.trim(),
        language
      })
      onCreated?.(created.id)
      onClose()
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setSubmitting(false)
    }
  }

  const suffix = file?.name?.includes('.') ? file.name.split('.').pop().toUpperCase().slice(0, 4) : ''

  return (
    <div className="mc-new-form">
      <div className="mc-file-field" data-filled={file ? 'true' : 'false'} data-drag={dragging ? 'true' : 'false'}
        title={t('new.meetingHint')}
        onDragOver={(event) => { event.preventDefault(); if (!dragging) setDragging(true) }}
        onDragLeave={(event) => { const next = event.relatedTarget; if (!next || !event.currentTarget.contains(next)) setDragging(false) }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); upload(event.dataTransfer?.files) }}>
        <div className="mc-file-row">
          {file ? (
            <>
              <span className="mc-file-badge" aria-hidden="true">{suffix || 'FILE'}</span>
              <span className="mc-file-name">{file.name}</span>
              {file.bytes ? <span className="mc-file-size">{(file.bytes / 1024 / 1024).toFixed(1)} MB</span> : null}
              <button type="button" className="mc-button mc-button-small" onClick={choose}>{t('new.replaceFile')}</button>
            </>
          ) : (
            <>
              <span className="mc-file-hint">{t('new.dropHint')}</span>
              <button type="button" className="mc-button mc-button-small" onClick={choose}>{t('new.chooseFile')}</button>
            </>
          )}
        </div>
        {uploading > 0 ? (
          <div className="mc-file-upload">
            <span className="mc-progress"><span style={{ width: `${Math.max(1, Math.min(100, uploading * 100))}%` }} /></span>
            <span className="mc-file-upload-text">{t('new.uploadProgress').replace('{p}', String(Math.round(uploading * 100)))}</span>
          </div>
        ) : null}
      </div>

      <div className="mc-field-pair">
        <label className="mc-field mc-field-grow">
          <span>{t('new.titleLabel')}</span>
          <input className="mc-input" value={title} placeholder={t('new.titlePlaceholder')} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="mc-field mc-field-lang">
          <span>{t('new.language')}</span>
          <select className="mc-input mc-select" value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="">{t('new.auto')}</option>
            {(options?.languages || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
      </div>

      {!asrReady ? <div className="mc-error-text">{t('new.asrNotReady')}</div> : null}
      {optionsError ? <div className="mc-error-text">{optionsError}</div> : null}
      {error ? <div className="mc-error-text" role="alert">{error}</div> : null}

      <div className="mc-modal-actions">
        <button type="button" className="mc-button" onClick={onClose}>{t('new.cancel')}</button>
        <button type="button" className="mc-button" data-variant="primary" data-new-submit="true"
          disabled={!file || submitting || uploading > 0 || !asrReady} onClick={submit}>
          {submitting ? t('new.checking') : t('new.submit')}
        </button>
      </div>
    </div>
  )
}
