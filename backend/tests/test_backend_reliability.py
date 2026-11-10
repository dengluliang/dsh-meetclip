"""运行：.venv/bin/python tests/test_backend_reliability.py（使用临时数据目录，不加载模型、不访问网络）。

覆盖：本地 API 鉴权与 Host 校验、meta 并发写、重新转写失败/取消保留旧转写、删除策略、
链接视频取消状态、会话列表计数。
"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid


class BackendReliabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-reliability-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.db = cls.database.db
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        cls.scheduler = importlib.import_module("scheduler")
        cls.sessions = importlib.import_module("routes.sessions")
        cls.link_video = importlib.import_module("link_video")
        cls.meeting = importlib.import_module("meeting")
        from fastapi.testclient import TestClient
        cls.TestClient = TestClient
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": cls.auth.API_TOKEN})

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.db._conn.close()
        cls.environment.stop()
        cls.data.cleanup()

    def new_session(self, kind="meeting", status="done"):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, f"测试 {sid}", "", source_type="audio", kind=kind)
        self.db.update_session(sid, status=status)
        self.database.session_dir(sid)
        return sid

    # ---------- 安全 ----------
    def test_api_requires_token(self):
        bare = self.TestClient(self.main.app, base_url="http://127.0.0.1:8321")
        self.assertEqual(bare.get("/api/sessions").status_code, 401)
        self.assertEqual(bare.get("/api/deps").status_code, 401)
        self.assertEqual(bare.get("/api/asr/status").status_code, 401)
        self.assertEqual(bare.get("/api/health").status_code, 200)

    def test_forwarded_for_does_not_bypass_auth(self):
        bare = self.TestClient(self.main.app, base_url="http://127.0.0.1:8321")
        for value in ("testclient", "testserver", "127.0.0.1"):
            response = bare.get("/api/sessions", headers={"X-Forwarded-For": value})
            self.assertEqual(response.status_code, 401, value)

    def test_foreign_host_is_rejected(self):
        for base in ("http://evil.example:8321", "http://127.0.0.1.evil.example", "http://192.168.1.2:8321"):
            client = self.TestClient(self.main.app, base_url=base)
            self.assertEqual(client.get("/api/health").status_code, 403, base)
            api = client.get("/api/sessions", headers={"X-MeetClip-Token": self.auth.API_TOKEN})
            self.assertEqual(api.status_code, 403, base)

    def test_web_frontend_and_web_only_api_are_removed(self):
        for path in ("/", "/static/app.js"):
            self.assertEqual(self.client.get(path).status_code, 404, path)
        for method, path in (("get", "/api/task-queue"), ("get", "/api/link-queue"),
                             ("post", "/api/link-queue/pause"), ("post", "/api/link-queue/resume"),
                             ("post", "/api/import"), ("post", "/api/import/path")):
            self.assertEqual(getattr(self.client, method)(path).status_code, 404, path)

    def test_cookie_token_is_not_accepted(self):
        bare = self.TestClient(self.main.app, base_url="http://127.0.0.1:8321",
                               cookies={"meetclip_token": self.auth.API_TOKEN})
        self.assertEqual(bare.get("/api/sessions").status_code, 401)

    def test_cookie_browser_is_whitelisted(self):
        bad = self.client.post("/api/settings", json={"link_cookie_browser": "chrome --exec rm"})
        self.assertEqual(bad.status_code, 400)
        ok = self.client.post("/api/settings", json={"link_cookie_browser": "Safari"})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["link_cookie_browser"], "safari")
        self.assertFalse(list(Path(self.data.name).glob("settings.json.tmp")))

    # ---------- 数据可靠性 ----------
    def test_concurrent_meta_updates_keep_all_fields(self):
        sid = self.new_session()
        keys = [f"k{i}" for i in range(40)]
        threads = [threading.Thread(target=self.db.update_meta, args=(sid,), kwargs={k: i})
                   for i, k in enumerate(keys)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        meta = self.db.get_session(sid)["meta"]
        self.assertEqual({k: meta[k] for k in keys}, {k: i for i, k in enumerate(keys)})
        self.db.update_meta(sid, k0=None)
        self.assertNotIn("k0", self.db.get_session(sid)["meta"])

    def _run_meeting(self, sid, behaviour):
        """以假的 ASR/ffmpeg 跑一次会议重新转写，behaviour 决定转写结果。"""
        media = self.database.session_dir(sid) / "media.wav"
        media.write_bytes(b"\0" * 4096)
        self.db.update_session(sid, media_path="media.wav")

        class Result:
            text = "新的转写"
            segments = []
            chunks = [{"text": "新的转写。", "start": 0.0, "end": 1.0}]
            truncated = False
            language = "Chinese"

        task_box = {}

        def fake_transcribe(*_args, **_kwargs):
            return behaviour(task_box["task"], Result)

        def fake_extract(_task, _media, wav):
            wav.write_bytes(b"\0" * 4096)

        import numpy as np
        with patch.object(self.meeting.asr.manager, "is_ready", return_value=True), \
                patch.object(self.meeting.asr.manager, "transcribe_long", side_effect=fake_transcribe), \
                patch.object(self.meeting.MeetingTask, "_extract_audio", fake_extract), \
                patch.object(self.meeting, "_load_wav", return_value=np.zeros(16000, dtype=np.float32)), \
                patch.dict(self.meeting.DEPS, {"ffmpeg": "/usr/bin/true"}):
            task = self.meeting.MeetingTask(sid, params={"language": "Chinese"})
            task_box["task"] = task
            self.scheduler.acquire(sid, lambda: task)
            self.assertTrue(task.finished.wait(10))
        return task

    def test_retranscribe_failure_keeps_old_transcripts(self):
        sid = self.new_session()
        self.db.add_transcripts(sid, [(0, 2, "原有转写一", "S1"), (2, 4, "原有转写二", "S2")])
        before = self.db.get_transcripts(sid)

        def fail(_task, _result):
            raise RuntimeError("模型崩溃")
        self._run_meeting(sid, fail)
        self.assertEqual(self.db.get_transcripts(sid), before)
        self.assertEqual(self.db.get_session(sid)["status"], "error")
        self.assertIsNone(self.scheduler.owner())

    def test_retranscribe_cancel_keeps_old_transcripts(self):
        sid = self.new_session()
        self.db.add_transcripts(sid, [(0, 2, "原有转写", "S1")])
        before = self.db.get_transcripts(sid)

        def cancel(task, result):
            task.cancel_flag.set()
            return result()
        self._run_meeting(sid, cancel)
        self.assertEqual(self.db.get_transcripts(sid), before)
        self.assertEqual(self.db.get_session(sid)["status"], "cancelled")

    def test_retranscribe_success_replaces_transcripts(self):
        sid = self.new_session()
        self.db.add_transcripts(sid, [(0, 2, "原有转写", "S1")])
        self._run_meeting(sid, lambda _task, result: result())
        texts = [t["text"] for t in self.db.get_transcripts(sid)]
        self.assertEqual(texts, ["新的转写。"])
        self.assertEqual(self.db.get_session(sid)["status"], "done")
        self.assertFalse((self.database.session_dir(sid) / "transcription_alignment.json").exists())

    def test_delete_running_session_is_rejected(self):
        sid = self.new_session(status="processing")
        self.assertTrue(self.scheduler.try_reserve(sid))
        try:
            response = self.client.delete(f"/api/sessions/{sid}")
            self.assertEqual(response.status_code, 409, response.text)
            self.assertIsNotNone(self.db.get_session(sid))
        finally:
            self.scheduler.release(sid)

    def test_trash_failure_keeps_directory_and_record(self):
        sid = self.new_session()
        marker = self.database.session_dir(sid) / "media.mp4"
        marker.write_bytes(b"media")
        with patch.object(self.sessions.shutil, "move", side_effect=OSError("只读磁盘")):
            response = self.client.delete(f"/api/sessions/{sid}")
        self.assertEqual(response.status_code, 500, response.text)
        self.assertTrue(marker.exists())
        self.assertIsNotNone(self.db.get_session(sid))

    def test_trash_falls_back_to_app_data_when_system_trash_denied(self):
        sid = self.new_session()
        marker = self.database.session_dir(sid) / "media.mp4"
        marker.write_bytes(b"media")
        home_trash = Path(self.data.name) / "Denied-home"
        real_move = self.sessions.shutil.move

        def move(src, dst):
            if str(dst).startswith(str(home_trash)):
                raise PermissionError("Operation not permitted")
            return real_move(src, dst)

        with patch.object(self.sessions.Path, "home", return_value=home_trash), \
                patch.object(self.sessions.shutil, "move", side_effect=move):
            response = self.client.delete(f"/api/sessions/{sid}")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(self.db.get_session(sid))
        app_trash = Path(self.data.name) / ".trash"
        self.assertTrue(any(app_trash.iterdir()))


    def test_batch_delete_cancels_active_link_job(self):
        trash = Path(self.data.name) / "Trash-active"
        sid = self.new_session(kind="link_video", status="processing")
        self.db.create_link_job(sid, self.db.next_link_queue_order())
        self.db.update_link_job(sid, job_state="downloading", phase="downloading")
        with patch.object(self.sessions.Path, "home", return_value=trash):
            response = self.client.post("/api/sessions/batch_delete", json={"ids": [sid]})
        body = response.json()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(body["deleted"], [sid])
        self.assertIsNone(self.db.get_session(sid))
        self.assertIsNone(self.db.get_link_job(sid))

    def test_batch_delete_reports_each_result(self):
        trash = Path(self.data.name) / "Trash-home"
        ok_sid = self.new_session()
        busy_sid = self.new_session(status="processing")
        self.assertTrue(self.scheduler.try_reserve(busy_sid))
        try:
            with patch.object(self.sessions.Path, "home", return_value=trash):
                response = self.client.post("/api/sessions/batch_delete",
                                            json={"ids": [ok_sid, busy_sid, "missing-id-0000"]})
        finally:
            self.scheduler.release(busy_sid)
        body = response.json()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(body["deleted"], [ok_sid])
        self.assertEqual({f["id"] for f in body["failed"]}, {busy_sid, "missing-id-0000"})
        self.assertFalse(body["ok"])
        self.assertTrue(any(trash.joinpath(".Trash").iterdir()))

    def test_cancel_queued_link_video_marks_cancelled(self):
        sid = self.new_session(kind="link_video", status="pending")
        self.db.create_link_job(sid, self.db.next_link_queue_order())
        response = self.client.post(f"/api/link-videos/{sid}/cancel")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.db.get_session(sid)["status"], "cancelled")
        self.assertEqual(self.db.get_link_job(sid)["job_state"], "cancelled")

    def test_unknown_status_is_rejected(self):
        sid = self.new_session()
        with self.assertRaises(ValueError):
            self.db.update_session(sid, status="live")

    def test_session_list_counts(self):
        sid = self.new_session(kind="live")
        self.db.add_transcripts(sid, [(0, 1, "一", None), (1, 2, "二", None), (2, 3, "三", None)])
        self.db.add_mark(sid, 1.0, "重点")
        self.db.add_screenshot(sid, 0.5, "shots/a.jpg")
        self.db.add_screenshot(sid, 1.5, "shots/b.jpg")
        rows = {r["id"]: r for r in self.client.get("/api/sessions").json()}
        row = rows[sid]
        self.assertEqual((row["transcripts"], row["marks"], row["screenshots"]), (3, 1, 2))
        self.assertNotIn("meta", row)

    def test_scheduler_is_exclusive(self):
        first, second = self.new_session(), self.new_session()
        self.assertTrue(self.scheduler.try_reserve(first))
        try:
            self.assertFalse(self.scheduler.try_reserve(second))
            response = self.client.post(f"/api/link-videos/{second}/retry")
            self.assertIn(response.status_code, (404, 409))
        finally:
            self.scheduler.release(first)
        self.assertTrue(self.scheduler.try_reserve(second))
        self.scheduler.release(second)


if __name__ == "__main__":
    unittest.main(verbosity=2)
