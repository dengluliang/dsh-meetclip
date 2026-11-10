import {
  backendAction, deps, depsInstallStatus, ensureWorkspace, homeFeed, inspectDataDir, installDeps,
  meetingOptions, modelCatalog, pickFile, probeModels, saveAIConfig, saveAsrEngine, savePrefs,
  setupStatus, startSetup, status as hostStatus, testAIModel, testAsrEngine
} from '../lib/api.js'
import { useFeishu } from '../lib/feishu.js'
import { FeishuJobPanel, FeishuLoginActions, FeishuStatusRows } from './feishu/FeishuParts.jsx'
import { candidateOrder, modelOptions, splitModels, vendorOf } from '../lib/models.js'

// 不预置网关地址与模型：首次配置时由用户填写自己的 OpenAI 兼容服务。
const BASE_PLACEHOLDER = 'https://your-gateway.example/v1'
// 每个模型类别最多试几个：同一个 Key 的权限通常按供应商划分，试到能通的就停。
const MAX_CANDIDATES = 6

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function SetupWizard({ status, onComplete }) {
  const [step, setStep] = React.useState(1)
  const [baseUrl, setBaseUrl] = React.useState(() => String(status?.ai?.baseUrl || '').trim())
  const [apiKey, setApiKey] = React.useState('')
  const [showKey, setShowKey] = React.useState(false)
  const [probing, setProbing] = React.useState(false)
  const [catalog, setCatalog] = React.useState(null)
  const [catalogError, setCatalogError] = React.useState('')
  const [asrModel, setAsrModel] = React.useState('')
  const [textModel, setTextModel] = React.useState('')
  const [running, setRunning] = React.useState(false)
  const [detail, setDetail] = React.useState('')
  const [log, setLog] = React.useState('')
  const [error, setError] = React.useState('')
  const [issues, setIssues] = React.useState([])
  const [skippedKey, setSkippedKey] = React.useState(false)
  const [background, setBackground] = React.useState(false)
  const [envReady, setEnvReady] = React.useState(false)
  const [dataDir, setDataDir] = React.useState(() => (
    status?.locations?.suggestedDataDir || status?.locations?.dataDir || ''
  ))
  const [pickingDir, setPickingDir] = React.useState(false)
  const [workspaceInfo, setWorkspaceInfo] = React.useState(null)
  const [workspaceError, setWorkspaceError] = React.useState('')
  const feishu = useFeishu({ enabled: step >= 2 })
  const mounted = React.useRef(true)
  const probeSeq = React.useRef(0)
  const probedKey = React.useRef('')
  const inflight = React.useRef(new Set())
  React.useEffect(() => () => { mounted.current = false }, [])

  // 输入停顿后再自动拉取；同一个 Key 只拉一次。
  // 之前是每次失焦都重拉，重拉期间把两张下拉整块卸载，点开列表时会消失再出现（闪一下）。
  React.useEffect(() => {
    const key = apiKey.trim()
    probeSeq.current += 1
    if (key.length < 16 || !baseUrl.trim()) {
      probedKey.current = ''
      setCatalog(null)
      setCatalogError('')
      return undefined
    }
    if (key === probedKey.current) return undefined
    setCatalog(null)
    setCatalogError('')
    const timer = setTimeout(() => { discover() }, 700)
    return () => clearTimeout(timer)
  }, [apiKey])

  // 目录到手后把两个下拉落到具体模型：此前是「界面显示第一项、状态仍为空」，
  // 保存时写进一个空模型名，用户以为选过了，实际没选中。
  // 文字模型优先取与语音同一个供应商的（同一个 Key 的权限通常按供应商划分）。
  React.useEffect(() => {
    if (!catalog) return
    const asrDefault = catalog.asr?.[0] || ''
    const vendor = vendorOf(asrDefault)
    const textDefault = (vendor && catalog.text?.find((id) => vendorOf(id) === vendor)) || catalog.text?.[0] || ''
    setAsrModel((current) => current || asrDefault)
    setTextModel((current) => current || textDefault)
  }, [catalog])

  async function discover({ force = false } = {}) {
    const key = apiKey.trim()
    if (key.length < 16) return
    if (!baseUrl.trim()) { setCatalogError('请先填写服务地址（Base URL）'); return }
    if (!force && key === probedKey.current) return
    if (inflight.current.has(key)) return
    inflight.current.add(key)
    const seq = ++probeSeq.current
    setProbing(true)
    setCatalogError('')
    try {
      let ids = null
      let count = 0
      try {
        const result = await probeModels({ apiKey: key, baseUrl: baseUrl.trim() })
        ids = Array.isArray(result?.models) ? result.models : []
        count = Number(result?.count) || ids.length
      } catch (failure) {
        if (failure?.status !== 404) throw failure
        // 宿主未重启时回退到后端目录（需要后端已运行）。
        const result = await modelCatalog()
        ids = Array.isArray(result?.models) ? result.models : []
        count = ids.length
        if (!ids.length) throw new Error('需要重启 DeepSeek Harness 后再试')
      }
      if (!mounted.current || seq !== probeSeq.current) return
      const split = splitModels(ids)
      probedKey.current = key
      setCatalog({ count, asr: split.asr, text: split.text })
    } catch (failure) {
      if (!mounted.current || seq !== probeSeq.current) return
      // 刷新失败时保留上一次的清单，只有换 Key 才清空。
      if (probedKey.current !== key) setCatalog(null)
      setCatalogError(failure?.status === 404 ? '需要重启 DeepSeek Harness 后再试' : (failure?.message || '获取模型列表失败'))
    } finally {
      inflight.current.delete(key)
      if (mounted.current) setProbing(inflight.current.size > 0)
    }
  }

  async function waitSetup(action) {
    await startSetup(action)
    for (let index = 0; index < 3600; index += 1) {
      await sleep(index === 0 ? 600 : 1500)
      if (!mounted.current) return null
      const result = await setupStatus()
      const env = result?.env || {}
      const job = env.job || {}
      if (job.log) setLog(job.log.split('\n').slice(-16).join('\n'))
      if (job.step) setDetail(job.step)
      if (job.state === 'error') throw new Error(job.error || '环境安装失败')
      if (job.state === 'cancelled') throw new Error('环境安装已取消')
      if (env.ready && (!job.state || job.state === 'done')) return env
    }
    throw new Error('环境安装超时，请稍后重试')
  }

  async function waitEngine() {
    for (let index = 0; index < 180; index += 1) {
      await sleep(index === 0 ? 500 : 1000)
      if (!mounted.current) return null
      const next = await hostStatus()
      if (next?.backend?.state === 'running') return next
      if (next?.backend?.lastError) throw new Error(next.backend.lastError)
    }
    throw new Error('本地引擎启动超时')
  }

  /**
   * 在同类别里逐个试，返回第一个真正能调通的模型。
   *
   * 网关目录只给裸 id，而调用通常要求「供应商/模型名」；有些模型的权限还按供应商
   * 分配。与其把目录第一项直接存下去再报错，不如当场试到能通的那个。
   */
  async function pickWorkingModel(kind, { vendor = '' } = {}) {
    const current = kind === 'asr' ? asrModel : textModel
    const list = kind === 'asr' ? (catalog?.asr || []) : (catalog?.text || [])
    const candidates = candidateOrder(list, {
      current,
      vendor: vendor || vendorOf(current)
    }).slice(0, MAX_CANDIDATES)
    const label = kind === 'asr' ? '语音' : '文字'
    if (!candidates.length) return { error: `目录里没有可用的${label}模型` }
    let last = ''
    for (const model of candidates) {
      if (!mounted.current) return { error: '已取消' }
      if (mounted.current) setDetail(`验证${label}模型：${model}`)
      try {
        const result = kind === 'asr'
          ? await testAsrEngine({
              provider: 'mimo', base_url: baseUrl.trim(), model, api_key: apiKey.trim()
            })
          : await testAIModel({
              provider: 'mimo', base_url: baseUrl.trim(), model, api_key: apiKey.trim()
            })
        if (result?.ok) return { model: result?.model || model }
        last = result?.message || '测试未通过'
      } catch (failure) {
        last = failure?.message || String(failure)
      }
    }
    return { error: last || `没有可用的${label}模型` }
  }

  async function runInstall() {
    if (running) return
    setRunning(true)
    setBackground(false)
    setEnvReady(false)
    setError('')
    setIssues([])
    setLog('')
    setDetail('')
    const foundIssues = []
    try {
      const current = await hostStatus()
      const desired = String(dataDir || '').trim()
      // 首次安装时默认隐藏目录 ~/.dsh/meetclip/data 还不存在；检查它会得到
      // ENOENT，旧逻辑误报成「没有完全磁盘访问权限」。这里检查用户真正选择
      // 的目录，缺失路径按最近可写祖先判断（inspectDir 已处理）。
      if (desired) {
        let info
        try {
          info = await inspectDataDir(desired, { measure: false })
        } catch (failure) {
          throw new Error(`无法检查存储位置：${failure?.message || failure}`)
        }
        // A missing folder is created by savePrefs below. Don't reject it from
        // the preflight: macOS TCC may only show its prompt on the real write,
        // and an ENOENT parent is not a permission failure.
        if (info?.exists && !info.writable) throw new Error(storagePermissionMessage(desired, info))
      } else if (current?.locations?.dataDirWritable === false) {
        throw new Error(storagePermissionMessage(current?.locations?.dataDir || '默认存储位置', null))
      }

      // The engine binds its data directory when it starts, so the choice is
      // persisted before the engine comes back up.
      if (['running', 'starting'].includes(current?.backend?.state)) await backendAction('stop')
      if (desired && desired.replace(/\/+$/, '') !== String(current?.locations?.dataDir || '').replace(/\/+$/, '')) {
        setDetail('保存存储位置')
        try {
          await savePrefs({ dataDir: desired })
        } catch (failure) {
          throw new Error(
            `保存存储位置失败：${failure?.message || failure}。` +
            '如果刚在 系统设置 → 隐私与安全性 → 完全磁盘访问权限 里勾选了 DeepSeek Harness，' +
            '需要完全退出（⌘Q）并重新打开 DeepSeek Harness 后再试。'
          )
        }
      }

      if (!current?.env?.ready) {
        setDetail('创建独立运行环境')
        await waitSetup('create-env')
      }

      setDetail('启动本地引擎')
      await backendAction('start')
      await waitEngine()
      if (mounted.current) setEnvReady(true)

      if (!skippedKey && apiKey.trim()) {
        // 先逐个试到真正能用的模型，再保存：网关的目录给的是裸 id，而调用往往要求
        // 「供应商/模型名」，直接把目录里的名字存下去会得到 401，用户只看到“凭证无效”。
        setDetail('验证云端语音')
        const asrPick = await pickWorkingModel('asr')
        if (asrPick.model) {
          setDetail('保存模型配置')
          await saveAsrEngine({
            mode: 'default',
            provider: 'mimo',
            base_url: baseUrl.trim(),
            model: asrPick.model,
            api_key: apiKey.trim()
          })
          if (mounted.current) setAsrModel(asrPick.model)
        } else {
          foundIssues.push({ id: 'asr-model', title: '云端语音不可用', detail: asrPick.error })
        }
        setDetail('验证文字模型')
        const textPick = await pickWorkingModel('text', { vendor: vendorOf(asrPick.model) })
        if (textPick.model) {
          await saveAIConfig({ provider: 'mimo', base_url: baseUrl.trim(), model: textPick.model })
          if (mounted.current) setTextModel(textPick.model)
        } else {
          foundIssues.push({ id: 'text-model', title: '文字模型不可用', detail: textPick.error })
        }
      } else {
        foundIssues.push({ id: 'asr-key', title: '云端语音未配置', detail: '进入主界面后可在 设置 → 模型 填写 API Key。' })
      }

      setDetail('安装采集组件')
      try {
        let capture = await deps()
        if (!capture?.yt_dlp || !capture?.ffmpeg) {
          await installDeps()
          for (let index = 0; index < 2400; index += 1) {
            await sleep(index === 0 ? 800 : 1500)
            const job = await depsInstallStatus()
            if (job?.log) setLog(job.log.split('\n').slice(-16).join('\n'))
            if (job?.step) setDetail(job.step)
            if (job?.error) throw new Error(job.error)
            if (job?.done && !job?.running) break
          }
          capture = await deps()
        }
        if (!capture?.yt_dlp || !capture?.ffmpeg) throw new Error('采集组件仍未就绪')
      } catch (failure) {
        foundIssues.push({ id: 'capture-deps', title: '采集组件未安装完成', detail: failure?.message || String(failure) })
      }

      const [feed, options] = await Promise.all([homeFeed({ limit: 1 }), meetingOptions()])
      if (!feed) foundIssues.push({ id: 'home', title: '首页数据未就绪', detail: '稍后刷新即可。' })
      if (options?.asr_ready === false && !skippedKey) {
        foundIssues.push({ id: 'asr-ready', title: '云端语音未就绪', detail: '请到 设置 → 模型 检查 API Key 与模型。' })
      }
      setIssues(foundIssues)

      // The directory the captures land in is exactly the workspace a new session
      // should start from; registration is idempotent per canonical path.
      setDetail('添加 DSH 工作区')
      try {
        const created = await ensureWorkspace({})
        if (mounted.current) {
          setWorkspaceInfo(created?.workspace || null)
          setWorkspaceError('')
        }
      } catch (failure) {
        if (mounted.current) setWorkspaceError(failure?.message || String(failure))
      }

      setStep(3)
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setRunning(false)
    }
  }

  async function chooseDir() {
    if (running) return
    setPickingDir(true)
    setError('')
    try {
      const result = await pickFile('directory')
      if (result?.ok && result.path) setDataDir(result.path)
      else if (result && !result.cancelled && result.error) setError(result.error)
    } catch (failure) {
      setError(failure?.message || String(failure))
    } finally {
      setPickingDir(false)
    }
  }

  async function finish() {
    if (!workspaceInfo) {
      try {
        const created = await ensureWorkspace({})
        setWorkspaceInfo(created?.workspace || null)
        setWorkspaceError('')
      } catch (failure) {
        setWorkspaceError(failure?.message || String(failure))
      }
    }
    onComplete()
  }

  const asrOptions = modelOptions(catalog?.asr || [], asrModel)
  const textOptions = modelOptions(catalog?.text || [], textModel)

  return (
    <div className="mc-setup">
      <section className="mc-setup-card">
        <div className="mc-setup-hero">
          <span className="mc-setup-mark">会摘</span>
          <div>
            <p className="mc-setup-eyebrow">首次使用 · {step} / 3</p>
            <h2>{step === 1 ? '连接模型服务' : step === 2 ? '安装环境' : '准备进入会摘'}</h2>
            <p>{step === 1 ? '填写 OpenAI 兼容服务地址与 API Key，自动获取可用模型。' : step === 2 ? '安装 Python 环境与采集组件，可选接入飞书 MCP。' : '未完成项会在首页提示。'}</p>
          </div>
        </div>

        <div className="mc-setup-steps">
          {['云端模型', '安装环境', '完成'].map((label, index) => (
            <div key={label} className="mc-setup-step" data-state={step > index + 1 ? 'done' : step === index + 1 ? 'active' : 'pending'}>
              <span className="mc-setup-step-index">{String(index + 1).padStart(2, '0')}</span>
              <span>{label}</span><i />
            </div>
          ))}
        </div>

        {step === 1 ? (
          <div className="mc-setup-form">
            <label className="mc-form-row">
              <span>服务地址</span>
              <input className="mc-input" value={baseUrl} spellCheck={false}
                onChange={(event) => setBaseUrl(event.target.value)}
                onBlur={() => { discover() }}
                placeholder={BASE_PLACEHOLDER} />
            </label>
            <p className="mc-setup-fine">任意 OpenAI 兼容网关：例如你自己的代理、公司网关或 OpenAI 官方地址。</p>
            <label className="mc-form-row">
              <span>API Key</span>
              <div className="mc-setup-key">
                <input className="mc-input" type={showKey ? 'text' : 'password'} value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false}
                  onBlur={() => { discover() }}
                  onKeyDown={(event) => { if (event.key === 'Enter') discover() }}
                  placeholder="粘贴 API Key" />
                <button type="button" className="mc-button mc-button-small" onClick={() => setShowKey((v) => !v)}>{showKey ? '隐藏' : '显示'}</button>
              </div>
            </label>
            <p className="mc-setup-fine">Key 只保存在本机钥匙串。</p>

            {probing ? <p className="mc-card-text">{catalog ? '正在更新模型清单…' : '正在获取模型…'}</p> : null}
            {catalogError ? <div className="mc-setup-error"><strong>没有连上</strong><p>{catalogError}</p></div> : null}
            {catalog ? <p className="mc-card-text">{`已获取 ${catalog.count || 0} 个模型`}</p> : null}

            {catalog ? (
              <>
                <label className="mc-form-row">
                  <span>语音转文字</span>
                  <select className="mc-input mc-select" value={asrModel} onChange={(event) => setAsrModel(event.target.value)}>
                    {asrOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <label className="mc-form-row">
                  <span>文字总结</span>
                  <select className="mc-input mc-select" value={textModel} onChange={(event) => setTextModel(event.target.value)}>
                    {textOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
              </>
            ) : null}

            <div className="mc-actions">
              <button type="button" className="mc-button" disabled={probing || !apiKey.trim() || !baseUrl.trim()} onClick={() => discover({ force: true })}>
                {probing ? '获取中…' : catalog ? '重新获取' : '获取模型'}
              </button>
              {catalog ? (
                <button type="button" className="mc-button" data-variant="primary" onClick={() => setStep(2)}>下一步</button>
              ) : (
                <button type="button" className="mc-button" onClick={() => { setSkippedKey(true); setStep(2) }}>跳过</button>
              )}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="mc-setup-form">
            <label className="mc-form-row">
              <span>存储位置</span>
              <div className="mc-setup-key">
                <input className="mc-input" value={dataDir || ''} readOnly title={dataDir}
                  placeholder="资料保存的文件夹" />
                <button type="button" className="mc-button mc-button-small"
                  disabled={running || pickingDir} onClick={chooseDir}>
                  {pickingDir ? '选择中…' : '选择…'}
                </button>
              </div>
            </label>
            <p className="mc-setup-fine">
              录音、转写、笔记与数据库都保存在这里。完成后会自动把同一目录添加为 DSH 工作区，
              在那个工作区新建会话，输入 @ 就能选会摘卡片，把记录内容带进对话；可以连续 @ 多条。
            </p>
            <p className="mc-setup-fine">
              如果系统提示存储位置不可写：在 系统设置 → 隐私与安全性 → 完全磁盘访问权限
              勾选 DeepSeek Harness 后，需要完全退出（⌘Q）再打开；也可以点「选择…」换到「文稿」以外的目录。
            </p>
            <div className="mc-setup-progress">
              <div className="mc-setup-progress-head"><span className={running ? 'mc-setup-spinner' : ''} /><strong>{detail || (running ? '准备安装' : '点击下方按钮开始')}</strong></div>
              {log ? <pre className="mc-log">{log}</pre> : null}
            </div>
            {error ? <div className="mc-setup-error" role="alert"><strong>安装没有完成</strong><p>{error}</p></div> : null}
            <div className="mc-actions">
              <button type="button" className="mc-button" data-variant="primary" disabled={running} onClick={runInstall}>
                {running ? '正在配置…' : '一键安装并配置'}
              </button>
              {running ? (
                <button type="button" className="mc-button" onClick={() => { setBackground(true); setStep(3) }}>后台完成</button>
              ) : null}
              {error ? <button type="button" className="mc-button" disabled={running} onClick={runInstall}>重新尝试</button> : null}
            </div>
            <FeishuSetupSection feishu={feishu} />
          </div>
        ) : null}

        {step === 3 ? (
          running && background ? (
            <div className="mc-setup-done">
              <div className="mc-setup-done-icon mc-setup-done-pending"><span className="mc-setup-spinner" /></div>
              <h3>正在后台配置</h3>
              <p>安装会继续；完成后进入主界面即可。</p>
              <div className="mc-setup-progress">
                <div className="mc-setup-progress-head"><span className="mc-setup-spinner" /><strong>{detail || '正在配置…'}</strong></div>
                {log ? <pre className="mc-log">{log}</pre> : null}
              </div>
              <button type="button" className="mc-button mc-setup-primary" data-variant="primary" disabled={!envReady} onClick={finish}>进入主界面</button>
              {!envReady ? <p className="mc-setup-fine">运行环境完成后即可进入。</p> : null}
              <WorkspaceNote info={workspaceInfo} error={workspaceError} />
            </div>
          ) : error && background ? (
            <div className="mc-setup-done">
              <div className="mc-setup-done-icon mc-setup-done-error">!</div>
              <h3>安装没有完成</h3>
              <p>{error}</p>
              <div className="mc-actions">
                <button type="button" className="mc-button" onClick={() => { setBackground(false); setStep(2) }}>返回安装</button>
                <button type="button" className="mc-button mc-setup-primary" data-variant="primary" onClick={finish}>进入主界面</button>
              </div>
              <WorkspaceNote info={workspaceInfo} error={workspaceError} />
            </div>
          ) : (
            <div className="mc-setup-done">
              <div className="mc-setup-done-icon">✓</div>
              <h3>{issues.length ? '已可进入会摘' : '环境已就绪'}</h3>
              <p>{issues.length ? '未完成项会在首页提示。' : '可以开始采集了。'}</p>
              {issues.length ? (
                <div className="mc-setup-issues">
                  {issues.map((issue) => <div key={issue.id}><strong>{issue.title}</strong><span>{issue.detail}</span></div>)}
                </div>
              ) : null}
              <WorkspaceNote info={workspaceInfo} error={workspaceError} />
              <FeishuSetupSection feishu={feishu} />
              <button type="button" className="mc-button mc-setup-primary" data-variant="primary" onClick={finish}>进入主界面</button>
            </div>
          )
        ) : null}
      </section>
    </div>
  )
}

function storagePermissionMessage(target, info) {
  const state = info && info.exists === true && info.isDirectory === false
    ? '这个路径不是文件夹'
    : '这个位置当前不可写'
  return `${state}：${target}。请点「选择…」换一个可写文件夹；` +
    '如果刚在 系统设置 → 隐私与安全性 → 完全磁盘访问权限 里勾选了 DeepSeek Harness，' +
    '需要完全退出（⌘Q）并重新打开 DeepSeek Harness 后再试。'
}

function FeishuSetupSection({ feishu }) {
  const status = feishu.status
  const running = status?.job?.state === 'running'
  const installed = Boolean(status?.dsh?.entryPresent)
  const loggedIn = Boolean(status?.auth?.loggedIn)
  const busy = Boolean(feishu.busy) || running
  // 与设置页保持同一套判断：源没配好时不要给出可点的安装按钮，
  // 否则一点就抛「尚未配置飞书 MCP 包」这种看不懂的错误。
  const canInstall = Boolean(status) && Boolean(status.runtime?.npxOk)
    && !status.dsh?.conflict && Boolean(status.package?.configured)
  const stateText = !status ? '读取中…' : installed ? (loggedIn ? '已配置并登录' : '已配置，未登录') : '未配置'

  return (
    <div className="mc-setup-feishu">
      <div className="mc-setup-feishu-head">
        <strong>飞书 MCP（可选）</strong>
        <span data-tone={installed && loggedIn ? 'ok' : undefined}>{stateText}</span>
      </div>
      <p className="mc-setup-fine">
        让 Agent 直接读写飞书文档、多维表格、云盘与 Wiki，工具名以
        <code className="mc-mono">mcp__feishu__</code> 开头；不装也不影响采集、转写与纪要。
      </p>
      <FeishuStatusRows status={status} compact />
      <div className="mc-actions">
        {!installed ? (
          <button type="button" className="mc-button" disabled={busy || !canInstall} onClick={feishu.actions.install}>
            {running && status?.job?.action === 'install' ? '正在安装…' : '安装飞书 MCP'}
          </button>
        ) : null}
        {installed && !loggedIn ? (
          <FeishuLoginActions status={status} actions={feishu.actions} busy={feishu.busy} running={running} />
        ) : null}
        {installed ? (
          <button type="button" className="mc-button" disabled={busy} onClick={feishu.actions.probe}>
            {running && status?.job?.action === 'probe' ? '检测中…' : '检测连接'}
          </button>
        ) : null}
        {installed && loggedIn ? (
          <button type="button" className="mc-button" disabled={busy} onClick={feishu.actions.logout}>退出登录</button>
        ) : null}
      </div>
      {feishu.error ? <p className="mc-error-text" role="alert">{feishu.error}</p> : null}
      <FeishuJobPanel job={status?.job} actions={feishu.actions} />
    </div>
  )
}

function WorkspaceNote({ info, error }) {
  if (info) return <p className="mc-setup-fine">已添加 DSH 工作区：{info.title}；在那个工作区输入 @ 可选会摘卡片</p>
  if (error) return <p className="mc-setup-fine">工作区未添加：{error}（稍后可在 设置 → 采集 里重试）</p>
  return null
}
