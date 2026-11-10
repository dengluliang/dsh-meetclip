"""多资料空间共用的文件位置。

会摘可以有多份资料空间（工作 / 生活 …），每份都有自己的数据目录：记录、转写、
笔记、卡片、数据库都在各自目录里。但账号与通用设置只有一份——B 站/抖音 Cookie、
语音引擎、画质、截图灵敏度这些跟「哪份资料」无关，放进共享目录。

宿主启用多资料空间时会通过 MEETCLIP_SHARED_DIR 指定共享目录；没有设置时
`shared()` 直接回落到数据目录，行为与单库版本完全一致（macOS 版会摘、
外部引擎、旧安装都不会受影响）。
"""
from __future__ import annotations

import os
from pathlib import Path

from database import DATA_DIR

SHARED_DIR = Path(os.environ.get("MEETCLIP_SHARED_DIR") or DATA_DIR).expanduser()


def shared(name: str) -> Path:
    """共享目录里的一个文件；共享目录不存在时先建出来。"""
    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    return SHARED_DIR / name


def using_shared_dir() -> bool:
    return SHARED_DIR != DATA_DIR
