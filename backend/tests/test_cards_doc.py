"""飞书文档卡片：生成、列表、幂等、改名、与记录卡片文件名隔离、路由。"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch


DOC_URL = "https://example.feishu.cn/docx/ExampleDocToken1"
DOC_CONTENT = (
    "会议纪要：2026-11-04 | 聊聊「物模型」白皮书\n\n"
    "🎉 总结\n传播口径与白皮书发布策略。\n\n"
    "✅ 待办任务与跟进\n郑晓航确认口径。"
)


class DocCardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-doc-cards-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.db = cls.database.db
        cls.cards = importlib.import_module("cards")
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
        for table in ("doc_cards", "card_exports", "session_minutes", "transcripts", "marks", "screenshots", "sessions"):
            self.db.execute(f"DELETE FROM {table}")
        card_dir = Path(self.data.name) / self.cards.CARD_DIR_NAME
        if card_dir.exists():
            for item in card_dir.iterdir():
                item.unlink()
            card_dir.rmdir()
        self.cards._LAST.update({"at": 0.0, "result": None})

    def card_files(self):
        directory = Path(self.data.name) / self.cards.CARD_DIR_NAME
        return sorted(path.name for path in directory.glob("*.md")) if directory.exists() else []

    def read(self, name):
        return (Path(self.data.name) / self.cards.CARD_DIR_NAME / name).read_text(encoding="utf-8")

    def session(self, title="预算评审"):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, title, "", source_type="import", kind="meeting")
        self.db.update_session(sid, status="done", duration=300.0)
        return sid

    # ---------- URL / 生成 ----------
    def test_parse_doc_url(self):
        self.assertEqual(self.cards.parse_doc_url(DOC_URL + "?from=share"), ("docx", "ExampleDocToken1"))
        self.assertEqual(self.cards.parse_doc_url("https://example.feishu.cn/wiki/WikAbc123456"), ("wiki", "WikAbc123456"))
        self.assertEqual(self.cards.parse_doc_url("https://example.feishu.cn/sheets/ShtAbc123456"), ("sheet", "ShtAbc123456"))
        self.assertEqual(self.cards.parse_doc_url("https://example.feishu.cn/base/BasAbc123456"), ("base", "BasAbc123456"))
        for bad in (
            "http://example.feishu.cn/docx/AbCdEf123456",
            "https://evil.com/docx/AbCdEf123456",
            "https://example.feishu.cn/minutes/obcn1g2429f9e82rg5euo348",
            "https://example.feishu.cn/docx/",
            "",
        ):
            self.assertIsNone(self.cards.parse_doc_url(bad), bad)

    def test_doc_card_contains_link_and_content(self):
        result = self.cards.upsert_doc_card(
            DOC_URL,
            title="会议纪要：2026-11-04 | 聊聊「物模型」白皮书",
            content=DOC_CONTENT,
            document_id="ExampleDocToken1",
            revision="2",
        )
        self.assertTrue(result["created"])
        self.assertTrue(result["card"]["has_content"])
        files = self.card_files()
        self.assertEqual(len(files), 1)
        text = self.read(files[0])
        for marker in (
            "# 会议纪要：2026-11-04 | 聊聊「物模型」白皮书",
            "> 会摘卡片 · 飞书文档",
            f"> 链接：{DOC_URL}",
            "`ExampleDocToken1`",
            "## 怎么用", "## 正文", "🎉 总结", "郑晓航确认口径",
            "没有 `session_id`", "请勿手工编辑",
        ):
            self.assertIn(marker, text)
        # doc_read 的首行标题不重复进正文
        self.assertEqual(text.count("# 会议纪要：2026-11-04 | 聊聊「物模型」白皮书"), 1)

        listing = self.cards.list_cards("物模型")
        self.assertEqual(listing["total"], 1)
        card = listing["cards"][0]
        self.assertEqual(card["kind"], "doc")
        self.assertEqual(card["source"], "feishu")
        self.assertTrue(card["has_content"])
        self.assertEqual(card["path"], f"会摘卡片/{files[0]}")
        self.assertIn("物模型", card["title"])

    def test_link_only_card(self):
        result = self.cards.upsert_doc_card(
            "https://example.feishu.cn/wiki/WikAbc123456",
            title="知识库文档",
            content="",
            document_id="DocXyz987654",
        )
        self.assertFalse(result["card"]["has_content"])
        text = self.read(self.card_files()[0])
        self.assertIn("还没有读取正文", text)
        self.assertIn("`DocXyz987654`", text)

    def test_invalid_url_rejected(self):
        with self.assertRaises(ValueError):
            self.cards.upsert_doc_card("https://example.feishu.cn/minutes/obcn1g2429f9e82rg5euo348", title="不是文档")
        self.assertEqual(self.card_files(), [])

    # ---------- 幂等 / 刷新 / 改名 ----------
    def test_repeat_add_refreshes_without_duplicate(self):
        first = self.cards.upsert_doc_card(DOC_URL, title="会议纪要", content=DOC_CONTENT)
        second = self.cards.upsert_doc_card(DOC_URL, title="会议纪要", content=DOC_CONTENT + "\n补充一句。")
        self.assertFalse(second["created"])
        self.assertTrue(second["changed"])
        self.assertEqual(len(self.card_files()), 1)
        self.assertIn("补充一句", self.read(self.card_files()[0]))

    def test_rename_moves_file_and_keeps_content(self):
        first = self.cards.upsert_doc_card(DOC_URL, title="旧标题", content=DOC_CONTENT)
        old_name = Path(first["card"]["path"]).name
        renamed = self.cards.upsert_doc_card(DOC_URL, title="新标题", content=DOC_CONTENT)
        new_name = Path(renamed["card"]["path"]).name
        self.assertNotEqual(old_name, new_name)
        self.assertEqual(self.card_files(), [new_name])
        self.assertIn("# 新标题", self.read(new_name))

    def test_same_title_docs_get_numbered_files(self):
        one = self.cards.upsert_doc_card("https://example.feishu.cn/docx/AbCdEf123456", title="同一篇", content="A")
        two = self.cards.upsert_doc_card("https://example.feishu.cn/docx/AbCdEf654321", title="同一篇", content="B")
        self.assertNotEqual(one["card"]["path"], two["card"]["path"])
        self.assertEqual(len(self.card_files()), 2)
        self.assertTrue(any("(2)" in name for name in self.card_files()))

    # ---------- 与记录卡片隔离 ----------
    def test_doc_card_wins_filename_against_record(self):
        doc = self.cards.upsert_doc_card(DOC_URL, title="预算评审", content="文档正文")
        doc_name = Path(doc["card"]["path"]).name
        self.assertEqual(doc_name, "预算评审.md")
        sid = self.session("预算评审")
        self.cards.sync_cards(force=True)
        files = self.card_files()
        self.assertIn("预算评审.md", files)
        self.assertIn("预算评审 (2).md", files)
        self.assertIn("文档正文", self.read("预算评审.md"))
        exports = {row["session_id"]: row for row in self.db.list_card_exports()}
        self.assertEqual(exports[sid]["file"], "预算评审 (2).md")

    def test_sync_and_delete_record_keep_doc_card(self):
        self.cards.upsert_doc_card(DOC_URL, title="文档", content="正文")
        sid = self.session("一条记录")
        self.cards.sync_cards(force=True)
        self.assertEqual(len(self.card_files()), 2)
        self.db.delete_session(sid)
        self.cards.sync_cards(force=True)
        self.assertEqual(self.card_files(), ["文档.md"])
        self.assertEqual(len(self.cards.list_cards()["cards"]), 1)

    # ---------- 路由 ----------
    def test_route_upsert_and_list(self):
        response = self.client.post("/api/cards/doc", json={
            "url": DOC_URL,
            "title": "会议纪要：2026-11-04",
            "content": DOC_CONTENT,
            "document_id": "ExampleDocToken1",
            "revision": "2",
        })
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["created"])
        listed = self.client.get("/api/cards", params={"q": "物模型"}).json()
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["cards"][0]["kind"], "doc")

    def test_route_rejects_non_doc_url(self):
        response = self.client.post("/api/cards/doc", json={"url": "https://example.feishu.cn/minutes/obcn1g24"})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(self.card_files(), [])


if __name__ == "__main__":
    unittest.main()
