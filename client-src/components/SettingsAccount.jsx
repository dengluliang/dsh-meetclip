import { BilibiliLoginCard } from './login/BilibiliLoginCard.jsx'
import { DouyinLoginCard } from './login/DouyinLoginCard.jsx'
import { FeishuAccountCard } from './login/FeishuAccountCard.jsx'

export function SettingsAccount() {
  return (
    <div className="mc-settings-panel">
      <section className="mc-section">
        <div className="mc-section-title">账号</div>
        <p className="mc-card-text">
          这三个账号都是可选的：B站用于原画/会员视频，抖音用于视频下载，飞书用于文档卡片与 Agent 读写。
          公开的 B站视频不登录也能试。
        </p>
        <div className="mc-account-grid" data-settings-anchor="bilibili">
          <BilibiliLoginCard />
        </div>
        <div className="mc-account-grid" data-settings-anchor="douyin">
          <DouyinLoginCard />
        </div>
        <div className="mc-account-grid" data-settings-anchor="feishu">
          <FeishuAccountCard />
        </div>
      </section>
    </div>
  )
}
