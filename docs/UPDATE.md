# 应用内更新

会摘 0.9.0 起在 **设置 → 会摘 → 关于** 提供版本信息和「检查更新」。DSH 没有插件自升级 API，所以更新由插件自己完成：从 GitHub Release 下载插件 tarball、校验、解包，然后替换 DSH profile 中已安装的插件副本。替换后的 Host/Client 代码在下次启动 DSH 时加载。

## 用户体验

1. 打开 **设置 → 会摘 → 关于**，页面显示：
   - 当前运行版本（内存中的 Host 版本）
   - 已安装版本（磁盘上 `package.json` 的版本，替换后可能与运行版本不同）
   - 最新版本、发布仓库、上次检查时间和安装位置
2. 点「检查更新」。发现新版本时自动进入下载；页面显示阶段、百分比、已下载/总大小和速度。
3. 下载完成后自动校验 SHA-256、解包并替换。完成后显示「已安装 vX，重启 DeepSeek Harness 后生效」。
4. 下载阶段可以取消；校验/安装阶段不能中断。下一次打开页面会显示上次的检查和安装结果。

如果插件从源码目录运行（`packageRoot` 不在 `node_modules/@meetclip/dsh-meetclip` 下），自动安装会被拒绝，只提示 `git pull`，避免覆盖源码。

## Host API

### `GET /meetclip/app/update`

```json
{
  "ok": true,
  "currentVersion": "0.9.0",
  "installedVersion": "0.9.1",
  "restartRequired": true,
  "repo": "dengluliang/dsh-meetclip",
  "target": {
    "path": "/Users/me/.dsh/profiles/desktop/node_modules/@meetclip/dsh-meetclip",
    "kind": "installed",
    "writable": true
  },
  "latest": {
    "version": "0.9.1",
    "tag": "v0.9.1",
    "publishedAt": "2026-11-10T04:00:00.000Z",
    "url": "https://github.com/dengluliang/dsh-meetclip/releases/tag/v0.9.1",
    "notes": "…",
    "asset": {
      "name": "dsh-meetclip-0.9.1.tgz",
      "url": "https://github.com/…/dsh-meetclip-0.9.1.tgz",
      "size": 704007,
      "sha256": "…"
    }
  },
  "updateAvailable": false,
  "lastCheckAt": 1794283744905,
  "recovery": null,
  "job": null
}
```

`updateAvailable` 比较的是「最新版本」和 `max(currentVersion, installedVersion)`，因此更新已下载但还没重启时不会再次提示或重复下载。

### `POST /meetclip/app/update`

```json
{ "action": "check", "auto_install": true }
```

- `check`：检查并（默认）自动安装。返回 `{ ok: true, job }` 后任务在后台跑，客户端轮询 GET。
- `install`：安装已经检查到的最新版本；没有可安装版本返回 409。
- `cancel`：取消检查/下载。返回 `{ ok: true, status: "cancelled" | "too-late" | "not-running" }`。

### job 状态

```json
{
  "state": "downloading",
  "phase": "下载中",
  "percent": 42.3,
  "received": 297795,
  "total": 704007,
  "speed": 839680,
  "version": "0.9.1",
  "error": "",
  "message": "",
  "startedAt": 1794283744905,
  "updatedAt": 1794283744980,
  "finishedAt": 0
}
```

`state`：`checking` → `downloading` → `verifying` → `installing` → `done`，异常为 `error` 或 `cancelled`。`percent` 在下载阶段是数字，在校验/安装阶段是 `null`（界面显示不确定态）。

## 更新源

优先读取 Release 资产里的 `latest.json`，这个 URL 不经过 GitHub API，不受 60 次/小时的匿名 API 限额影响：

```
https://github.com/dengluliang/dsh-meetclip/releases/latest/download/latest.json
```

失败时回退：

```
GET https://api.github.com/repos/dengluliang/dsh-meetclip/releases/latest
```

API 回退会取 `.tgz` 资产的 `digest`；没有 digest 时读取同 Release 的 `SHA256SUMS.txt`。两者都没有校验值时拒绝安装。

`latest.json` 格式：

```json
{
  "schemaVersion": 1,
  "version": "0.9.1",
  "tag": "v0.9.1",
  "publishedAt": "2026-11-10T04:00:00.000Z",
  "notes": "发布说明…",
  "asset": {
    "name": "dsh-meetclip-0.9.1.tgz",
    "url": "https://github.com/dengluliang/dsh-meetclip/releases/download/v0.9.1/dsh-meetclip-0.9.1.tgz",
    "size": 704007,
    "sha256": "<64 位十六进制>"
  }
}
```

## 安全边界

- 下载只允许 `https://github.com`、`api.github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`、`raw.githubusercontent.com`、`codeload.github.com`；开发/测试的本地 feed 只允许 loopback HTTP。
- 强制 SHA-256，下载完先比对再解包。
- 解包器（`src/host/tar.js`）只接受普通文件和目录：
  - 拒绝绝对路径、盘符、`..`、反斜杠、NUL
  - 拒绝符号链接、硬链接、设备文件、未知类型
  - 限制压缩包 64 MB、解压后 128 MB、单文件 32 MB、5000 个条目
  - 校验 tar 头校验和；支持 npm 可能生成的 PAX/GNU longname 元数据
- 不执行 shell、不执行安装脚本；只写插件目录和 `~/.dsh/meetclip/updates/`。
- 替换前把旧目录改名为 `dsh-meetclip.update-bak-<旧版本>-<时间戳>-<序号>`；替换后校验新目录，失败立即还原。成功时保留最近 2 份更新备份，不影响用户手工建的 `.bak-*`。
- 启动时如果发现目标目录缺失/不完整且有更新备份，会自动恢复。

## 失败处理

| 场景 | 行为 |
| --- | --- |
| 没有 Release / feed 404 | 回退 API；仍失败显示「仓库还没有发布版本」 |
| GitHub 限流 / 断网 / 超时 | 8 秒连接超时、60 秒下载空闲超时；提示检查网络或代理 |
| 版本相同或更旧 | `updateAvailable=false`，不降级 |
| 已安装但未重启 | `updateAvailable=false`，提示重启，不重复下载 |
| 哈希不一致 / 缺校验值 | 丢弃下载，运行版本不变 |
| 路径穿越 / 符号链接 | 拒绝整包，不写目标目录 |
| 目标不可写 / 磁盘满 | 明确错误；不动现有版本 |
| 替换中途失败 | 从备份还原；下次启动再兜底恢复 |
| 并发点击 | 409「已有更新任务」 |
| 源码目录运行 | 不覆盖，提示 `git pull` |

## 发布新版本

1. 修改 `package.json` 的 `version` 和 `CHANGELOG.md`。
2. 运行 `node build/release.mjs --dry-run`，确认生成的 tgz、`latest.json`、`SHA256SUMS.txt`。
3. 带 `GITHUB_TOKEN` 运行 `node build/release.mjs --upload`，或在 GitHub 手动建 Release 并上传三个资产。
4. 确认 `releases/latest/download/latest.json` 返回新版本号。
5. 旧版本客户端下次点「检查更新」即可看到新版本。

`latest.json` 必须最后上传或与 tgz 同一个 Release；它里面的 `sha256` 必须与 tgz 一致，否则客户端会拒绝安装。

## 限制

- 不自动重装 Python 依赖；改了 `backend/requirements.txt` 需要在设置里重装运行环境。
- 不自动重启 DSH，也不修改 profile 的依赖清单；手动重装插件可能回到安装时的旧 tgz。
- 不自动读取 `HTTPS_PROXY`；网络受限环境需要系统级代理。
- 主要验证平台是 macOS；Windows 的 rename 失败会退化为复制，但未实测。
