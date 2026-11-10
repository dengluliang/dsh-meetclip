"""统一队列集成验证：临时数据库、模拟处理管线，不加载模型或访问网络。"""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid


class TaskQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-queue-tests-")
        cls.env = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.env.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        cls.db = cls.database.db
        cls.scheduler = importlib.import_module("scheduler")
        cls.capture = importlib.import_module("capture")
        cls.meeting = importlib.import_module("meeting")
        cls.real_meeting_start = staticmethod(cls.meeting.start_meeting)
        cls.link = importlib.import_module("link_video")
        cls.main = importlib.import_module("main")
        from fastapi.testclient import TestClient
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": cls.main.auth.API_TOKEN})

    @classmethod
    def tearDownClass(cls):
        cls.scheduler.shutdown()
        cls.client.close()
        cls.db._conn.close()
        cls.env.stop()
        cls.data.cleanup()

    def setUp(self):
        self.scheduler.shutdown()
        for row in self.db.list_sessions():
            self.db.delete_session(row["id"])
        self.link.manager._stopping = False
        self.link.manager.resume()
        self.started = []
        self.gates = {}
        self.finished = {}
        self.running = 0
        self.max_running = 0
        self.patches = [
            patch.object(self.capture, "start_capture", side_effect=self.launch),
            patch.object(self.meeting, "start_meeting", side_effect=self.launch),
            patch.object(self.link.manager, "launch", side_effect=self.launch),
            patch.object(self.capture, "check_bilibili_live", return_value={"ok": True, "title": "发布会"}),
            patch.object(self.capture.asr.manager, "is_ready", return_value=True),
            patch.dict(self.capture.DEPS, {"ffmpeg": "/usr/bin/true"}),
            patch.object(self.link, "preview", return_value={"ok": True, "normalized_url": "https://youtu.be/test",
                                                           "platform": "youtube", "title": "链接视频"}),
        ]
        for p in self.patches:
            p.start()
        self.media = Path(self.data.name) / "会议录音.m4a"
        self.media.write_bytes(b"saved-media" * 1024)
        self.blocker = self.new_session()
        self.assertTrue(self.scheduler.try_reserve(self.blocker))

    def tearDown(self):
        self.scheduler.shutdown()
        for gate in list(self.gates.values()):
            gate.set()
        for finished in list(self.finished.values()):
            self.assertTrue(finished.wait(3))
        if self.scheduler.owner() == self.blocker:
            self.scheduler.release(self.blocker)
        self.assertIsNone(self.scheduler.owner())
        for p in reversed(self.patches):
            p.stop()

    def new_session(self, kind="meeting"):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, kind, "", kind=kind)
        return sid

    def launch(self, sid, **_params):
        suite = self

        class FakeTask:
            def __init__(self):
                self.finished = threading.Event()
                self.cancelled = False

            def start(self):
                suite.started.append(sid)
                suite.running += 1
                suite.max_running = max(suite.max_running, suite.running)
                suite.gates[sid] = threading.Event()
                suite.finished[sid] = self.finished
                threading.Thread(target=self.run, daemon=True).start()

            def run(self):
                suite.gates[sid].wait(5)
                suite.db.update_session(sid, status="cancelled" if self.cancelled else "done")
                if suite.db.get_link_job(sid):
                    suite.db.update_link_job(sid, job_state="cancelled" if self.cancelled else "done")
                suite.running -= 1
                suite.scheduler.release(sid, self)
                self.finished.set()

            def cancel(self):
                self.cancelled = True
                suite.gates[sid].set()

        return self.scheduler.acquire(sid, FakeTask)

    def wait_for(self, predicate):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail(f"等待任务状态超时；已启动：{self.started}")

    def finish(self, sid):
        self.wait_for(lambda: sid in self.gates)
        self.gates[sid].set()
        self.assertTrue(self.finished[sid].wait(3))

    def enqueue(self, kind="meeting", **params):
        sid = self.new_session("live" if kind == "capture" else kind)
        if kind == "link_video":
            self.db.create_link_job(sid, self.db.next_link_queue_order())
        self.scheduler.enqueue(sid, kind, **params)
        return sid

    def test_busy_imports_all_three_scenarios_are_accepted_and_run_fifo(self):
        meeting = self.client.post("/api/meetings/import", json={"path": str(self.media), "hotwords": "苹果"})
        live = self.new_session("live")
        self.db.update_session(live, source_url="https://live.bilibili.com/1")
        launch = self.client.post(f"/api/sessions/{live}/start")
        links = self.client.post("/api/link-videos/batch", json={"items": [{"url": "https://youtu.be/test"}]})
        for response in (meeting, launch, links):
            self.assertEqual(response.status_code, 200, response.text)
        ids = [meeting.json()["id"], live, links.json()["results"][0]["id"]]
        self.assertEqual([r["session_id"] for r in self.scheduler.snapshot()["jobs"]], ids)
        for index, sid in enumerate(ids, 1):
            detail = self.client.get(f"/api/sessions/{sid}").json()
            self.assertEqual((detail["status"], detail["queue_position"], detail["processing"]), ("queued", index, True))
        self.assertTrue(self.media.exists())
        self.assertEqual(self.started, [])
        self.scheduler.release(self.blocker)
        for sid in ids:
            self.finish(sid)
        self.assertEqual(self.started, ids)
        self.assertEqual(self.max_running, 1)
        self.assertEqual(self.db.get_session(ids[0])["meta"]["hotwords"], "苹果")

    def test_live_start_and_retranscribe_join_same_queue(self):
        live = self.new_session("live")
        self.db.update_session(live, source_url="https://live.bilibili.com/1")
        response = self.client.post(f"/api/sessions/{live}/start")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["queued"])
        sid = self.new_session()
        media = self.database.session_dir(sid) / "media.m4a"
        media.write_bytes(self.media.read_bytes())
        self.db.update_session(sid, status="done", media_path="media.m4a")
        self.db.add_transcript(sid, 0, 1, "原转写")
        response = self.client.post(f"/api/sessions/{sid}/retranscribe")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["queue_position"], 2)
        self.assertEqual(self.db.get_transcripts(sid)[0]["text"], "原转写")

    def test_cancel_waiting_task_removes_it_and_updates_positions(self):
        first, cancelled, third = [self.enqueue() for _ in range(3)]
        response = self.client.post(f"/api/sessions/{cancelled}/cancel")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.db.get_session(cancelled)["status"], "cancelled")
        self.assertEqual(self.scheduler.info(third)["queue_position"], 2)
        self.scheduler.release(self.blocker)
        self.finish(first)
        self.finish(third)
        self.assertEqual(self.started, [first, third])

    def test_running_cancel_releases_slot_before_starting_next(self):
        first, second = self.enqueue(), self.enqueue()
        self.scheduler.release(self.blocker)
        self.wait_for(lambda: first in self.gates)
        response = self.client.post(f"/api/sessions/{first}/cancel")
        self.assertEqual(response.status_code, 200, response.text)
        self.finish(second)
        self.assertEqual(self.db.get_session(first)["status"], "cancelled")
        self.assertEqual(self.max_running, 1)

    def test_queued_records_cannot_be_deleted_duplicated_or_reconfigured(self):
        sid = self.enqueue(params={"hotwords": "固定参数"})
        for response in (self.client.delete(f"/api/sessions/{sid}"),
                         self.client.post(f"/api/sessions/{sid}/duplicate"),
                         self.client.patch(f"/api/sessions/{sid}/options", json={"hotwords": "变化"})):
            self.assertEqual(response.status_code, 409, response.text)
        self.assertIsNotNone(self.db.get_session(sid))

    def test_paused_link_queue_does_not_block_other_scenarios(self):
        self.link.manager.pause()
        link = self.enqueue("link_video")
        meeting = self.enqueue()
        self.assertTrue(self.scheduler.info(link)["queue_paused"])
        self.scheduler.release(self.blocker)
        self.finish(meeting)
        self.assertEqual(self.started, [meeting])
        self.link.manager.resume()
        self.finish(link)
        self.assertEqual(self.started, [meeting, link])

    def test_factory_failure_marks_error_and_continues(self):
        failed, next_sid = self.enqueue(), self.enqueue("capture")
        with self.assertLogs(level="ERROR"), \
                patch.object(self.meeting, "start_meeting", side_effect=RuntimeError("源文件已移除")):
            self.scheduler.release(self.blocker)
            self.finish(next_sid)
        self.assertEqual(self.db.get_session(failed)["status"], "error")
        self.assertIn("源文件已移除", self.db.get_session(failed)["error"])
        self.assertFalse(self.scheduler.is_queued(failed))

    def test_failed_thread_start_does_not_leak_slot(self):
        failed, next_sid = self.enqueue(), self.enqueue("capture")

        class BadTask:
            def start(self):
                raise RuntimeError("线程无法启动")

        with self.assertLogs(level="ERROR"), \
                patch.object(self.meeting, "start_meeting", side_effect=lambda sid, **kw: self.scheduler.acquire(sid, BadTask)):
            self.scheduler.release(self.blocker)
            self.finish(next_sid)
        self.assertFalse(self.scheduler.is_queued(failed))
        self.assertEqual(self.db.get_session(failed)["status"], "error")

    def test_repeat_submission_does_not_add_or_reorder_task(self):
        sid, second = self.enqueue(), self.enqueue()
        original = self.scheduler.info(sid)
        self.scheduler.enqueue(sid, "meeting", params={"hotwords": "重复"})
        self.assertEqual(self.scheduler.info(sid), original)
        self.assertEqual(len(self.scheduler.snapshot()["jobs"]), 2)
        self.scheduler.release(self.blocker)
        self.wait_for(lambda: sid in self.gates)
        self.scheduler.enqueue(sid, "meeting")
        self.finish(sid)
        self.finish(second)
        self.assertEqual(self.started, [sid, second])

    def test_concurrent_submissions_run_in_persisted_order_with_one_slot(self):
        ids = [self.new_session() for _ in range(12)]
        threads = [threading.Thread(target=self.scheduler.enqueue, args=(sid, "meeting")) for sid in ids]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        expected = [r["session_id"] for r in self.scheduler.snapshot()["jobs"]]
        self.assertEqual(set(expected), set(ids))
        self.scheduler.release(self.blocker)
        for sid in expected:
            self.finish(sid)
        self.assertEqual(self.started, expected)
        self.assertEqual(self.max_running, 1)

    def test_restart_preserves_queued_parameters_and_order(self):
        first = self.enqueue(import_file=str(self.media), params={"language": "Chinese", "hotwords": "苹果", "diarize": False})
        second = self.enqueue("capture", import_file=str(self.media))
        self.scheduler.shutdown()
        self.scheduler.release(self.blocker)
        reopened = self.database.DB(Path(self.data.name) / "zhibo.db")
        rows = reopened.query("SELECT * FROM task_queue ORDER BY id")
        reopened._conn.close()
        self.assertEqual([r["session_id"] for r in rows], [first, second])
        self.assertEqual(json.loads(rows[0]["payload"])["params"]["hotwords"], "苹果")
        self.scheduler.recover()
        self.scheduler.start()
        self.finish(first)
        self.finish(second)
        self.assertEqual(self.started, [first, second])

    def test_interrupted_running_record_is_not_started_again(self):
        interrupted, waiting = self.enqueue("capture"), self.enqueue()
        self.scheduler.shutdown()
        self.db.execute("UPDATE task_queue SET state='running' WHERE session_id=?", (interrupted,))
        self.db.update_session(interrupted, status="processing")
        self.capture.recover_interrupted()
        self.scheduler.recover()
        self.assertEqual(self.db.get_session(interrupted)["status"], "error")
        self.assertFalse(self.scheduler.is_queued(interrupted))
        self.assertEqual(self.db.get_session(waiting)["status"], "queued")

    def test_cancelled_link_cannot_be_readded_by_stale_queue_scan(self):
        sid = self.enqueue("link_video")
        response = self.client.post(f"/api/link-videos/{sid}/cancel")
        self.assertEqual(response.status_code, 200, response.text)
        self.scheduler.enqueue(sid, "link_video")
        self.assertFalse(self.scheduler.is_queued(sid))
        self.assertEqual(self.db.get_link_job(sid)["job_state"], "cancelled")

    def test_model_loading_keeps_restored_tasks_queued_until_ready(self):
        meeting, launch = self.enqueue(), self.enqueue("capture")
        with patch.object(self.capture.asr.manager, "is_loading", return_value=True) as loading:
            self.scheduler.release(self.blocker)
            time.sleep(0.1)
            self.assertEqual(self.started, [])
            self.assertEqual(self.db.get_session(meeting)["status"], "queued")
            loading.return_value = False
            self.scheduler.changed.set()
            self.finish(meeting)
            self.finish(launch)
        self.assertEqual(self.started, [meeting, launch])

    def test_queued_meeting_runs_real_pipeline_and_releases_slot(self):
        sid = self.enqueue(import_file=str(self.media), params={"language": "Chinese", "hotwords": "苹果", "diarize": False})
        next_sid = self.enqueue("capture")
        result = SimpleNamespace(text="真实管线转写", segments=[], chunks=[{"text": "真实管线转写。", "start": 0, "end": 1}],
                                 truncated=False, language="Chinese")

        def extract(_task, _media, wav):
            wav.write_bytes(b"\0" * 4096)

        import numpy as np
        with patch.object(self.meeting, "start_meeting", side_effect=self.real_meeting_start), \
                patch.object(self.meeting, "probe_streams", return_value=(False, True, 1)), \
                patch.object(self.meeting.MeetingTask, "_make_playable", side_effect=lambda media, _has_v: media), \
                patch.object(self.meeting.MeetingTask, "_extract_audio", extract), \
                patch.object(self.meeting, "_load_wav", return_value=np.zeros(16000, dtype=np.float32)), \
                patch.object(self.capture.asr.manager, "transcribe_long", return_value=result):
            self.scheduler.release(self.blocker)
            self.finish(next_sid)
        self.assertEqual(self.db.get_session(sid)["status"], "done", self.db.get_session(sid)["error"])
        self.assertEqual(self.db.get_transcripts(sid)[0]["text"], "真实管线转写。")
        self.assertFalse(self.scheduler.is_queued(sid))

    def test_interrupted_link_recovers_in_original_queue_position(self):
        link, meeting = self.enqueue("link_video"), self.enqueue()
        self.scheduler.shutdown()
        self.db.execute("UPDATE task_queue SET state='running' WHERE session_id=?", (link,))
        self.db.update_session(link, status="processing")
        self.db.update_link_job(link, job_state="downloading", phase="downloading")
        self.scheduler.recover()
        self.link.manager.start()
        self.assertEqual(self.scheduler.info(link)["queue_position"], 1)
        self.assertEqual(self.db.get_link_job(link)["job_state"], "queued")
        self.scheduler.release(self.blocker)
        self.finish(link)
        self.finish(meeting)

    def test_link_retry_joins_tail_after_other_scenarios(self):
        link = self.enqueue("link_video")
        self.client.post(f"/api/link-videos/{link}/cancel")
        meeting = self.enqueue()
        response = self.client.post(f"/api/link-videos/{link}/retry")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.scheduler.info(link)["queue_position"], 2)
        self.scheduler.release(self.blocker)
        self.finish(meeting)
        self.finish(link)
        self.assertEqual(self.started, [meeting, link])

    def test_session_list_exposes_queue_positions_for_all_scenarios(self):
        ids = [self.enqueue(kind) for kind in ("capture", "meeting", "link_video")]
        rows = {r["id"]: r for r in self.client.get("/api/sessions").json()}
        self.assertEqual([rows[sid]["queue_position"] for sid in ids], [1, 2, 3])
        response = self.client.get("/api/sessions", headers={"X-MeetClip-Token": "wrong"})
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
