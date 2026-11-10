import { addFeishuDocCard, feishuStatus, previewFeishuDoc } from '../../lib/api.js'
import { feishuSummary } from '../../lib/feishu.js'

const DOC_PATH = /^\/(docx|wiki|sheets|base|docs)\/[A-Za-z0-9_-]+/
const DOC_HOST = /(^|\.)(feishu\.cn|larksuite\.com)$/i
const DOC_LABELS = {
  docx: '飞书文档',
  wiki: '飞书知识库',
  sheet: '飞书表格',
  base: '飞书多维表格',
  docs: '飞书文档'
}

/** 浏览器侧只做形态检查；真正的域名/尺寸/权限校验在 Host 与后端。 */
export function looksLikeFeishuDoc(value) {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'https:'
      && DOC_HOST.test(url.hostname)
      && DOC_PATH.test(url.pathname || '')
  } catch {
    return false
  }
}

/**
 * 「＋ → 飞书文档」表单：粘贴链接后先预读标题（可改），确认后由 Host
 * 用飞书 MCP 读正文并写会摘卡片；读不到正文时仍允许只登记链接。
 */
export function DocCardForm({ t, onClose, onCreated }) {
  const [url, setUrl] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [hint, setHint] = React.useState('')
  const [status, setStatus] = React.useState(null)
  const [preview, setPreview] = React.useState(null)
  const [previewing, setPreviewing] = React.useState(false)
  const [previewError, setPreviewError] = React.useState('')
  const [previewHint, setPreviewHint] = React.useState('')
  const [previewNonce, setPreviewNonce] = React.useState(0)
  const mounted = React.useRef(true)
  const sequence = React.useRef(0)
  const titleTouched = React.useRef(false)

  React.useEffect(() => {
    mounted.current = true
    feishuStatus()
      .then((value) => { if (mounted.current) setStatus(value) })
      .catch(() => {})
    return () => { mounted.current = false }
  }, [])

  // 粘贴/修改链接后自动预读标题；650ms 防抖，旧请求用 sequence 丢弃。
  React.useEffect(() => {
    const current = ++sequence.current
    const value = url.trim()
    if (!value || !looksLikeFeishuDoc(value)) {
      setPreview(null)
      setPreviewing(false)
      setPreviewError('')
      setPreviewHint('')
      return undefined
    }
    const controller = new AbortController()
    setPreviewing(true)
    setPreviewError('')
    setPreviewHint('')
    const timer = setTimeout(async () => {
      try {
        const result = await previewFeishuDoc({ url: value, signal: controller.signal })
        if (!mounted.current || current !== sequence.current) return
        setPreview(result)
        if (!titleTouched.current && result?.title) setTitle(result.title)
      } catch (failure) {
        if (failure?.name === 'AbortError' || !mounted.current || current !== sequence.current) return
        setPreview(null)
        setPreviewError(failure?.message || t('home.doc.previewFailed'))
        setPreviewHint(failure?.data?.hint || '')
      } finally {
        if (mounted.current && current === sequence.current) setPreviewing(false)
      }
    }, 650)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [url, previewNonce])

  const summary = feishuSummary(status)
  const ready = summary.tone === 'ok'
  const pending = busy === 'read' || busy === 'link'
  const label = preview ? DOC_LABELS[preview.doc_type] || t('home.docs.title') : ''

  function changeUrl(value) {
    setUrl(value)
    if (!titleTouched.current) setTitle('')
    setPreview(null)
    setPreviewError('')
    if (error) setError('')
  }

  function retryPreview() {
    setPreviewError('')
    setPreviewNonce((value) => value + 1)
  }

  async function submit(linkOnly) {
    if (pending) return
    const value = url.trim()
    if (!value) {
      setError(t('home.doc.urlRequired'))
      return
    }
    if (!looksLikeFeishuDoc(value)) {
      setError(t('home.doc.invalid'))
      setHint('')
      return
    }
    setBusy(linkOnly ? 'link' : 'read')
    setError('')
    setHint('')
    try {
      const result = await addFeishuDocCard({ url: value, title: title.trim(), linkOnly })
      if (!mounted.current) return
      onCreated?.({ kind: 'doc', ...result })
      onClose?.()
    } catch (failure) {
      if (!mounted.current) return
      setError(failure?.message || t('home.doc.failed'))
      setHint(failure?.data?.hint || '')
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  return (
    <div className="mc-new-form">
      <p className="mc-card-text">{t('home.doc.hint')}</p>
      <label className="mc-form-row">
        <span>{t('home.doc.url')}</span>
        <input className="mc-input" value={url} onChange={(event) => changeUrl(event.target.value)}
          placeholder="https://example.feishu.cn/docx/…" spellCheck={false} autoFocus />
      </label>

      {previewing ? <div className="mc-inline-note" role="status">{t('home.doc.previewing')}</div> : null}
      {preview ? (
        <div className="mc-preview-card mc-doc-preview">
          <div className="mc-preview-main">
            <strong>{preview.title || t('home.doc.noTitle')}</strong>
            <span>
              {label} · {preview.has_content
                ? `${preview.content_chars}${t('home.doc.chars')}`
                : t('home.doc.linkOnly')}
            </span>
            {preview.excerpt ? <span className="mc-doc-preview-excerpt">{preview.excerpt}</span> : null}
            {preview.warning ? <span className="mc-doc-preview-warning">{preview.warning}</span> : null}
          </div>
          <button type="button" className="mc-button mc-button-small" disabled={previewing} onClick={retryPreview}>
            {t('home.doc.rePreview')}
          </button>
        </div>
      ) : null}
      {previewError ? (
        <div className="mc-error-row">
          <span className="mc-error-text" role="alert">{previewError}{previewHint ? `：${previewHint}` : ''}</span>
          <button type="button" className="mc-button mc-button-small" onClick={retryPreview}>{t('home.doc.rePreview')}</button>
        </div>
      ) : null}

      <label className="mc-form-row">
        <span>{t('home.doc.titleLabel')}</span>
        <input className="mc-input" value={title}
          onChange={(event) => {
            const next = event.target.value
            setTitle(next)
            titleTouched.current = Boolean(next.trim())
          }}
          placeholder={preview ? t('home.doc.titleAutoPlaceholder') : t('home.doc.titlePlaceholder')} spellCheck={false} />
      </label>

      {status && !ready ? (
        <div className="mc-notice" data-tone="warn">
          {t('home.doc.notReady')}（{summary.text}）
        </div>
      ) : null}

      {pending ? <div className="mc-inline-note" role="status">{busy === 'link' ? t('home.doc.linking') : t('home.doc.reading')}</div> : null}
      {error ? <div className="mc-error-text" role="alert">{error}{hint ? `：${hint}` : ''}</div> : null}

      <div className="mc-modal-actions">
        <button type="button" className="mc-button" disabled={pending} onClick={onClose}>{t('new.cancel')}</button>
        <button type="button" className="mc-button" disabled={pending || !url.trim()} onClick={() => submit(true)}>
          {t('home.doc.linkOnly')}
        </button>
        <button type="button" className="mc-button" data-variant="primary" data-new-submit="true"
          disabled={pending || previewing || !url.trim()} onClick={() => submit(false)}>
          {busy === 'read' ? t('home.doc.reading') : (preview ? t('home.doc.create') : t('home.doc.read'))}
        </button>
      </div>
    </div>
  )
}
