"""首页聚合接口：临时数据目录，不加载模型、不访问网络。"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import shutil
import time
import unittest
from unittest.mock import patch
import uuid


class HomeFeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-home-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.db = cls.database.db
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        cls.sessions = importlib.import_module("routes.sessions")
        cls.cards = importlib.import_module("cards")
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
        self.db.execute("DELETE FROM marks")
        self.db.execute("DELETE FROM sticky_notes")
        self.db.execute("DELETE FROM board_images")
        self.db.execute("DELETE FROM screenshots")
        self.db.execute("DELETE FROM transcripts")
        self.db.execute("DELETE FROM sessions")
        self.db.execute("DELETE FROM doc_cards")
        card_dir = Path(self.data.name) / "会摘卡片"
        if card_dir.exists():
            shutil.rmtree(card_dir, ignore_errors=True)

    def session(self, title, kind="live", status="done", duration=60, notes="", cover=True):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, title, "", source_type="live", kind=kind)
        self.db.update_session(sid, status=status, duration=duration, notes=notes,
                               started_at=time.time())
        if cover:
            self.db.add_screenshot(sid, 1, "shots/cover.jpg")
        return sid

    def test_documents_are_listed_on_home(self):
        self.cards.upsert_doc_card(
            "https://example.feishu.cn/docx/ExampleDocToken1",
            title="会议纪要：物模型白皮书",
            content="🎉 总结\n正文",
            document_id="ExampleDocToken1",
            revision="2",
        )
        payload = self.client.get("/api/home?limit=10").json()
        self.assertEqual(len(payload["documents"]), 1)
        doc = payload["documents"][0]
        self.assertEqual(doc["title"], "会议纪要：物模型白皮书")
        self.assertTrue(doc["has_content"])
        self.assertEqual(doc["doc_type"], "docx")
        self.assertIn("会摘卡片/", doc["path"])

    def test_requires_token(self):
        bare = self.TestClient(self.main.app, base_url="http://127.0.0.1:8321")
        self.assertEqual(bare.get("/api/home").status_code, 401)

    def test_feed_stats_covers_and_highlights(self):
        sid = self.session("带标记的直播", notes="")
        self.db.execute(
            "INSERT INTO transcripts(session_id,start,end,text,created_at) VALUES(?,?,?,?,?)",
            (sid, 0, 3, "第一段转写内容", time.time()))
        self.db.add_mark(sid, 7, "这句很重要")
        self.db.add_mark(sid, 9, "   ")
        unreviewed = self.session("还没整理", status="done", notes="")
        recording = self.session("正在直播", status="recording", notes="")
        self.db.update_meta(sid, source_meta={"thumbnail": "https://example.com/cover.jpg"})

        payload = self.client.get("/api/home?limit=10").json()
        self.assertEqual(payload["stats"]["total"], 3)
        self.assertEqual(payload["stats"]["recording"], 1)
        self.assertEqual(payload["stats"]["marks"], 2)  # 空批注不进入金句，但仍算标记数
        self.assertEqual(payload["stats"]["unreviewed"], 1)
        items = payload["items"]
        self.assertEqual(items[0]["id"], recording)
        by_id = {item["id"]: item for item in items}
        self.assertEqual(by_id[sid]["cover"], {"type": "remote", "value": "https://example.com/cover.jpg"})
        self.assertEqual(by_id[sid]["snippet"], "第一段转写内容")
        self.assertEqual(by_id[sid]["marks"], 2)
        self.assertTrue(by_id[unreviewed]["unreviewed"])
        self.assertFalse(by_id[sid]["unreviewed"])
        self.assertEqual(len(payload["highlights"]), 1)
        self.assertEqual(payload["highlights"][0]["note"], "这句很重要")
        self.assertEqual(payload["highlights"][0]["session_title"], "带标记的直播")

    def test_pagination_and_limit_validation(self):
        for index in range(3):
            self.session(f"记录 {index}", cover=False)
        first = self.client.get("/api/home?limit=1&offset=0").json()
        second = self.client.get("/api/home?limit=1&offset=1").json()
        self.assertEqual(len(first["items"]), 1)
        self.assertEqual(len(second["items"]), 1)
        self.assertNotEqual(first["items"][0]["id"], second["items"][0]["id"])
        self.assertIsNone(first["items"][0]["cover"])
        self.assertEqual(self.client.get("/api/home?limit=0").status_code, 400)
        self.assertEqual(self.client.get("/api/home?limit=201").status_code, 400)
        self.assertEqual(self.client.get("/api/home?offset=-1").status_code, 400)

    def test_remote_thumbnail_carries_local_fallback(self):
        sid = self.session("X 视频", kind="link_video", cover=False)
        self.db.update_meta(sid, source_meta={"thumbnail": "https://pbs.twimg.com/x.jpg"})
        with patch.object(self.sessions.media_cover, "cover_file", return_value=Path("/tmp/cover.jpg")):
            item = self.client.get("/api/home").json()["items"][0]
        self.assertEqual(item["cover"]["type"], "file")
        self.assertEqual(item["cover"]["value"], "cover.jpg")
        self.assertEqual(item["cover"]["fallback"], {"type": "remote", "value": "https://pbs.twimg.com/x.jpg"})

    def test_first_screenshot_is_fallback_cover(self):
        sid = self.session("会议", kind="meeting", cover=False)
        self.db.add_screenshot(sid, 5, "shots/first.jpg")
        self.db.add_screenshot(sid, 9, "shots/second.jpg")
        item = self.client.get("/api/home").json()["items"][0]
        self.assertEqual(item["cover"], {"type": "file", "value": "shots/first.jpg"})


    def test_sticky_notes_todo_and_toggle(self):
        created = self.client.post("/api/sticky-notes", json={
            "text": "跟进事项\n- 确认场地\n- 发出邀请", "x": 120, "y": 80,
        })
        self.assertEqual(created.status_code, 200, created.text)
        note = created.json()
        self.assertEqual(note["kind"], "todo")
        self.assertEqual(note["checked"], [False, False])
        listed = self.client.get("/api/sticky-notes").json()
        self.assertEqual(len(listed), 1)
        patched = self.client.patch(f"/api/sticky-notes/{note['id']}", json={"checked": [True, False]})
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["checked"], [True, False])
        self.assertEqual(self.client.delete(f"/api/sticky-notes/{note['id']}").status_code, 200)
        self.assertEqual(self.client.get("/api/sticky-notes").json(), [])

    def test_sticky_note_plain_text(self):
        created = self.client.post("/api/sticky-notes", json={"text": "只是一条便签", "x": 10, "y": 10})
        note = created.json()
        self.assertEqual(note["kind"], "note")
        self.assertEqual(note["checked"], [])

    def test_board_image_upload_and_delete(self):
        png = bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02"
            "0000000b4944415478da63fcff1f0002eb01f58f59d09f0000000049454e44ae426082"
        )
        created = self.client.post(
            "/api/board/images",
            files={"file": ("pixel.png", png, "image/png")},
            data={"x": "120", "y": "80", "width": "1", "height": "1"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        row = created.json()
        self.assertTrue((self.database.DATA_DIR / row["path"]).is_file())
        self.assertEqual(len(self.client.get("/api/board/images").json()), 1)
        served = self.client.get(f"/api/board/images/{row['id']}/file")
        self.assertEqual(served.status_code, 200)
        self.assertEqual(self.client.delete(f"/api/board/images/{row['id']}").status_code, 200)
        self.assertFalse((self.database.DATA_DIR / row["path"]).exists())
        self.assertEqual(self.client.get("/api/board/images").json(), [])

    def _heic_payload(self, size=(96, 64)):
        """优先用 macOS sips 造一张真 HEIC；没有 sips 时尝试 pillow-heif。"""
        import shutil
        import subprocess
        from PIL import Image

        def build_via_sips(tmp):
            png = Path(tmp) / "src.png"
            heic = Path(tmp) / "src.heic"
            Image.new("RGB", size, (190, 120, 70)).save(png)
            sips = shutil.which("sips")
            if not sips:
                return None
            result = subprocess.run([sips, "-s", "format", "heic", str(png), "--out", str(heic)],
                                    capture_output=True)
            return heic.read_bytes() if result.returncode == 0 and heic.is_file() else None

        def build_via_pillow_heif(tmp):
            png = Path(tmp) / "src.png"
            heic = Path(tmp) / "src.heic"
            Image.new("RGB", size, (190, 120, 70)).save(png)
            try:
                from pillow_heif import from_pillow
            except Exception:
                return None
            with Image.open(png) as image:
                from_pillow(image).save(heic)
            return heic.read_bytes() if heic.is_file() else None

        with tempfile.TemporaryDirectory(prefix="meetclip-heic-") as tmp:
            payload = build_via_sips(tmp) or build_via_pillow_heif(tmp)
        if not payload:
            raise unittest.SkipTest("当前环境没有 sips 或 pillow-heif，无法生成 HEIC 样本")
        return payload

    def test_heif_upload_converts_to_jpeg(self):
        payload = self._heic_payload()
        created = self.client.post(
            "/api/board/images",
            files={"file": ("IMG_0001.HEIC", payload, "image/heic")},
            data={"x": "30", "y": "40", "width": "0", "height": "0"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        row = created.json()
        self.assertTrue(row["path"].endswith(".jpg"), row)
        stored = self.database.DATA_DIR / row["path"]
        self.assertTrue(stored.is_file())
        self.assertFalse((self.database.DATA_DIR / f"board-images/{row['id']}.heic").exists())
        from PIL import Image
        with Image.open(stored) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.size, (96, 64))
        self.assertEqual((row["width"], row["height"]), (96, 64))
        served = self.client.get(f"/api/board/images/{row['id']}/file")
        self.assertEqual(served.status_code, 200)
        self.assertEqual(served.headers.get("content-type"), "image/jpeg")
        self.assertEqual(self.client.delete(f"/api/board/images/{row['id']}").status_code, 200)
        self.assertFalse(stored.exists())

    def test_heif_upload_accepts_missing_mime(self):
        payload = self._heic_payload()
        created = self.client.post(
            "/api/board/images",
            files={"file": ("IMG_0002.heic", payload, "application/octet-stream")},
            data={"x": "0", "y": "0", "width": "0", "height": "0"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        row = created.json()
        self.assertTrue(row["path"].endswith(".jpg"), row)
        self.assertEqual((row["width"], row["height"]), (96, 64))

    def test_broken_heif_is_rejected_without_leaving_files(self):
        created = self.client.post(
            "/api/board/images",
            files={"file": ("broken.heic", b"not a heif at all", "image/heic")},
            data={"x": "0", "y": "0", "width": "0", "height": "0"},
        )
        self.assertEqual(created.status_code, 400, created.text)
        self.assertEqual(self.client.get("/api/board/images").json(), [])
        leftovers = list((self.database.DATA_DIR / "board-images").glob("*.heic"))
        self.assertEqual(leftovers, [])

    def test_link_batches_group_members_and_counts(self):
        first = self.session("批次一", kind="link_video", status="done", cover=False)
        second = self.session("批次二", kind="link_video", status="error", cover=False)
        solo = self.session("单条", kind="link_video", status="queued", cover=False)
        batch = {"id": "b1", "title": "批量视频 · 测试", "created_at": 123.0, "total": 3}
        self.db.update_meta(first, batch={**batch, "index": 1})
        self.db.update_meta(second, batch={**batch, "index": 0})
        payload = self.client.get("/api/home").json()
        self.assertEqual(len(payload["batches"]), 1)
        grouped = payload["batches"][0]
        self.assertEqual(grouped["id"], "b1")
        self.assertEqual(grouped["title"], "批量视频 · 测试")
        self.assertEqual([member["id"] for member in grouped["members"]], [second, first])
        self.assertEqual(grouped["total"], 2)
        self.assertEqual(grouped["counts"], {"queued": 0, "processing": 0, "done": 1, "error": 1, "cancelled": 0})
        self.assertEqual(grouped["active"], 0)
        self.assertEqual({item["id"] for item in payload["items"]}, {first, second, solo})
        self.assertNotIn(solo, [member["id"] for member in grouped["members"]])

    def test_appended_batch_moves_to_the_top(self):
        older = self.session("早批次成员", kind="link_video", status="done", cover=False)
        newer = self.session("新批次成员", kind="link_video", status="done", cover=False)
        old_batch = {"id": "b-old", "title": "早批次", "created_at": 100.0, "total": 1}
        new_batch = {"id": "b-new", "title": "新批次", "created_at": 200.0, "total": 1}
        self.db.update_meta(older, batch={**old_batch, "index": 0})
        self.db.update_meta(newer, batch={**new_batch, "index": 0})
        batches = self.client.get("/api/home").json()["batches"]
        self.assertEqual([batch["id"] for batch in batches], ["b-new", "b-old"])

        self.db.update_meta(older, batch={**old_batch, "index": 0, "updated_at": 300.0})
        batches = self.client.get("/api/home").json()["batches"]
        self.assertEqual([batch["id"] for batch in batches], ["b-old", "b-new"])
        self.assertEqual(batches[0]["created_at"], 100.0)
        self.assertNotIn("last_index", batches[0])

    def test_meeting_options_hide_removed_models(self):
        options = self.client.get("/api/meeting/options").json()
        self.assertNotIn("aligner_ready", options)
        self.assertNotIn("diarize", options)
        self.assertIn("asr_ready", options)

    def test_legacy_models_are_listed_and_deleted(self):
        target = self.database.DATA_DIR / "models" / "Qwen3-ForcedAligner-0.6B-8bit"
        target.mkdir(parents=True)
        (target / "config.json").write_text("{}")
        listed = self.client.get("/api/models/legacy").json()
        aligner = next(item for item in listed["models"] if item["id"] == "aligner")
        self.assertTrue(aligner["exists"])
        self.assertGreater(aligner["size_on_disk"], 0)
        self.assertEqual(self.client.delete("/api/models/legacy/aligner").status_code, 200)
        self.assertFalse(target.exists())
        self.assertEqual(self.client.delete("/api/models/legacy/unknown").status_code, 404)

if __name__ == "__main__":
    unittest.main()
