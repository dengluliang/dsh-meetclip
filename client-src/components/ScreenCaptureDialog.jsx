import { fallbackStart, fallbackStop } from '../lib/api.js'

const MIME_TYPES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
]

export function ScreenCaptureDialog({ t, sessionId, onClose, onDone }) {
  const [phase, setPhase] = React.useState('starting')
  const [error, setError] = React.useState('')
  const [progress, setProgress] = React.useState(0)
  const [seconds, setSeconds] = React.useState(0)
  const infoRef = React.useRef(null)
  const recorderRef = React.useRef(null)
  const streamRef = React.useRef(null)
  const chunksRef = React.useRef([])
  const cancelledRef = React.useRef(false)
  const timerRef = React.useRef(null)

  React.useEffect(() => {
    start()
    return () => {
      cancelledRef.current = true
      if (timerRef.current) clearInterval(timerRef.current)
      try { if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop() } catch {}
      stopTracks()
      if (infoRef.current) fallbackStop(sessionId).catch(() => {})
    }
  }, [])

  function stopTracks() {
    for (const track of streamRef.current?.getTracks() || []) {
      try { track.stop() } catch {}
    }
    streamRef.current = null
  }

  async function start() {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('当前浏览器不支持屏幕内录，请改用下载或登录后重试。')
      }
      const info = await fallbackStart(sessionId)
      infoRef.current = info
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
        preferCurrentTab: false
      })
      streamRef.current = stream
      const mimeType = MIME_TYPES.find((type) => {
        try { return MediaRecorder.isTypeSupported(type) } catch { return false }
      })
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      recorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (event) => { if (event.data?.size) chunksRef.current.push(event.data) }
      recorder.onstop = () => finish(recorder.mimeType || 'video/webm')
      stream.getVideoTracks()?.[0]?.addEventListener('ended', () => {
        if (recorder.state !== 'inactive') recorder.stop()
      })
      recorder.start(1000)
      setPhase('recording')
      timerRef.current = setInterval(() => setSeconds((value) => value + 1), 1000)
    } catch (failure) {
      setError(failure?.message || String(failure))
      setPhase('error')
      stopTracks()
      try { await fallbackStop(sessionId) } catch {}
    }
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current)
    try { recorderRef.current?.stop() } catch {}
    stopTracks()
  }

  function finish(mimeType) {
    stopTracks()
    if (cancelledRef.current) return
    const info = infoRef.current
    if (!info?.path || !info?.token) {
      setError('内录任务信息缺失')
      setPhase('error')
      return
    }
    const blob = new Blob(chunksRef.current, { type: mimeType })
    if (blob.size < 1024) {
      setError('没有捕获到有效的画面，请重试并选择正在播放的窗口。')
      setPhase('error')
      return
    }
    setPhase('uploading')
    const query = new URLSearchParams({
      session_id: sessionId,
      token: info.token,
      target: info.path
    })
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/meetclip/app/fallback/upload?${query.toString()}`)
    xhr.withCredentials = true
    xhr.setRequestHeader('content-type', mimeType || 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      let data = null
      try { data = JSON.parse(xhr.responseText || '{}') } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
        setPhase('done')
        onDone?.()
      } else {
        setError(data?.detail || `上传失败（HTTP ${xhr.status}）`)
        setPhase('error')
      }
    }
    xhr.onerror = () => { setError('上传失败'); setPhase('error') }
    xhr.send(blob)
  }

  async function cancel() {
    cancelledRef.current = true
    if (timerRef.current) clearInterval(timerRef.current)
    try { if (recorderRef.current?.state !== 'inactive') recorderRef.current.stop() } catch {}
    stopTracks()
    try { await fallbackStop(sessionId) } catch {}
    onClose()
  }

  return (
    <div className="mc-modal-layer" role="dialog" aria-modal="true">
      <div className="mc-modal mc-capture-dialog">
        <div className="mc-modal-head">
          <h3>内录视频</h3>
          <button type="button" className="mc-icon-button" onClick={cancel} aria-label="关闭">×</button>
        </div>
        <p className="mc-card-text">在系统选择器中选择正在播放视频的浏览器窗口；内录结束后会自动转写。</p>
        {phase === 'starting' ? <div className="mc-inline-note">正在等待屏幕录制授权…</div> : null}
        {phase === 'recording' ? (
          <div className="mc-recording">
            <span className="mc-dot" data-state="error" />
            <strong>正在内录 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</strong>
          </div>
        ) : null}
        {phase === 'uploading' ? (
          <div className="mc-inline-note">正在保存内录 {Math.round(progress * 100)}%…</div>
        ) : null}
        {phase === 'done' ? <div className="mc-ok-text">内录已保存，正在转写。</div> : null}
        {error ? <p className="mc-error-text" role="alert">{error}</p> : null}
        <div className="mc-modal-actions">
          {phase === 'recording' ? <button type="button" className="mc-button" data-variant="stop" onClick={stopRecording}>停止并保存</button> : null}
          {phase === 'done' ? <button type="button" className="mc-button" data-variant="primary" onClick={onClose}>完成</button> : null}
          <button type="button" className="mc-button" onClick={cancel}>取消内录</button>
        </div>
      </div>
    </div>
  )
}
