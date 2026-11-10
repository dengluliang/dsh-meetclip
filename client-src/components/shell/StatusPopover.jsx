export function StatusPopover({ t, data, health, error, onRefresh, onClose }) {
  const backend = data?.backend || {}
  const env = data?.env || {}
  const locations = data?.locations || {}
  const ready = backend.state === 'running'
  const deps = health?.deps
  const asr = health?.asr
  const asrLabel = !asr ? '检测中' : asr.state === 'downloading' ? `下载中 ${Math.round((asr.downloaded / Math.max(1, asr.total)) * 100)}%` : asr.state === 'ready' || asr.state === 'installed' ? '就绪' : '未启用'
  return (
    <div className="mc-status-pop" role="dialog" aria-label="运行状态">
      <div className="mc-status-head">
        <strong>运行状态</strong>
        <button type="button" className="mc-icon-button" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="mc-status-rows">
        <div><span>本地引擎</span><b data-state={error ? 'error' : ready ? 'ok' : 'warn'}>{error ? '连接失败' : ready ? '运行中' : '未启动'}</b></div>
        <div><span>端口</span><b>{backend.port || locations.port || '-'}</b></div>
        <div><span>运行环境</span><b>{env.ready ? '就绪' : '未就绪'}</b></div>
        <div><span>采集组件</span><b>{!deps ? '检测中' : deps.yt_dlp && deps.ffmpeg ? '就绪' : '缺失'}</b></div>
        <div><span>语音识别</span><b>{asrLabel}</b></div>
        <div><span>数据目录</span><b>{locations.dataDirWritable === false ? '不可写' : locations.dataDir || '-'}</b></div>
      </div>
      {error ? <p className="mc-status-error">{error}</p> : null}
      <div className="mc-status-actions">
        <button type="button" className="mc-button mc-button-small" onClick={onRefresh}>刷新</button>
        <span className="mc-status-hint">引擎设置、依赖和模型在 设置 → 会摘。</span>
      </div>
    </div>
  )
}
