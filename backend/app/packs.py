"""首页卡包：把墙面上的卡片收进一个容器，成员内容仍由各自的表维护。

卡包只存归属关系，不复制卡片数据。读取时统一 hydrate 成员摘要；成员被删除后
直接跳过，避免首页因为历史卡包报 500。

手工收纳（/api/packs）仍拒绝进行中的记录；会议音视频批量导入是内部入口，
会在记录入队后立刻建包，因此允许成员处于 queued/processing。
"""
from __future__ import annotations

import re
import sqlite3
import time
import uuid

from database import db

MEMBER_TYPES = ("session", "batch", "highlight", "note", "image", "doc")
ACTIVE_SESSION_STATES = ("recording", "processing", "queued")
MAX_PACKS = 200
MAX_MEMBERS = 60
MAX_TITLE = 80
PACK_ID_RE = re.compile(r"^[a-z0-9-]{8,40}$")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


class PackError(Exception):
    """带 HTTP 状态码的业务错误，由 routes 转成 JSON。"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _text(value, limit=200):
    text = re.sub(r"<!--.*?-->", " ", str(value or ""), flags=re.S)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def _clean_title(value):
    title = CONTROL_RE.sub("", str(value or "")).strip()
    if not title:
        raise PackError(400, "卡包名称不能为空")
    if len(title) > MAX_TITLE:
        raise PackError(400, f"卡包名称不能超过 {MAX_TITLE} 个字")
    return title


def _clean_member_id(value):
    member_id = CONTROL_RE.sub("", str(value or "")).strip()
    if not member_id or len(member_id) > 120:
        raise PackError(400, "卡片标识无效")
    return member_id


def _normalize_member(item):
    """把 {type,id} / tuple 统一成 (type, canonical_id)；只做格式与类型校验。"""
    if isinstance(item, dict):
        member_type = str(item.get("type") or "").strip().lower()
        member_id = item.get("id")
    elif isinstance(item, (list, tuple)) and len(item) == 2:
        member_type = str(item[0] or "").strip().lower()
        member_id = item[1]
    else:
        raise PackError(400, "卡片成员格式无效")
    if member_type not in MEMBER_TYPES:
        raise PackError(400, "不支持的卡片类型")
    member_id = _clean_member_id(member_id)
    if member_type == "highlight":
        try:
            member_id = str(int(float(member_id)))
        except (TypeError, ValueError):
            raise PackError(400, "标记标识无效")
    if member_type == "doc":
        if not member_id.startswith("doc:"):
            member_id = f"doc:{member_id}"
        if len(member_id) <= 4:
            raise PackError(400, "文档标识无效")
    return member_type, member_id


def _member_key(member_type, member_id):
    return f"{member_type}:{member_id}"


def _normalize_members(items, limit=MAX_MEMBERS):
    if items is None:
        items = []
    if not isinstance(items, (list, tuple)):
        raise PackError(400, "卡片成员格式无效")
    result = []
    seen = set()
    for item in items:
        member_type, member_id = _normalize_member(item)
        key = _member_key(member_type, member_id)
        if key in seen:
            continue
        seen.add(key)
        result.append((member_type, member_id))
    if len(result) > limit:
        raise PackError(400, f"一个卡包最多放 {MAX_MEMBERS} 张卡片")
    return result


def _catalog():
    """一次读出 hydration 需要的轻量目录，避免每个成员单独查库。"""
    sessions = {
        str(row.get("id")): row
        for row in db.query(
            "SELECT id,title,kind,status,created_at,started_at,duration "
            "FROM sessions"
        )
    }
    marks = {
        str(row.get("id")): row
        for row in db.query(
            "SELECT m.id,m.session_id,m.ts,m.note,m.created_at,s.title AS session_title,s.kind "
            "FROM marks m JOIN sessions s ON s.id=m.session_id"
        )
    }
    notes = {str(row.get("id")): row for row in db.list_sticky_notes()}
    images = {str(row.get("id")): row for row in db.list_board_images()}
    docs = {f"doc:{row.get('key')}": row for row in db.list_doc_cards()}
    batches = {str(row.get("id")): row for row in db.list_link_batches(1000)}
    return {"sessions": sessions, "marks": marks, "notes": notes,
            "images": images, "docs": docs, "batches": batches}


def _session_active(row):
    return str(row.get("status") or "") in ACTIVE_SESSION_STATES


def _batch_active(row):
    return int(row.get("active") or 0) > 0


def _describe_member(member_type, member_id, catalog):
    if member_type == "session":
        row = catalog["sessions"].get(member_id)
        if not row:
            return None
        return {
            "type": "session", "id": member_id,
            "title": _text(row.get("title"), 160) or "未命名记录",
            "subtitle": "",
            "kind": row.get("kind") or "live",
            "status": row.get("status") or "",
            "created_at": row.get("started_at") or row.get("created_at"),
            "duration": float(row.get("duration") or 0),
            "active": _session_active(row),
        }
    if member_type == "batch":
        row = catalog["batches"].get(member_id)
        if not row:
            return None
        counts = row.get("counts") if isinstance(row.get("counts"), dict) else {}
        return {
            "type": "batch", "id": member_id,
            "title": _text(row.get("title"), 160) or "批量视频",
            "subtitle": "",
            "kind": "link_video",
            "status": "active" if _batch_active(row) else "done",
            "created_at": row.get("created_at"),
            "count": int(row.get("total") or 0),
            "active": _batch_active(row),
            "counts": counts,
        }
    if member_type == "highlight":
        row = catalog["marks"].get(member_id)
        if not row:
            return None
        return {
            "type": "highlight", "id": member_id,
            "title": _text(row.get("note"), 160) or "标记",
            "subtitle": _text(row.get("session_title"), 80),
            "kind": row.get("kind") or "live",
            "status": "done",
            "session_id": row.get("session_id"),
            "session_title": _text(row.get("session_title"), 80),
            "ts": float(row.get("ts") or 0),
            "created_at": row.get("created_at"),
        }
    if member_type == "note":
        row = catalog["notes"].get(member_id)
        if not row:
            return None
        kind = row.get("kind") or "note"
        return {
            "type": "note", "id": member_id,
            "title": _text(row.get("text"), 160) or ("待办清单" if kind == "todo" else "便利签"),
            "subtitle": "待办清单" if kind == "todo" else "便利签",
            "kind": kind,
            "status": "done",
            "checked": row.get("checked") or [],
            "created_at": row.get("created_at"),
        }
    if member_type == "image":
        row = catalog["images"].get(member_id)
        if not row:
            return None
        return {
            "type": "image", "id": member_id,
            "title": "图片卡",
            "subtitle": "",
            "kind": "image",
            "status": "done",
            "width": int(row.get("width") or 0),
            "height": int(row.get("height") or 0),
            "created_at": row.get("created_at"),
        }
    if member_type == "doc":
        row = catalog["docs"].get(member_id)
        if not row:
            return None
        return {
            "type": "doc", "id": member_id,
            "title": _text(row.get("title"), 160) or "飞书文档",
            "subtitle": "",
            "kind": "doc",
            "status": "done",
            "url": str(row.get("url") or ""),
            "doc_type": str(row.get("doc_type") or "docx"),
            "has_content": bool(str(row.get("content") or "").strip()),
            "created_at": row.get("updated_at"),
        }
    return None


def _pack_payload(row, member_rows, catalog):
    members = []
    for member in member_rows:
        described = _describe_member(str(member.get("member_type") or ""),
                                     str(member.get("member_id") or ""), catalog)
        if described:
            members.append(described)
    return {
        "id": str(row.get("id") or ""),
        "title": str(row.get("title") or "卡包"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "count": len(members),
        "active_count": sum(1 for member in members if member.get("active")),
        "members": members,
    }


def _member_rows_by_pack():
    grouped = {}
    for row in db.list_card_pack_members():
        grouped.setdefault(str(row.get("pack_id") or ""), []).append(row)
    return grouped


def list_packs(limit=MAX_PACKS):
    rows = db.list_card_packs()[:max(0, int(limit or 0))]
    if not rows:
        return []
    catalog = _catalog()
    grouped = _member_rows_by_pack()
    return [_pack_payload(row, grouped.get(str(row.get("id") or ""), []), catalog) for row in rows]


def get_pack(pack_id):
    row = db.get_card_pack(pack_id)
    if not row:
        raise PackError(404, "卡包不存在")
    catalog = _catalog()
    return _pack_payload(row, db.list_card_pack_members(pack_id), catalog)


def _assert_exists(member_type, member_id, catalog, allow_active_sessions=False):
    if member_type == "session":
        row = catalog["sessions"].get(member_id)
        if not row:
            raise PackError(400, "这张记录不存在或已删除")
        if _session_active(row) and not allow_active_sessions:
            raise PackError(409, "进行中的记录不能放进卡包")
        return
    if member_type == "batch":
        row = catalog["batches"].get(member_id)
        if not row:
            raise PackError(400, "这个批次不存在或已删除")
        if _batch_active(row):
            raise PackError(409, "进行中的批次不能放进卡包")
        return
    if member_type == "highlight":
        if member_id not in catalog["marks"]:
            raise PackError(400, "这条标记不存在或已删除")
        return
    if member_type == "note":
        if member_id not in catalog["notes"]:
            raise PackError(400, "这张便利签不存在或已删除")
        return
    if member_type == "image":
        if member_id not in catalog["images"]:
            raise PackError(400, "这张图片不存在或已删除")
        return
    if member_type == "doc":
        if member_id not in catalog["docs"]:
            raise PackError(400, "这篇文档不存在或已删除")
        return
    raise PackError(400, "不支持的卡片类型")


def _validate_members_for_add(items, catalog):
    members = _normalize_members(items)
    for member_type, member_id in members:
        _assert_exists(member_type, member_id, catalog)
    return members


def next_title():
    numbers = []
    for row in db.query("SELECT title FROM card_packs"):
        match = re.fullmatch(r"卡包\s*(\d+)", str(row.get("title") or "").strip())
        if match:
            numbers.append(int(match.group(1)))
    return f"卡包 {max(numbers) + 1 if numbers else 1}"


def _new_id():
    return uuid.uuid4().hex[:12]


def _same_members(existing, wanted):
    existing_keys = {_member_key(row.get("member_type"), row.get("member_id")) for row in existing}
    wanted_keys = {_member_key(member_type, member_id) for member_type, member_id in wanted}
    return existing_keys == wanted_keys


def create_pack(pack_id="", title="", members=None, allow_active_sessions=False):
    members = _normalize_members(members)
    catalog = _catalog()
    for member_type, member_id in members:
        _assert_exists(member_type, member_id, catalog,
                       allow_active_sessions=allow_active_sessions)

    pack_id = str(pack_id or "").strip()
    if pack_id and not PACK_ID_RE.match(pack_id):
        raise PackError(400, "卡包标识无效")

    existing = db.get_card_pack(pack_id) if pack_id else None
    if existing:
        current = db.list_card_pack_members(pack_id)
        if _same_members(current, members):
            return get_pack(pack_id)
        raise PackError(409, "卡包标识已存在")
    if not pack_id:
        pack_id = _new_id()

    for member_type, member_id in members:
        owner = db.card_pack_for_member(member_type, member_id)
        if owner:
            raise PackError(409, "这张卡片已经在另一个卡包里")

    clean_title = _clean_title(title) if str(title or "").strip() else next_title()
    try:
        row = db.create_card_pack(pack_id, clean_title, members)
    except sqlite3.IntegrityError:
        raise PackError(409, "卡片已被另一个操作收进卡包，请刷新后再试")
    return _pack_payload(row, db.list_card_pack_members(pack_id), catalog)


def rename_pack(pack_id, title):
    row = db.get_card_pack(pack_id)
    if not row:
        raise PackError(404, "卡包不存在")
    clean_title = _clean_title(title)
    updated = db.update_card_pack(pack_id, {"title": clean_title, "updated_at": time.time()})
    catalog = _catalog()
    return _pack_payload(updated, db.list_card_pack_members(pack_id), catalog)


def add_members(pack_id, members=None):
    row = db.get_card_pack(pack_id)
    if not row:
        raise PackError(404, "卡包不存在")
    catalog = _catalog()
    wanted = _validate_members_for_add(members, catalog)
    current = db.list_card_pack_members(pack_id)

    new_members = []
    for member_type, member_id in wanted:
        owner = db.card_pack_for_member(member_type, member_id)
        if owner:
            if str(owner.get("pack_id")) == str(pack_id):
                continue
            raise PackError(409, "这张卡片已经在另一个卡包里")
        new_members.append((member_type, member_id))

    if len(current) + len(new_members) > MAX_MEMBERS:
        raise PackError(400, f"一个卡包最多放 {MAX_MEMBERS} 张卡片")
    if new_members:
        try:
            db.add_card_pack_members(pack_id, new_members)
        except sqlite3.IntegrityError:
            raise PackError(409, "卡片已被另一个操作收进卡包，请刷新后再试")
    return _pack_payload(db.get_card_pack(pack_id), db.list_card_pack_members(pack_id), catalog)


def remove_members(pack_id, members=None):
    row = db.get_card_pack(pack_id)
    if not row:
        raise PackError(404, "卡包不存在")
    wanted = _normalize_members(members)
    if wanted:
        db.remove_card_pack_members(pack_id, wanted)
    catalog = _catalog()
    return _pack_payload(db.get_card_pack(pack_id), db.list_card_pack_members(pack_id), catalog)


def reorder_members(pack_id, members=None):
    row = db.get_card_pack(pack_id)
    if not row:
        raise PackError(404, "卡包不存在")
    wanted = _normalize_members(members)
    current = db.list_card_pack_members(pack_id)
    current_keys = {_member_key(row.get("member_type"), row.get("member_id")) for row in current}
    for member_type, member_id in wanted:
        if _member_key(member_type, member_id) not in current_keys:
            raise PackError(400, "卡片不在这个卡包里")
    db.reorder_card_pack_members(pack_id, wanted)
    catalog = _catalog()
    return _pack_payload(db.get_card_pack(pack_id), db.list_card_pack_members(pack_id), catalog)


def delete_pack(pack_id):
    row = db.get_card_pack(pack_id)
    if not row:
        raise PackError(404, "卡包不存在")
    members = db.delete_card_pack(pack_id)
    return {
        "id": str(row.get("id") or ""),
        "title": str(row.get("title") or "卡包"),
        "members": [
            {"type": str(member.get("member_type") or ""), "id": str(member.get("member_id") or "")}
            for member in members
        ],
    }
