"""路由共用的校验与提示文案。"""
import re

from fastapi import HTTPException

from database import db
from hints import HINT_ASR, HINT_FFMPEG  # noqa: F401  供各路由统一引用

SID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def require_session(sid: str, kind: str | None = None, message: str = "记录不存在"):
    if not SID_RE.fullmatch(sid or ""):
        raise HTTPException(404, message)
    sess = db.get_session(sid)
    if not sess or (kind and sess.get("kind") != kind):
        raise HTTPException(404, message)
    return sess
