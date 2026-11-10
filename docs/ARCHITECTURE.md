# 架构

```
DSH Web GUI
 ├─ Client 半区（React，main / sidebar.panellist / settings.section）
 │    ├─ 同源 fetch、EventSource、<video>/<audio>、XHR 上传/内录
 │    └─ DSH 主题 token、locale、宿主控件样式（.mc- 前缀）
 └─ Host 半区（Node ESM，零运行时 npm 依赖）
      ├─ /meetclip/api/*  → 反向代理 → 127.0.0.1:<port>/api/*（注入 token、流式、Range）
      ├─ /meetclip/app/*  → 状态、启停、安装、日志、文件选择、上传、内录回传
      ├─ 后端生命周期（attach / spawn / restart / stop / PID / 日志）
      └─ meetclip_* Agent 工具 + 系统提示段落
           ↓
 fork 的 FastAPI 后端（backend/，插件独立 venv）
      ├─ SQLite / 媒体 / HLS / SSE / 统一队列
      ├─ yt-dlp + ffmpeg
      ├─ MiMo 云端 ASR
      ├─ 纪要引擎（增量 + 终稿，证据行号 → 秒）+ AI 治理层（闸门/重试/指标）
      └─ CalDAV + macOS Keychain
```

## 关键选择

- **同源代理**：浏览器不接触后端 token，不引入 CORS；SSE 与媒体 Range 直接透传。
- **纯云端转写**：时间戳来自 MiMo 的 4–15 秒停顿切分（片段级），说话人分离已下线；旧记录标签只读保留。`speakers_cloud.py` 只留一个可注册的云端分离接线位。
- **原生工具而非 MCP**：DSH 内不需要每轮 capability token；工具与 UI 调用同一后端接口。
- **插件自带后端与 venv**：满足“不安装原 App 也能独立使用”；数据仍可复用原 `data/`。
- **设置进 DSH Settings**：配置按宿主信息架构聚合；主面板只负责业务运行状态。

## 生命周期

- 懒启动：打开页面、列表请求或工具首次调用触发 `ensure()`。
- `auto`：已运行则 attach；否则用插件 venv spawn；`external` 只 attach；`managed` 只 spawn。
- 停止：SIGINT，10 秒后 SIGKILL；attached 不停止。
- 崩溃：managed 且曾健康时 10 分钟内最多自动重启 3 次。
- 状态与日志：`<stateDir>/backend.log`、`setup.log`、`backend.pid`。

## 数据流

- 页面 → `/meetclip/app/status`、`/meetclip/api/...`。
- 选中记录 → 详情接口 + SSE；列表/状态 2.5–8 秒轮询（页面隐藏时暂停）。
- 写操作 → 后端接口；笔记/日程笔记使用版本 CAS，冲突保留草稿。
- 工具 → Host `backendRequest` → 同一后端；转写分页 ≤200 行/约 12k 字符，纪要按主题/条目裁剪。
- 纪要：写入在后台线程串行跑（一条记录同时只有一个任务）；详情接口只回状态与版本，正文按需拉；
  覆盖率按**秒**记账，因为终稿会用 `replace_transcripts` 整表重插转写。

## @ 会摘卡片

```
记录变化（标题/状态/笔记/纪要/转写/标记）
      ↓ 签名比对
backend/app/cards.py ──→ <dataDir>/会摘卡片/<标题>.md
      └──────────────→ card_exports（文件名、签名、搜索文本）
      ↓
GET /api/cards?q=…  ──→ 客户端 @ source（仅 cwd = dataDir 的会话）
      ↓
插入 @@"会摘卡片/…md" ──→ 模型 read 卡片 → 需要更多时调用 meetclip_* 工具
```

- 卡片是**派生数据**：一张记录一张 Markdown，标题即文件名，重名加序号；内容有上限，完整转写不落盘到卡片里。
- 同步是幂等的：签名不变不重写；Host 在引擎启动、DSH 工作区创建时触发，另有 60 秒增量定时器；`@` 菜单打开时走 2 秒节流的 `GET /api/cards`。
- 客户端用 `ctx.inject(['inputTriggers','sessions'])` 注册 `meetclip-cards` source（order -10），只在会话 cwd 等于会摘根目录时出现；`inputTriggers` 不可用时自动降级为 DSH 原生文件 `@`。
- 旧版/外部后端没有 `/api/cards` 时，Host 熔断并只记一次日志；文件菜单仍可用，其他采集/转写/工具不受影响。

### 飞书文档卡片（0.8.11）

```
首页「＋」→ 飞书文档 →（650ms 防抖）POST /meetclip/app/feishu/doc-preview → 标题/长度/摘要回填（可改）
      ↓ 确认
POST /meetclip/app/feishu/doc-card
      ↓ Host 解析 docx/wiki/sheets/base/docs
      ├─ mcp__feishu__doc_read（wiki 先 mcp__feishu__wiki_get_node）
      ├─ 兜底（仅 docx、本地 token 未过期）：open.feishu.cn docx raw_content
      └─ 仍失败：仅链接卡片 + warning
      ↓
POST /api/cards/doc ──→ cards.upsert_doc_card()
      ├─→ <dataDir>/会摘卡片/<标题>.md
      └─→ doc_cards（key、doc_type:token、文件名、签名、正文快照）
      ↓
GET /api/cards ──→ 记录卡 + 文档卡混排（kind=doc）
GET /api/home  ──→ documents[]：首页文档墙/散落卡与「文档」筛选
```

- 不重复实现飞书授权：正文读取优先复用 DSH 已配置的 Feishu MCP；token、私有域名与刷新由 MCP 负责。Open API 只在 MCP 不可用、且本地 `auth.json` 的 access token 未过期时作为 docx 兜底，只读、不写回。
- 文档卡是**登记时的快照**：`doc_type:token` 去重，重复添加刷新正文与时间；没有 `session_id`，不参与 `meetclip_*` 记录查询。
- 文件名分配与记录卡共用一套规则：`sync_cards` 先占住现存文档卡文件名；文档卡改名时只在确认旧文件不属于记录卡时删除。`sync_cards` 不清理 `doc_cards`。
- 支持范围：docx 与解析到 docx 的 wiki 读正文；sheets/base/旧 docs 只登记链接。没有 AI 摘要、没有定时同步，也不在 `/jianbao` 后自动登记。

## 多资料空间

一份资料空间 = 一个数据目录（自己的 `zhibo.db`、记录目录、`会摘卡片/`、`.api-token`、`.trash`）。
同一时刻只有一个激活空间在跑，`settings.dataDir` 始终等于激活空间的目录，所以媒体相对路径、
导出、清理与工具代码都不需要知道「有多个库」这件事。

```
prefs.json（<stateDir>，0o600）
 ├─ schema: 2
 ├─ libraries: [{id, name, dataDir, createdAt, lastOpenedAt}]
 ├─ activeLibraryId
 ├─ dataDir           ← 旧版本宿主的镜像字段
 └─ sharedDir         ← 启用共享账号后才有
```

- **身份**：`id = sha1(realpath)[:10]`；目录里另写 `.meetclip-library.json`（`{version,id,name,createdAt}`），
  目录改名或被拷到另一台机器后重新收养仍是同一个空间。
- **切换**：`activateLibrary` = 收集在跑任务 →（未确认则 409 `library_busy`）→ 对记录调
  `POST /api/sessions/{id}/stop` 让采集收尾 → 停引擎 → 写 `activeLibraryId`/镜像 `dataDir` → 重启 →
  卡片同步；任一步失败回滚 prefs 并尽量拉回原引擎。`backend.attached`（外部进程托管）时拒绝切换。
- **兼容**：`/app/data-dir`、`/app/prefs` 校验与回包字段不变，内部变成「建/收养一个空间并切过去」；
  `move=true` 仍是同盘原子 rename 后再切。首次写入注册表前备份 `prefs.json.bak-v1`，未知字段原样保留。
- **共享**：`~/.dsh/meetclip/shared`（可用 prefs 覆盖）存 `settings.json`、`bili_cookies.txt`、
  `douyin_cookies.txt`。Host 只在启用后往子进程注入 `MEETCLIP_SHARED_DIR`；后端 `shared_paths.py`
  在变量缺失时回落到 `DATA_DIR`，因此单库安装、macOS 版会摘与外部引擎行为不变。启用时只复制不移动。
- **@ 卡片**：根目录即激活空间目录；`candidates()` 额外比对全部空间的目录，命中另一个空间时
  发 `libraryMismatch`（`lib/status-bus.js`），面板渲染成一行可点击的切换提示。
- **不做**：跨空间检索、多引擎并行、按会话 cwd 自动切换（歧义与副作用不可控）。

## 安全边界

- 浏览器鉴权与 Host/Origin 检查由 `connection.requestRejection` 完成。
- 上传仅 `<stateDir>/uploads`；内录仅 `<dataDir>/<session>/` 下目标路径。
- 导入工具限制在 uploads/data；不提供任意路径/命令/HTTP。
- Keychain 密钥只由后端读取；页面不返回密钥。

## 飞书 MCP Pro（可选接入）

会摘自己的能力走原生工具（`meetclip_*`）；飞书是第三方 MCP server，按 DSH 的标准方式接入，不重复实现：

- **配置位置**：`$DSH_HOME/cordis.patch.yml`（user patch，优先级高于 profile patch，且由 HMR 监听）。Host 只往里追加一段带标记注释的 `insert`：`@deepseek-ai/dsh-mcp-client` + `transport: stdio` + 绝对 `npx` 路径 + `PATH`/`npm_config_cache`。写入前备份，重复写入幂等，移除只删这一段；文件不像 YAML 序列或已有别的 `serverName: feishu` 时拒绝写入。
- **为什么用绝对 npx + 自带 npm 缓存**：DSH 从 Finder 启动时 PATH 往往比登录 shell 短；`dsh-mcp-client` 又会清洗 `DSH_*` 与 `*KEY/PASSWORD/SECRET/TOKEN*` 环境变量。显式 `env` 保证 `npx → node` 能解析，专用缓存避免用户 `~/.npm` 被 sudo 装过导致 EPERM。
- **版本**：安装时解析一次并固定（`<飞书 MCP 包名>@x.y.z`），启动不做网络解析；「检查更新」重新解析并改写同一段。
- **验证**：安装的最后一步用 MCP `initialize` + `tools/list` 真连一次，报告工具数量；失败不会回滚已写入的配置，只标记「连接待确认」。
- **登录**：调用包的 `login`（macOS 默认浏览器授权码流，可切 `--device`），Host 只解析 stderr 里的授权链接；令牌由 CLI 自己写 `~/.feishu-mcp-pro/auth.json`，Host 仅读 `open_id`/`expires_at`/`refresh_expires_at`，API 与界面都不返回令牌。
- **状态判定**：`entryPresent` 读 patch 文本，`entryLive` 读 `ctx.get('loader').entries()`（拿不到时为 `null`，界面显示「重启后生效」）。
- **接口**：`/meetclip/app/feishu/{status,install,update,login,logout,setup,probe,cancel,config}`；任务单槽、可取消，日志写 `<stateDir>/feishu.log`。`/meetclip/app/open` 增加 URL 白名单（只允许飞书官方域名），用于打开授权页与文档。
