"""AI 治理层：限速闸门、重试分档、关思考塑形、反劫持、JSON 模式回退、指标。

不访问网络：把 `ai.client._post_json` 换成假实现。
"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

OK = {"choices": [{"message": {"content": "纪要正文"}}],
      "usage": {"prompt_tokens": 11, "completion_tokens": 7}}


class AILayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-ai-tests-")
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
        cls.client_mod = importlib.import_module("ai.client")
        cls.providers = importlib.import_module("ai.providers")
        cls.gate_mod = importlib.import_module("ai.gate")
        cls.metrics = importlib.import_module("ai.metrics")
        cls.settings = importlib.import_module("settings")
        cls.Failure = cls.client_mod.Failure
        cls.sid = uuid.uuid4().hex[:12]
        cls.db.create_session(cls.sid, "指标记录", "", source_type="import", kind="meeting")

    @classmethod
    def tearDownClass(cls):
        cls.db._conn.close()
        cls.environment.stop()
        cls.data.cleanup()

    def setUp(self):
        self.gate_mod.reset()

    # ---------- 闸门 ----------
    def test_gate_spaces_request_starts(self):
        gate = self.gate_mod.Gate(spacing=0.12)
        started = time.monotonic()
        gate.acquire(2)
        gate.acquire(2)
        self.assertGreaterEqual(time.monotonic() - started, 0.11)
        self.assertEqual(gate.grants, 2)

    def test_gate_prefers_higher_priority_waiter(self):
        gate = self.gate_mod.Gate(spacing=0.05)
        gate.acquire(2)  # 先把"上次开始"占住
        order = []

        def worker(priority, name):
            gate.acquire(priority)
            order.append(name)

        import threading
        low = threading.Thread(target=worker, args=(2, "notes"))
        low.start()
        time.sleep(0.01)
        high = threading.Thread(target=worker, args=(0, "speak"))
        high.start()
        low.join(2)
        high.join(2)
        self.assertEqual(order[0], "speak")

    # ---------- 塑形 ----------
    def test_shape_disables_thinking_per_provider(self):
        mimo = self.providers.resolve({"ai_provider": "mimo"})
        body = self.providers.shape(mimo, {}, 100)
        self.assertEqual(body["reasoning"], {"enabled": False})
        self.assertEqual(body["max_tokens"], 100)
        self.assertEqual(body["temperature"], 0.2)

        openai = self.providers.resolve({"ai_provider": "openai"})
        body = self.providers.shape(openai, {}, 100)
        self.assertEqual(body["reasoning_effort"], "none")
        self.assertEqual(body["max_completion_tokens"], 100)
        self.assertNotIn("max_tokens", body)

    def test_wire_model_prefix_comes_from_env(self):
        # 供应商前缀不再写死在源码里：需要时由 MEETCLIP_AI_MODEL_PREFIX 指定。
        cfg = self.providers.Config(provider="mimo", base="https://gateway.example.test/v1",
                                    model="demo-flash", spacing=0.0, json_mode=True,
                                    thinking="reasoning")
        self.assertEqual(self.providers.wire_model(cfg), "demo-flash")
        self.assertEqual(self.providers.wire_model(cfg, "demo-lite"), "demo-lite")
        with patch.dict(os.environ, {"MEETCLIP_AI_MODEL_PREFIX": "vendor"}):
            self.assertEqual(self.providers.wire_model(cfg), "vendor/demo-flash")
            self.assertEqual(self.providers.wire_model(cfg, "demo-lite"), "vendor/demo-lite")
            self.assertEqual(self.providers.wire_model(cfg, "vendor/demo-pro"), "vendor/demo-pro")
        custom = self.providers.Config(provider="custom", base="https://example.com/v1",
                                       model="gpt-4o", spacing=0.0, json_mode=False, thinking="none")
        self.assertEqual(self.providers.wire_model(custom), "gpt-4o")

    def test_truncated_content_retries_with_bigger_budget(self):
        calls = []

        def fake_post(url, key, body, timeout):
            calls.append(body.get("max_tokens"))
            if len(calls) == 1:
                return {"choices": [{"finish_reason": "length", "message": {"content": None}}]}
            return OK

        with patch.object(self.client_mod, "_post_json", side_effect=fake_post):
            text = self.client_mod.chat("内容", "只返回 JSON。", max_tokens=100, attempts=2)
        self.assertEqual(text, "纪要正文")
        self.assertEqual(calls, [100, 200])

    def test_check_key_accepts_explicit_config_and_key(self):
        captured = {}

        def fake_post(url, key, body, timeout):
            captured["url"] = url
            captured["key"] = key
            captured["model"] = body["model"]
            return OK

        cfg = self.providers.Config(provider="custom", base="https://example.com/v1",
                                    model="gpt-4o", spacing=0.0, json_mode=False, thinking="none")
        with patch.object(self.client_mod, "_post_json", side_effect=fake_post):
            result = self.client_mod.check_key(10.0, config=cfg, key="env-key")
        self.assertTrue(result["ok"])
        self.assertEqual(captured["key"], "env-key")
        self.assertEqual(captured["model"], "gpt-4o")
        self.assertEqual(captured["url"], "https://example.com/v1/chat/completions")

    def test_check_key_uses_wire_model(self):
        previous = self.settings.get("ai_text_model")
        self.settings.update(ai_provider="mimo", ai_base_url="", ai_text_model="demo-flash")
        captured = {}

        def fake_post(url, key, body, timeout):
            captured["body"] = body
            return OK

        try:
            with patch.object(self.client_mod, "_post_json", side_effect=fake_post):
                result = self.client_mod.check_key()
            self.assertTrue(result["ok"])
            self.assertEqual(captured["body"]["model"], "demo-flash")
        finally:
            self.settings.update(ai_text_model=previous or "")

    def test_content_goes_in_system_message(self):
        captured = {}

        def fake_post(url, key, body, timeout):
            captured["body"] = body
            return OK

        with patch.object(self.client_mod, "_post_json", side_effect=fake_post):
            self.client_mod.chat("很长的转写内容", "只返回 JSON。", json_mode=True, role="notes")
        messages = captured["body"]["messages"]
        self.assertEqual(messages[0]["role"], "system")
        self.assertEqual(messages[0]["content"], "很长的转写内容")
        self.assertEqual(messages[1]["content"], "只返回 JSON。")

    # ---------- 失败分类与重试 ----------
    def test_no_key_raises(self):
        with patch("ai.keys.get", return_value=None):
            with self.assertRaises(self.Failure) as ctx:
                self.client_mod.chat("x", "y")
        self.assertEqual(ctx.exception.kind, "no_key")

    def test_rate_limit_retries_for_notes_only(self):
        calls = []

        def flaky(url, key, body, timeout):
            calls.append(1)
            if len(calls) < 3:
                raise self.Failure("rate_limited", status=429)
            return OK

        with patch.object(self.client_mod, "_post_json", side_effect=flaky), \
                patch.object(self.client_mod.time, "sleep", return_value=None):
            self.assertEqual(self.client_mod.chat("x", "y", role="notes", session_id=self.sid), "纪要正文")
            self.assertEqual(len(calls), 3)

        calls.clear()

        def always_429(url, key, body, timeout):
            calls.append(1)
            raise self.Failure("rate_limited", status=429)

        with patch.object(self.client_mod, "_post_json", side_effect=always_429), \
                patch.object(self.client_mod.time, "sleep", return_value=None):
            with self.assertRaises(self.Failure):
                self.client_mod.chat("x", "y", role="speakers")
        self.assertEqual(len(calls), 1)   # 说话人猜名不重试，直接交给上层提示

    def test_hijacked_reply_is_rejected(self):
        hijacked = {"choices": [{"message": {"content": "根据检索结果，这个问题需要看财报。"}}]}
        with patch.object(self.client_mod, "_post_json", return_value=hijacked), \
                patch.object(self.client_mod.time, "sleep", return_value=None):
            with self.assertRaises(self.Failure) as ctx:
                self.client_mod.chat("x", "y", role="speakers", attempts=1)
        self.assertEqual(ctx.exception.kind, "hijacked")

    def test_reasoning_leak_is_stripped(self):
        leaked = {"choices": [{"message": {"content": "先想一想</think>{\"summary\": \"好的\"}"}}]}
        with patch.object(self.client_mod, "_post_json", return_value=leaked):
            text = self.client_mod.chat("x", "y", role="notes")
        self.assertEqual(text, "{\"summary\": \"好的\"}")

    def test_json_mode_falls_back_once_when_gateway_rejects(self):
        bodies = []

        def reject_json(url, key, body, timeout):
            bodies.append("response_format" in body)
            if "response_format" in body:
                raise self.Failure("http", "不支持 response_format", status=400)
            return OK

        with patch.object(self.client_mod, "_post_json", side_effect=reject_json):
            text = self.client_mod.chat("x", "y", json_mode=True, role="notes")
        self.assertEqual(text, "纪要正文")
        self.assertEqual(bodies, [True, False])

    # ---------- 指标 ----------
    def test_metrics_are_numbers_only(self):
        with patch.object(self.client_mod, "_post_json", return_value=OK):
            self.client_mod.chat("SECRET-TRANSCRIPT", "y", role="notes", session_id=self.sid)
        rows = self.metrics.read(self.sid)
        self.assertTrue(rows)
        row = rows[-1]
        self.assertEqual(row["outcome"], "ok")
        self.assertEqual(row["prompt_tokens"], 11)
        # 指标只记数字与枚举：提示词正文不能落进 metrics.jsonl
        self.assertNotIn("SECRET-TRANSCRIPT", json_dump(row))
        summary = self.metrics.summary(self.sid)
        self.assertEqual(summary["calls"], len(rows))
        report = "\n".join(self.metrics.report_lines(self.sid))
        self.assertIn("notes", report)


def json_dump(row) -> str:
    import json
    return json.dumps(row, ensure_ascii=False)


if __name__ == "__main__":
    unittest.main()
