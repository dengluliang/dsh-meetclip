import { previewFeishuDoc } from '../../lib/api.js'

/**
 * 真正读一篇文档才算飞书可用。设置页、账号页和首次引导共用。
 */
export function FeishuDocProbe({ compact = false, onLogin, onSuccess }) {
  const [url, setUrl] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [error, setError] = React.useState(null)

  async function run() {
    const value = url.trim()
    if (!value) { setError({ message: '先粘贴一篇飞书文档链接' }); return }
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const next = await previewFeishuDoc({ url: value })
      setResult(next)
      onSuccess?.(next)
    } catch (failure) {
      setError({
        code: failure?.data?.code || '',
        message: failure?.message || '读取失败',
        hint: failure?.data?.hint || ''
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`mc-doc-probe${compact ? ' is-compact' : ''}`}>
      <div className="mc-doc-probe-title">验证读取</div>
      <p className="mc-form-note">登录只代表账号有效；读一篇文档才能确认 Agent 和飞书卡片真的能用。</p>
      <div className="mc-doc-probe-row">
        <input className="mc-input" value={url} spellCheck={false}
          placeholder="粘贴一篇飞书文档链接，例如 https://xxx.feishu.cn/docx/…"
          onChange={(event) => { setUrl(event.target.value); setError(null) }} />
        <button type="button" className="mc-button" disabled={busy} onClick={run}>
          {busy ? '读取中…' : '测试读取'}
        </button>
      </div>
      {result ? (
        <p className="mc-form-note" data-tone="ok" role="status">
          读取成功：{result.title || '（无标题）'}{result.has_content ? ` · ${result.content_chars} 字正文` : ' · 仅链接'}
        </p>
      ) : null}
      {error ? (
        <div className="mc-doc-probe-error">
          <p className="mc-error-text" role="alert">{error.message}{error.hint ? `：${error.hint}` : ''}</p>
          <div className="mc-actions">
            {onLogin ? <button type="button" className="mc-button mc-button-small" onClick={onLogin}>去登录飞书</button> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
