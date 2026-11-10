# 测试

新建弹层原生状态验证覆盖页签与默认类型、分享文案提取、X/Twitter 域名识别与批量提交、400 ms 自动预读、乱序响应、清空输入、关闭弹层、批量粘贴、删除预读中的链接、重试和 20 条上限（模拟后端，不访问网络）：

```sh
swiftc -parse-as-library tests/new_capture_native.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/Models.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/NewCaptureDraft.swift \
  -o /tmp/meetclip-new-capture-tests
/tmp/meetclip-new-capture-tests
```

新建弹层视觉验证直接渲染生产 SwiftUI 视图，覆盖空白、预读、成功、失败、批量、模型缺失、长链接、长文件名、说话人展开和浅／深色，以及相同直播链接的两种入口、封面缺失与加载失败，多种字幕语言、超长语言名、深色模式和预读中，并追加 X 预读成功、深色和登录失败，共 35 种状态。字幕语言状态会检查预读卡片、两个玻璃菜单和提示文字共用左边线，菜单高 32 pt、间距 8 pt，提示在菜单下方 4 pt；新建窗口不得出现 NSPopUpButton。逐一检查内容尺寸为 560 × 600 pt、输入框焦点描边的安全留白、会议控件的共同左边界，以及五个平台的矢量 logo 可离线加载，X 图标随浅／深色切换。封面由测试的本机 HTTP 服务提供，不访问外网。通过原生鼠标事件操作合并的玻璃类型控件，检查草稿与卡片保留、避免重复预读，以及回车仅提交当前页的数据。使用模拟后端，不创建实际任务：

```sh
(cd macos/ZhiBoApp && swift build)
swiftc -parse-as-library tests/new_capture_preview.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/Models.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/DesignTokens.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/GlassSegmentedControl.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/NewCaptureDraft.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/CaptureComponents.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/NewCaptureSheet.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/SpeakerOptionsView.swift \
  -o /tmp/meetclip-new-capture-preview
/tmp/meetclip-new-capture-preview /tmp/meetclip-new-capture-snapshots
```

默认使用开发资源包；可以通过 `PACKAGE_RESOURCE_BUNDLE_PATH` 指向资源包所在目录。

统一排队验证覆盖三种场景在已有任务时继续提交、混合任务 FIFO 顺序、并发提交的单槽位互斥、上传保留、取消、启动失败后继续、暂停链接、重复提交和重启恢复（临时数据库与模拟处理管线）：

```sh
.venv/bin/python tests/test_task_queue.py
```

后端可靠性与安全验证覆盖本地 API 鉴权、Host 校验、meta 并发写、重新转写失败/取消保留旧转写、删除策略、链接视频取消与列表计数（请单独运行）：

```sh
.venv/bin/python tests/test_backend_reliability.py
```

视频与会议转写分段验证覆盖无标点的长发言、真实静音与错误对齐间隔、完整中文词语与产品名、零时长数字和短语气词、说话人切换，以及无对齐模型时的降级。使用合成音频与时间戳，不加载语音模型或修改用户记录：

```sh
.venv/bin/python tests/test_transcript_segments.py
.venv/bin/python tests/test_word_alignment.py
.venv/bin/python tests/test_speaker_attribution.py
```

词级映射测试验证 `Pro、iPhone → ProiPhone`、`USB-C → USBC`、`f1.78 → f178` 等标点归一化差异不会让整段转写丢失标点，原文字面与词级起止时间均保留。

说话人归属测试覆盖零时长字符落在长发言内时不被附近短插话吸走、未覆盖文字使用区间边缘距离、重叠按发言人累计、连续零时长碎片、真实切换与短回复保留。分段测试同时覆盖“不了解”式词内跳变和“具体的。支撑的功能点”式半句边界。

链接视频验证覆盖立即入队（不访问平台、300 ms 内返回）、预读缓存复用、字幕先于视频下载导入、字幕视频按时间重叠标注发言人与失败保留字幕、内置说话人模型、进程内 yt-dlp 的登录回退顺序、三条批量导入、无 Chrome 登录数据库时的公开视频下载、登录授权回退、无协议链接、失败后继续队列与原记录重试（临时数据目录，不访问网络或加载模型）：

```sh
.venv/bin/python tests/test_link_video.py
```

同时覆盖链接视频说话人选项持久化、模型前置检查、会议管线复用、失败降级、重转写保留原文、命名/合并与 Markdown 导出。

X 回归使用已安装的 yt-dlp Twitter 提取器与 `fixtures/x-post.json` 模拟帖子，不访问 X。覆盖新旧／移动端域名归一、分享追踪参数移除、预读缓存与重复检查、普通多视频帖只采集首段、`/video/N` 保留指定选择、外部命令行提取器的多视频结果、下载队列与转写管线、登录授权回退和无视频帖错误。

同时覆盖匿名主接口超时后的公开嵌入接口回退、进程内与外部提取器路径、下载复用已成功的接口及下载阶段的回退；已登录请求和广播链接不使用帖子备用接口。实网验证记录见 `artifacts/x-support/README.md`。

也覆盖同一直播链接在发布会与视频预读接口中的标题、封面、主播、分区和开播时间一致，发布会预读无需 yt-dlp、主播请求失败后的降级、北京时间解析、未开播时不显示旧直播时长、HTTPS 封面回退及普通视频标题中的日期保留。

原生状态验证还覆盖主播/分区信息、开播时间与递增直播时长、缺失和无效时间的兼容。视觉验证可通过环境变量 `MEETCLIP_LIVE_PREVIEW_JSON` 指向已保存的公开直播预读结果，追加一张真实封面截图；这个可选状态会访问结果中的封面地址，默认 28 种状态仍使用本机图片服务。

链接视频原生说话人验证直接运行会议和链接视频共用的改名/合并组件，检查同名确认与失败保留名称。可选输出目录会截图新建选项与 290pt 检查器，便于检查窄列布局：

```sh
swiftc -parse-as-library tests/link_speakers_native.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/Models.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/SpeakerEditing.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/SpeakerViews.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/SpeakerOptionsView.swift \
  -o /tmp/meetclip-link-speakers-tests
/tmp/meetclip-link-speakers-tests /tmp/meetclip-link-speakers-preview
```

## 会议、直播与视频笔记验证

会话详情缓存、时间索引、搜索索引与 1,000/10,000 行合成夹具验证（不读取真实记录）：

```sh
bash tests/run_session_performance_native.sh
(cd macos/ZhiBoApp && swift build -c release)
```

测试检查 LRU 的 8 条上限、字节淘汰、过期清理、值相等、二分时间定位，以及千行搜索；大数据夹具用于发现主线程重排和线性扫描回归。脚本按 `-O` 编译核心，断言缓存中位数低于 100 ms、10,000 行规范化低于 500 ms。

Agent 原生测试还覆盖 50 条消息的会话在“主页 → 记录 → 主页”和“主页 → 日历 → 主页”之间快速往返：返回主页时原生对话容器保持同一身份；滚动不重建每行，历史会话切换恢复原滚动位置，隐藏页面不残留工具栏按钮，页面切换不交叉淡出。

## 日历与原生日程笔记

```sh
.venv/bin/python tests/test_calendar.py
bash tests/run_calendar_native.sh artifacts/calendar-native
bash tests/run_settings_native.sh
bash tests/run_session_detail_native.sh
bash tests/run_interface_text_selection_native.sh
```

日历后端检查使用临时数据库，不访问个人记录或钥匙串；覆盖重复迁移、版本冲突、多对多关联、引用保留、删除恢复、重复例外改期、全天跨月、全量失败保护、断开缓存、任务创建关联与副本规则，以及 CalDAV 客户端对本地协议服务器的实际读取和增量截断保护。

原生检查使用 URLProtocol 夹具，不启动真实采集；覆盖主页卡片、1020/1440 布局、浅深色、同日程笔记模型复用、直接编辑、保存与冲突草稿保留。直接视图缓存的截图不完整呈现系统玻璃材质，真实材质以运行应用的窗口截图为准。

后端测试在临时数据目录执行，不访问实际记录、不启动语音模型，覆盖三类记录的独立保存、处理期间编辑、清空笔记、重启恢复、导出原文/标记/截图及会议与直播副本：

```sh
.venv/bin/python tests/test_meeting_notes.py
```

原生验证使用模拟后端，检查保存中的持续输入、失败恢复、空草稿、Markdown 解析和原生编辑撤销：

```sh
swiftc -parse-as-library \
  tests/meeting_notes_native.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/DesignTokens.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/GlassSegmentedControl.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/MeetingControls.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/MeetingNotesView.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/NotesMarkdown.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/NotesMarkdownPreview.swift \
  -o /tmp/meetclip-notes-native-tests
/tmp/meetclip-notes-native-tests
```

可追加输出目录参数，截取测试窗口中的原生编辑区和 Markdown 预览供排版检查（需已有屏幕录制权限且 macOS 未锁屏，否则跳过截图）：

```sh
/tmp/meetclip-notes-native-tests /tmp/meetclip-notes-preview
```

Agent 流式中继验证覆盖 OpenAI-compatible SSE 原文转发、UTF-8 跨块、工具响应排除、最终回答追加、活动提示清理、未知 token 拒绝和上游 URL 约束；不访问真实模型或读取凭据：

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python tests/test_agent_stream_proxy.py
```

Agent 原生检查额外覆盖 DSH 活动提示、首个最终增量清除提示、连续增量不重复，以及停止后已显示正文保留。

详情页验证直接编译并操作会议、直播和视频的生产视图，以模拟协议拦截全部网络请求，不启动真实后端。检查「会议 / 直播 / 视频」场景文案、标题下方的玻璃切换位置、直播与视频的画面位于转写文字上方，切到笔记后默认显示可选择的 Markdown 预览并隐藏画面；预览粘贴会写回模型并自动保存，显式编辑模式保留撤销与自动保存。界面文字选择检查覆盖跨多个文字块拖动选择、⌘A、⌘C、编辑器和预览页粘贴，并确认按钮标签不进入可选文字集合。可选输出目录生成三个模块的内容和预览截图；先执行 `swift build` 生成资源包：

```sh
bash tests/run_session_detail_native.sh /tmp/meetclip-session-detail-preview
```

详情刷新取消与请求乱序验证可单独运行 `bash tests/run_session_detail_native.sh --refresh-only`：取消请求不显示错误，真实连接失败仍可见，成功重试清除错误，旧请求失败不会覆盖较新的成功结果。

详情页验证同时覆盖直播、视频与会议的统一时间戳转录：仅有流式文字时直接进入原生转写列表，同一片段持续更新且保留选择、时间戳链接与搜索高亮，完成后不重复；空片段不生成空行，重新转写在原时间段显示新文字，失败后恢复已保存文字，首次转录中断后仍可阅读已识别内容。可选输出目录增加三类场景的 `*-inline-transcript.png` 截图。

说话人合并验证覆盖重名后暂不合并、确认合并全部发言、会议之间的数据隔离、笔记与标记保留、重启后的持久化及导出统计：

```sh
.venv/bin/python tests/test_speaker_merge.py
```

原生重名检测验证覆盖名称未改变、空白名称、首尾空白、不同拼写及多位同名者时的一次两人合并：

```sh
swiftc -parse-as-library \
  tests/meeting_speakers_native.swift \
  macos/ZhiBoApp/Sources/ZhiBoApp/SpeakerEditing.swift \
  -o /tmp/meetclip-speakers-native-tests
/tmp/meetclip-speakers-native-tests
```

## 设置页原生验证

直接渲染生产设置视图，以 URLProtocol 拦截全部网络请求，不启动真实后端、不修改用户配置。覆盖「通用 / 直播 / 视频 / 会议」原生鼠标切换、浅/深色、固定窗口尺寸、原高级项归入通用并可滚动访问、导航固定、玻璃菜单、Cookie 开关保存、直播截图阈值方向与保存、扫码区域展开、保存失败保留旧值与重试恢复，以及模型未下载与下载中状态。可选目录输出原生截图：

```sh
(cd macos/ZhiBoApp && swift build)
bash tests/run_settings_native.sh /tmp/meetclip-settings-preview
```

## 工具栏玻璃背景验证

```sh
bash tests/run_toolbar_native.sh /tmp/meetclip-toolbar-native
```

直接渲染生产 `DetailToolbar`、`RecordToolbar` 和日程笔记窗口，以模拟协议拦截笔记请求，不启动真实采集或后端。检查停止、开始采集、取消处理在浅／深色和检查器展开／收起时只使用自身的玻璃背景，检查器使用单一系统工具栏背景，覆盖禁用状态和真实鼠标点击。日程笔记检查导出和版本冲突后的重新载入按钮。停止采集、取消处理、内录、排队和模型下载共用 `StopActionButton`，工具栏图标为 36 pt、普通内容区为 32 pt、紧凑区域为 24 pt。检查按钮实际宽高和垂直中心、内录文字按钮高度，以及任务进度不重复显示停止按钮，追加浅／深色展示检查。可选输出目录生成 19 张实际窗口截图，需要已有屏幕录制权限；视觉检查使用系统合成的窗口截图，不用视图缓存代替玻璃材质。


云端 ASR 验证使用模拟 HTTP、临时数据库和凭证替身，不访问真实网关或写入钥匙串：

```sh
.venv/bin/python tests/test_cloud_asr.py
```

覆盖 WAV 参数、Base64 实际大小切分、SSE 增量结果与 JSON 回退、限流重试、权限失败与日志脱敏、流中断、截断、取消、片段幂等提交、重启恢复、重新转写保留旧文字与说话人、文件补转录跳过已完成片段，以及 60 分钟音频长度的模拟直播处理。模拟直播不等待一小时，也不证明真实服务延迟；真实网关验证使用 `eval/asr_cloud_probe.py`。


云端预览的原生状态验证包含在 `bash tests/run_session_detail_native.sh --refresh-only`：同一片段增量文字替换、错误状态保留、正式提交后重新加载；`bash tests/run_settings_native.sh` 验证 MiMo 设置、网关和安全输入框，并覆盖浅／深色设置页面。完整详情页鼠标烟雾测试目前在进入笔记时的 `editor.isEditable` 断言失败（项目现有笔记默认进入预览），不计入本次通过项。

云端预览顺序回归也包含在 `--refresh-only`：详情快照已读取完整结果时跳过旧逐字事件、慢刷新不回退已收到的文字、正式提交后预览不重新出现、重新转写隔离上一轮事件，以及真实 SSE 解析与断线续传。首次事件连接携带快照的游标，画质提示和采集状态从快照恢复。`test_cloud_asr.py` 同时以线程同步模拟数据库更新与事件发布之间的间隙，检查预览、片段提交与整轮提交均不会向详情暴露不匹配的结果和事件游标；使用临时数据库和模拟网关。

## 全局搜索

隔离数据库检查四类保存文字、字面子串、排序去重、分页、跨月 iCalendar 与离线资料：

```sh
.venv/bin/python -m unittest discover -s tests -p test_search.py
bash tests/run_global_search_native.sh artifacts/global-search/native
```

原生检查使用模拟后端，覆盖横排三个图标、居中搜索卡片、三尺寸浅深色与减少动画、每次重置、焦点与键盘、中文组字、五类筛选与分页、内容／笔记定位、独立日程笔记窗口、取消与迟到请求。新版交互详见 `artifacts/global-search-overlay/README.md`，原检索能力记录保留在 `artifacts/global-search/README.md`。


## Agent 插件验收

统一能力注册表、接口覆盖、严格参数、授权范围、确认/重放、文件选择回调及缓存验证（临时数据库、假运行时，无真实模型或平台请求）：

```sh
.venv/bin/python tests/test_agent_capabilities.py
.venv/bin/python tests/test_agent_runtime_cache.py
.venv/bin/python tests/benchmark_agent_tools.py --records 1000 --segments 100 --output .build/agent-tools-verification/synthetic.json
```

原生 Agent 验证另覆盖文字增量、重复增量、迟到快照与受认证的原生动作回执；完整流程和功能目录见 `docs/agent-integration-method.md`。

Agent 权限、真实运行时与 SwiftUI 验证见 [交付记录](../artifacts/agent-production/README.md)。隔离后端测试运行 `.venv/bin/python tests/test_agent.py`；原生三尺寸检查运行 `bash tests/run_agent_native.sh artifacts/agent-production/native`。真实执行器权限检查运行 `.venv/bin/python tests/codex_isolation_probe.py`，使用本机 CLI 和确定性 Responses，不调用实际模型。
