"""MeetClip 会摘 · FastAPI 主服务：应用装配、本地访问安全与生命周期。

路由按领域拆分在 routes/ 下；本文件只负责中间件与启动/退出钩子。
"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import auth
import capture
import cloud_transcription
import link_video
import minutes
import scheduler
import settings
from database import DATA_DIR
from export_md import export_markdown  # noqa: F401  测试与脚本沿用 main.export_markdown
from routes import (asr_engines, calendar, cards as card_routes, link_videos, meetings,
                    minutes as minutes_routes, models, search, sessions, speakers, system)

PORT = int(os.environ.get("MEETCLIP_PORT") or 8321)
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
PUBLIC_API = {"/api/health"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    cloud_transcription.recover_interrupted()
    capture.recover_interrupted()
    scheduler.recover()
    settings.remove("hf_token")
    link_video.start()
    scheduler.start()
    minutes.start()
    yield
    # App 退出：停止正在进行的采集，保存已写入的媒体（TS→MP4），未完成的转写下次可补
    minutes.shutdown()
    scheduler.shutdown()
    link_video.shutdown(timeout=8)
    capture.shutdown_all(timeout=8)


app = FastAPI(title="MeetClip 会摘", lifespan=lifespan)


def host_allowed(request: Request) -> bool:
    """只接受回环地址作为 Host，防止 DNS 重绑定访问本地 API。"""
    host = (request.headers.get("host") or "").strip().lower()
    name, _, port = host.rpartition(":") if host.count(":") == 1 else (host, "", "")
    if not name:
        name = host
    return name in ALLOWED_HOSTS and (not port or port.isdigit())


@app.middleware("http")
async def local_api_guard(request: Request, call_next):
    if not host_allowed(request):
        return JSONResponse({"detail": "仅允许通过 127.0.0.1 访问本地服务"}, status_code=403)
    if request.url.path.startswith("/api/") and request.url.path not in PUBLIC_API:
        if not auth.valid(auth.token_from_request(request)):
            return JSONResponse({"detail": "本地 API 凭证无效"}, status_code=401)
    return await call_next(request)


@app.get("/api/health")
def health():
    return {"ok": True, "protocol": 3, "app": "meetclip", "pid": os.getpid(),
            "data_dir": str(DATA_DIR)}


for module in (system, models, sessions, meetings, link_videos, asr_engines, calendar, search,
               minutes_routes, speakers, card_routes):
    app.include_router(module.router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, proxy_headers=False)
