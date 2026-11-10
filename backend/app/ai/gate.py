"""请求起始闸门：所有 AI 调用从这里拿"可以发请求了"的许可。

两个作用：
1. **限速**：账号级配额是"每秒大约几次"，按供应商给一个最小起始间隔（默认网关约 2 次/秒 → 0.6s），
   而不是等撞上 429 再退避；
2. **优先级**：实时性要求高的用途（同传/字幕）排在前面，纪要这类可以等的排在后面。

线程实现（后端是线程模型），同一时刻只有一个许可签发，因此间隔是全局的。
"""
import threading
import time

SPACING = {"mimo": 0.6, "openai": 0.1, "custom": 0.1}


class Gate:
    def __init__(self, spacing: float = 0.6):
        self._spacing = float(spacing)
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._waiters: list[tuple[int, int]] = []
        self._seq = 0
        self._last = 0.0
        self.grants = 0
        self.max_wait = 0.0

    def set_spacing(self, spacing: float):
        with self._lock:
            self._spacing = float(spacing)

    def _bump(self, value: float):
        if value > self.max_wait:
            self.max_wait = value

    def acquire(self, priority: int = 2, spacing: float | None = None) -> float:
        """阻塞到可以发请求为止；返回排队等待的秒数（供指标使用）。"""
        spacing = self._spacing if spacing is None else float(spacing)
        asked = time.monotonic()
        with self._lock:
            self._seq += 1
            mine = (int(priority), self._seq)
            self._waiters.append(mine)
            try:
                while True:
                    head = min(self._waiters)
                    if head != mine:
                        self._cond.wait()
                        continue
                    now = time.monotonic()
                    ready = self._last + spacing
                    if now >= ready:
                        self._waiters.remove(mine)
                        self._last = now
                        self.grants += 1
                        self._bump(now - asked)
                        self._cond.notify_all()
                        return now - asked
                    self._cond.wait(max(0.0, ready - now))
            finally:
                if mine in self._waiters:
                    self._waiters.remove(mine)
                    self._cond.notify_all()


_gate = Gate()
_lock = threading.Lock()


def shared(spacing: float | None = None) -> Gate:
    """进程内只有一道闸门：所有服务共用一个账号配额。"""
    global _gate
    with _lock:
        if spacing is not None:
            _gate.set_spacing(spacing)
        return _gate


def reset():
    """测试用：清掉等待与统计。"""
    global _gate
    with _lock:
        _gate = Gate()
    return _gate
