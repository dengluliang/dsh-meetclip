"""场景模板、纪要写笔记、懒回填与导出去重。

运行：MEETCLIP_TEST_PYTHON=... python -m tests.test_minutes_notes（临时数据目录 + 假 AI）。
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

from fastapi import HTTPException

GOOD = {
    "title": "季度规划",
    "summary": "讨论了三件事。",
    "topics": [{
        "start": 5, "title": "预算", "summary": "确认有缺口",
        "points": [{"text": "预算缺口 20 万", "evidence": ["L1"]}],
        "fishbone": {"question": "为什么超支", "branches": [
            {"label": "人力", "detail": "多招了两人", "evidence": ["L2"]},
            {"label": "采购", "detail": "设备涨价", "evidence": ["L2"]}]},
    }],
    "conclusions": [{"text": "下季度压缩开支", "evidence": ["L3"]}],
    "todos": [{"text": "补一份预算表", "owner": "发言人 1", "evidence": ["L3"]}],
    "terms": [{"name": "会摘", "note": "产品名", "heard": ["会窄"]}],
}


def fake_ai(payload=None):
    return {"choices": [{"message": {"content": json.dumps(payload if payload is not None else GOOD,
                                                            ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 80}}


class MinutesNotesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-notes-sync-")
        cls.environment = patch.dict(os.environ, {
            "ZHIBO_DATA_DIR": cls.data.name,
            "MEETCLIP_AI_KEY": "test-key",
            "MEETCLIP_AI_BASE_URL": "https://gateway.example.test/v1",
            "MEETCLIP_AI_MODEL": "demo-text",
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
        cls.prompt = importlib.import_module("minutes_prompt")
        cls.scenarios = importlib.import_module("minutes_scenarios")
        cls.ai_client = importlib.import_module("ai.client")
        cls.export_md = importlib.import_module("export_md")
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
        for table in ("session_minutes", "transcripts", "marks", "screenshots", "sessions"):
            self.db.execute(f"DELETE FROM {table}")
        self.settings.update(minutes_auto="final", minutes_language="简体中文")

    # ---------- 准备 ----------
    def session(self, kind="meeting", notes="", rows=None):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, "预算评审", "", source_type="import", kind=kind)
        self.db.update_session(sid, status="done", duration=300.0, started_at=time.time())
        self.db.update_meta(sid, speakers={"S1": "发言人 1", "S2": "发言人 2"}, language="Chinese")
        for start, end, text, speaker in rows or [
            (5.0, 9.0, "预算缺口还有二十万。", "S1"),
            (12.0, 16.0, "人力多招了两个人，设备也涨价了。", "S2"),
            (20.0, 24.0, "下个季度先把开支压下来。", "S1"),
        ]:
            self.db.add_transcript(sid, start, end, text, speaker)
        if notes:
            self.db.save_record_notes(sid, notes, 0)
        return sid

    def run_final(self, sid):
        with patch.object(self.ai_client, "_post_json", return_value=fake_ai()):
            self.minutes.engine._run(sid, final=True)

    def payload(self, sid):
        return self.minutes.engine.get(sid)

    # ---------- 场景 ----------
    def test_kind_maps_to_scenario(self):
        self.assertEqual(self.scenarios.for_kind("meeting"), "meeting")
        self.assertEqual(self.scenarios.for_kind("link_video"), "video")
        self.assertEqual(self.scenarios.for_kind("live"), "live")
        self.assertEqual(self.scenarios.for_kind("unknown"), "meeting")
        self.assertEqual(self.scenarios.for_kind(None), "meeting")

    def test_topics_cap_follows_scenario(self):
        self.assertEqual(self.prompt.topics_cap(60), 1)
        self.assertEqual(self.prompt.topics_cap(600), 4)
        self.assertEqual(self.prompt.topics_cap(3600), 8)
        self.assertEqual(self.prompt.topics_cap(3600, "video"), 12)
        self.assertEqual(self.prompt.topics_cap(3600, "live"), 10)
        self.assertEqual(self.prompt.topics_cap(60, "video"), 1)

    def test_prompt_uses_scenario_wording_and_context(self):
        lines = [{"index": 10, "start": 300.0, "speaker": "S1", "label": "发言人 1",
                  "text": "继续说预算"}]
        meeting = self.prompt.build({"topics": []}, lines, language="Simplified Chinese",
                                    final=True, duration=300)
        video = self.prompt.build({"topics": []}, lines, language="Simplified Chinese", final=True,
                                  duration=300, scenario="video", context="标题=测试视频；平台=bilibili")
        live = self.prompt.build({"topics": []}, lines, language="Simplified Chinese", final=True,
                                 duration=300, scenario="live")
        self.assertIn("会议", meeting)
        self.assertIn("主题", meeting)
        self.assertIn("视频", video)
        self.assertIn("章节", video)
        self.assertIn("参考信息", video)
        self.assertIn("测试视频", video)
        self.assertIn("直播", live)
        self.assertIn("看点", live)

    def test_markdown_meeting_template_order(self):
        markdown = self.notes.build_markdown({
            **GOOD, "scenario": "meeting", "lang": "Simplified Chinese", "title": "季度规划",
            "summary": "讨论了三件事。",
        }, links=True)
        for marker in ("<!-- meetclip:minutes:begin -->", "<!-- meetclip:minutes:end -->",
                       "# 会议纪要 · 季度规划", "## 结论和待办", "## 总结", "## 主题",
                       "## 人名和术语", "[00:05](meetclip://seek/5)", "- [ ] 补一份预算表（发言人 1）",
                       "**会摘** 产品名（听作：会窄）", "**为什么超支**"):
            self.assertIn(marker, markdown)
        positions = [markdown.index(item) for item in
                     ("## 结论和待办", "## 总结", "## 主题", "## 人名和术语")]
        self.assertEqual(positions, sorted(positions))

    def test_markdown_video_and_live_templates(self):
        payload = {**GOOD, "scenario": "video", "lang": "Simplified Chinese", "title": "一次访谈",
                   "summary": "聊了三件事。"}
        video = self.notes.build_markdown(payload, links=True)
        for marker in ("# 视频纪要 · 一次访谈", "## 总结", "## 章节", "## 要点",
                       "## 可行动项", "## 人名和术语"):
            self.assertIn(marker, video)
        positions = [video.index(item) for item in
                     ("## 总结", "## 章节", "## 要点", "## 可行动项", "## 人名和术语")]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("## 结论和待办", video)

        live = self.notes.build_markdown({**payload, "scenario": "live", "title": "发布会"}, links=True)
        for marker in ("# 直播纪要 · 发布会", "## 总结", "## 看点", "## 结论", "## 后续", "## 人名和术语"):
            self.assertIn(marker, live)

    def test_markdown_projection_has_no_markers(self):
        payload = {**GOOD, "scenario": "meeting", "lang": "Simplified Chinese", "title": "季度规划",
                   "summary": "讨论了三件事。"}
        body = self.notes.build_projection(payload)
        self.assertNotIn("meetclip:minutes:begin", body)
        self.assertTrue(body.startswith("# 会议纪要 · 季度规划"))
        self.assertLess(body.index("## 结论和待办"), body.index("## 总结"))
        plain = self.notes.build_projection(payload, links=False)
        self.assertIn("[00:05]", plain)
        self.assertNotIn("meetclip://seek", plain)

    def test_projection_and_export_include_text_timeline(self):
        payload = {"scenario": "meeting", "lang": "Simplified Chinese", "title": "T", "summary": "s",
                   "topics": [{"start": 5, "title": "开场", "points": []},
                              {"start": 205, "title": "方案", "points": []}],
                   "conclusions": [], "todos": [], "terms": []}
        body = self.notes.build_projection(payload)
        self.assertIn("**时间轴** 00:05 开场 · 03:25 方案", body)
        exported = "\n".join(self.notes.build_export(payload))
        self.assertIn("**时间轴**", exported)
        # 笔记段落不长出时间轴：结构化视图和复制/导出才需要它。
        self.assertNotIn("**时间轴**", self.notes.build_markdown(payload))

    def test_export_section_reuses_scenario_order(self):
        payload = {**GOOD, "scenario": "meeting", "lang": "Simplified Chinese", "title": "季度规划",
                   "summary": "讨论了三件事。"}
        lines = self.notes.build_export(payload)
        text = "\n".join(lines)
        self.assertTrue(text.startswith("## 纪要"))
        self.assertIn("### 结论和待办", text)
        self.assertLess(text.index("### 结论和待办"), text.index("### 总结"))
        self.assertNotIn("# 会议纪要", text)
        self.assertNotIn("meetclip://seek", text)

    def test_markdown_english_labels(self):
        payload = {"scenario": "meeting", "lang": "English", "title": "Planning",
                   "summary": "Three things.", "topics": [], "conclusions": [{"text": "Ship"}],
                   "todos": [], "terms": []}
        markdown = self.notes.build_markdown(payload, links=True)
        self.assertIn("# Meeting notes · Planning", markdown)
        self.assertIn("## Conclusions", markdown)

    def test_apply_block_collapses_duplicate_blocks(self):
        block = self.notes.build_markdown({"scenario": "meeting", "lang": "Simplified Chinese",
                                           "title": "重复", "summary": "摘要", "topics": [],
                                           "conclusions": [], "todos": [], "terms": []})
        notes = f"{block}\n中间的文字\n\n{block}\n结尾"
        merged = self.notes.apply_block(notes, block)
        self.assertEqual(merged.count("<!-- meetclip:minutes:begin -->"), 1)
        self.assertIn("中间的文字", merged)
        self.assertIn("结尾", merged)

    # ---------- 终稿写笔记 ----------
    def test_final_writes_block_and_meta(self):
        sid = self.session(kind="meeting", notes="我的想法")
        self.run_final(sid)
        sess = self.db.get_session(sid)
        shot = sess["notes"]
        self.assertIn("<!-- meetclip:minutes:begin -->", shot)
        self.assertIn("# 会议纪要 · 季度规划", shot)
        self.assertIn("我的想法", shot)
        self.assertTrue(shot.rstrip().endswith("我的想法"))
        self.assertGreaterEqual(sess["notes_version"], 1)
        row = self.db.get_minutes(sid)
        self.assertEqual(sess["meta"]["minutes_notes_version"], row["version"])
        detail = self.client.get(f"/api/sessions/{sid}").json()
        self.assertEqual(detail["minutes_notes_version"], row["version"])
        self.assertEqual(detail["minutes"]["scenario"], "meeting")
        self.assertEqual(detail["minutes_scenario"], "meeting")
        payload = self.client.get(f"/api/sessions/{sid}/minutes").json()
        self.assertEqual(payload["labels"]["summary"], "总结")
        self.assertEqual(payload["section_order"][0], "outcomes")

    def test_minutes_markdown_endpoint(self):
        sid = self.session(kind="meeting")
        self.run_final(sid)
        response = self.client.get(f"/api/sessions/{sid}/minutes.md")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("# 会议纪要 · 季度规划", response.text)
        self.assertNotIn("meetclip:minutes:begin", response.text)
        plain = self.client.get(f"/api/sessions/{sid}/minutes.md", params={"links": 0})
        self.assertIn("[00:05]", plain.text)
        self.assertNotIn("meetclip://seek", plain.text)

    def test_markdown_endpoint_404_without_minutes(self):
        sid = self.session(kind="meeting")
        response = self.client.get(f"/api/sessions/{sid}/minutes.md")
        self.assertEqual(response.status_code, 404)

    def test_video_and_live_final_use_their_templates(self):
        video = self.session(kind="link_video")
        self.run_final(video)
        self.assertIn("# 视频纪要", self.db.get_session(video)["notes"])
        live = self.session(kind="live")
        self.run_final(live)
        self.assertIn("# 直播纪要", self.db.get_session(live)["notes"])

    def test_live_incremental_does_not_touch_notes(self):
        sid = self.session(kind="live", notes="我的想法")
        with patch.object(self.ai_client, "_post_json", return_value=fake_ai()):
            self.minutes.engine._run(sid, final=False)
        sess = self.db.get_session(sid)
        self.assertEqual(sess["notes"], "我的想法")
        self.assertEqual(sess["notes_version"], 1)

    def test_sync_is_idempotent(self):
        sid = self.session()
        self.run_final(sid)
        before = self.db.get_session(sid)
        self.run_final(sid)
        after = self.db.get_session(sid)
        self.assertEqual(before["notes"], after["notes"])
        self.assertEqual(before["notes_version"], after["notes_version"])

    def test_user_can_delete_block_and_force_restore(self):
        sid = self.session()
        self.run_final(sid)
        sess = self.db.get_session(sid)
        self.db.save_record_notes(sid, "只保留我的笔记", sess["notes_version"])
        payload = self.payload(sid)
        skipped = self.notes.sync(sid, payload)
        self.assertFalse(skipped["synced"])
        self.assertEqual(self.db.get_session(sid)["notes"], "只保留我的笔记")
        restored = self.notes.sync(sid, payload, force=True)
        self.assertTrue(restored["synced"])
        self.assertIn("<!-- meetclip:minutes:begin -->", self.db.get_session(sid)["notes"])
        self.assertIn("只保留我的笔记", self.db.get_session(sid)["notes"])

    def test_conflict_retries_and_keeps_latest_user_text(self):
        sid = self.session(notes="用户内容")
        self.db.save_minutes(sid, {"title": "季度规划", "summary": "摘要", "topics": [],
                                   "conclusions": [], "todos": [], "terms": []},
                             covered=20.0, kind="final", lang="Simplified Chinese")
        payload = self.payload(sid)
        real = self.db.save_record_notes
        calls = []

        def flaky(*args, **kwargs):
            calls.append(args)
            if len(calls) == 1:
                raise HTTPException(409, "并发")
            return real(*args, **kwargs)

        with patch.object(self.db, "save_record_notes", side_effect=flaky):
            result = self.notes.sync(sid, payload, force=True)
        self.assertTrue(result["synced"], result)
        self.assertEqual(len(calls), 2)
        self.assertIn("用户内容", self.db.get_session(sid)["notes"])

    def test_materialize_endpoint_for_legacy_minutes(self):
        sid = self.session(notes="历史笔记")
        self.db.save_minutes(sid, {"title": "旧纪要", "summary": "旧摘要", "topics": [],
                                   "conclusions": [], "todos": [], "terms": []},
                             covered=20.0, kind="final", lang="Simplified Chinese")
        response = self.client.post(f"/api/sessions/{sid}/minutes/notes")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["synced"])
        notes = self.db.get_session(sid)["notes"]
        self.assertIn("旧纪要", notes)
        self.assertIn("历史笔记", notes)

    def test_empty_minutes_endpoint_rejects(self):
        sid = self.session()
        response = self.client.post(f"/api/sessions/{sid}/minutes/notes")
        self.assertEqual(response.status_code, 400)

    # ---------- 导出 ----------
    def test_export_deduplicates_block(self):
        sid = self.session(notes="我的旧笔记")
        self.run_final(sid)
        markdown = self.export_md.export_markdown(sid)["markdown"]
        self.assertNotIn("<!-- meetclip:minutes:begin -->", markdown)
        self.assertEqual(markdown.count("## 纪要"), 1)
        self.assertIn("我的旧笔记", markdown)
        self.assertIn("讨论了三件事", markdown)

    def test_export_keeps_block_content_without_minutes_row(self):
        sid = self.session()
        self.run_final(sid)
        self.minutes.engine.clear(sid)
        markdown = self.export_md.export_markdown(sid)["markdown"]
        self.assertNotIn("<!-- meetclip:minutes:begin -->", markdown)
        self.assertIn("季度规划", markdown)


if __name__ == "__main__":
    unittest.main()
