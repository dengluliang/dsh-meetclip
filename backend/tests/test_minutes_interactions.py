"""纪要互动（待办勾选 / 文字高亮）的存储、投影与笔记同步。

运行：MEETCLIP_TEST_PYTHON=... python -m tests.test_minutes_interactions
"""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

GOOD = {
    "title": "预算评审",
    "summary": "确认了预算缺口。",
    "topics": [{
        "start": 5, "title": "预算缺口",
        "summary": "缺口二十万",
        "points": [{"text": "预算缺口还有二十万", "evidence": ["L1"]}],
    }],
    "conclusions": [{"text": "压缩开支", "evidence": ["L3"]}],
    "todos": [{"text": "补一份预算表", "owner": "发言人 1", "evidence": ["L3"]},
              {"text": "确认采购清单", "owner": "发言人 2", "evidence": ["L2"]}],
    "terms": [{"name": "会摘", "note": "产品名", "heard": ["会窄"]}],
}


def fake_ai(payload=None):
    return {"choices": [{"message": {"content": json.dumps(payload if payload is not None else GOOD,
                                                            ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 80}}


class MinutesInteractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-interactions-")
        cls.environment = patch.dict(os.environ, {
            "ZHIBO_DATA_DIR": cls.data.name,
            "MEETCLIP_AI_KEY": "test-key",
            "MEETCLIP_AI_SPACING": "0",
        })
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.db = cls.database.db
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        cls.minutes = importlib.import_module("minutes")
        cls.notes = importlib.import_module("minutes_notes")
        cls.interactions = importlib.import_module("minutes_interactions")
        cls.ai_client = importlib.import_module("ai.client")
        cls.cards = importlib.import_module("cards")
        cls.settings = importlib.import_module("settings")
        from fastapi.testclient import TestClient
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": cls.auth.API_TOKEN})

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.db._conn.close()
        cls.environment.stop()
        cls.data.cleanup()

    def setUp(self):
        for table in ("card_exports", "session_minutes_interactions", "session_minutes", "transcripts",
                      "marks", "screenshots", "sessions"):
            self.db.execute(f"DELETE FROM {table}")
        card_dir = Path(self.data.name) / self.cards.CARD_DIR_NAME
        if card_dir.exists():
            for item in card_dir.iterdir():
                item.unlink()
            card_dir.rmdir()
        self.settings.update(minutes_auto="final", minutes_language="简体中文")

    def session(self, with_minutes=True):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, "预算评审", "", source_type="import", kind="meeting")
        self.db.update_session(sid, status="done", duration=300.0, started_at=time.time())
        for start, end, text, speaker in [
            (5.0, 9.0, "预算缺口还有二十万。", "S1"),
            (12.0, 16.0, "人力多招了两个人，设备也涨价了。", "S2"),
            (20.0, 24.0, "下个季度先把开支压下来。", "S1"),
        ]:
            self.db.add_transcript(sid, start, end, text, speaker)
        if with_minutes:
            with patch.object(self.ai_client, "_post_json", return_value=fake_ai()):
                self.minutes.engine._run(sid, final=True)
        return sid

    # ---------- 键与归一化 ----------
    def test_todo_key_ignores_spacing_case_and_trailing_punctuation(self):
        key = self.interactions.todo_key("补一份 预算表。")
        self.assertEqual(key, self.interactions.todo_key("补一份预算表"))
        self.assertEqual(key, self.interactions.todo_key("补一份预算表！"))
        self.assertNotEqual(key, self.interactions.todo_key("补一份采购表"))

    def test_normalize_accepts_legacy_shapes(self):
        doc = self.interactions.normalize({
            "todos": {"补预算表": True, "不做了": False},
            "highlights": [{"quote": "预算缺口", "fragments": ["预算缺口"]}],
        })
        self.assertIn(self.interactions.todo_key("补预算表"), doc["todos"])
        self.assertNotIn(self.interactions.todo_key("不做了"), doc["todos"])
        self.assertEqual(len(doc["highlights"]), 1)
        self.assertTrue(doc["highlights"][0]["id"])
        self.assertEqual(doc["highlights"][0]["fragments"][0]["text"], "预算缺口")

    # ---------- 接口 ----------
    def test_put_get_and_minutes_payload(self):
        sid = self.session()
        response = self.client.put(f"/api/sessions/{sid}/minutes/interactions", json={
            "todos": [{"text": "补一份预算表", "done": True}],
            "highlights": [{
                "id": "h-test-1",
                "quote": "预算缺口还有二十万",
                "fragments": [{"text": "预算缺口", "before": "", "after": "还有二十万"}],
                "section": "topics",
                "topic": "预算缺口",
                "t": 5,
            }],
        })
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["interactions"]["todos"][self.interactions.todo_key("补一份预算表")]["done"], True)
        self.assertEqual(body["interactions"]["highlights"][0]["id"], "h-test-1")
        self.assertEqual(body["interactions"]["highlights"][0]["topic"], "预算缺口")

        fetched = self.client.get(f"/api/sessions/{sid}/minutes/interactions").json()["interactions"]
        self.assertEqual(len(fetched["highlights"]), 1)
        self.assertTrue(fetched["todos"])

        minutes = self.client.get(f"/api/sessions/{sid}/minutes").json()
        self.assertIn("interactions", minutes)
        self.assertEqual(len(minutes["interactions"]["highlights"]), 1)
        self.assertTrue(minutes["interactions"]["todos"])

    def test_highlight_needs_quote_or_fragments(self):
        sid = self.session()
        response = self.client.put(f"/api/sessions/{sid}/minutes/interactions", json={
            "highlights": [{"quote": "  "}, {"fragments": [{"text": "预算缺口"}]}]
        })
        self.assertEqual(response.status_code, 200, response.text)
        highlights = response.json()["interactions"]["highlights"]
        self.assertEqual(len(highlights), 1)
        self.assertEqual(highlights[0]["quote"], "预算缺口")

    def test_put_syncs_notes_and_projection(self):
        sid = self.session()
        self.client.put(f"/api/sessions/{sid}/minutes/interactions", json={
            "todos": [{"text": "补一份预算表", "done": True}],
            "highlights": [{"quote": "预算缺口", "fragments": [{"text": "预算缺口"}],
                            "topic": "预算缺口", "t": 5}],
        })
        notes = self.db.get_session(sid)["notes"]
        self.assertIn("- [x] 补一份预算表（发言人 1）", notes)
        self.assertIn("- [ ] 确认采购清单", notes)
        self.assertIn("我高亮的内容", notes)
        self.assertIn("「预算缺口」", notes)
        self.assertIn("[00:05](meetclip://seek/5)", notes)

        projection = self.client.get(f"/api/sessions/{sid}/minutes.md?links=1").text
        self.assertIn("- [x] 补一份预算表", projection)
        self.assertIn("我高亮的内容", projection)

    def test_regenerating_minutes_keeps_interactions(self):
        sid = self.session()
        self.client.put(f"/api/sessions/{sid}/minutes/interactions", json={
            "todos": [{"text": "补一份预算表", "done": True}]
        })
        with patch.object(self.ai_client, "_post_json", return_value=fake_ai()):
            self.minutes.engine._run(sid, final=True)
        payload = self.minutes.engine.get(sid)
        self.assertIn(self.interactions.todo_key("补一份预算表"), payload["interactions"]["todos"])
        notes = self.db.get_session(sid)["notes"]
        self.assertIn("- [x] 补一份预算表", notes)

    def test_unchecking_removes_status(self):
        sid = self.session()
        self.client.put(f"/api/sessions/{sid}/minutes/interactions", json={
            "todos": [{"text": "补一份预算表", "done": True}]
        })
        self.client.put(f"/api/sessions/{sid}/minutes/interactions", json={
            "todos": {"补一份预算表": False}
        })
        notes = self.db.get_session(sid)["notes"]
        self.assertIn("- [ ] 补一份预算表", notes)

    def test_delete_minutes_clears_interactions(self):
        sid = self.session()
        self.client.put(f"/api/sessions/{sid}/minutes/interactions", json={
            "highlights": [{"quote": "预算缺口", "fragments": [{"text": "预算缺口"}]}]
        })
        self.client.delete(f"/api/sessions/{sid}/minutes")
        self.assertIsNone(self.db.get_minutes_interactions(sid))
        empty = self.client.get(f"/api/sessions/{sid}/minutes/interactions").json()["interactions"]
        self.assertEqual(empty["highlights"], [])

    def test_fullwidth_punctuation_is_preserved(self):
        # 高亮片段必须原样保存：NFKC 会把"，："折成半角，界面就匹配不回那段原文了。
        sid = self.session()
        quote = '结论：先建立信任，再谈合作。'
        response = self.client.put(f"/api/sessions/{sid}/minutes/interactions", json={
            "highlights": [{
                "quote": quote,
                "fragments": [{"text": quote, "before": '前面：', "after": '后面。'}],
                "topic": 'Mimo 合作'
            }]
        })
        self.assertEqual(response.status_code, 200, response.text)
        stored = response.json()["interactions"]["highlights"][0]
        self.assertEqual(stored["quote"], quote)
        self.assertEqual(stored["fragments"][0]["text"], quote)
        self.assertEqual(stored["fragments"][0]["before"], '前面：')
        self.assertEqual(stored["fragments"][0]["after"], '后面。')

    def test_card_shows_interactions(self):
        sid = self.session()
        self.client.put(f"/api/sessions/{sid}/minutes/interactions", json={
            "todos": [{"text": "补一份预算表", "done": True}],
            "highlights": [{"quote": "预算缺口", "fragments": [{"text": "预算缺口"}], "topic": "预算缺口", "t": 5}],
        })
        self.cards.sync_cards(force=True)
        directory = Path(self.data.name) / self.cards.CARD_DIR_NAME
        files = list(directory.glob("*.md"))
        self.assertTrue(files)
        text = "\n".join(path.read_text(encoding="utf-8") for path in files)
        self.assertIn("- [x] 补一份预算表", text)
        self.assertIn("我高亮的内容", text)
        self.assertIn("预算缺口", text)

    def test_invalid_session_is_404(self):
        response = self.client.put("/api/sessions/nope/minutes/interactions", json={})
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
