"""说话人规则：5 句阈值、两人以上才编号、编号不回退、猜名证据校验与驳回、名字回填。"""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch


def rows(*spec):
    """spec: (speaker, text, start)"""
    return [{"index": i, "start": start, "speaker": speaker, "text": text}
            for i, (speaker, text, start) in enumerate(spec)]


LONG = "这是一个足够长的句子，用来认声音。"
SHORT = "嗯。"


class SpeakerLabelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-speaker-tests-")
        cls.environment = patch.dict(os.environ, {
            "ZHIBO_DATA_DIR": cls.data.name,
            "MEETCLIP_AI_KEY": "test-key",
            "MEETCLIP_AI_BASE_URL": "https://gateway.example.test/v1",
            "MEETCLIP_AI_MODEL": "demo-text",
            "MEETCLIP_AI_SPACING": "0",
        })
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.labels = importlib.import_module("speaker_labels")
        cls.database = importlib.import_module("database")
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        cls.minutes = importlib.import_module("minutes")
        cls.ai = importlib.import_module("ai.client")
        from fastapi.testclient import TestClient
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": cls.auth.API_TOKEN})

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.environment.stop()
        cls.data.cleanup()

    # ---------- 规则 ----------
    def test_substantive(self):
        self.assertTrue(self.labels.substantive(LONG))
        self.assertFalse(self.labels.substantive(SHORT))
        self.assertTrue(self.labels.substantive("I think we should ship it"))
        self.assertFalse(self.labels.substantive("Yeah."))

    def test_single_speaker_gets_no_numbers(self):
        data = rows(*[("S1", LONG, i * 3.0) for i in range(8)])
        self.assertEqual(self.labels.qualifying_numbers(data), {})

    def test_needs_five_substantive_lines(self):
        data = rows(*[("S1", LONG, i * 3.0) for i in range(4)])
        data += rows(*[("S2", LONG, 30 + i * 3.0) for i in range(5)])
        # S1 只有 4 句，不够格；只剩一人够格 → 不编号
        self.assertEqual(self.labels.qualifying_numbers(data), {})

    def test_numbers_are_stable_and_ordered_by_reaching_threshold(self):
        data = []
        for i in range(5):
            data.append(("S2", LONG, i * 6.0))
            data.append(("S1", SHORT, i * 6.0 + 3))
        for i in range(5):
            data.append(("S1", LONG, 100 + i * 3.0))
        ordered = rows(*data)
        numbers = self.labels.qualifying_numbers(ordered)
        self.assertEqual(numbers, {"S2": 1, "S1": 2})
        # 再多说几轮，编号不动
        more = ordered + rows(*[("S1", LONG, 200 + i * 3.0) for i in range(5)])
        self.assertEqual(self.labels.qualifying_numbers(more), {"S2": 1, "S1": 2})

    def test_display_names_prefer_user_names(self):
        data = rows(*[("S1", LONG, i * 3.0) for i in range(6)])
        data += rows(*[("S2", LONG, 30 + i * 3.0) for i in range(6)])
        names = self.labels.display_names(data, {"S1": "张三", "S2": "发言人 2"})
        self.assertEqual(names["S1"], "张三")
        self.assertEqual(names["S2"], "发言人 2")

    def test_named_replaces_longer_numbers_first(self):
        notes = {"summary": "发言人 1 和发言人 12 都说了", "topics": [
            {"title": "发言人 1 的开场", "summary": "", "points": [{"text": "发言人 12 补充"}]}],
            "conclusions": [{"text": "发言人 1 拍板"}], "todos": [{"text": "发言人 12 跟进", "owner": "发言人 12"}]}
        out = self.labels.named(notes, {1: "张三", 12: "李四"})
        self.assertEqual(out["summary"], "张三 和李四 都说了")
        self.assertEqual(out["topics"][0]["title"], "张三 的开场")
        self.assertEqual(out["topics"][0]["points"][0]["text"], "李四 补充")
        self.assertEqual(out["todos"][0]["owner"], "李四")

    # ---------- 猜名 ----------
    def _two_speakers(self):
        data = []
        for i in range(5):
            data.append({"index": len(data), "start": i * 3.0, "speaker": "S1", "text": LONG})
        for i in range(5):
            data.append({"index": len(data), "start": 20 + i * 3.0, "speaker": "S2", "text": LONG})
        return data

    def test_guess_accepts_self_introduction(self):
        data = [{"index": 0, "start": 0.0, "speaker": "S1", "text": "大家好，我是乔治。"}] + self._two_speakers()[1:]
        payload = {"speakers": [{"speaker": 1, "name": "乔治", "evidence": "L1"}]}
        found, refuted = self.labels.read_guess(json.dumps(payload), data)
        self.assertEqual(found["S1"]["name"], "乔治")
        self.assertIn("00:00", found["S1"]["evidence"])
        self.assertEqual(refuted, {})

    def test_guess_refutes_name_pointing_at_another_speaker(self):
        data = self._two_speakers()
        # L3 落在 S1 那一段里，却声称是发言人 2 的名字 → 驳回
        payload = {"speakers": [{"speaker": 2, "name": "某某", "evidence": "L3"}]}
        found, refuted = self.labels.read_guess(json.dumps(payload), data)
        self.assertEqual(found, {})
        self.assertEqual(refuted, {"S2": "某某"})

    def test_merge_guesses_replaces_and_keeps(self):
        data = [{"index": i, "start": i * 3.0, "speaker": "S1", "text": LONG} for i in range(2)]
        previous = {"S1": {"name": "旧名字", "evidence": "00:00 “旧名字”"}}
        found = {"S1": {"name": "新名字", "evidence": "00:00 “新名字”"}}
        merged = self.labels.merge_guesses(previous, found, {"S2": "另一个"}, data)
        self.assertEqual(merged["S1"]["name"], "新名字")
        self.assertNotIn("S2", merged)

    # ---------- 接口 ----------
    def test_api_plan_and_accept_and_undo(self):
        sid = uuid.uuid4().hex[:12]
        self.database.db.create_session(sid, "两人会议", "", source_type="import", kind="meeting")
        self.database.db.update_session(sid, status="done", duration=120, started_at=0)
        self.database.db.update_meta(sid, speakers={"S1": "发言人 1", "S2": "发言人 2"})
        for i in range(6):
            self.database.db.add_transcript(sid, i * 6.0, i * 6.0 + 3, LONG, "S1")
            self.database.db.add_transcript(sid, i * 6.0 + 3, i * 6.0 + 5, LONG, "S2")
        plan = self.client.get(f"/api/sessions/{sid}/speakers/plan").json()
        self.assertEqual([item["number"] for item in plan["speakers"]], [1, 2])

        reply = {"choices": [{"message": {"content": json.dumps(
            {"speakers": [{"speaker": 1, "name": "张三", "evidence": "L1"}]})}}]}
        with patch.object(self.ai, "_post_json", return_value=reply):
            guess = self.client.post(f"/api/sessions/{sid}/speakers/guess", json={"force": True}).json()
        item = next(entry for entry in guess["speakers"] if entry["number"] == 1)
        self.assertEqual(item["guess"]["name"], "张三")

        accepted = self.client.post(f"/api/sessions/{sid}/speakers/guess/accept",
                                    json={"raw": "S1"}).json()
        self.assertEqual(accepted["speakers"][0]["name"], "张三")

        undone = self.client.post(f"/api/sessions/{sid}/speakers/undo").json()
        self.assertEqual(undone["speakers"][0]["name"], "")
        self.assertEqual(undone["speakers"][0]["label"], "发言人 1")


if __name__ == "__main__":
    unittest.main()
