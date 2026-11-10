"""SQLite 数据层：记录、转写段、截图、标记、链接视频队列。"""
import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

# 打包版由 App 通过 ZHIBO_DATA_DIR 指定（~/Library/Application Support/MeetClip）；开发时用项目下 data/
DATA_DIR = Path(os.environ.get("ZHIBO_DATA_DIR") or (Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "zhibo.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_url TEXT,
    platform TEXT DEFAULT 'bilibili',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending/queued/recording/processing/done/error/cancelled
    source_type TEXT DEFAULT 'live',         -- live/import
    created_at REAL NOT NULL,
    started_at REAL,
    ended_at REAL,
    duration REAL DEFAULT 0,
    media_path TEXT,          -- 视频文件相对路径
    audio_path TEXT,          -- 抽出的音频
    error TEXT,
    meta TEXT DEFAULT '{}'    -- 额外 JSON 元信息
);
CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    text TEXT NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_tr_session ON transcripts(session_id, start);
CREATE TABLE IF NOT EXISTS screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts REAL NOT NULL,           -- 相对时间（秒）
    path TEXT NOT NULL,         -- 相对 session 目录
    ocr_text TEXT DEFAULT '',
    created_at REAL NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_ss_session ON screenshots(session_id, ts);
CREATE TABLE IF NOT EXISTS marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts REAL NOT NULL,
    note TEXT DEFAULT '',
    created_at REAL NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_mk_session ON marks(session_id, ts);
CREATE TABLE IF NOT EXISTS sticky_notes (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'note',
    checked TEXT NOT NULL DEFAULT '[]',
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS board_images (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS link_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    queue_order INTEGER NOT NULL,
    job_state TEXT NOT NULL DEFAULT 'queued',
    phase TEXT NOT NULL DEFAULT 'queued',
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER,
    available_duration REAL NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    partial_cache_path TEXT,
    started_at REAL,
    updated_at REAL NOT NULL,
    finished_at REAL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_link_jobs_queue ON link_jobs(job_state, queue_order);
CREATE TABLE IF NOT EXISTS asr_chunks (
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    start_sample INTEGER NOT NULL,
    end_sample INTEGER NOT NULL,
    audio_path TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    text TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    metrics TEXT NOT NULL DEFAULT '{}',
    output_data TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(session_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_asr_run ON asr_chunks(session_id, run_id, start_sample);
CREATE TABLE IF NOT EXISTS task_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    task_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued',
    created_at REAL NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS session_minutes (
    session_id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',   -- 整份纪要 JSON（title/summary/topics/conclusions/todos/terms）
    covered REAL NOT NULL DEFAULT 0,   -- 已覆盖到第几秒的转写（不用行 id：终稿会整表重插）
    kind TEXT NOT NULL DEFAULT 'live', -- live / final
    lang TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'idle',-- idle/updating/failed/no_key/invalid_key/rate_limited
    error TEXT NOT NULL DEFAULT '',
    updated_at REAL,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS session_minutes_interactions (
    session_id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',   -- 用户在纪要上的互动：勾选完成的待办 + 文字高亮（含原文片段与上下文）
    updated_at REAL NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS card_exports (
    session_id TEXT PRIMARY KEY,       -- 故意不加外键：记录删除后要留到 cards.sync 才能删旧卡片文件
    file TEXT NOT NULL,                -- 会摘卡片/ 下的文件名（相对）
    signature TEXT NOT NULL,           -- 生成卡片时的内容指纹；不变就不重写
    title TEXT NOT NULL,
    search TEXT NOT NULL DEFAULT '',   -- 标题/摘要/待办/笔记摘要，供 @ 菜单过滤
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_cards (
    key TEXT PRIMARY KEY,              -- sha1(doc_type:token)[:12]
    url TEXT NOT NULL,
    doc_type TEXT NOT NULL,            -- docx / wiki / sheet / base / docs
    token TEXT NOT NULL,               -- URL 里的文档 token
    document_id TEXT NOT NULL DEFAULT '', -- wiki 解析出的 obj_token；docx 等于 token
    title TEXT NOT NULL,
    file TEXT NOT NULL,                -- 会摘卡片/ 下的文件名（相对）
    signature TEXT NOT NULL,
    search TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',  -- 登记时读取的正文快照（有上限）
    revision TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
"""


SESSION_STATUSES = ("pending", "queued", "recording", "processing", "done", "error", "cancelled")


class DB:
    def __init__(self, path: Path = DB_PATH):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._conn.execute("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self._lock = threading.RLock()
        self._transaction_depth = 0
        self._migrate()

    def _migrate(self):
        columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(asr_chunks)")}
        if "output_data" not in columns:
            self._conn.execute("ALTER TABLE asr_chunks ADD COLUMN output_data TEXT NOT NULL DEFAULT '{}'")
        # 旧版本数据库没有 link_jobs；先建表再执行列迁移，保证首次升级幂等。
        self._conn.executescript(
            """CREATE TABLE IF NOT EXISTS link_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL UNIQUE,
                queue_order INTEGER NOT NULL,
                job_state TEXT NOT NULL DEFAULT 'queued',
                phase TEXT NOT NULL DEFAULT 'queued',
                downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER,
                available_duration REAL NOT NULL DEFAULT 0,
                retry_count INTEGER NOT NULL DEFAULT 0,
                error_code TEXT,
                error_message TEXT,
                partial_cache_path TEXT,
                started_at REAL,
                updated_at REAL NOT NULL DEFAULT 0,
                finished_at REAL,
                FOREIGN KEY(session_id) REFERENCES sessions(id)
            );"""
        )
        self._conn.commit()
        for sql in (
            "ALTER TABLE sessions ADD COLUMN kind TEXT DEFAULT 'live'",
            "ALTER TABLE sessions ADD COLUMN notes TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE transcripts ADD COLUMN speaker TEXT",
            "ALTER TABLE sessions ADD COLUMN normalized_url TEXT",
            "ALTER TABLE sessions ADD COLUMN download_mode TEXT",
            "ALTER TABLE link_jobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE link_jobs ADD COLUMN transcribed_until REAL NOT NULL DEFAULT 0",
            "ALTER TABLE link_jobs ADD COLUMN speed REAL NOT NULL DEFAULT 0",
            "ALTER TABLE link_jobs ADD COLUMN eta REAL",
            "ALTER TABLE link_jobs ADD COLUMN preview_path TEXT",
            "ALTER TABLE link_jobs ADD COLUMN request_id TEXT",
            "ALTER TABLE link_jobs ADD COLUMN phase_text TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE link_jobs ADD COLUMN fallback_token TEXT",
            "ALTER TABLE link_jobs ADD COLUMN download_progress REAL",
        ):
            try:
                self._conn.execute(sql)
                self._conn.commit()
            except sqlite3.OperationalError:
                pass
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_link_url ON sessions(normalized_url)")
        self._conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_link_request ON link_jobs(request_id)")
        # v4 增加统一 task_queue 与 queued 状态，保留旧记录。
        self._conn.execute("UPDATE sessions SET status='recording' WHERE status='live'")
        self._conn.execute("UPDATE sessions SET status='cancelled' WHERE status='error' AND error IN ('已取消','内录已取消')")
        self._conn.execute("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('schema_version','4')")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS calendar_accounts (
                id TEXT PRIMARY KEY, url TEXT NOT NULL, username TEXT NOT NULL,
                connected INTEGER NOT NULL DEFAULT 1, last_sync REAL, error TEXT DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS calendars (
                id TEXT PRIMARY KEY, account_id TEXT NOT NULL, url TEXT NOT NULL,
                title TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 1,
                sync_token TEXT, last_sync REAL, error TEXT DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS calendar_resources (
                calendar_id TEXT NOT NULL, href TEXT NOT NULL, etag TEXT, ical TEXT NOT NULL,
                removed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(calendar_id,href)
            );
            CREATE TABLE IF NOT EXISTS calendar_events (
                id TEXT PRIMARY KEY, calendar_id TEXT, resource_href TEXT, uid TEXT,
                recurrence_id TEXT, source TEXT NOT NULL, title TEXT NOT NULL,
                start REAL NOT NULL, end REAL NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
                start_date TEXT NOT NULL, end_date TEXT NOT NULL, timezone TEXT,
                location TEXT DEFAULT '', description TEXT DEFAULT '',
                cancelled INTEGER NOT NULL DEFAULT 0, remote_deleted INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
                notes_version INTEGER NOT NULL DEFAULT 0, notes_updated REAL
            );
            CREATE INDEX IF NOT EXISTS idx_calendar_event_time ON calendar_events(start,end);
            CREATE TABLE IF NOT EXISTS calendar_links (
                event_id TEXT NOT NULL, session_id TEXT NOT NULL,
                PRIMARY KEY(event_id,session_id)
            );
            CREATE TABLE IF NOT EXISTS calendar_quotes (
                id TEXT PRIMARY KEY, event_id TEXT NOT NULL, session_id TEXT NOT NULL,
                title TEXT NOT NULL, start REAL NOT NULL, text TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS calendar_search_text (
                id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, href TEXT NOT NULL,
                uid TEXT NOT NULL, recurrence_id TEXT NOT NULL,
                title TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL,
                start REAL NOT NULL, component TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_calendar_search_resource ON calendar_search_text(calendar_id,href);
        """)
        session_columns = {r['name'] for r in self._conn.execute('PRAGMA table_info(sessions)')}
        if 'calendar_date' not in session_columns:
            self._conn.execute('ALTER TABLE sessions ADD COLUMN calendar_date TEXT')
        if 'notes_version' not in session_columns:
            self._conn.execute('ALTER TABLE sessions ADD COLUMN notes_version INTEGER NOT NULL DEFAULT 0')
        event_columns = {r['name'] for r in self._conn.execute('PRAGMA table_info(calendar_events)')}
        if 'response_status' not in event_columns:
            self._conn.execute('ALTER TABLE calendar_events ADD COLUMN response_status TEXT')
        if 'is_recurring' not in event_columns:
            self._conn.execute('ALTER TABLE calendar_events ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 0')
        search_columns = {r['name'] for r in self._conn.execute('PRAGMA table_info(calendar_search_text)')}
        for column, kind in (('event_id', 'TEXT'), ('event_start', 'REAL'), ('event_cancelled', 'INTEGER')):
            if column not in search_columns:
                self._conn.execute(f'ALTER TABLE calendar_search_text ADD COLUMN {column} {kind}')
        self._conn.execute('CREATE INDEX IF NOT EXISTS idx_calendar_event_resource ON calendar_events(calendar_id,resource_href)')
        self._conn.execute('CREATE INDEX IF NOT EXISTS idx_calendar_quote_event ON calendar_quotes(event_id)')
        self._conn.execute('CREATE INDEX IF NOT EXISTS idx_calendar_link_session ON calendar_links(session_id,event_id)')
        account_columns = {r['name'] for r in self._conn.execute('PRAGMA table_info(calendar_accounts)')}
        if 'user_addresses' not in account_columns:
            self._conn.execute("ALTER TABLE calendar_accounts ADD COLUMN user_addresses TEXT NOT NULL DEFAULT '[]'")
        self._conn.commit()

    @contextmanager
    def transaction(self):
        with self._lock:
            outer = self._transaction_depth == 0
            if outer:
                self._conn.execute("BEGIN IMMEDIATE")
            self._transaction_depth += 1
            try:
                yield
                if outer:
                    self._conn.commit()
            except BaseException:
                if outer:
                    self._conn.rollback()
                raise
            finally:
                self._transaction_depth -= 1

    def execute(self, sql, params=()):
        with self._lock:
            cur = self._conn.execute(sql, params)
            if not self._transaction_depth:
                self._conn.commit()
            return cur

    def query(self, sql, params=()):
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def one(self, sql, params=()):
        rows = self.query(sql, params)
        return rows[0] if rows else None

    # ---- sessions ----
    def create_session(self, sid, title, source_url, source_type="live", platform="bilibili", kind="live"):
        self.execute(
            "INSERT INTO sessions(id,title,source_url,platform,status,source_type,created_at,kind) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (sid, title, source_url, platform, "pending", source_type, time.time(), kind),
        )

    def update_session(self, sid, **fields):
        if not fields:
            return
        if "status" in fields and fields["status"] not in SESSION_STATUSES:
            raise ValueError(f"未知的记录状态：{fields['status']}")
        keys = ", ".join(f"{k}=?" for k in fields)
        vals = list(fields.values()) + [sid]
        if "meta" in fields and isinstance(fields["meta"], (dict, list)):
            vals[list(fields).index("meta")] = json.dumps(fields["meta"], ensure_ascii=False)
        self.execute(f"UPDATE sessions SET {keys} WHERE id=?", vals)

    def save_record_notes(self, sid, notes, version=None):
        """Compare and swap a note; legacy callers can omit the expected version."""
        from fastapi import HTTPException
        with self.transaction():
            row = self.get_session(sid)
            if not row:
                raise HTTPException(404, '转录记录不存在')
            if version is not None and row['notes_version'] != version:
                raise HTTPException(409, '笔记已在其他位置更新，当前草稿保留，请读取最新版本后合并')
            self.execute('UPDATE sessions SET notes=?,notes_version=notes_version+1 WHERE id=?', (notes, sid))
            return row['notes_version']+1

    @staticmethod
    def _decode_meta(raw):
        try:
            meta = json.loads(raw) if raw else {}
        except Exception:
            meta = {}
        return meta if isinstance(meta, dict) else {}

    def get_session(self, sid):
        row = self.one("SELECT * FROM sessions WHERE id=?", (sid,))
        if row:
            row["meta"] = self._decode_meta(row.get("meta"))
        return row

    def update_meta(self, sid, **changes):
        """在同一把锁内读取、合并、写回 meta，避免并发的读改写互相覆盖。值为 None 的键会被删除。"""
        with self.transaction():
            row = self._conn.execute("SELECT meta FROM sessions WHERE id=?", (sid,)).fetchone()
            if row is None:
                return None
            meta = self._decode_meta(row["meta"])
            for key, value in changes.items():
                if value is None:
                    meta.pop(key, None)
                else:
                    meta[key] = value
            self._conn.execute("UPDATE sessions SET meta=? WHERE id=?",
                               (json.dumps(meta, ensure_ascii=False), sid))
            return meta

    def list_sessions(self):
        rows = self.query(
            "SELECT s.*, (SELECT COUNT(*) FROM transcripts WHERE session_id=s.id) AS transcripts, "
            "(SELECT COUNT(*) FROM marks WHERE session_id=s.id) AS marks, "
            "(SELECT COUNT(*) FROM screenshots WHERE session_id=s.id) AS screenshots "
            "FROM sessions s ORDER BY created_at DESC")
        jobs = {j["session_id"]: j for j in self.query("SELECT * FROM link_jobs")}
        for r in rows:
            r["meta"] = self._decode_meta(r.get("meta"))
            r["link_job"] = jobs.get(r["id"]) if r.get("kind") == "link_video" else None
        return rows

    def home_stats(self):
        """首页统计：总数、本周新增、总时长、录制中、未整理、标记数。"""
        now = time.localtime()
        week_start = time.mktime((now.tm_year, now.tm_mon, now.tm_mday - (now.tm_wday), 0, 0, 0, 0, 0, -1))
        row = self.one(
            "SELECT COUNT(*) AS total, COALESCE(SUM(duration), 0) AS duration, "
            "COALESCE(SUM(CASE WHEN COALESCE(started_at, created_at) >= ? THEN 1 ELSE 0 END), 0) AS week, "
            "COALESCE(SUM(CASE WHEN status = 'recording' THEN 1 ELSE 0 END), 0) AS recording, "
            "COALESCE(SUM(CASE WHEN status IN ('recording', 'processing', 'queued') THEN 1 ELSE 0 END), 0) AS active, "
            "COALESCE(SUM(CASE WHEN kind = 'live' THEN 1 ELSE 0 END), 0) AS live, "
            "COALESCE(SUM(CASE WHEN kind = 'link_video' THEN 1 ELSE 0 END), 0) AS link_video, "
            "COALESCE(SUM(CASE WHEN kind = 'meeting' THEN 1 ELSE 0 END), 0) AS meeting "
            "FROM sessions", (week_start,)) or {}
        marks = self.one("SELECT COUNT(*) AS n FROM marks") or {}
        unreviewed = self.one(
            "SELECT COUNT(*) AS n FROM sessions s WHERE s.status = 'done' "
            "AND (s.notes IS NULL OR trim(s.notes) = '') "
            "AND NOT EXISTS (SELECT 1 FROM marks m WHERE m.session_id = s.id)") or {}
        return {
            "total": int(row.get("total") or 0),
            "week": int(row.get("week") or 0),
            "duration": float(row.get("duration") or 0),
            "recording": int(row.get("recording") or 0),
            "active": int(row.get("active") or 0),
            "live": int(row.get("live") or 0),
            "link_video": int(row.get("link_video") or 0),
            "meeting": int(row.get("meeting") or 0),
            "unreviewed": int(unreviewed.get("n") or 0),
            "marks": int(marks.get("n") or 0),
        }

    def list_home_sessions(self, limit=60, offset=0):
        """首页卡片：只取展示需要的字段，封面优先链接缩略图、否则首张截图。"""
        rows = self.query(
            "SELECT s.id, s.title, s.kind, s.status, s.source_url, s.platform, s.source_type, "
            "s.created_at, s.started_at, s.duration, s.notes, s.notes_version, s.meta, s.media_path, "
            "(SELECT COUNT(*) FROM transcripts t WHERE t.session_id = s.id) AS transcripts, "
            "(SELECT COUNT(*) FROM marks m WHERE m.session_id = s.id) AS marks, "
            "(SELECT COUNT(*) FROM screenshots ss WHERE ss.session_id = s.id) AS screenshots, "
            "(SELECT t.text FROM transcripts t WHERE t.session_id = s.id ORDER BY t.start LIMIT 1) AS snippet, "
            "(SELECT ss.path FROM screenshots ss WHERE ss.session_id = s.id ORDER BY ss.ts LIMIT 1) AS cover_path "
            "FROM sessions s "
            "ORDER BY CASE WHEN s.status = 'recording' THEN 0 ELSE 1 END, "
            "COALESCE(s.started_at, s.created_at) DESC LIMIT ? OFFSET ?",
            (limit, offset),
        )
        for row in rows:
            row["meta"] = self._decode_meta(row.get("meta"))
        return rows

    def _link_batch_groups(self):
        """批次卡：把带 meta.batch 的链接记录按批次聚合，成员按提交顺序排列。

        `last_index` 供追加链接时续接序号；`updated_at` 让刚追加过的批次排到最前。
        """
        rows = self.query(
            "SELECT id, title, status, platform, source_url, duration, error, created_at, meta "
            "FROM sessions WHERE kind='link_video' AND meta LIKE '%\"batch\"%' "
            "ORDER BY created_at ASC"
        )
        groups = {}
        for row in rows:
            meta = self._decode_meta(row.get("meta"))
            batch = meta.get("batch") if isinstance(meta.get("batch"), dict) else None
            if not batch or not batch.get("id"):
                continue
            bid = str(batch["id"])
            created_at = float(batch.get("created_at") or row.get("created_at") or 0)
            group = groups.setdefault(bid, {
                "id": bid,
                "title": batch.get("title") or "批量视频",
                "created_at": created_at,
                "updated_at": created_at,
                "last_index": 0,
                "members": [],
            })
            group["last_index"] = max(group["last_index"], int(batch.get("index") or 0))
            group["updated_at"] = max(group["updated_at"], float(batch.get("updated_at") or created_at))
            group["members"].append({
                "id": row.get("id"),
                "title": row.get("title") or "",
                "status": row.get("status") or "pending",
                "platform": row.get("platform") or "",
                "source_url": row.get("source_url") or "",
                "duration": float(row.get("duration") or 0),
                "error": (row.get("error") or "")[:300],
                "_index": int(batch.get("index") or 0),
            })
        batches = []
        for group in groups.values():
            members = sorted(group["members"], key=lambda item: item.get("_index") or 0)
            for member in members:
                member.pop("_index", None)
            counts = {"queued": 0, "processing": 0, "done": 0, "error": 0, "cancelled": 0}
            for member in members:
                status = member["status"]
                if status in ("pending", "queued"):
                    counts["queued"] += 1
                elif status in counts:
                    counts[status] += 1
            group["members"] = members
            group["total"] = len(members)
            group["counts"] = counts
            group["active"] = counts["queued"] + counts["processing"]
            batches.append(group)
        batches.sort(key=lambda item: item.get("updated_at") or item.get("created_at") or 0, reverse=True)
        return batches

    def list_link_batches(self, limit=50):
        batches = self._link_batch_groups()
        for batch in batches:
            batch.pop("last_index", None)
        return batches[:max(0, int(limit))]

    def get_link_batch(self, batch_id):
        """按批次 id 取聚合结果（含内部字段 last_index），不存在时返回 None。"""
        wanted = str(batch_id or "").strip()
        if not wanted:
            return None
        for batch in self._link_batch_groups():
            if batch.get("id") == wanted:
                return batch
        return None

    def list_home_highlights(self, limit=12):
        """首页金句：带批注的标记，按写入时间倒序。"""
        return self.query(
            "SELECT m.id, m.session_id, m.ts, m.note, m.created_at, s.title AS session_title, s.kind "
            "FROM marks m JOIN sessions s ON s.id = m.session_id "
            "WHERE trim(COALESCE(m.note, '')) <> '' "
            "ORDER BY m.created_at DESC LIMIT ?",
            (limit,),
        )

    def list_sticky_notes(self):
        rows = self.query("SELECT * FROM sticky_notes ORDER BY created_at ASC")
        for row in rows:
            try:
                row["checked"] = json.loads(row.get("checked") or "[]")
            except Exception:
                row["checked"] = []
        return rows

    def create_sticky_note(self, text, kind, checked, x, y):
        now = time.time()
        nid = uuid.uuid4().hex[:12]
        self.execute(
            "INSERT INTO sticky_notes(id,text,kind,checked,x,y,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (nid, text, kind, json.dumps(checked, ensure_ascii=False), float(x), float(y), now, now),
        )
        return self.one("SELECT * FROM sticky_notes WHERE id=?", (nid,))

    def update_sticky_note(self, nid, fields):
        allowed = {"text", "kind", "checked", "x", "y"}
        pairs = []
        params = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            if key == "checked":
                value = json.dumps(value, ensure_ascii=False)
            pairs.append(f"{key}=?")
            params.append(value)
        if not pairs:
            return self.one("SELECT * FROM sticky_notes WHERE id=?", (nid,))
        pairs.append("updated_at=?")
        params.extend([time.time(), nid])
        self.execute(f"UPDATE sticky_notes SET {', '.join(pairs)} WHERE id=?", tuple(params))
        return self.one("SELECT * FROM sticky_notes WHERE id=?", (nid,))

    def delete_sticky_note(self, nid):
        self.execute("DELETE FROM sticky_notes WHERE id=?", (nid,))

    def list_board_images(self):
        return self.query("SELECT * FROM board_images ORDER BY created_at ASC")

    def create_board_image(self, image_id, path, width, height, x, y):
        self.execute(
            "INSERT INTO board_images(id,path,width,height,x,y,created_at) VALUES(?,?,?,?,?,?,?)",
            (image_id, path, int(width or 0), int(height or 0), float(x), float(y), time.time()),
        )
        return self.one("SELECT * FROM board_images WHERE id=?", (image_id,))

    def delete_board_image(self, image_id):
        row = self.one("SELECT * FROM board_images WHERE id=?", (image_id,))
        self.execute("DELETE FROM board_images WHERE id=?", (image_id,))
        return row

    def delete_session(self, sid):
        with self.transaction():
            self.execute("DELETE FROM calendar_links WHERE session_id=?", (sid,))
            for t in ("transcripts", "screenshots", "marks", "link_jobs", "task_queue", "asr_chunks",
                      "session_minutes", "session_minutes_interactions"):
                self.execute(f"DELETE FROM {t} WHERE session_id=?", (sid,))
            # card_exports 故意留给 cards.sync_cards：它需要旧文件名才能删卡片；
            # 列表查询用 JOIN sessions，记录删掉后不会出现在 @ 菜单里。
            self.execute("DELETE FROM sessions WHERE id=?", (sid,))

    # ---- @ 卡片（由 cards.py 生成，派生数据） ----
    def list_card_exports(self):
        return self.query("SELECT * FROM card_exports")

    def upsert_card_export(self, sid, file, signature, title, search, updated_at=None):
        self.execute(
            "INSERT INTO card_exports(session_id,file,signature,title,search,updated_at) "
            "VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(session_id) DO UPDATE SET file=excluded.file, signature=excluded.signature, "
            "title=excluded.title, search=excluded.search, updated_at=excluded.updated_at",
            (sid, file, signature, title, search, updated_at if updated_at is not None else time.time()),
        )

    def delete_card_export(self, sid):
        self.execute("DELETE FROM card_exports WHERE session_id=?", (sid,))

    # ---- 飞书文档卡片（用户/Agent 登记，卡片文件同样在会摘卡片/） ----
    def list_doc_cards(self):
        return self.query("SELECT * FROM doc_cards ORDER BY updated_at DESC, key ASC")

    def get_doc_card(self, key):
        return self.one("SELECT * FROM doc_cards WHERE key=?", (key,))

    def upsert_doc_card(self, key, url, doc_type, token, document_id, title, file,
                        signature, search, content, revision, created_at, updated_at):
        self.execute(
            "INSERT INTO doc_cards(key,url,doc_type,token,document_id,title,file,signature,"
            "search,content,revision,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET url=excluded.url, doc_type=excluded.doc_type, "
            "token=excluded.token, document_id=excluded.document_id, title=excluded.title, "
            "file=excluded.file, signature=excluded.signature, search=excluded.search, "
            "content=excluded.content, revision=excluded.revision, updated_at=excluded.updated_at",
            (key, url, doc_type, token, document_id, title, file, signature,
             search, content, revision, created_at, updated_at),
        )

    def delete_doc_card(self, key):
        self.execute("DELETE FROM doc_cards WHERE key=?", (key,))

    # ---- link video queue ----
    def create_link_job(self, sid, queue_order, state="queued", phase="queued"):
        now = time.time()
        self.execute(
            "INSERT INTO link_jobs(session_id,queue_order,job_state,phase,updated_at) VALUES(?,?,?,?,?)",
            (sid, queue_order, state, phase, now),
        )

    def get_link_job(self, sid):
        return self.one("SELECT * FROM link_jobs WHERE session_id=?", (sid,))

    def list_link_jobs(self, states=None):
        if states:
            marks = ",".join("?" for _ in states)
            return self.query(
                f"SELECT j.*, s.title, s.source_url, s.platform, s.status, s.kind, s.media_path "
                f"FROM link_jobs j JOIN sessions s ON s.id=j.session_id "
                f"WHERE j.job_state IN ({marks}) ORDER BY j.queue_order, j.id",
                tuple(states),
            )
        return self.query(
            "SELECT j.*, s.title, s.source_url, s.platform, s.status, s.kind, s.media_path "
            "FROM link_jobs j JOIN sessions s ON s.id=j.session_id ORDER BY j.queue_order, j.id"
        )

    def claim_next_link_job(self):
        """Atomically claim the next queued job so a restart cannot double-start it."""
        with self.transaction():
            row = self.one("SELECT session_id FROM link_jobs WHERE job_state IN ('queued','waiting_for_slot') "
                           "ORDER BY queue_order,id LIMIT 1")
            if not row:
                return None
            self.update_link_job(row["session_id"], job_state="preparing", phase="preparing")
            return row["session_id"]

    def next_link_queue_order(self):
        row = self.one("SELECT COALESCE(MAX(queue_order), 0) AS n FROM link_jobs")
        return int(row["n"] or 0) + 1

    def update_link_job(self, sid, **fields):
        if not fields:
            return
        fields["updated_at"] = time.time()
        keys = ", ".join(f"{k}=?" for k in fields)
        self.execute(f"UPDATE link_jobs SET {keys} WHERE session_id=?",
                     list(fields.values()) + [sid])

    def count_active_link_jobs(self):
        row = self.one(
            "SELECT COUNT(*) AS n FROM link_jobs WHERE job_state IN "
            "('queued','waiting_for_slot','preparing','downloading','transcribing','finalizing','paused','fallback_recording')"
        )
        return int(row["n"] or 0)

    # ---- transcripts ----
    def add_transcript(self, sid, start, end, text, speaker=None):
        self.execute(
            "INSERT INTO transcripts(session_id,start,end,text,created_at,speaker) VALUES(?,?,?,?,?,?)",
            (sid, start, end, text, time.time(), speaker),
        )

    def add_transcripts(self, sid, rows):
        """批量写入 [(start, end, text, speaker)]"""
        now = time.time()
        with self._lock:
            self._conn.executemany(
                "INSERT INTO transcripts(session_id,start,end,text,created_at,speaker) VALUES(?,?,?,?,?,?)",
                [(sid, a, b, t, now, sp) for a, b, t, sp in rows],
            )
            if not self._transaction_depth:
                self._conn.commit()

    def replace_transcripts(self, sid, rows):
        """在一个事务里用新转写整体替换旧转写；失败时旧内容保持不变。"""
        with self.transaction():
            self._conn.execute("DELETE FROM transcripts WHERE session_id=?", (sid,))
            self.add_transcripts(sid, rows)

    def get_transcripts(self, sid, after_id=None, limit=None):
        if after_id is not None:
            return self.query("SELECT * FROM transcripts WHERE session_id=? AND id>? ORDER BY id LIMIT ?",
                              (sid, after_id, min(limit or 200, 1000)))
        return self.query(
            "SELECT * FROM transcripts WHERE session_id=? ORDER BY start", (sid,)
        )

    # ---- minutes（AI 纪要） ----
    def get_minutes(self, sid):
        row = self.one("SELECT * FROM session_minutes WHERE session_id=?", (sid,))
        if not row:
            return None
        try:
            row["data"] = json.loads(row.get("data") or "{}")
        except Exception:
            row["data"] = {}
        return row

    def save_minutes(self, sid, data, covered, kind, lang, state="idle", error=""):
        """整份替换一版纪要。不为空的纪要永远不写状态错误以外的空内容。"""
        now = time.time()
        payload = json.dumps(data or {}, ensure_ascii=False)
        self.execute(
            "INSERT INTO session_minutes(session_id,data,covered,kind,lang,state,error,updated_at,version) "
            "VALUES(?,?,?,?,?,?,?,?,1) "
            "ON CONFLICT(session_id) DO UPDATE SET data=excluded.data, covered=excluded.covered, "
            "kind=excluded.kind, lang=excluded.lang, state=excluded.state, error=excluded.error, "
            "updated_at=excluded.updated_at, version=session_minutes.version+1",
            (sid, payload, float(covered), kind, lang, state, error, now),
        )
        return self.get_minutes(sid)

    def set_minutes_state(self, sid, state, error=""):
        """只改状态（更新中/失败/缺 key），不动上一份好纪要。"""
        row = self.get_minutes(sid)
        if row is None:
            self.execute(
                "INSERT INTO session_minutes(session_id,data,covered,kind,lang,state,error,updated_at,version) "
                "VALUES(?, '{}', 0, 'live', '', ?, ?, ?, 1)",
                (sid, state, error, time.time()),
            )
        else:
            self.execute("UPDATE session_minutes SET state=?, error=?, updated_at=? WHERE session_id=?",
                         (state, error, time.time(), sid))
        return self.get_minutes(sid)

    def delete_minutes(self, sid):
        self.execute("DELETE FROM session_minutes WHERE session_id=?", (sid,))

    # ---- minutes 互动（勾选待办 / 高亮原文） ----
    def get_minutes_interactions(self, sid):
        """取用户对纪要的互动记录；没有时返回 None（不建空行）。"""
        row = self.one("SELECT * FROM session_minutes_interactions WHERE session_id=?", (sid,))
        if not row:
            return None
        try:
            row["data"] = json.loads(row.get("data") or "{}")
        except Exception:
            row["data"] = {}
        if not isinstance(row["data"], dict):
            row["data"] = {}
        return row

    def save_minutes_interactions(self, sid, data, updated_at=None):
        """整份替换互动记录。和笔记一样只有一份，用版本号给派生数据做指纹。"""
        now = time.time() if updated_at is None else float(updated_at)
        payload = json.dumps(data or {}, ensure_ascii=False)
        self.execute(
            "INSERT INTO session_minutes_interactions(session_id,data,updated_at,version) "
            "VALUES(?,?,?,1) "
            "ON CONFLICT(session_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, "
            "version=session_minutes_interactions.version+1",
            (sid, payload, now),
        )
        return self.get_minutes_interactions(sid)

    def delete_minutes_interactions(self, sid):
        self.execute("DELETE FROM session_minutes_interactions WHERE session_id=?", (sid,))

    # ---- screenshots ----
    def add_screenshot(self, sid, ts, path):
        cur = self.execute(
            "INSERT INTO screenshots(session_id,ts,path,created_at) VALUES(?,?,?,?)",
            (sid, ts, path, time.time()),
        )
        return cur.lastrowid

    def get_screenshots(self, sid):
        return self.query(
            "SELECT * FROM screenshots WHERE session_id=? ORDER BY ts", (sid,)
        )

    # ---- marks ----
    def add_mark(self, sid, ts, note=""):
        cur = self.execute(
            "INSERT INTO marks(session_id,ts,note,created_at) VALUES(?,?,?,?)",
            (sid, ts, note, time.time()),
        )
        return cur.lastrowid

    def update_mark(self, mark_id, note):
        self.execute("UPDATE marks SET note=? WHERE id=?", (note, mark_id))

    def delete_mark(self, mark_id):
        self.execute("DELETE FROM marks WHERE id=?", (mark_id,))

    def get_marks(self, sid):
        return self.query("SELECT * FROM marks WHERE session_id=? ORDER BY ts", (sid,))

    # ---- search ----
    def search(self, sid, keyword):
        like = f"%{keyword}%"
        trs = self.query(
            "SELECT 'transcript' AS kind, id, start AS ts, text FROM transcripts "
            "WHERE session_id=? AND text LIKE ? ORDER BY start",
            (sid, like),
        )
        shots = self.query(
            "SELECT 'screenshot' AS kind, id, ts, ocr_text AS text FROM screenshots "
            "WHERE session_id=? AND ocr_text LIKE ? ORDER BY ts",
            (sid, like),
        )
        return sorted(trs + shots, key=lambda x: x["ts"])


db = DB()


def session_dir(sid: str) -> Path:
    d = DATA_DIR / sid
    d.mkdir(parents=True, exist_ok=True)
    if (db.get_session(sid) or {}).get("kind") != "link_video":
        (d / "shots").mkdir(exist_ok=True)
    return d
