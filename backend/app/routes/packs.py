"""首页卡包接口：创建、改名、加/移成员、删除。"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import packs

router = APIRouter()


class PackMemberReq(BaseModel):
    type: str = ""
    id: str = ""


class PackCreateReq(BaseModel):
    id: str = ""
    title: str = ""
    members: list[PackMemberReq] = []


class PackRenameReq(BaseModel):
    title: str = ""


class PackMembersReq(BaseModel):
    members: list[PackMemberReq] = []


def _members(rows):
    return [{"type": row.type, "id": row.id} for row in rows]


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except packs.PackError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.post("/api/packs")
def create_pack(req: PackCreateReq):
    pack = _call(packs.create_pack, req.id, req.title, _members(req.members))
    return {"ok": True, "pack": pack}


@router.get("/api/packs/{pack_id}")
def get_pack(pack_id: str):
    return {"ok": True, "pack": _call(packs.get_pack, pack_id)}


@router.patch("/api/packs/{pack_id}")
def rename_pack(pack_id: str, req: PackRenameReq):
    return {"ok": True, "pack": _call(packs.rename_pack, pack_id, req.title)}


@router.post("/api/packs/{pack_id}/members")
def add_members(pack_id: str, req: PackMembersReq):
    return {"ok": True, "pack": _call(packs.add_members, pack_id, _members(req.members))}


@router.patch("/api/packs/{pack_id}/members")
def reorder_members(pack_id: str, req: PackMembersReq):
    return {"ok": True, "pack": _call(packs.reorder_members, pack_id, _members(req.members))}


@router.delete("/api/packs/{pack_id}/members")
def remove_members(pack_id: str, req: PackMembersReq):
    return {"ok": True, "pack": _call(packs.remove_members, pack_id, _members(req.members))}


@router.delete("/api/packs/{pack_id}")
def delete_pack(pack_id: str):
    return {"ok": True, **_call(packs.delete_pack, pack_id)}
