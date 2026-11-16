import { Settings } from './Settings.jsx'

/** 面板内设置弹层：打开时底层首页/采集表单不卸载，关闭后输入还在。 */
export function SettingsDialog({ t, request, onClose, onRestartSetup }) {
  React.useEffect(() => {
    function onKey(event) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="mc-modal-layer mc-settings-layer" role="dialog" aria-modal="true" aria-label="会摘设置"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="mc-modal mc-settings-dialog">
        <div className="mc-settings-dialog-head">
          <span className="mc-settings-dialog-title">会摘设置</span>
          <button type="button" className="mc-icon-button" aria-label="关闭设置" onClick={onClose}>×</button>
        </div>
        <div className="mc-settings-dialog-body">
          <Settings t={t} initialTab={request?.tab || ''} focusAnchor={request?.anchor || ''}
            focusNonce={request?.nonce || 0} onRestartSetup={onRestartSetup} />
        </div>
      </div>
    </div>
  )
}
