# 会摘 MeetClip · DeepSeek Harness 插件

[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/dengluliang/dsh-meetclip?display_name=tag)](https://github.com/dengluliang/dsh-meetclip/releases)

把直播、视频和会议变成可检索、可回看的本地资料库：在 DeepSeek Harness（DSH）里采集 B 站直播、导入视频链接或本地录音，做云端转写、边看边打点、写 Markdown 笔记，并让 Agent 用 `meetclip_*` 工具检索、整理、生成 AI 纪要。0.9.0 起还可以在应用内检查并自动更新。

![会摘首页](docs/assets/home-wall-preview.png)

> 个人开源项目，与 DeepSeek、小米或飞书没有隶属关系。插件默认的 MiMo 网关与飞书 MCP 包指向作者所在环境，其他团队可以在设置或环境变量里换成自己的服务。

## 功能

- **三种采集**：B 站直播（边录边转写）、视频链接（B 站 / YouTube 等）、本地会议音视频。
- **时间戳转写**：云端 ASR，转写行带时间码和发言人；鼠标点任意时间戳即可跳转播放。
- **边看边记**：打点、截图、Markdown 笔记、待办；记录、笔记和截图都在本地资料库。
- **AI 纪要**：自动生成摘要、分节时间轴、结论、待办与术语表；支持增量更新与用户勾选/高亮反馈。
- **资料空间**：工作/生活多个资料库随时切换，账号与通用设置可共享。
- **飞书文档卡片**：粘贴飞书文档链接，读成可在会话里 `@` 的卡片；可选登录飞书 MCP 读写文档、多维表格、云盘与 Wiki。
- **Agent 工具**：`meetclip_search`、`meetclip_records`、`meetclip_minutes`、`meetclip_marks`、`meetclip_notes`、`meetclip_calendar` 等。
- **应用内更新**：设置 → 关于 → 检查更新，自动下载 GitHub Release、校验 SHA-256、替换已安装副本，带进度条。

![会摘卡片墙](docs/assets/scatter-preview.png)

## 系统要求

- DeepSeek Harness 0.2.x（桌面版或网页版）
- macOS（当前主要验证平台；Windows/Linux 的路径已处理但未实测）
- Node.js 20+（仅开发/构建需要；运行时由 DSH 提供）
- 首次使用会创建独立的 Python 运行环境，需要网络
- 一把 Mify / MiMo API Key（云识别与 AI 纪要默认共用；也可换成任意 OpenAI 兼容服务）

## 安装

### 从 GitHub Releases（推荐）

1. 打开 [最新 Release](https://github.com/dengluliang/dsh-meetclip/releases/latest)，下载 `dsh-meetclip-<版本>.tgz` 到固定目录。
2. 打开 DSH：**设置 → 插件 → 添加插件**。
3. 填 tgz 的**绝对路径**，安装后启用「会摘」。
4. 首次打开按引导安装 Python 运行环境，填入 API Key。

> 只接受 `.tgz` 或含 `package.json` 的插件目录；不要填 zip、`dist/` 父目录或未构建的仓库根目录。

### 命令行

```bash
dsh plugin --profile desktop add "file:/absolute/path/to/dsh-meetclip-0.9.1.tgz"
```

网页版把 `desktop` 换成 `web`，然后重启 DSH。更细的步骤、飞书配置和常见问题见 [INSTALL.md](INSTALL.md)。

## 更新

打开 **设置 → 会摘 → 关于**：

- 「当前运行版本 / 已安装版本 / 最新版本」分别显示内存中的版本、磁盘上已替换的版本和 GitHub 上的最新版本。
- 点「检查更新」：读取 Release 的 `latest.json`（失败时回退 GitHub API）→ 有更新就自动下载 → SHA-256 校验 → 安全解包 → 原子替换 DSH profile 里的插件副本。下载过程显示百分比、已下载字节和速度，可取消。
- 完成后重启 DeepSeek Harness 生效；重启前会明确提示「已安装 vX，重启后生效」。
- 替换前会保留 `dsh-meetclip.update-bak-<旧版本>-<时间戳>` 备份；失败自动还原，进程中断后下次启动自动恢复。
- 源码方式运行（`link:` / 开发目录）不会自动覆盖，只提示 `git pull`。
- 自动更新不改 profile 的 `package.json`/`pnpm-lock.yaml`；之后手动重装插件可能回到安装时的旧 tgz。新包留在 `~/.dsh/meetclip/updates/<版本>/`。

实现细节、feed 格式和发布流程见 [docs/UPDATE.md](docs/UPDATE.md)。

## 首次使用

1. 打开侧栏「会摘」→ 按引导准备 Python 环境。
2. **设置 → 会摘 → 模型**：填入 Mify / MiMo API Key，或配置 OpenAI 兼容服务。
3. 首页「＋」选择发布会直播 / 视频链接 / 会议录音，或直接粘贴链接让 Agent 处理。
4. 采集完成后在记录页看转写、打点、写笔记、生成 AI 纪要。

飞书是可选项：**设置 → 会摘 → 飞书** 安装并登录飞书 MCP 后，Agent 才能读写飞书文档、多维表格与 Wiki。默认包 `@mi/feishu-mcp-pro` 来自作者环境的 npm 源；其他团队可用环境变量 `MEETCLIP_FEISHU_PACKAGE`、`MEETCLIP_FEISHU_REGISTRY` 指向自己的 MCP 包。

## 数据与隐私

- 资料库默认位于 `~/.dsh/meetclip/data`（或设置里选定的目录），包含音视频、转写、截图、笔记和 SQLite 数据库。
- 云识别与 AI 纪要会把音频/文本发给你配置的 ASR / 模型服务；除此之外插件不向第三方上传资料。
- 「检查更新」只向 `github.com` 发 GET 请求，不上传资料库、笔记或转写；没有遥测。
- 更新包强制 HTTPS + SHA-256，解包拒绝绝对路径、`..`、符号链接和设备文件，不执行 shell。

## 开发

```bash
# 构建浏览器端 client.js（需要 esbuild/react）
npm install --prefix build
node build/build-client.mjs

# 前端与 Host 单元测试
node --test tests/*.test.mjs

# 打包插件（生成 meetclip-dsh-meetclip-<版本>.tgz）
npm pack --pack-destination dist

# 生成 Release 资产（tgz + latest.json + SHA256SUMS）
node build/release.mjs --dry-run
```

后端测试使用插件自己的 Python 环境：

```bash
MEETCLIP_TEST_PYTHON="$HOME/.dsh/meetclip/venv/bin/python" backend/tests/run-all.sh
```

目录结构：

```
index.js              Host 入口（路由、工具、skill 注册）
src/host/             Host：运行时、采集、飞书、更新器、安全解包
client-src/           React 客户端源码（Settings / 首页 / 详情页）
client.js             构建产物（npm pack 与 DSH 加载用）
backend/app/          FastAPI 后端（ASR、纪要、搜索、导出）
backend/tests/        后端测试
skills/jianbao/       内置「发布会简报」skill
tests/                Host / Client 单元测试
build/                构建、预览、截图与发布脚本
docs/                 架构、验证、更新说明
```

发布新版本：更新 `package.json` 版本与 `CHANGELOG.md`，运行 `node build/release.mjs --dry-run` 检查资产，再带 `GITHUB_TOKEN` 执行 `node build/release.mjs --upload`（或按脚本输出用 API 上传）。`latest.json` 是更新器读取的稳定入口。

## 兼容与限制

- 自动更新只替换已安装副本，不自动重装 Python 依赖；若新版本改了 `backend/requirements.txt`，需在设置里重装运行环境。
- 更新后必须重启 DSH 才能加载新的 Host/Client 代码（DSH 没有插件自重启 API）。
- 网络受限时更新器会给出「连不上 GitHub」提示；暂不自动读取 `HTTPS_PROXY`。
- 飞书 MCP 与 MiMo 网关默认值面向作者环境，公开使用前请换成自己的服务。
- 主要验证平台是 macOS；Windows 的目录替换有回退逻辑但未实测。

## 许可证

[MIT](LICENSE)。第三方署名见 [THIRD_PARTY.md](THIRD_PARTY.md)（Cicada，Apache-2.0）。详见 [CHANGELOG.md](CHANGELOG.md)、[INSTALL.md](INSTALL.md) 和 [docs/](docs/)。
