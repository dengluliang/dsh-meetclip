"""说话人：规则预览、从对话里猜名字、采纳/驳回、撤销。

设计取舍：**不改写已存的 `meta["speakers"]` 语义**（默认仍是"发言人 N"），
编号规则只作为提示层，避免影响既有导出、搜索与原生端读数。
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import minutes
import speaker_labels
from ai import client as ai_client
from database import db
from routes.common import require_session

router = APIRouter()

META_GUESSES = "speaker_guesses"
META_REFUSED = "speaker_guess_refused"
META_UNDO = "speakers_undo"


def _rows(sid: str) -> list[dict]:
    return minutes.rows_for_prompt(sid)


def _meta(sid: str) -> dict:
    return (db.get_session(sid) or {}).get("meta") or {}


def _snapshot(sid: str):
    """改说话人之前留一份快照，撤销时整份回填。"""
    meta = _meta(sid)
    db.update_meta(sid, **{META_UNDO: {"speakers": meta.get("speakers") or {},
                                      META_GUESSES: meta.get(META_GUESSES) or {}}})


def _payload(sid: str) -> dict:
    rows = _rows(sid)
    meta = _meta(sid)
    numbers = speaker_labels.qualifying_numbers(rows)
    speakers = meta.get("speakers") or {}
    guesses = meta.get(META_GUESSES) or {}
    refused = meta.get(META_REFUSED) or {}
    items = []
    for raw, number in sorted(numbers.items(), key=lambda kv: kv[1]):
        default = f"发言人 {number}"
        current = (speakers.get(raw) or "").strip()
        # "发言人 N" 是转写时给的默认名，不算用户命名：猜名要能显示出来。
        user_name = "" if current == default else current
        item = {"raw": raw, "number": number, "name": user_name,
                "label": user_name or default,
                "lines": sum(1 for row in rows if row.get("speaker") == raw),
                "guess": None}
        guess = guesses.get(raw)
        if guess and not user_name:
            item["guess"] = {"name": guess.get("name"), "evidence": guess.get("evidence"),
                             "refused": (refused.get(raw) or "") == (guess.get("name") or "")}
        items.append(item)
    return {"speakers": items, "has_numbers": bool(numbers), "total": len(rows),
            "unnumbered": sum(1 for row in rows if row.get("speaker") and row["speaker"] not in numbers),
            "can_undo": bool(meta.get(META_UNDO))}


@router.get("/api/sessions/{sid}/speakers/plan")
def speakers_plan(sid: str):
    require_session(sid)
    return _payload(sid)


class GuessReq(BaseModel):
    force: bool = False


@router.post("/api/sessions/{sid}/speakers/guess")
def speakers_guess(sid: str, req: GuessReq | None = None):
    require_session(sid)
    rows = _rows(sid)
    if not speaker_labels.qualifying_numbers(rows):
        return {**_payload(sid), "skipped": "至少要有两个说话人各自说满 5 句，才需要辨认"}
    if not ai_client.has_key():
        raise HTTPException(400, "请先在 设置 → 会摘 → 模型 配置 AI Key")
    content = speaker_labels.guess_content(rows)
    if not content:
        raise HTTPException(400, "转写内容还不够，暂时无法辨认说话人")
    try:
        reply = ai_client.chat(content, speaker_labels.INSTRUCTION, priority="speakers", json_mode=True,
                               max_tokens=600, timeout=90, role="speakers", session_id=sid, attempts=2)
    except ai_client.Failure as exc:
        raise HTTPException(502, str(exc)) from None
    found, refuted = speaker_labels.read_guess(reply, rows)
    meta = _meta(sid)
    merged = speaker_labels.merge_guesses(meta.get(META_GUESSES) or {}, found, refuted, rows)
    refused = dict(meta.get(META_REFUSED) or {})
    for raw, name in refuted.items():
        refused[raw] = name
    db.update_meta(sid, **{META_GUESSES: merged or None, META_REFUSED: refused or None})
    return {**_payload(sid), "found": len(found), "refuted": len(refuted)}


class AcceptReq(BaseModel):
    raw: str
    name: str | None = None


@router.post("/api/sessions/{sid}/speakers/guess/accept")
def speakers_accept(sid: str, req: AcceptReq):
    require_session(sid)
    meta = _meta(sid)
    guesses = dict(meta.get(META_GUESSES) or {})
    guess = guesses.get(req.raw) or {}
    name = (req.name or guess.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "没有可采纳的名字")
    _snapshot(sid)
    speakers = dict(meta.get("speakers") or {})
    speakers[req.raw] = name
    guesses.pop(req.raw, None)
    db.update_meta(sid, speakers=speakers or None, **{META_GUESSES: guesses or None})
    return _payload(sid)


class RejectReq(BaseModel):
    raw: str


@router.post("/api/sessions/{sid}/speakers/guess/reject")
def speakers_reject(sid: str, req: RejectReq):
    require_session(sid)
    meta = _meta(sid)
    guesses = dict(meta.get(META_GUESSES) or {})
    refused = dict(meta.get(META_REFUSED) or {})
    guess = guesses.pop(req.raw, None)
    if guess:
        refused[req.raw] = guess.get("name") or ""
    db.update_meta(sid, **{META_GUESSES: guesses or None, META_REFUSED: refused or None})
    return _payload(sid)


@router.post("/api/sessions/{sid}/speakers/undo")
def speakers_undo(sid: str):
    require_session(sid)
    meta = _meta(sid)
    snap = meta.get(META_UNDO)
    if not snap:
        raise HTTPException(409, "没有可撤销的说话人改动")
    db.update_meta(sid, speakers=snap.get("speakers") or None,
                   **{META_GUESSES: snap.get(META_GUESSES) or None, META_UNDO: None})
    return _payload(sid)


@router.post("/api/sessions/{sid}/speakers/snapshot")
def speakers_snapshot(sid: str):
    """原生端/页面在做改名、合并前先留一份快照，撤销按钮才有东西可回。"""
    require_session(sid)
    _snapshot(sid)
    return {"ok": True}
