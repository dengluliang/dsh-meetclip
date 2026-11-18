"""采集组件（yt-dlp / ffmpeg）安装：原生镜像直下，不再要求用户先装 Homebrew。

优先级：
1. yt-dlp 直接复用独立环境里已经装好的 console script（requirements.txt 里就有），
   软链到 <state>/bin；后端启动时这个目录是 PATH 第一位、也是 ZHIBO_BIN_DIR 的指向，
   所以能被 capture._vendored() 优先命中。
2. ffmpeg（以及可选的 ffprobe）从静态构建镜像直下，先国内源、再 GitHub 代理：
   osxexperts 的静态包 → eugeneware/ffmpeg-static → PyPI 的 imageio-ffmpeg 兜底。
3. 只有在机器上已经有 Homebrew 时才走 brew 兜底；不再弹终端替用户装 Homebrew
   （新机器上那条路要管理员密码、还要连 GitHub，正是要避开的失败点）。

镜像地址可用环境变量覆盖，便于内网部署：
  MEETCLIP_PYPI_MIRROR     逗号分隔的 PyPI 镜像根
  MEETCLIP_FFMPEG_MIRROR   逗号分隔的 ffmpeg 下载地址（zip / gz 直链）
  MEETCLIP_FFPROBE_MIRROR  同上，给 ffprobe 用
"""
import gzip
import os
import platform
import shutil
import subprocess
import sys
import threading
import urllib.request
import zipfile
from pathlib import Path

import capture

USER_AGENT = "meetclip-deps/1.0"

DEFAULT_PYPI_INDEXES = (
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple",
    "https://pypi.org/simple",
)

GH_PROXIES = ("https://ghfast.top/", "https://gh-proxy.com/", "")

_state = {"running": False, "log": "", "step": "", "done": False, "error": ""}
_lock = threading.Lock()

# 独立 CPython 不一定带系统 CA，和 capture.py 一样给 urllib 一个 macOS 根证书。
if not os.environ.get("SSL_CERT_FILE") and os.path.exists("/etc/ssl/cert.pem"):
    os.environ["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"


def _mirrors(name, default=()):
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return list(default)
    return [row.strip() for row in raw.split(",") if row.strip()]


def pypi_indexes():
    return _mirrors("MEETCLIP_PYPI_MIRROR", DEFAULT_PYPI_INDEXES)


def _machine():
    machine = (platform.machine() or "").lower()
    return "arm64" if machine in ("arm64", "aarch64") else "x86_64"


def _infer_kind(url):
    return "zip" if url.lower().split("?")[0].endswith(".zip") else "gz"


def binary_sources(name):
    """返回 [(url, kind, member)]，按优先级从高到低。"""
    arch = _machine()
    extra = _mirrors("MEETCLIP_FFMPEG_MIRROR" if name == "ffmpeg" else "MEETCLIP_FFPROBE_MIRROR")
    urls = list(extra)
    if name == "ffprobe":
        asset = "ffprobe7arm.zip" if arch == "arm64" else "ffprobe7intel.zip"
        urls.append(f"https://www.osxexperts.net/{asset}")
    else:
        static_asset = "ffmpeg-darwin-arm64.gz" if arch == "arm64" else "ffmpeg-darwin-x64.gz"
        release = f"https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/{static_asset}"
        urls.append("https://www.osxexperts.net/ffmpeg7arm.zip" if arch == "arm64"
                    else "https://www.osxexperts.net/ffmpeg7intel.zip")
        for proxy in GH_PROXIES:
            urls.append(f"{proxy}{release}" if proxy else release)
    return [(url, _infer_kind(url), name) for url in urls]


# ---------------- 任务状态 ----------------
def status():
    with _lock:
        return dict(_state)


def start():
    with _lock:
        if _state["running"]:
            return {"ok": True, "message": "安装已在进行中"}
        _state.update({"running": True, "log": "", "step": "初始化", "done": False, "error": ""})
    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "message": "安装已开始"}


def _log(msg):
    with _lock:
        _state["log"] += str(msg) + "\n"


def _step(step):
    with _lock:
        _state["step"] = step


def _finish(done, step, error=""):
    with _lock:
        _state.update({"running": False, "done": done, "step": step, "error": error})


def _bin_dir():
    configured = os.environ.get("ZHIBO_BIN_DIR")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parent.parent / "bin"


# ---------------- 下载与解包 ----------------
def _download(url, dest, label):
    _log(f"↓ {label}：{url}")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last = 0
    received = 0
    with urllib.request.urlopen(request, timeout=60) as response, open(dest, "wb") as out:
        try:
            total = int(response.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            total = 0
        while True:
            chunk = response.read(256 * 1024)
            if not chunk:
                break
            out.write(chunk)
            received += len(chunk)
            if total:
                percent = int(received * 100 / total)
                if percent - last >= 10 or percent >= 100:
                    last = percent
                    _log(f"  {percent}%  {received / 1048576:.1f}MB / {total / 1048576:.1f}MB")
    if received < 1024 * 1024:
        raise RuntimeError(f"{label} 下载内容过小（{received} 字节）")
    return received


def _extract(archive, kind, member, out_path):
    if kind == "zip":
        with zipfile.ZipFile(archive) as zf:
            names = [row for row in zf.namelist()
                     if Path(row).name == member and not row.endswith("/")]
            if not names:
                raise RuntimeError(f"压缩包里没有 {member}")
            with zf.open(sorted(names, key=len)[0]) as src, open(out_path, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
    else:
        with gzip.open(archive, "rb") as src, open(out_path, "wb") as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
    os.chmod(out_path, 0o755)


def verify(binary, args=("-version",)):
    """跑一次版本号，返回 (首行, 错误)。能跑起来才算装好。"""
    try:
        result = subprocess.run([str(binary), *args], capture_output=True, text=True, timeout=45)
    except Exception as error:  # noqa: BLE001 - 任何异常都当作"不能用"
        return "", str(error)
    text = (result.stdout or result.stderr or "").strip().splitlines()
    return (text[0] if text else ""), ("" if result.returncode == 0 else f"退出码 {result.returncode}")


# ---------------- yt-dlp ----------------
def _link_or_copy(src, dst):
    if dst.is_symlink() or dst.exists():
        try:
            dst.unlink()
        except OSError:
            pass
    try:
        os.symlink(Path(src).resolve(), dst)
    except OSError:
        shutil.copy2(src, dst)
        os.chmod(dst, 0o755)


def install_ytdlp(bin_dir):
    found = capture.DEPS.get("yt_dlp")
    if found:
        _log(f"yt-dlp 已可用：{found}")
        return found
    script = Path(sys.executable).parent / "yt-dlp"
    if not script.exists():
        # requirements.txt 里本来就有 yt-dlp，正常走不到这里；真缺了就补装一次。
        for index in pypi_indexes():
            _step("补装 yt-dlp")
            _log(f"用 {index} 补装 yt-dlp…")
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                 "-i", index, "yt-dlp"],
                capture_output=True, text=True, timeout=600,
            )
            if result.returncode == 0 and script.exists():
                break
            tail = (result.stderr or "").strip().splitlines()
            _log(f"该源补装失败：{tail[-1] if tail else '未知错误'}")
    if not script.exists():
        raise RuntimeError("独立环境里没有 yt-dlp，补装也没成功")
    target = bin_dir / "yt-dlp"
    _link_or_copy(script, target)
    first, error = verify(target, ("--version",))
    if error:
        raise RuntimeError(f"yt-dlp 无法运行：{error}")
    _log(f"yt-dlp 就绪：{first}")
    return str(target)


# ---------------- ffmpeg / ffprobe ----------------
def install_binary(name, bin_dir, required=True):
    existing = capture.DEPS.get(name)
    if existing:
        _log(f"{name} 已可用：{existing}")
        return existing
    target = bin_dir / name
    errors = []
    downloads = bin_dir.parent / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    for url, kind, member in binary_sources(name):
        _step(f"下载 {name}")
        archive = downloads / f"{name}-{abs(hash(url))}.{kind}"
        try:
            _download(url, archive, name)
            _extract(archive, kind, member, target)
            first, error = verify(target)
            if error:
                raise RuntimeError(f"下载的 {name} 无法运行：{error}")
            _log(f"{name} 就绪：{first}")
            return str(target)
        except Exception as error:  # noqa: BLE001 - 逐个源降级
            errors.append(f"{url.split('/')[2]}：{error}")
            _log(f"该源不可用，换下一个：{error}")
        finally:
            try:
                archive.unlink()
            except OSError:
                pass
    if name == "ffmpeg":
        fallback = install_imageio_ffmpeg(bin_dir)
        if fallback:
            return fallback
    message = f"{name} 安装失败：" + "；".join(errors[-3:])
    if required:
        raise RuntimeError(message)
    _log(message + "（非必需，跳过）")
    return None


def install_imageio_ffmpeg(bin_dir):
    """最后一条网络兜底：PyPI 的 imageio-ffmpeg wheel 里自带一份 ffmpeg 二进制。"""
    for index in pypi_indexes():
        _step("安装 imageio-ffmpeg")
        _log(f"尝试用 {index} 安装 imageio-ffmpeg…")
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
             "-i", index, "imageio-ffmpeg"],
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode != 0:
            _log((result.stderr or "").strip()[-300:])
            continue
        probe = subprocess.run(
            [sys.executable, "-c",
             "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"],
            capture_output=True, text=True, timeout=120,
        )
        path = (probe.stdout or "").strip()
        if probe.returncode == 0 and path and Path(path).exists():
            target = bin_dir / "ffmpeg"
            _link_or_copy(Path(path), target)
            first, error = verify(target)
            if not error:
                _log(f"ffmpeg 就绪（imageio-ffmpeg）：{first}")
                return str(target)
    return None


# ---------------- Homebrew 兜底（仅在已经装过 brew 时使用） ----------------
def find_brew():
    for candidate in (shutil.which("brew"), "/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
        if candidate and Path(candidate).exists():
            return candidate
    return None


def install_via_brew():
    brew = find_brew()
    if not brew:
        raise RuntimeError("没有 Homebrew，已跳过 brew 兜底")
    _step("用 Homebrew 补装")
    _log(f"使用 {brew} 安装 yt-dlp ffmpeg…")
    env = dict(os.environ)
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")
    proc = subprocess.Popen([brew, "install", "yt-dlp", "ffmpeg"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    for line in proc.stdout:
        _log(line.rstrip())
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"brew install 退出码 {proc.returncode}")


# ---------------- 主流程 ----------------
def _run():
    try:
        bin_dir = _bin_dir()
        bin_dir.mkdir(parents=True, exist_ok=True)
        _log(f"安装目录：{bin_dir}（架构 {_machine()}，Python {platform.python_version()}）")
        _step("准备采集组件")
        install_ytdlp(bin_dir)
        install_binary("ffmpeg", bin_dir, required=True)
        install_binary("ffprobe", bin_dir, required=False)
        capture.refresh_deps()
        missing = [key for key in ("yt_dlp", "ffmpeg") if not capture.DEPS.get(key)]
        if missing:
            raise RuntimeError("仍未找到：" + "、".join(missing))
        _finish(True, "安装完成")
        _log("✅ 安装完成，直播采集与截图功能已可用")
    except Exception as error:  # noqa: BLE001 - 兜底路径 + 结构化状态
        _log(f"❌ {error}")
        try:
            install_via_brew()
            capture.refresh_deps()
            if capture.DEPS.get("yt_dlp") and capture.DEPS.get("ffmpeg"):
                _finish(True, "安装完成（Homebrew）")
                _log("✅ 已通过 Homebrew 补齐采集组件")
                return
            raise RuntimeError("Homebrew 装完仍缺组件")
        except Exception as brew_error:  # noqa: BLE001
            _log(f"Homebrew 兜底不可用：{brew_error}")
            _finish(False, "失败", str(error))
