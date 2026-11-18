"""采集组件安装：yt-dlp 复用独立环境、ffmpeg 走镜像直下并逐个源降级。"""
import gzip
import io
import os
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1] / "app"
if str(APP) not in sys.path:
    sys.path.insert(0, str(APP))


def _stub_capture():
    """deps.py 只用到 capture.DEPS / refresh_deps，用桩替掉，避免拉 numpy 等重依赖。"""
    module = types.ModuleType("capture")
    module.DEPS = {}
    module.refresh_deps = lambda: None
    return module


sys.modules.setdefault("capture", _stub_capture())

import deps  # noqa: E402


class BinarySourceTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("MEETCLIP_FFMPEG_MIRROR", None)
        os.environ.pop("MEETCLIP_FFPROBE_MIRROR", None)

    def test_arm64先试国内静态构建(self):
        with patch.object(deps, "_machine", return_value="arm64"):
            sources = deps.binary_sources("ffmpeg")
        self.assertEqual(sources[0][0], "https://www.osxexperts.net/ffmpeg7arm.zip")
        self.assertEqual(sources[0][1], "zip")
        self.assertEqual(sources[0][2], "ffmpeg")

    def test_intel换对应静态构建(self):
        with patch.object(deps, "_machine", return_value="x86_64"):
            sources = deps.binary_sources("ffmpeg")
        self.assertIn("ffmpeg7intel.zip", sources[0][0])
        self.assertTrue(any("ffmpeg-darwin-x64.gz" in row[0] for row in sources))

    def test_环境变量指定的源排在最前(self):
        with patch.dict(os.environ, {"MEETCLIP_FFMPEG_MIRROR": "https://mirror.internal/ffmpeg.zip"}):
            sources = deps.binary_sources("ffmpeg")
        self.assertEqual(sources[0][0], "https://mirror.internal/ffmpeg.zip")
        self.assertEqual(sources[0][1], "zip")

    def test_ffprobe不依赖GitHub(self):
        with patch.object(deps, "_machine", return_value="arm64"):
            sources = deps.binary_sources("ffprobe")
        self.assertEqual(sources[0][0], "https://www.osxexperts.net/ffprobe7arm.zip")
        self.assertFalse(any("github.com" in row[0] for row in sources))

    def test_按后缀判断压缩方式(self):
        self.assertEqual(deps._infer_kind("https://x/ffmpeg.zip"), "zip")
        self.assertEqual(deps._infer_kind("https://x/ffmpeg.zip?token=1"), "zip")
        self.assertEqual(deps._infer_kind("https://x/ffmpeg-darwin-arm64.gz"), "gz")


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="meetclip-deps-tests-")
        self.root = Path(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def test_从zip里取出同名的二进制(self):
        archive = self.root / "ffmpeg.zip"
        payload = b"#!/bin/sh\necho fake ffmpeg\n"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("readme.txt", "ignore")
            zf.writestr("nested/ffmpeg", payload)
        out = self.root / "bin" / "ffmpeg"
        out.parent.mkdir()
        deps._extract(archive, "zip", "ffmpeg", out)
        self.assertEqual(out.read_bytes(), payload)
        self.assertTrue(os.access(out, os.X_OK))

    def test_从gz里解出单个二进制(self):
        archive = self.root / "ffmpeg.gz"
        payload = b"#!/bin/sh\necho gz ffmpeg\n"
        archive.write_bytes(gzip.compress(payload))
        out = self.root / "ffmpeg"
        deps._extract(archive, "gz", "ffmpeg", out)
        self.assertEqual(out.read_bytes(), payload)
        self.assertTrue(os.access(out, os.X_OK))

    def test_zip里没有成员时明确报错(self):
        archive = self.root / "empty.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("other", b"x")
        with self.assertRaises(RuntimeError):
            deps._extract(archive, "zip", "ffmpeg", self.root / "ffmpeg")

    def test_版本号探测返回值与错误(self):
        good = self.root / "good"
        good.write_text("#!/bin/sh\necho ffmpeg version 7.0\n")
        os.chmod(good, 0o755)
        first, error = deps.verify(good)
        self.assertEqual(first, "ffmpeg version 7.0")
        self.assertEqual(error, "")
        first, error = deps.verify(self.root / "missing")
        self.assertEqual(first, "")
        self.assertNotEqual(error, "")


class InstallFlowTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(prefix="meetclip-deps-flow-")
        self.root = Path(self.dir.name)
        self.bin_dir = self.root / "state" / "bin"
        self.bin_dir.mkdir(parents=True)
        deps.capture.DEPS = {}

    def tearDown(self):
        deps.capture.DEPS = {}
        self.dir.cleanup()

    def test_ytdlp用独立环境里的脚本建软链(self):
        venv_bin = self.root / "venv" / "bin"
        venv_bin.mkdir(parents=True)
        script = venv_bin / "yt-dlp"
        script.write_text("#!/bin/sh\necho 2026.08.19\n")
        os.chmod(script, 0o755)
        with patch.object(deps.sys, "executable", str(venv_bin / "python")):
            path = deps.install_ytdlp(self.bin_dir)
        self.assertEqual(Path(path), self.bin_dir / "yt-dlp")
        self.assertEqual(os.path.realpath(self.bin_dir / "yt-dlp"), os.path.realpath(script))

    def test_已有可用的ffmpeg时不重复下载(self):
        deps.capture.DEPS = {"ffmpeg": "/usr/bin/true"}
        with patch.object(deps, "_download") as download:
            path = deps.install_binary("ffmpeg", self.bin_dir)
        self.assertEqual(path, "/usr/bin/true")
        download.assert_not_called()

    def test_首个源失败后自动换下一个源(self):
        calls = []

        def fake_download(url, dest, label):
            calls.append(url)
            if "first" in url:
                raise RuntimeError("连接被重置")
            dest.write_bytes(gzip.compress(b"#!/bin/sh\necho fake ffmpeg\n"))
            return 1024

        sources = [("https://first/ffmpeg.gz", "gz", "ffmpeg"),
                   ("https://second/ffmpeg.gz", "gz", "ffmpeg")]
        with patch.object(deps, "binary_sources", return_value=sources), \
                patch.object(deps, "_download", side_effect=fake_download), \
                patch.object(deps, "verify", return_value=("ffmpeg version 7.0", "")):
            path = deps.install_binary("ffmpeg", self.bin_dir)
        self.assertEqual(Path(path), self.bin_dir / "ffmpeg")
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[1].startswith("https://second"))

    def test_全部源失败且无brew时报可读错误(self):
        with patch.object(deps, "binary_sources", return_value=[("https://only/ffmpeg.gz", "gz", "ffmpeg")]), \
                patch.object(deps, "_download", side_effect=RuntimeError("超时")), \
                patch.object(deps, "install_imageio_ffmpeg", return_value=None):
            with self.assertRaises(RuntimeError) as ctx:
                deps.install_binary("ffmpeg", self.bin_dir)
        self.assertIn("ffmpeg 安装失败", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
