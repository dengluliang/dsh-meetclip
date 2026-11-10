"""AI 纪要引擎：进行中增量更新，结束时用整份转写重写终稿。

移植自知了（Cicada）的 `NotesEngine`，保留它验证过的机制：
- 增量：只把"还没覆盖的句子"连同当前纪要一起发，模型返回整份更新后的纪要；
- 证据：每条论断带 evidence 行号，解析时换算成秒 → 界面点一下就能跳回原话；
- 失败绝不覆盖好结果；语言不对就丢弃并重试一次；
- 正在更新时又来的终稿不丢，进队列按序补跑；
- 覆盖率按"秒"记账：终稿会整表重插转写，行号不可依赖。

线程模型：一个工作线程串行跑（一次只花一份 AI 配额），一个扫描线程定期看活跃记录。
"""
from __future__ import annotations

import threading
import time

import settings
import text_hygiene
import minutes_interactions
import minutes_notes
import minutes_scenarios
from ai import client as ai_client, keys, metrics
from database import db
from minutes_prompt import (FINAL_WINDOW, LIVE_MAX_LINES, MIN_LINES, build, carry_times, context_tail,
                            merge_window, parse, plan_final, sanitize_topics, strip_point_ids, written_in)
from ai import providers

STATE_TEXT = {
    "idle": "", "updating": "正在整理纪要…", "no_key": "尚未配置 AI Key，纪要暂不可用",
    "invalid_key": "AI Key 无效，请到设置检查", "rate_limited": "AI 服务限流，稍后会自动重试",
    "failed": "这一次整理失败，已保留上一版纪要",
}
AUTO_MODES = ("off", "final", "live")


def _now() -> float:
    return time.time()


def rows_for_prompt(sid: str) -> list[dict]:
    """转写行 → 提示词行。

    `speaker` 保留原始标签（去重、编号、猜名都靠它），`label` 是给人看/给模型看的写法。
    文本先过一遍卫生清洗——模型看到脏文本会把它整理进纪要里。
    """
    sess = db.get_session(sid) or {}
    names = (sess.get("meta") or {}).get("speakers") or {}
    out = []
    for index, row in enumerate(db.get_transcripts(sid)):
        text = text_hygiene.clean(row.get("text") or "")
        if not text:
            continue
        raw = row.get("speaker") or ""
        out.append({"index": index, "start": float(row.get("start") or 0), "speaker": raw,
                    "label": (names.get(raw) or "") if raw else "", "text": text})
    return out


def _language(sess: dict) -> str:
    chosen = providers.language_name(settings.get("minutes_language") or "")
    if chosen:
        return chosen
    meta = sess.get("meta") or {}
    return providers.english_language(meta.get("language") or meta.get("language_hint") or "")


def _auto_mode() -> str:
    mode = (settings.get("minutes_auto") or "final").strip().lower()
    return mode if mode in AUTO_MODES else "final"


def _interval() -> float:
    try:
        return max(45.0, float(settings.get("minutes_interval") or 120))
    except (TypeError, ValueError):
        return 120.0


def scenario_for(sess: dict | None) -> str:
    """会议 / 视频 / 直播模板：按记录类型自动选，未知类型回落到会议。"""
    return minutes_scenarios.for_kind((sess or {}).get("kind"))


def _context(sess: dict) -> str:
    """给提示词的参考信息：只校准主题和人名，不要求模型照抄。"""
    parts = []
    title = str(sess.get("title") or "").strip()
    if title:
        parts.append(f"标题={title}")
    platform = str(sess.get("platform") or "").strip()
    if platform:
        parts.append(f"平台={platform}")
    meta = sess.get("meta") or {}
    source = meta.get("source_meta") if isinstance(meta.get("source_meta"), dict) else {}
    uploader = str(source.get("uploader") or "").strip()
    if uploader:
        parts.append(f"上传者={uploader}")
    return "；".join(parts)[:500]


class MinutesEngine:
    def __init__(self):
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._jobs: dict[str, dict] = {}
        self._order: list[str] = []
        self._worker: threading.Thread | None = None
        self._ticker: threading.Thread | None = None
        self._stop = threading.Event()
        self._running_sid: str | None = None

    # ---------------- 生命周期 ----------------
    def start(self):
        with self._lock:
            if self._worker and self._worker.is_alive():
                return
            self._stop.clear()
            self._worker = threading.Thread(target=self._loop, name="minutes-worker", daemon=True)
            self._worker.start()
            self._ticker = threading.Thread(target=self._tick_loop, name="minutes-ticker", daemon=True)
            self._ticker.start()

    def shutdown(self, timeout: float = 3.0):
        self._stop.set()
        with self._cond:
            self._cond.notify_all()
        for thread in (self._worker, self._ticker):
            if thread and thread.is_alive() and thread is not threading.current_thread():
                thread.join(timeout)

    def recover(self):
        """上次退出时遗留的"更新中"不是真实状态，重置掉，避免界面一直转圈。"""
        for row in db.query("SELECT session_id FROM session_minutes WHERE state='updating'"):
            db.set_minutes_state(row["session_id"], "idle", "")

    # ---------------- 对外接口 ----------------
    def request(self, sid: str, final: bool = False, upto: int | None = None) -> bool:
        """排一次纪要更新。同一条记录只排一个任务；终稿可以顶掉排队中的直播更新。"""
        if not db.get_session(sid):
            return False
        with self._cond:
            job = self._jobs.get(sid)
            if job is None:
                self._jobs[sid] = {"final": bool(final), "upto": upto}
                self._order.append(sid)
            else:
                job["final"] = job["final"] or bool(final)
                if upto is not None:
                    job["upto"] = upto
            self._cond.notify()
        return True

    def finish(self, sid: str) -> bool:
        """记录结束：排终稿（用整份转写重写）。"""
        return self.request(sid, final=True)

    def status(self, sid: str) -> dict:
        row = db.get_minutes(sid)
        busy = self._running_sid == sid
        with self._cond:
            queued = bool(sid in self._jobs or sid in self._order)
        if not row:
            return {"state": "idle" if not busy else "updating", "state_text": STATE_TEXT["updating" if busy else "idle"],
                    "version": 0, "updated_at": None, "covered": 0, "kind": "", "error": "",
                    "queued": queued and not busy}
        state = "updating" if busy else row.get("state") or "idle"
        return {"state": state, "state_text": STATE_TEXT.get(state, ""), "version": row.get("version") or 0,
                "updated_at": row.get("updated_at"), "covered": row.get("covered") or 0,
                "kind": row.get("kind") or "", "error": row.get("error") or "",
                "queued": queued and not busy}

    def get(self, sid: str) -> dict:
        sess = db.get_session(sid) or {}
        row = db.get_minutes(sid) or {}
        payload = row.get("data") or {}
        scenario = payload.get("scenario") or scenario_for(sess)
        language = row.get("lang") or ""
        payload = {
            "title": payload.get("title") or "",
            "summary": payload.get("summary") or "",
            "topics": payload.get("topics") or [],
            "conclusions": payload.get("conclusions") or [],
            "todos": payload.get("todos") or [],
            "terms": payload.get("terms") or [],
            "final": bool(row.get("kind") == "final"),
            "lang": language,
            "covered": row.get("covered") or 0,
            "scenario": scenario,
            # 原生视图直接按服务端的标签与顺序渲染，避免前后端各写一份模板。
            "labels": minutes_scenarios.labels(scenario, language),
            "section_order": list(minutes_scenarios.section_order(scenario)),
        }
        # 旧版本把模型算错的 start 直接存进了库（例如 1:49:47 出现在 1:19:20 的视频里）：
        # 读的时候按证据重算一遍，页面、笔记、导出、Agent 工具拿到的都是能跳的时间。
        media_end = float(sess.get("duration") or 0) or float(row.get("covered") or 0)
        sanitize_topics(payload["topics"], media_end)
        payload.update(self.status(sid))
        # 用户互动（勾选待办 / 高亮）跟纪要一起返回：页面、导出、卡片和 Agent 工具都用同一份。
        payload["interactions"] = minutes_interactions.get(sid)
        return self._backfill_names(sid, payload)

    @staticmethod
    def _backfill_names(sid: str, notes: dict) -> dict:
        """模型写的是"发言人 6"，用户改过名后显示层换成姓名（不改库里存的内容）。"""
        import speaker_labels
        try:
            rows = rows_for_prompt(sid)
            numbers = speaker_labels.qualifying_numbers(rows)
            if not numbers:
                return notes
            speakers = ((db.get_session(sid) or {}).get("meta") or {}).get("speakers") or {}
            labels = {}
            for raw, number in numbers.items():
                name = (speakers.get(raw) or "").strip()
                if name and name != f"发言人 {number}":
                    labels[number] = name
            return speaker_labels.named(notes, labels) if labels else notes
        except Exception:
            return notes

    def clear(self, sid: str):
        with self._cond:
            self._jobs.pop(sid, None)
            if sid in self._order:
                self._order.remove(sid)
        db.delete_minutes(sid)
        minutes_interactions.clear(sid)

    # ---------------- 扫描 ----------------
    def tick_once(self) -> int:
        """检查活跃记录：有新内容且到了间隔就排一次更新。返回排了几条。"""
        mode = _auto_mode()
        if mode == "off" or not keys.get(providers.resolve().provider):
            return 0
        now = _now()
        queued = 0
        active = db.query("SELECT id, meta, status FROM sessions WHERE status IN ('recording','processing')")
        for sess in active:
            sid = sess["id"]
            rows = db.get_transcripts(sid)
            if len(rows) < MIN_LINES:
                continue
            latest = max(float(r.get("end") or 0) for r in rows)
            row = db.get_minutes(sid)
            covered = float(row.get("covered") or 0) if row else 0.0
            if mode == "live" and row and row.get("kind") == "final":
                continue
            if row and latest - covered < 20:
                continue
            if row and now - float(row.get("updated_at") or 0) < _interval():
                continue
            if row and (row.get("state") or "") in ("updating",):
                continue
            if self.request(sid, final=False):
                queued += 1
        return queued

    def _tick_loop(self):
        while not self._stop.wait(15):
            try:
                self.tick_once()
            except Exception:  # 扫描失败不能让线程死掉
                pass

    # ---------------- 工作线程 ----------------
    def _next_job(self) -> tuple[str, dict] | None:
        with self._cond:
            while not self._order and not self._stop.is_set():
                self._cond.wait(5)
            if self._stop.is_set():
                return None
            sid = self._order.pop(0)
            job = self._jobs.pop(sid, None)
            return (sid, job) if job else None

    def _loop(self):
        while not self._stop.is_set():
            item = self._next_job()
            if not item:
                continue
            sid, job = item
            self._running_sid = sid
            try:
                self._run(sid, final=bool(job.get("final")), upto=job.get("upto"))
            except Exception:
                db.set_minutes_state(sid, "failed", "整理纪要时出错")
            finally:
                self._running_sid = None

    # ---------------- 一次更新 ----------------
    def _run(self, sid: str, final: bool, upto: int | None = None):
        sess = db.get_session(sid) or {}
        scenario = scenario_for(sess)
        context_hint = _context(sess)
        lines = rows_for_prompt(sid)
        if upto is not None:
            lines = lines[:upto]
        if not lines:
            return
        existing = db.get_minutes(sid) or {}
        # 终稿从零开始重写（知了的做法）：拿上一版当底稿会让主题重复堆积。
        base = {} if final else dict(existing.get("data") or {})
        language = _language(sess)
        times = [l["start"] for l in lines]
        duration = float(sess.get("duration") or 0) or (times[-1] - times[0])
        # 上一版里可能有旧版本写坏的起点：先按证据修正，喂回模型和最后落库的都是能跳的时间。
        sanitize_topics(base.get("topics") or [], duration)

        covered = float(existing.get("covered") or 0)
        context = ""
        if final:
            spans = plan_final(len(lines)) or [(0, len(lines))]
        else:
            fresh_index = next((i for i, l in enumerate(lines) if l["start"] >= covered), None)
            if fresh_index is None:
                return
            context = context_tail(lines[:fresh_index])
            spans = [(fresh_index, min(len(lines), fresh_index + LIVE_MAX_LINES))]

        db.set_minutes_state(sid, "updating", "")
        # 终稿按 300 行切窗：每窗都把上一窗的结果发回去接着整理，最后一窗只是整份重写的收尾。
        # 之前的实现只有第一窗带当前纪要，最后一窗的回复直接替换 base，长记录于是只剩最后几百行。
        windowed_final = bool(final and len(spans) > 1)
        try:
            for position, (start, stop) in enumerate(spans):
                window = lines[start:stop]
                if not window:
                    continue
                notes = dict(base)
                notes["_context"] = context_tail(lines[:start]) if start > 0 else context
                # 只有分窗终稿才需要把上一窗的纪要发回去（直播增量本来就会带当前纪要）。
                carry = windowed_final and bool(base.get("topics"))
                prompt = build(notes, window, language=language,
                               final=bool(final), duration=duration,
                               scenario=scenario, context=context_hint, carry=carry,
                               part=(position + 1, len(spans)))
                reply = self._ask(sid, prompt, final=bool(final), language=language, times=times)
                if reply is None:
                    if windowed_final:
                        # 分窗终稿缺一段就不要落一份残缺的终稿，保留上一版更安全。
                        db.set_minutes_state(sid, "failed", "整理纪要时有一段没有返回，已保留上一版")
                        return
                    continue
                merged = merge_window(base, reply) if windowed_final else carry_times(base, reply)
                merged["title"] = merged.get("title") or base.get("title") or ""
                merged["scenario"] = scenario
                merged["updated_at"] = _now()
                base = merged
            strip_point_ids(base)
            if not base.get("topics") and not base.get("summary"):
                db.set_minutes_state(sid, "failed", "AI 没有返回可用的纪要")
                return
            covered_seconds = max(l["start"] for l in lines)
            saved = db.save_minutes(sid, base, covered=covered_seconds,
                                    kind="final" if final else "live", lang=language, state="idle", error="")
            metrics.record(sid, kind="minutes", topics=len(base.get("topics") or []),
                           terms=len(base.get("terms") or []), final=bool(final))
            if final and saved:
                # 纪要写库成功后再落笔记；同步失败不能影响纪要本身。
                try:
                    payload = self.get(sid)
                    minutes_notes.sync(sid, payload, force=False)
                except Exception:
                    pass
        except ai_client.Failure as exc:
            db.set_minutes_state(sid, exc.kind if exc.kind in STATE_TEXT else "failed", str(exc))
        except Exception as exc:  # 绝不因为一次失败覆盖已有纪要
            db.set_minutes_state(sid, "failed", str(exc)[:200])

    def _ask(self, sid: str, prompt: str, *, final: bool, language: str, times: list[float]) -> dict | None:
        """一次模型调用 + 解析 + 语言校验。语言不对时终稿再试一次，仍不对就丢弃。

        分窗终稿会把已有纪要整份发回去，输出可能很长；被 max_tokens 截断时 JSON 自然
        解析不了，这时放大预算重试，而不是把整条终稿判失败。
        """
        attempts = 2 if final else 1
        budget = 4096
        attempt = 0
        while attempt < attempts:
            attempt += 1
            reply = ai_client.chat(prompt, "只返回 JSON 纪要。", priority="notes", json_mode=True,
                                   max_tokens=budget, timeout=150, role="notes", session_id=sid,
                                   attempts=3)
            parsed = parse(reply, times)
            if parsed and written_in(parsed, language):
                return parsed
            truncated = parsed is None and str(reply).lstrip().startswith("{") \
                and not str(reply).rstrip().endswith("}")
            if truncated and budget < 8192 and attempt < 4:
                budget = min(budget * 2, 8192)
                metrics.record(sid, kind="minutes_reject", reason="truncated", attempt=attempt)
                continue
            metrics.record(sid, kind="minutes_reject", reason="parse" if not parsed else "language",
                           attempt=attempt)
        return None


engine = MinutesEngine()


# ---------------- 供任务管线调用的入口 ----------------
def request(sid: str, final: bool = False, upto: int | None = None) -> bool:
    return engine.request(sid, final=final, upto=upto)


def auto_mode() -> str:
    """off 不开 / final 结束时一次 / live 边录边更新。"""
    return _auto_mode()


def finish(sid: str) -> bool:
    """记录结束时调用；没开自动纪要、没配 key 或没有转写时安静地跳过。"""
    if _auto_mode() == "off":
        return False
    if not keys.get(providers.resolve().provider):
        db.set_minutes_state(sid, "no_key", STATE_TEXT["no_key"])
        return False
    if not db.get_transcripts(sid):
        return False
    return engine.finish(sid)


def materialize_notes(sid: str, force: bool = False) -> dict:
    """把已有纪要写进笔记（历史回填 / 用户点「写入笔记」），不调用模型。"""
    sess = db.get_session(sid)
    if not sess:
        return {"ok": False, "synced": False, "reason": "missing"}
    row = db.get_minutes(sid)
    if not row:
        return {"ok": False, "synced": False, "reason": "empty", "message": "还没有可写入的纪要"}
    payload = engine.get(sid)
    if not payload.get("topics") and not payload.get("summary"):
        return {"ok": False, "synced": False, "reason": "empty", "message": "还没有可写入的纪要"}
    payload["scenario"] = payload.get("scenario") or scenario_for(sess)
    return minutes_notes.sync(sid, payload, force=force)


def start():
    engine.recover()
    engine.start()


def shutdown(timeout: float = 3.0):
    engine.shutdown(timeout)
