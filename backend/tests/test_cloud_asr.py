"""Isolated cloud provider, durability and API integration tests. No remote calls or Keychain writes."""
import importlib
import io
import json
import os
from pathlib import Path
import queue
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid
import wave

import httpx
import numpy as np

TASK_DATA = tempfile.TemporaryDirectory(prefix="meetclip-cloud-tests-")
os.environ["ZHIBO_DATA_DIR"] = TASK_DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
import asr_engines as engines
import cloud_transcription as cloud
import database
import asr
import settings
import capture
import meeting
import scheduler
from fastapi.testclient import TestClient
import main

REAL_CLIENT = httpx.Client


def sse(text="你好", finish="stop"):
    objects = [{"choices": [{"delta": {"content": text[:1]}}]},
               {"choices": [{"delta": {"content": text[1:]}}]}]
    if finish:
        objects.append({"choices": [{"delta": {}, "finish_reason": finish}]})
    return "".join("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n" for obj in objects).encode()


class CloudTests(unittest.TestCase):
    def setUp(self):
        self.config = engines.default_config("mimo")
        self.provider = engines.MiMoProvider(self.config)
        self.key_patch = patch.object(engines, "credential", return_value="test-key")
        self.key_patch.start()
        self.events = []
        self.cancel = threading.Event()
        self.client = TestClient(main.app, base_url="http://127.0.0.1:8321",
                                 headers={"X-MeetClip-Token": main.auth.API_TOKEN})
        self.audio = np.ones(16000 * 5, dtype=np.float32) * .05

    def tearDown(self):
        scheduler.shutdown()
        self.client.close()
        self.key_patch.stop()
        settings.update(asr_provider="local")

    def transport(self, handler):
        return patch("httpx.Client", side_effect=lambda **kwargs:
                     REAL_CLIENT(transport=httpx.MockTransport(handler), **kwargs))

    def new_record(self, old=False):
        sid = uuid.uuid4().hex[:12]
        database.db.create_session(sid, "测试", "", kind="meeting")
        database.db.update_meta(sid, asr_engine=self.config)
        if old:
            database.db.add_transcript(sid, 0, 5, "旧转录", speaker="S1")
            database.db.update_meta(sid, aligned=True, speakers={"S1": "张老师"})
        run = cloud.begin(sid, self.config)
        return sid, run

    def emit(self, kind, **payload):
        self.events.append(dict(kind=kind, **payload))

    def test_wav_format_and_actual_size_splitting(self):
        data = engines.encode_wav(self.audio)
        with wave.open(io.BytesIO(data), "rb") as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (16000, 1, 2))
        with patch.object(engines, "MAX_BASE64_BYTES", 10000):
            parts = list(engines.split_upload(self.audio))
        self.assertEqual(sum(len(a) for a, _ in parts), len(self.audio))
        self.assertTrue(all(len(encoded) <= 10000 for _, encoded in parts))

    def test_sse_builds_partial_text_and_correct_request(self):
        seen, previews = [], []
        def handler(request):
            seen.append(json.loads(request.content))
            self.assertEqual(request.headers["Authorization"], "Bearer test-key")
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse("您好，MiMo。"))
        with self.transport(handler):
            result = self.provider.recognize(self.audio, language="Chinese", on_partial=previews.append)
        self.assertEqual(result.text, "您好，MiMo。")
        self.assertEqual(previews, ["您", "您好，MiMo。"])
        self.assertEqual(seen[0]["asr_options"], {"language": "zh"})
        self.assertTrue(seen[0]["stream"])
        self.assertTrue(seen[0]["messages"][0]["content"][0]["input_audio"]["data"].startswith("data:audio/wav;base64,"))
        self.assertIsNotNone(result.metrics["requests"][0]["first_text_seconds"])

    def test_json_gateway_fallback(self):
        with self.transport(lambda _: httpx.Response(200, json={"choices": [{
            "message": {"content": "一次性结果"}, "finish_reason": "stop"}]})):
            result = self.provider.recognize(self.audio)
        self.assertEqual(result.text, "一次性结果")
        self.assertFalse(result.metrics["requests"][0]["streamed"])

    def test_auth_failure_is_fatal_and_does_not_echo_remote_body(self):
        count = []
        with self.transport(lambda _: (count.append(1) or httpx.Response(403, text="test-key remote-private-body"))):
            with self.assertRaises(engines.ProviderError) as caught:
                self.provider.recognize(self.audio)
        self.assertTrue(caught.exception.fatal)
        self.assertNotIn("test-key", str(caught.exception))
        self.assertEqual(len(count), 1)

    def test_retry_replaces_preview_after_interrupted_stream(self):
        count, previews = [], []
        def handler(_):
            count.append(1)
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  content=sse("中断", None) if len(count) == 1 else sse("成功"))
        with self.transport(handler), patch("asr_engines.time.sleep"):
            result = self.provider.recognize(self.audio, on_partial=previews.append)
        self.assertEqual(result.text, "成功")
        self.assertIn("", previews)
        self.assertEqual(len(count), 2)

    def test_rate_limit_retries_but_truncation_does_not_commit(self):
        calls = []
        def handler(_):
            calls.append(1)
            return httpx.Response(429) if len(calls) < 3 else httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse())
        with self.transport(handler), patch("asr_engines.time.sleep"):
            self.assertEqual(self.provider.recognize(self.audio).text, "你好")
        self.assertEqual(len(calls), 3)
        with self.transport(lambda _: httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse(finish="length"))):
            with self.assertRaisesRegex(engines.ProviderError, "截断"):
                self.provider.recognize(self.audio)

    def test_language_tag_only_stream_is_empty_instead_of_truncated(self):
        """空白片段上模型只吐 `<chinese>`：按空结果处理，既不报截断也不写入转写。"""
        tags = "<chinese>" * 60
        def stream(finish="stop"):
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  content=sse(tags, finish=finish))
        with self.transport(lambda _: stream()):
            result = self.provider.recognize(self.audio)
        self.assertEqual(result.text, "")
        self.assertTrue(result.metrics["requests"][0]["noise_only"])
        # 标记刷到输出上限时也是空片段，不该当成「输出被截断」让整段转写失败。
        with self.transport(lambda _: stream("length")):
            self.assertEqual(self.provider.recognize(self.audio).text, "")
        with self.transport(lambda _: httpx.Response(200, headers={"content-type": "text/event-stream"},
                                                     content=sse("<chinese>", finish="length"))):
            self.assertEqual(self.provider.recognize(self.audio).text, "")

    def test_noise_chunk_is_skipped_and_preview_stays_clean(self):
        sid, run = self.new_record()
        row = cloud.save_chunk(sid, run, 0, self.audio)
        with self.transport(lambda _: httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=sse("<chinese>" * 60))):
            text = cloud.recognize(sid, run, row, self.provider, self.cancel, self.emit)
        self.assertEqual(text, "")
        self.assertEqual(database.db.get_transcripts(sid), [])
        self.assertEqual(cloud.pending_previews(sid), [])
        previews = [e["text"] for e in self.events if e["kind"] == "transcript_partial"]
        self.assertTrue(previews)
        self.assertTrue(all(value == "" for value in previews))
        self.assertEqual(cloud.finish(sid, run, self.emit), [])
        self.assertEqual((database.db.get_session(sid)["meta"])["asr_status"], "empty")

    def test_cancel_stops_publication(self):
        self.cancel.set()
        with self.assertRaises(engines.Cancelled):
            self.provider.recognize(self.audio, cancel=self.cancel)
        sid, run = self.new_record()
        row = cloud.save_chunk(sid, run, 0, self.audio)
        def response(*args, **kwargs):
            self.cancel.set()
            return engines.Recognition("不会提交")
        self.cancel.clear()
        with patch.object(self.provider, "recognize", side_effect=response):
            with self.assertRaises(engines.Cancelled):
                cloud.recognize(sid, run, row, self.provider, self.cancel, self.emit)
        self.assertEqual(database.db.get_transcripts(sid), [])

    def test_restart_marks_interrupted_preview_and_preserves_text(self):
        sid, run = self.new_record()
        row = cloud.save_chunk(sid, run, 0, self.audio)
        cloud.preview(sid, row, "中断前的字", "streaming", self.emit)
        cloud.recover_interrupted()
        preview = cloud.pending_previews(sid)[0]
        self.assertEqual(preview["text"], "中断前的字")
        self.assertEqual(preview["state"], "error")

    def test_final_is_committed_once_and_reconnect_recovers_preview(self):
        sid, run = self.new_record()
        row = cloud.save_chunk(sid, run, 0, self.audio)
        with patch.object(self.provider, "recognize", return_value=engines.Recognition("完成")) as infer:
            cloud.recognize(sid, run, row, self.provider, self.cancel, self.emit)
            row = cloud.save_chunk(sid, run, 0, self.audio)
            cloud.recognize(sid, run, row, self.provider, self.cancel, self.emit)
        self.assertEqual(infer.call_count, 1)
        self.assertEqual(len(database.db.get_transcripts(sid)), 1)
        row2 = cloud.save_chunk(sid, run, 5, self.audio)
        cloud.preview(sid, row2, "部分文字", "error", self.emit)
        reopened = database.DB(database.DB_PATH)
        self.assertEqual(reopened.one("SELECT preview FROM asr_chunks WHERE chunk_id=?", (row2["chunk_id"],))["preview"], "部分文字")
        reopened._conn.close()
        self.assertEqual(cloud.pending_previews(sid)[0]["text"], "部分文字")
        self.assertEqual(cloud.begin(sid, self.config)["id"], run["id"])
        with self.assertRaises(engines.ProviderError):
            cloud.finish(sid, run, self.emit)
        self.assertEqual((database.db.get_session(sid)["meta"])["asr_failures"][0]["start"], 5)

    def test_detail_cursor_skips_committed_previews_and_resumes_new_text(self):
        sid, run = self.new_record()
        task = capture.CaptureTask(sid)
        task.emit("warn", text="画质提示")
        task.emit("status", text="开始采集直播流")
        row = cloud.save_chunk(sid, run, 0, self.audio)
        cloud.preview(sid, row, "前", "streaming", task.emit)
        cloud.preview(sid, row, "当前片段的完整内容", "streaming", task.emit)
        with patch.object(self.provider, "recognize", return_value=engines.Recognition("当前片段的完整内容")):
            cloud.recognize(sid, run, row, self.provider, self.cancel, task.emit)
        with patch.object(scheduler, "task_for", return_value=task):
            detail = self.client.get(f"/api/sessions/{sid}").json()
        self.assertEqual(detail["transcripts"][0]["text"], "当前片段的完整内容")
        self.assertEqual(detail["transcript_previews"], [])
        self.assertEqual(detail["event_stream_id"], task.event_cursor()["event_stream_id"])
        self.assertEqual(detail["event_warnings"], ["画质提示"])
        self.assertEqual(detail["event_status"], "开始采集直播流")
        self.assertEqual(task.events_since(detail["event_id"]), [],
                         "A loaded official transcript must not replay its earlier partial text")

        pending = cloud.save_chunk(sid, run, 5, self.audio)
        cloud.preview(sid, pending, "下一段", "streaming", task.emit)
        resumed = task.events_since(detail["event_id"])
        self.assertEqual(len(resumed), 1)
        self.assertEqual(resumed[0]["text"], "下一段")
        self.assertEqual(resumed[0]["event_stream_id"], detail["event_stream_id"])
        for replacement in (capture.CaptureTask(sid), meeting.MeetingTask(sid, params={}),
                            main.link_video.LinkTask(sid)):
            replacement.emit("status", text="新任务")
            self.assertNotEqual(replacement.event_cursor()["event_stream_id"], detail["event_stream_id"])
            self.assertEqual(replacement.event_cursor()["event_id"], 1)

    def test_detail_waits_for_cloud_text_and_event_to_be_published_together(self):
        # Hold publication after the DB change but before emit, precisely the old race.
        for operation in ("preview", "commit", "reset"):
            with self.subTest(operation=operation):
                sid, run = self.new_record()
                task = capture.CaptureTask(sid)
                row = cloud.save_chunk(sid, run, 0, self.audio)
                if operation == "reset":
                    with patch.object(self.provider, "recognize", return_value=engines.Recognition("完整内容")):
                        cloud.recognize(sid, run, row, self.provider, self.cancel, task.emit)
                reached, release, reading, read_done = (threading.Event() for _ in range(4))
                errors, responses = queue.Queue(), queue.Queue()

                def delayed_emit(kind, **payload):
                    reached.set()
                    if not release.wait(3):
                        raise TimeoutError("Test did not release publication")
                    task.emit(kind, **payload)

                def publish():
                    try:
                        if operation == "preview":
                            cloud.preview(sid, row, "完整内容", "streaming", delayed_emit)
                        elif operation == "commit":
                            cloud.recognize(sid, run, row, self.provider, self.cancel, delayed_emit)
                        else:
                            cloud.finish(sid, run, delayed_emit)
                    except BaseException as exc:
                        errors.put(exc)

                def read_detail():
                    reading.set()
                    try:
                        responses.put(main.sessions.get_session(sid))
                    except BaseException as exc:
                        errors.put(exc)
                    finally:
                        read_done.set()

                with patch.object(scheduler, "task_for", return_value=task), \
                     patch.object(self.provider, "recognize", return_value=engines.Recognition("完整内容")):
                    writer = threading.Thread(target=publish)
                    reader = threading.Thread(target=read_detail)
                    writer.start()
                    try:
                        self.assertTrue(reached.wait(2), "Cloud publication did not start")
                        reader.start()
                        self.assertTrue(reading.wait(1))
                        self.assertFalse(read_done.wait(.08),
                                         "Detail exposed cloud text before its matching event was published")
                    finally:
                        release.set()
                        writer.join(3)
                        if reader.ident is not None:
                            reader.join(3)
                    self.assertFalse(writer.is_alive() or reader.is_alive())
                    if not errors.empty():
                        raise errors.get()
                detail = responses.get_nowait()
                self.assertEqual(detail["event_id"], task.event_cursor()["event_id"])
                self.assertEqual(task.events_since(detail["event_id"]), [])
                if operation == "preview":
                    self.assertEqual(detail["transcript_previews"][0]["text"], "完整内容")
                else:
                    self.assertEqual(detail["transcripts"][0]["text"], "完整内容")
                    self.assertEqual(detail["transcript_previews"], [])

    def test_retranscription_keeps_old_text_and_speakers_until_full_success(self):
        sid, run = self.new_record(old=True)
        a = cloud.save_chunk(sid, run, 0, self.audio)
        b = cloud.save_chunk(sid, run, 5, self.audio)
        with patch.object(self.provider, "recognize", return_value=engines.Recognition("新转录")):
            cloud.recognize(sid, run, a, self.provider, self.cancel, self.emit)
        with self.assertRaises(engines.ProviderError):
            cloud.finish(sid, run, self.emit)
        self.assertEqual(database.db.get_transcripts(sid)[0]["text"], "旧转录")
        self.assertEqual(database.db.get_session(sid)["meta"]["speakers"], {"S1": "张老师"})
        with patch.object(self.provider, "recognize", return_value=engines.Recognition("另一段")):
            cloud.recognize(sid, run, b, self.provider, self.cancel, self.emit)
        cloud.finish(sid, run, self.emit)
        self.assertEqual([r["text"] for r in database.db.get_transcripts(sid)], ["新转录", "另一段"])
        self.assertEqual(cloud.pending_previews(sid), [])

    def test_stop_flushes_tail_and_live_queue_holds_ids_not_audio(self):
        sid, _ = self.new_record()
        task = capture.CaptureTask(sid)
        task._push_chunk([np.ones(16000, dtype=np.int16) * 1000], [1000], 0)
        self.assertIsInstance(task._asr_q.queue[0], str)
        task._asr_q.put(None)
        with patch.object(engines.MiMoProvider, "recognize", return_value=engines.Recognition("尾段")):
            task._asr_worker()
        self.assertIsNone(task._asr_error)
        self.assertEqual(database.db.get_transcripts(sid)[0]["text"], "尾段")
        self.assertTrue((database.session_dir(sid) / cloud.chunks(sid, task._cloud_run)[0]["audio_path"]).exists())

    def test_file_pipeline_and_resume_skip_completed_requests(self):
        sid, run = self.new_record(old=True)
        task = meeting.MeetingTask(sid, params={})
        wav = database.session_dir(sid) / "meeting_audio.wav"
        wav.write_bytes(engines.encode_wav(np.tile(self.audio, 5)))
        done = cloud.save_chunk(sid, run, 0, self.audio)
        with patch.object(self.provider, "recognize", return_value=engines.Recognition("已有新段")):
            cloud.recognize(sid, run, done, self.provider, self.cancel, self.emit)
        with patch.object(engines.MiMoProvider, "recognize", return_value=engines.Recognition("续段")) as infer:
            rows = cloud.transcribe_file(task, wav, self.config)
        self.assertEqual(rows[0][2], "已有新段")
        self.assertEqual(infer.call_count, len(rows) - 1)
        self.assertEqual(rows[-1][1], 25)

    def test_cloud_rows_stay_chunk_level_without_local_models(self):
        sid, run = self.new_record()
        task = meeting.MeetingTask(sid, params={})
        task._cloud_run = run
        wav = database.session_dir(sid) / "meeting_audio.wav"
        wav.write_bytes(engines.encode_wav(self.audio))
        done = cloud.save_chunk(sid, run, 0, self.audio)
        with patch.object(self.provider, "recognize", return_value=engines.Recognition("云端。")):
            cloud.recognize(sid, run, done, self.provider, self.cancel, self.emit)
        with patch.object(engines.MiMoProvider, "recognize", return_value=engines.Recognition("云端。")):
            rows = cloud.transcribe_file(task, wav, self.config)
        self.assertEqual("".join(r[2] for r in rows), "云端。")
        self.assertEqual(rows[0][3], None)
        meta = database.db.get_session(sid)["meta"]
        self.assertFalse(meta.get("aligned"))
        self.assertEqual(meta.get("timing_precision"), "chunk")
        self.assertEqual(meta.get("speakers"), {})

    def test_60_minute_simulated_live_chunk_processing(self):
        sid, _ = self.new_record()
        task = capture.CaptureTask(sid)
        block = np.ones(16000 * 15, dtype=np.int16) * 1000
        for index in range(240):
            task._push_chunk([block], [1000], index * len(block))
        task._asr_q.put(None)
        with patch.object(engines.MiMoProvider, "recognize", return_value=engines.Recognition("模拟直播")) as infer:
            task._asr_worker()
        self.assertEqual(infer.call_count, 240)
        self.assertEqual(len(database.db.get_transcripts(sid)), 240)
        self.assertEqual(task.asr_time, 3600)
        self.assertEqual(task._asr_q.qsize(), 0)
        self.assertIsNone(task._asr_error)

    def test_configuration_does_not_leak_key_and_old_records_remain_local(self):
        response = self.client.post("/api/asr/engines", json={"provider": "mimo", "api_key": "sensitive-test-key"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("sensitive-test-key", response.text)
        self.assertNotIn("sensitive-test-key", settings.PATH.read_text())
        self.assertEqual(engines.session_config({})["provider"], "local")
        self.assertFalse(engines.MiMoProvider.capabilities.audio_streaming)
        for url in ["http://example.com", "https://user:password@example.com", "https://example.com?v=secret"]:
            self.assertEqual(self.client.post("/api/asr/engines", json={"provider": "mimo", "base_url": url}).status_code, 400)

    def test_real_meeting_pipeline_uses_cloud_without_local_asr(self):
        sid, _ = self.new_record()
        media = database.session_dir(sid) / "media.wav"
        media.write_bytes(engines.encode_wav(self.audio))
        database.db.update_session(sid, media_path="media.wav", duration=5)
        task = meeting.MeetingTask(sid, params={})
        def extract(source, target):
            target.write_bytes(source.read_bytes())
        with patch.dict(capture.DEPS, {"ffmpeg": "/usr/bin/true"}), patch.object(task, "_extract_audio", side_effect=extract), patch.object(asr.manager, "is_ready", return_value=False), patch.object(engines.MiMoProvider, "recognize", return_value=engines.Recognition("云端会议")):
            task._run()
        self.assertEqual(database.db.get_session(sid)["status"], "done")
        self.assertEqual(database.db.get_transcripts(sid)[0]["text"], "云端会议")
        self.assertEqual(database.db.get_session(sid)["meta"]["timing_precision"], "chunk")
        self.assertFalse((database.session_dir(sid) / "meeting_audio.wav").exists())

    def test_failed_cloud_meeting_pipeline_preserves_old_metadata(self):
        sid, _ = self.new_record(old=True)
        media = database.session_dir(sid) / "media.wav"
        media.write_bytes(engines.encode_wav(self.audio))
        database.db.update_session(sid, media_path="media.wav", duration=5)
        task = meeting.MeetingTask(sid, params={})
        def extract(source, target):
            target.write_bytes(source.read_bytes())
        with patch.dict(capture.DEPS, {"ffmpeg": "/usr/bin/true"}), patch.object(task, "_extract_audio", side_effect=extract), patch.object(engines.MiMoProvider, "recognize", side_effect=engines.ProviderError("无权限", fatal=True)):
            task._run()
        self.assertEqual(database.db.get_session(sid)["status"], "error")
        self.assertEqual(database.db.get_transcripts(sid)[0]["text"], "旧转录")
        self.assertEqual(database.db.get_session(sid)["meta"]["speakers"], {"S1": "张老师"})
        self.assertTrue(database.db.get_session(sid)["meta"]["aligned"])

    def test_cloud_import_without_local_models_and_config_snapshot(self):
        settings.update(asr_provider="mimo")
        media = Path(TASK_DATA.name) / "sample.wav"
        media.write_bytes(engines.encode_wav(self.audio))
        with patch.object(asr.manager, "is_ready", return_value=False), patch.dict(capture.DEPS, {"ffmpeg": "/usr/bin/true"}), patch.object(scheduler, "start"):
            response = self.client.post("/api/meetings/import", json={"path": str(media)})
        self.assertEqual(response.status_code, 200, response.text)
        sid = response.json()["id"]
        before = engines.session_config(database.db.get_session(sid))
        settings.update(asr_provider="local", mimo_model="another-model")
        self.assertEqual(engines.session_config(database.db.get_session(sid)), before)
        scheduler.cancel(sid)
        settings.update(mimo_model=engines.DEFAULT_MODEL)


if __name__ == "__main__":
    unittest.main(verbosity=2)
