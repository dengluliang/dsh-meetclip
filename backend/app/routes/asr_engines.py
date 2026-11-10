"""Provider configuration and explicit minimal ASR connectivity probe."""
from dataclasses import asdict
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, SecretStr

import asr_engines as engines
import settings

router = APIRouter()


class EngineSettings(BaseModel):
    mode: str = "mify"  # mify（默认网关）| custom（自定义 API）| key（只保存 Key）
    provider: str = "mimo"
    base_url: str = engines.DEFAULT_URL
    model: str = engines.DEFAULT_MODEL
    api_key: SecretStr | None = None
    delete_api_key: bool = False


def _save_key(req: EngineSettings, account: str = "mimo") -> None:
    if req.delete_api_key:
        engines.credential(account, delete=True)
        return
    if req.api_key is None:
        return
    value = req.api_key.get_secret_value().strip()
    if not value or len(value) > 4096 or any(ch.isspace() for ch in value):
        raise ValueError("API Key 不能为空、不能包含空白字符，且最多 4096 字符")
    engines.credential(account, value=value)


@router.get("/api/asr/engines")
def engine_status():
    return engines.status()


@router.post("/api/asr/engines")
def engine_settings(req: EngineSettings):
    try:
        mode = (req.mode or "mify").strip()
        if mode == "key":
            _save_key(req)
            return engines.status()
        if mode == "custom":
            config = engines.validate_config("mimo", req.base_url, req.model)
            _save_key(req, engines.ASR_CUSTOM_ACCOUNT)
            settings.update(asr_custom_base=config["base_url"], asr_custom_model=config["model"],
                            asr_provider="mimo")
            return engines.status()
        if mode != "mify":
            raise ValueError("mode 只能是 mify、custom 或 key")
        config = engines.validate_config(req.provider, req.base_url, req.model)
        _save_key(req)
        settings.update(asr_provider=config["provider"], mimo_base_url=config["base_url"],
                        mimo_model=config["model"], asr_custom_base="", asr_custom_model="")
        return engines.status()
    except (ValueError, engines.ProviderError) as exc:
        raise HTTPException(400, str(exc)) from None


class EngineProbe(BaseModel):
    """设置页「测试连接」：可以测还没保存的候选模型，传空则测当前配置。"""
    base_url: str | None = None
    model: str | None = None
    api_key: SecretStr | None = None


@router.post("/api/asr/engines/test")
def engine_test(req: EngineProbe | None = None):
    try:
        config = dict(engines.default_config("mimo"))
        if req and (req.base_url or req.model or req.api_key):
            probe = engines.validate_config("mimo", req.base_url or config["base_url"],
                                            req.model or config["model"])
            config.update(probe)
            if req.api_key and req.api_key.get_secret_value().strip():
                config["api_key"] = req.api_key.get_secret_value().strip()
        if not config.get("api_key") and not engines.credential(config.get("key_account") or "mimo"):
            raise engines.ProviderError("请先配置 API Key", fatal=True)
        # Explicit user action only; synthetic silence avoids uploading private recordings.
        provider = engines.PROVIDERS["mimo"](config)
        result = provider.recognize(np.zeros(16000, dtype=np.float32), language="", on_partial=lambda _: None)
        return {"ok": True, "model": config["model"], "base_url": config["base_url"],
                "message": "已完成 1 秒测试音频请求；识别效果与直播延迟需使用真实音频验证",
                "metrics": result.metrics, "capabilities": asdict(provider.capabilities)}
    except (ValueError, engines.ProviderError) as exc:
        raise HTTPException(502, str(exc)) from None
