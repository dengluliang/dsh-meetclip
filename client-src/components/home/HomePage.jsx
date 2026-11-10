import { addPackMembers, boardImageUrl, boardImages, createPack, createStickyNote, deleteBoardImage, deletePack, deleteStickyNote, fileUrl, homeFeed, listCards, openExternal, pickFile, removePackMembers, renamePack, renameSession, reorderPackMembers, stickyNotes, syncCards, updateStickyNote, uploadBoardImage } from '../../lib/api.js'
import { clock, dateTime, kindInfo, statusText } from '../../lib/format.js'
import { NoteEditor } from './NoteEditor.jsx'
import { PinMark, ScatterCanvas } from './ScatterCanvas.jsx'
import { BatchCard } from './BatchCard.jsx'
import { BatchOverlay } from './BatchOverlay.jsx'
import { PackCard } from './PackCard.jsx'
import { PackOverlay } from './PackOverlay.jsx'
import { entryKey } from './scatter-layout.js'
import { applyPacks, entryMember, fanPositions, nextPackTitle, packById, packKey, packMatchesFilter, packMemberKey, PACK_TYPE } from './pack-model.js'
import { CaptureInline } from '../capture/CaptureInline.jsx'
import { SetupProgressCards } from './SetupProgressCards.jsx'
import { MAX_MEETING_FILES, filesFromPaths, mergeMeetingFiles } from '../../lib/meetingFiles.js'
import { ContextMenu, useContextMenu } from '../ContextMenu.jsx'
import { cancelLink, deleteSession, deleteSessions, revealRecord } from '../../lib/api.js'
import { openCardAgentDraft, sendPromptToAgent } from '../../lib/agent.js'
import { imageFilesFromClipboard, isBoardImage, looksLikeImageFile, stickyFromClipboard } from '../../lib/paste.js'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'live', label: '直播' },
  { id: 'link_video', label: '视频' },
  { id: 'meeting', label: '会议' },
  { id: 'doc', label: '文档' },
  { id: 'active', label: '进行中' },
  { id: 'mark', label: '标记' }
]

const PINS_KEY = 'meetclip.scatter.pins.v1'
const ACTIVE_STATUSES = ['recording', 'processing', 'queued']

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]'
const DIALOG_SELECTOR = '[role="dialog"], dialog'

// 正在输入或弹层里时，⌘V 该归输入框/弹层自己处理，不接管成画板卡片。
function pasteBusy(target) {
  if (typeof document === 'undefined') return true
  const selectors = `${EDITABLE_SELECTOR}, ${DIALOG_SELECTOR}`
  for (const node of [target, document.activeElement]) {
    if (!node || node.nodeType !== 1) continue
    if (node.isContentEditable) return true
    if (typeof node.closest === 'function' && node.closest(selectors)) return true
  }
  return Boolean(document.querySelector(`.mc-root ${DIALOG_SELECTOR}, .mc-modal-layer, .mc-note-editor, .mc-context`))
}

// 粘贴落在当前视野中心：散落模式下取画布视口的中央，信息流模式不关心坐标。
function pasteAnchor(pointRef, seqRef) {
  let point = null
  try {
    point = pointRef?.current?.() || null
  } catch {
    point = null
  }
  const seq = Number(seqRef?.current) || 0
  if (seqRef) seqRef.current = seq + 1
  const offset = (seq % 4) * 26
  return {
    x: Math.round((Number(point?.x) || 0) + offset),
    y: Math.round((Number(point?.y) || 0) + offset * 0.8)
  }
}

function isActiveTask(item) {
  return Boolean(item) && ACTIVE_STATUSES.includes(item.status)
}

function activeTaskLabel(item) {
  if (item?.status === 'recording') return '录制中'
  if (item?.status === 'processing') return '处理中'
  if (item?.status === 'queued') return '排队中'
  return '进行中'
}

const ACTIVE_RANK = { recording: 0, processing: 1, queued: 2 }

// Hero 里的「N 条正在进行」要直接把人送到那条记录，挑一条最该看的：
// 在录的优先，其次转写中，再其次排队；同一状态里取最近开始的。
function activeTaskOrder(a, b) {
  const rank = (ACTIVE_RANK[a?.status] ?? 3) - (ACTIVE_RANK[b?.status] ?? 3)
  if (rank) return rank
  return (Number(b?.started_at || b?.created_at) || 0) - (Number(a?.started_at || a?.created_at) || 0)
}

function pickActiveTask(activeItems) {
  const rows = (activeItems || []).slice().sort(activeTaskOrder)
  return rows[0] || null
}

function readPins() {
  try {
    const value = JSON.parse(localStorage.getItem(PINS_KEY) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

function coverToUrl(item, cover) {
  if (!cover?.value) return null
  return cover.type === 'remote' ? cover.value : fileUrl(item.id, cover.value)
}

function coverSources(item) {
  const list = [coverToUrl(item, item?.cover), coverToUrl(item, item?.cover?.fallback)].filter(Boolean)
  return [...new Set(list)]
}

function Cover({ item, sources, onBroken }) {
  const [index, setIndex] = React.useState(0)
  const source = sources[index]
  if (!source) return null
  return (
    <div className="mc-home-cover" data-kind={kindInfo(item.kind).tone}>
      <img src={source} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer"
        onError={() => {
          if (index + 1 < sources.length) setIndex(index + 1)
          else onBroken()
        }} />
      {item.status === 'recording' ? <span className="mc-home-live"><i />录制中</span> : null}
      {item.duration ? <span className="mc-home-duration">{clock(item.duration)}</span> : null}
    </div>
  )
}

function SessionCard({ item, t, onOpen, onCopyLink, onDelete, onMenu,
  renaming = false, renameDraft = '', onRenameChange, onRenameCommit, onRenameCancel }) {
  const partialStatus = item.status === 'error'
    && (item.asr_status === 'partial' || Number(item.missing_chunks) > 0)
  const active = isActiveTask(item)
  const info = kindInfo(item.kind)
  const [imageFailed, setImageFailed] = React.useState(false)
  const sources = coverSources(item)
  const hasCover = sources.length > 0 && !imageFailed
  return (
    <article className={`mc-home-card${hasCover ? '' : ' is-text'}${active ? ' is-active' : ''}${renaming ? ' is-renaming' : ''}`}
      data-kind={info.tone} data-active={active ? 'true' : undefined}
      tabIndex={renaming ? -1 : 0} role={renaming ? undefined : 'button'}
      aria-label={`${active ? '进行中，' : ''}${info.label}：${item.title}`}
      onClick={() => { if (!renaming) onOpen(item) }}
      onContextMenu={(event) => onMenu?.(item, event)}
      onKeyDown={(event) => {
        if (renaming) return
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item) }
      }}>
      {hasCover ? <Cover item={item} sources={sources} onBroken={() => setImageFailed(true)} /> : null}
      <div className="mc-home-card-body">
        <div className="mc-home-card-top">
          <span className={`mc-home-type-inline mc-home-tone-${info.tone}`}>{info.label}</span>
          {active ? (
            <span className="mc-home-active-pill" data-status={item.status}><i />{activeTaskLabel(item)}</span>
          ) : (
            <span className="mc-home-status" data-status={partialStatus ? 'partial' : item.status}>
              <i />{statusText(item.status, t, partialStatus)}
            </span>
          )}
        </div>
        {renaming ? (
          <div className="mc-home-card-rename" onClick={(event) => event.stopPropagation()}>
            <input className="mc-home-card-rename-input" autoFocus
              aria-label="记录标题" title="回车保存 · Esc 取消"
              value={renameDraft}
              onFocus={(event) => { try { event.currentTarget.select() } catch {} }}
              onChange={(event) => onRenameChange?.(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation()
                // 中文输入法回车是上屏，不能当成保存。
                if (event.key === 'Enter' && (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229)) return
                if (event.key === 'Enter') { event.preventDefault(); onRenameCommit?.() }
                else if (event.key === 'Escape') { event.preventDefault(); onRenameCancel?.() }
              }}
              onBlur={() => onRenameCommit?.()} />
            <p className="mc-home-card-rename-hint">回车保存 · Esc 取消</p>
          </div>
        ) : (
          <>
            <h3 className="mc-home-card-title">{item.title}</h3>
            {item.snippet ? <p className="mc-home-card-snippet">{item.snippet}</p> : null}
          </>
        )}
        <div className="mc-home-card-foot">
          <span>{item.platform && item.platform !== 'bilibili' ? item.platform : info.label}</span>
          <span>{dateTime(item.started_at || item.created_at)}</span>
          <span className="mc-home-card-counts">
            {!hasCover && item.duration ? `${clock(item.duration)} · ` : ''}
            {item.marks ? `${item.marks} 标记` : ''}
            {item.screenshots ? ` · ${item.screenshots} 截图` : ''}
          </span>
        </div>
      </div>
      <div className="mc-home-card-actions">
        {onDelete && !active ? (
          <button type="button" data-action="delete" title="删除记录"
            onClick={(event) => { event.stopPropagation(); onDelete(item) }}>删除</button>
        ) : null}
        {onCopyLink && item.source_url ? (
          <button type="button" onClick={(event) => { event.stopPropagation(); onCopyLink(item.source_url) }}>复制链接</button>
        ) : null}
      </div>
    </article>
  )
}

const DOC_TYPE_LABELS = {
  docx: '飞书文档',
  wiki: '飞书知识库',
  sheet: '飞书表格',
  base: '飞书多维表格',
  docs: '飞书文档'
}

function DocWallCard({ doc, onOpen, onMenu, t }) {
  const label = DOC_TYPE_LABELS[doc.doc_type] || t('home.docs.title')
  return (
    <article className="mc-doc-wall-card" role="button" tabIndex={0}
      aria-label={`${label}：${doc.title}`}
      onClick={() => onOpen(doc)}
      onContextMenu={(event) => onMenu?.(doc, event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(doc)
        }
      }}>
      <span className="mc-doc-wall-top">
        <span>{label}</span>
        <span>{dateTime(doc.updated_at)}</span>
      </span>
      <strong className="mc-doc-wall-title">{doc.title}</strong>
      <span className="mc-doc-wall-foot">
        <span>{doc.has_content ? t('home.docs.hasContent') : t('home.docs.linkOnly')}</span>
        <span>{t('home.docs.open')} ↗</span>
      </span>
    </article>
  )
}

function HighlightCard({ item, onOpen, onMenu }) {
  return (
    <article className="mc-home-card mc-home-quote" tabIndex={0} role="button"
      aria-label={`标记：${item.note}`}
      onClick={() => onOpen({ id: item.session_id, title: item.session_title, kind: item.kind }, item.ts)}
      onContextMenu={(event) => onMenu?.(event)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen({ id: item.session_id, title: item.session_title, kind: item.kind }, item.ts)
        }
      }}>
      <div className="mc-home-quote-mark">“</div>
      <blockquote>{item.note}</blockquote>
      <div className="mc-home-card-foot">
        <span>{item.session_title}</span>
        <span>{clock(item.ts)}</span>
        <span>{dateTime(item.created_at)}</span>
      </div>
    </article>
  )
}

function Hero({ stats, items = [], t, onFilter, onOpenRecord, onCaptureCreated, onCaptureSubmitted, library = null, dataDir = '' }) {
  const [text, setText] = React.useState('')
  const [hint, setHint] = React.useState('')
  const [capture, setCapture] = React.useState(null)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [pickingFile, setPickingFile] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const plusRef = React.useRef(null)
  const now = new Date()
  const weekdays = '日一二三四五六'
  const hours = stats?.duration ? (stats.duration / 3600).toFixed(1) : '0'
  const activeItems = items.filter(isActiveTask)
  const activeCount = Number(stats?.active) || activeItems.length
  const activeTarget = pickActiveTask(activeItems)

  // 菜单开着时点击别处或 Esc 就收起；Esc 后把焦点还给「＋」。
  React.useEffect(() => {
    if (!menuOpen) return undefined
    function onPointer(event) {
      if (!plusRef.current?.contains(event.target)) setMenuOpen(false)
    }
    function onKey(event) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setMenuOpen(false)
      plusRef.current?.querySelector('button')?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  function choose(kind) {
    setMenuOpen(false)
    setHint('')
    if (kind === 'meeting') {
      chooseFile()
      return
    }
    if (kind === 'launch' || kind === 'video' || kind === 'doc') setCapture({ type: kind, url: '' })
  }

  async function chooseFile() {
    if (pickingFile) return
    setPickingFile(true)
    setHint('')
    try {
      const result = await pickFile('media', { multiple: true })
      const paths = Array.isArray(result?.paths) && result.paths.length
        ? result.paths
        : (result?.path ? [result.path] : [])
      if (paths.length) {
        const merged = mergeMeetingFiles([], filesFromPaths(paths))
        if (!merged.files.length) {
          setHint('只支持音频或视频文件（mp4/mov/mkv/flv/webm/m4v/ts 与常见音频格式）')
          return
        }
        const ignored = merged.rejected.length + merged.duplicates
        if (merged.overflow) setHint(`单次最多 ${MAX_MEETING_FILES} 个文件，已忽略 ${merged.overflow} 个`)
        else if (ignored) setHint(`已忽略 ${ignored} 个不支持的文件`)
        setCapture({ type: 'meeting', files: merged.files })
      } else if (result && !result.cancelled) {
        setHint(result.error || '无法打开文件选择器')
      }
    } catch (failure) {
      setHint(failure?.message || '无法打开文件选择器')
    } finally {
      setPickingFile(false)
    }
  }

  function closeCapture() {
    setCapture(null)
    setHint('')
  }

  function created(payload) {
    setCapture(null)
    setHint('')
    onCaptureCreated?.(payload)
  }

  async function submit(event) {
    event.preventDefault()
    if (capture || sending) return
    const value = text.trim()
    if (!value) return
    setSending(true)
    setHint('')
    try {
      await sendPromptToAgent(value, { path: dataDir })
      setText('')
    } catch (failure) {
      setHint(failure?.message || t('home.agent.failed'))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="mc-home-hero">
      <p className="mc-home-date">
        {now.getFullYear()} · {now.getMonth() + 1} 月 {now.getDate()} 日 · 周{weekdays[now.getDay()]}
        {library?.name ? <span className="mc-home-library"> {library.name}</span> : null}
      </p>
      <h1 className="mc-home-headline">
        你留下了 <b className="mc-home-serif">{stats?.total || 0}</b> 段现场，共 <b className="mc-home-serif">{hours}</b> 小时。
        <br />
        本周新增 <b>{stats?.week || 0}</b> 条
        {activeCount ? <>，<button type="button" className="mc-home-alert-link"
          title={activeTarget
            ? `打开${activeItems.length > 1 ? '最近一条' : '这条'}进行中的记录：${activeTarget.title || activeTarget.id}`
            : '只看正在进行的任务'}
          aria-label={activeTarget ? `打开进行中的记录：${activeTarget.title || activeTarget.id}` : '只看正在进行的任务'}
          onClick={() => (activeTarget ? onOpenRecord?.(activeTarget) : onFilter('active'))}>{activeCount} 条正在进行</button></> : null}
      </h1>
      <form className="mc-home-capture" data-menu={menuOpen ? 'true' : 'false'} data-capture={capture ? 'true' : 'false'} data-sending={sending ? 'true' : 'false'} onSubmit={submit}>
        <div className="mc-home-plus-wrap" ref={plusRef}>
          <button type="button" className="mc-home-plus" data-testid="hero-new-capture"
            aria-label={t('home.entry.title')} aria-haspopup="menu" aria-expanded={menuOpen}
            aria-controls="meetclip-new-capture-menu" title={t('home.entry.title')}
            disabled={pickingFile || Boolean(capture) || sending}
            onClick={() => setMenuOpen((value) => !value)}>{pickingFile ? '…' : '＋'}</button>
          {menuOpen ? (
            <div id="meetclip-new-capture-menu" className="mc-home-plus-menu mc-omnibox-pop" role="menu" aria-label={t('home.entry.title')}>
              {CAPTURE_ENTRIES.map((entry) => (
                <button key={entry.kind} type="button" role="menuitem" data-kind={entry.kind} onClick={() => choose(entry.kind)}>
                  <strong>{t(entry.title)}</strong><span>{t(entry.hint)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <input value={text} readOnly={Boolean(capture) || sending} data-testid="hero-agent-input"
          onChange={(event) => { setText(event.target.value); if (hint) setHint('') }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              if (capture) closeCapture()
              else if (menuOpen) setMenuOpen(false)
              return
            }
            if (event.key === 'Enter' && (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229)) {
              event.preventDefault()
            }
          }}
          placeholder={capture ? t('home.agent.captureOpen') : sending ? t('home.agent.sending') : t('home.agent.placeholder')}
          aria-label={t('home.agent.aria')} aria-busy={sending ? 'true' : 'false'} spellCheck={false} />
        {capture ? (
          <CaptureInline
            key={`${capture.type}-${capture.url || (capture.files || []).map((file) => file.path).join('|') || capture.file?.path || ''}`}
            t={t}
            type={capture.type}
            url={capture.url || ''}
            file={capture.file || null}
            files={capture.files || null}
            onClose={closeCapture}
            onCreated={created}
            onSubmitted={onCaptureSubmitted}
          />
        ) : null}
      </form>
      {sending ? <div className="mc-home-capture-note" role="status">{t('home.agent.sending')}</div> : null}
      {hint ? <div className="mc-home-capture-error" role="alert">{hint}</div> : null}
    </section>
  )
}

function todoItems(text) {
  return String(text || '').split('\n')
    .map((line) => line.match(/^\s*-\s+(.*)$/))
    .filter(Boolean)
    .map((match) => match[1].replace(/^\[[ xX]\]\s*/, '').trim())
    .filter(Boolean)
}

function imageDimensions(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 }); URL.revokeObjectURL(url) }
    image.onerror = () => { resolve({ width: 0, height: 0 }); URL.revokeObjectURL(url) }
    image.src = url
  })
}

// 与记录卡一致的右上角动作：悬停才出现，样式统一用「删除」胶囊。
function CardActions({ label, onDelete }) {
  return (
    <div className="mc-card-actions">
      <button type="button" data-action="delete" aria-label={label} title={label}
        onClick={(event) => { event.stopPropagation(); onDelete?.() }}>删除</button>
    </div>
  )
}

function ImageCard({ image, onDelete, onMenu }) {
  const ratio = image.width && image.height ? `${image.width} / ${image.height}` : '4 / 3'
  return (
    <article className="mc-image-card" onContextMenu={(event) => onMenu?.(event)}>
      <img src={boardImageUrl(image.id)} alt="画板图片" draggable={false} loading="lazy" style={{ aspectRatio: ratio }} />
      {onDelete ? <CardActions label="删除图片卡" onDelete={() => onDelete(image)} /> : null}
    </article>
  )
}

function StickyCard({ note, onToggle, onDelete, onMenu, onEdit }) {
  const todos = note.kind === 'todo' ? todoItems(note.text) : []
  const body = String(note.text || '').split('\n').filter((line) => !/^\s*-\s+/.test(line)).join('\n').trim()
  function edit(event) {
    if (event.target?.closest?.('button, input, label, a')) return
    event.stopPropagation()
    onEdit?.(note, event)
  }
  return (
    <article className="mc-sticky-card" data-kind={note.kind || 'note'}
      onDoubleClick={edit}
      onContextMenu={(event) => onMenu?.(event)}>
      <div className="mc-sticky-head">
        <span>{note.kind === 'todo' ? '待办清单' : '便利签'}</span>
      </div>
      {body ? <p className="mc-sticky-text">{body}</p> : null}
      {note.kind === 'todo' ? (
        <div className="mc-sticky-todos">
          {todos.map((text, index) => (
            <label key={`${index}-${text}`} className="mc-sticky-todo" data-done={Boolean(note.checked?.[index])}>
              <input type="checkbox" checked={Boolean(note.checked?.[index])}
                onChange={() => onToggle(note, index)} />
              <span>{text}</span>
            </label>
          ))}
        </div>
      ) : null}
      {!body && note.kind !== 'todo' ? <p className="mc-sticky-text">{note.text}</p> : null}
      {onDelete ? <CardActions label={note.kind === 'todo' ? '删除待办清单' : '删除便利签'} onDelete={() => onDelete(note)} /> : null}
    </article>
  )
}

const CAPTURE_ENTRIES = [
  { kind: 'launch', title: 'home.entry.launch', hint: 'home.entry.launchHint' },
  { kind: 'video', title: 'home.entry.video', hint: 'home.entry.videoHint' },
  { kind: 'meeting', title: 'home.entry.meeting', hint: 'home.entry.meetingHint' },
  { kind: 'doc', title: 'home.entry.doc', hint: 'home.entry.docHint' }
]

function Empty({ t, onNewCapture }) {
  return (
    <div className="mc-home-empty">
      <h2>摘录墙还是空的</h2>
      <p>从一场直播、一个视频链接、一次会议录音，或一篇飞书文档开始。转写、截图和标记会自动铺到这里。</p>
      <div className="mc-home-empty-grid">
        {CAPTURE_ENTRIES.map((entry) => (
          <button key={entry.kind} type="button" onClick={() => onNewCapture({ kind: entry.kind })}>
            <strong>{t(entry.title)}</strong><span>{t(entry.hint)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function HomePage({ t, revision = 0, onOpenRecord, onNewCapture, onToast, onCaptureCreated,
  batchFocus = null, onBatchFocusHandled, packFocus = null, onPackFocusHandled,
  library = null, dataDir = '' }) {
  const [data, setData] = React.useState(null)
  const [items, setItems] = React.useState([])
  const [highlights, setHighlights] = React.useState([])
  const [batches, setBatches] = React.useState([])
  const [openBatchId, setOpenBatchId] = React.useState('')
  const [batchAppend, setBatchAppend] = React.useState(false)
  const [focusedBatchId, setFocusedBatchId] = React.useState('')
  const [packs, setPacks] = React.useState([])
  const packsRef = React.useRef(packs)
  packsRef.current = packs
  const [openPackId, setOpenPackId] = React.useState('')
  const [packRenameFocus, setPackRenameFocus] = React.useState(false)
  const [packBusy, setPackBusy] = React.useState(false)
  const [packUndo, setPackUndo] = React.useState(null)
  const packBusyRef = React.useRef(false)
  const askingCardRef = React.useRef(false)
  const packUndoTimer = React.useRef(null)
  const undoBusyRef = React.useRef(false)
  const layoutApiRef = React.useRef(null)
  const [notes, setNotes] = React.useState([])
  const [images, setImages] = React.useState([])
  const [pins, setPins] = React.useState(readPins)
  const [pinFlash, setPinFlash] = React.useState('')
  const pinFlashTimer = React.useRef(null)
  const [loading, setLoading] = React.useState(true)
  const [more, setMore] = React.useState(false)
  const [error, setError] = React.useState('')
  const [kind, setKind] = React.useState('all')
  const [mode, setMode] = React.useState('scatter')
  const [sort, setSort] = React.useState('recent')
  const [localRevision, setLocalRevision] = React.useState(0)
  const sentinel = React.useRef(null)
  const homeRef = React.useRef(null)
  const pastePointRef = React.useRef(null)
  const pasteSeqRef = React.useRef(0)
  const pasteHandlersRef = React.useRef(null)
  const [confirm, setConfirm] = React.useState(null)
  // 首页卡片改名：同一张会话卡在墙面就地编辑，保存时写回资料库里同一条记录的标题。
  const [renamingCardId, setRenamingCardId] = React.useState('')
  const [cardRenameDraft, setCardRenameDraft] = React.useState('')
  const cardRenameTargetRef = React.useRef('')
  const [noteEditor, setNoteEditor] = React.useState(null)
  const focusHandledRef = React.useRef(0)
  const packFocusHandledRef = React.useRef(0)
  const focusClearRef = React.useRef(null)
  const { menu, open: openMenu, close: closeMenu } = useContextMenu()

  const load = React.useCallback(async (reset = true) => {
    if (reset) setLoading(true)
    try {
      const next = await homeFeed({ limit: 60, offset: 0 })
      setData(next)
      setItems((current) => {
        if (reset) return next.items || []
        const seen = new Set((next.items || []).map((item) => item.id))
        return [...(next.items || []), ...current.filter((item) => !seen.has(item.id))]
      })
      setHighlights(next.highlights || [])
      setBatches(Array.isArray(next.batches) ? next.batches : [])
      setPacks(Array.isArray(next.packs) ? next.packs : [])
      setError('')
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      if (reset) setLoading(false)
    }
  }, [])

  React.useEffect(() => { load(true) }, [load, revision, localRevision])

  React.useEffect(() => {
    let cancelled = false
    stickyNotes().then((rows) => { if (!cancelled) setNotes(Array.isArray(rows) ? rows : []) }).catch(() => {})
    return () => { cancelled = true }
  }, [revision, localRevision])

  React.useEffect(() => {
    let cancelled = false
    boardImages().then((rows) => { if (!cancelled) setImages(Array.isArray(rows) ? rows : []) }).catch(() => {})
    return () => { cancelled = true }
  }, [revision, localRevision])

  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(false)
    }, 30000)
    return () => clearInterval(timer)
  }, [load])

  // 主界面 ⌘V：没在输入框/弹层里时，图片按图片卡流程贴到画板，文字落成便利签（列表自动转待办）。
  React.useEffect(() => {
    pasteHandlersRef.current = { addNote, addImages, toast: onToast }
  })
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    function onPaste(event) {
      if (!event?.clipboardData || event.defaultPrevented) return
      if (!homeRef.current || homeRef.current.getClientRects().length === 0) return
      if (pasteBusy(event.target)) return
      const handlers = pasteHandlersRef.current
      if (!handlers) return
      const images = imageFilesFromClipboard(event.clipboardData)
      if (images.length) {
        const supported = images.filter((file) => isBoardImage(file.type, file.name))
        if (!supported.length) {
          handlers.toast?.('粘贴的图片格式不支持，仅限 PNG、JPEG、WebP、GIF、HEIC/HEIF')
          return
        }
        event.preventDefault()
        handlers.addImages?.(supported, pasteAnchor(pastePointRef, pasteSeqRef))
        return
      }
      const draft = stickyFromClipboard(event.clipboardData.getData('text/plain') || event.clipboardData.getData('text'))
      if (!draft) return
      const point = pasteAnchor(pastePointRef, pasteSeqRef)
      handlers.addNote?.({
        text: draft.text,
        x: point.x,
        y: point.y,
        toast: (note) => `已粘贴为${note?.kind === 'todo' ? '待办清单' : '便利签'}${draft.truncated ? '（已截断）' : ''}`
      })
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  async function loadMore() {
    if (more || items.length < 60) return
    setMore(true)
    try {
      const next = await homeFeed({ limit: 60, offset: items.length })
      const rows = next.items || []
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id))
        return [...current, ...rows.filter((item) => !seen.has(item.id))]
      })
    } catch (failure) {
      onToast?.(failure?.message || String(failure))
    } finally {
      setMore(false)
    }
  }

  React.useEffect(() => {
    const node = sentinel.current
    if (!node || mode !== 'feed' || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore()
    }, { rootMargin: '400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [mode, items.length, more])

  const batchMemberIds = React.useMemo(() => {
    const ids = new Set()
    for (const batch of batches) for (const member of batch.members || []) ids.add(member.id)
    return ids
  }, [batches])
  const batchEntries = React.useMemo(
    () => batches.map((batch) => ({ type: 'batch', at: batch.created_at || 0, item: batch })),
    [batches]
  )
  // 布局始终基于全部卡片：筛选只决定显示，不会让整面墙重新洗牌。
  // 卡包成员先收起，再由卡包作为一张顶层卡参与避让。
  // rawEntries 同时给卡包浮层复用：展开后直接用同一套卡片组件，不另做摘要样式。
  const rawEntries = React.useMemo(() => [
    ...items.filter((item) => !batchMemberIds.has(item.id))
      .map((item) => ({ type: 'session', at: item.started_at || item.created_at || 0, item })),
    ...batchEntries,
    ...highlights.map((item) => ({ type: 'highlight', at: item.created_at || 0, item })),
    ...notes.map((item) => ({ type: 'note', at: item.created_at || 0, item })),
    ...images.map((item) => ({ type: 'image', at: item.created_at || 0, item })),
    ...(data?.documents || []).map((item) => ({ type: 'doc', at: item.updated_at || 0, item }))
  ], [items, batchMemberIds, batchEntries, highlights, notes, images, data])
  const rawEntryByKey = React.useMemo(
    () => new Map(rawEntries.map((entry) => [entryKey(entry), entry])),
    [rawEntries]
  )
  const allEntries = React.useMemo(() => applyPacks(rawEntries, packs).sort((a, b) => {
    const pinnedA = pins[`${a.type}-${a.item.id}`] ? 1 : 0
    const pinnedB = pins[`${b.type}-${b.item.id}`] ? 1 : 0
    const activeOf = (entry) => {
      if (entry.type === 'session') return ['recording', 'processing', 'queued'].includes(entry.item.status) ? 1 : 0
      if (entry.type === 'batch') return Number(entry.item.active) > 0 ? 1 : 0
      if (entry.type === PACK_TYPE) return Number(entry.item.active_count) > 0 ? 1 : 0
      return 0
    }
    return pinnedB - pinnedA || activeOf(b) - activeOf(a) || b.at - a.at
  }), [rawEntries, packs, pins])
  const showHighlights = kind === 'all' || kind === 'mark'
  const showNotes = kind === 'all' || kind === 'mark'
  const entries = React.useMemo(() => allEntries.filter((entry) => {
    if (entry.type === PACK_TYPE) return packMatchesFilter(entry.item, kind)
    if (entry.type === 'batch') {
      if (kind === 'mark' || kind === 'live' || kind === 'meeting') return false
      if (kind === 'active') return Number(entry.item.active) > 0
      return true
    }
    if (entry.type === 'session') {
      if (kind === 'mark') return false
      if (kind === 'active') return isActiveTask(entry.item)
      if (['live', 'link_video', 'meeting'].includes(kind)) return entry.item.kind === kind
      return true
    }
    if (entry.type === 'doc') return kind === 'all' || kind === 'doc'
    if (entry.type === 'highlight') return showHighlights
    return showNotes
  }), [allEntries, kind, showHighlights, showNotes])
  const openPack = React.useMemo(() => packById(packs, openPackId), [packs, openPackId])

  React.useEffect(() => {
    if (!openPackId) return
    if (packById(packs, openPackId)) return
    setOpenPackId('')
    setPackRenameFocus(false)
  }, [packs, openPackId])

  React.useEffect(() => () => {
    if (packUndoTimer.current) clearTimeout(packUndoTimer.current)
  }, [])

  // 选中「重命名」时打开浮层并聚焦标题；普通打开不抢焦点。
  function openPackOverlay(pack, rename = false) {
    if (!pack?.id) return
    setOpenPackId(pack.id)
    setPackRenameFocus(Boolean(rename))
  }
  const visibleKeys = new Set(entries.map(entryKey))

  React.useEffect(() => () => {
    if (focusClearRef.current) clearTimeout(focusClearRef.current)
  }, [])

  React.useEffect(() => {
    if (!batchFocus?.id) return undefined
    if (focusHandledRef.current === batchFocus.nonce) return undefined
    const found = batches.find((batch) => batch.id === batchFocus.id)
    if (!found) return undefined
    focusHandledRef.current = batchFocus.nonce
    setKind('all')
    setFocusedBatchId(batchFocus.id)
    if (focusClearRef.current) clearTimeout(focusClearRef.current)
    focusClearRef.current = setTimeout(() => {
      setFocusedBatchId('')
      onBatchFocusHandled?.()
    }, 2400)
    if (mode === 'feed') {
      setTimeout(() => {
        const node = document.querySelector(`[data-batch-id="${batchFocus.id}"]`)
        if (node && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
      }, 120)
    }
    return undefined
  }, [batchFocus?.nonce, batchFocus?.id, batches, mode, onBatchFocusHandled])

  React.useEffect(() => {
    if (!packFocus?.id) return undefined
    if (packFocusHandledRef.current === packFocus.nonce) return undefined
    const found = packs.find((pack) => String(pack.id) === String(packFocus.id))
    if (!found) return undefined
    packFocusHandledRef.current = packFocus.nonce
    setKind('all')
    setOpenPackId(found.id)
    setPackRenameFocus(false)
    onPackFocusHandled?.()
    return undefined
  }, [packFocus?.nonce, packFocus?.id, packs, onPackFocusHandled])

  function togglePin(key) {
    const pinning = !pins[key]
    setPins((current) => {
      const next = { ...current }
      if (next[key]) delete next[key]
      else next[key] = true
      try { localStorage.setItem(PINS_KEY, JSON.stringify(next)) } catch {}
      return next
    })
    // 只有刚钉上的那张卡播一次落针动效；其它已固定的卡片不跟着重播。
    if (pinFlashTimer.current) clearTimeout(pinFlashTimer.current)
    if (pinning) {
      setPinFlash(key)
      pinFlashTimer.current = setTimeout(() => setPinFlash(''), 700)
    } else {
      setPinFlash((current) => (current === key ? '' : current))
    }
  }

  React.useEffect(() => () => {
    if (pinFlashTimer.current) clearTimeout(pinFlashTimer.current)
  }, [])

  function pinAction(key) {
    return { id: 'pin', label: pins[key] ? '取消图钉' : '图钉固定', onSelect: () => togglePin(key) }
  }

  function clearPackUndo() {
    if (packUndoTimer.current) clearTimeout(packUndoTimer.current)
    packUndoTimer.current = null
    setPackUndo(null)
  }

  function forgetPin(key) {
    setPins((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      try { localStorage.setItem(PINS_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  function beginPackBusy() {
    if (packBusyRef.current) return false
    clearPackUndo()
    packBusyRef.current = true
    setPackBusy(true)
    return true
  }

  function endPackBusy() {
    packBusyRef.current = false
    setPackBusy(false)
  }

  function replacePack(updated) {
    if (!updated?.id) return
    setPacks((current) => {
      const found = current.some((pack) => String(pack.id) === String(updated.id))
      if (!found) return [...current, updated]
      return current.map((pack) => (String(pack.id) === String(updated.id) ? updated : pack))
    })
  }

  function schedulePackUndo(label, run) {
    if (packUndoTimer.current) clearTimeout(packUndoTimer.current)
    setPackUndo({ label, run })
    packUndoTimer.current = setTimeout(() => {
      packUndoTimer.current = null
      setPackUndo(null)
    }, 5200)
  }

  async function runPackUndo() {
    if (undoBusyRef.current || !packUndo) return
    const action = packUndo
    undoBusyRef.current = true
    packBusyRef.current = true
    setPackBusy(true)
    clearPackUndo()
    try {
      await action.run()
    } catch (failure) {
      onToast?.(failure?.message || '撤销失败，请重试')
    } finally {
      undoBusyRef.current = false
      packBusyRef.current = false
      setPackBusy(false)
    }
  }

  function newPackId() {
    return `pack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function createEmptyPack(point) {
    if (!beginPackBusy()) return
    try {
      const result = await createPack({
        id: newPackId(),
        title: nextPackTitle(packsRef.current),
        members: []
      })
      const pack = result?.pack
      if (!pack?.id) throw new Error('卡包创建失败')
      layoutApiRef.current?.place(packKey(pack.id), point)
      setPacks((current) => [...current, pack])
      schedulePackUndo(`已新建「${pack.title}」`, async () => {
        await deletePack(pack.id)
        layoutApiRef.current?.remove(packKey(pack.id))
        forgetPin(packKey(pack.id))
        setPacks((current) => current.filter((row) => String(row.id) !== String(pack.id)))
        onToast?.('已撤销新建卡包')
      })
    } catch (failure) {
      onToast?.(failure?.message || '新建卡包失败')
    } finally {
      endPackBusy()
    }
  }

  async function mergeCards({ sourceKey, targetEntry, sourceEntry, targetPosition, sourceOrigin }) {
    if (!sourceEntry || !targetEntry) return false
    if (!beginPackBusy()) return false
    try {
      if (targetEntry.type === PACK_TYPE) {
        const pack = packById(packsRef.current, targetEntry.item.id) || targetEntry.item
        const result = await addPackMembers(pack.id, [entryMember(sourceEntry)])
        const updated = result?.pack
        if (!updated?.id) throw new Error('放进卡包失败')
        replacePack(updated)
        schedulePackUndo(`已放进「${updated.title}」`, async () => {
          const undone = await removePackMembers(updated.id, [entryMember(sourceEntry)])
          if (undone?.pack) replacePack(undone.pack)
          if (sourceKey && sourceOrigin) layoutApiRef.current?.place(sourceKey, sourceOrigin)
          onToast?.('已撤销放入卡包')
        })
        return true
      }

      const result = await createPack({
        id: newPackId(),
        title: nextPackTitle(packsRef.current),
        members: [entryMember(targetEntry), entryMember(sourceEntry)]
      })
      const pack = result?.pack
      if (!pack?.id) throw new Error('合成卡包失败')
      if (targetPosition) layoutApiRef.current?.place(packKey(pack.id), targetPosition)
      setPacks((current) => [...current, pack])
      schedulePackUndo(`已合成「${pack.title}」`, async () => {
        await deletePack(pack.id)
        layoutApiRef.current?.remove(packKey(pack.id))
        forgetPin(packKey(pack.id))
        if (sourceKey && sourceOrigin) layoutApiRef.current?.place(sourceKey, sourceOrigin)
        if (targetPosition) layoutApiRef.current?.place(entryKey(targetEntry), targetPosition)
        setPacks((current) => current.filter((row) => String(row.id) !== String(pack.id)))
        onToast?.('已撤销合成，两张卡片已回到原处')
      })
      return true
    } catch (failure) {
      onToast?.(failure?.message || '合成卡包失败')
      return false
    } finally {
      endPackBusy()
    }
  }

  async function renamePackById(pack, title) {
    if (!pack?.id) return false
    if (!beginPackBusy()) return false
    try {
      const result = await renamePack(pack.id, title)
      const updated = result?.pack
      if (!updated?.id) throw new Error('改名失败')
      replacePack(updated)
      onToast?.(`已改名为「${updated.title}」`)
      return true
    } catch (failure) {
      onToast?.(failure?.message || '卡包改名失败')
      return false
    } finally {
      endPackBusy()
    }
  }

  async function reorderPackRows(pack, members) {
    if (!pack?.id || !Array.isArray(members)) return false
    if (!beginPackBusy()) return false
    try {
      const result = await reorderPackMembers(pack.id, members.map((member) => ({
        type: member.type,
        id: member.id
      })))
      const updated = result?.pack
      if (!updated?.id) throw new Error('保存卡包顺序失败')
      replacePack(updated)
      return true
    } catch (failure) {
      onToast?.(failure?.message || '保存卡包顺序失败')
      return false
    } finally {
      endPackBusy()
    }
  }

  function openPackMember(pack, member) {
    if (!member) return
    setOpenPackId('')
    setPackRenameFocus(false)
    if (member.type === 'session') {
      onOpenRecord?.({ id: member.id, title: member.title, kind: member.kind })
      return
    }
    if (member.type === 'batch') {
      setBatchAppend(false)
      setOpenBatchId(member.id)
      return
    }
    if (member.type === 'highlight') {
      onOpenRecord?.({ id: member.session_id, title: member.session_title || member.subtitle, kind: member.kind }, member.ts)
      return
    }
    if (member.type === 'doc') {
      openDoc({ url: member.url })
    }
  }

  async function removePackMember(pack, member) {
    if (!pack?.id || !member) return
    if (!beginPackBusy()) return
    try {
      const packPosition = layoutApiRef.current?.getPosition(packKey(pack.id))
      const result = await removePackMembers(pack.id, [{ type: member.type, id: member.id }])
      const updated = result?.pack
      if (!updated?.id) throw new Error('移出卡包失败')
      replacePack(updated)
      if (packPosition) {
        layoutApiRef.current?.place(packMemberKey(member), {
          x: packPosition.x + 96,
          y: packPosition.y + 60
        })
      }
      onToast?.(`已从「${updated.title}」移出 1 张卡片`)
    } catch (failure) {
      onToast?.(failure?.message || '移出卡包失败')
    } finally {
      endPackBusy()
    }
  }

  async function dissolvePack(pack) {
    if (!pack?.id) return
    if (!beginPackBusy()) return
    try {
      const packPosition = layoutApiRef.current?.getPosition(packKey(pack.id))
      const members = Array.isArray(pack.members) ? pack.members : []
      const spots = fanPositions(packPosition || { x: 0, y: 0 }, members.length)
      const placements = {}
      if (packPosition) {
        members.forEach((member, index) => {
          if (spots[index]) placements[packMemberKey(member)] = spots[index]
        })
      }
      await deletePack(pack.id)
      if (Object.keys(placements).length) layoutApiRef.current?.placeMany(placements)
      layoutApiRef.current?.remove(packKey(pack.id))
      forgetPin(packKey(pack.id))
      setPacks((current) => current.filter((row) => String(row.id) !== String(pack.id)))
      setOpenPackId('')
      setPackRenameFocus(false)
      onToast?.(members.length
        ? `已解散「${pack.title}」，${members.length} 张卡片移出卡包`
        : `已删除「${pack.title}」`)
    } catch (failure) {
      onToast?.(failure?.message || '解散卡包失败')
    } finally {
      endPackBusy()
    }
  }

  function askCardId(type, item) {
    if (!item?.id) return ''
    if (type === 'session' || type === 'doc') return String(item.id)
    if (type === 'pack') return `pack:${item.id}`
    return `${type}:${item.id}`
  }

  async function askAgentAboutCard(type, item) {
    if (askingCardRef.current) return
    const cardId = askCardId(type, item)
    if (!cardId) {
      onToast?.('这张卡片还没有可用的标识')
      return
    }
    askingCardRef.current = true
    try {
      const synced = await syncCards()
      if (synced && synced.ok === false) {
        throw new Error(synced.errors?.[0]?.message || '卡片文件同步失败')
      }
      const result = await listCards('', { id: cardId, limit: 1 })
      const card = result?.cards?.[0]
      if (!card?.path) throw new Error('这张卡片还没有生成可 @ 的文件，请稍后再试')
      await openCardAgentDraft(card, { path: dataDir })
    } catch (failure) {
      onToast?.(failure?.message || '无法在 Agent 中 @ 这张卡片')
    } finally {
      askingCardRef.current = false
    }
  }

  function packMenu(pack, event) {
    const key = packKey(pack.id)
    openMenu(event, [
      { id: 'ask-pack', label: '基于此卡包提问', hint: '在 Agent 中 @它', onSelect: () => askAgentAboutCard('pack', pack) },
      { separator: true },
      { id: 'open-pack', label: '打开卡包', onSelect: () => openPackOverlay(pack) },
      { id: 'rename-pack', label: '重命名', onSelect: () => openPackOverlay(pack, true) },
      pinAction(key),
      { separator: true },
      {
        id: 'dissolve-pack',
        label: Number(pack.count) > 0 ? '解散卡包' : '删除卡包',
        hint: Number(pack.count) > 0 ? '卡片不删除' : '',
        danger: true,
        onSelect: () => dissolvePack(pack)
      }
    ])
  }

  function blankPackMenu(event, point) {
    openMenu(event, [{
      id: 'new-pack',
      label: '新建卡包',
      hint: '把卡片拖进来',
      onSelect: () => createEmptyPack(point)
    }])
  }

  function boardEntryMenu(entry, event) {
    const key = `${entry.type}-${entry.item.id}`
    const actions = [
      { id: 'ask-card', label: '基于此卡片提问', hint: '在 Agent 中 @它', onSelect: () => askAgentAboutCard(entry.type, entry.item) },
      { separator: true },
      pinAction(key)
    ]
    if (entry.type === 'highlight') {
      actions.push({ id: 'open', label: '打开记录', onSelect: () => onOpenRecord({ id: entry.item.session_id, title: entry.item.session_title, kind: entry.item.kind }, entry.item.ts) })
    }
    if (entry.type === 'note') {
      actions.push({ id: 'delete', label: '删除便利签', onSelect: () => removeNote(entry.item) })
    }
    if (entry.type === 'image') {
      actions.push({ id: 'delete', label: '删除图片卡', onSelect: () => removeImage(entry.item) })
    }
    openMenu(event, actions)
  }

  function batchMenu(entry, event) {
    const key = `batch-${entry.item.id}`
    openMenu(event, [
      { id: 'ask-batch', label: '基于此卡片提问', hint: '在 Agent 中 @它', onSelect: () => askAgentAboutCard('batch', entry.item) },
      { separator: true },
      pinAction(key), { separator: true },
      { id: 'open', label: '打开批次', onSelect: () => { setBatchAppend(false); setOpenBatchId(entry.item.id) } },
      { id: 'append-batch', label: '加入新链接', onSelect: () => { setBatchAppend(true); setOpenBatchId(entry.item.id) } },
      { separator: true },
      { id: 'delete-batch', label: '全部删除', danger: true, onSelect: () => askDeleteBatch(entry.item) }
    ])
  }

  async function addNote({ text, x, y, toast }) {
    try {
      const note = await createStickyNote({ text, x, y })
      setNotes((current) => [...current, note])
      onToast?.(typeof toast === 'function' ? toast(note) : (toast || '便利签已贴上'))
      return note
    } catch (failure) {
      onToast?.(failure?.message || '便利签保存失败')
      return null
    }
  }

  // 双击便利签 / 待办：就地在卡片附近打开同一个编辑器，保存后按新文本重新判定待办。
  function openNoteEditor(note, event) {
    const host = homeRef.current
    if (!host || !note) return
    const rect = host.getBoundingClientRect()
    const left = Number(event?.clientX) - rect.left
    const top = Number(event?.clientY) - rect.top
    setNoteEditor({
      note,
      text: String(note.text || ''),
      left: Math.max(8, Math.min(Math.max(8, rect.width - 308), Number.isFinite(left) ? left : rect.width / 2)),
      top: Math.max(8, Math.min(Math.max(8, rect.height - 208), Number.isFinite(top) ? top : rect.height / 2))
    })
  }

  async function editNote(note, text) {
    const previous = notes
    const checked = Array.isArray(note.checked) ? note.checked : []
    setNotes((current) => current.map((row) => (row.id === note.id ? { ...row, text } : row)))
    try {
      const updated = await updateStickyNote(note.id, { text, checked })
      setNotes((current) => current.map((row) => (row.id === note.id ? { ...row, ...updated } : row)))
      onToast?.(updated?.kind === 'todo' ? '待办清单已更新' : '便利签已更新')
    } catch (failure) {
      setNotes(previous)
      onToast?.(failure?.message || '便利签保存失败')
    }
  }

  function saveNoteEditor() {
    const value = noteEditor?.text?.trim()
    const note = noteEditor?.note
    setNoteEditor(null)
    if (!note || !value) return
    editNote(note, value)
  }

  async function toggleNote(note, index) {
    const checked = (note.checked || []).slice()
    checked[index] = !checked[index]
    setNotes((current) => current.map((row) => row.id === note.id ? { ...row, checked } : row))
    try {
      await updateStickyNote(note.id, { checked })
    } catch (failure) {
      setNotes((current) => current.map((row) => row.id === note.id ? note : row))
      onToast?.(failure?.message || '待办状态保存失败')
    }
  }

  // 卡片删除统一走应用内确认弹层：取消 / 确认；不用浏览器原生 confirm（按钮是英文 Cancel/OK）。
  function askDeleteCard({ title, body, run }) {
    setConfirm({ title, body, label: '确认', run })
  }

  function removeNote(note) {
    const label = note?.kind === 'todo' ? '待办清单' : '便利签'
    askDeleteCard({
      title: `删除这张${label}？`,
      body: `${label}会从摘录墙上移除，删除后无法恢复。`,
      run: () => dropNote(note)
    })
  }

  async function dropNote(note) {
    const previous = notes
    setNotes((current) => current.filter((row) => row.id !== note.id))
    try {
      await deleteStickyNote(note.id)
    } catch (failure) {
      setNotes(previous)
      onToast?.(failure?.message || '便利签删除失败')
    }
  }

  async function addImages(files, point = { x: 0, y: 0 }) {
    let index = 0
    for (const file of files) {
      if (!looksLikeImageFile(file)) continue
      try {
        const size = await imageDimensions(file)
        const image = await uploadBoardImage(file, {
          x: Math.max(0, (point.x || 0) + index * 28),
          y: Math.max(0, (point.y || 0) + index * 22),
          width: size.width,
          height: size.height
        })
        setImages((current) => [...current, image])
        index += 1
      } catch (failure) {
        onToast?.(failure?.message || '图片上传失败')
        break
      }
    }
    if (index > 0) onToast?.(index > 1 ? `已添加 ${index} 张图片` : '已添加图片卡')
  }

  function removeImage(image) {
    askDeleteCard({
      title: '删除这张图片卡？',
      body: '图片会从摘录墙上移除，删除后无法恢复。',
      run: () => dropImage(image)
    })
  }

  async function dropImage(image) {
    const previous = images
    setImages((current) => current.filter((row) => row.id !== image.id))
    try {
      await deleteBoardImage(image.id)
    } catch (failure) {
      setImages(previous)
      onToast?.(failure?.message || '图片删除失败')
    }
  }

  async function copyLink(url) {
    try {
      await navigator.clipboard.writeText(url)
      onToast?.('已复制链接')
    } catch (failure) {
      onToast?.(failure?.message || '复制失败')
    }
  }

  const openBatch = React.useMemo(
    () => batches.find((batch) => batch.id === openBatchId) || null,
    [batches, openBatchId]
  )
  const count = kind === 'mark' ? highlights.length : entries.length
  const dockCounts = {
    active: data?.stats?.active ?? items.filter(isActiveTask).length,
    live: data?.stats?.live || 0,
    link_video: data?.stats?.link_video || 0,
    meeting: data?.stats?.meeting || 0,
    doc: (data?.documents || []).length,
    mark: data?.stats?.marks || 0
  }
  if (loading && !data) {
    return (
      <div className="mc-home" ref={homeRef}>
        <div className="mc-home-skeleton mc-home-skeleton-hero" />
        <div className="mc-home-skeleton-grid">
          {[0, 1, 2, 3, 4, 5].map((index) => <div key={index} className="mc-home-skeleton" />)}
        </div>
      </div>
    )
  }

  function askDelete(item) {
    if (!item || isActiveTask(item)) return
    setConfirm({
      title: `删除「${item.title || item.id}」？`,
      body: '媒体、截图、转写与标记会移到废纸篓，清空废纸篓前可找回。',
      label: '移到废纸篓',
      run: async () => {
        const previous = items
        setItems((current) => current.filter((row) => row.id !== item.id))
        try {
          await deleteSession(item.id)
          onToast?.('已移到废纸篓')
          load(false)
        } catch (failure) {
          setItems(previous)
          onToast?.(failure?.message || '删除失败')
        }
      }
    })
  }

  function askDeleteBatch(batch) {
    const ids = (batch?.members || []).map((member) => member.id).filter(Boolean)
    if (!ids.length) {
      onToast?.('这批记录已经删除')
      return
    }
    const active = Number(batch.active) || 0
    setOpenBatchId('')
    setBatchAppend(false)
    setConfirm({
      title: `全部删除「${batch.title || '批量视频'}」？`,
      body: active
        ? `共 ${ids.length} 条，其中 ${active} 条仍在处理中；会先取消，再把整批移到废纸篓。清空废纸篓前可找回。`
        : `共 ${ids.length} 条记录，会整批移到废纸篓；清空废纸篓前可找回。`,
      label: '全部删除',
      run: async () => {
        const previousBatches = batches
        const previousItems = items
        setBatches((current) => current.filter((row) => row.id !== batch.id))
        setItems((current) => current.filter((row) => !ids.includes(row.id)))
        onToast?.(active ? '正在取消并删除…' : '正在移到废纸篓…')
        try {
          const running = (batch.members || []).filter((member) => (
            ['queued', 'waiting_for_slot', 'preparing', 'downloading', 'transcribing', 'finalizing'].includes(member.status)
          ))
          await Promise.allSettled(running.map((member) => cancelLink(member.id)))
          let result = await deleteSessions(ids)
          for (let attempt = 1; attempt < 8 && result?.failed?.length; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500))
            result = await deleteSessions(ids)
          }
          const count = Number(result?.count) || 0
          if (result?.failed?.length) {
            onToast?.(`已删除 ${count} 条，${result.failed.length} 条失败；稍后重试`)
            load(false)
          } else {
            onToast?.(`已删除 ${count || ids.length} 条`)
            load(false)
          }
        } catch (failure) {
          setBatches(previousBatches)
          setItems(previousItems)
          onToast?.(failure?.message || '删除失败')
          load(false)
        }
      }
    })
  }

  async function openDoc(doc) {
    if (!doc?.url) return
    try {
      await openExternal('url', doc.url)
    } catch {
      try {
        window.open(doc.url, '_blank', 'noopener')
      } catch {
        onToast?.('无法打开文档链接')
      }
    }
  }

  function startCardRename(item) {
    if (!item?.id) return
    cardRenameTargetRef.current = String(item.id)
    setRenamingCardId(String(item.id))
    setCardRenameDraft(item.title || '')
  }

  function cancelCardRename() {
    cardRenameTargetRef.current = ''
    setRenamingCardId('')
    setCardRenameDraft('')
  }

  async function commitCardRename(item) {
    if (!item?.id || cardRenameTargetRef.current !== String(item.id)) return
    const next = cardRenameDraft.trim()
    // 先清掉编辑态：回车提交后输入框失焦会再触发一次 onBlur，这里必须幂等。
    cardRenameTargetRef.current = ''
    setRenamingCardId('')
    setCardRenameDraft('')
    if (!next || next === item.title) return
    const previous = item.title || ''
    setItems((current) => current.map((row) => (
      String(row.id) === String(item.id) ? { ...row, title: next } : row
    )))
    try {
      await renameSession(item.id, next)
      onToast?.(`已重命名为「${next}」`)
      // 首页卡片和资料库是同一条记录：同步一份 @ 卡片文件，让 @ 菜单立刻显示新标题。
      syncCards().catch(() => {})
      load(false)
    } catch (failure) {
      setItems((current) => current.map((row) => (
        String(row.id) === String(item.id) ? { ...row, title: previous } : row
      )))
      onToast?.(failure?.message || '重命名失败')
    }
  }

  function cardMenu(item, event) {
    const pinKey = `session-${item.id}`
    openMenu(event, [
      { id: 'ask-card', label: '基于此卡片提问', hint: '在 Agent 中 @它', onSelect: () => askAgentAboutCard('session', item) },
      { separator: true },
      pinAction(pinKey), { separator: true },
      { id: 'open', label: '打开记录', onSelect: () => onOpenRecord(item) },
      { id: 'rename', label: '重命名', onSelect: () => startCardRename(item) },
      ...(item.source_url ? [{ id: 'copy', label: '复制链接', onSelect: () => copyLink(item.source_url) }] : []),
      ...(isActiveTask(item) ? [] : [{ id: 'delete', label: '删除记录', onSelect: () => askDelete(item) }]),
      { separator: true },
      { id: 'reveal', label: '在 Finder 中显示记录目录', onSelect: async () => {
        try { await revealRecord(item.id); onToast?.('已在 Finder 中显示') }
        catch (failure) { onToast?.(failure?.message || '无法显示记录目录') }
      } }
    ])
  }

  const hero = <Hero stats={data?.stats} items={items} t={t} onFilter={setKind} onOpenRecord={onOpenRecord}
    onCaptureCreated={onCaptureCreated}
    onCaptureSubmitted={() => load(false)} library={library} dataDir={dataDir} />
  function docMenu(doc, event) {
    openMenu(event, [
      { id: 'ask-doc', label: '基于此卡片提问', hint: '在 Agent 中 @它', onSelect: () => askAgentAboutCard('doc', doc) },
      { separator: true },
      { id: 'open-doc', label: '打开文档', onSelect: () => openDoc(doc) }
    ])
  }

  // options.packMode：卡包浮层里复用同一张卡，但去掉删除/复制/右键等墙面动作。
  const renderEntry = (entry, options = {}) => {
    const packMode = Boolean(options.packMode)
    const openMember = options.onOpenMember
    if (entry.type === PACK_TYPE) {
      return <PackCard item={entry.item} memberEntries={rawEntryByKey} t={t}
        onOpen={(pack) => openPackOverlay(pack)}
        onMenu={(event) => packMenu(entry.item, event)} />
    }
    if (entry.type === 'batch') {
      return <BatchCard item={entry.item} focused={!packMode && focusedBatchId === entry.item.id}
        onOpen={packMode ? () => openMember?.(entry) : (batch) => { setBatchAppend(false); setOpenBatchId(batch.id) }}
        onMenu={packMode ? undefined : (event) => batchMenu(entry, event)}
        onDelete={packMode ? undefined : askDeleteBatch} />
    }
    if (entry.type === 'note') {
      return <StickyCard note={entry.item} onToggle={toggleNote}
        onDelete={packMode ? undefined : removeNote}
        onEdit={packMode ? undefined : openNoteEditor}
        onMenu={packMode ? undefined : (event) => boardEntryMenu(entry, event)} />
    }
    if (entry.type === 'image') {
      return <ImageCard image={entry.item}
        onDelete={packMode ? undefined : removeImage}
        onMenu={packMode ? undefined : (event) => boardEntryMenu(entry, event)} />
    }
    if (entry.type === 'highlight') {
      return <HighlightCard item={entry.item}
        onOpen={packMode ? () => openMember?.(entry) : onOpenRecord}
        onMenu={packMode ? undefined : (event) => boardEntryMenu(entry, event)} />
    }
    if (entry.type === 'doc') {
      return <DocWallCard doc={entry.item} onOpen={packMode ? () => openMember?.(entry) : openDoc} onMenu={packMode ? undefined : docMenu} t={t} />
    }
    return <SessionCard item={entry.item} t={t}
      onOpen={packMode ? () => openMember?.(entry) : onOpenRecord}
      onCopyLink={packMode ? undefined : copyLink}
      onDelete={packMode ? undefined : askDelete}
      onMenu={packMode ? undefined : cardMenu}
      renaming={!packMode && renamingCardId === String(entry.item.id)}
      renameDraft={cardRenameDraft}
      onRenameChange={setCardRenameDraft}
      onRenameCommit={() => commitCardRename(entry.item)}
      onRenameCancel={cancelCardRename} />
  }

  return (
    <div className={`mc-home ${mode === 'scatter' ? 'is-scatter' : 'is-feed'}`} ref={homeRef}>
      {mode === 'scatter' && allEntries.length > 0 && !error ? (
        <>
          <SetupProgressCards variant="scatter" revision={localRevision} />
          <ScatterCanvas
            entries={allEntries}
            visibleKeys={visibleKeys}
            hero={hero}
            renderEntry={renderEntry}
            onCreateNote={addNote}
            onDropImages={addImages}
            pastePointRef={pastePointRef}
            pins={pins}
            pinningKey={pinFlash}
            focusKey={focusedBatchId ? `batch-${focusedBatchId}` : ''}
            onShowAll={() => setKind('all')}
            onToast={onToast}
            onMergeCards={mergeCards}
            onBlankContextMenu={blankPackMenu}
            layoutApiRef={layoutApiRef}
          />
        </>
      ) : (
        <div className="mc-home-scroll">
          {hero}
          <SetupProgressCards variant="feed" revision={localRevision} />
          {error ? (
            <div className="mc-home-error">
              <span>摘录墙加载失败：{error}</span>
              <button type="button" className="mc-home-ghost" onClick={() => load(true)}>重试</button>
            </div>
          ) : null}
          {!error && entries.length === 0 ? (data?.stats?.total ? (
          <div className="mc-home-empty mc-home-empty-filter">
            <h2>没有符合条件的摘录</h2>
            <p>换一个筛选，或者回到全部。</p>
            <button type="button" className="mc-home-ghost" onClick={() => setKind('all')}>查看全部</button>
          </div>
        ) : <Empty t={t} onNewCapture={onNewCapture} />) : null}
          {entries.length > 0 ? (
            <div className="mc-home-wall">
              {entries.map((entry) => {
                const pinned = Boolean(pins[`${entry.type}-${entry.item.id}`])
                const active = (entry.type === 'session' && isActiveTask(entry.item))
                  || (entry.type === 'batch' && Number(entry.item.active) > 0)
                  || (entry.type === PACK_TYPE && Number(entry.item.active_count) > 0)
                return (
                  <div className={`mc-home-cell${pinned ? ' is-pinned' : ''}${pinned && pinFlash === `${entry.type}-${entry.item.id}` ? ' is-pinning' : ''}${active ? ' is-active' : ''}`}
                    data-active={active ? 'true' : undefined}
                    data-batch-id={entry.type === 'batch' ? entry.item.id : undefined}
                    data-pack-id={entry.type === PACK_TYPE ? entry.item.id : undefined}
                    key={`${entry.type}-${entry.item.id}`}>
                    {pinned ? <PinMark /> : null}
                    {renderEntry(entry)}
                  </div>
                )
              })}
            </div>
          ) : null}
          {items.length >= 60 ? <div ref={sentinel} className="mc-home-more">{more ? '正在加载…' : '继续下滑'}</div> : null}
        </div>
      )}
      <div className="mc-home-dock" role="toolbar" aria-label="摘录墙视图">
        <div className="mc-home-seg" role="tablist" aria-label="展示方式">
          <button type="button" role="tab" aria-selected={mode === 'feed'} data-active={mode === 'feed'} onClick={() => setMode('feed')}>信息流</button>
          <button type="button" role="tab" aria-selected={mode === 'scatter'} data-active={mode === 'scatter'} onClick={() => setMode('scatter')}>散落</button>
        </div>
        <span className="mc-home-dock-sep" />
        <div className="mc-home-chips" role="tablist" aria-label="筛选">
          {FILTERS.map((filter) => (
            <button key={filter.id} type="button" role="tab" aria-selected={kind === filter.id} data-active={kind === filter.id}
              onClick={() => setKind(filter.id)}>
              {filter.label}{filter.id !== 'all' ? <b className="mc-home-chip-count">{dockCounts[filter.id] ?? 0}</b> : null}
            </button>
          ))}
        </div>
        <select className="mc-home-sort" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="排序">
          <option value="recent">最近</option>
          <option value="longest">最长</option>
          <option value="marks">标记最多</option>
        </select>
        <span className="mc-home-dock-count">{count} 条</span>
        <button type="button" className="mc-home-add" aria-label="新建采集" title="新建采集" onClick={() => onNewCapture({})}>＋</button>
      </div>
      {packUndo ? (
        <div className="mc-pack-undo" role="status">
          <span>{packUndo.label}</span>
          <button type="button" onClick={runPackUndo}>撤销</button>
        </div>
      ) : null}
      {noteEditor ? (
        <NoteEditor
          key={noteEditor.note?.id || 'note'}
          left={noteEditor.left}
          top={noteEditor.top}
          text={noteEditor.text}
          title={noteEditor.note?.kind === 'todo' ? '编辑待办清单' : '编辑便利签'}
          hint="保存后自动识别 “- ” 开头的待办条目"
          onChange={(text) => setNoteEditor((current) => (current ? { ...current, text } : current))}
          onCancel={() => setNoteEditor(null)}
          onSave={saveNoteEditor}
        />
      ) : null}
      <ContextMenu menu={menu} onClose={closeMenu} />

      {openPack ? (
        <PackOverlay pack={openPack} t={t}
          busy={packBusy}
          renameFocus={packRenameFocus}
          memberEntries={rawEntryByKey}
          renderEntry={renderEntry}
          onClose={() => { setOpenPackId(''); setPackRenameFocus(false) }}
          onOpenMember={openPackMember}
          onRemoveMember={removePackMember}
          onDissolve={dissolvePack}
          onRename={(title) => renamePackById(openPack, title)}
          onReorder={(members) => reorderPackRows(openPack, members)} />
      ) : null}

      {openBatch ? (
        <BatchOverlay batch={openBatch} t={t}
          initialAppending={batchAppend}
          onClose={() => { setOpenBatchId(''); setBatchAppend(false) }}
          onRefresh={() => load(false)}
          onDeleteAll={askDeleteBatch}
          onOpenRecord={(member) => { setOpenBatchId(''); setBatchAppend(false); onOpenRecord(member) }} />
      ) : null}

      {confirm ? (
        <div className="mc-modal-layer" role="dialog" aria-modal="true">
          <div className="mc-modal mc-confirm">
            <div className="mc-modal-head"><h3>{confirm.title}</h3></div>
            <p className="mc-card-text">{confirm.body}</p>
            <div className="mc-modal-actions">
              <button type="button" className="mc-button" onClick={() => setConfirm(null)}>取消</button>
              <button type="button" className="mc-button" data-variant="primary" onClick={() => {
                const run = confirm.run
                setConfirm(null)
                run?.()
              }}>{confirm.label}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
