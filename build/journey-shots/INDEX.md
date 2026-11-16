# 会摘 0.9.15 · 前端界面前后对比

- **Before**：`git archive HEAD` 的 0.9.14 源码 + 同一套 `build/journey-preview` harness（无头 Chrome，1440 宽，浅色）。
- **After**：0.9.15 工作区 + 同一 harness、同一 mock 状态。
- 新增界面在 before 里显示最接近的旧界面，表格中标注「新增，无旧界面」。
- 重新生成：
  ```bash
  node build/build-journey-preview.mjs
  node build/journey-shots.mjs --out build/journey-shots/after
  # 基线与 after 使用同一 harness；见 docs/VERIFICATION.md 0.9.15
  ```

| # | 界面 | Before | After | 说明 |
|---|---|---|---|---|
| 1 | 首页顶栏 | `before/01-home-topbar.png` | `after/01-home-topbar.png` | 新增「设置」「？」入口；Hero 对话框未改 |
| 2 | 设置 → 模型 | `before/02-settings-models.png` | `after/02-settings-models.png` | API Key 在最上、模型/地址分离 → 地址+Key+一次保存；死锁解除 |
| 3 | 设置 → 账号 | `before/03-settings-account.png` | `after/03-settings-account.png` | **新增，无旧界面**；before 为旧模型页 |
| 4 | 设置 → 采集 | `before/04-settings-capture.png` | `after/04-settings-capture.png` | B 站/抖音登录移出，只留画质、灵敏度与通用开关；新增权限按钮 |
| 5 | 设置 → 飞书 | `before/05-settings-feishu.png` | `after/05-settings-feishu.png` | access token 过期仍显示可使用 → 登录待刷新、设备码、验证读取 |
| 6 | 设置弹层 | `before/06-settings-dialog.png` | `after/06-settings-dialog.png` | **新增，无旧界面**；before 为顶栏首页 |
| 7 | 引导第 1 步 | `before/07-setup-step1.png` | `after/07-setup-step1.png` | 跳过始终可用；文案与验证说明 |
| 8 | 引导第 2 步 | `before/08-setup-step2.png` | `after/08-setup-step2.png` | 去掉飞书块；加上一步、取消、完全磁盘访问、耗时说明 |
| 9 | 引导第 3 步 | `before/09-setup-step3.png` | `after/09-setup-step3.png` | 就绪清单、修复入口、可选账号、四条「现在试一次」 |
| 10 | 首页配置进度 | `before/10-progress-card.png` | `after/10-progress-card.png` | 手填模型 ID → 同一连接向导 |
| 11 | 视频表单：B 站登录失败 | `before/11-video-bili.png` | `after/11-video-bili.png` | 只有错误+重试 → 中文原因、扫码登录、登录后重试、技术详情 |
| 12 | 视频表单：抖音登录 | `before/12-video-douyin.png` | `after/12-video-douyin.png` | 静态提示/原文 → 三步登录卡入口 |
| 13 | 直播表单：接口风控 | `before/13-launch-error.png` | `after/13-launch-error.png` | 原文 → 中文建议 + 登录入口 |
| 14 | 飞书文档表单 | `before/14-doc-login.png` | `after/14-doc-login.png` | 灰色提示 → 实时状态、登录/设备码、仅登记链接、自动重试 |
| 15 | 使用指南 | `before/15-help.png` | `after/15-help.png` | **新增，无旧界面**；before 为顶栏首页 |
| 16 | 记录详情：登录失败 | `before/16-record-login.png` | `after/16-record-login.png` | 重复错误文字 → 登录卡 + 重试 + 技术详情 |
| 17 | 设置 → 关于（新增） | `before/17-settings-about.png` | `after/17-settings-about.png` | **新增，无旧界面**；增加「重新运行配置向导」 |
