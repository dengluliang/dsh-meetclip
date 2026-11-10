"""只读拉取网关的模型目录：用于设置页与首次引导的模型选择。

不写盘、不缓存、不记日志；失败一律转成可展示的中文原因。
"""
from __future__ import annotations

import httpx

TIMEOUT = 20.0


class CatalogError(Exception):
    """目录获取失败，消息可直接展示给用户。"""


def fetch_models(base_url: str, api_key: str, timeout: float = TIMEOUT) -> list[str]:
    base = (base_url or "").strip().rstrip("/")
    key = (api_key or "").strip()
    if not base.startswith("https://"):
        raise CatalogError("网关地址必须为 HTTPS")
    if not key:
        raise CatalogError("尚未配置 API Key")
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            response = client.get(base + "/models", headers={"Authorization": "Bearer " + key})
    except httpx.TimeoutException:
        raise CatalogError("连接网关超时，请稍后重试") from None
    except (httpx.HTTPError, httpx.InvalidURL):
        raise CatalogError("连不上网关，请检查网络或代理") from None
    if response.status_code in (401, 403):
        raise CatalogError("API Key 无效或没有模型权限")
    if response.status_code != 200:
        raise CatalogError(f"网关返回 HTTP {response.status_code}")
    try:
        data = response.json()
    except ValueError:
        raise CatalogError("网关没有返回模型列表") from None

    seen: set[str] = set()
    models: list[str] = []
    for item in data.get("data") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("id") or "").strip()
        if not name or name.endswith(":batch") or name in seen:
            continue
        seen.add(name)
        models.append(name)
    return models
