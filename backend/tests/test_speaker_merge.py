"""运行：.venv/bin/python tests/test_speaker_merge.py（使用临时数据目录）。"""
import importlib
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid


class SpeakerMergeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-speaker-tests-")
        cls.resources = ExitStack()
        cls.resources.enter_context(patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name}))
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        cls.main = importlib.import_module("main")
        export = importlib.import_module("export_md")
        # 同时运行其他测试文件时也使用独立连接与目录，避免复用已关闭的模块级数据库。
        directory = Path(cls.data.name)
        cls.resources.enter_context(patch.object(cls.database, "DATA_DIR", directory))
        cls.db_path = directory / "speakers.db"
        cls.db = cls.database.DB(cls.db_path)
        modules = [cls.database, export] + [importlib.import_module(name) for name in (
            "routes.common", "routes.sessions", "routes.meetings", "routes.link_videos")]
        for module in modules:
            cls.resources.enter_context(patch.object(module, "db", cls.db))
        from fastapi.testclient import TestClient
        auth = importlib.import_module("auth")
        # 不进入 lifespan，避免加载模型或启动真实采集；本地 API 与正式客户端一样需要凭证。
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": auth.API_TOKEN})

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.db._conn.close()
        cls.resources.close()
        cls.data.cleanup()

    def setUp(self):
        self.sid = uuid.uuid4().hex[:12]
        db = self.database.db
        db.create_session(self.sid, "合并测试", "", source_type="audio", kind="meeting")
        self.database.session_dir(self.sid).mkdir(parents=True, exist_ok=True)
        db.update_session(self.sid, notes="# 会议笔记\n保留原文", meta={
            "speakers": {"S1": "邹聪", "S2": "发言人 2", "S3": "陈玉皎"},
            "hotwords": "Miclaw", "aligned": True,
        })
        db.add_transcripts(self.sid, [
            (0, 3, "第一人的发言", "S1"),
            (3, 8, "第二人的第一次发言", "S2"),
            (8, 10, "另一人的发言", "S3"),
            (10, 14, "第二人的第二次发言", "S2"),
            (14, 15, "未标注的发言", None),
        ])

    def detail(self):
        response = self.client.get(f"/api/sessions/{self.sid}")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def update(self, body):
        response = self.client.patch(f"/api/sessions/{self.sid}/speakers", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_duplicate_name_without_confirmation_keeps_separate_speakers(self):
        before = self.detail()
        result = self.update({"names": {"S2": " \n邹聪\t "}})
        self.assertEqual(result["speakers"], {"S1": "邹聪", "S2": "邹聪", "S3": "陈玉皎"})
        after = self.detail()
        self.assertEqual(after["transcripts"], before["transcripts"])
        self.assertEqual(after["notes"], before["notes"])

    def test_confirmed_merge_reassigns_all_speech_and_preserves_other_data(self):
        db = self.database.db
        other = uuid.uuid4().hex[:12]
        db.create_session(other, "另一场会议", "", kind="meeting")
        db.update_session(other, meta={"speakers": {"S2": "另一位同名说话人"}})
        db.add_transcript(other, 0, 2, "另一场会议的发言", "S2")
        other_before = db.get_transcripts(other)
        db.add_mark(self.sid, 4, "重要发言")
        self.update({"names": {"S2": "邹聪"}})
        before = self.detail()

        result = self.update({"merge": {"S2": "S1"}})
        self.assertEqual(result["speakers"], {"S1": "邹聪", "S3": "陈玉皎"})
        after = self.detail()
        expected = [dict(t, speaker="S1" if t["speaker"] == "S2" else t["speaker"])
                    for t in before["transcripts"]]
        self.assertEqual(after["transcripts"], expected)
        for key in ("notes", "marks", "hotwords", "aligned"):
            self.assertEqual(after[key], before[key])
        self.assertEqual(db.get_transcripts(other), other_before)
        self.assertEqual(db.get_session(other)["meta"]["speakers"], {"S2": "另一位同名说话人"})

        duration = sum(t["end"] - t["start"] for t in after["transcripts"] if t["speaker"] == "S1")
        self.assertEqual(duration, 12)
        reopened = self.database.DB(self.db_path)
        try:
            self.assertEqual(reopened.get_transcripts(self.sid), expected)
            self.assertEqual(reopened.get_session(self.sid)["meta"]["speakers"], result["speakers"])
        finally:
            reopened._conn.close()

        export = self.main.export_markdown(self.sid)
        markdown = (Path(export["dir"]) / "notes.md").read_text(encoding="utf-8")
        people = markdown.split("## 参会人\n\n", 1)[1].split("\n\n", 1)[0]
        self.assertEqual(people.count("邹聪"), 1)
        self.assertIn("邹聪（发言约 00:12，86%）", people)
        for transcript in expected:
            self.assertIn(transcript["text"], markdown)
        self.assertIn(before["notes"], markdown)

    def test_merge_only_combines_selected_pair_when_more_names_are_duplicated(self):
        self.update({"names": {"S2": "邹聪", "S3": "邹聪"}})
        self.update({"merge": {"S2": "S1"}})
        after = self.detail()
        self.assertEqual(after["speakers"], {"S1": "邹聪", "S3": "邹聪"})
        self.assertEqual([t["speaker"] for t in after["transcripts"]], ["S1", "S1", "S3", "S1", None])


if __name__ == "__main__":
    unittest.main(verbosity=2)
