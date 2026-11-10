"""抖音登录态：浏览器 Cookie 导入、状态与清除；不访问浏览器或网络。"""
import http.cookiejar
import importlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


def cookie(name, domain, value="value"):
    return http.cookiejar.Cookie(
        0, name, value, None, False, domain, True, domain.startswith("."), "/", True,
        False, int(time.time()) + 3600, False, None, None, {},
    )


class DouyinTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-douyin-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件")
        cls.douyin = importlib.import_module("douyin")
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        from fastapi.testclient import TestClient
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": cls.auth.API_TOKEN})

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.database.db._conn.close()
        cls.environment.stop()
        cls.data.cleanup()

    def setUp(self):
        self.douyin.COOKIE_FILE.unlink(missing_ok=True)

    def jar(self):
        jar = http.cookiejar.MozillaCookieJar()
        jar.set_cookie(cookie("s_v_web_id", ".douyin.com"))
        jar.set_cookie(cookie("ttwid", ".douyin.com"))
        jar.set_cookie(cookie("odin_tt", ".iesdouyin.com"))
        jar.set_cookie(cookie("noise", ".example.com"))
        return jar

    def test_import_filters_domains_and_writes_private_file(self):
        with patch("yt_dlp.cookies.extract_cookies_from_browser", return_value=self.jar()):
            response = self.client.post("/api/douyin/import", json={"browser": "chrome"})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["count"], 3)
        self.assertTrue(self.douyin.COOKIE_FILE.is_file())
        mode = stat.S_IMODE(self.douyin.COOKIE_FILE.stat().st_mode)
        self.assertEqual(mode, 0o600)
        text = self.douyin.COOKIE_FILE.read_text()
        self.assertIn("s_v_web_id", text)
        self.assertIn("douyin.com", text)
        self.assertNotIn("example.com", text)
        status = self.client.get("/api/douyin/status").json()
        self.assertTrue(status["saved"])
        self.assertEqual(status["count"], 3)

    def test_import_without_douyin_cookies_reports_login(self):
        jar = http.cookiejar.MozillaCookieJar()
        jar.set_cookie(cookie("noise", ".example.com"))
        with patch("yt_dlp.cookies.extract_cookies_from_browser", return_value=jar):
            response = self.client.post("/api/douyin/import", json={})
        self.assertEqual(response.status_code, 502)
        self.assertIn("没有抖音 Cookie", response.json()["detail"])
        self.assertFalse(self.douyin.COOKIE_FILE.exists())

    def test_import_reports_macos_permission_error(self):
        with patch("yt_dlp.cookies.extract_cookies_from_browser",
                   side_effect=FileNotFoundError('could not find chrome cookies database in "/x"')):
            response = self.client.post("/api/douyin/import", json={})
        self.assertEqual(response.status_code, 502)
        self.assertIn("完全磁盘访问权限", response.json()["detail"])
        self.assertFalse(self.douyin.COOKIE_FILE.exists())

    def test_open_permission_opens_system_settings(self):
        with patch.object(self.douyin.subprocess, "Popen") as popen:
            response = self.client.post("/api/douyin/permission")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["url"], self.douyin.PERMISSION_URL)
        self.assertEqual(popen.call_args.args[0][0], "open")
        self.assertEqual(popen.call_args.args[0][1], self.douyin.PERMISSION_URL)


    def test_share_info_parses_router_data(self):
        payload = {
            "loaderData": {
                "video_(id)/page": {
                    "videoInfoRes": {
                        "item_list": [{
                            "aweme_id": "123",
                            "desc": "测试视频",
                            "author": {"nickname": "测试作者"},
                            "video": {
                                "duration": 125000,
                                "width": 1080,
                                "height": 1920,
                                "play_addr": {
                                    "uri": "v0300test",
                                    "url_list": ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0300test"],
                                },
                                "cover": {"url_list": ["https://p3.douyinpic.com/cover.jpeg"]},
                            },
                        }],
                    },
                },
            },
        }
        html = "<script>window._ROUTER_DATA = " + json.dumps(payload) + "</script>"
        with patch.object(self.douyin, "_http_get", return_value=html):
            data = self.douyin.share_info("https://www.douyin.com/video/123")
        self.assertEqual(data["aweme_id"], "123")
        self.assertEqual(data["title"], "测试视频")
        self.assertEqual(data["uploader"], "测试作者")
        self.assertAlmostEqual(data["duration"], 125.0)
        self.assertIn("video_id=v0300test", data["play_url"])
        self.assertEqual(data["thumbnail"], "https://p3.douyinpic.com/cover.jpeg")

    def test_share_info_requires_video_data(self):
        with patch.object(self.douyin, "_http_get", return_value="<html></html>"):
            with self.assertRaises(RuntimeError) as ctx:
                self.douyin.share_info("https://www.douyin.com/video/123")
        self.assertIn("Cookie", str(ctx.exception))

    def test_logout_clears_file(self):
        with patch("yt_dlp.cookies.extract_cookies_from_browser", return_value=self.jar()):
            self.client.post("/api/douyin/import", json={})
        response = self.client.post("/api/douyin/logout")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(self.douyin.COOKIE_FILE.exists())
        self.assertEqual(self.client.get("/api/douyin/status").json()["count"], 0)

    def test_open_login_uses_fixed_url_and_selected_browser(self):
        with patch.object(self.douyin.subprocess, "Popen") as popen, \
                patch.object(self.douyin.sys, "platform", "darwin"), \
                patch.object(self.douyin.settings, "get_all", return_value={"link_cookie_browser": "chrome"}):
            response = self.client.post("/api/douyin/open")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["url"], self.douyin.LOGIN_URL)
        args = popen.call_args.args[0]
        self.assertEqual(args[0], "open")
        self.assertEqual(args[1], "-a")
        self.assertEqual(args[2], "Google Chrome")
        self.assertEqual(args[3], self.douyin.LOGIN_URL)

    def test_test_endpoint_without_url_returns_clear_error(self):
        response = self.client.post("/api/douyin/test", json={})
        self.assertEqual(response.status_code, 400)
        self.assertIn("抖音链接", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
