"""首页卡包：临时数据目录，不加载模型、不访问网络。"""
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


class PackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-pack-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.db = cls.database.db
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
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
        for table in ("card_pack_members", "card_packs", "marks", "sticky_notes",
                      "board_images", "screenshots", "transcripts", "doc_cards", "sessions"):
            self.db.execute(f"DELETE FROM {table}")
        card_dir = Path(self.data.name) / "会摘卡片"
        if card_dir.exists():
            shutil.rmtree(card_dir, ignore_errors=True)

    def session(self, title, kind="live", status="done", duration=60):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, title, "", source_type="live", kind=kind)
        self.db.update_session(sid, status=status, duration=duration, started_at=time.time())
        return sid

    def batch(self, status="done"):
        bid = f"batch-{uuid.uuid4().hex[:6]}"
        ids = []
        for index in range(2):
            sid = self.session(f"批次视频 {index}", kind="link_video", status=status)
            self.db.update_meta(sid, batch={
                "id": bid, "title": "测试批次", "index": index,
                "created_at": time.time(), "updated_at": time.time(),
            })
            ids.append(sid)
        return bid, ids

    def note(self, text="便利签测试"):
        return self.db.create_sticky_note(text, "note", [], 10, 20)

    def image(self):
        image_id = uuid.uuid4().hex[:12]
        self.db.create_board_image(image_id, f"board-images/{image_id}.png", 640, 420, 10, 20)
        return image_id

    def doc(self):
        result = self.cards.upsert_doc_card(
            "https://example.feishu.cn/docx/PackDocToken1",
            title="卡包文档", content="正文", document_id="PackDocToken1", revision="1")
        return f"doc:{result['card']['key']}"

    def create(self, body):
        return self.client.post("/api/packs", json=body)

    def test_create_hydrates_all_member_types_and_home_lists_pack(self):
        sid = self.session("发布会")
        mark = self.db.add_mark(sid, 3.5, "关键句")
        note = self.note()
        image = self.image()
        doc_id = self.doc()
        bid, _ = self.batch()
        members = [
            {"type": "session", "id": sid},
            {"type": "highlight", "id": str(mark)},
            {"type": "note", "id": note["id"]},
            {"type": "image", "id": image},
            {"type": "doc", "id": doc_id},
            {"type": "batch", "id": bid},
        ]
        response = self.create({"id": "packhydrate1", "members": members})
        self.assertEqual(response.status_code, 200, response.text)
        pack = response.json()["pack"]
        self.assertEqual(pack["title"], "卡包 1")
        self.assertEqual(pack["count"], 6)
        self.assertEqual({member["type"] for member in pack["members"]},
                         {"session", "highlight", "note", "image", "doc", "batch"})
        by_type = {member["type"]: member for member in pack["members"]}
        self.assertEqual(by_type["session"]["kind"], "live")
        self.assertEqual(by_type["highlight"]["ts"], 3.5)
        self.assertEqual(by_type["doc"]["url"], "https://example.feishu.cn/docx/PackDocToken1")
        self.assertEqual(by_type["batch"]["count"], 2)

        payload = self.client.get("/api/home?limit=10").json()
        self.assertEqual(len(payload["packs"]), 1)
        self.assertEqual(payload["packs"][0]["id"], "packhydrate1")
        self.assertEqual(payload["packs"][0]["count"], 6)
        self.assertIn(sid, {item["id"] for item in payload["items"]})

    def test_reorder_members_and_reject_foreign_card(self):
        ids = [self.session(f"排序 {index}") for index in range(3)]
        members = [{"type": "session", "id": sid} for sid in ids]
        created = self.create({"id": "packorder001", "members": members})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual([item["id"] for item in created.json()["pack"]["members"]], ids)

        reversed_members = list(reversed(members))
        response = self.client.patch("/api/packs/packorder001/members",
                                     json={"members": reversed_members})
        self.assertEqual(response.status_code, 200, response.text)
        pack = response.json()["pack"]
        self.assertEqual([item["id"] for item in pack["members"]], list(reversed(ids)))
        fetched = self.client.get("/api/packs/packorder001").json()["pack"]
        self.assertEqual([item["id"] for item in fetched["members"]], list(reversed(ids)))

        foreign = self.session("不属于这个包")
        rejected = self.client.patch("/api/packs/packorder001/members",
                                     json={"members": [{"type": "session", "id": foreign}]})
        self.assertEqual(rejected.status_code, 400, rejected.text)
        untouched = self.client.get("/api/packs/packorder001").json()["pack"]
        self.assertEqual([item["id"] for item in untouched["members"]], list(reversed(ids)))

    def test_idempotent_create_and_one_pack_per_card(self):
        sid = self.session("只能进一个包")
        body = {"id": "packidem00001", "members": [{"type": "session", "id": sid}]}
        first = self.create(body)
        self.assertEqual(first.status_code, 200, first.text)
        again = self.create(body)
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["pack"]["id"], "packidem00001")
        changed = self.create({"id": "packidem00001", "members": []})
        self.assertEqual(changed.status_code, 409, changed.text)
        other = self.create({"id": "packidem00002", "members": [{"type": "session", "id": sid}]})
        self.assertEqual(other.status_code, 409, other.text)
        self.assertIn("另一个卡包", other.text)

    def test_rename_add_remove_and_delete_does_not_delete_cards(self):
        sid = self.session("保留记录")
        note = self.note()
        created = self.create({"id": "packmutate01", "title": "原名字", "members": [
            {"type": "session", "id": sid}, {"type": "note", "id": note["id"]}]}).json()["pack"]
        self.assertEqual(created["title"], "原名字")

        renamed = self.client.patch("/api/packs/packmutate01", json={"title": "新名字"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["pack"]["title"], "新名字")

        mark = self.db.add_mark(sid, 9, "补充")
        added = self.client.post("/api/packs/packmutate01/members",
                                 json={"members": [{"type": "highlight", "id": str(mark)}]})
        self.assertEqual(added.status_code, 200, added.text)
        self.assertEqual(added.json()["pack"]["count"], 3)

        removed = self.client.post("/api/packs/packmutate01/members/remove",
                                   json={"members": [{"type": "note", "id": note["id"]}]})
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(removed.json()["pack"]["count"], 2)

        deleted = self.client.delete("/api/packs/packmutate01")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["id"], "packmutate01")
        self.assertEqual(len(deleted.json()["members"]), 2)
        self.assertEqual(self.client.get("/api/home").json()["packs"], [])
        self.assertIsNotNone(self.db.get_session(sid))
        self.assertIsNotNone(self.db.one("SELECT id FROM sticky_notes WHERE id=?", (note["id"],)))

    def test_active_records_are_rejected(self):
        recording = self.session("正在录", status="recording")
        bad = self.create({"id": "packactive01", "members": [{"type": "session", "id": recording}]})
        self.assertEqual(bad.status_code, 409, bad.text)
        self.assertIn("进行中", bad.text)

        bid, _ = self.batch(status="pending")
        bad_batch = self.create({"id": "packactive02", "members": [{"type": "batch", "id": bid}]})
        self.assertEqual(bad_batch.status_code, 409, bad_batch.text)

    def test_deleted_member_is_skipped_without_500(self):
        sid = self.session("留下")
        note = self.note()
        self.create({"id": "packmissing1", "members": [
            {"type": "session", "id": sid}, {"type": "note", "id": note["id"]}]})
        self.db.delete_sticky_note(note["id"])
        response = self.client.get("/api/packs/packmissing1")
        self.assertEqual(response.status_code, 200, response.text)
        pack = response.json()["pack"]
        self.assertEqual(pack["count"], 1)
        self.assertEqual(pack["members"][0]["type"], "session")
        home = self.client.get("/api/home").json()
        self.assertEqual(home["packs"][0]["count"], 1)

    def test_validation_auth_and_missing_pack(self):
        sid = self.session("校验")
        self.assertEqual(self.create({"id": "packbadtype1", "members": [
            {"type": "unknown", "id": sid}]}).status_code, 400)
        self.assertEqual(self.create({"id": "../bad", "members": []}).status_code, 400)
        self.assertEqual(self.create({"id": "packbadid001", "members": [
            {"type": "session", "id": "not-exist"}]}).status_code, 400)
        self.assertEqual(self.client.get("/api/packs/missing0001").status_code, 404)
        self.assertEqual(self.client.get("/api/packs").status_code, 405)
        bare = self.TestClient(self.main.app, base_url="http://127.0.0.1:8321")
        self.assertEqual(bare.get("/api/home").status_code, 401)


if __name__ == "__main__":
    unittest.main()
