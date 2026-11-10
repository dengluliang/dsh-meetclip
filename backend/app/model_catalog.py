"""只读拉取网关的模型目录：用于设置页与首次引导的模型选择。

不写盘、不缓存、不记日志；失败一律转成可展示的中文原因。

OpenAI 兼容网关的 `/models` 会给每个模型一个 `owned_by`（供应商）。多数网关要求
调用时写成 `供应商/模型名`，而列表里的 `id` 往往不带供应商；同一个 `id` 还可能
由不同供应商提供（例如 `deepseek-v4-flash` 同时挂在 deepseek 与 volcengine_maas
下）。因此这里统一按 `owned_by` 补出可直接调用的模型名，避免用户在引导里选中
一个“看起来对、实际调不通”的裸 id。
"""
from __future__ import annotations

import httpx

TIMEOUT = 20.0


class CatalogError(Exception):
    """目录获取失败，消息可直接展示给用户。"""


def qualify(name: str, vendor: str = "") -> str:
    """把目录里的裸 id 补成可调用模型名；已经带供应商的保持原样。"""
    model = (name or "").strip()
    owner = (vendor or "").strip()
    if not model or "/" in model or not owner:
        return model
    return owner + "/" + model


def fetch_entries(base_url: str, api_key: str, timeout: float = TIMEOUT) -> list[dict]:
    """返回 `[{id, vendor, wire}]`：`id` 是网关原始名，`wire` 是可直接调用名。"""
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
    entries: list[dict] = []
    for item in data.get("data") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("id") or "").strip()
        if not name or name.endswith(":batch"):
            continue
        vendor = str(item.get("owned_by") or "").strip()
        wire = qualify(name, vendor)
        if not wire or wire in seen:
            continue
        seen.add(wire)
        entries.append({"id": name, "vendor": vendor, "wire": wire})
    return entries


def fetch_models(base_url: str, api_key: str, timeout: float = TIMEOUT) -> list[str]:
    """只取可直接调用的模型名（带供应商前缀），供选择与保存。"""
    return [entry["wire"] for entry in fetch_entries(base_url, api_key, timeout)]
