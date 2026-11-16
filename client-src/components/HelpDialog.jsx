const ENTRIES = [
  { kind: 'launch', title: '发布会直播', hint: '贴直播间链接，边录边转写；登录 B站可录原画' },
  { kind: 'video', title: '视频链接', hint: 'B站、YouTube、抖音等链接；抖音通常要登录' },
  { kind: 'meeting', title: '会议录音', hint: '选本地音频或视频，可多选批量导入' },
  { kind: 'doc', title: '飞书文档', hint: '读成可 @ 的卡片；也可只登记链接' }
]

export function HelpDialog({ onClose, onStart }) {
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
    <div className="mc-modal-layer" role="dialog" aria-modal="true" aria-label="会摘使用指南"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="mc-modal mc-help-dialog">
        <div className="mc-modal-head">
          <h3>会摘怎么用</h3>
          <button type="button" className="mc-icon-button" aria-label="关闭使用指南" onClick={onClose}>×</button>
        </div>
        <div className="mc-help-body">
          <section>
            <h4>四个入口</h4>
            <div className="mc-help-entries">
              {ENTRIES.map((entry) => (
                <button key={entry.kind} type="button" onClick={() => { onClose(); onStart?.(entry.kind) }}>
                  <strong>{entry.title}</strong>
                  <span>{entry.hint}</span>
                </button>
              ))}
            </div>
            <p>一般从左侧「＋」开始；首页对话框用来问 Agent，贴链接也会交给 Agent 处理。</p>
          </section>
          <section>
            <h4>账号什么时候需要</h4>
            <ul>
              <li>B站：录直播原画、会员/私享视频；公开视频可匿名。</li>
              <li>抖音：多数视频下载需要登录；按「选浏览器 → 扫码 → 读取登录状态」三步走。</li>
              <li>飞书：读文档卡片和 Agent 读写飞书；只登记链接可以不登录。</li>
            </ul>
          </section>
          <section>
            <h4>设置在哪里</h4>
            <p>会摘面板右上角「设置」：模型、账号、采集、飞书、资料空间、关于。改完直接关闭，底层页面不会丢。</p>
          </section>
          <section>
            <h4>遇到问题</h4>
            <ul>
              <li>提示需要登录：错误旁边就有「扫码登录 B站 / 登录抖音」。</li>
              <li>飞书说已登录却读不了：到会摘面板右上角「设置 → 飞书」点「测试读取」，确认能读一篇文档。</li>
              <li>读不到浏览器 Cookie：到设置 → 账号点「打开完全磁盘访问设置」，授权后重启引擎。</li>
            </ul>
          </section>
          <section>
            <h4>快捷键</h4>
            <p>⌘K 搜索；⌘↩ 把首页输入发给 Agent；Esc 关闭弹层。</p>
          </section>
        </div>
      </div>
    </div>
  )
}
