"""直播断流自动续录：分段、重连决策、拼接与续录。

运行：MEETCLIP_TEST_PYTHON=~/.dsh/meetclip/venv/bin/python backend/tests/run-all.sh
本文件单独跑：
  cd dsh-meetclip/backend && ZHIBO_DATA_DIR=$(mktemp -d) ../.venv/bin/python -m tests.test_live_reconnect

不访问网络：取流/开播状态全部替换成假实现；媒体用 ffmpeg 现场生成的 1 秒小片段。
"""
import importlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid


def make_clip(path, seconds=1.0, size="320x240"):
    """生成一段可解析的 h264+aac mpegts 片段（不出网）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=black:s={size}:d={seconds}:r=10",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", "-f", "mpegts", str(path),
    ], capture_output=True)
    if r.returncode != 0 or not path.exists():
        raise unittest.SkipTest("本机 ffmpeg 无法生成测试片段：" + (r.stderr or b"").decode(errors="ignore")[-200:])
    return path


class LiveReconnectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-live-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        cls.settings = importlib.import_module("settings")
        cls.capture = importlib.import_module("capture")
        cls.db = cls.database.db
        cls.settings.update(live_reconnect=True, live_stall_seconds=45, live_refresh_minutes=40)

    @classmethod
    def tearDownClass(cls):
        cls.db._conn.close()
        cls.environment.stop()
        cls.data.cleanup()

    def new_task(self, title="测试直播"):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, title, "https://live.bilibili.com/3373007")
        self.db.update_session(sid, status="done")
        d = self.database.session_dir(sid)
        return self.capture.CaptureTask(sid, url="https://live.bilibili.com/3373007"), d

    # ---------- 基础工具 ----------
    def test_probe_duration_and_spec(self):
        with tempfile.TemporaryDirectory() as tmp:
            clip = make_clip(Path(tmp) / "a.ts", 1.0)
            self.assertAlmostEqual(self.capture.probe_duration(clip), 1.0, delta=0.35)
            spec = self.capture.probe_spec(clip)
            self.assertEqual(spec["video"]["codec_name"], "h264")
            self.assertEqual(spec["audio"]["codec_name"], "aac")

    def test_concat_media_joins_parts(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            a = make_clip(tmp / "a.ts", 1.0)
            b = make_clip(tmp / "b.ts", 1.0)
            out = tmp / "all.ts"
            self.assertTrue(self.capture.concat_media([a, b], out))
            self.assertAlmostEqual(self.capture.probe_duration(out), 2.0, delta=0.5)

    def test_concat_media_rejects_missing_part(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            a = make_clip(tmp / "a.ts", 1.0)
            self.assertFalse(self.capture.concat_media([a, tmp / "missing.ts"], tmp / "all.ts"))
            self.assertFalse((tmp / "all.ts").exists())

    def test_url_expiry_from_signed_url(self):
        url = "https://x.bilivideo.com/live.flv?expires=1795599218&len=0&sig=abc"
        self.assertEqual(self.capture._url_expiry(url), 1795599218.0)
        self.assertIsNone(self.capture._url_expiry("https://x.bilivideo.com/live.flv"))

    # ---------- 重连决策 ----------
    def test_stream_live_status(self):
        task, _ = self.new_task()
        with patch.object(self.capture, "check_bilibili_live", return_value={"status": "live"}):
            self.assertTrue(task._stream_live())
        with patch.object(self.capture, "check_bilibili_live", return_value={"status": "not_started"}):
            self.assertFalse(task._stream_live())
        with patch.object(self.capture, "check_bilibili_live", return_value={"status": "unreachable"}):
            self.assertTrue(task._stream_live())

    def test_live_capture_reconnects_into_new_part(self):
        task, d = self.new_task()
        calls = {"n": 0}

        def fake_resolve():
            return "https://example.invalid/live.flv?expires=9999999999", "原画"

        def fake_pipeline(src, out_path, has_v, has_a, realtime, hls_dir=None, hls_append=False):
            calls["n"] += 1
            out_path.write_bytes(b"0" * 4096)
            self.assertEqual(hls_append, calls["n"] > 1)
            task._done_duration_marker = calls["n"]
            if calls["n"] == 1:
                task.media_time = 5.0
                task._part_reason = "exit"      # 流被中断
            else:
                task.media_time = 10.0
                task.stop_flag.set()            # 第二次录完，用户停止
                task._part_reason = "stop"

        with patch.object(task, "_resolve_stream", side_effect=fake_resolve), \
                patch.object(task, "_pipeline", side_effect=fake_pipeline), \
                patch.object(task, "_stream_live", return_value=True):
            parts, existing = task._live_capture(d)

        self.assertEqual([p.name for p in parts], ["media.ts", "media.part02.ts"])
        self.assertIsNone(existing)
        self.assertEqual(len(task.reconnects), 1)
        self.assertEqual(task.reconnects[0]["reason"], "exit")
        self.assertAlmostEqual(task._done_duration, 10.0, delta=0.1)
        self.assertTrue((d / "media.ts").exists() and (d / "media.part02.ts").exists())

    def test_live_capture_stops_when_stream_ended(self):
        task, d = self.new_task()
        task.stop_flag = threading.Event()
        with patch.object(task, "_resolve_stream", return_value=("u", "原画")), \
                patch.object(task, "_pipeline") as pipeline, \
                patch.object(task, "_stream_live", return_value=False):
            parts, _ = task._live_capture(d)
        self.assertEqual(parts, [])
        pipeline.assert_not_called()

    def test_live_capture_single_part_when_reconnect_disabled(self):
        self.settings.update(live_reconnect=False)
        try:
            task, d = self.new_task()

            def fake_pipeline(src, out_path, has_v, has_a, realtime, hls_dir=None, hls_append=False):
                out_path.write_bytes(b"0" * 2048)
                task.media_time = 3.0
                task._part_reason = "exit"

            with patch.object(task, "_resolve_stream", return_value=("u", "原画")), \
                    patch.object(task, "_pipeline", side_effect=fake_pipeline), \
                    patch.object(task, "_stream_live", return_value=True):
                parts, _ = task._live_capture(d)
            self.assertEqual(len(parts), 1)
            self.assertEqual(task.reconnects, [])
        finally:
            self.settings.update(live_reconnect=True)

    # ---------- 拼接与续录 ----------
    def test_finalize_live_concats_parts_and_remuxes(self):
        task, d = self.new_task()
        a = make_clip(d / "media.ts", 1.0)
        b = make_clip(d / "media.part02.ts", 1.0)
        task.media_time = 2.0
        task.audio_time = 2.0
        task._finalize_live(d, [a, b], None)
        sess = self.db.get_session(task.sid)
        self.assertEqual(sess["media_path"], "media.mp4")
        self.assertAlmostEqual(self.capture.probe_duration(d / "media.mp4"), 2.0, delta=0.6)
        self.assertFalse(a.exists() and b.exists())

    def test_finalize_live_keeps_parts_when_concat_fails(self):
        task, d = self.new_task()
        good = make_clip(d / "media.ts", 1.0)
        bad = d / "media.part02.ts"
        bad.write_bytes(b"not a video")
        task.media_time = 2.0
        task._finalize_live(d, [good, bad], None)
        sess = self.db.get_session(task.sid)
        self.assertTrue(bad.exists(), "拼接失败必须保留原始分段")
        self.assertIn(sess["media_path"], ("media.ts", "media.mp4"))

    def test_resume_appends_to_existing_media(self):
        task, d = self.new_task()
        task.resume = True
        base = make_clip(d / "media.mp4", 1.0)
        self.db.update_session(task.sid, media_path="media.mp4")
        task.media_time = 2.0
        task.audio_time = 2.0
        extra = make_clip(d / "media.resume01.ts", 1.0)
        task._finalize_live(d, [extra], base)
        sess = self.db.get_session(task.sid)
        self.assertEqual(sess["media_path"], "media.mp4")
        self.assertAlmostEqual(self.capture.probe_duration(d / "media.mp4"), 2.0, delta=0.6)
        self.assertFalse(extra.exists())

    def test_force_reconnect_only_while_recording(self):
        task, _ = self.new_task()
        task.capturing = False
        self.assertFalse(task.force_reconnect())
        task.capturing = True
        self.assertTrue(task.force_reconnect())
        self.assertTrue(task._force_reconnect.is_set())

    def test_stall_limit_reads_setting(self):
        self.settings.update(live_stall_seconds=60)
        try:
            task, _ = self.new_task()
            self.assertEqual(task._stall_limit, 60.0)
        finally:
            self.settings.update(live_stall_seconds=45)

    def test_part_deadline_uses_url_expiry(self):
        task, _ = self.new_task()
        expires = time.time() + 5 * 60
        task._url_expires = expires
        deadline = task._part_deadline()
        self.assertIsNotNone(deadline)
        self.assertLessEqual(deadline, expires - 120, "取流地址到期前 3 分钟就要换段")
        task._url_expires = time.time() + 2 * 60
        self.assertIsNone(task._part_deadline(), "地址 2 分钟后到期时来不及录，应该立刻换段")

    def test_capture_log_written(self):
        task, d = self.new_task()
        task._log("unit_test", note="hello")
        text = (d / "capture.log").read_text(encoding="utf-8")
        self.assertIn("unit_test", text)
        self.assertIn("hello", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
