"""平台错误分类：主文案必须可执行，原始错误只进 detail。"""
import importlib
import sys
import unittest
from pathlib import Path


class PlatformErrorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.errors = importlib.import_module("platform_errors")

    def test_bilibili_login_is_actionable(self):
        result = self.errors.classify_failure(
            "bilibili", "ERROR: [BiliBili] 123: This video is for premium members only")
        self.assertEqual(result["status"], "login_required")
        self.assertEqual(result["code"], "login_required")
        self.assertIn("扫码登录 B站", result["message"])
        self.assertEqual(result["action"]["id"], "bilibili_login")
        self.assertIn("premium", result["detail"])
        self.assertNotIn("ERROR:", result["message"])

    def test_douyin_login_has_no_fresh_cookies_jargon(self):
        result = self.errors.classify_failure(
            "douyin", "ERROR: [Douyin] Fresh cookies (not necessarily logged in) are needed")
        self.assertEqual(result["status"], "login_required")
        self.assertNotIn("Fresh cookies", result["message"])
        self.assertIn("读取登录状态", result["message"])

    def test_missing_bvid_is_invalid_not_login(self):
        result = self.errors.classify_failure(
            "bilibili", "ERROR: 1zzzzzzzzz: An extractor error has occurred. (caused by KeyError('bvid'))")
        self.assertEqual(result["status"], "invalid")
        self.assertIn("链接无效", result["message"])

    def test_503_is_network_not_invalid(self):
        result = self.errors.classify_failure("youtube", "ERROR: HTTP Error 503: Service Unavailable")
        self.assertEqual(result["status"], "unreachable")
        self.assertIn("连不上平台", result["message"])

    def test_x_no_video_keeps_clear_message(self):
        result = self.errors.classify_failure("x", "ERROR: No video could be found in this tweet")
        self.assertEqual(result["status"], "error")
        self.assertIn("没有可采集的视频", result["message"])

    def test_browser_cookie_permission_has_exact_next_step(self):
        result = self.errors.classify_failure(
            "bilibili", 'ERROR: could not find chrome cookies database in "/missing/Chrome"')
        self.assertEqual(result["status"], "login_required")
        self.assertIn("选择已登录的浏览器", result["message"])

    def test_live_api_block_is_friendly(self):
        result = self.errors.classify_live_api_failure(-352, "request blocked")
        self.assertEqual(result["status"], "unreachable")
        self.assertIn("稍后重试", result["message"])
        self.assertIn("-352", result["detail"])


if __name__ == "__main__":
    unittest.main()
