# 验证记录

## 0.9.2 开源去敏（2026-11-10）

### 改动

- 后端：`asr_engines.DEFAULT_URL/DEFAULT_MODEL`、`settings.DEFAULTS["mimo_base_url"/"mimo_model"]`、`ai/providers.DEFAULT_BASE/DEFAULT_MODEL` 全部置空；`validate_config` 对空地址抛「请先填写服务地址（Base URL）」；`default_config` 在未配置时返回空配置而不是抛错，`CloudASRProvider.is_ready()` 同时要求地址与模型，`require_ready` 按缺什么给什么提示。
- 后端：`ai/client._guard()` 在发请求前拦「没填地址/模型」，`chat()` 先判 Key 再判配置（缺 Key 仍报 `no_key`）；`status()` 新增 `configured` 与 `model_prefix`；`wire_model` 的供应商前缀改为 `MEETCLIP_AI_MODEL_PREFIX`（默认不补）。
- 后端：新增 `MEETCLIP_AI_BASE_URL` / `MEETCLIP_AI_MODEL` / `MEETCLIP_ASR_BASE_URL` / `MEETCLIP_ASR_MODEL` 环境变量回落，便于 CI 与无界面部署。
- Host：`asr-probe` / `models-probe` 去掉内置地址与模型，空地址直接报「请先填写服务地址（Base URL）」；`feishu.js` 的包名与 npm 源改为 `settings.feishuPackage` / `settings.feishuRegistry` → 环境变量 → 空，`packageTarget()` 在未配置时给出可照做的中文提示；`status().package` 新增 `configured`。
- 客户端：`SetupWizard` 首步新增「服务地址」输入（未填地址不拉模型、按钮置灰）；`SettingsModels` 的语音/文字两张卡各新增「服务地址 + 保存地址」，`modelOptions` 排序改为按当前配置的族名；`SetupProgressCards` 的配置表单补地址与模型；`feishuSummary` 优先提示「未配置 MCP 源」并置灰安装按钮。
- 文档与测试：README / INSTALL / CHANGELOG / ARCHITECTURE / 调研文档里的私有地址、私有 npm 源、私有包名与厂商模型名全部替换为通用描述；前端与后端测试夹具改用 `https://gateway.example.test/v1` + `demo-*` 模型名。

### 自动化验证

- 前端 `node --test tests/*.test.mjs` **242/242** 通过（含 `tests/feishu.test.mjs` 改为显式注入测试包名与源、`tests/host.test.mjs` 的 ASR 探针与模型清单用例改为传 `base_url`、新增「没填地址不发请求」断言）。
- 后端 `MEETCLIP_TEST_PYTHON=…/python3.12 bash backend/tests/run-all.sh` **29 个测试文件全部 PASS**；重点：`test_cloud_asr` 补「不填 Base URL 返回 400 + 提示」、`test_task_queue` 与 `test_minutes*` 通过环境变量注入示例网关、`test_ai_layer` 的 `wire_model` 用例改为按 `MEETCLIP_AI_MODEL_PREFIX` 断言。
- 基线对照：同样的后端用例在 git HEAD（0.9.1）上全部 PASS，说明本轮改动没有掩盖既有失败。
- `node build/build-client.mjs` + `node --check client.js` 通过；重新构建的 `client.js` 里私有域名、私有源、私有包名与厂商前缀 0 命中。
- 全仓库扫描（源码 / 文档 / 测试 / 构建产物）上述四类标识 0 命中；`backend/data/` 属本地运行数据，已在 `.gitignore` 中排除。

### 手工核对

- 未配置网关时：新建记录、导入会议、写笔记均正常；语音/纪要显示「未配置」并按设置页提示补齐地址，不再出现 URL 解析错误。
- 设置 → 飞书：未配置 `feishuPackage`/`feishuRegistry` 时显示「未配置 MCP 源」的说明卡，安装按钮置灰；配置后恢复原有安装/登录流程。

## 未发布：纪要「结论和待办」标记列对齐（2026-11-11）

### 改动

- 现象：会议模板把结论和待办并进同一节，编号结论与勾选待办的正文左边缘差 4px；序号列（16px）和勾选框列（12px）也不等宽，整段读起来是锯齿的。
- 根因：两条列表各自写死标记宽度——序号 `flex: 0 0 16px` + `gap: 8px`，勾选框 `width: 12px` + `gap: 8px`，正文因此落在 24px 和 20px 两列。
- 修复：`.mc-minutes-list` 声明 `--mc-marker: 16px`（列宽）与 `--mc-row: 20.8px`（列高 = 13px × 1.6 行高）；序号 `flex: 0 0 var(--mc-marker)` + `height: var(--mc-row)` + flex 居中，勾选框 `flex: 0 0 12px` + `margin: calc((var(--mc-row) - 12px) / 2) 2px 0`（12 + 2 × 2 = 16px）。两条列表正文同起 24px，数字和方框的水平中心、垂直中心也都落在标记列的同一条中线上。
- 分层：`.mc-minutes-conclusions + .mc-minutes-todos` 加 10px 上间距（条目间距 6px + 10px = 16px），结论块和待办块不再连成一条列表；单独出现待办（视频 / 直播模板）时相邻选择器不生效，不会留下悬空间距。
- 新增预览：`build/outcomes-preview.jsx` + `build/outcomes-preview.html` + `build/build-outcomes-preview.mjs` + `build/outcomes-preview-shot.mjs`，用真实 `MinutesView` 和真实样式渲染这条记录（5 条结论 + 10 条待办）；`--metrics` 量序号 / 勾选框 / 正文的 x，`--stress` 补两位序号（1..10）和一条长待办，`--done` 把第一条待办标成已完成。

### 自动化验证

- `node build/outcomes-preview-shot.mjs --metrics`：修复前正文列 **40 / 36**（结论 / 待办），修复后统一 **40**；序号列与勾选框列都从 16 起。
- 无头 Chrome 像素量：序号与勾选框的中心差修复前 **2.5px（水平）/ 1px（垂直）**，修复后 ≤ **0.5px**；两位序号（`--stress` 第 10 条）仍居中在 16px 列内。
- `node --test tests/*.test.mjs` **270/270** 通过，新增 `tests/style.test.mjs` 两个用例：「conclusion numbers and todo checkboxes share one marker column」（勾选框宽度 + 右留白必须等于标记列宽）与「the todo block is set off from the conclusions above it」（待办前间距必须大于条目间距）。
- `node build/build-client.mjs` 重新生成 `client.js`（2 219 409 字节），`client.js` 内 `--mc-marker` 命中 2 处。
- 无头 Chrome 复核浅色主题：`build/outcomes-align-compare.png`（上：修复前，下：修复后，红线为结论正文列）。

### 手工核对

- `--stress` 下两位序号（第 10 条）仍落在 16px 列内，长待办折行后正文不会绕到勾选框下面。
- 勾选待办（打勾 + 划线）后正文仍在同一列（`--done` 预览）；只读（`span`）与可点（`button`）两种勾选框尺寸一致。

## 未发布：会议音视频批量导入自动成包（2026-11-10）

### 改动

- Host 原生选择器去掉 `of type {"public.movie","public.audio"}` 过滤并开启多选；媒体脚本用 `character id 31` 分隔返回路径，空格、中文、逗号不拆坏。目录选择保持原脚本。
- `MeetingForm` 改为文件列表：多选/多拖拽、逐行上传进度、失败原因、移除；单次最多 20 个；不支持扩展名与重复文件跳过并提示。单文件仍调 `/api/meetings/import`，2 个及以上调新增的 `/api/meetings/import-batch`。
- 批量接口逐条容错导入，成功 2 条及以上自动创建卡包，默认名 `会议录音 · MM-DD HH:MM`；`packs.create_pack` 新增内部参数 `allow_active_sessions`，只给批量导入使用，手工 `/api/packs` 继续拒绝进行中的记录。
- `Panel` 处理批量响应并在首页自动打开新卡包（`HomePage` 新增 `packFocus`）；单文件仍打开记录详情。
- 失败策略：单条路径/扩展名/入队失败不阻塞其他文件；整批总大小校验磁盘剩余空间 −512MB；卡包创建失败返回 `pack_error`，已入队记录不丢。

### 自动化验证

- 前端：`node --test tests/*.test.mjs` **237/237** 通过。新增 `tests/meeting-files.test.mjs` 9 项（视频/音频扩展名、标题与默认卡包名、路径条目、去重、20 上限、批量/单文件载荷）与 `tests/host-picker.test.mjs` 5 项（单选无 UTI 过滤、多选脚本、目录脚本、路径解析）。
- 后端：`MEETCLIP_TEST_PYTHON=… bash backend/tests/run-all.sh` 29 个测试文件全部 PASS；新增 `test_meeting_import.py` 9 项：单文件兼容且不成包、2 个视频（含 `.mkv`）自动成包且成员为 queued、默认卡包名、部分失败不成包、全部失败 400 + 逐条 results、重复路径只导入一次、单条入队失败不丢另一条、超过 20 条拒绝、手工 `/api/packs` 仍拒绝 active。
- `build/interaction-smoke.mjs` 通过：会议入口的 pick-file mock 返回两条路径，断言文件列表出现两个 `mc-file-item`、默认卡包名与提交按钮；点击提交后断言 `POST /api/meetings/import-batch` 收到 2 个文件、标题取文件名、`pack_title` 留空，并由 Panel 显示「已导入 2 个文件」toast。
- `build/render-smoke.mjs`、`node build/build-client.mjs`、`node --check client.js` 通过。

### 视觉

- `node build/build-meeting-preview.mjs && node build/meeting-preview-shot.mjs` 生成 `build/meeting-preview.png`（2 个文件批量态，深色）；`--light` 生成 `build/meeting-preview-light.png`，`--empty` 生成 `build/meeting-preview-empty.png`。两者核对文件行、视频/音频标签、卡包名称输入与按钮状态正常。

### 安装副本与运行态

- 同步前备份整包：`~/.dsh/meetclip/backups/dsh-meetclip-pre-meeting-batch-20261110-150030.tgz`。
- 已同步 `client.js`、`src/host/files.js`、`src/host/routes.js`、`backend/app/packs.py`、`backend/app/routes/meetings.py`、`backend/app/routes/sessions.py` 到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip`；工作区/安装副本 `client.js` SHA-256 一致（`0f792fb1…`）。
- 重启本地引擎（旧 pid 47237 → 65451）；`/api/health` 正常，`/openapi.json` 已包含 `POST /api/meetings/import-batch`。
- 对运行中的真实后端做只读/无效路径探测：`POST /api/meetings/import-batch` 使用不存在的文件返回 400、`results` 逐条给出「文件不存在或无法访问」；随后 `/api/home` 仍为 13 条记录、1 个既有卡包、`active=0`，没有写入测试记录。
- **Host 选择器改动需重启 DSH 才能生效**（`src/host/*` 在 DSH 进程内加载）；本地后端已重启，刷新 DSH 页面即可加载新 `client.js`。重启 DSH 后请人工点一次「＋ → 会议录音」，确认可多选且 `.mkv/.flv` 不再置灰。
- 多文件拖拽上传不依赖 Host 选择器，刷新页面即可使用；批量导入接口已在线。

### 限制

- 系统文件对话框无法用无头浏览器自动点击；多选与 `.mkv/.flv` 不再置灰需要重启 DSH 后人工点一次确认。
- 批量列表每条记录标题默认文件名，暂不支持逐条编辑；标题可在导入后改名。
- 卡包默认名按服务端本地时间生成；不做同名校验。

## 未发布：设置 → 关于回退到升级前的本地版本（2026-11-10）

### 自动化

- `node --test tests/*.test.mjs` **223/223** 通过。新增：
  - `update-host.test.mjs` 6 项：回退把本地 `.update-bak-0.9.0-…` 换回安装目录且当前版本另存为备份、回退后能指定 `0.9.1` 再切回（`restartDirection: rollback`）、两份备份中指定更旧的 `0.8.11`、残缺备份不列入且 `performRollback` 直接调用也先拒绝、交换后校验失败时把原版本和备份都还原、未知版本报可回退列表、源码目录拒绝回退。
  - `update-routes.test.mjs` 2 项：`POST { action: "rollback", version }` 透传版本并返回 `kind: rollback` 的任务；无备份时 409 `no-rollback`；未知 action 的 400 文案包含 `rollback`。
  - `update-client.test.mjs` 2 项：`rollbackCandidates` 去重/排除磁盘版本/丢弃非法行；`updateSummary` 渲染「回退失败」「已回退到 vX」「重启后回到这个版本」；构建产物包含回退控件与文案。
- 回退测试全部在临时目录里跑真实目录交换，没有访问网络；断言回退后 `package.json` 与 `src/host/routes.js` 来自旧备份，且被换下来的版本成为新的 `.update-bak-*`。

### 真实 profile 只读核对

- 用新的 `UpdateManager` 对 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip`（0.9.1）只读调用 `status()`：`rollback.canRollback = true`，`available` 为 `0.9.0`（`2026-11-10 13:54:08`）与 `0.8.11`（`2026-11-10 12:26:13`），`direction` 都是 `older`，与 `ls -d …update-bak-*` 的两个目录一致。
- 没有对真实安装执行回退（会替换正在运行的插件且需要重启 DSH）；交换逻辑由临时目录测试与预览截图覆盖。

### 界面

- `node build/build-about-preview.mjs` 后截图核对浅色与深色：
  - `build/about-preview-rollback-confirm.png`：「可回退版本」下拉显示 `v0.9.0 · 2026/11/9 14:46:56`，按钮「回退到 v0.9.0」，确认块写明「换回升级前保存在本地的 v0.9.0；当前版本也会另存为本地备份…不联网、不从 GitHub 下载」。
  - `build/about-preview-rollback-done.png`：摘要「已回退到 v0.9.0 · 重启 DeepSeek Harness 后生效」，进度卡「回退完成 100.0%」，按钮变成「切换回 v0.9.1」，并有「回退后的文件已就位」提示。
  - `build/about-preview-rollback-none.png`：没有备份时按钮置灰为「回退到升级前版本」，行内说明「只有应用内升级会自动保留升级前的版本」。

### 未执行

- 在真实 DSH 页面点一次回退并重启验证「重启后运行版本变成旧版本」；需要重启当前 DSH 会话，交由用户在安装副本同步后操作。

## 0.8.12 / 0.9.2：纪要时间轴按转写锚定（2026-11-10）

### 现象

- 记录 `70fd40a9ce77`（oppo ODC26 回放，`1:19:20`）的纪要时间轴第一个章节显示 `1:49:47`，比整条视频还长；章节下的要点却是 `1:09:47`。
- 同一条记录的 6 个章节只覆盖最后 9 分钟，前 70 分钟的发布会内容没有进纪要。

### 根因

- **模型算的秒数被直接采信**：提示词把转写行渲染成 `[L601 01:09:47 发言人] …`，模型要先把钟点换算成秒填进 `topics[].start`。这次它把 `1:09:47` 算成了 `6587`（1:49:47），`minutes_prompt.parse` 原样存库，时间轴、笔记、导出、卡片和 `meetclip_minutes` 全部照这个数渲染。
- **长记录终稿分窗只看最后一窗**：678 行按 `FINAL_WINDOW=300` 切成 3 窗，但只有第一窗的提示词带「当前纪要」，且最后一窗的回复会直接替换 `base`，前两窗的章节被丢掉——所以 79 分钟的视频只剩最后 9 分钟。
- **修好分窗后又暴露第三个问题**：模型会借「整份发回」把前几窗的主题重写一遍，重写后的要点没有证据行号，时间锚点整片丢失（82 条要点只剩 18 条能跳）；偶尔还会把 evidence 只写在主题上、要点里不写（只剩 40 条能跳）。

### 修复

- `minutes_prompt.topic_start`：主题起点必须落在媒体长度内，且不能晚于自己的第一条证据（容差 5 秒）；比第一条证据早 3 分钟以上也按证据重算。`parse` 与读兜底共用这一条规则。
- `minutes_prompt.sanitize_topics`：`engine.get()` 读出旧纪要时按证据重算起点（页面、笔记、导出、卡片、Agent 工具共用），`_run` 在直播增量落库前也会先修上一版；修出来的起点保持单调。
- 终稿分窗：`build(carry=True)` 把当前纪要发回模型，`merge_window` 以旧主题为准（保留上一窗带证据的版本，只追加本窗新主题）；分窗中任一窗没返回就不落残缺终稿，保留上一版。
- 跨窗接时间：要点带 6 位短 id（文本 sha1），改写后带回 id、文本相似度或主题起点对得上都能把 `t` / `support` 接回去；输出被 `max_tokens` 截断时预算 4096 → 8192 重试。
- 兜底回填 `backfill_point_times`：模型只把 evidence 写在主题上时，按文字相似度（≥0.3，限主题自己的时间范围）在本窗转写里补一个锚点。
- 提示词补一条：`start` 用转写时间换算、必须落在媒体长度内，拿不准就留空。

### 自动化验证

- `backend/tests/test_minutes.py`：34/34 通过（新增 18 项：起点越界/晚于证据/略早于证据/无证据回落、`sanitize_topics` 幂等与单调、孤证不硬拽、同名主题起点前移、要点改写/带 id 接回时间与依据数、`merge_window` 保留带锚点的旧主题与全局段落、分窗终稿保留前窗、`backfill_point_times`、截断重试、`get()` 修旧数据）。
- 后端全量：`tests/run-all.sh` 27 个测试文件全部 PASS。
- 前端：`node --test tests/*.test.mjs` 199/199 通过（本次未改客户端）。

### 真机验证（运行中的插件后端）

- 修复文件同步到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip/backend/app/`（`minutes.py`、`minutes_prompt.py`）并重启后端加载新代码（端口 8321）。
- 旧数据读兜底：`GET /api/sessions/70fd40a9ce77/minutes` 的 6 个章节起点由 `6587 / 6727 / 6787 / 6856 / 6946 / 7079` 修正为 `4187 / 4327.9 / 4389.3 / 4491.9 / 4572.4 / 4683.2`，全部落在 `covered=4760.5` 之内；笔记与之同步（版本 7 → 8），卡片随 `POST /api/cards/sync` 重建。
- 重新整理（真实 AI，3 窗）：内容覆盖整条视频，但锚点被模型重写掉，据此补了 `merge_window` 与 id 接时间；再整理一次后是 22 个章节、覆盖 `1:40–1:18:03`。
- 要点锚点回填（无 AI）：对最终一版跑 `backfill_point_times`，82 条要点中 77 条拿到时间（回填 37 条），笔记（版本 12）与卡片同步刷新；`cover` 与章节起点都保持不变。

### 限制

- 旧纪要只修时间、不补内容：被丢掉的章节要重新整理一次才会回来（消耗一次 AI 配额）。
- 回填按文字相似度工作，改写幅度特别大的要点仍可能没有锚点（本次 82 条中 5 条）。

## 未发布：首页卡包（2026-11-10）

### 改动

- 散落画布空白右键新增「新建卡包」；拖一张卡到另一张卡中央，160ms 上膛后松手叠成新卡包，默认名 `卡包 N`。上膛前松手仍是普通重排，Esc/pointercancel 取消。
- 卡包是画布上的一张顶层卡（272×208），成员从墙面收起，卡包继续参与现有 `buildLayout` 避让；外壳叠放真实成员卡。热区只保留无边框的灰色呼吸光晕 + “停一下/松手”胶囊提示，不随画布缩放；黑色虚线/实线已删除。
- 卡包浮层用墙面原卡片按信息流三列平铺，按住任意卡片即可整卡拖动排序，指针上半/下半分别在上/下卡片间隙显示「插入到这里」，松手插到两张卡之间并回写 `PATCH /api/packs/{id}/members`；支持打开成员、移出、改名、解散；合并/加入/新建后 5 秒撤销。图钉卡和进行中的记录不能收纳；一张卡只属于一个卡包，最多 60 张。
- 新增 `card_packs` / `card_pack_members` 表、`backend/app/packs.py`、`routes/packs.py` 与 `/api/packs`；`/api/home` 增加 hydrate 后的 `packs`。成员删除后读取自动跳过；位置仍用本机 `meetclip.scatter.layout.v2`。
- 散落与信息流都折叠卡包；筛选下任一成员匹配就显示整包，空卡包始终可见。

### 卡片 @ 与右键提问（2026-11-10 二轮）

- **所有首页卡片物化成 @ 卡片**：卡包在 `会摘卡片/卡包/<标题>.md`，便利签/标记/图片/批次分别在 `便利签/`、`标记/`、`图片/`、`批次/`；卡包卡片包含标题、成员类型、成员标题、`session_id` / 文档链接 / 时间点，并提示 Agent 继续用 `meetclip_*` 读取成员详情。`GET /api/cards` 统一返回记录、文档、卡包和这些辅助卡片。
- **右键提问**：记录、卡包、批次、便利签、标记、图片、飞书文档的右键菜单都加了「基于此卡片/卡包提问」。动作先 `POST /api/cards/sync` 落盘，再按精确 id 调 `GET /api/cards?id=...`，随后 `openCardAgentDraft` 新建 Agent 会话；用 `conversation.input.shell(id).setDraft({text,references})` 放入**结构化 @ 引用**，不自动发送。缺少 `conversation` 输入模型时退回工作区 `startSession` 的纯文本 @ 草稿。
- 卡片文件按标题命名（同名追加 ` (2)` 等序号），发送后消息里的文件引用也会显示可读标题，不再显示哈希 id；卡包改名后文件名随标题变化，旧标题文件由同步清理。辅助卡片目录只清理带「本文件由会摘自动生成」标记的旧文件，不碰用户手工放进去的文件。

### 自动化验证

- 前端：`node --test tests/*.test.mjs` 241/241 通过（新增卡包候选、Agent structured draft、OpenDraft、卡包排序纯函数、卡包布局/样式断言）。
- 整卡拖动：`build/scatter-preview` 内注入 pointerdown/pointermove/pointerup，验证按住卡片本体即可拖起；指针在上半时插入线在目标卡上方、在下半时在下方，位置与真实卡片间隙一致，松手后按前/后插入并发出 `PATCH /api/packs/{pack}/members`；截图 `build/pack-reorder-preview.png`。
- `build/build-client.mjs`、`node --check client.js`、`build/render-smoke.mjs` 通过；`build/interaction-smoke.mjs` 通过，覆盖空白右键建包、160ms 上膛（未满 160ms 仍重排）、拖卡入包、拖卡叠包、全卡片浮层与整卡拖动、右键「基于此卡片/卡包提问」、结构化 @ 草稿、筛选、浮层改名、撤销、解散。
- 后端：`backend/tests/run-all.sh` 29 个测试文件全部 PASS；`test_packs.py` 7 项，`test_cards.py` 8 项（新增卡包/便利签/标记/图片/批次文件生成、`id` 精确取卡）。`test_home.py` 仍通过。
- 视觉：`node build/build-scatter-preview.mjs` + 无头 Chrome 生成 `build/pack-preview.png`、`build/pack-hotzone-preview.png`、`build/pack-overlay-preview.png`，核对真实卡叠层、灰色光晕/提示与全卡片信息流；浅色/深色均检查。

### 安装副本与运行态

- 改动前整包备份：`~/.dsh/meetclip/backups/dsh-meetclip-pre-pack-20261110-134604.tgz`。
- 同步文件：`client.js`、`backend/app/database.py`、`main.py`、`packs.py`、`routes/packs.py`、`routes/sessions.py` 到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip`；`client.js` SHA-256 工作区/安装副本一致（`9436710d…`）。
- 安装副本先用临时数据目录在 8399 端口独立启动：`/api/health` 200、`/api/home` 的 `packs` 初始为 `[]`、`POST /api/packs` 创建空包后再取 home 能看到 1 个卡包。
- 随后重启真实引擎（旧 pid 15849 → 新 pid 27500），`/api/home` 已返回 `packs: []`，真实资料库 `zhibo.db` 已创建 `card_packs` / `card_pack_members` 两张空表，`stats.active=0`。客户端刷新 DSH 页面后加载新 `client.js`。
- **2026-11-10 13:54 应用内更新把安装副本替换成 0.9.1，卡包代码被覆盖**。核对发现 0.9.1 的 `client.js` / `database.py` / `main.py` / `routes/sessions.py` 与更新前 0.9.0 基线逐字节一致（只差 package/发布元数据），且更新器保留了 `dsh-meetclip.update-bak-0.9.0-20261110-135408-48172`。因此只从该备份恢复 `client.js`、`packs.py`、`database.py`、`main.py`、`routes/packs.py`、`routes/sessions.py`，保留 0.9.1 的发布元数据与许可文件；恢复前当前 0.9.1 快照在 `~/.dsh/meetclip/backups/dsh-meetclip-pre-restore-20261110-135658.tgz`。
- 恢复后重启真实引擎（pid 27500 → 32818），`/api/home` 立即返回用户更新前创建的卡包 `pack-mwa9vmrl-ab3gz6`（`卡包 1`，3 名成员：两条记录 + 一篇飞书文档），`/api/packs/{id}` 可读；说明卡包数据一直在 SQLite 里，回退的只是应用代码。安装副本 `client.js` 与工作区再次一致（`9436710d…`），版本号仍为 0.9.1。
- **二轮 UI/性能同步**：2026-11-10 14:27 将新 `client.js`（SHA-256 `964bdb82…`）、`backend/app/database.py`、`packs.py`、`routes/packs.py`、`main.py`、`routes/sessions.py` 同步到安装副本，保留 0.9.1 的 `package.json` 与许可文件；同步前整包快照 `~/.dsh/meetclip/backups/dsh-meetclip-pre-pack-ui2-20261110-142705.tgz`。
- 重启真实引擎（pid 32818 → 47237），`/openapi.json` 已包含 `PATCH /api/packs/{pack_id}/members`；对不存在卡包调用返回 404（而不是 405），确认排序路由已加载。`/api/home`、`/api/health` 正常。
- 15:15 用户在当前资料库新建 `miloco 3.0相关讨论`（4 张：`miloco 3.0第一次沟通`、飞书 wiki `Miloco A2 3D空间地图`、`IMG_1302`、`IMG_1301`）；同步后生成 `会摘卡片/卡包/miloco 3.0相关讨论.md`（约 4 个成员、`MEMBER_TYPE_LABELS` 显示为「卡包」）。`GET /api/cards?q=miloco` 返回该卡包、文档和记录三条，`GET /api/cards?id=pack%3A81a26c275e57` 精确命中。此前 `pack-mwa9vmrl-ab3gz6` 的删除属于 13:57 的历史操作，不影响这次新包。

### 卡片 @ 与提问同步

- 同步文件：`client.js`（SHA-256 `ead0a479…`）、`index.js`（`397130c2…`，系统提示补充卡包/辅助卡片说明）、`backend/app/cards.py`（`c8291617…`，标题命名）、`backend/app/routes/cards.py`（`e474f372…`）；同步前整包快照 `~/.dsh/meetclip/backups/dsh-meetclip-pre-card-ask-20261110-154001.tgz`。
- 后端正 pid `91219`（本次只改前端，未重启）；`POST /api/cards/sync` 返回 `aux.ok=true`，真实库把卡包卡片改为 `会摘卡片/卡包/miloco 3.0相关讨论.md`，旧哈希文件被清理；`/api/cards?id=pack%3A81a26c275e57` 返回新路径。`/api/health` 正常。

### 限制

- 卡包位置只在本机浏览器保存，不跨设备同步（内容随资料库持久化）。
- v1 不支持包中包、多选批量入包、从浮层直接拖出；移出用浮层按钮。排序通过浮层按住任意卡片拖动，墙面卡包本身不直接拖成员。
- 触屏/键盘目前没有“新建卡包”的等价入口；桌面右键与拖拽是主路径。
- 图片卡只生成含路径/尺寸的 Markdown，不附图片字节；需要视觉分析时请把图片作为附件发送。
- 右键提问会新开一个 Agent 会话（不并入当前会话），并在输入框预置引用；不会自动发送。
- 超出首页 60 条、文档 12 条等窗口的成员移出后遵循首页现有窗口，不会强行塞回墙面。

## 0.8.9：首页「＋」三入口菜单 + Agent 对话框（2026-11-09）

### 改动

- Hero `＋` 改为发布会直播 / 视频链接 / 会议录音三入口菜单；点击 `＋` 不再直接弹系统文件选择器，会议录音入口才走 `pickFile`。
- Hero 输入框改为 Agent 对话框：回车经 `sessions.create → session.prompt → uiWorkspace.openSession` 把原文发到当前资料空间的会摘工作区，并跳转到新会话。
- Hero 移除链接自动识别与内联搜索；顶栏恢复搜索入口，`⌘K` 保留。

### 自动化验证

- `node --test tests/*.test.mjs`：159/159 通过；新增 `tests/agent.test.mjs` 7 项（已注册/未注册工作区、registry 不可用、prompt 被拒、缺服务/缺路径、retain 兜底、bridge 安装清理与 trim）。
- `node build/interaction-smoke.mjs`：通过；新增断言——`＋` 只弹三入口菜单、选会议录音才出现会议面板、顶栏搜索打开全局搜索、Hero 回车触发假 `sessions.create/using/prompt/openSession`、失败保留文字且不打开会话。
- `node build/build-client.mjs`：`client.js` 重建成功。

### 真机验证（headless Chrome + 运行中的 DSH）

- 通过 DSH 桌面端的 `dsh-auth` cookie 打开 `http://127.0.0.1:50358`，确认服务端已返回新 `client.js`。
- 会摘首页 `＋` 弹出三项菜单（发布会直播 / 视频链接 / 会议录音），`aria-expanded` 与关闭行为正常；「视频链接」打开行内视频表单并可关闭。
- 输入「你好，界面联调测试，请只回复「收到」。」回车：主视图切到「会摘资料」下的新会话，原文出现在对话中，Agent 回复「收到」；测试会话已归档。

### 打包与部署

- 分享包：`dist/dsh-meetclip-0.8.9.tgz`（688 KB）、`dist/MeetClip-0.8.9-installer.zip`（1.4 MB，含 tgz、解包目录、INSTALL.md 与 SHA256SUMS）。
- 校验：tgz `13ea4e65419538d492f4c8d2aad76fbf62ae211a817a37d0cf53890fd4923357`；installer zip `942b7cb54d8871c70cdbb0ba3dc86a52c99ded032131f82f7dd1c6eeb6cd686d`。
- `client.js` 已同步到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip`，旧文件备份为 `client.js.bak-20261109-183550`；刷新页面后加载新 bundle。

## 0.8.8：纪要高亮不显示 + 去掉面向用户的互动提示（2026-11-09）

### 现象

- 用户选中纪要文字并高亮后，工具条出现"高亮 2 处"，但结构化视图里文字没有任何高亮。
- 工具条 / 提示行出现"会摘助手可见"，这是给 Agent 的说明，不该显示给用户。

### 根因

- `minutes_interactions._clean` 对高亮片段做了 `NFKC` 归一化。NFKC 会把全角 `，` `：` `＋` 折成 `,` `:` `+`，存进库的片段和界面原文不再逐字相等；`highlightSpans` 用 `indexOf` 定位时一条也匹配不上，所以 mark 不出现。
- 真实数据确认：`5abae5923eae` 存的是 `…合作方式,先建立…`，界面原文是 `…合作方式，先建立…`。

### 修复

- 后端高亮片段改为原样保存（只折叠空白），`todo_key` 的 NFKC 保持不变。
- 客户端定位增加逐字 NFKC 映射兜底：精确匹配失败后，用规范化后的文本搜索再把下标映射回原文；已经存坏的老高亮也能直接渲染，无需重新高亮。
- 移除工具条上的互动计数/提示，以及 `interactionNote` 文案；互动持久化、笔记同步、卡片与工具输出保持不变。

### 自动化验证

- `node --test tests/*.test.mjs` 152/152；新增"半角标点匹配全角原文""带上下文的全角标点定位"两个用例。
- `node build/interaction-smoke.mjs`：待办勾选/取消仍写回，且界面不再出现"会摘助手可见"。
- `node build/seek-e2e.mjs`（真 Chrome + 真后端）：`5abae5923eae` 纪要页 `mark.mc-hl` 数量 1（两条重复高亮合并），证明库里已存坏的高亮已恢复显示；假直播会话的待办/右键高亮仍通过，`noAgentTrace=true`。
- 后端 `test_minutes_interactions` 11 项通过，新增"全角标点原样保存"。

### 部署

- `client.js`、`package.json`、`README.md` 已同步到安装副本；后端改动需重启本地引擎生效（或由客户端兜底先行显示）。


## 批次连续添加与续排（2026-11-09）

- 用户反馈：批量加入队列以后，不能再次批量加入队列，也不能在原有批次卡里批量加入新链接。
- 实现：
  - `backend/app/routes/link_videos.py`：`POST /api/link-videos/batch` 新增可选 `batch_id`；存在时把新记录续排到该批次（`meta.batch.index` 从已有最大 index+1 开始，`total`/`updated_at` 更新，标题与创建时间不变），单条也可续排；未知批次 404「批次不存在或已删除」，不会创建孤儿记录。
  - `backend/app/database.py`：批次聚合抽出 `_link_batch_groups()` + `get_link_batch()`；列表用 `updated_at` 排序（没有追加时等同 `created_at`），对外批次对象新增 `updated_at`，内部 `last_index` 不外泄。
  - `client-src/components/NewCaptureDialog.jsx`：批量表单提交后不关闭；已加入的行从输入框移除，失败/重复行保留；结果汇总「已加入 N 条 · 继续粘贴链接可再加入一批」；点「完成」才关闭并把最近一批交给上层定位。单条链接仍保持提交即打开记录。
  - 全部重复/失败时后端 400 的 `results` 不再被吞成 HTTP 400：前端按行展示原因，并提供「仍然加入重复链接」（`allow_duplicate=true` 重提重复行）。
  - `client-src/components/home/BatchOverlay.jsx`：批次浮层新增「批量加入新链接」，在浮层内直接复用视频表单；`onSubmitted` 刷新首页批次数据，完成后回到成员列表。`HomePage` 的批次卡右键菜单增加「加入新链接」，打开浮层即进入追加态；追加后浮层显示「更新 …」。
  - `client-src/lib/api.js`：`addLinks(items, { batchId })`，只在有值时发 `batch_id`。
- 后端验证：`MEETCLIP_TEST_PYTHON=~/.dsh/meetclip/venv/bin/python bash backend/tests/run-all.sh` **26/26 个文件通过**；其中 `test_link_video.py` **50/50**（新增：续排序号 0..4、total 4/5、单条续排、未知批次 404 且不建记录）、`test_home.py` **15/15**（新增：追加后的 `updated_at` 排序、`last_index` 不出现在 API）。
- 前端验证：`node build/build-client.mjs`、`node --check client.js`、`node --test tests/*.test.mjs` **147/147**、`node build/render-smoke.mjs` 通过；`node build/interaction-smoke.mjs` 新增断言并通过——批量提交后表单仍打开、输入框清空、继续提交第二批；全部重复时逐行展示并可确认仍加入；批次浮层请求带 `batch_id`、完成后成员从 2 条刷新为 4 条；右键「加入新链接」进入追加表单。
- 安装副本：`client.js`、`backend/app/database.py`、`backend/app/routes/link_videos.py` 已同步到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip`（旧文件备份后缀 `.bak-20261109-170952`）；旧引擎 pid 39709 停止，新引擎 pid 85281 从安装副本的 `backend/` 启动，`/api/health` 为 200、`/api/home` 为 200，带未知 `batch_id` 的批量请求返回 404「批次不存在或已删除」。当前打开中的 DSH 页面需要刷新一次才会加载新的 `client.js`。
- 未在本机验证：真实平台的追加下载（只覆盖入队/批次聚合）；真机上仍建议先在一个已完成批次里追加 1–2 条，确认 yt-dlp 下载与进度刷新符合预期。

## 多资料空间（工作与生活分开）（2026-11-09）

- 目标：一份目录一份空间，工作与生活的内容、卡片、日历账号、DSH 工作区彻底分开；顶部一处切换，首页与资料库同时生效；`@` 卡片永远跟着激活空间。
- 实现：`src/host/libraries.js`（注册表、身份标记、校验、共享目录）+ `runtime.js` 的 `createLibrary/renameLibrary/forgetLibrary/activateLibrary`，`routes.js` 七个 `/meetclip/app/libraries*` 路由；后端 `backend/app/shared_paths.py` + `settings.py`/`bilibili.py`/`douyin.py` 三处路径改指共享目录（`MEETCLIP_SHARED_DIR` 缺失时行为不变）；客户端 `LibrarySwitcher`（顶部右侧胶囊）、`LibraryPanel`（列表/新建/共享）、`SettingsLibraries`（新标签）、`lib/libraries.js`（纯逻辑）、`libraries.css`（独立样式文件）。
- 兼容：`/app/data-dir`、`/app/prefs` 的错误码与回包字段未变；`prefs.json` 保留 `dataDir` 镜像并先备份 `prefs.json.bak-v1`。
- **Host/客户端测试**：`node --test tests/*.test.mjs` **135/135** 通过，其中新增 `tests/libraries.test.mjs`（13 项：旧 prefs 迁移与备份、身份标记跨目录、危险目标拒绝、重名加序号、移除不删盘、busy 拦截与「先 stop 再停引擎」的调用顺序、引擎起不来时回滚、外部托管拒绝、目录缺失报错、共享目录只复制一次、建第二个空间自动启用共享、`data-dir`/`prefs` 兼容路由、`/libraries` 列表/预检/创建/改名/404）与 `tests/libraries-client.test.mjs`（7 项纯逻辑）。
- **后端**：`python -m tests.test_shared_paths` 3/3（共享目录落点、未设置时回落 `DATA_DIR`、设置在共享目录里往返读写）。
- **UI**：`node build/interaction-smoke.mjs` 通过，新增断言——顶部切换器显示当前空间、点开出「切换资料空间/工作/生活/新建资料空间/管理资料空间」、设置→资料空间标签含「正在使用/新建资料空间/账号与通用设置/共享目录路径」；`node build/render-smoke.mjs` 三个 slot 正常渲染。
- **端到端（真引擎）**：新增 `build/libraries-e2e.mjs`，临时 stateDir + 两个临时空间 + 随机端口，**22/22 通过**：引擎启动绑定第一个空间、新建并切到第二个空间后 `/api/health` 的 `data_dir` 已变、新空间生成自己的 `zhibo.db` 与 `.api-token`、共享目录在第二个空间时自动就绪、`prefs.json` 记录两个空间且 `dataDir` 镜像激活空间、`prefs.json.bak-v1` 存在；在「生活」里新建一条记录后切回「工作」列表为 0 条、再切回「生活」记录仍在（**库间数据确实隔离**）。
- **视觉**：新增 `build/libraries-preview.{jsx,js,mjs,html}` 与截图 `build/libraries-preview.png`（深色）、`build/libraries-preview-light.png`（浅色）；确认切换菜单能盖住页面内容（`.mc-root > *` 的 `z-index:1` 会让后来的兄弟压住下拉，故给 `.mc-topbar` 提层，选择器与宿主那条等长以压过其优先级）、路径不再因 RTL 被翻转、深浅色对比度可读。
- **排版第二轮（用户截图反馈后）**：
  - 弹层里「资料空间」标题重复了两次 → 弹层改用 `variant="dialog"`，标题只由弹层标题栏出；设置页的小节标题移回卡片**上方**，与「采集/模型」等页一致。
  - 空态/错误态原来只剩一排按钮和 404 原文 → 新增 `mc-lib-empty`（无空间 / 宿主未加载两种），工具栏在空态时只留「刷新」，主按钮交给空态块，避免两个「＋新建」并排。
  - `HTTP 404` 原文直出改为 `libraryLoadErrorText()`：404/501 → 「宿主还没加载多资料空间：重启 DeepSeek Harness，或用最新的 dsh-meetclip 插件包重新安装会摘」（这正是「客户端已换新版、宿主仍 0.8.5」的症状）；503 → 引擎没起来。
  - 行内动作分级：`切换` 只给非激活行（实心），激活行用「正在使用」徽标代替禁用按钮；`改名 / 加入工作区` 为次级文字按钮，`移除` 用 quiet 样式（悬停才变红），激活行的「移除」保持禁用。
  - 间距与字号：路径/条数 11px 三级色、说明 11.5px、卡片内脚注 `margin-top:10px`；「存储位置与搬家」从一张只放一段话的卡片改成一行脚注；共享目录卡改成「标题+徽标 / 路径 / 说明 / 右侧按钮」的行式布局。
  - 复核：`node --test tests/*.test.mjs` **147/147**、`interaction-smoke` / `render-smoke` 通过、`node build/libraries-e2e.mjs` **22/22**；预览截图重拍（深浅两套，含弹层、空态、宿主未加载态）。
- **设置页间距统一（用户截图反馈：按钮与备注文字贴太紧）**：
  - 根因：宿主样式里 `.mc-actions`（margin-top 10px）、`.mc-foot-meta`（无 margin）、`.mc-card-hint`（8px）、`.mc-form-note`（6px）各自带值，叠在同一张卡片里时「按钮 → 说明」实际是 0–10px 不等。
  - 做法：新增 `client-src/settings-spacing.css`，把设置页卡片改为 flex 列 + `gap:14px`，卡片内子块 `margin:0`，间距只由一套数值决定：小节之间 22px、标题↔卡片 10px、卡片内块 14px、按钮横排 8px；说明文字统一 12px/1.65 次级色；窄屏（≤640px）降为 12px/6px。作用域 `.mc-settings-shell` / `.mc-settings-panel` / `.mc-lib-card`，不影响首页、资料库与弹窗。
  - 量测（无头 Chrome `getComputedStyle`，预览里写进隐藏节点 `#mc-metrics`）：`panel-gap=22px · section-gap=10px · card-gap=14px · actions-gap=8px · actions-margin=0px · note-margin=0px · note-size=12px · card-padding=14px 16px`。
  - 顺带：设置里不再出现裸 `HTTP404` / `HTTP405`——`libraryLoadErrorText()` 把 404/**405**/501 变成「宿主还没加载多资料空间：重启 DeepSeek Harness，或用最新的插件包重新安装『会摘』」，`SettingsLibraries` 对带状态的失败不再把原文写进错误行。
  - 复核：`node --test tests/*.test.mjs` **147/147**、`interaction-smoke` / `render-smoke` 通过；`build/settings-preview{,-light}.png`、`build/libraries-preview{,-light}.png` 重拍。
- **未在本机验证（需要真实操作）**：真机上从「工作」切到「生活」的整链路（会停/重启真实引擎、动 `~/.dsh/meetclip/prefs.json`，实施期间另一个会话正在用真实引擎跑直播/跳转 e2e，故全部用临时 stateDir + 临时库目录 + 假引擎 `backend` 验证）；切换时对真实 B 站直播的收尾（`/stop` 后媒体落盘）也只验证了调用顺序与轮询逻辑。

## 录制的停止按钮改为红色（2026-11-09，0.8.5）

- 需求：采集中/内录中的「停止」要更显眼，但整体设计不能跳脱。
- 实现：新增 `.mc-button[data-variant='stop']`（`client-src/styles.css`）——背景用 `--dsw-alias-state-error-primary`，文字用 `--dsw-alias-bg-base`（与 primary 一样做明暗反转，深色主题是深字、浅色主题是浅字），`font-weight: 600`；hover 用 `color-mix(错误色 88%, label-primary)`，浅色主题变深、深色主题变亮；`:focus-visible` 换成错误色描边；`:disabled` 复用 primary 的灰底可读样式。高度/圆角/字号沿用 `.mc-button-small`（24px / 8px / 11px），不新增硬编码色值。
- 落地位置：`SessionDetail` 头部「停止」（`data-variant="stop"`），以及它的停止确认弹层（`confirm.danger` → 确认键也变红）；`ScreenCaptureDialog` 的「停止并保存」（内录）同步改成红色。
- 验证：`node build/live-player-e2e.mjs` **14/14**，其中新增断言——深色主题下停止按钮计算样式为 `rgb(255,107,100)`、文字 `rgb(21,21,23)`、高 24px；确认弹层的确认键同为红色；浅色主题下为 `rgb(210,75,69)`、`rgb(247,246,243)`，且与同排无 variant 的小按钮等高（24px）、圆角 8px。
- `node --test`：客户端相关用例 43/43 通过（`style` / `transcript` / `minutes-view` / `cards` / `links` / `paste`）；`render-smoke`、`interaction-smoke` 通过。另：同一时间另一会话正在新增「资料空间」 Host 功能（`src/host/libraries.js`、`tests/libraries.test.mjs`），其 8 个测试失败与本次改动无关，未改动那部分代码。
- 截图：`build/live-player-playing.png`（深色）、`build/live-player-stop-confirm.png`（确认弹层）、`build/live-player-light.png`（浅色）。
- 未在本机验证：`ScreenCaptureDialog` 的「停止并保存」只改了 variant，没有真机跑内录流程（需要屏幕录制授权）。

## 直播自动播放 + 时间戳可跳（2026-11-09，0.8.5）

### 用户反馈

- 发布会直播：输入链接开始采集后，画面是黑的，视频不会自己播；手动点播放有时点不开。
- 转写时间轴和视频时间轴对不上，点时间戳跳不过去。

### 根因（两件事是同一个原因）

- `MediaPane` 用 `document.createElement('video').canPlayType('application/vnd.apple.mpegurl')` 判断能否原生播 HLS。Chromium（实测 HeadlessChrome/156，DSH 内置 Electron 44 / Chromium 152 同级）对它返回 `"maybe"`，旧代码据此走原生 `<video src="…m3u8">`，根本不加载 hls.js。
- Chromium 实际放不了 MPEG-TS 分片：元素停在黑屏，`play()` 静默失败（旧代码 `.catch(() => {})` 吞掉），`currentTime` 也动不了，所以点时间戳看起来"时间轴对不上/跳不动"。
- 另外旧代码在 HLS 出现任一致命错误时就把播放器换成静态预览图，`hlsError` 之后永不恢复；首个分片生成前（B 站常见数秒）整块区域是空的。
- 用真 Chrome 直接喂后端录下的 HLS 播放列表可正常播放、可回拖 seek，证明 hls.js 路径本身没问题。

### 修改

- `client-src/components/SessionDetail.jsx`
  - 有 `MediaSource` 一律走 hls.js（`Hls.isSupported()`），只有没有 MSE 的 Safari/iOS 才用原生 HLS；`src` 只在原生模式下设置。
  - 播放器挂上后自动 `play()`；`NotAllowedError` 时静音重试、显示「已静音播放 · 点击开启声音」，用户首次在 `.mc-root` 内点击时自动取消静音。
  - 画面可点按播放/暂停，暂停显示居中播放标记；`waiting/stalled/seeking` 显示转圈；网络/媒体致命错误按 600ms×n（上限 6s）重连 12 次，再给错误提示与「重试」（原生模式重新 `load()`）。
  - 直播进度条改读 `seekable`：`duration` 为 Infinity 时也能拖动；首个分片前显示「正在连接直播流…」（有 `preview.jpg` 时垫在背后），回放文件生成中显示「回放文件生成中…」。
  - 时间戳跳转：播放器不存在/元数据未就绪时记住目标并每 300ms 轮询补跳；采集中的记录在还没 `live_hls_path` 时不再误报「没有可播放的媒体文件」。
- `client-src/lib/i18n.js`、`client-src/styles.css`：新增直播连接/重连/静音/重试文案与 `.mc-media-stage`、`.mc-media-waiting`、`.mc-media-unmute`、`.mc-media-overlay` 等样式；全屏时 `.mc-media-stage` 撑满，播放条仍在。

### 自动化验证

- 新增 `node build/live-player-e2e.mjs`（真 Chrome + 真 HLS：ffmpeg `-c copy`、2 秒分片、event playlist、`-itsoffset 1.417` 复刻真实时间戳起点，假后端只提供详情）：**10/10 通过**。
  - 无手势：`paused=false, muted=true`，出现「开启声音」按钮（静音兜底能出画面）。
  - 真实点击（CDP `Input.dispatchMouseEvent`）后：`paused=false, muted=false`（有声自动播放）。
  - 详情先不含 `live_hls_path`、6 秒后才出现：先显示「正在连接直播流…」，此时点 00:06 不报「没有媒体文件」；播放器出现后自动补跳到 `currentTime≈6.02`。
  - 播放中（>12s）点转写 00:06：`currentTime=6.00`，播放条同步显示 `00:06 · LIVE`，且继续播放（`currentTime - 6 ≈ 点击后经过的秒数`，误差 <1.8s）。
  - 全屏后视频高度 500px、播放条仍在。
- `node build/build-client.mjs`、`node --check client.js` 通过；`node --test tests/*.test.mjs` **113/113**；`render-smoke`、`interaction-smoke` 通过。
- 补跳轮询加了 20 秒上限（播放器一直不出现时不空转，下次详情刷新再试）。
- `client.js` 已同步安装副本 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip/client.js`，md5 `f5c78f90bf47a47502cd44032a0cd555`（原文件备份为 `client.js.bak-<时间戳>`）；Host 与后端本次无改动，刷新 DSH 页面即可生效。
- 截图：`build/live-player-playing.png`（播放中）、`build/live-player-muted.png`（静音兜底胶囊）、`build/live-player-waiting.png`（连接中）。

### 未在本机验证

- 真实 B 站直播的端到端（本机 HLS 首分片延迟、平台 CDN 抖动）需要用户在界面里再开一场发布会直播确认；自动播放会把「有声」作为首选，若系统/浏览器策略更严会落到静音 + 胶囊。
- Safari 原生 HLS 分支（无 MSE 的环境）只做了代码路径保留，没有真机验证。

## 0.8.5：时间戳跳转 + 纪要互动留痕（2026-11-09）

### 问题与根因

- 纪要页点时间锚点没有反应：`SessionDetail` 只在 `tab === 'content'` 时渲染 `MediaPane`，切到纪要页会把 `<audio>/<video>` 卸载，`mediaRef.current` 为 null，`seek()` 静默返回。
- 转写页的跳转在媒体未就绪 / HLS `duration=Infinity` / 时间点在可回放窗口外时也会静默失败；`focus` 的补跳条件要求 `Number.isFinite(media.duration)`，HLS 直播永远不满足。
- 纪要里的待办、高亮都只是只读展示，没有可持久化的用户状态。

### 修复

- 内容页与纪要页共用同一个 `MediaPane`（切换标签不卸载），纪要页收成 `.mc-media.is-compact` 迷你播放条；`applyMediaSeek` 统一处理元数据等待、seekable 边界钳制与提示，`seek()` 在播放器未挂载时把目标放进 `pendingSeek`。
- 新增 `session_minutes_interactions` 表、`minutes_interactions.py`、`GET/PUT/DELETE /api/sessions/{sid}/minutes/interactions`；`minutes.engine.get()` 附带 `interactions`。
- 结构化纪要：待办按钮化（`role=checkbox`，划掉）、选中文字右键「高亮所选」/点高亮取消；高亮按片段 + 上下文渲染 `<mark>`。
- 留痕链路：互动 PUT 后同步笔记里的纪要段落（`- [x]`、`## 我高亮的内容`）；复制/导出/卡片/`meetclip_minutes`（`todos[].done`、`user_interactions`）使用同一份状态；重新生成纪要保留互动，删除纪要清空。

### 自动化验证

- `node build/build-client.mjs`、`node --check client.js`、`node build/render-smoke.mjs`、`node build/interaction-smoke.mjs` 通过；冒烟新增：已存高亮渲染为 `mark.mc-hl`、待办按钮勾选写回 PUT、取消勾选清空、互动 trace 文案。
- `node --test tests/*.test.mjs` 115/115；新增 `tests/minutes-interactions.test.mjs`（key 归一化、上下文定位、重叠高亮）与 `tests/minutes-tool.test.mjs`（`meetclip_minutes` 输出 `todos[].done` / `user_interactions`，缺字段时安全降级）。
- 后端 `bash backend/tests/run-all.sh` 全部 PASS（含新增 `test_minutes_interactions` 10 项：PUT/GET、笔记同步、投影、重生成保留、取消勾选、删除清空、卡片）。
- 真 Chrome + 真后端 + 真媒体 `node build/seek-e2e.mjs`：
  - 会议录音 `3eb2a111bb6e`：转写 05:02 → 303.48s（+1.5s 播放余量），纪要最远锚点 1:22:59 → 4979.85s，切换标签前后是同一个媒体元素。
  - 链接视频 `dfb8229ad18f`：转写 05:00 → 301.37s，纪要页媒体保持挂载、迷你条出现。
  - 假直播 HLS：转写 00:08 → 8.62s，纪要 02:00 → 120.83s；待办勾选 `checked=true/stored=true`；右键菜单出现「高亮所选」，点击后 `mark.mc-hl` 出现且服务端已存。

### 安装副本

- 已把 0.8.5 的 `client.js`、`src/host/`、`backend/`、`package.json` 等同步到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip`（同步前整包备份到 `~/.dsh/meetclip/backups/`），并重启本地引擎；`/api/sessions/{sid}/minutes/interactions` 与 `/minutes` 的 `interactions` 字段已实测可读。
- 刷新 DSH 页面加载新 `client.js`；Host 进程里的 `boundedMinutes`（新增 `user_interactions`）要等 DSH 整体重启后生效，在此之前 Agent 仍可从笔记里的 `- [x]` /「我高亮的内容」看到留痕。

### 未在本机验证

- 真实 GUI 里纪要页迷你播放条的视觉观感（需要在 54969 页面刷新后目测）。
- 真实直播采集中旧时间点被滑出窗口时的提示文案；用假 HLS EVENT 播放列表覆盖了正常跳转。


## 打开记录统一进资料库（2026-11-06，未发布）

### 行为

- 首页信息流/散落卡片、金句卡、右键「打开记录」、「N 条正在进行」、批次浮层成员、⌘K / 首页搜索、新建采集后自动打开：全部改为切到顶部「资料库」并选中该条记录，右侧直接显示详情；金句卡继续带时间点 seek。
- 资料库收到一次性 `focus`（`id` / `title` / `kind` / `time` / `nonce`）：选中该行、必要时把类型筛选放宽到「全部」、数据到位后滚动到该行，然后消费掉 focus，避免之后在列表里换记录时旧时间点被再次 seek。
- 删除记录聚焦浮层（`client-src/components/home/FocusOverlay.jsx`、`.mc-focus-layer` 样式、`pasteBusy` 里的浮层选择器）；返回首页用顶部导航。

### 自动化验证

- `node build/build-client.mjs`、`node --check client.js`、`node build/render-smoke.mjs` 通过。
- `node build/interaction-smoke.mjs` 通过；断言更新为：散落/信息流点击后出现 `.mc-workspace` 且目标行 `data-active`；被「会议」筛选挡住时打开直播记录会自动回「全部」；批次成员点击进入资料库；Hero「N 条正在进行」进入资料库并选中正确记录。
- `node --test tests/*.test.mjs` 99/99。
- `node build/build-scatter-preview.mjs && node build/scatter-click-smoke.mjs`：4/4 通过（单击/抖动打开、拖动不打开）。
- 真实 Chrome（headless）核对 `build/scatter-preview.html`：散落与信息流点开记录后 `.mc-workspace` 出现、顶部「资料库」高亮、左列选中行与右栏标题一致；信息流滚到底部点「周末读书会」时，左列 `scrollTop=144`，选中行仍在可视区（深列表滚动定位生效）。
- 顺手修掉交互冒烟里三条因「纪要结构化视图」改版而过期的断言：不再期待原始块 H1「会议纪要」、seek 锚点改为 `.mc-minutes-time`、编辑入口改为工具条「编辑原文」。

### 安装副本

- `client.js` 已同步到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip/client.js`，刷新 DSH 页面生效；Host 与后端无改动。

### 未在本机验证

- 真实数据下从散落画布点开一条老记录（列表靠下）后的滚动定位观感，需要在 GUI 内目测；离开首页再回来会回到默认散落视图（与切 tab 行为一致）。

## 纪要 × 笔记整合 + 三套场景模板（2026-11-05，未发布）

### 2026-11-06 补充：失败状态不再误报「未配置文字模型」

- 用户反馈：AI Key 与文字模型已配置，但纪要页显示「未配置文字模型」。
- 原因：`invalid_key`（Key 被网关拒绝/无模型权限）和 `no_key`（没有 Key）在旧状态胶囊里用了同一句文案。
- 修复：
  - `invalid_key` 显示「AI Key 无效」，`no_key` 才显示「未配置文字模型」；两者分别有独立提示。
  - 失败时读取 `/api/ai/status`，提示里带上当前模型：「AI Key 已配置（demo-flash），但上次调用被拒绝：AI Key 无效或无模型权限」，并提供「检查模型」按钮直接调 `/api/ai/check`。
  - `own_key=false`（文字总结沿用云端 ASR 那把 Key）时额外提示：如该 Key 没有文本模型权限，请在「文字总结 → 自定义 API」单独填 Key。
  - 无 AI 内容时按钮文案改为「生成纪要」，有 AI 段落时才是「重新生成」。
  - 新增深色预览 `build/notes-preview-invalid.png` 复现该状态。
- 本机实测（2026-11-06）：`/api/ai/status` 返回 `has_key=true`、`own_key=false`、`model=demo-flash`；`/api/ai/check` 当时返回 `invalid_key`。后续定位到这不是 Key 权限，而是模型名少了网关要求的供应商前缀（见下一条）。
- 前端重新构建、`node --check`、render/interaction smoke 均通过；`client.js` 重新同步到安装副本。


### 2026-11-06 根因修复：网关的模型必须带供应商前缀

- 现象：设置里显示 Key 与模型都已配置，`/api/ai/check` 仍返回 `invalid_key`；网关原始响应是 `{"error":{"message":"该模型未指定供应商","code":"401"}}`。
- 根因：`/v1/models` 返回的模型 id 不带供应商前缀（如 `demo-flash`），但 `/v1/chat/completions` 需要 `demo-flash`。同一把 Key：
  - `POST /v1/chat/completions` with `demo-flash` → **401 该模型未指定供应商**；
  - with `demo-flash` → **200**（`mimo-v2.6-pro`、`vendor/deepseek-v3.1` 同样可用）；
  - `demo-asr` 做文本请求返回 400（它是 ASR 模型，符合预期）。
- 修复：
  - `backend/app/ai/providers.py` 新增 `wire_model()`：默认网关提供商下，模型 id 没有 `/` 时补供应商前缀；OpenAI/自定义服务保持原样。
  - `ai/client.py` 的 `chat()` 与 `check_key()` 都走 `wire_model()`；设置里仍保存模型清单返回的无前缀 id，设置页下拉不受影响。
  - 401/403 现在把网关原始原因带进错误信息，后续可直接看到「该模型未指定供应商」而不是笼统的 Key 无效。
- 复验：
  - `POST /api/ai/check` 返回 `{"ok":true,"seconds":0.42,"provider":"mimo","model":"demo-flash"}`。
  - 临时数据目录 + 真实 Key/模型跑完整 `minutes.engine._run(final=True)`：纪要行 `state=idle`、`version=2`，说明模型输出已解析并落库（未在真实资料库上消耗生成）。
  - 后端重启后 `/api/health` 200（pid 91265）。
  - `tests/test_ai_layer.py` 新增 `wire_model` 与前缀请求体测试，12/12；后端全量 **23/23 文件通过**。
- 已存在的 `invalid_key` 纪要行不会自动清状态；刷新页面后在对应记录点「生成纪要 / 重新整理」即可重新生成并写入笔记。
- 界面补充：失败状态下点「检查模型」成功后，胶囊切到「模型可用」并提示「点生成纪要即可重新整理」，不需要先刷新或手动清状态。

### 2026-11-06 二次根因：思考模式吃光 token + 设置页「测试连接」

- 现象：模型前缀修好后，真实长会议（789 行、3 个窗口）仍失败，纪要状态 `failed`，错误 `AI 返回了空内容`。
- 根因：网关不执行 `reasoning: {"enabled": false}`。长提示词下思考把 `max_tokens=3000` 全部烧完，`finish_reason=length`、`content=null`，于是被当成「空内容」。
  - 同一提示词实测：只发 `reasoning.enabled=false` → 思考 2999 token、正文空；
  - 加发 `reasoning_effort: "none"` → 思考 0 token、正文 4280 字、JSON 可解析（41s）。
- 修复：
  - `ai/providers.py::shape()` 在 reasoning 提供商上同时发 `reasoning: {"enabled": false}` 与 `reasoning_effort: "none"`。
  - `ai/client.py::_content()`：`finish_reason=length` 且正文为空时抛 `truncated`，不再误报「空内容」；`chat()` 遇到截断自动把 token 预算翻倍重试一次（上限 8000）。
- 真机复验：
  - 用真实 Key 重新生成 `5abae5923eae`（88 分钟、789 行）：`state=idle`、`version=2`，6 个主题、4 条待办、10 个术语；笔记写入 3313 字，含 `meetclip:minutes` 段落、时间锚点与待办勾选框。
  - 之前 4 条 `invalid_key` 记录不会自动重跑，需各点一次「生成纪要」。

### 设置页「测试连接」（2026-11-06）

- 语音转文字、文字总结的模型下拉旁各有一个「测试连接」，测的是**下拉里当前选中、可能还没保存**的模型；结果行显示「模型可用：…」或错误原因。
- 后端：
  - `POST /api/ai/test` 接受 `{provider, base_url, model, api_key?}`，走 `wire_model()` 与 15 秒超时，不写设置。
  - `POST /api/asr/engines/test` 接受 `{base_url, model, api_key?}`，仍用 1 秒合成静音，不上传真实录音；云端 ASR 提供商支持探针直接带一把未保存的 Key。
- 实测：
  - `POST /api/ai/test {"provider":"mimo","model":"demo-flash"}` → `ok=true, seconds=0.6, wire_model=demo-flash`。
  - `POST /api/asr/engines/test {}` → `ok=true, model=demo-asr`，首字 0.17s。
- 预览：`build/settings-preview.png`（深色）、`build/settings-preview-light.png`（浅色），两个按钮与结果行均已截图确认。

- 测试：`test_ai_layer` 14/14（新增 wire_model、显式 config/key、截断重试）、`test_asr_custom` 9/9（新增探针带未保存模型/Key、无 Key 拒绝）；后端全量 **23/23 文件通过**；`node --check`、render/interaction/setup smoke、host 14/14 通过。
- 已同步安装副本（`client.js` md5 `2d599e6177e81e32a36d3395c46bdbcd`），后端重启 pid 91265。

### 行为

- 详情页「纪要 / 笔记」合并为一个「纪要」页：AI 纪要以 `<!-- meetclip:minutes:begin -->` / `end` 包住的 Markdown 段落写进 `sessions.notes`，默认预览，点击纸张或「编辑」进入编辑；保留原自动保存、草稿恢复、页内查找、409 冲突和「载入最新 / 保留草稿」。
- 场景模板按记录类型自动选择：`meeting` → 会议纪要（结论和待办 → 总结 → 主题 → 人名和术语），`link_video` → 视频纪要（总结 → 章节 → 要点 → 可行动项 → 人名和术语），`live` → 直播纪要（总结 → 看点 → 结论 → 后续 → 人名和术语）。模板 JSON 结构与知了 Cicada 一致（title / summary / topics / conclusions / todos / terms / evidence），实现见 `backend/app/minutes_scenarios.py`、`backend/app/minutes_notes.py`。
- 触发：会议与直播沿用原有 `minutes.finish()`；视频链接的**字幕路径**在 `LinkTask` 成功收尾且 `imported` 为真时补一次 `minutes.finish()`，ASR/内录路径仍由 `MeetingTask` 触发，避免重复。只对终稿写笔记，直播增量草稿不覆盖用户内容。
- 历史记录：有纪要版本但笔记无段落时，打开纪要页会 `POST /api/sessions/{sid}/minutes/notes` 懒回填一次；用户删掉段落后 `meta.minutes_notes_version` 阻止自动加回，可用「写入笔记」（force）恢复。
- 时间锚点 `meetclip://seek/{秒}` 在预览中渲染为可点击 chip；`- [ ]` 渲染为勾选框；HTML 注释边界在预览中隐藏。
- 导出 Markdown 有结构化纪要时先剥离笔记里的 AI 段落，避免同一份总结出现两次；无纪要行但笔记有段落时只去掉边界注释，保留内容。

### 自动化验证

- 后端：`MEETCLIP_TEST_PYTHON=$HOME/.dsh/meetclip/venv/bin/python backend/tests/run-all.sh` — **23/23 文件通过**。
  - `tests/test_minutes_notes.py` 22/22：场景映射与 topics 上限、会议/视频/直播 prompt 措辞与参考上下文、三套 Markdown 节顺序与锚点/待办/术语、英文字段名、终稿写笔记与 meta、视频/直播模板、直播增量不改笔记、幂等、用户删除后 force 恢复、409 重试保留用户文本、历史纪要 `/minutes/notes` 回填、空纪要 400、重复段落合并、导出去重与无纪要行保留、Markdown 投影无边界/无提示行、`/minutes.md` 200 与 404、导出节复用场景顺序、复制/导出带文本时间轴而笔记段落不带。
  - `tests/test_search.py` 13/13：新增「纪要 JSON 可搜；物化进笔记后只算一处」——命中来源为「纪要」，摘要片段取自字段本身而不是 JSON。
  - 前端：`tests/minutes-view.test.mjs` 9/9（后端下发的节顺序、语言兜底、结论和待办合并标题、弱证据判定、空纪要判定、时间轴分段与直播高亮）；`node --test tests/*.test.mjs` 106/106。原因块改为卡片网格后，鱼骨图的「上下分支分配」不再有实现，相应用例一并删除。
  - 扩展 `tests/test_minutes.py`（16/16）、`tests/test_link_video.py`（48/48，字幕路径 `minutes.finish` 只调一次）、`tests/test_export_formats.py`（6/6）、`tests/test_meeting_notes.py`（14/14）。
- 前端：
  - `node build/build-client.mjs`；`node --check client.js`；`render-smoke`、`interaction-smoke`、`setup-smoke` 全通过。
  - `interaction-smoke` 新增：详情不再有「笔记」页签；纪要页默认预览、无 textarea；点击纸张进入编辑并保留内容；预览切回；`meetclip://seek` 锚点渲染；边界注释不在预览文本里。
  - Host：`node --test tests/host.test.mjs` 14/14；`tests/scatter-layout.test.mjs` 10/10、`tests/scatter-camera.test.mjs` 6/6。
- 视觉：`node build/build-notes-preview.mjs` + `node build/notes-preview-shot.mjs`（深色）/ `--light`（浅色）生成 `build/notes-preview.png`、`build/notes-preview-light.png`；18px 面板、14px 纸张、宋体标题、胶囊、0.5px 线与首页/设置一致。

### 安装副本

- `client.js` 已同步到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip`，md5 与工作区一致（`2d599e6177e81e32a36d3395c46bdbcd`）。
- 后端已同步 `minutes_scenarios.py`、`minutes_notes.py`、`minutes_prompt.py`、`minutes.py`、`routes/minutes.py`、`routes/sessions.py`、`link_video.py`、`export_md.py`；`src/host/tools.js` 同步（描述与 scenario 字段，需插件重载后生效）。
- 已重启本地引擎：pid 78522，`/api/health` 200，`/api/sessions/659af77f1181` 返回 `minutes_scenario=meeting`、`minutes_notes_version=0`；对无可用纪要的记录调用 `/minutes/notes` 返回 400「还没有可写入的纪要」。

### 未在本机验证

- 真实 AI 的端到端生成：当前资料库的 Key 状态为 `invalid_key`（例如 `ab534553d3fb`），修复 Key 前无法验证真实模型输出；逻辑用假 AI 与临时库验证。
- 真实浏览器里点击预览进入编辑、时间锚点跳转的观感：没有浏览器自动化，需刷新 DSH 页面后在 GUI 内目测。
- 视频链接完整字幕下载 + 自动纪要触发：单测只验证 `minutes.finish` 被调用；未用真实链接跑完整下载与模型。
- 直播增量草稿不再在纪要页单独渲染（只显示状态）；这是本次合并的有意取舍，未做旧观感对照。

## 0.7.0 补丁：Hero「N 条正在进行」直达记录（2026-11-05）

- 行为：首页 Hero 的「N 条正在进行」不再把散落画布筛成「进行中」，改为直接打开那条记录（录制/转写进度就在里面；后续版本统一改为在资料库中选中该记录）；底部「进行中」筛选保留，用于浏览全部进行中的记录。
- 多条同时进行时按「录制 > 处理 > 排队」挑一条，同状态取最近开始；Hero 的悬浮提示会写明要打开哪条记录。
- 前端验证：`node build/build-client.mjs`、`node --check client.js`、`node build/render-smoke.mjs`、`node build/interaction-smoke.mjs` 全通过。交互冒烟新增：
  - 单条「处理中」时点 Hero 链接，浮层打开「产品会议」，底部筛选仍停在「全部」而不是切到「进行中」；
  - 两条进行中（录制 + 处理）时点 Hero 链接，打开的是录制中的「发布会回放」。
- 单测：`node --test tests/host.test.mjs` 14/14，`tests/scatter-layout.test.mjs` 10/10，`tests/scatter-camera.test.mjs` 6/6。
- 安装副本：`client.js` 已同步到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip`（md5 与工作区一致），刷新 DSH 页面即可生效。
- 未在本机验证：真实引擎里对「处理中」记录打开浮层后的实时转写观感（逻辑与现有卡片点击一致，需在应用内目测）。

## 0.7.0：首页批量链接、批次卡与抖音登录（2026-11-05）

- 链接解析单测：`node --test tests/links.test.mjs` 8/8。用用户原文断言 34 条 URL → 28 条唯一视频（B站 3 / 微博 21 / 抖音 4），跳过 5 条非视频站 + 1 条重复；覆盖引号、空行、中文标点、平台变体、追踪参数清理、去重与 50 条上限。
- 后端：`MEETCLIP_TEST_PYTHON=$HOME/.dsh/meetclip/venv/bin/python backend/tests/run-all.sh` 22/22 文件通过。新增/扩展：
  - `test_douyin.py`：Cookie 域名过滤、0600、状态/清除、打开浏览器、无链接测试错误；
  - `test_home.py`：`/api/home` 的 `batches` 聚合、成员顺序、状态计数、非 link_video 忽略；
  - `test_link_video.py`：多条提交写 `meta.batch`、单条不写、抖音 Cookie 文件优先于匿名（46 个用例）。
- 前端：`node build/build-client.mjs`、`node --check client.js`、`render-smoke`、`interaction-smoke` 全通过；交互冒烟新增批次卡/批次浮层与设置页「抖音账号」断言；`node --test tests/host.test.mjs` 8/8，`tests/scatter-layout.test.mjs` + `tests/scatter-camera.test.mjs` 全通过。
- 安装副本：`client.js` 已同步到 `~/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip`（与工作区 md5 一致）；后端从该副本以临时数据目录启动，`/api/health`、`/api/douyin/status`、`/api/home`（含 `batches`）均 200。运行中的本地引擎需重启后才会加载新后端路由。
- 未在本机验证：
  - 抖音分享页兜底（`_ROUTER_DATA`）已用真实链接验证预读标题/作者/时长/封面，直链下载 70 MB 成功；完整入队+转写仍沿用同一路径。
  - 真实抖音 Cookie 提取与下载：本机 Chrome/Brave/Edge 没有 douyin.com Cookie，需要用户在设置页扫码登录后复验；且 macOS 未给 DeepSeek Harness 完全磁盘访问权限时，读取 Chrome Cookie 会失败（已在 UI 给出权限入口）。yt-dlp 的 Douyin 提取器仍可能被平台风控拒绝。
  - 真实 28 条批量下载：只验证了解析、入队、批次卡与队列路径，没有一次下载近 30 条视频；真机验证建议先提交 3 条。
  - 批次卡在散落画布的定位动画与高亮：没有浏览器自动化，需要在同一 GUI 里目测。

## 0.5.0：停用本地时间戳/说话人模型（2026-11-05）

后端（插件 venv，`MEETCLIP_TEST_PYTHON=$HOME/.dsh/meetclip/venv/bin/python backend/tests/run-all.sh`）：
19/19 文件通过，其中：

| 测试文件 | 覆盖 |
|---|---|
| `test_cloud_asr.py` | 云片段直接落库为 chunk 级时间戳、无本地模型参与、失败保留旧转写 |
| `test_speakers_cloud.py` | 云端分离接线位：无 provider 原样返回、按时间重叠标注、注册/注销 |
| `test_home.py` | 会议选项不再返回 aligner/diarize；旧模型列举与删除接口 |
| `test_link_video.py` | 字幕导入、下载/元数据与队列行为（说话人相关用例已随功能下线移除） |
| `test_word_alignment.py` | 词级对齐映射保留；阶段始终为 transcribe |

前端与宿主：
- `node --test tests/host.test.mjs` 7/7。
- `node --check client.js`、`build/render-smoke.mjs`、`build/interaction-smoke.mjs`、`build/setup-smoke.mjs` 全通过。
- `node build/build-client.mjs` 重新生成 `client.js`（设置只含云端语音卡片；概览为引擎状态条）。

**未在本机验证**：
- 真实云端批量转写后的片段级时间戳观感（需要真实音频与 API 额度）；
- 旧记录重转后发言人标签清除的实际提示（逻辑有单测，UI 需在同一 GUI 里看一眼）；
- 已安装 tgz 的升级路径（本次只改仓库源码，需重新打包安装后复验）。

## 0.4.0：知了 Cicada 借鉴项（2026-11-05）

后端（插件 venv，`MEETCLIP_TEST_PYTHON=$HOME/.dsh/meetclip/venv/bin/python backend/tests/run-all.sh`）：
18/18 文件通过，其中 6 个为本次新增：

| 测试文件 | 覆盖 |
|---|---|
| `test_minutes.py` | 证据行号→秒数、越界证据丢弃、语言不符丢弃并重试、时间锚点只前移、终稿分窗、主题数随时长封顶、失败不覆盖上一版、指标落盘、详情带纪要状态、重新生成需 Key |
| `test_ai_layer.py` | 限速闸门（间隔 + 优先级）、按供应商关思考、内容进 system message、429 只对纪要重试、反劫持、思考泄露剥离、JSON 模式被拒后自动回退、指标只记数字 |
| `test_speaker_labels.py` | 5 句阈值、单人/仅一人够格不编号、编号按达标顺序固定、用户命名优先、发言人 N 回填（长号先换）、猜名证据邻域校验与驳回、撤销快照、接口往返 |
| `test_text_hygiene.py` | 重复标点/行首标点清洗、定稿丢词用草稿、断句续接与拼接、相邻行合并 |
| `test_export_formats.py` | SRT 时间轴（最短 1s / 最长 8s / 末行 +4s）、VTT 带说话人、DOCX 包结构与正文、三种下载接口、Markdown 带纪要且 ZIP 附字幕 |
| `test_meeting_end.py` | 询问→倒计时→结束、说话取消询问、直接结束、一句没说安静收尾、继续记录、静音下限；采集侧的裁尾秒数与看门狗启动条件 |

前端与宿主：
- `node --test tests/host.test.mjs` 7/7（新增 `meetclip_minutes` 注册，工具数 9）。
- `node --check client.js`、`build/render-smoke.mjs`（三 slot）、`build/interaction-smoke.mjs` 全通过；
  交互冒烟新增：切到「纪要」页签后能看到主题、要点、待办与术语。
- `npm pack` 产出 `dist/dsh-meetclip-0.4.0.tgz`（68 个文件，含 `backend/app/ai/*`、`routes/minutes.py`、`routes/speakers.py`）。

**未在本机验证**（需要真实资源，与方法无关）：
- 真实文本模型 Key 的端到端纪要质量与费用（用假网关验证了解析、重试与失败路径）；
- 真实直播的自动结束与裁尾（状态机有单测，`-t` 裁尾需真实 TS 才能看到成品）；
- 页面视觉：没有浏览器自动化，纪要页签的排版需要在同一 GUI 里看一眼。

## 已执行

- 后端 fork 测试（插件独立 venv）：`backend/tests/run-all.sh` — 11/11 文件通过。
- Host 单测：`node --test tests/host.test.mjs` — 6/6 通过（配置、鉴权、prefs、attach/数据目录冲突、后端生命周期与代理、工具注册）。
- Client 构建：`node build/build-client.mjs`；`node --check client.js`。
- 渲染冒烟：`build/render-smoke.mjs`（main/sidebar/settings 三 slot）。
- 交互冒烟：`build/interaction-smoke.mjs`（首页摘录墙/散落/打开记录进资料库、资料库、详情、转写、标记、笔记页、日历、事件详情、新建弹层、设置分组；含侧栏/标记/截图/首页右键菜单断言）。
- 首页接口：`backend/tests/test_home.py`（统计、封面优先级、金句、分页、鉴权）4/4 通过。
- 右键菜单：`ContextMenu` + 侧栏多选作用域、标记/截图/说话人/内容区/首页卡片菜单，交互冒烟通过。
- 键盘：M/Space/⌘Z/⌘F/⌘G/⌥⌘I、侧栏 Delete/⌘C/Return、截图空格预览。
- 详情：时间轴（标记/截图/命中）、播放条（倍速/音量/直播最新）、转写自动跟随、信息字段与提示条。
- 日历：未关联内容按月历与当天议程混排、独立本地/飞书/未关联开关、缓存/上次同步标记、日程详情「新建采集」自动关联。
- 笔记：标题/列表/待办/删除线/代码块/分隔线/复制全文/字数/页内查找/快捷键；默认预览态。
- 采集：类型草稿保留、默认新建类型、直播状态/开播时间、视频逐条移除/增加、会议热词多行与云端引擎禁用、Esc/Enter。
- 详情：采集胶囊（时长/截图/画质）、实时预览/截图灵敏度、四步阶段标签、Markdown 下载、动作层级收敛（更多菜单）。
- 首页：Hero 统计、链接输入、信息流/散落、金句卡、打开记录进资料库并选中。
- 散落画布布局：`node --test tests/scatter-layout.test.mjs` 9/9（四类卡片互不重叠、避开 Hero、幂等、图钉不动、新增不洗牌、80 卡收敛、手动落点让位）。
- 散落画布相机：`node --test tests/scatter-camera.test.mjs` 6/6（取景、指针锚点缩放、屏幕/世界互转、新卡入镜）。
- 散落画布交互：interaction smoke 覆盖便利签/图片卡入墙、拖到便利签上后落点持久化与邻居让位、筛选往返不重排、图钉卡不可拖动。
- 散落画布视觉：`node build/scatter-preview-shot.mjs` 生成 `docs/assets/scatter-preview.png`（1440×1000）；`--drag` 走 `?demo=drag`，在浏览器里真实拖动一张卡后截图并导出位置，确认落点持久化、邻居让位、无重叠。
- 卡片可读性（深色主题）：会议卡背景由写死的 `#f8f8f5` 改为跟随主题的暖色混色；卡片显式继承主题文字色；深色下补了页脚/状态/未读徽标/封面角标/便利签（含待办）/便利签编辑器的对比度变体，图片卡补边框。用 `node build/scatter-preview-shot.mjs --dark` 截图核对，浅色用默认参数回归。
- 客户端分发：`client.js` 已重建并同步到桌面 profile 的安装副本（2026-11-06，sha256 `ae0f5f3a…` 一致），刷新 DSH 页面即可加载。
- 后端分发（HEIC）：`backend/app/routes/sessions.py` 已同步到安装副本；`backend/tests/run-all.sh` 全量 23 个文件通过；安装副本里的后端已用与宿主机相同的环境变量重启（新 pid 42946），真实上传 `/tmp/src.heic` 返回 `board-images/*.jpg`、96×64、`image/jpeg`，测试图已删除。
- 主界面粘贴：`node --test tests/paste.test.mjs` 11/11（文字→便利签、列表标记归一成待办、标题行保留、数字/日期不误判、空内容返回 null、超长截断到 5000 字、剪贴板图片去重与格式白名单）。
- ⌘V 入板（真实浏览器）：`build/scatter-preview.html?paste=text` 生成 `build/paste-text-preview.png` —— 新增一张待办卡、底部计数 16→17；`?paste=image` 生成 `build/paste-image-preview.png` —— 走 `POST /api/board/images` 后新增图片卡并提示「已添加图片卡」；`?paste=guard` 在 Hero 输入框聚焦时粘贴不建卡、无 POST（`{"sticky":2,"images":1,"active":"INPUT","requests":[]}`）。
- 卡片删除动作：图片卡、便利签、待办清单改用与记录卡完全一致的右上角「删除」胶囊（right/top 10、悬停或键盘聚焦出现、图钉态隐藏），去掉各自的 × 按钮；`tests/style.test.mjs` 断言共用同一套内缩与样式，interaction smoke 断言记录卡/便利签/图片卡都渲染「删除」；四类卡片悬停截图 `build/delete-actions-compare.png` 核对。
- 拖拽白边：散落卡外壳（`.mc-scatter-card`）补 20px 圆角，拖动态画在外壳上的 box-shadow 不再于四角露出直角接缝；`?demo=drag-hold` 保持拖动态，同一布局下临时移除外壳圆角做 A/B 截图 `build/drag-corners-compare.png`；`tests/style.test.mjs` 断言外壳圆角。
- 双击编辑便利签/待办：抽出共用 `NoteEditor`，散落画布双击空白新建、双击卡片编辑（点到勾选框或删除按钮不触发）；保存走 `PATCH /api/sticky-notes/{id}` 并回填 kind/checked。真实浏览器验证：双击打开「编辑待办清单」→ 改文本 → 保存后便利签变待办、勾选项重建、提示「待办清单已更新」；信息流视图同样可编辑。
- 便利签排版：正文由 15.5px 宋体改为 12.5px 系统字体（与无封面记录卡的正文一致），待办条目同字号；编辑器输入框同步；`tests/style.test.mjs` 断言不再出现 `sticky-serif`。
- HEIC/HEIF 图片：后端上传白名单新增 `image/heic`、`image/heif`（含 sequence 类型）并按扩展名兜住浏览器未上报 MIME 的 `.heic/.heif/.hif`；落盘后嗅探 `ftyp` 品牌，命中 HEIF 就用 `pillow-heif`（若安装）或 macOS `sips` 转成 JPEG 再入库，前端拿到的仍是普通图片卡。`backend/tests/test_home.py` 新增 3 条：真实 HEIC（sips 生成）上传转 JPEG、宽高回填 96×64、返回 `image/jpeg`；无 MIME 的 `.heic` 也能识别；损坏 HEIF 返回 400 且不留残文件。
- HEIC 前端链路：`tests/paste.test.mjs` 覆盖 HEIC MIME、无 MIME 的 `.HEIC` 扩展名与拖入文件识别；`build/scatter-preview.html?paste=heic` 生成 `build/paste-heic-preview.png`，确认 HEIC 文件走 `POST /api/board/images` 并落成图片卡。
- 图钉动效：基础 `.mc-scatter-card.is-pinned` / `.mc-scatter-pin` 移除常驻 animation，改为钉上时只给目标卡挂 700ms 的 `is-pinning`；用 `animationstart` 监听复现：修复前第二次钉卡会同时重播 `note-n1`、`note-n2` 的 sink+set，修复后只播本次目标卡（`[{"name":"mc-pin-sink","node":"note-n1"},{"name":"mc-pin-set","node":"note-n1"}]`）；信息流同样只播目标卡，700ms 后 `is-pinning` 归零。`tests/style.test.mjs` 断言基础规则无 animation、瞬时选择器存在。
- 设置：模型/采集两个标签；模型含网关 Key + 拉取模型清单、语音转文字、文字总结（各自可选模型与自定义 API），采集含默认类型/直播/视频；页面不含通用页、数据目录、端口、日志、运行信息等诊断内容。
- 真实音频会议导入：临时库 + 真实 6 秒音频 → `done`，1 段转写（本地模型下线后需用云端重跑复验）。
- 同源代理媒体 Range：`206` + `Content-Range`；SSE：`text/event-stream` + 首个 `noop` 事件。
- 真实 B站：`live.bilibili.com/1` 预检返回回放状态与标题；公开 BV 视频预读返回标题/时长/平台与可加入队列。
- 真实直播闭环：临时库中采集正在直播的 B站房间 → 录制约 8 秒 → 停止 → `done`，产出 `media.mp4` 与 3 张自动截图。
- 真实飞书 CalDAV：账号已连接并同步，180 天范围读取 236 条飞书日程；真实库笔记/标记保持原样。
- 分发包：`npm pack` 产出 30 MB、78 文件 tarball；解包后独立启动后端并通过 `/api/health`，注册 8 个工具。
- 0.5.1 分发包：`npm pack` 产出 `dist/MeetClip-0.5.1/dsh-meetclip-0.5.1.tgz`（545 KB、68 文件）；解包后独立启动后端通过 `/api/health`，包内 `client.js` 与仓库构建产物 md5 一致。
- 0.6.7 首次引导：真实网关 227 个模型 → 「语音转文字」8 项、「文字总结」181 项全量下拉；Key 输入框失焦只发 1 次 `/meetclip/app/models`，表单一字未重建（点开列表不再闪）。
- 0.6.7 分发包：`dist/MeetClip-0.6.7/dsh-meetclip-0.6.7.tgz`（547 KB、70 文件），解包启动后端通过 `/api/health`；包内 `client.js` 与仓库构建产物 md5 一致，setup/interaction/render smoke 全过。
- 0.6.6 分发包：`dist/MeetClip-0.6.6/dsh-meetclip-0.6.6.tgz`（546 KB、70 文件），解包启动后端通过 `/api/health`；模型页提示精简为「更新 Key 后，点『拉取模型清单』」。
- 0.6.5 分发包：`dist/MeetClip-0.6.5/dsh-meetclip-0.6.5.tgz`（545 KB、70 文件），解包启动后端通过 `/api/health`；文字总结模型改为下拉，interaction smoke 断言模型选项已渲染。
- 0.6.4 分发包：`dist/MeetClip-0.6.4/dsh-meetclip-0.6.4.tgz`（545 KB、70 文件），解包启动后端通过 `/api/health`；模型页提示/错误文案与输入框列对齐，Key 停顿 800ms 自动保存并拉取。
- 0.6.3 分发包：`dist/MeetClip-0.6.3/dsh-meetclip-0.6.3.tgz`（545 KB、70 文件），解包启动后端通过 `/api/health`；深色主按钮改用 label-primary/bg-base 反色，模型页 Key 支持回车保存并拉取。
- 0.6.2 分发包：`dist/MeetClip-0.6.2/dsh-meetclip-0.6.2.tgz`（545 KB、70 文件），解包启动后端通过 `/api/health`；设置只剩模型/采集两页。
- 0.6.1 分发包：`dist/MeetClip-0.6.1/dsh-meetclip-0.6.1.tgz`（545 KB、70 文件），解包启动后端 `/api/health` 通过；模型页三卡与自定义 API 由 interaction smoke 覆盖。
- 0.6.0 分发包：`dist/MeetClip-0.6.0/dsh-meetclip-0.6.0.tgz`（544 KB、70 文件），解包启动后端通过 `/api/health`；新增 `model_catalog.py` 与宿主 `models-probe.js` 均在包内。
- 0.6.1 模型页：`backend/tests/test_asr_custom.py` 覆盖自定义 ASR 配置与三种保存模式；setup smoke 覆盖首次引导拉取模型并保存；interaction smoke 覆盖模型页的三个区块与自定义 API 字段。
- 0.6.0 模型目录：`tests/models.test.mjs` 覆盖语音/文本分类；`tests/host.test.mjs` 覆盖 `/meetclip/app/models`；`backend/tests/test_model_catalog.py` 覆盖解析/401/网络错误；setup smoke 覆盖输入 Key 后自动列出模型并保存所选模型。
- 转写选项、日程删除撤销、上传清理、内录回传路由、依赖安装顺序等 M5 边界已补并重建。
- DSH 运行态：8 个 `meetclip_*` 工具、main/sidebar/settings 三个 slot 均 active。
- 真实库快照：8 条记录；媒体 Range 206；模型 autoload；ASR/对齐就绪。
- 工具集成：列表/详情/分页转写/全局检索/笔记版本冲突/标记增删/改名/删除审批/日程创建/关联/引用/笔记/导出/删除恢复/内录路径权限。
- 旧仓库不变量：`git status` 与基线对比，旧路径零修改。

## 未执行（需用户环境）

- B站真实直播预检、采集、HLS 播放。
- 真实 YouTube/B站/微博/抖音/X 链接的预读与批量下载。
- 飞书 CalDAV 账号测试与同步。
- B站二维码登录与 Chrome cookie 读取。
- 浏览器内录（getDisplayMedia）真实录制。
- DSH 应用内的最终目测（散落画布已在 `build/scatter-preview.html` 用无头 Chrome 截图核对，应用内需刷新后确认）。

## 限制

- 当前 Host/Client 更新通过禁用再启用插件与刷新页面加载；替换包代码可能需要重启 DSH。
- 自动测试使用临时数据目录；真实数据验证会执行原项目的恢复逻辑。

- 内联采集：视频 URL → 视频单面板；＋ 文件 → 会议单面板；搜索文字不弹采集面板；interaction smoke 通过。
