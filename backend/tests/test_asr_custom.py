"""语音转文字的自定义 API：配置解析与保存模式。"""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

from pydantic import SecretStr

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

import asr_engines
from routes import asr_engines as routes


BASE = "https://gateway.example.test/v1"


def data(**extra):
    value = {"asr_provider": "mimo", "mimo_base_url": BASE, "mimo_model": "demo-asr",
             "asr_custom_base": "", "asr_custom_model": ""}
    value.update(extra)
    return value


class CustomConfigTests(unittest.TestCase):
    def test_custom_overrides_default(self):
        with patch.object(asr_engines.settings, "get_all",
                          return_value=data(asr_custom_base="https://custom.example/v1", asr_custom_model="asr-x")):
            config = asr_engines.default_config()
        self.assertEqual(config["base_url"], "https://custom.example/v1")
        self.assertEqual(config["model"], "asr-x")
        self.assertEqual(config["key_account"], asr_engines.ASR_CUSTOM_ACCOUNT)

    def test_without_custom_uses_mimo(self):
        with patch.object(asr_engines.settings, "get_all", return_value=data()):
            config = asr_engines.default_config()
        self.assertEqual(config["base_url"], BASE)
        self.assertNotIn("key_account", config)

    def test_provider_uses_custom_account(self):
        provider = asr_engines.CloudASRProvider({
            "provider": "mimo", "base_url": "https://custom.example/v1", "model": "asr-x",
            "key_account": asr_engines.ASR_CUSTOM_ACCOUNT
        })
        with patch.object(asr_engines, "credential", return_value="k") as credential:
            self.assertTrue(provider.is_ready())
        credential.assert_called_with(asr_engines.ASR_CUSTOM_ACCOUNT)


class RouteModeTests(unittest.TestCase):
    def test_custom_mode_saves_custom_account(self):
        req = routes.EngineSettings(mode="custom", base_url="https://custom.example/v1", model="asr-x",
                                    api_key=SecretStr("secret"))
        with patch.object(routes.engines, "credential") as credential, \
                patch.object(routes.settings, "update") as update, \
                patch.object(routes.engines, "status", return_value={"ok": True}):
            routes.engine_settings(req)
        credential.assert_called_once_with(asr_engines.ASR_CUSTOM_ACCOUNT, value="secret")
        update.assert_called_once_with(asr_custom_base="https://custom.example/v1",
                                       asr_custom_model="asr-x", asr_provider="mimo")

    def test_key_mode_only_saves_key(self):
        req = routes.EngineSettings(mode="key", api_key=SecretStr("secret"))
        with patch.object(routes.engines, "credential") as credential, \
                patch.object(routes.settings, "update") as update, \
                patch.object(routes.engines, "status", return_value={"ok": True}):
            routes.engine_settings(req)
        credential.assert_called_once_with("mimo", value="secret")
        update.assert_not_called()

    def test_mify_mode_clears_custom(self):
        req = routes.EngineSettings(mode="default", base_url=BASE, model="demo-asr")
        with patch.object(routes.engines, "credential"), \
                patch.object(routes.settings, "update") as update, \
                patch.object(routes.engines, "status", return_value={"ok": True}):
            routes.engine_settings(req)
        update.assert_called_once_with(asr_provider="mimo", mimo_base_url=BASE,
                                       mimo_model="demo-asr",
                                       asr_custom_base="", asr_custom_model="")

    def test_probe_uses_unsaved_model_and_key(self):
        req = routes.EngineProbe(base_url=BASE, model="mimo-v2.6-flash", api_key=SecretStr("probe-key"))
        captured = {}

        class FakeProvider:
            capabilities = asr_engines.Capabilities(text_streaming=True)
            def __init__(self, config):
                captured["config"] = config
            def recognize(self, audio, *, language="", on_partial=None):
                captured["audio_len"] = len(audio)
                return type("R", (), {"metrics": {"requests": 1}})()

        with patch.object(routes.engines, "default_config",
                          return_value={"provider": "mimo", "base_url": BASE, "model": "demo-asr"}), \
                patch.dict(routes.engines.PROVIDERS, {"mimo": FakeProvider}):
            result = routes.engine_test(req)
        self.assertTrue(result["ok"])
        self.assertEqual(result["model"], "mimo-v2.6-flash")
        self.assertEqual(captured["config"]["api_key"], "probe-key")
        self.assertEqual(captured["audio_len"], 16000)

    def test_probe_without_key_is_rejected(self):
        req = routes.EngineProbe(base_url=BASE, model="mimo-v2.6-flash")
        with patch.object(routes.engines, "default_config",
                          return_value={"provider": "mimo", "base_url": BASE, "model": "demo-asr"}), \
                patch.object(routes.engines, "credential", return_value=None):
            with self.assertRaises(Exception):
                routes.engine_test(req)

    def test_unknown_mode_rejected(self):
        req = routes.EngineSettings(mode="nope")
        with self.assertRaises(Exception):
            routes.engine_settings(req)


if __name__ == "__main__":
    unittest.main(verbosity=2)
