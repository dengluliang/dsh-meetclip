"""网关模型目录：只读解析与错误文案。"""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

import model_catalog


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


class FakeClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.headers = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, url, headers=None):
        self.headers = headers
        if self.error:
            raise self.error
        return self.response


def factory(response=None, error=None):
    return lambda **kwargs: FakeClient(response, error)


class ModelCatalogTests(unittest.TestCase):
    def test_parses_and_filters_ids(self):
        response = FakeResponse(200, {"data": [
            {"id": "mimo-v2.5-asr"},
            {"id": "gpt-4o"},
            {"id": "gpt-4o"},
            {"id": ""},
            {"id": "x:batch"},
            "not-a-dict"
        ]})
        with patch.object(model_catalog.httpx, "Client", factory(response)):
            models = model_catalog.fetch_models("https://example.com/v1", "sk-test")
        self.assertEqual(models, ["mimo-v2.5-asr", "gpt-4o"])

    def test_invalid_key_message(self):
        with patch.object(model_catalog.httpx, "Client", factory(FakeResponse(401))):
            with self.assertRaises(model_catalog.CatalogError) as ctx:
                model_catalog.fetch_models("https://example.com/v1", "bad")
        self.assertIn("无效", str(ctx.exception))

    def test_network_error_message(self):
        with patch.object(model_catalog.httpx, "Client", factory(error=httpx.ConnectError("boom"))):
            with self.assertRaises(model_catalog.CatalogError) as ctx:
                model_catalog.fetch_models("https://example.com/v1", "sk-test")
        self.assertIn("连不上", str(ctx.exception))

    def test_requires_key_and_https(self):
        with self.assertRaises(model_catalog.CatalogError):
            model_catalog.fetch_models("https://example.com/v1", "")
        with self.assertRaises(model_catalog.CatalogError):
            model_catalog.fetch_models("http://example.com/v1", "sk-test")

    def test_non_json_body(self):
        with patch.object(model_catalog.httpx, "Client", factory(FakeResponse(200, None))):
            with self.assertRaises(model_catalog.CatalogError) as ctx:
                model_catalog.fetch_models("https://example.com/v1", "sk-test")
        self.assertIn("模型列表", str(ctx.exception))

    def test_qualifies_models_with_owned_by(self):
        """网关要求「供应商/模型名」，目录却给裸 id：这里统一补好再交给界面保存。"""
        response = FakeResponse(200, {"data": [
            {"id": "mimo-v2.5-asr", "owned_by": "xiaomi"},
            {"id": "deepseek-v4-flash", "owned_by": "deepseek"},
            # 同一个 id 由不同供应商提供时，两条都要留下，否则会丢掉可用的那条。
            {"id": "deepseek-v4-flash", "owned_by": "volcengine_maas"},
            {"id": "anthropic/claude-sonnet-5-5", "owned_by": "ppio"},
            {"id": "plain-model"},
        ]})
        with patch.object(model_catalog.httpx, "Client", factory(response)):
            entries = model_catalog.fetch_entries("https://example.com/v1", "sk-test")
        self.assertEqual([entry["wire"] for entry in entries], [
            "xiaomi/mimo-v2.5-asr",
            "deepseek/deepseek-v4-flash",
            "volcengine_maas/deepseek-v4-flash",
            # 已经带供应商的名字不再拼接。
            "anthropic/claude-sonnet-5-5",
            # 没有 owned_by 的保持裸名。
            "plain-model",
        ])
        self.assertEqual(entries[0]["vendor"], "xiaomi")
        self.assertEqual(entries[0]["id"], "mimo-v2.5-asr")

    def test_qualify_helper_rules(self):
        self.assertEqual(model_catalog.qualify("mimo-v2.5-asr", "xiaomi"), "xiaomi/mimo-v2.5-asr")
        self.assertEqual(model_catalog.qualify("xiaomi/mimo-v2.5-asr", "xiaomi"), "xiaomi/mimo-v2.5-asr")
        self.assertEqual(model_catalog.qualify("plain", ""), "plain")
        self.assertEqual(model_catalog.qualify("", "xiaomi"), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
