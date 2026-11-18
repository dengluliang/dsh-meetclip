"""会摘备份与迁移：选择清单、导出、检查与导入。

导出/导入都是后台任务：POST 只负责启动并返回任务快照，前端轮询
GET /api/backup/job 看进度；同一时刻只允许一个任务。
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import backup

router = APIRouter()


class BackupItem(BaseModel):
    type: str = ""
    id: str = ""


class ExportReq(BaseModel):
    dest: str = ""
    include_media: bool = False
    items: list[BackupItem] = []


class PathReq(BaseModel):
    path: str = ""


class ImportReq(BaseModel):
    path: str = ""
    include_media: bool | None = None
    skip_existing: bool | None = None


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except backup.BackupError as exc:
        raise HTTPException(exc.status, exc.message) from exc


@router.get("/api/backup/catalog")
def backup_catalog():
    """按类型列出可备份的卡片，供设置 → 备份的勾选清单使用。"""
    return {"ok": True, **_call(backup.catalog)}


@router.post("/api/backup/export")
def backup_export(req: ExportReq):
    """把选中的卡片打包成一个 zip；返回后台任务快照。"""
    payload = {
        "dest": req.dest,
        "include_media": req.include_media,
        "items": [{"type": item.type, "id": item.id} for item in req.items],
    }
    return {"ok": True, "job": _call(backup.start_export, payload)}


@router.post("/api/backup/inspect")
def backup_inspect(req: PathReq):
    """只读备份清单：数量、体积、来源与已导入情况，不写任何文件。"""
    return {"ok": True, **_call(backup.inspect_archive, req.path)}


@router.post("/api/backup/import")
def backup_import(req: ImportReq):
    """把备份导入当前资料空间；返回后台任务快照。"""
    payload = {
        "path": req.path,
        "include_media": req.include_media,
        "skip_existing": req.skip_existing,
    }
    return {"ok": True, "job": _call(backup.start_import, payload)}


@router.get("/api/backup/job")
def backup_job():
    """当前或最近一次导出/导入任务（完成后保留 10 分钟）。"""
    return {"ok": True, "job": backup.job_snapshot()}


@router.post("/api/backup/cancel")
def backup_cancel():
    """取消正在跑的导出/导入；已经提交的导入不会回滚。"""
    return {"ok": True, "job": backup.cancel_job()}
