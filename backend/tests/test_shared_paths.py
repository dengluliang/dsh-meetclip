"""多资料空间：共享目录里的账号与通用设置。

不碰真实资料库：每个用例都在临时目录里起一个子进程，只验证「变量指到哪儿」。
子进程隔离是必要的——settings 模块在 import 时就定下了 PATH。
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

APP_PKG = Path(__file__).resolve().parents[1] / "app"

PROBE = textwrap.dedent(
    """
    import json
    import shared_paths
    import settings, bilibili, douyin
    print("PROBE" + json.dumps({
        "shared_dir": str(shared_paths.SHARED_DIR),
        "using_shared": shared_paths.using_shared_dir(),
        "settings": str(settings.PATH),
        "bili": str(bilibili.COOKIE_FILE),
        "douyin": str(douyin.COOKIE_FILE),
    }))
    """
)


def run_script(script, data_dir, shared=None):
    env = dict(os.environ)
    env["ZHIBO_DATA_DIR"] = str(data_dir)
    env["PYTHONPATH"] = str(APP_PKG)
    env.pop("MEETCLIP_SHARED_DIR", None)
    if shared is not None:
        env["MEETCLIP_SHARED_DIR"] = str(shared)
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise AssertionError(result.stderr.strip()[-800:])
    for line in result.stdout.splitlines():
        if line.startswith("PROBE"):
            return json.loads(line[len("PROBE"):])
    raise AssertionError(f"没有探测输出：{result.stdout!r}")


class SharedPathsTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix="meetclip-shared-")
        self.data_dir = Path(self.root.name) / "data"
        self.shared_dir = Path(self.root.name) / "shared"

    def tearDown(self):
        self.root.cleanup()

    def test_without_shared_dir_falls_back_to_data_dir(self):
        payload = run_script(PROBE, self.data_dir)
        self.assertFalse(payload["using_shared"])
        self.assertEqual(payload["shared_dir"], str(self.data_dir))
        self.assertEqual(payload["settings"], str(self.data_dir / "settings.json"))
        self.assertEqual(payload["bili"], str(self.data_dir / "bili_cookies.txt"))
        self.assertEqual(payload["douyin"], str(self.data_dir / "douyin_cookies.txt"))

    def test_shared_dir_moves_accounts_and_settings(self):
        payload = run_script(PROBE, self.data_dir, shared=self.shared_dir)
        self.assertTrue(payload["using_shared"])
        self.assertEqual(payload["shared_dir"], str(self.shared_dir))
        self.assertEqual(payload["settings"], str(self.shared_dir / "settings.json"))
        self.assertEqual(payload["bili"], str(self.shared_dir / "bili_cookies.txt"))
        self.assertEqual(payload["douyin"], str(self.shared_dir / "douyin_cookies.txt"))

    def test_settings_round_trip_in_shared_dir(self):
        script = textwrap.dedent(
            """
            import json
            import settings
            settings.update(shot_sensitivity=0.42)
            print("PROBE" + json.dumps({"path": str(settings.PATH),
                                        "value": settings.get("shot_sensitivity")}))
            """
        )
        payload = run_script(script, self.data_dir, shared=self.shared_dir)
        self.assertEqual(payload["path"], str(self.shared_dir / "settings.json"))
        self.assertEqual(payload["value"], 0.42)
        stored = json.loads((self.shared_dir / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["shot_sensitivity"], 0.42)
        # 数据目录里不该再留一份设置
        self.assertFalse((self.data_dir / "settings.json").exists())


if __name__ == "__main__":
    unittest.main()
