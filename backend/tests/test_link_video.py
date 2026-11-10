"""链接视频访问、三条批量队列与原记录重试；临时目录、模拟下载，不访问网络或模型。"""
import importlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
from contextlib import ExitStack
import threading


class LinkVideoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-link-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件")
        cls.db = cls.database.db
        cls.link = importlib.import_module("link_video")
        cls.scheduler = importlib.import_module("scheduler")
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        from fastapi.testclient import TestClient
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": cls.auth.API_TOKEN})

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.db._conn.close()
        cls.environment.stop()
        cls.data.cleanup()

    def setUp(self):
        for row in self.db.list_sessions():
            self.db.delete_session(row["id"])
        self.queue = self.link.LinkQueueManager()
        self.patches = [
            patch.object(self.link, "manager", self.queue),
            patch.dict(self.link.capture.DEPS, {"yt_dlp": "fake-yt-dlp"}),
            # 这些用例模拟命令行 yt-dlp 的输出；进程内读取另有专门测试。
            patch.object(self.link, "_has_module", return_value=False),
            patch.object(self.link, "_disk_ok", return_value=True),
        ]
        for p in self.patches:
            p.start()
        self.link._preview_cache.clear()
        self.link.settings.update(link_browser_cookies=True, link_cookie_browser="chrome")
        self.info_calls = []
        self.download_calls = []
        self.fail_urls = set()

    def tearDown(self):
        self.queue.shutdown(timeout=3)
        for p in reversed(self.patches):
            p.stop()
        self.assertIsNone(self.scheduler.owner())

    def result(self, error=""):
        return SimpleNamespace(returncode=1 if error else 0, stderr=error,
                               stdout="" if error else json.dumps({"title": "测试视频", "duration": 60}))

    def public_info(self, cmd, **_kwargs):
        self.info_calls.append(cmd)
        if "--cookies-from-browser" in cmd:
            return self.result('ERROR: could not find chrome cookies database in "/missing/Chrome"')
        if cmd[-1] in self.fail_urls:
            return self.result("ERROR: HTTP Error 503: Service Unavailable")
        return self.result()

    def public_download(self, cmd, **_kwargs):
        self.download_calls.append(cmd)
        if "--cookies-from-browser" in cmd:
            error = 'ERROR: could not find chrome cookies database in "/missing/Chrome"'
        elif cmd[-1] in self.fail_urls:
            error = "ERROR: HTTP Error 503: Service Unavailable"
        else:
            error = ""
            target = Path(cmd[cmd.index("-o") + 1].replace("%(ext)s", "mp4"))
            target.write_bytes(b"fake-video" * 256)
        return SimpleNamespace(stdout=io.StringIO(error or "[download] 100%\n"),
                               wait=lambda: 1 if error else 0)

    def new_job(self, url):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, "测试视频", url, source_type="link", kind="link_video")
        self.db.create_link_job(sid, self.db.next_link_queue_order())
        return sid

    def wait_states(self, expected):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            states = {sid: self.db.get_session(sid)["status"] for sid in expected}
            if states == expected:
                return
            time.sleep(0.02)
        self.assertEqual(states, expected)

    def test_public_metadata_ignores_missing_browser_and_normalizes_url(self):
        with patch.object(self.link.subprocess, "run", side_effect=self.public_info):
            result = self.link.preview("bilibili.com/video/BV123/?tracking=unused")
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(self.info_calls), 1)
        cmd = self.info_calls[0]
        self.assertEqual(cmd[-1], "https://bilibili.com/video/BV123")
        self.assertIn("--ignore-config", cmd)
        self.assertIn("--no-cookies-from-browser", cmd)
        self.assertNotIn("--cookies-from-browser", cmd)

    def x_post(self):
        return json.loads((Path(__file__).parent / "fixtures" / "x-post.json").read_text())

    def test_x_and_twitter_urls_normalize_by_post_and_keep_video_selection(self):
        canonical = "https://x.com/i/web/status/123456"
        for url in ("X.com/example/status/123456/", "https://www.twitter.com/Other/status/123456?s=20&t=tracking",
                    "http://m.x.com/example/status/123456#player", "https://mobile.twitter.com/statuses/123456",
                    "https://x.com/i/web/status/123456"):
            with self.subTest(url=url):
                self.assertEqual(self.link.detect_platform(url), "x")
                self.assertEqual(self.link.normalize_url(url), canonical)
        for index in (1, 2):
            self.assertEqual(self.link.normalize_url(f"https://twitter.com/example/status/123456/video/{index}?s=46"),
                             f"{canonical}/video/{index}")
        for url in ("https://x.com.example.org/example/status/123456", "https://nottwitter.com/example/status/123456"):
            with self.subTest(url=url):
                self.assertIsNone(self.link.detect_platform(url))
        self.assertEqual(self.link.normalize_url("https://youtube.com/watch?v=abc&t=30&tracking=unused"),
                         "https://youtube.com/watch?v=abc&t=30")

    def test_x_preview_uses_real_extractor_for_first_and_selected_video(self):
        from yt_dlp.extractor.twitter import TwitterIE

        with patch.object(self.link, "_has_module", return_value=True), \
                patch.object(TwitterIE, "_extract_status", return_value=self.x_post()):
            first = self.client.post("/api/link-videos/preview", json={
                "url": "https://x.com/example/status/123456?s=46&t=tracking"}).json()
            second = self.client.post("/api/link-videos/preview", json={
                "url": "https://twitter.com/example/status/123456/video/2"}).json()
        for result, index in ((first, 1), (second, 2)):
            with self.subTest(index=index):
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["platform"], "x")
                self.assertEqual(result["extractor"], "Twitter")
                self.assertEqual(result["duration"], index * 5)
                self.assertEqual(result["uploader"], "演示作者")
                self.assertIn(f"demo{index}.jpg", result["thumbnail"])
                self.assertEqual(result["subtitle_status"], "none")
        self.assertIn("X 平台新品演示", first["title"])

    def test_x_external_extractor_flattens_first_video_and_rejects_empty_playlist(self):
        playlist = {"_type": "playlist", "title": "帖子", "entries": [
            {"title": "第一段视频", "duration": 5, "uploader": "作者"},
            {"title": "第二段视频", "duration": 10}]}
        with patch.object(self.link.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stderr="", stdout=json.dumps(playlist))) as run:
            result = self.link.preview("https://x.com/example/status/123456")
        self.assertTrue(result["ok"], result)
        self.assertEqual((result["title"], result["duration"]), ("第一段视频", 5))
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--playlist-items") + 1], "1")
        self.assertIn("--no-playlist", command)
        with patch.object(self.link.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stderr="", stdout=json.dumps({"_type": "playlist", "entries": []}))):
            result = self.link.preview("https://x.com/example/status/987654")
        self.assertFalse(result["ok"])
        self.assertIn("没有可采集的视频", result["message"])

    def test_x_aliases_share_preview_cache_and_batch_duplicate_check(self):
        self.queue.pause()
        first_url = "https://twitter.com/example/status/123456?s=20&t=tracking"
        alias = "https://www.x.com/Other/status/123456?s=46"
        with patch.object(self.link, "_info", return_value={"title": "同一帖子", "duration": 5}) as info:
            self.assertTrue(self.link.preview(first_url)["ok"])
            self.assertTrue(self.link.preview(alias)["ok"])
        self.assertEqual(info.call_count, 1)
        with patch.object(self.link, "_info", side_effect=AssertionError("入队不应访问 X")):
            response = self.client.post("/api/link-videos/batch", json={"items": [
                {"url": first_url}, {"url": alias}, {"url": "https://x.com/example/status/123456/video/2"}]})
        self.assertEqual(response.status_code, 200, response.text)
        results = response.json()["results"]
        self.assertEqual([r["ok"] for r in results], [True, False, True])
        self.assertTrue(results[1]["duplicate"])
        self.assertEqual(results[1]["existing"]["id"], results[0]["id"])
        session = self.db.get_session(results[0]["id"])
        self.assertEqual(session["platform"], "x")
        self.assertEqual(session["source_url"], first_url)
        self.assertEqual(session["normalized_url"], "https://x.com/i/web/status/123456")
        self.assertEqual(session["title"], "同一帖子")

    def test_x_batch_downloads_one_video_per_job_and_uses_existing_transcription(self):
        from yt_dlp.extractor.twitter import TwitterIE

        urls = ["https://x.com/example/status/123456", "https://twitter.com/example/status/123456/video/2"]
        transcribed = []

        def transcribe(task, media, _job):
            transcribed.append((task.sid, media.read_bytes()))

        with patch.object(self.link, "_has_module", return_value=True), \
                patch.object(TwitterIE, "_extract_status", return_value=self.x_post()), \
                patch.object(self.link.subprocess, "Popen", side_effect=self.public_download), \
                patch.object(self.link.meeting.asr_engines, "ready", return_value=True), \
                patch.object(self.link.LinkTask, "_transcribe", new=transcribe):
            response = self.client.post("/api/link-videos/batch", json={"items": [{"url": url} for url in urls]})
            self.assertEqual(response.status_code, 200, response.text)
            ids = [result["id"] for result in response.json()["results"]]
            self.wait_states({sid: "done" for sid in ids})
            self.queue.shutdown(timeout=3)
        self.assertEqual([sid for sid, _ in transcribed], ids)
        self.assertTrue(all(data for _, data in transcribed))
        self.assertEqual([self.db.get_session(sid)["duration"] for sid in ids], [5, 10])
        self.assertEqual([cmd[-1] for cmd in self.download_calls], [self.link.normalize_url(url) for url in urls])
        for command in self.download_calls:
            self.assertEqual(command[command.index("--playlist-items") + 1], "1")
            self.assertIn("--no-playlist", command)
            self.assertNotIn("--cookies-from-browser", command)
        for sid in ids:
            self.assertEqual(self.db.get_session(sid)["platform"], "x")
            self.assertTrue((self.database.session_dir(sid) / "media.mp4").is_file())

    def test_x_authentication_error_obeys_cookie_authorization(self):
        error = "ERROR: [twitter] NSFW tweet requires authentication"
        self.link.settings.update(link_cookie_browser="safari")
        with patch.object(self.link.subprocess, "run", side_effect=[self.result(error), self.result()]) as run:
            result = self.link.preview("https://x.com/example/status/123456")
        self.assertTrue(result["ok"], result)
        self.assertEqual(run.call_count, 2)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--cookies-from-browser") + 1], "safari")
        self.link._preview_cache.clear()
        self.link.settings.update(link_browser_cookies=False)
        with patch.object(self.link.subprocess, "run", return_value=self.result(error)) as run:
            result = self.link.preview("https://x.com/example/status/123456")
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "login_required")
        self.assertEqual(run.call_count, 1)
        self.assertNotIn("--cookies-from-browser", run.call_args.args[0])

    def test_x_post_without_video_preserves_extractor_error(self):
        from yt_dlp.extractor.twitter import TwitterIE

        post = self.x_post()
        post["extended_entities"]["media"] = []
        with patch.object(self.link, "_has_module", return_value=True), \
                patch.object(TwitterIE, "_extract_status", return_value=post):
            result = self.link.preview("https://x.com/example/status/123456")
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["platform"], "x")
        self.assertIn("No video could be found", result["message"])

    def test_x_anonymous_api_error_uses_syndication_before_reading_browser(self):
        playlist = {"_type": "playlist", "entries": [{"title": "公开帖第一段", "duration": 5}]}
        with patch.object(self.link.subprocess, "run", side_effect=[
                self.result("ERROR: Unable to download JSON metadata: Connection to api.x.com timed out"),
                SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(playlist))]) as run:
            result = self.link.preview("https://x.com/example/status/123456")
        self.assertTrue(result["ok"], result)
        self.assertEqual(run.call_count, 2)
        second = run.call_args.args[0]
        self.assertEqual(second[second.index("--extractor-args") + 1], "twitter:api=syndication")
        self.assertNotIn("--cookies-from-browser", second)
        info = self.link.cached_info(result["normalized_url"])
        self.assertEqual(info["_x_api"], "syndication")
        sid = self.new_job(result["normalized_url"])
        source = self.database.session_dir(sid) / "source"
        source.mkdir()
        with patch.object(self.link.subprocess, "Popen", side_effect=self.public_download):
            self.link.LinkTask(sid)._download(result["normalized_url"], source, info)
        command = self.download_calls[0]
        self.assertEqual(command[command.index("--extractor-args") + 1], "twitter:api=syndication")

    def test_x_module_retries_api_failure_through_syndication(self):
        calls = []

        def extract(url, cookie_args, subtitles_wanted):
            calls.append(cookie_args)
            if "twitter:api=syndication" not in cookie_args:
                return SimpleNamespace(returncode=1, stdout=None, stderr="ERROR: Connection to api.x.com timed out")
            return SimpleNamespace(returncode=0, stdout={"title": "公开帖"}, stderr="")

        with patch.object(self.link, "_has_module", return_value=True), \
                patch.object(self.link, "_extract", side_effect=extract):
            info = self.link._info("https://x.com/example/status/123456")
        self.assertEqual(info["_x_api"], "syndication")
        self.assertEqual(len(calls), 2)
        self.assertTrue(all("--cookies-from-browser" not in args for args in calls))


    def test_douyin_falls_back_to_share_page(self):
        share = {
            "aweme_id": "123",
            "title": "抖音测试",
            "uploader": "作者",
            "duration": 12.5,
            "thumbnail": "https://p3.douyinpic.com/cover.jpeg",
            "play_url": "https://www.douyin.com/aweme/v1/play/?video_id=v0300test&ratio=720p&line=0",
            "play_fallback": "",
            "page_url": "https://www.douyin.com/video/123",
            "width": 1080,
            "height": 1920,
        }
        with patch.object(self.link, "_info_ytdlp", side_effect=RuntimeError("Fresh cookies")), \
                patch.object(self.link.douyin, "share_info", return_value=share):
            info = self.link._info("https://www.douyin.com/video/123")
        self.assertEqual(info["extractor_key"], "DouyinShare")
        self.assertEqual(info["title"], "抖音测试")
        self.assertEqual(info["duration"], 12.5)
        self.assertIn("video_id=v0300test", info["_douyin_play_url"])
        self.assertEqual(info["formats"][0]["ext"], "mp4")


    def test_douyin_uses_direct_download(self):
        sid = self.new_job("https://www.douyin.com/video/123")
        source = self.database.session_dir(sid) / "source"
        source.mkdir()
        task = self.link.LinkTask(sid)
        info = {
            "_douyin_play_url": "https://www.douyin.com/aweme/v1/play/?video_id=v0300test",
            "_douyin_play_fallback": "",
        }
        with patch.object(self.link.douyin, "download_media", return_value=2048) as download:
            size, path = task._download("https://www.douyin.com/video/123", source, info)
        self.assertEqual(size, 2048)
        self.assertEqual(path, source / "douyin.mp4")
        self.assertEqual(download.call_args.args[0], info["_douyin_play_url"])
        self.assertEqual(download.call_args.kwargs["max_bytes"], self.link.MAX_BYTES)

    def test_x_download_api_failure_retries_public_endpoint(self):
        url = "https://x.com/example/status/123456"
        sid = self.new_job(url)
        source = self.database.session_dir(sid) / "source"
        source.mkdir()
        calls = []

        def download(cmd, **kwargs):
            calls.append(cmd)
            if "twitter:api=syndication" not in cmd:
                return SimpleNamespace(stdout=io.StringIO("ERROR: Unable to download JSON metadata: timed out\n"),
                                       wait=lambda: 1)
            return self.public_download(cmd, **kwargs)

        with patch.object(self.link.subprocess, "Popen", side_effect=download):
            size, media = self.link.LinkTask(sid)._download(url, source, {})
        self.assertEqual(len(calls), 2)
        self.assertGreater(size, 0)
        self.assertTrue(media.is_file())
        self.assertNotIn("--cookies-from-browser", calls[1])

    def test_x_syndication_is_not_used_for_authenticated_or_non_post_links(self):
        self.assertFalse(self.link._x_syndication_fallback(
            "https://x.com/example/status/123456", ["--cookies-from-browser", "safari"], "timed out"))
        self.assertFalse(self.link._x_syndication_fallback(
            "https://x.com/i/broadcasts/example", ["--no-cookies-from-browser"], "timed out"))
        self.assertFalse(self.link._x_syndication_fallback(
            "https://youtube.com/watch?v=abc", ["--no-cookies-from-browser"], "timed out"))
        self.assertEqual(self.link._extractor_args({"_x_api": "syndication"},
                                                ["--cookies-from-browser", "safari"]), [])

    def room_response(self, **overrides):
        info = {"room_id": 5146309, "title": "特斯拉ROADSTER发布会（回放）", "live_status": 1,
                "user_cover": "https://example.com/room-cover.jpg", "keyframe": "https://example.com/frame.jpg",
                "live_time": "2026-10-16 13:12:44", "area_name": "科技"}
        info.update(overrides)
        return io.BytesIO(json.dumps({"code": 0, "data": info}).encode())

    def preview_response(self, request, **_kwargs):
        if "get_anchor_in_room" in request.full_url:
            return io.BytesIO(json.dumps({"code": 0, "data": {"info": {"uname": "发布会官方"}}}).encode())
        return self.room_response()

    def test_same_live_link_has_same_title_cover_and_status_in_both_previews(self):
        raw = "https://live.bilibili.com/5146309?session_id=tracking&visit_id=unused"
        extracted = {"title": "特斯拉ROADSTER发布会（回放） 2026-10-16 15:33", "duration": 0,
                     "thumbnail": "https://example.com/extractor-cover.jpg", "uploader": "另一个来源",
                     "is_live": True, "extractor_key": "BiliBiliLive"}
        with patch.object(self.link.capture.urllib.request, "urlopen", side_effect=self.preview_response), \
                patch.object(self.link, "_info", return_value=extracted):
            live = self.client.post("/api/precheck", json={"url": raw}).json()
            video = self.client.post("/api/link-videos/preview", json={"url": raw}).json()
        self.assertTrue(live["ok"])
        self.assertTrue(video["ok"])
        self.assertEqual(live["title"], video["title"])
        self.assertEqual(live["thumbnail"], video["thumbnail"])
        self.assertEqual(live["status"], video["live_status"])
        self.assertEqual(video["normalized_url"], "https://live.bilibili.com/5146309")
        self.assertEqual(video["uploader"], "发布会官方")
        self.assertEqual(live["uploader"], video["uploader"])
        self.assertEqual(live["started_at"], video["started_at"])
        self.assertEqual(live["category"], video["category"])
        self.assertNotIn("2026-10-16", video["title"])

    def test_launch_preview_reads_cover_anchor_start_time_and_category_without_ytdlp(self):
        with patch.object(self.link.capture.urllib.request, "urlopen", side_effect=self.preview_response), \
                patch.dict(self.link.capture.DEPS, {"yt_dlp": None}):
            response = self.client.post("/api/precheck", json={"url": "https://live.bilibili.com/5146309"})
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertTrue(result["ok"])
        self.assertEqual(result["thumbnail"], "https://example.com/room-cover.jpg")
        self.assertEqual(result["uploader"], "发布会官方")
        self.assertEqual(result["started_at"], 1792127564)
        self.assertEqual(result["category"], "科技")

    def test_anchor_failure_preserves_successful_launch_preview(self):
        with patch.object(self.link.capture.urllib.request, "urlopen", side_effect=[self.room_response(), TimeoutError()]):
            result = self.link.capture.preview_bilibili_live("https://live.bilibili.com/5146309")
        self.assertTrue(result["ok"])
        self.assertEqual(result["started_at"], 1792127564)
        self.assertEqual(result["thumbnail"], "https://example.com/room-cover.jpg")
        self.assertNotIn("uploader", result)

    def test_live_thumbnail_uses_https_and_invalid_start_time_is_omitted(self):
        for value in ("", "0000-00-00 00:00:00", "not a date"):
            with self.subTest(value=value), patch.object(self.link.capture.urllib.request, "urlopen",
                    side_effect=lambda *_a, **_kw: self.room_response(user_cover="http://example.com/room-cover.jpg", live_time=value)):
                result = self.link.capture.check_bilibili_live("https://live.bilibili.com/5146309")
            self.assertEqual(result["thumbnail"], "https://example.com/room-cover.jpg")
            self.assertIsNone(result["started_at"])

    def test_offline_room_does_not_show_elapsed_time_from_old_broadcast(self):
        with patch.object(self.link.capture.urllib.request, "urlopen",
                side_effect=lambda *_a, **_kw: self.room_response(live_status=0)):
            result = self.link.capture.check_bilibili_live("https://live.bilibili.com/5146309")
        self.assertEqual(result["status"], "not_started")
        self.assertIsNone(result["started_at"])

    def test_live_cover_fallback_and_offline_status_preserve_room_metadata(self):
        for status in (0, 1, 2):
            with self.subTest(status=status), patch.object(self.link.capture.urllib.request, "urlopen",
                    side_effect=lambda *_a, **_kw: self.room_response(live_status=status, user_cover="", keyframe="//example.com/frame.jpg")):
                result = self.link.capture.check_bilibili_live("https://live.bilibili.com/5146309")
            self.assertEqual(result["thumbnail"], "https://example.com/frame.jpg")
            self.assertEqual(result["title"], "特斯拉ROADSTER发布会（回放）")
            self.assertEqual(result["ok"], status == 1)

    def test_short_link_resolved_to_live_uses_same_room_metadata(self):
        with patch.object(self.link, "_info", return_value={
                "title": "带提取时间的标题", "webpage_url": "https://live.bilibili.com/5146309"}), \
                patch.object(self.link.capture.urllib.request, "urlopen", side_effect=lambda *_a, **_kw: self.room_response()):
            result = self.link.preview("https://b23.tv/short")
        self.assertEqual(result["title"], "特斯拉ROADSTER发布会（回放）")
        self.assertEqual(result["thumbnail"], "https://example.com/room-cover.jpg")
        self.assertEqual(result["live_status"], "live")

    def test_normal_video_title_date_and_metadata_are_preserved(self):
        with patch.object(self.link, "_info", return_value={"title": "产品演示 2026-10-16 15:33",
                "thumbnail": "https://example.com/video.jpg", "uploader": "原作者", "duration": 65}), \
                patch.object(self.link.capture, "check_bilibili_live") as live_check:
            result = self.link.preview("https://www.bilibili.com/video/BV123")
        live_check.assert_not_called()
        self.assertEqual(result["title"], "产品演示 2026-10-16 15:33")
        self.assertEqual(result["thumbnail"], "https://example.com/video.jpg")
        self.assertEqual(result["uploader"], "原作者")
        self.assertEqual(result["duration"], 65)
        self.assertIsNone(result["live_status"])

    def test_login_metadata_uses_only_authorized_selected_browser(self):
        self.link.settings.update(link_cookie_browser="safari")
        with patch.object(self.link.subprocess, "run", side_effect=[
            self.result("ERROR: Please login to watch this private video"), self.result(),
        ]) as run:
            self.assertEqual(self.link._info("youtu.be/private")["title"], "测试视频")
        self.assertEqual(run.call_count, 2)
        cmd = run.call_args.args[0]
        self.assertEqual(cmd[cmd.index("--cookies-from-browser") + 1], "safari")

    def test_login_metadata_without_authorization_never_reads_browser(self):
        self.link.settings.update(link_browser_cookies=False)
        with patch.object(self.link.subprocess, "run", return_value=self.result("ERROR: Please sign in")) as run:
            with self.assertRaisesRegex(self.link.LinkAccessError, "sign in"):
                self.link._info("youtu.be/private")
        self.assertEqual(run.call_count, 1)
        self.assertNotIn("--cookies-from-browser", run.call_args.args[0])

    def test_missing_browser_preserves_platform_error_with_actionable_message(self):
        with patch.object(self.link.subprocess, "run", side_effect=[
            self.result("ERROR: Please login to watch this private video"),
            self.result('ERROR: could not find chrome cookies database in "/missing/Chrome"'),
        ]):
            result = self.link.preview("youtu.be/private")
        self.assertFalse(result["ok"])
        self.assertIn("private video", result["message"])
        self.assertIn("选择已登录的浏览器", result["message"])
        self.assertNotIn("/missing", result["message"])

    def test_network_error_does_not_trigger_browser_read_or_duplicate_metadata_request(self):
        sid = self.new_job("https://bilibili.com/video/network")
        self.fail_urls.add("https://bilibili.com/video/network")
        with patch.object(self.link.subprocess, "run", side_effect=self.public_info):
            self.link.LinkTask(sid).run()
        self.assertEqual(len(self.info_calls), 1)
        self.assertIn("503", self.db.get_session(sid)["error"])

    def test_three_link_batch_completes_serially_with_missing_chrome(self):
        urls = ["https://www.bilibili.com/video/first/", "https://bilibili.com/video/second/",
                "bilibili.com/video/third/?tracking=unused"]
        with patch.object(self.link.subprocess, "run", side_effect=self.public_info), \
                patch.object(self.link.subprocess, "Popen", side_effect=self.public_download), \
                patch.object(self.link.asr_engines, "ready", return_value=False):
            response = self.client.post("/api/link-videos/batch", json={"items": [{"url": u} for u in urls]})
            self.assertEqual(response.status_code, 200, response.text)
            ids = [r["id"] for r in response.json()["results"]]
            self.assertEqual(len(ids), 3)
            self.wait_states({sid: "done" for sid in ids})
            self.queue.shutdown(timeout=3)
        self.assertEqual([c[-1] for c in self.download_calls], [self.link.normalize_url(u) for u in urls])
        for cmd in self.info_calls + self.download_calls:
            self.assertNotIn("--cookies-from-browser", cmd)
            self.assertIn("--ignore-config", cmd)
        for sid in ids:
            self.assertEqual(self.db.get_link_job(sid)["job_state"], "done")
            self.assertTrue((self.database.session_dir(sid) / "media.mp4").is_file())

    def test_failed_middle_job_does_not_block_next_and_retry_reuses_original_record(self):
        urls = [f"https://bilibili.com/video/{n}" for n in ("first", "second", "third")]
        ids = [self.new_job(url) for url in urls]
        self.fail_urls.add(urls[1])
        with patch.object(self.link.subprocess, "run", side_effect=self.public_info), \
                patch.object(self.link.subprocess, "Popen", side_effect=self.public_download):
            self.queue.add(ids[0])
            self.wait_states(dict(zip(ids, ("done", "error", "done"))))
            first_bytes = (self.database.session_dir(ids[0]) / "media.mp4").read_bytes()
            self.fail_urls.clear()
            response = self.client.post(f"/api/link-videos/{ids[1]}/retry")
            self.assertEqual(response.status_code, 200, response.text)
            self.wait_states({sid: "done" for sid in ids})
            self.queue.shutdown(timeout=3)
        self.assertEqual(len(self.db.list_sessions()), 3)
        self.assertEqual(self.db.get_link_job(ids[1])["retry_count"], 1)
        self.assertIsNone(self.db.get_session(ids[1])["error"])
        self.assertIsNone(self.db.get_link_job(ids[1])["error_message"])
        self.assertEqual((self.database.session_dir(ids[0]) / "media.mp4").read_bytes(), first_bytes)

    def test_download_login_fallback_keeps_resume_and_reports_real_error(self):
        sid = self.new_job("bilibili.com/video/private")
        source = self.database.session_dir(sid) / "source"
        source.mkdir()
        task = self.link.LinkTask(sid)
        calls = []

        def download(cmd, **_kwargs):
            calls.append(cmd)
            if "--cookies-from-browser" not in cmd:
                return SimpleNamespace(stdout=io.StringIO("ERROR: HTTP Error 403: Forbidden\n"), wait=lambda: 1)
            return self.public_download(cmd, **_kwargs)

        with patch.object(self.link.subprocess, "Popen", side_effect=download):
            with self.assertRaisesRegex(self.link.LinkAccessError, "403.*选择已登录的浏览器"):
                task._download("bilibili.com/video/private", source, {})
        self.assertEqual(len(calls), 2)
        for cmd in calls:
            self.assertIn("--continue", cmd)
            self.assertEqual(cmd[-1], "https://bilibili.com/video/private")

    def test_download_can_succeed_after_authorized_login_fallback(self):
        sid = self.new_job("https://bilibili.com/video/private")
        source = self.database.session_dir(sid) / "source"
        source.mkdir()
        calls = []

        def download(cmd, **_kwargs):
            calls.append(cmd)
            if "--cookies-from-browser" not in cmd:
                return SimpleNamespace(stdout=io.StringIO("ERROR: Please login\n"), wait=lambda: 1)
            target = source / "media.mp4"
            target.write_bytes(b"video" * 256)
            return SimpleNamespace(stdout=io.StringIO("[download] 100%\n"), wait=lambda: 0)

        with patch.object(self.link.subprocess, "Popen", side_effect=download):
            size, media = self.link.LinkTask(sid)._download("bilibili.com/video/private", source, {})
        self.assertEqual(len(calls), 2)
        self.assertEqual(size, media.stat().st_size)

    def test_download_progress_uses_selected_formats_not_preview_size(self):
        sid = self.new_job("https://bilibili.com/video/progress")
        source = self.database.session_dir(sid) / "source"
        source.mkdir()
        snapshots = []
        output = (
            'MEETCLIP_PLAN [{"format_id": "720", "filesize_approx": 300}, {"format_id": "audio", "filesize": 100}]\n'
            "MEETCLIP_PROGRESS 720\t150\t300\t20\tdownloading\n"
            "MEETCLIP_PROGRESS 720\t300\t300\t20\tfinished\n"
            "MEETCLIP_PROGRESS audio\t50\t100\t10\tdownloading\n"
        )

        def download(cmd, **_kwargs):
            self.assertIn("--progress-template", cmd)
            (source / "media.mp4").write_bytes(b"x" * 10)
            return SimpleNamespace(stdout=io.StringIO(output), wait=lambda: 0)

        original = self.db.update_link_job

        def record(job_sid, **fields):
            if "download_progress" in fields:
                snapshots.append(fields["download_progress"])
            return original(job_sid, **fields)

        task = self.link.LinkTask(sid)
        with patch.object(self.link.subprocess, "Popen", side_effect=download), \
                patch.object(self.link.time, "monotonic", side_effect=[1, 2, 3, 4]), \
                patch.object(self.link.db, "update_link_job", side_effect=record):
            task._download("https://bilibili.com/video/progress", source, {"filesize_approx": 1_400_000_000})
        job = self.db.get_link_job(sid)
        self.assertEqual(job["total_bytes"], 400)
        self.assertEqual(job["downloaded_bytes"], 350)
        self.assertAlmostEqual(job["download_progress"], 0.875)
        self.assertEqual(job["speed"], 10)
        self.assertEqual(job["eta"], 5)
        self.assertNotIn(1.0, snapshots)

    def test_link_speaker_merge_and_export_follow_meeting_rules(self):
        sid = self.new_job("https://bilibili.com/video/export")
        self.db.update_meta(sid, speakers={"S1": "张三", "S2": "发言人 2"})
        self.db.add_transcripts(sid, [(0, 4, "第一人的发言", "S1"), (4, 10, "第二人的发言", "S2")])
        response = self.client.patch(f"/api/sessions/{sid}/speakers", json={"names": {"S2": "张三"}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([t["speaker"] for t in self.db.get_transcripts(sid)], ["S1", "S2"])
        response = self.client.patch(f"/api/sessions/{sid}/speakers", json={"merge": {"S2": "S1"}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([t["speaker"] for t in self.db.get_transcripts(sid)], ["S1", "S1"])
        exported = self.main.export_markdown(sid)
        markdown = (Path(exported["dir"]) / "notes.md").read_text()
        self.assertIn("## 说话人", markdown)
        self.assertIn("张三（发言约 00:10，100%）", markdown)
        self.assertEqual(markdown.count("**张三**"), 2)
        self.assertIn("https://bilibili.com/video/export", markdown)

    def test_subtitle_selection_filters_comments_and_prefers_original_language(self):
        subtitles = self.link.subtitles
        info = {"language": "en", "subtitles": {
                    "danmaku": [{"ext": "xml", "url": "x"}], "live_chat": [{"ext": "json", "url": "x"}],
                    "en": [{"ext": "vtt", "url": "en"}], "ai-zh": [{"ext": "srt", "data": "x"}],
                    "zh-Hans": [{"ext": "srt", "data": "x"}]},
                "automatic_captions": {"zh-Hans": [{"ext": "json3", "url": "auto"}]}}
        ranked = subtitles.candidates(info)
        self.assertEqual(ranked[0]["code"], "en")
        self.assertNotIn("danmaku", [t["code"] for t in ranked])
        self.assertEqual(subtitles.summary(info)["default_subtitle_track_id"], "en:manual")
        self.assertEqual(subtitles.summary({"subtitles": {"danmaku": [{"ext": "xml", "url": "x"}]}})["subtitle_status"], "none")

    def test_youtube_dubbed_captions_default_to_audio_language_and_translate_from_it(self):
        def track(lang, tlang=None):
            query = f"lang={lang}&kind=asr" + (f"&tlang={tlang}" if tlang else "")
            return [{"ext": "vtt", "url": f"https://youtube.test/api?{query}", "name": lang}]
        info = {"language": "en-US",
                "formats": [{"language": "en-US", "format_note": "English (US) original (default)"}],
                "automatic_captions": {
                    "ar-orig": track("ar"), "en-orig": track("en"), "en": track("ar", "en") + track("en"),
                    "zh-Hans": track("ar", "zh-Hans") + track("en", "zh-Hans")}}
        summary = self.link.subtitles.summary(info)
        self.assertEqual(summary["default_subtitle_track_id"], "en:automatic")
        self.assertFalse(summary["subtitle_selection_required"])
        options = {t["id"]: t for t in summary["subtitle_tracks"]}
        self.assertEqual(options["zh-hans:translated"]["source_language"], "en")
        chosen = self.link.subtitles.candidates(info, "zh-hans:translated")
        self.assertTrue(chosen and all("lang=en&" in t["track"]["url"] for t in chosen))
        self.assertTrue(all("lang=en&" in t["track"]["url"]
                            for t in self.link.subtitles.candidates(info, "en:automatic")))

    def test_unknown_original_language_with_several_tracks_requires_choice(self):
        summary = self.link.subtitles.summary({"subtitles": {
            "fr": [{"ext": "srt", "data": "x"}], "de": [{"ext": "srt", "data": "x"}]}})
        self.assertTrue(summary["subtitle_selection_required"])
        self.assertIsNone(summary["default_subtitle_track_id"])
        single = self.link.subtitles.summary({"subtitles": {"fr": [{"ext": "srt", "data": "x"}]}})
        self.assertEqual(single["default_subtitle_track_id"], "fr:manual")

    def test_batch_requires_and_persists_a_valid_subtitle_choice(self):
        self.queue.pause()
        self.link._remember("https://youtu.be/choice", {"title": "字幕", "subtitles": {
            "fr": [{"ext": "srt", "data": "x"}], "de": [{"ext": "srt", "data": "x"}]}})
        with patch.object(self.link, "_info", side_effect=AssertionError("入队不应读取视频信息")):
            missing = self.client.post("/api/link-videos/batch", json={"items": [{"url": "https://youtu.be/choice"}]})
            invalid = self.client.post("/api/link-videos/batch", json={"items": [
                {"url": "https://youtu.be/choice", "subtitle_track_id": "ar:automatic"}]})
            chosen = self.client.post("/api/link-videos/batch", json={"items": [
                {"url": "https://youtu.be/choice", "subtitle_track_id": "de:manual"}]})
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(chosen.status_code, 200, chosen.text)
        detail = self.client.get(f"/api/sessions/{chosen.json()['results'][0]['id']}").json()
        self.assertEqual(detail["subtitle_track_id"], "de:manual")

    def test_batch_enqueues_immediately_without_reading_platform(self):
        self.queue.pause()
        with patch.object(self.link, "_info", side_effect=AssertionError("入队不应读取视频信息")), \
                patch.object(self.link, "preview", side_effect=AssertionError("入队不应预读")):
            started = time.monotonic()
            response = self.client.post("/api/link-videos/batch", json={"items": [
                {"url": "https://youtu.be/pending", "title": "客户端标题", "thumbnail": "https://example.com/a.jpg"},
                {"url": "https://youtu.be/no-title"},
                {"url": "https://example.com/unsupported"}]})
            elapsed = time.monotonic() - started
        self.assertEqual(response.status_code, 200, response.text)
        self.assertLess(elapsed, 0.3)
        results = response.json()["results"]
        self.assertEqual([r["ok"] for r in results], [True, True, False])
        first = self.db.get_session(results[0]["id"])
        self.assertEqual(first["title"], "客户端标题")
        self.assertEqual(first["meta"]["source_meta"]["thumbnail"], "https://example.com/a.jpg")
        self.assertEqual(self.db.get_session(results[1]["id"])["title"], "https://youtu.be/no-title")

    def test_task_reuses_preview_cache_and_updates_placeholder_title(self):
        url = "https://youtu.be/cached"
        self.link._remember(url, {"title": "真实标题", "duration": 4, "subtitles": {
            "en": [{"ext": "srt", "data": "1\n00:00:00,000 --> 00:00:02,000\nHello\n"}]}})
        sid = self.new_job(url)
        self.db.update_session(sid, title=url)
        self.db.update_meta(sid, transcription_mode="auto")
        with patch.object(self.link, "_info", side_effect=AssertionError("已有预读缓存不应再访问平台")), \
                patch.object(self.link.subprocess, "Popen", side_effect=self.public_download):
            self.link.LinkTask(sid).run()
        session = self.db.get_session(sid)
        self.assertEqual(session["status"], "done", session.get("error"))
        self.assertEqual(session["title"], "真实标题")
        self.assertEqual([t["text"] for t in self.db.get_transcripts(sid)], ["Hello"])

    def test_subtitles_are_imported_before_video_download(self):
        url = "https://youtu.be/order"
        self.link._remember(url, {"title": "顺序", "duration": 4, "subtitles": {
            "en": [{"ext": "srt", "data": "1\n00:00:00,000 --> 00:00:02,000\nFirst\n"}]}})
        sid = self.new_job(url)
        self.db.update_meta(sid, transcription_mode="auto")
        seen = []

        def download(cmd, **kwargs):
            seen.append([t["text"] for t in self.db.get_transcripts(sid)])
            return self.public_download(cmd, **kwargs)

        with patch.object(self.link.subprocess, "Popen", side_effect=download):
            self.link.LinkTask(sid).run()
        self.assertEqual(seen, [["First"]])
        self.assertEqual(self.db.get_session(sid)["status"], "done")

    def test_ambiguous_caption_language_fails_after_keeping_video(self):
        url = "https://youtu.be/ambiguous"
        self.link._remember(url, {"duration": 4, "subtitles": {
            "fr": [{"ext": "srt", "data": "1\n00:00:00,000 --> 00:00:01,000\nBonjour\n"}],
            "de": [{"ext": "srt", "data": "1\n00:00:00,000 --> 00:00:01,000\nHallo\n"}]}})
        sid = self.new_job(url)
        self.db.update_meta(sid, transcription_mode="auto")
        with patch.object(self.link.subprocess, "Popen", side_effect=self.public_download):
            self.link.LinkTask(sid).run()
        session = self.db.get_session(sid)
        self.assertEqual(session["status"], "error")
        self.assertIn("选择字幕语言", session["error"])
        self.assertTrue((self.database.session_dir(sid) / "media.mp4").is_file())
        self.assertEqual(self.db.get_transcripts(sid), [])

    def test_in_process_metadata_uses_yt_dlp_module_and_cookie_order(self):
        calls = []

        def extract(url, cookie_args, subtitles_wanted):
            calls.append(cookie_args)
            if "--cookies-from-browser" not in cookie_args:
                return SimpleNamespace(returncode=1, stdout=None, stderr="ERROR: Please sign in")
            return SimpleNamespace(returncode=0, stdout={"title": "登录后可见"}, stderr="")

        with patch.object(self.link, "_has_module", return_value=True), \
                patch.object(self.link, "_extract", side_effect=extract):
            self.assertEqual(self.link._info("youtu.be/private")["title"], "登录后可见")
        self.assertNotIn("--cookies-from-browser", calls[0])
        self.assertIn("--cookies-from-browser", calls[1])
        with patch.object(self.link, "_has_module", return_value=True):
            self.assertEqual(self.link._command()[1:], ["-m", "yt_dlp"])

    def test_subtitle_formats_clean_rolling_duplicates_and_invalid_cues(self):
        parse = self.link.subtitles.parse
        vtt = "WEBVTT\n\n00:00.000 --> 00:02.000\n<c>大家好</c>&amp;欢迎\n\n" \
              "00:01.000 --> 00:03.000\n大家好&amp;欢迎 今天开始\n\n00:05.000 --> 00:04.000\n坏时间"
        self.assertEqual(parse(vtt, "vtt"), [(0.0, 2.0, "大家好&欢迎", None), (1.0, 3.0, "今天开始", None)])
        self.assertEqual(parse("1\n00:00:01,000 --> 00:00:02,500\n第一句\n\n2\n00:00:03,000 --> 00:00:04,000\n", "srt"),
                         [(1.0, 2.5, "第一句", None)])
        self.assertEqual(parse(json.dumps({"events": [{"tStartMs": 500, "dDurationMs": 1000,
                                                      "segs": [{"utf8": "hello"}, {"utf8": " world"}]}]}), "json3"),
                         [(0.5, 1.5, "hello world", None)])
        self.assertEqual(parse(json.dumps({"body": [{"from": 1, "to": 2, "content": "B站字幕"}]}), "json"),
                         [(1.0, 2.0, "B站字幕", None)])

    def test_youtube_back_to_back_rolling_captions_are_not_duplicated(self):
        # YouTube automatic VTT: each line is shown alone for 10 ms, then repeated
        # above the next line. Cues touch rather than overlap.
        vtt = ("WEBVTT\n\n"
               "00:00:07.480 --> 00:00:08.630\n \nAll<00:00:07.600><c> right,</c>\n\n"
               "00:00:08.630 --> 00:00:08.640\nAll right,\n \n\n"
               "00:00:08.640 --> 00:00:10.870\nAll right,\ntreatment<00:00:09.120><c> for Alex.</c>\n\n"
               "00:00:10.870 --> 00:00:10.880\ntreatment for Alex.\n \n\n"
               "00:00:10.880 --> 00:00:13.090\ntreatment for Alex.\nAll right.\n\n"
               "00:00:20.000 --> 00:00:21.000\nAll right.\n")
        rows = self.link.subtitles.parse(vtt, "vtt")
        self.assertEqual([r[2] for r in rows], ["All right,", "treatment for Alex.", "All right.", "All right."])
        self.assertEqual(rows[0][:2], (7.48, 8.64))

    def _caption_job(self, mode, info):
        sid = self.new_job("https://youtu.be/captions")
        self.db.update_meta(sid, transcription_mode=mode)
        source = self.database.session_dir(sid) / "source"
        source.mkdir(parents=True, exist_ok=True)
        (source / "metadata.json").write_text(json.dumps(dict(info, _subtitle_probe=True)), encoding="utf-8")
        (self.database.session_dir(sid) / "media.mp4").write_bytes(b"video" * 256)
        return sid

    def test_auto_mode_imports_captions_without_any_local_model(self):
        sid = self._caption_job("auto", {"title": "字幕视频", "duration": 4, "subtitles": {
            "zh-Hans": [{"ext": "srt", "data": "1\n00:00:00,000 --> 00:00:02,000\n字幕正文\n"}]}})
        self.db.add_transcript(sid, 0, 1, "旧文本", "S1")
        with patch.object(self.link.meeting.asr.manager, "is_ready", return_value=False), \
                patch.object(self.link.LinkTask, "_transcribe", side_effect=AssertionError("ASR must not run")), \
                patch.object(self.link.minutes, "finish") as finish:
            self.link.LinkTask(sid).run()
        # 字幕路径不走 MeetingTask，必须在链接任务收尾时补一次终稿纪要。
        finish.assert_called_once_with(sid)
        detail = self.client.get(f"/api/sessions/{sid}").json()
        self.assertEqual(detail["status"], "done", detail.get("error"))
        self.assertEqual([(t["text"], t["speaker"]) for t in detail["transcripts"]], [("字幕正文", None)])
        self.assertEqual(detail["transcription_source"], "subtitle")
        caption_dir = self.database.session_dir(sid) / "source" / "subtitles"
        self.assertTrue((caption_dir / "caption.srt").exists())
        exported = importlib.import_module("export_md").export_markdown(sid)["dir"]
        notes = Path(exported, "notes.md").read_text(encoding="utf-8")
        self.assertIn("平台人工字幕", notes)
        self.assertIn("字幕时间轴", notes)

    def test_asr_mode_and_empty_caption_fall_back_to_existing_pipeline(self):
        for mode, info in (("asr", {"subtitles": {"zh": [{"ext": "srt", "data": "1\n00:00:00,000 --> 00:00:01,000\n字幕\n"}]}}),
                           ("auto", {"subtitles": {}})):
            with self.subTest(mode=mode):
                sid = self._caption_job(mode, dict(info, duration=4))
                with patch.object(self.link.meeting.asr.manager, "is_ready", return_value=True), \
                        patch.object(self.link.LinkTask, "_transcribe") as transcribe:
                    self.link.LinkTask(sid).run()
                transcribe.assert_called_once()
                self.assertEqual(self.db.get_session(sid)["status"], "done")

    def test_selected_caption_failure_keeps_video_and_retries_same_language(self):
        sid = self._caption_job("auto", {"duration": 4, "subtitles": {
            "zh-Hans": [{"ext": "srt", "data": "WEBVTT\n\n"}],
            "en": [{"ext": "srt", "data": "1\n00:00:00,000 --> 00:00:01,000\nEnglish\n"}]}})
        self.db.update_meta(sid, subtitle_track_id="zh-hans:manual")
        with patch.object(self.link.meeting.asr.manager, "is_ready", return_value=True), \
                patch.object(self.link.LinkTask, "_transcribe") as transcribe, \
                patch.object(self.link, "_info", side_effect=RuntimeError("offline")):
            self.link.LinkTask(sid).run()
        transcribe.assert_not_called()
        session = self.db.get_session(sid)
        self.assertEqual(session["status"], "error")
        self.assertIn("同一字幕语言", session["error"])
        self.assertEqual(session["meta"]["subtitle_track_id"], "zh-hans:manual")
        self.assertTrue((self.database.session_dir(sid) / "media.mp4").exists())
        self.assertEqual(self.db.get_transcripts(sid), [])

    def test_multi_link_batch_writes_batch_meta_and_single_does_not(self):
        urls = ["https://www.bilibili.com/video/batch-a/", "https://www.bilibili.com/video/batch-b/"]
        with patch.object(self.link.manager, "add") as add:
            response = self.client.post("/api/link-videos/batch", json={"items": [{"url": u} for u in urls]})
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(add.call_count, 2)
        self.assertIn("batch", payload)
        batch = payload["batch"]
        self.assertEqual(batch["total"], 2)
        ids = [row["id"] for row in payload["results"]]
        metas = [self.db.get_session(sid)["meta"] for sid in ids]
        self.assertEqual({meta["batch"]["id"] for meta in metas}, {batch["id"]})
        self.assertEqual([meta["batch"]["index"] for meta in metas], [0, 1])

        with patch.object(self.link.manager, "add"):
            single = self.client.post("/api/link-videos/batch", json={
                "items": [{"url": "https://www.bilibili.com/video/single/"}]
            })
        self.assertEqual(single.status_code, 200, single.text)
        self.assertNotIn("batch", single.json())

    def test_append_links_to_existing_batch_continues_indices_and_total(self):
        first_urls = ["https://www.bilibili.com/video/append-a/", "https://www.bilibili.com/video/append-b/"]
        with patch.object(self.link.manager, "add"):
            first = self.client.post("/api/link-videos/batch", json={"items": [{"url": u} for u in first_urls]})
        self.assertEqual(first.status_code, 200, first.text)
        batch = first.json()["batch"]
        first_ids = [row["id"] for row in first.json()["results"]]

        second_urls = ["https://www.bilibili.com/video/append-c/", "https://www.bilibili.com/video/append-d/"]
        with patch.object(self.link.manager, "add"):
            second = self.client.post("/api/link-videos/batch", json={
                "batch_id": batch["id"], "items": [{"url": u} for u in second_urls]
            })
        self.assertEqual(second.status_code, 200, second.text)
        payload = second.json()
        self.assertTrue(payload.get("appended"))
        self.assertEqual(payload["batch"]["id"], batch["id"])
        self.assertEqual(payload["batch"]["title"], batch["title"])
        self.assertAlmostEqual(payload["batch"]["created_at"], batch["created_at"])
        self.assertEqual(payload["batch"]["total"], 4)
        second_ids = [row["id"] for row in payload["results"]]
        metas = [self.db.get_session(sid)["meta"] for sid in first_ids + second_ids]
        self.assertEqual([meta["batch"]["index"] for meta in metas], [0, 1, 2, 3])
        self.assertEqual({meta["batch"]["title"] for meta in metas}, {batch["title"]})

        # 单条也能续排进已有批次，而不是另开一张批次卡。
        with patch.object(self.link.manager, "add"):
            third = self.client.post("/api/link-videos/batch", json={
                "batch_id": batch["id"],
                "items": [{"url": "https://www.bilibili.com/video/append-e/"}]
            })
        self.assertEqual(third.status_code, 200, third.text)
        self.assertEqual(third.json()["batch"]["total"], 5)
        third_id = third.json()["results"][0]["id"]
        self.assertEqual(self.db.get_session(third_id)["meta"]["batch"]["index"], 4)

        grouped = self.client.get("/api/home").json()["batches"]
        self.assertEqual(len(grouped), 1)
        self.assertEqual(grouped[0]["id"], batch["id"])
        self.assertEqual(grouped[0]["total"], 5)
        self.assertEqual([member["id"] for member in grouped[0]["members"]], first_ids + second_ids + [third_id])

    def test_append_to_unknown_batch_is_rejected_without_creating_sessions(self):
        before = len(self.db.list_sessions())
        response = self.client.post("/api/link-videos/batch", json={
            "batch_id": "does-not-exist",
            "items": [{"url": "https://www.bilibili.com/video/append-missing/"}]
        })
        self.assertEqual(response.status_code, 404, response.text)
        self.assertIn("批次", response.json()["detail"])
        self.assertEqual(len(self.db.list_sessions()), before)

    def test_douyin_uses_imported_cookie_file_before_anonymous(self):
        path = Path(self.data.name) / "douyin_cookies.txt"
        path.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
        with patch.object(self.link.douyin, "COOKIE_FILE", path):
            attempts = self.link._access_attempts("https://v.douyin.com/6DFF61GmvhI/")
            self.assertEqual(attempts[0], ["--cookies", str(path)])
            self.assertIn("--no-cookies", attempts[1])
            plain = self.link._access_attempts("https://www.bilibili.com/video/BV1xx411c7mD")
            self.assertNotIn("--cookies", plain[0])
        path.unlink(missing_ok=True)

if __name__ == "__main__":
    unittest.main(verbosity=2)
