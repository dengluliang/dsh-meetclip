"""转写语种：默认中文、auto 语义、链接/会议入队与字幕轨兜底。"""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid


class AsrLanguageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-language-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.db = cls.database.db
        cls.settings = importlib.import_module("settings")
        cls.languages = importlib.import_module("asr_languages")
        cls.meeting = importlib.import_module("meeting")
        cls.subtitles = importlib.import_module("subtitles")
        cls.asr_engines = importlib.import_module("asr_engines")
        cls.cloud = importlib.import_module("cloud_transcription")
        cls.meetings = importlib.import_module("routes.meetings")
        cls.link = importlib.import_module("link_video")
        cls.capture = importlib.import_module("capture")
        cls.scheduler = importlib.import_module("scheduler")
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        from fastapi.testclient import TestClient
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": cls.auth.API_TOKEN})
        cls.class_patches = [
            patch.object(cls.asr_engines, "default_config",
                         return_value={"provider": "mimo", "base_url": "https://example.invalid/v1",
                                       "model": "test-asr"}),
            patch.object(cls.asr_engines, "ready", return_value=True),
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
        self.settings.update(asr_language="Chinese")
        self.enqueued = []
        for table in ("card_pack_members", "card_packs", "task_queue", "link_jobs", "asr_chunks",
                      "transcripts", "marks", "sessions"):
            self.db.execute(f"DELETE FROM {table}")
        self.link.manager.pause()
        self.enqueue_patch = patch.object(self.scheduler, "enqueue", side_effect=self.enqueue)
        self.enqueue_patch.start()
        self.files = Path(self.data.name) / "incoming"
        self.files.mkdir(exist_ok=True)

    def tearDown(self):
        self.enqueue_patch.stop()
        self.link.manager.resume()

    def enqueue(self, sid, task_type, **payload):
        self.enqueued.append((sid, task_type, payload))
        self.db.update_session(sid, status="queued")
        return {"queued": True, "queue_position": len(self.enqueued)}

    def media(self, name="会议.mp4"):
        path = self.files / name
        path.write_bytes(b"x" * 4096)
        return str(path)

    # ---------- 默认值 ----------
    def test_default_is_chinese_and_alias_normalized(self):
        self.assertEqual(self.settings.get("asr_language"), "Chinese")
        self.assertEqual(self.languages.default(), "Chinese")
        self.assertEqual(self.languages.resolve(None), "Chinese")
        self.assertEqual(self.languages.resolve(""), "Chinese")
        self.assertEqual(self.languages.resolve("auto"), "auto")
        self.assertEqual(self.languages.resolve("en"), "English")
        self.assertEqual(self.languages.resolve("zh"), "Chinese")
        self.assertEqual(self.languages.resolve("English"), "English")
        self.assertTrue(self.languages.is_auto("auto"))
        self.assertFalse(self.languages.is_auto("Chinese"))

    def test_settings_can_change_default_and_reject_unknown(self):
        response = self.client.post("/api/settings", json={"asr_language": "en"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["asr_language"], "English")
        self.assertEqual(self.languages.resolve(""), "English")
        self.assertEqual(self.languages.resolve("auto"), "auto")
        bad = self.client.post("/api/settings", json={"asr_language": "Klingon"})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.client.get("/api/settings").json()["asr_language"], "English")

    def test_legacy_auto_is_auto_and_missing_hint_follows_default(self):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, "会议", "", source_type="import", platform="local", kind="meeting")
        self.assertEqual(self.meeting.transcription_params({"meta": {}})["language"], "Chinese")
        self.assertEqual(self.meeting.transcription_params({"meta": {"language_hint": ""}})["language"], "Chinese")
        self.assertEqual(self.meeting.transcription_params({"meta": {"language_hint": "auto"}})["language"], "auto")
        self.assertEqual(self.meeting.transcription_params({"meta": {"language_hint": "English"}})["language"], "English")

    def test_meeting_options_expose_default_and_auto(self):
        body = self.client.get("/api/meeting/options").json()
        self.assertEqual(body["default_language"], "Chinese")
        ids = [item["id"] for item in body["languages"]]
        self.assertIn("auto", ids)
        self.assertIn("Chinese", ids)
        self.assertIn("English", ids)

    def test_meeting_import_without_language_queues_chinese(self):
        path = self.media()
        response = self.client.post("/api/meetings/import", json={"path": path, "title": "导入"})
        self.assertEqual(response.status_code, 200, response.text)
        sid = response.json()["id"]
        self.assertEqual(self.enqueued[0][2]["params"]["language"], "Chinese")
        meta = self.db.get_session(sid)["meta"]
        self.assertEqual(meta["language_hint"], "Chinese")
        explicit = self.client.post("/api/meetings/import",
                                    json={"path": self.media("自动.mp4"), "language": "auto"})
        self.assertEqual(explicit.status_code, 200, explicit.text)
        self.assertEqual(self.enqueued[1][2]["params"]["language"], "auto")

    def test_link_video_records_chinese_hint(self):
        self.client.post("/api/link-videos/batch", json={"items": [{"url": "https://youtu.be/default-lang"}]})
        sid = self.db.one("SELECT id FROM sessions WHERE kind='link_video'")["id"]
        self.assertEqual(self.db.get_session(sid)["meta"]["language_hint"], "Chinese")

    # ---------- 字幕轨 ----------
    def bilibili_info(self, tracks):
        return {"subtitles": {code: [{"ext": "srt", "data": "x"}] for code in tracks}}

    def test_unknown_original_prefers_default_language_track(self):
        info = self.bilibili_info(["ai-zh", "ai-en", "ai-ja", "ai-es", "ai-ar", "ai-pt"])
        summary = self.subtitles.summary(info)
        self.assertEqual(summary["default_subtitle_track_id"], "zh:automatic")
        self.assertFalse(summary["subtitle_selection_required"])
        self.assertEqual(summary["subtitle_language"], "zh")
        ranked = [t["id"] for t in self.subtitles.candidates(info)]
        self.assertEqual(ranked[0], "ar:automatic")

    def test_unknown_original_foreign_only_still_requires_choice(self):
        summary = self.subtitles.summary(self.bilibili_info(["fr", "de", "ar"]))
        self.assertTrue(summary["subtitle_selection_required"])
        self.assertIsNone(summary["default_subtitle_track_id"])

    def test_known_original_wins_over_default(self):
        info = {"language": "en", "subtitles": {
            "zh": [{"ext": "srt", "data": "x"}], "en": [{"ext": "srt", "data": "x"}]}}
        self.assertEqual(self.subtitles.summary(info)["default_subtitle_track_id"], "en:manual")

    # ---------- 会议任务 ----------
    def test_cloud_task_uses_default_language_and_clears_stale_subtitle_language(self):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, "链接视频", "https://example.test/v", source_type="link",
                               platform="youtube", kind="link_video")
        media = self.database.session_dir(sid) / "media.mp4"
        media.parent.mkdir(parents=True, exist_ok=True)
        media.write_bytes(b"\0" * 4096)
        self.db.update_session(sid, media_path="media.mp4")
        self.db.update_meta(sid, asr_engine={"provider": "mimo", "base_url": "https://example.invalid/v1",
                                             "model": "test-asr"},
                            transcription_source="subtitle", language="ar",
                            subtitle_language="ar", subtitle_source_language="ar",
                            subtitle_track_id="ar:automatic")
        seen = {}

        def fake_cloud(task, wav, config):
            seen["language"] = task.params.get("language")
            Path(wav).write_bytes(b"\0" * 4096)
            db = self.db
            with db.transaction():
                db.replace_transcripts(task.sid, [(0, 1, "新的中文转写", None)])

        def fake_extract(task, _media, wav):
            Path(wav).write_bytes(b"\0" * 4096)

        with patch.object(self.meeting.MeetingTask, "_extract_audio", fake_extract), \
                patch.object(self.cloud, "transcribe_file", side_effect=fake_cloud), \
                patch.object(self.meeting.minutes, "auto_mode", return_value="off"):
            task = self.meeting.MeetingTask(sid, params={"language": "", "hotwords": ""})
            self.scheduler.acquire(sid, lambda: task)
            self.assertTrue(task.finished.wait(10))
        self.assertEqual(seen["language"], "Chinese")
        meta = self.db.get_session(sid)["meta"]
        self.assertEqual(meta["language"], "Chinese")
        self.assertEqual(meta["transcription_source"], "asr")
        self.assertNotIn("subtitle_language", meta)
        self.assertNotIn("subtitle_source_language", meta)
        self.assertNotIn("subtitle_track_id", meta)


if __name__ == "__main__":
    unittest.main()
