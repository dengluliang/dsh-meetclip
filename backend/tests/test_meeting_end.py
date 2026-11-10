"""自动结束：状态机（询问/直接停/一句没说/继续记录）与采集侧的收尾钩子。"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch


class MeetingEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-end-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.module = importlib.import_module("meeting_end")

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.data.cleanup()

    def watch(self, **kw):
        # 静音下限是 30 秒（防止把半小时的会切成碎片），测试用 40 秒 + 20 秒倒计时。
        options = dict(mode="prompt", silence_after=40.0, countdown=20.0, start=0.0)
        options.update(kw)
        return self.module.MeetingEndWatch(**options)

    def test_prompt_then_end(self):
        watch = self.watch()
        self.assertIsNone(watch.tick(now=5, said=True))
        self.assertEqual(watch.tick(now=41, said=True), "prompt")
        self.assertIsNotNone(watch.deadline())
        self.assertIsNone(watch.tick(now=50, said=True))
        self.assertEqual(watch.tick(now=62, said=True), "end")

    def test_speech_cancels_prompt(self):
        watch = self.watch()
        watch.tick(now=41, said=True)
        watch.heard(now=45)
        self.assertIsNone(watch.tick(now=55, said=True))
        self.assertIsNone(watch.deadline())

    def test_end_mode_stops_at_once(self):
        watch = self.watch(mode="end")
        self.assertEqual(watch.tick(now=41, said=True), "end")

    def test_off_never_ends(self):
        watch = self.watch(mode="off")
        self.assertIsNone(watch.tick(now=10_000, said=True))

    def test_nobody_spoke_stops_quietly(self):
        watch = self.watch()
        self.assertIsNone(watch.tick(now=5, said=False))
        self.assertEqual(watch.tick(now=41, said=False), "nobody_spoke")

    def test_keep_going_restarts_silence(self):
        watch = self.watch()
        watch.tick(now=41, said=True)
        watch.keep_going(now=42)
        self.assertIsNone(watch.tick(now=50, said=True))
        self.assertEqual(watch.tick(now=83, said=True), "prompt")

    def test_silence_floor(self):
        watch = self.module.MeetingEndWatch(mode="prompt", silence_after=1, countdown=1)
        self.assertGreaterEqual(watch.silence_after, 30.0)
        self.assertGreaterEqual(watch.countdown, 10.0)

    # ---------- 采集侧钩子 ----------
    def test_capture_trim_and_keep_going(self):
        database = self.database
        sid = uuid.uuid4().hex[:12]
        database.db.create_session(sid, "直播", "", source_type="bilibili", kind="live")
        capture = importlib.import_module("capture")
        with patch.object(database.db, "update_meta", return_value={}):
            task = capture.CaptureTask(sid, url="https://live.bilibili.com/1")
        task.media_time = 600.0
        task.end_trim = None
        self.assertEqual(task._trimmed_duration(), 600.0)
        task.end_trim = 120.0
        self.assertEqual(task._trimmed_duration(), 122.0)   # 留两秒余量
        task.end_trim = 597.0                              # 离结尾太近就不裁
        self.assertEqual(task._trimmed_duration(), 600.0)

        task.capturing = False                             # 没在采集时不该起看门狗
        task.start_end_watch()
        self.assertIsNone(task._eos_watch)
        task.capturing = True
        with patch.object(capture.settings, "get", side_effect=lambda key, default=None: {
                "auto_end_silence": "prompt", "auto_end_after": 600}[key]):
            task.start_end_watch()
        self.assertIsNotNone(task._eos_watch)
        task.keep_going()
        self.assertIsNone(task._eos_watch.pending_deadline)


if __name__ == "__main__":
    unittest.main()
