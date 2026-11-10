"""判断一场直播/会议是不是该结束了，免得没人管的采集一录一整夜。

移植自知了（Cicada）的 `MeetingEndWatch`，这里只保留在 MeetClip 上可用的信号：
- 主信号原本是"会议 App 放开麦克风 = 挂断"，Web 插件拿不到，换成"直播流结束"（ffmpeg 收尾）；
- 兜底信号是"很久没有识别出**词**"——按词计时，不按声音：背景音乐、空调声不续命。

两种收尾方式：
- `prompt`：先问一句"还要继续吗"，倒计时结束才停（默认）；
- `end`：到点直接停。
一句都没说过的情况（`said=False`）安静地停：空房间不该被听一晚上。

纯状态机，不碰线程与 IO，便于单测。
"""
from __future__ import annotations

SILENCE_MODES = ("off", "prompt", "end")


class MeetingEndWatch:
    def __init__(self, mode: str = "prompt", silence_after: float = 600.0, countdown: float = 60.0,
                 start: float = 0.0):
        self.mode = mode if mode in SILENCE_MODES else "prompt"
        self.silence_after = max(30.0, float(silence_after))
        self.countdown = max(10.0, float(countdown))
        self.last_speech = float(start)
        # 已经发出"要不要结束"的询问，以及它的截止时间。
        self.pending_deadline: float | None = None
        self.pending_reason: str | None = None

    def heard(self, now: float):
        """识别出了词（谁的都算）：静音倒计时取消，但"已询问"要用户明确继续才取消。"""
        self.last_speech = now
        if self.pending_reason == "silence":
            self.pending_deadline = None
            self.pending_reason = None

    def keep_going(self, now: float):
        """用户点"继续记录"：忘掉询问，重新开始计静音。"""
        self.last_speech = now
        self.pending_deadline = None
        self.pending_reason = None

    def tick(self, now: float, said: bool) -> str | None:
        """返回 None / "prompt"（该问要不要结束了）/ "end"（该结束了）/ "nobody_spoke"。"""
        if self.mode == "off":
            return None
        if not said:
            # 一句都没说过：不用问，安静地停。
            if now - self.last_speech >= self.silence_after:
                return "nobody_spoke"
            return None
        if self.pending_deadline is None and now - self.last_speech >= self.silence_after:
            if self.mode == "end":
                return "end"
            self.pending_reason = "silence"
            self.pending_deadline = now + self.countdown
            return "prompt"
        if self.pending_deadline is not None and now >= self.pending_deadline:
            self.pending_deadline = None
            self.pending_reason = None
            return "end"
        return None

    def deadline(self) -> float | None:
        return self.pending_deadline
