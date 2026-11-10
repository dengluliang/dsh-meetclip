"""采集组件（yt-dlp / ffmpeg）的一键安装：必要时引导安装 Homebrew，然后 brew install。"""
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import capture

_state = {"running": False, "log": "", "step": "", "done": False, "error": ""}
_lock = threading.Lock()


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
        _state["log"] += msg + "\n"


def _step(step):
    with _lock:
        _state["step"] = step


def _find_brew():
    for candidate in (shutil.which("brew"), "/opt/homebrew/bin/brew", "/usr/local/bin/brew"):
        if candidate and Path(candidate).exists():
            return candidate
    return None


def _run():
    try:
        brew = _find_brew()
        if not brew:
            _step("安装 Homebrew")
            _log("未检测到 Homebrew，开始安装（需要管理员密码，请在弹出的终端中确认）…")
            script = (
                'tell application "Terminal"\n'
                '  activate\n'
                '  do script "/bin/bash -c \\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\" && echo \'HOMEBREW_DONE\'"\n'
                'end tell'
            )
            r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=10)
            if r.returncode != 0:
                raise RuntimeError(f"无法打开终端安装 Homebrew：{r.stderr}")
            _log("Homebrew 安装脚本已在终端中启动，完成后请回到此处")
            for _ in range(600):
                brew = _find_brew()
                if brew:
                    break
                time.sleep(1)
            if not brew:
                raise RuntimeError("Homebrew 安装超时或未成功，请手动安装后重试")
            _log("Homebrew 已就绪")

        _step("安装 yt-dlp 和 ffmpeg")
        _log(f"使用 {brew} 安装 yt-dlp ffmpeg…（首次可能需要几分钟）")
        env = dict(os.environ)
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")
        proc = subprocess.Popen([brew, "install", "yt-dlp", "ffmpeg"],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
        for line in proc.stdout:
            _log(line.rstrip())
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f"brew install 退出码 {proc.returncode}")

        _step("完成")
        capture.refresh_deps()
        with _lock:
            _state.update({"running": False, "done": True, "step": "安装完成"})
        _log("✅ 安装完成，直播采集与截图功能已可用")
    except Exception as e:
        with _lock:
            _state.update({"running": False, "error": str(e), "step": "失败"})
        _log(f"❌ {e}")
