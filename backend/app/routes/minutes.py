"""AI 纪要、AI 服务配置、诊断指标、字幕/文档导出与"继续记录"。

纪要的读写都走 `minutes` 引擎；这里只做校验与形状转换，方便 Agent 工具与页面复用同一套接口。
"""
import urllib.parse

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

import capture
import export_srt
import minutes
import minutes_interactions
import minutes_notes
import settings
import speaker_labels
from ai import client as ai_client
from ai import keys as ai_keys
from ai import gate as gate_mod
from ai import metrics as ai_metrics
from ai import providers
from routes.common import require_session

router = APIRouter()


# ---------------- 纪要 ----------------
@router.get("/api/sessions/{sid}/minutes")
def get_minutes(sid: str):
    require_session(sid)
    return minutes.engine.get(sid)


class MinutesReq(BaseModel):
    mode: str = "final"      # final 整份重写 / live 只补增量


@router.get("/api/sessions/{sid}/minutes.md")
def get_minutes_markdown(sid: str, links: bool = True):
    """把结构化纪要投影成 Markdown：复制、分享与导出共用同一份渲染。"""
    require_session(sid)
    payload = minutes.engine.get(sid)
    if not any(payload.get(key) for key in ("summary", "topics", "conclusions", "todos", "terms")):
        raise HTTPException(404, "还没有可导出的纪要")
    return PlainTextResponse(minutes_notes.build_projection(payload, links=links))


@router.post("/api/sessions/{sid}/minutes")
def build_minutes(sid: str, req: MinutesReq | None = None):
    require_session(sid)
    mode = (req.mode if req else "final") or "final"
    if mode not in ("final", "live"):
        raise HTTPException(400, "mode 只能是 final 或 live")
    if not ai_client.has_key():
        raise HTTPException(400, "请先在 设置 → 会摘 → 模型 配置 AI Key，纪要需要文本模型")
    if not _has_rows(sid):
        raise HTTPException(400, "这条记录还没有转写内容，暂时无法整理纪要")
    queued = minutes.engine.request(sid, final=(mode == "final"))
    return {"queued": queued, **minutes.engine.get(sid)}


def _has_rows(sid: str) -> bool:
    return bool(minutes.rows_for_prompt(sid))


@router.post("/api/sessions/{sid}/minutes/notes")
def materialize_minutes_notes(sid: str, force: bool = False):
    """把已有的结构化纪要写进笔记，不调用模型；历史记录打开时懒回填也走这里。"""
    require_session(sid)
    result = minutes.materialize_notes(sid, force=force)
    if not result.get("ok"):
        raise HTTPException(400, result.get("message") or "还没有可写入的纪要")
    return result


class InteractionsReq(BaseModel):
    # 前端可以整份回传（dict / list 两种历史写法都接受）；服务端负责归一化。
    todos: dict | list | None = None
    highlights: list | None = None


@router.get("/api/sessions/{sid}/minutes/interactions")
def get_minutes_interactions(sid: str):
    require_session(sid)
    return {"ok": True, "interactions": minutes_interactions.get(sid)}


@router.put("/api/sessions/{sid}/minutes/interactions")
def put_minutes_interactions(sid: str, req: InteractionsReq):
    """保存勾选/高亮，并把同一份状态同步进笔记里的纪要段落（让笔记与 Agent 都看得到）。

    互动写在单独的表里：重新整理纪要不会丢；笔记段落只是投影，写失败也不影响互动本身。
    """
    require_session(sid)
    doc = minutes_interactions.save(sid, req.model_dump())
    sync = None
    try:
        payload = minutes.engine.get(sid)
        if any(payload.get(key) for key in ("summary", "topics", "conclusions", "todos", "terms")):
            sync = minutes_notes.sync(sid, payload, force=False)
    except Exception as exc:  # 笔记同步失败不影响用户点选
        sync = {"ok": False, "synced": False, "reason": "error", "message": str(exc)[:200]}
    return {"ok": True, "interactions": doc, "notes_sync": sync}


@router.delete("/api/sessions/{sid}/minutes/interactions")
def delete_minutes_interactions(sid: str):
    require_session(sid)
    minutes_interactions.clear(sid)
    try:
        payload = minutes.engine.get(sid)
        if any(payload.get(key) for key in ("summary", "topics", "conclusions", "todos", "terms")):
            minutes_notes.sync(sid, payload, force=False)
    except Exception:
        pass
    return {"ok": True, "interactions": minutes_interactions.get(sid)}


@router.delete("/api/sessions/{sid}/minutes")
def delete_minutes(sid: str):
    require_session(sid)
    minutes.engine.clear(sid)
    return {"ok": True}


# ---------------- 诊断指标 ----------------
@router.get("/api/sessions/{sid}/metrics")
def get_metrics(sid: str):
    require_session(sid)
    return ai_metrics.summary(sid)


@router.get("/api/sessions/{sid}/metrics.txt")
def get_metrics_text(sid: str):
    sess = require_session(sid)
    text = "\n".join(ai_metrics.report_lines(sid, sess.get("title") or ""))
    return Response(text, media_type="text/plain; charset=utf-8")


# ---------------- AI 服务配置 ----------------
class AIConfigReq(BaseModel):
    provider: str | None = None
    base_url: str | None = None
    model: str | None = None
    minutes_auto: str | None = None
    minutes_interval: float | None = None
    minutes_language: str | None = None
    auto_end_silence: str | None = None
    auto_end_after: float | None = None


@router.get("/api/ai/status")
def ai_status():
    data = ai_client.status()
    data.update(notes_language=settings.get("minutes_language"),
                minutes_auto=settings.get("minutes_auto"),
                minutes_interval=settings.get("minutes_interval"),
                auto_end_silence=settings.get("auto_end_silence"),
                auto_end_after=settings.get("auto_end_after"),
                languages=list(providers.LANGUAGE_CHOICES))
    return data


@router.post("/api/ai/config")
def ai_config(req: AIConfigReq):
    changes = {}
    if req.provider is not None:
        if req.provider not in providers.PROVIDERS:
            raise HTTPException(400, "不支持的 AI 服务")
        changes["ai_provider"] = req.provider
    if req.base_url is not None:
        base = req.base_url.strip()
        if base and not (base.startswith("https://") or base.startswith("http://127.0.0.1")
                         or base.startswith("http://localhost")):
            raise HTTPException(400, "AI 服务地址必须为 HTTPS（本机服务可用 http://127.0.0.1）")
        changes["ai_base_url"] = base
    if req.model is not None:
        model = req.model.strip()
        if len(model) > 200:
            raise HTTPException(400, "模型名称最多 200 字符")
        changes["ai_text_model"] = model
    if req.minutes_auto is not None:
        if req.minutes_auto not in minutes.AUTO_MODES:
            raise HTTPException(400, "纪要模式只能是 off、final 或 live")
        changes["minutes_auto"] = req.minutes_auto
    if req.minutes_interval is not None:
        changes["minutes_interval"] = max(45.0, min(900.0, float(req.minutes_interval)))
    if req.minutes_language is not None:
        changes["minutes_language"] = req.minutes_language.strip()[:40]
    if req.auto_end_silence is not None:
        if req.auto_end_silence not in ("off", "prompt", "end"):
            raise HTTPException(400, "自动结束只能是 off、prompt 或 end")
        changes["auto_end_silence"] = req.auto_end_silence
    if req.auto_end_after is not None:
        changes["auto_end_after"] = max(60.0, min(7200.0, float(req.auto_end_after)))
    if changes:
        settings.update(**changes)
    gate_mod.shared(providers.resolve().spacing)
    return ai_status()


class AIKeyReq(BaseModel):
    api_key: str


@router.post("/api/ai/key")
def ai_key(req: AIKeyReq):
    from ai import keys
    value = (req.api_key or "").strip()
    if not value or "\n" in value or "\r" in value:
        raise HTTPException(400, "API Key 不能为空且不能包含换行")
    try:
        keys.save(value)
    except Exception as exc:  # 钥匙串不可用时给出明确原因，不回退明文
        raise HTTPException(400, f"无法写入钥匙串：{exc}") from None
    return {"saved": True, "check": ai_client.check_key()}


@router.delete("/api/ai/key")
def ai_key_delete():
    from ai import keys
    keys.remove()
    return ai_client.status()


@router.post("/api/ai/check")
def ai_check():
    return ai_client.check_key()


class AITestReq(BaseModel):
    """设置页「测试连接」：可测列表里刚选、还没保存的文字模型。"""
    provider: str | None = None
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None


@router.post("/api/ai/test")
def ai_test(req: AITestReq | None = None):
    merged = dict(settings.get_all())
    if req:
        if req.provider:
            merged["ai_provider"] = req.provider
        if req.base_url is not None:
            merged["ai_base_url"] = req.base_url.strip()
        if req.model:
            merged["ai_text_model"] = req.model.strip()
    config = providers.resolve(merged)
    key = (req.api_key or "").strip() if req else ""
    if not key:
        key = ai_keys.get(config.provider)
    if not key:
        return {"ok": False, "kind": "no_key", "message": "尚未配置 AI Key",
                "provider": config.provider, "model": config.model}
    result = ai_client.check_key(15.0, config=config, key=key)
    result.setdefault("provider", config.provider)
    result["model"] = config.model
    result["wire_model"] = providers.wire_model(config)
    result["base_url"] = config.base
    return result


@router.get("/api/ai/models")
def ai_models():
    return {"models": ai_client.probe_models()}


# ---------------- 导出：SRT / VTT / DOCX ----------------
def _attachment(content: bytes | str, media_type: str, filename: str) -> Response:
    quoted = urllib.parse.quote(filename)
    return Response(content, media_type=media_type,
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"})


def _export_name(sid: str, suffix: str) -> str:
    sess = require_session(sid)
    title = (sess.get("title") or sid).strip()[:80]
    return f"{title}.{suffix}"


@router.get("/api/sessions/{sid}/export.srt")
def export_srt_file(sid: str):
    require_session(sid)
    return _attachment(export_srt.build_srt(sid), "application/x-subrip; charset=utf-8",
                       _export_name(sid, "srt"))


@router.get("/api/sessions/{sid}/export.vtt")
def export_vtt_file(sid: str):
    require_session(sid)
    return _attachment(export_srt.build_vtt(sid), "text/vtt; charset=utf-8", _export_name(sid, "vtt"))


@router.get("/api/sessions/{sid}/export.docx")
def export_docx_file(sid: str):
    require_session(sid)
    return _attachment(export_srt.build_docx(sid),
                       "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                       _export_name(sid, "docx"))


# ---------------- 自动结束：继续记录 ----------------
@router.post("/api/sessions/{sid}/keep-going")
def keep_going(sid: str):
    require_session(sid)
    task = capture.get_task(sid)
    if not task or not hasattr(task, "keep_going"):
        raise HTTPException(409, "这条记录当前没有在采集")
    task.keep_going()
    return {"ok": True}


@router.post("/api/sessions/{sid}/stop-capture")
def stop_capture(sid: str):
    """自动结束时界面上的"现在就结束"。与原有停止接口等价，单独留一个语义清晰的名字。"""
    require_session(sid)
    if not capture.stop_capture(sid):
        raise HTTPException(409, "这条记录当前没有在采集")
    return {"ok": True}
