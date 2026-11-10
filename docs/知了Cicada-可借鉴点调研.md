# 知了 Cicada 调研：可以搬进「会摘 MeetClip」DSH 插件的东西

> 调研对象：<https://github.com/wquguru/cicada>（Apache-2.0；首次公开 1.0.0 于 2026-11-03，本报告基于 `main` @ `a5799a8`，`VERSION` 1.1.1）
> 调研方式：克隆仓库通读 Swift 主端（`Sources/LiveSubs/`，约 2.1 万行）+ 对照本插件现有实现（`backend/`、`src/host/`、`client-src/`）。
> 结论一句话：**它把"转写之后的最后一公里"（结构化纪要、说话人是谁、双语字幕、会后导出、会自己结束）做成了产品，而这正是会摘现在缺的一段；其中约 3/4 的机制与平台无关，能直接搬到我们的 Python 后端 + React 面板里。**

---

## 落地状态（0.4.0，2026-11-05）

"最值得搬的 5 件"已经实现并跑通测试，原始分析保留在下面，作为设计与取舍的依据。

| # | 借鉴点 | 落地位置 | 验证 |
|---|---|---|---|
| 1 | 增量纪要引擎 | `backend/app/minutes.py`、`minutes_prompt.py`、`session_minutes` 表、`routes/minutes.py`、`client-src/components/MinutesPanel.jsx` | `tests/test_minutes.py`（16 项） |
| 2 | AI 调用治理层 | `backend/app/ai/{providers,gate,keys,client,metrics}.py`、`routes/minutes.py` 的 `/api/ai/*`、`SettingsMinutes.jsx` | `tests/test_ai_layer.py`（10 项） |
| 3 | 说话人产品规则 | `backend/app/speaker_labels.py`、`routes/speakers.py`、`SpeakersPanel.jsx` | `tests/test_speaker_labels.py`（10 项） |
| 4 | 文本卫生 + 导出补齐 | `backend/app/text_hygiene.py`、`export_srt.py`、`export_md.py`、`SessionDetail.jsx` 导出弹层 | `tests/test_text_hygiene.py`、`tests/test_export_formats.py` |
| 5 | 自动结束 + 静音裁剪 | `backend/app/meeting_end.py`、`capture.py`（看门狗、`-t` 裁尾）、`/keep-going` 接口 | `tests/test_meeting_end.py`（8 项） |

宿主侧新增工具 `meetclip_minutes`（`get` / `regenerate`，重新生成走 approval），
`tests/host.test.mjs` 覆盖注册与数量。前端新增"纪要"页签、设置里的"纪要（AI）"分节、
发言人面板的"从对话里认人 / 就是他 / 不是 / 撤销"，交互冒烟会点开纪要页签断言内容。

**与知了不一致的取舍**（都在代码注释里写了原因）：

- 覆盖率按**秒**而不是行号记账——MeetClip 终稿会用 `replace_transcripts` 整表重插，行 id 不可依赖；
- 终稿分窗口（300 行/窗）而不是一次塞整份转写，避免两小时会议的提示词失控；
- "静音"只在直播采集上生效（会议/链接视频是一次性转写，没有"还在进行"的概念）；
- 说话人编号规则只做**提示层**，不改写已存的 `meta["speakers"]`，避免影响既有导出与原生端读数。

## 0. 项目速览

| 项 | 知了 Cicada | 会摘 MeetClip |
|---|---|---|
| 定位 | **实时旁听**：听电脑播放的声音（或会议室麦克风），出双语字幕、同传、边听边写纪要 | **采集归档**：B 站直播、链接视频、会议文件，落成记录 + 转写 + 打点 + 人工笔记 + Agent 检索 |
| 形态 | macOS 菜单栏 App（SwiftUI，零第三方依赖）+ Windows/Linux/Android 移植，四端共用一个版本号和同一种记录格式 | DSH 插件：Host（Node ESM）+ Client（React）+ fork 的 FastAPI 后端 + 独立 venv |
| 存储 | 每场一个文件夹：`session.json` + `system.m4a` + `mic.m4a` + `metrics.jsonl` | SQLite + 每场媒体目录 + HLS + SSE |
| AI | 语音识别本机（SpeechAnalyzer）；翻译/纪要/同传走 Ling（蚂蚁）API，可切 OpenRouter/ZenMux/OpenAI/任意 OpenAI 兼容 | ASR 走 Mify/MiMo 云识别或本地 Qwen3-ASR；**没有任何 LLM 文本能力** |
| 许可 | Apache-2.0；声纹模型 WeSpeaker ResNet34-LM 为 CC BY 4.0 | 自有 |

两者不冲突：会摘负责"把内容弄进来并留住"，知了负责"当场听懂并总结"。我们要补的正是后半段。

**会摘现状（本次核对过的）**

| 能力 | 现状 | 证据 |
|---|---|---|
| 实时增量转写 | **已有**：云识别按 chunk 落盘并 `emit("transcript_partial"/"transcript_chunk_done"/"transcript_reset")` | `backend/app/cloud_transcription.py:52-117` |
| 转写行结构 | `transcripts(start, end, text, speaker, ...)`；终稿时 `replace_transcripts` **整表删了重插**（自增 id 会变） | `backend/app/database.py:32-40`、`:555-567` |
| 说话人 | 已有 pyannote 分段 + `meta["speakers"]`（原始标签 → "发言人 N"）+ 改名/合并接口 | `backend/app/speaker_attribution.py`、`routes/meetings.py:104` |
| LLM 纪要 / 摘要 | **无**（后端只把 Mify/MiMo 当 ASR 用，除字幕轨识别外没有任何 LLM 文本调用） | 全仓 grep `summary/llm/openai/translate` |
| 双语 / 翻译 | **无**（`subtitles.py` 能识别平台的"人工/自动/翻译"字幕轨，但不生成译文） | `backend/app/subtitles.py:57-75` |
| 导出 | 仅 Markdown 与 ZIP | `routes/sessions.py:681,690`；`export_md.py` |
| SSE | 有，`GET /api/sessions/{sid}/events` | `routes/sessions.py:610` |
| Agent 工具 | 8 个 `meetclip_*`，有界（转写 ≤200 行/约 12k 字，导出 ≤20k 字），删除走 `ctx.get('approval')` | `src/host/tools.js:20-330,706-731` |
| 密钥 | macOS Keychain，服务名 `cn.meetclip.asr` | `backend/app/asr_engines.py:20,72` |

也就是说：**管道已经通了，缺的是"接上去的那台机器"。**

**合法性前提**：Apache-2.0 允许直接移植代码/提示词/文案（保留版权与 NOTICE）；若日后打包 WeSpeaker 声纹权重，需在"关于"里署名 CC BY 4.0。

---

## 1. 结论先行：14 条借鉴点，按「值不值 / 贵不贵」排

| # | 借鉴点 | 知了出处 | 会摘落点 | 价值 | 工作量 |
|---|---|---|---|---|---|
| **P0-1** | 增量式实时纪要引擎（带时间锚点、术语表、鱼骨图、终稿重写） | `Notes.swift` | 新增 `backend/app/minutes.py` + SSE + 面板 | ★★★★★ | 4–6 人日 |
| **P0-2** | AI 调用治理层（优先级闸门、限速、退避、关思考、反劫持、按供应商塑形） | `Ling.swift` `AIProviders.swift` | 新增 `backend/app/ai/` | ★★★★★ | 2–3 人日 |
| **P0-3** | 本地诊断指标（每场 `metrics.jsonl`，p50/p95，只记数字） | `Diagnostics.swift` | 后端 + 设置页"复制诊断" | ★★★★☆ | 1–2 人日 |
| **P1-4** | 说话人呈现规则与"命名/合并/撤销"（5 句才编号、编号不回退、证据邻域校验、名字回填纪要） | `SpeakerID.swift` | `SpeakersPanel.jsx` + 后端 | ★★★★☆ | 3 人日 |
| **P1-5** | 翻译链 + 半句/整句分流 + 翻译清洗 + 术语表一致 | `Translator.swift` | 后端 subtitle/双语层 | ★★★★☆ | 3–4 人日 |
| **P1-6** | 会议自动结束 + 静音裁剪 + 空记录不留 | `MeetingEnd.swift` | 采集/会议录制生命周期 | ★★★★☆ | 1–2 人日 |
| **P1-7** | 长文件导入流水线（先建记录、阶段进度、取消保留、语言采样、按句切分） | `FileImport.swift` | `link_video.py` / `meeting.py` 对齐 | ★★★☆☆ | 2 人日 |
| **P1-8** | 文本卫生：识别噪声清洗、定稿不如草稿则用草稿、断句续接 | `HeardText.swift` | ASR 后处理 | ★★★★☆ | 0.5–1 人日 |
| **P1-9** | 导出补齐 SRT/VTT（+纪要进 Word） | `TranscriptExport` | `export_md.py` 旁新增 | ★★★★☆ | 1 人日 |
| **P2-10** | 引导里放"示例会议"，首启即见成品 | `Onboarding.swift` + `Resources/sample` | `SetupWizard.jsx` | ★★★☆☆ | 1 人日 |
| **P2-11** | 诚实 UI：弱证据灰显、"纪要落后 N 句"提示、点击跳回原话 | `NotesViews.swift` | 纪要面板 | ★★★★☆ | 与 P0-1 同期 |
| **P2-12** | 可撤销的说话人编辑（快照回滚） | `SessionStore.VoiceSnapshot` | `SpeakersPanel` | ★★★☆☆ | 0.5 人日 |
| **P2-13** | 隐私叙事与密钥纪律（0600 文件、不进日志/导出/备份、无遥测） | `Ling.swift` `AIKey` | 设置页 + 后端 | ★★★☆☆ | 0.5 人日 |
| **P2-14** | 依赖/模型下载校验 SHA-256 | `Updater.swift` | 一键装环境 | ★★☆☆☆ | 0.5 人日 |

> 说明：P0 = 一个迭代内能见效；P1 = 第二个迭代；P2 = 顺手做。人日为单人投入的保守估计，含自测。

---

## 2. P0 详解

### 2.1 增量式实时纪要引擎（最值得抄的一块）

**知了怎么做的**（`Sources/LiveSubs/Notes.swift`，501 行）

- **节流**：每 45 秒一次；但"第一条纪要"要快——满 3 句或距上次 20 秒就发。
- **增量而非全量**：请求 = `当前纪要 JSON` + `已覆盖的最后 2 句（仅作上下文）` + `新句子`；模型返回**整份更新后的纪要**。用 `covered`（已覆盖到第几行）判断有没有新内容，没新行就不调用。
- **每条论断带证据行号**：prompt 里每句转写渲染成 `[L12 03:41 说话人2] 原文…`，模型输出的 topic / point / 结论 / 待办 / 鱼骨分支都必须带 `evidence: ["L12","L13"]`。解析时把行号映射回秒数 → 界面"点击跳回原话"，`support`（证据句数）为 0 的条目**灰显**。
- **时间锚点只前移不后移**（`carryTimes`）：模型重复输出老要点时不带证据，就沿用老时间；同一要点若两处都有证据，取更早的。
- **终稿重写**：会议结束时用**整份转写**重写一次（`final`），并把主题数按会议时长封顶 `min(8, 分钟数/3 + 1)`；直播更新时若当前主题开始不到 2 分钟，明确禁止开新主题（"否则模型拆得太碎"）。
- **语言漂移双保险**：终稿只给转写、没有"目标语言的现有纪要"作锚，长英文会议里模型会跟着英文写。做法是：指令末尾再强调一次语言 + 检字脚本比例（`written()`）+ 不对就重试一次 + 仍不对就丢弃、保留旧纪要。
- **失败绝不覆盖好结果**：解析失败/语言不对 → 保留上一版，状态置 `failed`；只有解析成功才写盘。
- **并发排队**：正在更新时又来了"终稿"或"切换纪要语言"，进 `pendingFinals` / `pendingRewrite` 队列，按序补跑，不丢。
- **"新"标记**：本轮新增的标题/要点高亮 60 秒（`markFresh`），让用户一眼看到"刚刚总结出了什么"。

**场景模板（未发布补充）**：Cicada 本身只有一套会议模板（JSON schema + prompt 规则 + 展示顺序）。会摘在这套基准上按记录类型派生三套，JSON 键完全一致，`parse()`、MCP 与导出都不用改数据结构：

- 会议：Cicada 原样——结论和待办 → 总结 → 主题（鱼骨图）→ 人名和术语；
- 视频：总结 → 章节 → 要点 → 可行动项 → 人名和术语；标题参考平台标题但不照抄标题党写法，待办只写视频明确要求的行动；
- 直播：总结 → 看点 → 结论 → 后续 → 人名和术语；结论写正式公布/反复强调的信息，后续写预告或后续动作。

实现：`backend/app/minutes_scenarios.py`（模板与 prompt 差异）、`backend/app/minutes_notes.py`（写进笔记的 Markdown 段落与同步）；场景按 `sessions.kind` 自动选择。模板来源为 Apache-2.0，代码头与 README 保留出处。

**为什么有效**（写进代码注释的硬教训）

1. 交给模型"整份纪要 + 新增句子"比"自己合并两份纪要"稳定一个量级；
2. 强制 `evidence` 是幻觉的最低成本解药，同时白送"跳回原话"；
3. 主题粒度必须显式约束（时长上限 + 禁止 2 分钟内换主题），否则纪要碎成流水账；
4. 语言/JSON 的失败模式必须显式检测并丢弃，否则脏数据会一路进导出。

**会摘怎么落**

后端（Python）：

```
backend/app/minutes.py        # 引擎：节流、增量、终稿、排队、语言校验
backend/app/minutes_prompt.py # 提示词模板（可直接由 Notes.prompt 改写）
```

数据（沿用现有 SQLite 风格，`backend/app/database.py`）：

```sql
CREATE TABLE IF NOT EXISTS session_minutes (
    session_id  TEXT PRIMARY KEY,
    data        TEXT NOT NULL,      -- 整份 JSON（title/summary/topics/conclusions/todos/terms）
    covered     INTEGER NOT NULL,   -- 已覆盖的转写行数
    kind        TEXT NOT NULL,      -- live | final
    lang        TEXT NOT NULL,      -- 纪要语言
    updated_at  TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS session_terms (      -- 术语表，供翻译/搜索复用
    session_id TEXT NOT NULL, name TEXT NOT NULL, note TEXT,
    heard      TEXT,                            -- 误听变体，JSON 数组
    PRIMARY KEY (session_id, name)
);
```

触发点：`backend/app/cloud_transcription.py` 已经在逐 chunk 识别时 `emit("transcript_partial")`（草稿）和 `emit("transcript_chunk_done")`（定稿），终稿时 `finish()` 会 `replace_transcripts` 并 `emit("transcript_reset")`。纪要引擎只要订阅同一族事件（或轮询 `asr_chunks` 里 `state='done'` 的行）即可，**不需要动采集管线**。

两个必须注意的坑（我在会摘这边核对出来的）：

1. **锚点存秒数，不要存 transcript 自增 id** —— 终稿时 `replace_transcripts()` 是 `DELETE` 后重插（`database.py:555`），id 全部作废；`asr_chunks.chunk_id`（`run:start:end`）稳定但也只在同一个 run 内有效。所以 evidence 一律换算成 `(start_seconds)`，终稿重写时按时间重新匹配。
2. **live 阶段的一行 ≠ 终稿阶段的一行** —— live 拿的是 chunk（可能 20–60 秒一整段），终稿会被 `sentence_units()` / `transcript_segments.py` 重排成句/段。增量纪要时把 chunk 当"行"没问题，但终稿必须用重排后的行，`covered` 计数要按"已喂到第几秒"而不是"第几行"更稳。

接口与前端：

- 接口：`GET /api/sessions/{sid}/minutes`（读）、`POST /api/sessions/{sid}/minutes/regenerate`（重跑终稿）；
- **SSE 新事件** `minutes_updated`（只带 version + 主题数，正文再拉，避免长连接里塞大 JSON），复用现有 `GET /api/sessions/{sid}/events`；
- `client-src/components/SessionDetail.jsx` 加"纪要"页签，`NotesEditor.jsx` 的**人工笔记保持独立**（当"批注"用，别和 AI 纪要混一栏）；
- Host 工具：新增 `meetclip_minutes`（`get` / `regenerate`），结果有界（主题 ≤8、每条 ≤200 字），`regenerate` 直接复用 `src/host/tools.js` 里现成的 `requireApproval()`（花钱的操作必须问一句）。

**成本与参数建议**：知了每 45 秒一次，1 小时 ≈ 80 次调用，单次约 2–4k 输入 + 1–2k 输出 token。会摘是"采集完再看"，可以更省：默认 **90 秒或新增≥8 行才触发**，会后一次终稿；设置里给"实时纪要：关/省/快"三档。

**直接可用的提示词骨架**（由 `Notes.prompt` 改写，中文化后即可用）：

```
你在为一场「还在进行/刚刚结束」的会议维护纪要。用{语言}写，只返回 JSON。

当前纪要：{json}
已覆盖（仅上下文）：[L{from-2} …]
新句子（编号, mm:ss, 说话人）：[L{n} 12:03 说话人2] …
（终稿时：本次会议长 {X} 分钟，主题最多 {min(8, X/3+1)} 个）

返回 {"title","summary","topics":[{"start","title","summary","points":[{"text","evidence":["L4"]}],"fishbone":null|{...}}],
      "conclusions":[{"text","evidence"}],"todos":[{"text","owner","evidence"}],
      "terms":[{"name","note","heard":["误听写法"]}]}

规则：
- 标题 ≤12 字；summary ≤3 句；主题 3–10 分钟一个，最多 8 个，不到 2 分钟不许开新主题，能合就合；
- 每主题 ≤4 个要点，结论 ≤5 条，待办只写真正的待办；
- 每个主题/要点/结论/待办/鱼骨分支都必须给 evidence（原句编号），不许写转写里没有的话；
- terms ≤10 个，优先"转写里听错的人名"，其次读者不懂的人/地名/行话；name 用正确写法，heard 只列转写用过的错写法；
- 只写会上的内容，不要评论转写质量；没内容就给空数组。
```

### 2.2 AI 调用治理层（所有 AI 功能的地基）

**知了怎么做的**（`Ling.swift` + `AIProviders.swift`）

- **一个闸门，按优先级排队**：`speak(0) < translate(1) < notes(2)`，同优先级 FIFO，两次请求起始间隔按供应商配置（Ling 账号约 2 次/秒 → `spacing 0.6s`；聚合商 0.1s）。任何新功能都必须走这个闸门，不自己发请求。
- **重试分档**：纪要 429 重试 4 次、指数退避 + 抖动；翻译/同传**只试 1 次就失败**，好让上层立刻降级到 Google——"实时功能不能为了一次重试卡住 2 秒"。
- **关思考**：每家写法不同（`thinking:{type:disabled}` / `reasoning:{enabled:false}` / `reasoning_effort:"none"`），实测 Ling 开思考 **+2.6 秒且计费**。
- **反劫持**：内容放 **system message**、user message 只放固定指令（"Translate."），因为网关会把"像事实问题"的用户消息当搜索请求，回一篇带"根据检索…"的作文；命中前缀就丢弃重试。
- **JSON 模式**：纪要开 `response_format: json_object`；自定义服务还要额外测一次"你到底支不支持 JSON"，不支持就在设置页明说"纪要用不了"。
- **key 校验用最省的请求**（Ling 用最小模型 + max_tokens=1；OpenRouter 查 key info；OpenAI 列模型），并且区分"key 无效/服务连不上/模型名不对"三类错误再给文案。
- **每次调用落一条指标**：provider / model / role（translate·notes·speak·speakers）/ 优先级 / 排队时长 / 耗时 / 结果 / tokens。

**会摘怎么落**

```
backend/app/ai/gate.py      # 优先级闸门 + spacing（asyncio）
backend/app/ai/client.py    # chat()：shape、重试分档、JSON、劫持检测、指标上报
backend/app/ai/providers.py # ling/openrouter/zenmux/openai/custom 表 + 每家 shape()
backend/app/ai/keys.py      # 复用现有 Keychain（后端已用 cn.meetclip.asr），或 0600 文件
```

注意：会摘现有的云端识别只是**云 ASR**，纪要需要**文本模型**。两条路：① 同一把 key 走 OpenAI 兼容 `/chat/completions`（先探测模型列表）；② 允许单独配"纪要模型"。建议做成统一的 `providers.py`，Mify 只是其中一行。

### 2.3 本地诊断指标

`Diagnostics.swift` 的要点很少但很值：

- 每场一个 `metrics.jsonl`，一行一条（`type: sentence|call`），**只记数字**：识别耗时、排队、翻译耗时、走了哪个供应商、失败的供应商与原因、tokens；
- `p50 / p95 / n` 三个数就够定位"是网络还是模型慢"；
- "复制诊断信息"生成的是纯文本、**只含数字**，可以放心贴给作者；
- 草稿翻译（每秒刷新那种）只计数不逐条落盘，否则日志会把有用数据埋掉。

会摘落点：`<dataDir>/<sid>/metrics.jsonl` + `GET /api/sessions/{id}/metrics` + 设置页"复制诊断"。跨记录再给一个库里视图（最近 7 天 p95）。

---

## 3. P1 详解

### 3.1 说话人：呈现规则比算法更值钱

知了的声纹方案（WeSpeaker ResNet34-LM 256 维 + 在线聚类，`join/startNew = 0.5`，≥2 秒才起新簇，AMI 上标定）对我们意义有限——会摘后端本来就有 pyannote 和说话人分段。真正该抄的是它的**产品规则**：

1. **一个声音攒够 5 句"有内容"的话才显示编号**；且**至少两个声音都够了才编号**，否则一对一通话里全程都叫"对方"（避免"说话人 1 说了整场"的噪音）。
2. **编号一旦显示就不再变**（按首次达到阈值的时间排序），新声音只能往后加。
3. **不回头改已标注的行**——宁可留"对方"，也不要让文字在屏幕上跳动。
4. **改名的优先级**：用户命名的 > 模型猜的 > "说话人 N"；用户选"就叫说话人 N"是一个显式状态（空字符串），要能压住模型的猜测。
5. **模型猜名字必须有证据**：只从对话里认人（"Thanks, George" 紧跟着说话人 1 的回答），并要求给出证据行号；解析时**校验证据行 ±2 行的邻域内确实有这个声音在说话**，否则判定为"广告/片头里的自我介绍"直接驳回（`refuted`），连之前存过的同名猜测一起撤掉。
6. **同一名字给了两个声音时，给话多的那个**。
7. **名字要回填进纪要文本**：纪要里模型可能写"说话人 6 提出…"，改名后展示层做 `说话人 N → 姓名` 替换（降序替换，防"说话人 1"吃掉"说话人 12"）。
8. **撤销**：编辑前拍一份快照（每行的 voice + 姓名 + 猜测），⌘Z 恢复；快照之后新来的行保持现状。

会摘落点：`client-src/components/SpeakersPanel.jsx`（已有改名/合并），补"猜测名字 + 证据 + 一键采纳/驳回"；后端 `speaker_names` 表存 `name / evidence_line / source(user|model) / state(accepted|refuted)`；展示层做编号规则与回填。

### 3.2 翻译链与"半句/整句"分流

- **链路**：有 key 走大模型（带术语表，保证人名一致）→ 失败退 Google 翻译 → 再退本机模型；Google 429 时**退避 10 秒**内直接跳过它，不反复撞墙。
- **半句不进大模型**：正在说的半句话每秒刷新，用 Google 翻（免费/快）；只有**定稿的整句**才花大模型的钱和配额。这一条直接决定"实时字幕能不能开"。
- **翻译清洗（约 60 行正则/规则，最脏最值的部分）**：模型偶尔"评论"而不是翻译（"这段字幕似乎是乱码，以下是最接近的翻译："），偶尔把思考过程漏出来（`</think>` 之后才是正文），偶尔翻错语言。做法：丢弃像评论的行、剥掉 `Translation:` 标签、取 `</think>` 之后的内容、**按目标语言的字符类型校验**（中日韩目标必须大量 CJK，其他目标不能大部分是 CJK），不合格就返回 nil 让下家翻。
- **同传/对译一次性两步**：一次调用返回 `ORIGINAL: … / TRANSLATION: …` 两行，除这两行外全部丢弃——"绝不能把没翻译的话说进会场"这条硬规矩，对应到我们会摘就是**绝不把清洗不过关的机翻写进记录/导出**。
- **导入文件排在直播之后**：转写文件时的翻译请求优先级设为 notes 级，不抢实时字幕的通道；并发上限 3，失败重试 3 次（5s/15s）。

会摘落点：这决定"链接视频（外语）"能不能出双语记录与双语字幕。落 `backend/app/subtitle_translate.py`，与现有 `subtitles.py`（已能识别 manual/automatic/translated 字幕轨）对接：**有官方翻译字幕轨就优先用，没有才机翻**，并把"字幕来源"写进导出元信息（现有 `export_md.py` 已有该字段）。

### 3.3 会议自动结束 + 静音裁剪

`MeetingEnd.swift`（99 行，纯函数 + 状态机）值得整段搬：

- **双信号**：主信号是"会议 App（Zoom/腾讯会议…）原来占着麦克风，现在放开了"——这就是外部能看到的挂断；给 30 秒宽限（切设备会短暂掉麦）。兜底信号是"很久没有识别出词"。
- **按"词"计时，不按"声音"计时**：背景音乐、空调声不续命；但**只要会议 App 还在通话中，静音就不计时**（静音看直播也是开会）。
- **两种收尾方式**：`prompt`（先问"还要继续吗"，60 秒倒计时，可"继续记录"）与 `end`（直接结束）。
- **一句没说过**（`said=false`）：安静地停，不进倒数，也**不留空记录**（"空房间不该被听一晚上"）。
- **结束时间要用来裁录音**：按真实结束时刻裁掉尾部空白（`finishAudio(until:)`）。

会摘落点：直播采集（B 站下播）/ 会议录制两个生命周期。B 站有直播状态可查，可作为"挂断"信号；会议录制没有外部信号，就只用"长时间无词 + 询问"。

### 3.4 长文件导入流水线

`FileImport.swift` 的几个选择，正好补我们会摘导入的边角：

- **先建记录再转写**：记录立刻出现在列表里（带"进行中"状态），而不是转完才出现。
- **阶段可见**：`准备 → 识别语言 → 下载模型(语言) → 转写 → 翻译`，进度按"已转写秒数/总时长"，翻译阶段按"已翻译行/待翻译行"。
- **取消保留已完成部分**，状态落到"未完成"，界面上给"重新转写"（重跑会清空旧行与旧纪要）。
- **语言检测用文件里 3 个片段（15% / 45% / 75%）打分求和**——片头常是音乐或静音，只取开头会判错。
- **一整段没有停顿的识别结果**（演讲、念稿）按句末标点切行，"Mr. / OK." 这种短句并到下一句；每行时间取该句第一个词的时间。
- **推进策略**：老识别器一次只能跑一个流时，"会议优先"，文件流在会议安静时继续 —— 单实例资源竞争时的调度思路。

会摘现状：`link_video.py` / `meeting.py` 已有阶段与队列，主要补 ①②③（记录先行、取消保留、语言采样）。

### 3.5 文本卫生（半小时的活儿，天天受益）

`HeardText.swift`：

- `clean()`：把 `in..........`、`, , that`、`. , that is` 这类呼吸/犹豫噪声归一（多句点→省略号、重复逗号→一个、标点前空格去掉），并去掉行首残留标点——"翻译会把行首的 `,` 变成 `，……`"。
- `fuller(final, draft)`：**定稿比草稿少了 15% 以上/少 3 词以上时，用草稿**（实测快速说话时定稿会整句丢词，草稿只是偶有拼错）。
- `continues(prev, next, gap, cut)` + `join()`：间隔 ≤1.5 秒、上句不足 40 词、上句不是问号感叹号结尾 → 认为是一句话被停顿切开，拼接时去掉上句那个"猜出来的句号"。

会摘落点：`backend/app/transcript_segments.py` 旁加一个 `text_hygiene.py`，在落库前跑；对云端 ASR 的 chunk 拼接尤其有用（我们现在是 chunk 边界切，天然会切碎句子）。

### 3.6 导出补齐

知了三种导出，都是小事但很显功力：

- **Markdown**：标题 + `日期 · 时长` + 纪要（主题按时间排序、结论、待办 `- [ ]`、人名术语）+ 逐行文字记录，每行 `**[03:41] 姓名**` + 原文 + 引用块译文。
- **SRT**：用**下一行的时间**推本行结束时间，夹在 `[t+1, t+8]` 之间；有译文就补一行双语。
- **docx**：同样的结构，纪要在前、转写在后，字号/灰阶分两级。

会摘现状只有 Markdown / ZIP。建议：`export_srt.py`（SRT + VTT，VTT 顺手加 `speaker` cue 标签）、`export_docx.py`（python-docx 已在工具链里），并把纪要写进 Markdown 导出的第一段。

---

## 4. P2：产品与工程细节

1. **引导里放成品**（`Onboarding.swift` + `Resources/sample/sample.m4a`）：第二步就让用户听一段打包好的双人示例会议、当场看到字幕/纪要效果，再谈装模型和填 key。会摘的 `SetupWizard.jsx` 现在是"装环境、下模型、填 key"，可以插一条"看一条示例记录"（预置一条 60 秒的演示记录 + 已生成纪要），让首启不是空墙。
2. **诚实 UI**（`NotesViews.swift`）：证据只有 1 句的条目降级灰显并标"依据 1 句"；纪要落后时在最后一行显示"还有 N 句没整理"，点一下跳到那一段。比"假装全知"更可信。
3. **可撤销**：说话人/名字/纪要的编辑都给快照回滚（`VoiceSnapshot`）。
4. **密钥纪律**：0600 文件、`isExcludedFromBackup`、不进日志/导出/崩溃报告；`key` 只在 Host 注入（会摘的架构文档已经这么写了，值得在设置页把这句话写出来）。
5. **无遥测**：知了明说没有统计、没有自建服务器、诊断只写本机。会摘也该在设置页有一句同等明确的表述——这是"本地库"类产品的信任基础。
6. **依赖下载校验**：BlackHole 驱动下载后核对代码里写死的 SHA-256。会摘的一键装环境拉了 yt-dlp / ffmpeg / 模型，值得对固定版本产物做同样的 hash 校验（至少记录来源与哈希）。
7. **记录格式一版到底**：知了四端共用一个 `session.json` 结构，移植端逐字节读写同一格式。会摘的 macOS 版与插件后端共享同一份数据目录，更该把"记录 schema 版本号"写进库里——`database.py` 已经有 `schema_meta(key, value)` 表，把 `schema_version` 和迁移日志写进去，比靠 `ALTER TABLE` 试探更可控。

---

## 5. 不建议迁移（平台绑定，看清楚再动手）

| 知了能力 | 为什么搬不过来 |
|---|---|
| Core Audio process tap / 系统声音采集 | macOS 私有能力；我们会摘走 B 站/链接/文件三条路，不需要 |
| `SpeechAnalyzer` / `SFSpeechRecognizer` 本机识别 | 绑定 Apple 模型；我们用 Mify/MiMo/Qwen3-ASR |
| BlackHole 虚拟麦克风 + 同声传译 | 驱动级、GPL、需管理员权限；Web 插件不具备也不该具备 |
| 菜单栏面板 / 非激活浮窗 / `sharingType = .none`（屏幕共享拍不到） | AppKit 专有；Web 版只能靠"内录/共享窗口"提示 |
| DMG 自更新、权限保留 | 桌面 App 分发模型；插件的分发包路径完全不同 |
| Core ML 声纹模型包 | 若要声纹，Python 侧用 WeSpeaker ONNX / pyannote embedding 更顺，别搬 CoreML |
| 实时语音合成（Ming TTS）/ 声音克隆 | 与"摘录归档"定位无关 |

---

## 6. 建议的落地节奏

**迭代 A（约 2 周）：让纪要跑起来**
1. `ai/` 治理层 + 一把（Mify 或独立）文本模型 key（P0-2）
2. `minutes.py`：增量 + 终稿 + 术语表 + 证据锚点（P0-1）
3. `SessionDetail` 加"纪要"页签：主题/结论/待办/术语 + 点击跳原话 + "落后 N 句"（P2-11）
4. `meetclip_minutes` 工具（有界；regenerate 走 approval）
5. 验收：`backend/tests/run-all.sh` 加 `test_minutes.py`（假模型回包 → 校验解析、时间锚点、语言不对则丢弃、终稿队列）；`build/render-smoke.mjs` 加纪要面板渲染断言；`node --test tests/host.test.mjs` 加工具分页/审批用例。

**迭代 B（约 1.5 周）：说话人与导出**
6. 说话人呈现规则 + 模型猜名（证据校验 + 驳回）+ 撤销（P1-4）
7. `export_srt.py` / `export_docx.py` + 纪行进 Markdown（P1-9）
8. 文本卫生 `text_hygiene.py`（P1-8）
9. 验收：SRT 时间轴单测（短行 1 秒、长行封顶 8 秒、末行 +4 秒）；说话人编号单测（5 句阈值、两人以下不编号、编号不回退）。

**迭代 C（约 1.5 周）：双语与生命周期**
10. 翻译链 + 半句/整句分流 + 清洗（P1-5），接 `subtitles.py` 的字幕轨优先级
11. 会议/直播自动结束 + 静音裁剪 + 空记录不留（P1-6）
12. 诊断指标 + "复制诊断"（P0-3）
13. 验收：翻译清洗用固定坏样本回归（评论行、`</think>`、语言不符、整句中文包在引号里）；自动结束用纯状态机单测（挂断、切设备、静音但仍在通话、无人发言）。

---

## 7. 出处索引

知了（`main`）：
- 纪要引擎与提示词：`Sources/LiveSubs/Notes.swift`
- 纪要界面与"跳回原话/落后提示"：`Sources/LiveSubs/NotesViews.swift`
- AI 客户端（闸门/重试/关思考/反劫持/密钥）：`Sources/LiveSubs/Ling.swift`、`Sources/LiveSubs/AIProviders.swift`
- 翻译链与清洗：`Sources/LiveSubs/Translator.swift`
- 说话人与命名：`Sources/LiveSubs/SpeakerID.swift`、`Sources/LiveSubs/SpeakerViews.swift`
- 记录格式与导出：`Sources/LiveSubs/SessionStore.swift`
- 导入流水线：`Sources/LiveSubs/FileImport.swift`
- 自动结束：`Sources/LiveSubs/MeetingEnd.swift`
- 文本卫生：`Sources/LiveSubs/HeardText.swift`
- 诊断：`Sources/LiveSubs/Diagnostics.swift`
- 开发约定与架构：`AGENTS.md`、`docs/ROADMAP.zh-CN.md`

在线阅读：<https://github.com/wquguru/cicada/blob/main/AGENTS.md> 起。

会摘侧对照：`docs/ARCHITECTURE.md`、`docs/PARITY.md`、`backend/app/cloud_transcription.py`、`backend/app/database.py`、`backend/app/export_md.py`、`client-src/components/SessionDetail.jsx`、`client-src/components/SpeakersPanel.jsx`、`src/host/tools.js`。
