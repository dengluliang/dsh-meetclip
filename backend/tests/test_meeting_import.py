"""会议导入：单文件兼容、音视频批量入队与自动卡包；临时数据目录、模拟队列。"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid


class MeetingImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-import-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.db = cls.database.db
        cls.meetings = importlib.import_module("routes.meetings")
        cls.capture = importlib.import_module("capture")
        cls.scheduler = importlib.import_module("scheduler")
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        from fastapi.testclient import TestClient
        cls.TestClient = TestClient
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": cls.auth.API_TOKEN})
        cls.class_patches = [
            patch.object(cls.meetings.asr_engines, "default_config",
                         return_value={"provider": "mimo", "base_url": "https://example.invalid/v1",
                                       "model": "test-asr"}),
            patch.object(cls.meetings.asr_engines, "ready", return_value=True),
            patch.dict(cls.capture.DEPS, {"ffmpeg": "/usr/bin/true"}),
        ]
        for item in cls.class_patches:
            item.start()

    @classmethod
    def tearDownClass(cls):
        for item in reversed(cls.class_patches):
            item.stop()
        cls.client.close()
        cls.db._conn.close()
        cls.environment.stop()
        cls.data.cleanup()

    def setUp(self):
        self.enqueued = []
        self.fail_call = 0
        for table in ("card_pack_members", "card_packs", "task_queue", "transcripts", "marks", "sessions"):
            self.db.execute(f"DELETE FROM {table}")
        self.patches = [
            patch.object(self.scheduler, "enqueue", side_effect=self.enqueue),
        ]
        for item in self.patches:
            item.start()
        self.files = Path(self.data.name) / "incoming"
        self.files.mkdir(exist_ok=True)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()

    def enqueue(self, sid, task_type, **payload):
        self.enqueued.append((sid, task_type, payload))
        if self.fail_call and len(self.enqueued) >= self.fail_call:
            raise RuntimeError("模拟入队失败")
        self.db.update_session(sid, status="queued")
        return {"queued": True, "queue_position": len(self.enqueued)}

    def media(self, name, size=4096):
        path = self.files / name
        path.write_bytes(b"x" * size)
        return str(path)

    def import_one(self, path, title="", language=""):
        return self.client.post("/api/meetings/import", json={
            "path": path, "title": title, "language": language,
        })

    def import_batch(self, paths, **extra):
        body = {"items": [{"path": path} for path in paths], **extra}
        return self.client.post("/api/meetings/import-batch", json=body)

    def test_single_import_keeps_legacy_response_and_no_pack(self):
        path = self.media("单条会议.mp4")
        response = self.import_one(path)
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertIn("id", payload)
        self.assertTrue(payload["queued"])
        self.assertEqual(len(self.enqueued), 1)
        self.assertEqual(self.enqueued[0][1], "meeting")
        self.assertEqual(self.enqueued[0][2]["import_file"], path)
        self.assertEqual(self.client.get("/api/home").json()["packs"], [])

    def test_batch_import_videos_creates_one_active_pack(self):
        first = self.media("产品评审 第 1 场.mp4")
        second = self.media("产品评审 第 2 场.mkv")
        response = self.import_batch([first, second], language="Chinese", pack_title="  产品评审  ")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["ids"], [sid for sid, _, _ in self.enqueued])
        self.assertEqual(len(body["ids"]), 2)
        self.assertTrue(all(row["ok"] for row in body["results"]))
        self.assertTrue(all(row["queue_position"] in (1, 2) for row in body["results"]))
        pack = body["pack"]
        self.assertIsNotNone(pack)
        self.assertEqual(pack["title"], "产品评审")
        self.assertEqual(pack["count"], 2)
        self.assertEqual(pack["active_count"], 2)
        self.assertEqual([member["type"] for member in pack["members"]], ["session", "session"])
        for sid in body["ids"]:
            self.assertEqual(self.db.get_session(sid)["status"], "queued")
        home = self.client.get("/api/home").json()
        self.assertEqual([row["id"] for row in home["packs"]], [pack["id"]])
        self.assertEqual(home["packs"][0]["count"], 2)

    def test_batch_generates_default_pack_title(self):
        response = self.import_batch([self.media("早会.m4a"), self.media("午会.wav")])
        self.assertEqual(response.status_code, 200, response.text)
        pack = response.json()["pack"]
        self.assertIsNotNone(pack)
        self.assertRegex(pack["title"], r"^会议录音 · \d\d-\d\d \d\d:\d\d$")

    def test_one_valid_file_among_failures_does_not_create_pack(self):
        valid = self.media("能导入.mp4")
        invalid = self.files / "不支持的.txt"
        invalid.write_text("not media", encoding="utf-8")
        response = self.import_batch([valid, str(invalid)])
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(len(body["ids"]), 1)
        self.assertIsNone(body["pack"])
        failed = [row for row in body["results"] if not row["ok"]]
        self.assertEqual(len(failed), 1)
        self.assertIn("仅支持", failed[0]["message"])
        self.assertEqual(self.client.get("/api/home").json()["packs"], [])

    def test_all_invalid_returns_400_with_row_results(self):
        invalid = self.files / "说明.pdf"
        invalid.write_bytes(b"pdf")
        response = self.import_batch([str(invalid)])
        self.assertEqual(response.status_code, 400, response.text)
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["results"][0]["ok"], False)
        self.assertEqual(self.client.get("/api/sessions").json(), [])
        self.assertEqual(self.enqueued, [])

    def test_duplicate_paths_only_import_once(self):
        path = self.media("重复.m4a")
        response = self.import_batch([path, path])
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(len(body["ids"]), 1)
        self.assertIsNone(body["pack"])
        self.assertEqual(sum(1 for row in body["results"] if not row["ok"]), 1)
        self.assertEqual(len(self.enqueued), 1)

    def test_enqueue_failure_marks_one_row_without_losing_the_other(self):
        self.fail_call = 2
        response = self.import_batch([self.media("第一条.mp4"), self.media("第二条.mp4")])
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(len(body["ids"]), 1)
        self.assertIsNone(body["pack"])
        failed = [row for row in body["results"] if not row["ok"]]
        self.assertEqual(len(failed), 1)
        self.assertIn("模拟入队失败", failed[0]["message"])

    def test_more_than_limit_is_rejected_before_import(self):
        items = [{"path": str(self.files / f"文件-{index}.mp4")} for index in range(21)]
        response = self.client.post("/api/meetings/import-batch", json={"items": items})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("最多", response.text)
        self.assertEqual(self.enqueued, [])

    def test_manual_pack_api_still_rejects_active_sessions(self):
        active = uuid.uuid4().hex[:12]
        self.db.create_session(active, "正在转写", "", source_type="import", platform="local", kind="meeting")
        self.db.update_session(active, status="queued")
        response = self.client.post("/api/packs", json={
            "id": "packactiveimport1",
            "members": [{"type": "session", "id": active}],
        })
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("进行中", response.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
