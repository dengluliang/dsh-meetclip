"""Authentication for the loopback API used by the native app."""
from __future__ import annotations

import os
import secrets

from database import DATA_DIR

TOKEN_PATH = DATA_DIR / ".api-token"


def ensure_token() -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    if len(token) < 32:
        token = secrets.token_urlsafe(32)
        tmp = TOKEN_PATH.with_suffix(".tmp")
        tmp.write_text(token + "\n", encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, TOKEN_PATH)
        try:
            os.chmod(TOKEN_PATH, 0o600)
        except OSError:
            pass
    return token


API_TOKEN = ensure_token()


def valid(value: str | None) -> bool:
    return bool(value) and secrets.compare_digest(value, API_TOKEN)


def token_from_request(request) -> str:
    return (request.headers.get("x-meetclip-token")
            or request.query_params.get("token")
            or "")
