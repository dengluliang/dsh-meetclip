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


if __name__ == "__main__":
    unittest.main(verbosity=2)
