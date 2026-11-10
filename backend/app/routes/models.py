"""端侧模型：语音识别（Qwen3-ASR）。

旧的时间戳对齐与说话人分离模型已下线，这里只保留一个清理入口，用于释放旧版本
遗留的 1.2 GB 对齐模型和 31 MB pyannote 模型。
"""
import hashlib
import shutil
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, SecretStr

import asr
import asr_engines
import meeting
import model_catalog
from database import DATA_DIR

router = APIRouter()

LEGACY_MODELS = {
    "aligner": ("词级时间戳 ForcedAligner", DATA_DIR / "models" / "Qwen3-ForcedAligner-0.6B-8bit"),
    "diarize": ("说话人分离 pyannote", DATA_DIR / "models" / "pyannote-speaker-diarization-community-1"),
}


def _status():
    return asr.manager.status()


@router.get("/api/asr/status")
def asr_status():
    return _status()


@router.post("/api/asr/download")
def asr_download():
    try:
        asr.manager.start_download()
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    return _status()


@router.post("/api/asr/cancel")
def asr_cancel():
    asr.manager.cancel_download()
    return {"ok": True}


@router.delete("/api/asr/model")
def asr_delete():
    try:
        asr.manager.delete_model()
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return _status()


@router.get("/api/models/legacy")
def legacy_models():
    items = []
    for kind, (title, path) in LEGACY_MODELS.items():
        exists = path.is_dir()
        items.append({"id": kind, "title": title, "exists": exists,
                      "size_on_disk": asr._dir_size(path) if exists else 0})
    return {"models": items, "total_size": sum(item["size_on_disk"] for item in items)}


@router.delete("/api/models/legacy/{kind}")
def legacy_delete(kind: str):
    target = LEGACY_MODELS.get(kind)
    if not target:
        raise HTTPException(404, "未知的旧模型")
    path = target[1]
    if path.parent != DATA_DIR / "models":
        raise HTTPException(409, "模型目录不在数据目录内，已拒绝删除")
    if not path.is_dir():
        return {"ok": True, "deleted": False}
    shutil.rmtree(path, ignore_errors=True)
    return {"ok": True, "deleted": not path.exists()}


@router.get("/api/meeting/options")
def meeting_options(asr_provider: str | None = None):
    try:
        config = asr_engines.default_config(asr_provider)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    languages = asr_engines.resolve(config).capabilities.languages
    return {
        "languages": [{"id": k, "name": v} for k, v in meeting.LANGUAGES if k in languages],
        "asr_ready": asr_engines.ready(config),
        "asr_provider": config["provider"],
        "hotwords_supported": config["provider"] == "local",
    }


_USABLE_CACHE: dict[str, tuple[float, dict]] = {}
_USABLE_TTL = 600.0


class UsableProbe(BaseModel):
    """可选：用还没保存的地址 / Key 试跑一轮可用性探测。"""
    base_url: str | None = None
    api_key: SecretStr | None = None


@router.post("/api/models/usable")
def models_usable(req: UsableProbe | None = None):
    """只留下这个 Key 真正能调通的模型。

    网关的 /models 会列出全部模型，权限之外的模型要等调用时才 401；这里用极短的
    探测请求逐个确认，结果按「地址 + Key + 模型清单」缓存 10 分钟。
    """
    try:
        config = asr_engines.default_config("mimo")
        base = (req.base_url if req and req.base_url else config["base_url"]).strip()
        if not base:
            return {"ok": False, "error": "请先填写服务地址（Base URL）", "usable": [], "text": [], "speech": []}
        key = (req.api_key.get_secret_value().strip() if req and req.api_key
               else (asr_engines.credential() or ""))
    except (ValueError, asr_engines.ProviderError) as exc:
        return {"ok": False, "error": str(exc), "usable": [], "text": [], "speech": []}
    if not key:
        return {"ok": False, "error": "尚未配置 API Key", "usable": [], "text": [], "speech": []}
    try:
        entries = model_catalog.fetch_entries(base, key)
    except model_catalog.CatalogError as exc:
        return {"ok": False, "error": str(exc), "usable": [], "text": [], "speech": []}

    fingerprint = hashlib.sha256(
        (base + "|" + key[-6:] + "|" + ",".join(entry["wire"] for entry in entries)).encode()
    ).hexdigest()
    cached = _USABLE_CACHE.get(fingerprint)
    if cached and time.monotonic() - cached[0] < _USABLE_TTL:
        return {**cached[1], "ok": True, "cached": True}

    result = model_catalog.probe_usable(entries, base, key, concurrency=10)
    _USABLE_CACHE[fingerprint] = (time.monotonic(), result)
    return {**result, "ok": True, "cached": False}


@router.get("/api/models/catalog")
def models_catalog():
    """只读列出网关可用模型；无 Key / 网络失败时返回空表与原因，不抛 500。"""
    try:
        config = asr_engines.default_config("mimo")
    except ValueError as exc:
        return {"models": [], "count": 0, "has_key": False, "error": str(exc)}
    try:
        key = asr_engines.credential()
    except asr_engines.ProviderError as exc:
        return {"models": [], "count": 0, "has_key": False, "error": str(exc)}
    if not key:
        return {"models": [], "count": 0, "has_key": False, "error": "尚未配置 API Key"}
    try:
        entries = model_catalog.fetch_entries(config["base_url"], key)
    except model_catalog.CatalogError as exc:
        return {"models": [], "entries": [], "count": 0, "has_key": True, "error": str(exc)}
    models = [entry["wire"] for entry in entries]
    return {"models": models, "entries": entries, "count": len(models), "has_key": True, "error": ""}
