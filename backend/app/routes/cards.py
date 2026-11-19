"""@ 会摘卡片：列出卡片清单、触发卡片文件同步、登记链接卡片（飞书文档/公众号/网页）。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import cards

router = APIRouter()


class DocCardReq(BaseModel):
    url: str = ""
    title: str = ""
    content: str = ""
    document_id: str = ""
    revision: str | int | float | None = ""
    meta: dict | None = None


@router.get("/api/cards")
def list_cards(q: str = "", limit: int = 20, id: str = ""):
    """给 DSH 的 @ 菜单列卡片；q 同时匹配标题和摘要关键词。"""
    return cards.list_cards(q[:200], max(1, min(int(limit or 20), 50)), card_id=id[:120])


@router.post("/api/cards/sync")
def sync_cards(force: bool = False):
    """把记录重新物化成工作区里的 Markdown 卡片；Host 定时/建工作区时调用。"""
    return cards.sync_cards(force=force)


@router.post("/api/cards/doc")
def upsert_doc_card(req: DocCardReq):
    """登记/刷新一张链接卡片。

    飞书文档的正文由 Host 通过飞书 MCP 读取后传入；公众号文章与普通网页的正文
    由 Host 抓取，meta 里带站点、作者、发布时间和摘要。
    """
    try:
        return {"ok": True, **cards.upsert_doc_card(
            req.url,
            title=req.title,
            content=req.content,
            document_id=req.document_id,
            revision=str(req.revision or ""),
            meta=req.meta,
        )}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
