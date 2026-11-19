import { addLinkCard, previewLinkCard } from '../../lib/api.js'
import { feishuSummary, useFeishu } from '../../lib/feishu.js'
import { FeishuJobPanel } from '../feishu/FeishuParts.jsx'

const DOC_PATH = /^\/(docx|wiki|sheets|base|docs)\/[A-Za-z0-9_-]+/
const DOC_HOST = /(^|\.)(feishu\.cn|larksuite\.com)$/i
const DOC_LABELS = {
  docx: '飞书文档',
  wiki: '飞书知识库',
  sheet: '飞书表格',
  base: '飞书多维表格',
  docs: '飞书文档',
  wechat: '公众号文章',
  web: '网页'
}
const KIND_LABELS = {
  'feishu-doc': '飞书',
  wechat: '公众号',
  web: '网页',
  video: '视频'
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

export function looksLikeLink(value) {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** 允许直接粘贴「分享文案 + 链接」，取其中的第一个 http(s) 链接。 */
export function firstLink(value) {
  const text = String(value || '').trim()
  if (looksLikeLink(text)) return text
  const match = text.match(/https?:\/\/[^\s"'<>]+/)
  if (!match) return ''
  // 分享文案里的链接常带中文标点/右括号，去掉尾部的包裹字符再交给 Host。
  return match[0].replace(/[)"'“”‘’>\],.;:!?，。；：！？、]+$/, '')
}

function failureText(failure, t) {
  // 405 只会在「页面已是新前端、Host 还是旧版」时出现：新路由没注册。
  if (failure?.status === 405) return '宿主还没重新加载：退出并重新打开 DeepSeek Harness 后再试'
  return failure?.message || t('home.doc.failed')
}

function previewMeta(preview, t) {
  if (!preview) return ''
  const typeLabel = preview.kind === 'feishu-doc'
    ? DOC_LABELS[preview.doc_type] || t('home.docs.title')
    : KIND_LABELS[preview.kind] || t('home.docs.title')
  const bits = [typeLabel]
  if (preview.kind !== 'feishu-doc' && preview.site && preview.site !== typeLabel) bits.push(preview.site)
  if (preview.author) bits.push(preview.author)
  if (preview.published_at) bits.push(preview.published_at)
  bits.push(preview.has_content
    ? `${preview.content_chars}${t('home.doc.chars')}`
    : t('home.doc.linkOnly'))
  return bits.join(' · ')
}

/**
 * 「＋ → 链接卡片」表单：粘贴任意链接（公众号文章、普通网页、飞书文档），
 * 先预读标题/站点/摘要，确认后由 Host 读正文并写会摘卡片；读不到正文时仍可仅登记链接。
 */
export function LinkCardForm({ t, onClose, onCreated }) {
  const [url, setUrl] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [hint, setHint] = React.useState('')
  const [preview, setPreview] = React.useState(null)
  const [previewing, setPreviewing] = React.useState(false)
  const [previewError, setPreviewError] = React.useState('')
  const [previewHint, setPreviewHint] = React.useState('')
  const [previewNonce, setPreviewNonce] = React.useState(0)
  const mounted = React.useRef(true)
  const sequence = React.useRef(0)
  const titleTouched = React.useRef(false)
  const retriedAfterLogin = React.useRef(false)
  const feishuUrl = looksLikeFeishuDoc(firstLink(url))
  const feishu = useFeishu({ enabled: feishuUrl })

  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const summary = feishuSummary(feishu.status)
  const installed = Boolean(feishu.status?.dsh?.entryPresent)
  const loggedIn = Boolean(feishu.status?.auth?.loggedIn)
  const accessExpired = Boolean(feishu.status?.auth?.accessExpired)
  const canRead = installed && loggedIn && !accessExpired
  const jobRunning = feishuUrl && feishu.status?.job?.state === 'running'
  const pending = busy === 'read' || busy === 'link' || Boolean(jobRunning)

  // 粘贴/修改链接后自动预读；650ms 防抖，旧请求用 sequence 丢弃。
  React.useEffect(() => {
    const current = ++sequence.current
    const value = firstLink(url)
    if (!value) {
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
        const result = await previewLinkCard({ url: value, signal: controller.signal })
        if (!mounted.current || current !== sequence.current) return
        setPreview(result)
        if (!titleTouched.current && result?.title) setTitle(result.title)
        if (feishuUrl) feishu.load()
      } catch (failure) {
        if (failure?.name === 'AbortError' || !mounted.current || current !== sequence.current) return
        setPreview(null)
        setPreviewError(failure?.status === 405 ? failureText(failure, t) : (failure?.message || t('home.doc.previewFailed')))
        setPreviewHint(failure?.hint || failure?.data?.hint || '')
      } finally {
        if (mounted.current && current === sequence.current) setPreviewing(false)
      }
    }, 650)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [url, previewNonce])

  // 登录成功后自动重试一次，避免用户手动再点；只重试一次。
  React.useEffect(() => {
    if (!feishuUrl || !canRead || !previewError || retriedAfterLogin.current) return
    retriedAfterLogin.current = true
    setPreviewNonce((value) => value + 1)
  }, [feishuUrl, canRead, previewError])

  function changeUrl(value) {
    retriedAfterLogin.current = false
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
    const value = firstLink(url)
    if (!value) {
      setError(url.trim() ? t('home.doc.invalid') : t('home.doc.urlRequired'))
      return
    }
    if (!looksLikeLink(value)) {
      setError(t('home.doc.invalid'))
      setHint('')
      return
    }
    setBusy(linkOnly ? 'link' : 'read')
    setError('')
    setHint('')
    try {
      const result = await addLinkCard({ url: value, title: title.trim(), linkOnly })
      if (!mounted.current) return
      onCreated?.({ kind: 'doc', ...result })
      onClose?.()
    } catch (failure) {
      if (!mounted.current) return
      setError(failureText(failure, t))
      setHint(failure?.hint || failure?.data?.hint || '')
    } finally {
      if (mounted.current) setBusy('')
    }
  }

  const linkOnlyPreview = Boolean(preview?.link_only)
  const primaryLabel = busy === 'read' ? t('home.doc.reading')
    : preview ? (linkOnlyPreview ? t('home.doc.createLinkOnly') : t('home.doc.create'))
      : t('home.doc.read')

  return (
    <div className="mc-new-form">
      <p className="mc-card-text">{t('home.doc.hint')}</p>
      <label className="mc-form-row">
        <span>{t('home.doc.url')}</span>
        <input className="mc-input" value={url} onChange={(event) => changeUrl(event.target.value)}
          onPaste={(event) => {
            // 分享文案里通常夹着链接；粘贴时只留链接，避免整段文案塞进输入框。
            const text = event.clipboardData?.getData?.('text') || ''
            const link = firstLink(text)
            if (link && link !== text.trim()) {
              event.preventDefault()
              changeUrl(link)
            }
          }}
          placeholder="https://mp.weixin.qq.com/s/… · https://example.com/article" spellCheck={false} autoFocus />
      </label>

      {previewing ? <div className="mc-inline-note" role="status">{t('home.doc.previewing')}</div> : null}
      {preview ? (
        <div className="mc-preview-card mc-doc-preview">
          <div className="mc-preview-main">
            <strong>{preview.title || t('home.doc.noTitle')}</strong>
            <span>{previewMeta(preview, t)}</span>
            {preview.excerpt ? <span className="mc-doc-preview-excerpt">{preview.excerpt}</span> : null}
            {preview.warning ? <span className="mc-doc-preview-warning">{preview.warning}</span> : null}
          </div>
          <button type="button" className="mc-button mc-button-small" disabled={previewing} onClick={retryPreview}>
            {t('home.doc.rePreview')}
          </button>
        </div>
      ) : null}
      {preview?.kind === 'video' ? (
        <div className="mc-notice" data-tone="info">{t('home.doc.videoHint')}</div>
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

      {feishuUrl && !canRead ? (
        <div className="mc-feishu-issue" data-tone={summary.tone}>
          <div>
            <strong>{summary.text}</strong>
            <span>{summary.detail || t('home.doc.feishuDetail')}</span>
          </div>
          <div className="mc-actions">
            {!installed ? (
              <button type="button" className="mc-button mc-button-small" disabled={pending}
                onClick={() => feishu.actions.install()}>安装并连接飞书</button>
            ) : null}
            {installed && (!loggedIn || accessExpired) ? (
              <>
                <button type="button" className="mc-button mc-button-small" data-variant="primary"
                  disabled={pending} onClick={() => feishu.actions.login('auto')}>
                  {feishu.busy === 'login' ? '等待授权…' : accessExpired ? '刷新飞书登录' : '登录飞书'}
                </button>
                <button type="button" className="mc-button mc-button-small" disabled={pending}
                  onClick={() => feishu.actions.login('device')}>设备码登录</button>
              </>
            ) : null}
            {installed ? (
              <button type="button" className="mc-button mc-button-small" disabled={pending}
                onClick={feishu.actions.probe}>检测连接</button>
            ) : null}
          </div>
        </div>
      ) : feishuUrl ? (
        <p className="mc-foot-meta">{t('home.doc.feishuReady')}</p>
      ) : null}

      {feishuUrl ? <FeishuJobPanel job={feishu.status?.job} actions={feishu.actions} /> : null}

      {pending ? <div className="mc-inline-note" role="status">{busy === 'link' ? t('home.doc.linking') : t('home.doc.reading')}</div> : null}
      {error ? <div className="mc-error-text" role="alert">{error}{hint ? `：${hint}` : ''}</div> : null}

      <div className="mc-modal-actions">
        <button type="button" className="mc-button" disabled={pending} onClick={onClose}>{t('new.cancel')}</button>
        {!linkOnlyPreview ? (
          <button type="button" className="mc-button" disabled={pending || !url.trim()} onClick={() => submit(true)}>
            {t('home.doc.linkOnly')}
          </button>
        ) : null}
        <button type="button" className="mc-button" data-variant="primary" data-new-submit="true"
          disabled={pending || previewing || !url.trim()} onClick={() => submit(linkOnlyPreview)}>
          {primaryLabel}
        </button>
      </div>
    </div>
  )
}

// 兼容旧引用（0.9.22 及以前的「飞书文档」表单名）。
export const DocCardForm = LinkCardForm
