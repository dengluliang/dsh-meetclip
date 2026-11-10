"""端侧 ASR：Qwen3-ASR-1.7B（MLX，Apple Silicon 本地推理）。

职责：
- 检测运行环境（arm64 + mlx-qwen3-asr）
- 模型下载（断点续传、实时进度与速度、可取消、多镜像回退）
- 下载完成后自动加载启用；应用重启后已安装模型自动加载
- 线程安全的转写调用
"""
import json
import os
import platform
import shutil
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np

from database import DATA_DIR

MODEL_NAME = "Qwen3-ASR-1.7B"
MODEL_REPO = "mlx-community/Qwen3-ASR-1.7B-8bit"
MODEL_DIR = DATA_DIR / "models" / "Qwen3-ASR-1.7B-8bit"
FILE_SUFFIXES = (".json", ".safetensors", ".txt", ".model")
SAMPLE_RATE = 16000


def _endpoints():
    eps = [os.environ.get("HF_ENDPOINT"), "https://huggingface.co", "https://hf-mirror.com"]
    seen, out = set(), []
    for e in eps:
        if e and e.rstrip("/") not in seen:
            seen.add(e.rstrip("/"))
            out.append(e.rstrip("/"))
    return out


def runtime_status():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return False, "Qwen3-ASR 端侧推理需要 Apple Silicon（M 系列芯片）Mac"
    try:
        import mlx.core  # noqa
        import mlx_qwen3_asr  # noqa
        return True, ""
    except Exception as e:
        return False, f"缺少 ASR 运行环境（mlx-qwen3-asr）：请运行 ./setup-backend.sh 后重启应用（{e.__class__.__name__}）"


class _Cancelled(Exception):
    pass


class ModelManager:
    """单个模型的下载/加载/推理管理。"""

    def __init__(self):
        self.kind = "asr"
        self.name = MODEL_NAME
        self.repo = MODEL_REPO
        self.model_dir = MODEL_DIR
        self.complete_mark = self.model_dir / ".complete"
        self._lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._active_inferences = 0
        self._deleting = False
        self._session = None
        self._cancel = threading.Event()
        self._thread = None
        self._speed_samples = []
        self.st = {
            "state": "installed" if self.complete_mark.exists() else "not_installed",
            "downloaded": 0, "total": 0, "speed": 0.0, "eta": None,
            "error": "", "endpoint": "", "current_file": "",
        }

    # ---------- 状态 ----------
    def status(self):
        ok, msg = runtime_status()
        with self._lock:
            s = dict(self.st)
        s.update({
            "model": self.name, "repo": self.repo,
            "runtime": ok, "runtime_message": msg,
            "ready": s["state"] == "ready",
            "size_on_disk": _dir_size(self.model_dir) if s["state"] in ("installed", "loading", "ready") else 0,
        })
        return s

    def is_ready(self):
        return self._session is not None

    def is_pending(self):
        """模型是否可能很快可用（下载或加载中）"""
        with self._lock:
            return self.st["state"] in ("downloading", "loading", "installed")

    def is_loading(self):
        """队列等待正在下载或加载的模型；未安装/加载失败交给任务报告错误。"""
        with self._lock:
            return self.st["state"] in ("downloading", "loading")

    def _set(self, **kw):
        with self._lock:
            self.st.update(kw)

    # ---------- 启动时自动启用 ----------
    def autoload(self):
        if self.complete_mark.exists() and runtime_status()[0]:
            self._set(state="loading", error="")
            threading.Thread(target=self._load, daemon=True).start()

    # ---------- 下载 ----------
    def start_download(self):
        ok, msg = runtime_status()
        if not ok:
            raise RuntimeError(msg)
        with self._lock:
            if self.st["state"] in ("downloading", "loading", "ready"):
                return
            self.st.update(state="downloading", error="", speed=0.0, eta=None)
        self._cancel.clear()
        self._thread = threading.Thread(target=self._download, daemon=True)
        self._thread.start()

    def cancel_download(self):
        self._cancel.set()

    def delete_model(self):
        # Lock the inference lane before inspecting the counter. New inference
        # calls may increment the counter while waiting for this lane; checking
        # after acquiring it makes deletion atomic with respect to inference.
        # All inference paths acquire _infer_lock before _lock. Keep the same
        # order here so model deletion cannot deadlock with an inference that is
        # finishing while the user presses Delete.
        with self._infer_lock:
            with self._lock:
                if self.st["state"] == "downloading":
                    raise RuntimeError("下载进行中，请先取消")
                if self._active_inferences:
                    raise RuntimeError("语音识别正在使用该模型，请等待当前任务完成或取消后再删除")
                self._deleting = True
                self._session = None
            try:
                shutil.rmtree(self.model_dir, ignore_errors=True)
            finally:
                with self._lock:
                    self._deleting = False
                    self.st.update(state="not_installed", downloaded=0, total=0,
                                   speed=0.0, eta=None, error="")
            return

    def _file_url(self, ep, name):
        return f"{ep}/{self.repo}/resolve/main/{name}"

    def _list_files(self):
        last = None
        for ep in _endpoints():
            try:
                url = f"{ep}/api/models/{self.repo}/tree/main"
                req = urllib.request.Request(url, headers={"User-Agent": "zhibo/1.0"})
                with urllib.request.urlopen(req, timeout=10) as r:
                    items = json.loads(r.read().decode())
                files = [(i["path"], int(i.get("lfs", {}).get("size") or i.get("size") or 0))
                         for i in items if i.get("type") == "file" and i["path"].endswith(FILE_SUFFIXES)]
                if files:
                    return ep, files
            except Exception as e:
                last = e
        raise RuntimeError(f"无法连接模型仓库（已尝试 {', '.join(_endpoints())}）：{last}")

    def _download(self):
        try:
            ep, files = self._list_files()
            self.model_dir.mkdir(parents=True, exist_ok=True)
            total = sum(s for _, s in files)
            done_bytes = 0
            for name, size in files:
                p = self.model_dir / name
                part = p.with_name(p.name + ".part")
                if p.exists() and p.stat().st_size == size:
                    done_bytes += size
                elif part.exists():
                    done_bytes += min(part.stat().st_size, size)
            self._set(total=total, downloaded=done_bytes, endpoint=ep)
            self._speed_samples = [(time.time(), done_bytes)]
            for name, size in files:
                dest = self.model_dir / name
                if dest.exists() and dest.stat().st_size == size:
                    continue
                self._set(current_file=name)
                errors = []
                for e in [ep] + [x for x in _endpoints() if x != ep]:
                    try:
                        self._fetch(e, name, size, dest)
                        self._set(endpoint=e)
                        ep = e
                        break
                    except _Cancelled:
                        raise
                    except Exception as ex:
                        errors.append(f"{e}: {ex}")
                else:
                    raise RuntimeError("；".join(errors))
            self.complete_mark.write_text(json.dumps({"repo": self.repo, "at": time.time()}))
            self._set(state="installed", speed=0.0, eta=None, current_file="",
                      downloaded=total)
            self._load()
        except _Cancelled:
            self._set(state="not_installed", speed=0.0, eta=None, current_file="",
                      error="下载已取消，已下载部分会保留，再次点击可继续")
        except Exception as e:
            self._set(state="error", speed=0.0, eta=None, error=f"下载失败：{e}")

    def _fetch(self, ep, name, size, dest):
        part = dest.with_name(dest.name + ".part")
        dest.parent.mkdir(parents=True, exist_ok=True)
        have = part.stat().st_size if part.exists() else 0
        if size and have > size:
            self._advance(-have)
            part.unlink()
            have = 0
        headers = {"User-Agent": "zhibo/1.0"}
        if have:
            headers["Range"] = f"bytes={have}-"
        req = urllib.request.Request(self._file_url(ep, name), headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            if have and r.status != 206:
                self._advance(-have)
                have = 0
            mode = "ab" if have else "wb"
            with open(part, mode) as f:
                while True:
                    if self._cancel.is_set():
                        raise _Cancelled()
                    buf = r.read(1 << 20)
                    if not buf:
                        break
                    f.write(buf)
                    self._advance(len(buf))
        if size and part.stat().st_size != size:
            raise RuntimeError(f"{name} 大小不符（{part.stat().st_size}/{size}），将重试")
        part.rename(dest)

    def _advance(self, n):
        now = time.time()
        with self._lock:
            self.st["downloaded"] += n
            done = self.st["downloaded"]
            total = self.st["total"]
        self._speed_samples.append((now, done))
        while len(self._speed_samples) > 2 and now - self._speed_samples[0][0] > 3.0:
            self._speed_samples.pop(0)
        t0, b0 = self._speed_samples[0]
        speed = (done - b0) / (now - t0) if now - t0 > 0.2 else 0.0
        eta = (total - done) / speed if speed > 0 and total else None
        self._set(speed=speed, eta=eta)

    # ---------- 加载 ----------
    def _load(self):
        self._set(state="loading", error="")
        try:
            from mlx_qwen3_asr import Session
            sess = Session(model=str(self.model_dir))
            sess.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))
            with self._infer_lock:
                self._session = sess
            self._set(state="ready")
        except Exception as e:
            self._set(state="error", error=f"模型加载失败：{e}")

    # ---------- 推理 ----------
    def transcribe_long(self, audio, *, language=None, context="", return_chunks=True, on_progress=None):
        """会议用：整段离线转写。返回 mlx_qwen3_asr.TranscriptionResult。
        audio 为 16k 单声道 float32；时间戳来自分块（句级），不加载对齐模型。"""
        with self._infer_lock:
                with self._lock:
                    if self._deleting or self._session is None:
                        raise RuntimeError("ASR 模型未就绪")
                    self._active_inferences += 1
                try:
                    kw = dict(context=context or "", language=language or None,
                              return_timestamps=False,
                              return_chunks=return_chunks, on_progress=on_progress)
                    return self._session.transcribe(audio.astype(np.float32), **kw)
                finally:
                    with self._lock:
                        self._active_inferences = max(0, self._active_inferences - 1)

    def detect_language(self, audio: np.ndarray, seconds=30):
        """不带上下文地识别前几十秒，得到语种标签（带热词/背景时库返回的标签不可靠）"""
        with self._infer_lock:
                with self._lock:
                    if self._deleting or self._session is None:
                        return None
                    self._active_inferences += 1
                try:
                    head = audio[: SAMPLE_RATE * seconds].astype(np.float32)
                    if head.size < SAMPLE_RATE:
                        return None
                    try:
                        return self._session.transcribe(head, max_new_tokens=160).language or None
                    except Exception:
                        return None
                finally:
                    with self._lock:
                        self._active_inferences = max(0, self._active_inferences - 1)

    def transcribe(self, audio: np.ndarray) -> str:
        with self._infer_lock:
                with self._lock:
                    if self._deleting or self._session is None:
                        raise RuntimeError("ASR 模型未就绪")
                    self._active_inferences += 1
                try:
                    r = self._session.transcribe(audio.astype(np.float32))
                finally:
                    with self._lock:
                        self._active_inferences = max(0, self._active_inferences - 1)
        return (r.text or "").strip()


def _dir_size(d: Path):
    if not d.exists():
        return 0
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())


manager = ModelManager()
