"""运行：.venv/bin/python tests/test_meeting_notes.py（使用临时数据目录）。"""
import importlib
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
import zipfile


SUMMARY = """# 小爱 5.0（Miclaw）技术战略沟通会 · 会议总结

主讲：邹聪 ｜ 产品：陈玉皎 ｜ 参与：王诗薇等

**一句话结论**

从“对话式 AI 助手”转向“Agent 型 AI 伙伴”。

## 三大技术趋势判断

- 强化交互，边说边听边干
- 多任务并发，后台异步

| 主线 | 内涵 | 车 | 人 | 家 |
| ---- | ---- | -- | -- | -- |
| 跨端 | 同一个小爱 | ✓ | ✓ | ✓ |

详细总结：
""" + "保留中文、空行和 Markdown 原文。\n\n" * 1000


class MeetingNotesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-notes-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        cls.main = importlib.import_module("main")
        from fastapi.testclient import TestClient
        auth = importlib.import_module("auth")
        # 不进入 lifespan，避免加载模型或启动真实采集；本地 API 与正式客户端一样需要凭证。
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": auth.API_TOKEN})

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.database.db._conn.close()
        cls.environment.stop()
        cls.data.cleanup()

    def setUp(self):
        self.sid = uuid.uuid4().hex[:12]
        self.database.db.create_session(self.sid, "会议测试", "", source_type="audio", kind="meeting")
        self.database.session_dir(self.sid).mkdir(parents=True, exist_ok=True)

    def save(self, text, sid=None):
        response = self.client.patch(f"/api/sessions/{sid or self.sid}/notes", json={"notes": text})
        self.assertEqual(response.status_code, 200, response.text)

    def detail(self, sid=None):
        response = self.client.get(f"/api/sessions/{sid or self.sid}")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_existing_database_migrates_without_losing_content(self):
        path = Path(self.data.name) / "legacy.db"
        connection = sqlite3.connect(path)
        connection.executescript(self.database._SCHEMA)
        connection.execute("INSERT INTO sessions(id,title,created_at) VALUES('old','原有会议',1)")
        connection.commit()
        connection.close()
        migrated = self.database.DB(path)
        self.assertEqual(migrated.get_session("old")["title"], "原有会议")
        self.assertEqual(migrated.get_session("old")["notes"], "")
        migrated._conn.close()

    def test_new_meeting_has_empty_notes(self):
        self.assertEqual(self.detail()["notes"], "")

    def test_long_markdown_round_trip_and_database_reopen(self):
        self.save(SUMMARY)
        self.assertEqual(self.detail()["notes"], SUMMARY)
        reopened = self.database.DB(self.database.DB_PATH)
        self.assertEqual(reopened.get_session(self.sid)["notes"], SUMMARY)
        reopened._conn.close()

    def test_notes_are_isolated_by_meeting(self):
        other = uuid.uuid4().hex[:12]
        self.database.db.create_session(other, "另一场会议", "", kind="meeting")
        self.save("第一场会议")
        self.save("第二场会议", other)
        self.assertEqual(self.detail()["notes"], "第一场会议")
        self.assertEqual(self.detail(other)["notes"], "第二场会议")

    def test_clearing_notes_and_preserving_whitespace(self):
        self.save("  纪要\n\n待办\n  ")
        self.assertEqual(self.detail()["notes"], "  纪要\n\n待办\n  ")
        self.save("")
        self.assertEqual(self.detail()["notes"], "")

    def test_missing_session_and_invalid_payload(self):
        self.assertEqual(self.client.patch("/api/sessions/missing/notes", json={"notes": "内容"}).status_code, 404)
        for payload in ({}, {"notes": None}, {"notes": 42}):
            self.assertEqual(self.client.patch(f"/api/sessions/{self.sid}/notes", json=payload).status_code, 422)

    def test_speaker_and_transcription_updates_preserve_notes(self):
        self.save(SUMMARY)
        self.database.db.update_session(self.sid, meta={"speakers": {"S1": "发言人"}, "hotwords": "旧热词"})
        self.assertEqual(self.client.patch(f"/api/sessions/{self.sid}/speakers", json={"names": {"S1": "邹聪"}}).status_code, 200)
        self.assertEqual(self.client.patch(f"/api/sessions/{self.sid}/options", json={"hotwords": "Miclaw"}).status_code, 200)
        detail = self.detail()
        self.assertEqual(detail["notes"], SUMMARY)
        self.assertEqual(detail["speakers"]["S1"], "邹聪")
        self.assertEqual(detail["hotwords"], "Miclaw")

    def test_duplicate_copies_notes_and_later_edits_are_independent(self):
        self.save(SUMMARY)
        self.database.db.update_session(self.sid, status="done")
        with patch.object(self.main.sessions, "is_running", return_value=False):
            response = self.client.post(f"/api/sessions/{self.sid}/duplicate")
        self.assertEqual(response.status_code, 200, response.text)
        copied = response.json()["id"]
        self.assertEqual(self.detail(copied)["notes"], SUMMARY)
        self.save("新纪要", copied)
        self.assertEqual(self.detail()["notes"], SUMMARY)

    def test_export_contains_notes_and_original_transcript(self):
        self.save(SUMMARY)
        self.database.db.add_transcript(self.sid, 0, 10, "原始发言内容", "S1")
        response = self.client.get(f"/api/sessions/{self.sid}/export")
        self.assertEqual(response.status_code, 200, response.text)
        with zipfile.ZipFile(response.json()["zip"]) as archive:
            markdown = archive.read("notes.md").decode("utf-8")
        self.assertIn("## 笔记\n\n" + SUMMARY, markdown)
        self.assertIn("## 会议记录", markdown)
        self.assertIn("原始发言内容", markdown)

    def test_empty_notes_do_not_add_empty_export_section(self):
        response = self.client.get(f"/api/sessions/{self.sid}/export")
        self.assertEqual(response.status_code, 200, response.text)
        markdown = (Path(response.json()["dir"]) / "notes.md").read_text()
        self.assertNotIn("## 笔记", markdown)

    def test_live_and_video_notes_round_trip_while_processing(self):
        for kind in ("live", "link_video"):
            with self.subTest(kind=kind):
                sid = uuid.uuid4().hex[:12]
                self.database.db.create_session(sid, "笔记复用", "https://example.com/source", kind=kind)
                self.database.db.update_session(sid, status="recording" if kind == "live" else "processing")
                self.save(SUMMARY, sid)
                # 处理中的持续刷新和元信息更新不能覆盖笔记。
                self.database.db.update_meta(sid, phase="transcribe")
                self.database.db.add_transcript(sid, 5, 10, "新增转写内容")
                self.assertEqual(self.detail(sid)["notes"], SUMMARY)
                reopened = self.database.DB(self.database.DB_PATH)
                self.assertEqual(reopened.get_session(sid)["notes"], SUMMARY)
                reopened._conn.close()
                self.save("", sid)
                self.assertEqual(self.detail(sid)["notes"], "")

    def test_notes_are_isolated_across_all_three_modules(self):
        records = []
        for kind in ("meeting", "live", "link_video"):
            sid = uuid.uuid4().hex[:12]
            self.database.db.create_session(sid, kind, "", kind=kind)
            self.save(f"{kind} 的独立笔记", sid)
            records.append((sid, kind))
        for sid, kind in records:
            self.assertEqual(self.detail(sid)["notes"], f"{kind} 的独立笔记")

    def test_live_and_video_exports_include_notes_and_original_content(self):
        for kind in ("live", "link_video"):
            with self.subTest(kind=kind):
                sid = uuid.uuid4().hex[:12]
                self.database.db.create_session(sid, "完整记录", "https://example.com/source", kind=kind)
                root = self.database.session_dir(sid)
                (root / "shots").mkdir(parents=True, exist_ok=True)
                self.save(SUMMARY, sid)
                self.database.db.add_transcript(sid, 5, 10, "保留原始发言")
                self.database.db.add_mark(sid, 6, "关键结论")
                if kind == "live":
                    (root / "shots/fixture.jpg").write_bytes(b"fixture-image")
                    self.database.db.add_screenshot(sid, 5, "shots/fixture.jpg")
                response = self.client.get(f"/api/sessions/{sid}/export")
                self.assertEqual(response.status_code, 200, response.text)
                with zipfile.ZipFile(response.json()["zip"]) as archive:
                    markdown = archive.read("notes.md").decode("utf-8")
                    self.assertIn("## 笔记\n\n" + SUMMARY, markdown)
                    self.assertIn("## 转写全文", markdown)
                    self.assertIn("保留原始发言", markdown)
                    self.assertIn("关键结论", markdown)
                    self.assertIn("https://example.com/source", markdown)
                    if kind == "live":
                        self.assertIn("shots/fixture.jpg", markdown)
                        self.assertEqual(archive.read("shots/fixture.jpg"), b"fixture-image")
                self.save("", sid)
                response = self.client.get(f"/api/sessions/{sid}/export")
                markdown = (Path(response.json()["dir"]) / "notes.md").read_text()
                self.assertNotIn("## 笔记", markdown)

    def test_live_duplicate_preserves_notes_and_edits_stay_independent(self):
        sid = uuid.uuid4().hex[:12]
        self.database.db.create_session(sid, "直播笔记", "", kind="live")
        self.database.session_dir(sid).mkdir(exist_ok=True)
        self.database.db.update_session(sid, status="done")
        self.save(SUMMARY, sid)
        with patch.object(self.main.sessions, "is_running", return_value=False):
            response = self.client.post(f"/api/sessions/{sid}/duplicate")
        self.assertEqual(response.status_code, 200, response.text)
        copied = response.json()["id"]
        self.assertEqual(self.detail(copied)["notes"], SUMMARY)
        self.save("副本的新笔记", copied)
        self.assertEqual(self.detail(sid)["notes"], SUMMARY)


if __name__ == "__main__":
    unittest.main(verbosity=2)
