"""AI 纪要：提示词解析、时间锚点、语言校验、失败不覆盖、接口与指标。

运行：MEETCLIP_TEST_PYTHON=... .venv/bin/python -m tests.test_minutes
（临时数据目录 + 假 AI，不访问网络、不碰真实记录）
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

ENGLISH = {"title": "Quarterly planning", "summary": "We discussed three things.",
           "topics": [{"start": 0, "title": "Budget", "points": [{"text": "A gap", "evidence": ["L1"]}]}],
           "conclusions": [], "todos": [], "terms": []}


def reply(payload=None) -> str:
    return json.dumps(payload if payload is not None else GOOD, ensure_ascii=False)


def fake_ai(payload=None):
    """模拟网关返回：choices[0].message.content 里放我们的 JSON。"""
    return {"choices": [{"message": {"content": reply(payload)}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 80}}


class MinutesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-minutes-tests-")
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
        cls.prompt = importlib.import_module("minutes_prompt")
        cls.ai_client = importlib.import_module("ai.client")
        cls.metrics = importlib.import_module("ai.metrics")
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
        for table in ("session_minutes", "transcripts", "sessions"):
            self.db.execute(f"DELETE FROM {table}")

    # ---------- 准备数据 ----------
    def session(self, rows=None, duration=300.0, kind="meeting", language="Chinese"):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, "预算评审", "", source_type="import", kind=kind)
        self.db.update_session(sid, status="done", duration=duration, started_at=time.time())
        self.db.update_meta(sid, speakers={"S1": "发言人 1", "S2": "发言人 2"}, language=language)
        for start, end, text, speaker in rows or [
            (5.0, 9.0, "预算缺口还有二十万。", "S1"),
            (12.0, 16.0, "人力多招了两个人，设备也涨价了。", "S2"),
            (20.0, 24.0, "下个季度先把开支压下来。", "S1"),
        ]:
            self.db.add_transcript(sid, start, end, text, speaker)
        return sid

    # ---------- 纯函数 ----------
    def test_parse_maps_evidence_to_seconds(self):
        times = [5.0, 12.0, 20.0]
        notes = self.prompt.parse(reply(), times)
        self.assertEqual(notes["title"], "季度规划")
        point = notes["topics"][0]["points"][0]
        self.assertEqual(point["t"], 5.0)
        self.assertEqual(point["support"], 1)
        self.assertEqual(notes["topics"][0]["start"], 5.0)
        self.assertEqual(notes["conclusions"][0]["t"], 20.0)
        self.assertEqual(notes["todos"][0]["owner"], "发言人 1")
        branches = notes["topics"][0]["fishbone"]["branches"]
        self.assertEqual(len(branches), 2)
        self.assertEqual(branches[0]["t"], 12.0)
        self.assertEqual(notes["terms"][0]["heard"], ["会窄"])

    def test_parse_ignores_out_of_range_evidence(self):
        notes = self.prompt.parse(reply({"summary": "有内容", "topics": [
            {"title": "主题", "points": [{"text": "要点", "evidence": ["L99"]}]}]}), [0.0])
        self.assertIsNone(notes["topics"][0]["points"][0]["t"])
        self.assertEqual(notes["topics"][0]["points"][0]["support"], 0)

    def test_parse_rejects_non_json(self):
        self.assertIsNone(self.prompt.parse("这不是 JSON", [0.0]))
        self.assertIsNone(self.prompt.parse("{}", [0.0]))

    def test_language_check(self):
        chinese = {"summary": "讨论了三件事。", "topics": [{"title": "预算"}]}
        english = {"summary": "We discussed three things.", "topics": [{"title": "Budget"}]}
        self.assertTrue(self.prompt.written_in(chinese, "Simplified Chinese"))
        self.assertFalse(self.prompt.written_in(english, "Simplified Chinese"))
        self.assertTrue(self.prompt.written_in(english, "English"))
        self.assertFalse(self.prompt.written_in(chinese, "English"))

    def test_carry_times_keeps_the_earliest(self):
        old = {"topics": [{"title": "预算", "points": [{"text": "缺口 20 万", "t": 5.0}]}],
               "conclusions": [{"text": "压缩开支", "t": 20.0}], "todos": []}
        new = {"topics": [{"title": "预算", "points": [{"text": "缺口 20 万", "t": 30.0},
                                                       {"text": "缺口 20 万", "t": None}]}],
               "conclusions": [{"text": "压缩开支", "t": None}], "todos": []}
        merged = self.prompt.carry_times(old, new)
        self.assertEqual(merged["topics"][0]["points"][0]["t"], 5.0)
        self.assertEqual(merged["topics"][0]["points"][1]["t"], 5.0)
        self.assertEqual(merged["conclusions"][0]["t"], 20.0)

    # ---------- 主题起点：不信模型自己算的秒数 ----------
    def test_parse_anchors_topic_start_that_overruns_the_media(self):
        # 现场：1:19:20 的视频，模型把 1:09:47 写成 1:49:47（6587 秒），时间轴指向了不存在的片段。
        kinds = {"topics": [{"start": 6587, "title": "心力球", "points": [
            {"text": "多层 PCC 加密", "evidence": ["L1"]},
            {"text": "手表升级", "evidence": ["L2"]}]}]}
        notes = self.prompt.parse(reply(kinds), [4187.0, 4197.0])
        self.assertEqual(notes["topics"][0]["start"], 4187.0)
        self.assertLessEqual(notes["topics"][0]["start"], 4197.0)

    def test_parse_never_starts_a_topic_after_its_first_evidence(self):
        kinds = {"topics": [{"start": 5000, "title": "主题", "points": [
            {"text": "要点", "evidence": ["L2"]}]}]}
        notes = self.prompt.parse(reply(kinds), [10.0, 20.0])
        self.assertEqual(notes["topics"][0]["start"], 20.0)

    def test_parse_keeps_a_slightly_earlier_topic_start(self):
        # 章节开场白常不带结论句：比第一条证据早一点是合理的，保留。
        kinds = {"topics": [{"start": 30, "title": "主题", "points": [
            {"text": "要点", "evidence": ["L2"]}]}]}
        notes = self.prompt.parse(reply(kinds), [10.0, 60.0])
        self.assertEqual(notes["topics"][0]["start"], 30.0)

    def test_parse_falls_back_when_start_is_outside_the_media(self):
        kinds = {"topics": [{"start": 9000, "title": "无证据主题"}]}
        notes = self.prompt.parse(reply(kinds), [0.0, 100.0])
        self.assertEqual(notes["topics"][0]["start"], 0.0)

    def test_sanitize_repairs_stored_starts(self):
        topics = [{"start": 6587, "title": "心力球", "points": [{"text": "a", "t": 4187.0}]},
                  {"start": 6727, "title": "互联", "points": [{"text": "b", "t": 4327.9}]}]
        self.assertTrue(self.prompt.sanitize_topics(topics, 4760.8))
        self.assertEqual([topic["start"] for topic in topics], [4187.0, 4327.9])
        self.assertFalse(self.prompt.sanitize_topics(topics, 4760.8))

    def test_sanitize_keeps_order_and_trusts_a_lonely_anchor(self):
        # 只有一条证据、又只是把起点往前拽：不动（孤证可能来自别的段落），顺序也不能倒。
        topics = [{"start": 300.0, "title": "A", "points": [{"text": "a", "t": 300.0}]},
                  {"start": 900.0, "title": "B", "points": [{"text": "b", "t": 1132.1}]},
                  {"start": 1600.0, "title": "C", "points": [{"text": "c", "t": 2787.6}]},
                  {"start": 2230.0, "title": "D", "points": [{"text": "d", "t": 2230.0}]}]
        self.prompt.sanitize_topics(topics, 2981.0)
        self.assertEqual([topic["start"] for topic in topics], [300.0, 900.0, 1600.0, 2230.0])
        # 修出来的起点跑到了上一个主题前面时，钳回上一个主题，时间轴保持单调。
        topics = [{"start": 500.0, "title": "A", "points": [{"text": "a", "t": 500.0}]},
                  {"start": 120.0, "title": "B", "points": [{"text": "b", "t": 120.0},
                                                            {"text": "c", "t": 140.0}]}]
        self.prompt.sanitize_topics(topics, 600.0)
        self.assertEqual([topic["start"] for topic in topics], [500.0, 500.0])

    def test_carry_times_keeps_the_earliest_topic_start(self):
        old = {"topics": [{"start": 4187.0, "title": "心力球", "points": []}]}
        new = {"topics": [{"start": 6587.0, "title": "心力球", "points": []}]}
        merged = self.prompt.carry_times(old, new)
        self.assertEqual(merged["topics"][0]["start"], 4187.0)

    def test_merge_window_restores_topics_the_model_dropped(self):
        old = {"topics": [{"start": 5.0, "title": "开场"},
                          {"start": 200.0, "title": "方案"}]}
        new = {"topics": [{"start": 400.0, "title": "收尾"}]}
        merged = self.prompt.merge_window(old, new)
        self.assertEqual([topic["title"] for topic in merged["topics"]], ["开场", "方案", "收尾"])
        final = self.prompt.merge_window({"topics": [{"start": 5.0, "title": "开场"}]},
                                         {"topics": [{"start": 5.0, "title": "开场"},
                                                     {"start": 400.0, "title": "收尾"}]})
        self.assertEqual(len(final["topics"]), 2)

    def test_carry_times_repairs_rewritten_points(self):
        # 分窗终稿里模型把老主题的要点改写了一遍、还丢了 evidence：时间与证据数要能接回来。
        old = {"topics": [{"start": 100.0, "title": "心力球", "support": 4, "points": [
            {"text": "端侧、云侧与传输通道均采用多层 PCC 加密", "t": 4187.0, "support": 1},
            {"text": "超燃指模式按个人体征测算千人千面的最佳燃脂心率区间", "t": 4297.9, "support": 2}]}]}
        new = {"topics": [{"start": 100.0, "title": "心力球加密", "support": 0, "points": [
            {"text": "端侧、云侧与传输通道均使用多层 PCC 加密，设备丢失也无法破解", "t": None, "support": 0},
            {"text": "全新超燃脂模式按个人体征测算最佳燃脂心率区间并主动提醒", "t": None, "support": 0}]}]}
        merged = self.prompt.carry_times(old, new)
        points = merged["topics"][0]["points"]
        self.assertEqual([point["t"] for point in points], [4187.0, 4297.9])
        self.assertEqual([point["support"] for point in points], [1, 2])
        self.assertEqual(merged["topics"][0]["support"], 2)

    def test_carry_times_follows_point_ids(self):
        # 模型把要点改写得很不一样、但把 id 带回来了：仍然接回原来的时间与依据数。
        pid = self.prompt._point_id("原始说法一")
        old = {"topics": [{"start": 100.0, "title": "A", "points": [
            {"text": "原始说法一", "t": 4187.0, "support": 2}]}]}
        new = {"topics": [{"start": 100.0, "title": "A", "points": [
            {"text": "完全改写过的另一句话", "t": None, "support": 0, "id": pid}]}]}
        merged = self.prompt.carry_times(old, new)
        self.assertEqual(merged["topics"][0]["points"][0]["t"], 4187.0)
        self.assertEqual(merged["topics"][0]["points"][0]["support"], 2)

    def test_compact_carries_point_ids_and_save_strips_them(self):
        notes = {"topics": [{"start": 1.0, "title": "A", "points": [{"text": "要点一", "t": 5.0}]}]}
        compact = self.prompt._compact(notes)
        self.assertIn(self.prompt._point_id("要点一"), compact)

        def strip(notes):
            self.prompt.strip_point_ids(notes)
        kept = {"topics": [{"start": 1.0, "title": "A", "points": [
            {"text": "要点一", "t": 5.0, "support": 1, "id": "abc123"}]}]}
        strip(kept)
        self.assertNotIn("id", kept["topics"][0]["points"][0])

    def test_merge_window_keeps_the_anchored_old_topic(self):
        # 模型在最后一窗把老主题重写了一遍（没有证据）：保留上一窗那份带时间的版本。
        old = {"topics": [{"start": 100.0, "title": "A", "support": 1,
                           "points": [{"text": "原要点", "t": 4187.0, "support": 1}]}]}
        new = {"topics": [{"start": 100.0, "title": "A", "support": 0,
                           "points": [{"text": "改写后的要点", "t": None, "support": 0}]}]}
        merged = self.prompt.merge_window(old, new)
        self.assertEqual(len(merged["topics"]), 1)
        self.assertEqual(merged["topics"][0]["points"][0]["t"], 4187.0)

    def test_merge_window_keeps_global_sections(self):
        old = {"summary": "旧总结", "conclusions": [{"text": "结论一", "t": 5.0, "support": 1}],
               "todos": [{"text": "待办一", "t": 6.0, "support": 1}], "terms": [], "topics": [{"start": 0, "title": "A"}]}
        new = {"summary": "新总结", "conclusions": [], "todos": [], "terms": [],
               "topics": [{"start": 0, "title": "A"}]}
        merged = self.prompt.merge_window(old, new)
        self.assertEqual(merged["summary"], "新总结")
        self.assertEqual(merged["conclusions"][0]["text"], "结论一")
        self.assertEqual(merged["todos"][0]["text"], "待办一")

    def test_merge_window_treats_a_renamed_topic_as_the_same(self):
        # 模型把标题改了、起点没动：不算被丢掉，不能补出一份重复主题。
        renamed = self.prompt.merge_window({"topics": [{"start": 5.0, "title": "预算·评审"}]},
                                           {"topics": [{"start": 6.0, "title": "预算评审"}]})
        self.assertEqual(len(renamed["topics"]), 1)

    def test_topic_cap_follows_duration(self):
        self.assertEqual(self.prompt.topics_cap(60), 1)
        self.assertEqual(self.prompt.topics_cap(600), 4)
        self.assertEqual(self.prompt.topics_cap(3600), 8)

    def test_plan_final_windows(self):
        self.assertEqual(self.prompt.plan_final(100), [(0, 100)])
        self.assertEqual(self.prompt.plan_final(650), [(0, 300), (300, 600), (600, 650)])

    def test_prompt_forbids_new_topic_right_after_one_started(self):
        notes = {"topics": [{"start": 290.0, "title": "预算"}], "summary": "x"}
        lines = [{"index": 10, "start": 300.0, "speaker": "S1", "label": "发言人 1",
                  "text": "继续说预算"}]
        text = self.prompt.build(notes, lines, language="Simplified Chinese", final=False, duration=300)
        self.assertIn("不要新开主题", text)
        self.assertIn("[L11 05:00 发言人 1]", text)

    # ---------- 引擎 ----------
    def test_engine_final_windows_keep_earlier_topics(self):
        rows = [(10.0 + i, 10.5 + i, "第%d句内容，用来测分窗。" % i, "S1") for i in range(330)]
        sid = self.session(rows=rows, duration=340.0)
        payloads = [
            {"title": "长视频", "summary": "前半段内容。", "topics": [
                {"start": 10, "title": "开场", "points": [{"text": "第一段要点", "evidence": ["L1"]}]}]},
            {"title": "长视频", "summary": "后半段内容。", "topics": [
                {"start": 320, "title": "收尾", "points": [{"text": "第二段要点", "evidence": ["L330"]}]}]},
        ]
        prompts = []

        def fake(url, key, body, timeout):
            prompts.append(body["messages"][0]["content"])
            return fake_ai(payloads[len(prompts) - 1])

        with patch.object(self.ai_client, "_post_json", side_effect=fake):
            self.minutes.engine._run(sid, final=True)
        notes = self.minutes.engine.get(sid)
        # 第二窗的回复只写了本窗内容：缺的旧主题要按时间补回去，不能只剩最后一窗。
        self.assertEqual([topic["title"] for topic in notes["topics"]], ["开场", "收尾"])
        self.assertEqual([topic["start"] for topic in notes["topics"]], [10.0, 320.0])
        self.assertEqual(len(prompts), 2)
        self.assertIn("当前纪要", prompts[1])
        self.assertIn("第 2/2 段", prompts[1])

    def test_engine_sanitizes_stored_starts_on_read(self):
        sid = self.session(duration=4760.8)
        data = {"title": "发布会", "summary": "有内容。", "topics": [
            {"start": 6587, "title": "心力球", "points": [{"text": "要点", "t": 4187.0}]}],
            "conclusions": [], "todos": [], "terms": []}
        self.db.save_minutes(sid, data, covered=4760.5, kind="final", lang="Chinese")
        notes = self.minutes.engine.get(sid)
        self.assertEqual(notes["topics"][0]["start"], 4187.0)

    def test_ask_retries_truncated_json_with_bigger_budget(self):
        sid = self.session()
        budgets = []

        def fake_chat(prompt, instruction, **kwargs):
            budgets.append(kwargs.get("max_tokens"))
            if len(budgets) == 1:
                return '{"title": "x", "summary": "y", "topics": [{"title": "A", "points": [{"text": "p"'
            return reply()

        with patch.object(self.ai_client, "chat", side_effect=fake_chat):
            parsed = self.minutes.engine._ask(sid, "prompt", final=True,
                                              language="Simplified Chinese", times=[5.0, 12.0, 20.0])
        self.assertIsNotNone(parsed)
        self.assertEqual(budgets, [4096, 8192])

    def test_engine_writes_minutes_with_anchors(self):
        sid = self.session()
        with patch.object(self.ai_client, "_post_json", return_value=fake_ai()):
            self.minutes.engine._run(sid, final=True)
        notes = self.minutes.engine.get(sid)
        self.assertEqual(notes["title"], "季度规划")
        self.assertTrue(notes["final"])
        self.assertEqual(notes["topics"][0]["points"][0]["t"], 5.0)
        self.assertAlmostEqual(notes["covered"], 20.0)
        row = self.db.get_minutes(sid)
        self.assertEqual(row["kind"], "final")
        self.assertGreaterEqual(row["version"], 1)

    def test_engine_keeps_previous_notes_on_bad_reply(self):
        sid = self.session()
        with patch.object(self.ai_client, "_post_json", return_value=fake_ai()):
            self.minutes.engine._run(sid, final=True)
        before = self.minutes.engine.get(sid)
        bad = {"choices": [{"message": {"content": "抱歉，我无法总结。"}}]}
        with patch.object(self.ai_client, "_post_json", return_value=bad):
            self.minutes.engine._run(sid, final=True)
        after = self.minutes.engine.get(sid)
        self.assertEqual(before["topics"], after["topics"])
        self.assertEqual(after["state"], "failed")

    def test_engine_drops_wrong_language_final(self):
        sid = self.session()
        with patch.object(self.ai_client, "_post_json", return_value=fake_ai(ENGLISH)):
            self.minutes.engine._run(sid, final=True)
        notes = self.minutes.engine.get(sid)
        self.assertEqual(notes["topics"], [])
        self.assertEqual(notes["state"], "failed")

    def test_engine_records_metrics(self):
        sid = self.session()
        with patch.object(self.ai_client, "_post_json", return_value=fake_ai()):
            self.minutes.engine._run(sid, final=True)
        summary = self.metrics.summary(sid)
        self.assertEqual(summary["calls"], 1)
        self.assertEqual(summary["uses"][0]["role"], "notes")
        self.assertIsNotNone(summary["latency"])

    def test_finish_skips_without_key(self):
        sid = self.session()
        with patch("ai.keys.get", return_value=None):
            self.assertFalse(self.minutes.finish(sid))
        self.assertEqual(self.db.get_minutes(sid)["state"], "no_key")

    # ---------- 接口 ----------
    def test_api_minutes_roundtrip(self):
        sid = self.session()
        empty = self.client.get(f"/api/sessions/{sid}/minutes")
        self.assertEqual(empty.status_code, 200)
        self.assertEqual(empty.json()["topics"], [])
        with patch.object(self.ai_client, "_post_json", return_value=fake_ai()):
            self.minutes.engine._run(sid, final=True)
        body = self.client.get(f"/api/sessions/{sid}/minutes").json()
        self.assertEqual(len(body["topics"]), 1)
        self.assertEqual(body["todos"][0]["owner"], "发言人 1")
        self.assertIn("state", body)
        # 详情接口带上纪要状态，供页面轮询
        detail = self.client.get(f"/api/sessions/{sid}").json()
        self.assertIn("minutes", detail)
        self.assertGreaterEqual(detail["minutes"]["version"], 1)

    def test_api_regenerate_requires_key(self):
        sid = self.session()
        with patch("ai.keys.get", return_value=None):
            response = self.client.post(f"/api/sessions/{sid}/minutes", json={"mode": "final"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("AI Key", response.json()["detail"])

    def test_api_regenerate_queues_and_rejects_empty_record(self):
        sid = self.session()
        empty = uuid.uuid4().hex[:12]
        self.db.create_session(empty, "空记录", "", source_type="import", kind="meeting")
        response = self.client.post(f"/api/sessions/{empty}/minutes", json={"mode": "final"})
        self.assertEqual(response.status_code, 400)
        response = self.client.post(f"/api/sessions/{sid}/minutes", json={"mode": "final"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["queued"])


if __name__ == "__main__":
    unittest.main()
