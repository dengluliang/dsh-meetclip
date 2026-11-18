"""备份与迁移：选择导出、清单、去重导入、媒体选项与安全拒绝。

每个用例自己造临时资料库；不联网、不加载模型，导入完成后只读数据库与压缩包。
"""
import importlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
import uuid
import zipfile
from unittest.mock import patch


class BackupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-backup-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.db = cls.database.db
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        cls.backup = importlib.import_module("backup")
        cls.cards = importlib.import_module("cards")
        cls.packs = importlib.import_module("packs")
        from fastapi.testclient import TestClient
        cls.TestClient = TestClient
        cls.client = TestClient(cls.main.app, base_url="http://127.0.0.1:8321",
                                headers={"X-MeetClip-Token": cls.auth.API_TOKEN})

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.db._conn.close()
        cls.environment.stop()
        cls.data.cleanup()

    def setUp(self):
        for table in ("backup_import_items", "card_pack_members", "card_packs", "marks",
                      "session_minutes", "session_minutes_interactions", "screenshots",
                      "transcripts", "sticky_notes", "board_images", "doc_cards", "sessions"):
            self.db.execute(f"DELETE FROM {table}")
        for name in ("会摘卡片", "board-images", "便利签", "卡包", "标记", "图片", "批次", "备份"):
            shutil.rmtree(Path(self.data.name) / name, ignore_errors=True)
        self.export_dir = tempfile.mkdtemp(prefix="meetclip-backup-out-")

    def tearDown(self):
        shutil.rmtree(self.export_dir, ignore_errors=True)

    # ---------------------------------------------------------------- helpers
    def session(self, title="测试会议", kind="meeting", status="done", notes="", media=False):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, title, "", source_type="live", kind=kind)
        self.db.update_session(sid, status=status, duration=12.0, started_at=time.time(), notes=notes)
        self.db.add_transcripts(sid, [
            (0.0, 2.0, "第一句转写", None),
            (2.0, 4.0, "第二句转写", "发言人 1"),
        ])
        mark_id = self.db.add_mark(sid, 1.5, "这里很重要")
        folder = Path(self.data.name) / sid
        (folder / "shots").mkdir(parents=True, exist_ok=True)
        (folder / "shots" / "3.0.jpg").write_bytes(b"\xff\xd8fake-jpeg")
        self.db.add_screenshot(sid, 3.0, "shots/3.0.jpg")
        (folder / "cover.jpg").write_bytes(b"\xff\xd8cover")
        if media:
            (folder / "media.mp4").write_bytes(b"0" * 4096)
            self.db.update_session(sid, media_path="media.mp4")
        self.db.save_minutes(sid, {"title": "摘要", "summary": "一句话", "topics": []}, 4.0, "final", "zh")
        self.db.save_minutes_interactions(sid, {"todos": {}, "highlights": []})
        return sid, mark_id

    def note(self, text="一条便利签"):
        row = self.db.create_sticky_note(text, "note", [], 10, 20)
        return row["id"]

    def image(self):
        iid = uuid.uuid4().hex[:12]
        rel = f"board-images/{iid}.png"
        target = Path(self.data.name) / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\x89PNG-fake")
        self.db.create_board_image(iid, rel, 12, 34, 5, 6)
        return iid

    def doc(self, token="DocToken123456"):
        result = self.cards.upsert_doc_card(
            f"https://demo.feishu.cn/docx/{token}", title="测试文档", content="正文快照"
        )
        return result["card"]["key"]

    def wait_job(self, timeout=15.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            payload = self.client.get("/api/backup/job").json()
            job = payload.get("job")
            if job and job.get("state") != "running":
                return job
            time.sleep(0.05)
        self.fail("备份任务没有在预期时间内结束")

    def export(self, items, include_media=False, dest=None):
        response = self.client.post("/api/backup/export", json={
            "dest": dest or self.export_dir,
            "include_media": include_media,
            "items": items,
        })
        self.assertEqual(response.status_code, 200, response.text)
        job = self.wait_job()
        self.assertEqual(job["state"], "done", job)
        return job["result"]

    def import_archive(self, path, include_media=False, skip_existing=True):
        response = self.client.post("/api/backup/import", json={
            "path": path,
            "include_media": include_media,
            "skip_existing": skip_existing,
        })
        self.assertEqual(response.status_code, 200, response.text)
        job = self.wait_job()
        return job

    # ------------------------------------------------------------------ 目录
    def test_catalog_lists_every_card_kind(self):
        sid, mark_id = self.session("目录记录", media=True)
        nid = self.note()
        iid = self.image()
        key = self.doc()
        self.packs.create_pack("", "测试卡包", [("session", sid), ("note", nid)])
        payload = self.client.get("/api/backup/catalog").json()
        self.assertTrue(payload["ok"])
        items = payload["items"]
        self.assertEqual(len(items["records"]), 1)
        self.assertEqual(items["records"][0]["title"], "目录记录")
        self.assertGreater(items["records"][0]["media_bytes"], 0)
        self.assertEqual(len(items["packs"]), 1)
        self.assertEqual(items["packs"][0]["count"], 2)
        self.assertEqual([item["id"] for item in items["notes"]], [nid])
        self.assertEqual([item["id"] for item in items["images"]], [iid])
        self.assertEqual([item["key"] for item in items["docs"]], [key])
        self.assertEqual(len(items["highlights"]), 1)
        self.assertEqual(items["highlights"][0]["id"], mark_id)
        self.assertTrue(payload["default_dest"].endswith("备份"))
        self.assertEqual(payload["format_version"], 1)

    # ------------------------------------------------------------------ 导出
    def test_export_manifest_layout_without_media(self):
        sid, _ = self.session(media=True)
        result = self.export([{"type": "session", "id": sid}])
        path = Path(result["path"])
        self.assertTrue(path.is_file())
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            self.assertIn("manifest.json", names)
            self.assertIn(f"records/{sid}/record.json", names)
            self.assertIn(f"records/{sid}/shots/3.0.jpg", names)
            self.assertIn(f"records/{sid}/cover.jpg", names)
            self.assertFalse(any("/media/" in name for name in names), names)
            self.assertFalse(any(name.startswith("asr_chunks") for name in names))
            manifest = json.loads(zf.read("manifest.json"))
            record = json.loads(zf.read(f"records/{sid}/record.json"))
        self.assertEqual(manifest["format"], "meetclip-backup")
        self.assertEqual(manifest["format_version"], 1)
        self.assertEqual(manifest["counts"]["records"], 1)
        self.assertEqual(manifest["counts"]["transcripts"], 2)
        self.assertFalse(manifest["options"]["include_media"])
        self.assertIsNone(record["session"]["media_path"])
        self.assertFalse(record["session"]["media_included"])
        self.assertEqual(len(record["screenshots"]), 1)
        self.assertEqual(record["minutes"]["data"]["summary"], "一句话")
        self.assertFalse(any("Cookie" in name or "settings.json" in name for name in names))

    def test_export_includes_media_and_cover_when_asked(self):
        sid, _ = self.session(media=True)
        result = self.export([{"type": "session", "id": sid}], include_media=True)
        with zipfile.ZipFile(result["path"]) as zf:
            names = set(zf.namelist())
            self.assertIn(f"records/{sid}/media/media.mp4", names)
            record = json.loads(zf.read(f"records/{sid}/record.json"))
        self.assertTrue(record["session"]["media_included"])
        self.assertEqual(record["session"]["media_path"], "media.mp4")

    def test_export_pack_pulls_members_and_highlight_parent(self):
        sid, mark_id = self.session()
        nid = self.note()
        iid = self.image()
        key = self.doc()
        self.packs.create_pack("", "整包导出", [
            ("session", sid), ("note", nid), ("image", iid), ("doc", f"doc:{key}"),
            ("highlight", str(mark_id)),
        ])
        pack_id = self.db.list_card_packs()[0]["id"]
        result = self.export([{"type": "pack", "id": pack_id}])
        with zipfile.ZipFile(result["path"]) as zf:
            names = set(zf.namelist())
            manifest = json.loads(zf.read("manifest.json"))
            self.assertIn(f"notes/{nid}.json", names)
            self.assertIn(f"images/{iid}.json", names)
            self.assertIn(f"docs/{key}.json", names)
            self.assertIn(f"packs/{pack_id}.json", names)
            pack = json.loads(zf.read(f"packs/{pack_id}.json"))
        self.assertEqual(manifest["counts"]["records"], 1)
        self.assertEqual(manifest["counts"]["packs"], 1)
        types = {member["type"] for member in pack["members"]}
        self.assertEqual(types, {"session", "note", "image", "doc", "highlight"})
        self.assertNotIn("doc:", [member["id"] for member in pack["members"]])

    # ------------------------------------------------------------------ 导入
    def reset_library(self):
        """清空当前资料库，模拟「另一个人的空资料库」；备份文件在 export_dir，不受影响。"""
        for table in ("backup_import_items", "card_pack_members", "card_packs", "marks",
                      "session_minutes", "session_minutes_interactions", "screenshots",
                      "transcripts", "sticky_notes", "board_images", "doc_cards", "sessions"):
            self.db.execute(f"DELETE FROM {table}")
        for entry in Path(self.data.name).iterdir():
            if entry.is_dir() and entry.name not in ("备份",) and entry.name != "会摘卡片":
                shutil.rmtree(entry, ignore_errors=True)
        shutil.rmtree(Path(self.data.name) / "会摘卡片", ignore_errors=True)

    def test_import_roundtrip_remaps_ids_and_restores_cards(self):
        sid, mark_id = self.session(notes="记录笔记")
        nid = self.note()
        iid = self.image()
        key = self.doc()
        self.packs.create_pack("", "往返卡包", [
            ("session", sid), ("note", nid), ("image", iid), ("doc", f"doc:{key}"),
            ("highlight", str(mark_id)),
        ])
        pack_id = self.db.list_card_packs()[0]["id"]
        result = self.export([{"type": "pack", "id": pack_id}])

        inspected = self.client.post("/api/backup/inspect", json={"path": result["path"]}).json()
        self.assertTrue(inspected["ok"])
        self.assertEqual(inspected["counts"]["records"], 1)
        self.assertEqual(inspected["already_imported"]["records"], 0)

        self.reset_library()
        self.assertEqual(self.db.query("SELECT id FROM sessions"), [])

        job = self.import_archive(result["path"])
        self.assertEqual(job["state"], "done", job)
        counts = job["result"]["counts"]
        self.assertEqual(counts["records"], 1)
        self.assertEqual(counts["packs"], 1)
        self.assertEqual(counts["notes"], 1)
        self.assertEqual(counts["images"], 1)
        self.assertEqual(counts["docs"], 1)

        sessions = self.db.query("SELECT * FROM sessions")
        self.assertEqual(len(sessions), 1)
        new_sid = sessions[0]["id"]
        self.assertNotEqual(new_sid, sid)
        self.assertEqual(len(self.db.get_transcripts(new_sid)), 2)
        self.assertEqual(sessions[0]["notes"], "记录笔记")
        marks = self.db.get_marks(new_sid)
        self.assertEqual(len(marks), 1)
        self.assertNotEqual(marks[0]["id"], mark_id)
        self.assertEqual(len(self.db.get_screenshots(new_sid)), 1)
        self.assertTrue((Path(self.data.name) / new_sid / "shots" / "3.0.jpg").is_file())
        self.assertTrue((Path(self.data.name) / new_sid / "cover.jpg").is_file())
        self.assertIsNotNone(self.db.get_minutes(new_sid))
        self.assertIsNotNone(self.db.get_minutes_interactions(new_sid))

        notes = self.db.list_sticky_notes()
        self.assertEqual(len(notes), 1)
        self.assertNotEqual(notes[0]["id"], nid)
        images = self.db.list_board_images()
        self.assertEqual(len(images), 1)
        self.assertTrue((Path(self.data.name) / images[0]["path"]).is_file())
        self.assertIsNotNone(self.db.get_doc_card(key))

        pack_rows = self.db.list_card_packs()
        self.assertEqual(len(pack_rows), 1)
        self.assertNotEqual(pack_rows[0]["id"], pack_id)
        members = self.db.list_card_pack_members(pack_rows[0]["id"])
        member_ids = {(member["member_type"], member["member_id"]) for member in members}
        self.assertIn(("session", new_sid), member_ids)
        self.assertIn(("highlight", str(marks[0]["id"])), member_ids)
        self.assertIn(("note", notes[0]["id"]), member_ids)
        self.assertIn(("image", images[0]["id"]), member_ids)
        self.assertIn(("doc", f"doc:{key}"), member_ids)

        card_dir = Path(self.data.name) / "会摘卡片"
        self.assertTrue(card_dir.is_dir())
        self.assertTrue(any("往返卡包" in name for name in os.listdir(card_dir / "卡包")))
        self.assertEqual(len(self.db.query("SELECT * FROM backup_import_items")), 6)

    def test_import_into_empty_library_skips_doc_existing(self):
        sid, _ = self.session()
        key = self.doc()
        result = self.export([{"type": "session", "id": sid}, {"type": "doc", "id": key}])
        job = self.import_archive(result["path"])
        self.assertEqual(job["state"], "done", job)
        self.assertEqual(job["result"]["counts"]["docs"], 0)
        self.assertEqual(job["result"]["skipped"]["docs"], 1)
        self.assertEqual(len(self.db.query("SELECT * FROM doc_cards")), 1)

    def test_import_skips_known_archive_then_can_copy_again(self):
        sid, _ = self.session()
        note_id = self.note()
        result = self.export([
            {"type": "session", "id": sid}, {"type": "note", "id": note_id},
        ])
        first = self.import_archive(result["path"])
        self.assertEqual(first["result"]["counts"]["records"], 1)
        sessions_after_first = self.db.query("SELECT id FROM sessions")
        self.assertEqual(len(sessions_after_first), 2)

        second = self.import_archive(result["path"])
        self.assertEqual(second["state"], "done", second)
        self.assertEqual(second["result"]["counts"]["records"], 0)
        self.assertEqual(second["result"]["skipped"]["records"], 1)
        self.assertEqual(len(self.db.query("SELECT id FROM sessions")), 2)

        third = self.import_archive(result["path"], skip_existing=False)
        self.assertEqual(third["result"]["counts"]["records"], 1)
        self.assertEqual(len(self.db.query("SELECT id FROM sessions")), 3)

    def test_import_with_media_and_without_media(self):
        sid, _ = self.session(media=True)
        result = self.export([{"type": "session", "id": sid}], include_media=True)
        job = self.import_archive(result["path"], include_media=True)
        self.assertEqual(job["state"], "done", job)
        new_session = self.db.query("SELECT * FROM sessions WHERE id<>?", (sid,))[0]
        self.assertEqual(new_session["media_path"], "media.mp4")
        self.assertTrue((Path(self.data.name) / new_session["id"] / "media.mp4").is_file())

        plain = self.export([{"type": "session", "id": sid}], include_media=False)
        job = self.import_archive(plain["path"], include_media=True)
        self.assertEqual(job["state"], "done", job)
        new_ids = [row["id"] for row in self.db.query("SELECT id FROM sessions WHERE id NOT IN (?,?)",
                                                     (sid, new_session["id"]))]
        self.assertEqual(len(new_ids), 1)
        missing_media = self.db.get_session(new_ids[0])
        self.assertIsNone(missing_media["media_path"])
        self.assertFalse((Path(self.data.name) / new_ids[0] / "media.mp4").exists())

    def test_import_normalizes_unfinished_status_and_batch(self):
        sid, _ = self.session(status="processing")
        result = self.export([{"type": "session", "id": sid}])
        job = self.import_archive(result["path"])
        self.assertEqual(job["state"], "done", job)
        new_session = self.db.query("SELECT * FROM sessions WHERE id<>?", (sid,))[0]
        self.assertEqual(new_session["status"], "done")

        a = uuid.uuid4().hex[:12]
        b = uuid.uuid4().hex[:12]
        batch_id = f"batch-{uuid.uuid4().hex[:6]}"
        for index, (ident, title) in enumerate(((a, "批次一"), (b, "批次二"))):
            self.db.create_session(ident, title, "", kind="link_video")
            self.db.update_session(ident, status="done", duration=5.0)
            self.db.update_meta(ident, batch={"id": batch_id, "title": "测试批次",
                                              "index": index, "created_at": time.time()})
        result = self.export([{"type": "batch", "id": batch_id}])
        with zipfile.ZipFile(result["path"]) as zf:
            manifest = json.loads(zf.read("manifest.json"))
        self.assertEqual(manifest["counts"]["records"], 2)
        self.assertEqual(manifest["counts"]["batches"], 1)
        job = self.import_archive(result["path"])
        self.assertEqual(job["state"], "done", job)
        imported = self.db.query(
            "SELECT id,meta FROM sessions WHERE kind='link_video' AND id NOT IN (?,?)", (a, b)
        )
        self.assertEqual(len(imported), 2)
        batch_ids = {json.loads(row["meta"]).get("batch", {}).get("id") for row in imported}
        self.assertEqual(len(batch_ids), 1)
        new_batch_id = batch_ids.pop()
        self.assertNotEqual(new_batch_id, batch_id)
        self.assertEqual(len(self.db.get_link_batch(new_batch_id)["members"]), 2)

    def test_missing_media_drops_unrepairable_chunk_flags(self):
        sid, _ = self.session(media=True)
        self.db.update_meta(sid, asr_failures=[{"start": 1, "end": 2}], asr_status="partial")
        result = self.export([{"type": "session", "id": sid}])
        job = self.import_archive(result["path"])
        self.assertEqual(job["state"], "done", job)
        imported = self.db.query("SELECT id FROM sessions WHERE id<>?", (sid,))[0]
        session = self.db.get_session(imported["id"])
        self.assertNotIn("asr_failures", session["meta"])
        self.assertEqual(session["meta"].get("asr_status"), "done")

    # ------------------------------------------------------------------ 拒绝
    def test_export_rejects_empty_selection_and_bad_dest(self):
        response = self.client.post("/api/backup/export", json={"dest": self.export_dir, "items": []})
        self.assertEqual(response.status_code, 400)
        sid, _ = self.session()
        response = self.client.post("/api/backup/export", json={
            "dest": "relative/path", "items": [{"type": "session", "id": sid}],
        })
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/backup/export", json={
            "dest": self.export_dir, "items": [{"type": "session", "id": "ffffffffffff"}],
        })
        self.assertEqual(response.status_code, 400)

    def test_inspect_rejects_bad_archives(self):
        cases = {}
        missing = Path(self.export_dir) / "missing-manifest.zip"
        with zipfile.ZipFile(missing, "w") as zf:
            zf.writestr("hello.txt", "hi")
        cases["missing"] = missing

        wrong = Path(self.export_dir) / "wrong-format.zip"
        with zipfile.ZipFile(wrong, "w") as zf:
            zf.writestr("manifest.json", json.dumps({"format": "other"}))
        cases["wrong"] = wrong

        newer = Path(self.export_dir) / "newer.zip"
        with zipfile.ZipFile(newer, "w") as zf:
            zf.writestr("manifest.json", json.dumps({
                "format": "meetclip-backup", "format_version": 2, "archive_id": "abc",
            }))
        cases["newer"] = newer

        slip = Path(self.export_dir) / "slip.zip"
        with zipfile.ZipFile(slip, "w") as zf:
            zf.writestr("manifest.json", json.dumps({
                "format": "meetclip-backup", "format_version": 1, "archive_id": "abc",
            }))
            zf.writestr("records/../evil.txt", "x")
        cases["slip"] = slip

        for label, path in cases.items():
            response = self.client.post("/api/backup/inspect", json={"path": str(path)})
            self.assertEqual(response.status_code, 400, f"{label}: {response.text}")

        response = self.client.post("/api/backup/inspect", json={"path": str(Path(self.export_dir) / "nope.zip")})
        self.assertEqual(response.status_code, 400)

    def test_import_keeps_database_consistent_when_archive_is_corrupt(self):
        sid, _ = self.session()
        result = self.export([{"type": "session", "id": sid}])
        with zipfile.ZipFile(result["path"]) as zf:
            payload = {name: zf.read(name) for name in zf.namelist()}
        broken = Path(self.export_dir) / "broken.zip"
        with zipfile.ZipFile(broken, "w") as zf:
            for name, data in payload.items():
                if name.endswith("record.json"):
                    data = b"{not json"
                zf.writestr(name, data)
        job = self.import_archive(str(broken))
        self.assertEqual(job["state"], "error", job)
        self.assertEqual(len(self.db.query("SELECT id FROM sessions")), 1)
        self.assertEqual(self.db.query("SELECT * FROM backup_import_items"), [])


if __name__ == "__main__":
    unittest.main()
