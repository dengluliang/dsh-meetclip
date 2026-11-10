"""@ 会摘卡片：文件命名/内容、签名幂等、改名删除同步、列表过滤与 API。"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch


class CardExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-cards-")
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

    def session(self, title="预算评审", kind="meeting", status="done", duration=300.0,
                rows=None, notes="", minutes=None, marks=None, offset=0):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, title, "", source_type="import", kind=kind)
        started = time.time() - 1000 + offset
        self.db.update_session(sid, status=status, duration=duration, started_at=started)
        self.db.update_meta(sid, speakers={"S1": "张三", "S2": "李四"}, language="Chinese")
        for start, end, text, speaker in rows or [
            (5.0, 9.0, "预算缺口还有二十万。", "S1"),
            (12.0, 16.0, "人力多招了两个人，设备也涨价了。", "S2"),
            (20.0, 24.0, "下个季度先把开支压下来。", "S1"),
        ]:
            self.db.add_transcript(sid, start, end, text, speaker)
        if notes:
            self.db.save_record_notes(sid, notes, 0)
        if minutes:
            self.db.save_minutes(sid, minutes, covered=24.0, kind="final", lang="Simplified Chinese")
        for ts, note in marks or []:
            self.db.add_mark(sid, ts, note)
        return sid

    def sync(self):
        return self.cards.sync_cards(force=True)

    def card_files(self):
        directory = Path(self.data.name) / self.cards.CARD_DIR_NAME
        return sorted(path.name for path in directory.glob("*.md")) if directory.exists() else []

    # ---------- 生成 ----------
    def test_card_contains_minutes_notes_marks_and_bounded_preview(self):
        minutes = {
            "title": "预算评审", "summary": "确认预算缺口并压缩开支。",
            "topics": [{"start": 5, "title": "预算缺口", "summary": "缺口二十万",
                        "points": [{"text": "先砍非必要采购", "t": 8}], "fishbone": None}],
            "conclusions": [{"text": "下季度压缩开支", "t": 20}],
            "todos": [{"text": "补一份预算表", "owner": "张三", "t": 21}],
            "terms": [{"name": "会摘", "note": "产品名", "heard": ["会窄"]}],
        }
        notes = ("<!-- meetclip:minutes:begin -->\n# 会议纪要\n旧内容\n<!-- meetclip:minutes:end -->\n\n"
                 "我自己的笔记：先找财务确认口径。")
        rows = [(i * 10.0, i * 10.0 + 4, f"第{i}段转写内容。", "S1") for i in range(1, 21)]
        sid = self.session(rows=rows, notes=notes, minutes=minutes, marks=[(12.0, "这里要回看")])
        result = self.sync()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["created"], 1)
        self.assertEqual(len(self.card_files()), 1)
        text = (Path(self.data.name) / self.cards.CARD_DIR_NAME / self.card_files()[0]).read_text(encoding="utf-8")
        for marker in (
            "# 预算评审", "会摘卡片", "怎么用", sid, "## AI 纪要",
            "确认预算缺口", "## 我的笔记", "我自己的笔记：先找财务确认口径。",
            "## 标记", "[00:12] — 这里要回看", "## 转写预览",
            "[00:10] 张三：第1段转写内容。", "共 20 段转写", "请勿手工编辑",
        ):
            self.assertIn(marker, text)
        self.assertNotIn("<!-- meetclip:minutes:begin -->", text)
        self.assertNotIn("旧内容", text)
        # 20 段只展示前 12 段；完整转写交给工具
        self.assertNotIn("第20段转写内容", text)
        exports = self.db.list_card_exports()
        self.assertEqual(len(exports), 1)
        self.assertEqual(exports[0]["session_id"], sid)

    def test_duplicate_and_unsafe_titles(self):
        first = self.session(title="同一场会", offset=0)
        second = self.session(title="同一场会", offset=10)
        unsafe = self.session(title="../../预算/会议: 第一版", offset=20)
        result = self.sync()
        self.assertTrue(result["ok"], result)
        files = self.card_files()
        self.assertEqual(len(files), 3)
        self.assertEqual(len(set(files)), 3)
        self.assertTrue(any("(2)" in name for name in files))
        self.assertFalse(any(name in ("..", ".", "") for name in files))
        self.assertFalse(any(sep in name for name in files for sep in ("/", "\\")))
        self.assertTrue(all(name.endswith(".md") for name in files))
        exports = {row["session_id"]: row["file"] for row in self.db.list_card_exports()}
        self.assertEqual(set(exports), {first, second, unsafe})
        self.assertTrue(all("/" not in file for file in exports.values()))

    # ---------- 同步 ----------
    def test_sync_is_idempotent_until_content_changes(self):
        sid = self.session()
        first = self.sync()
        self.assertEqual(first["created"], 1)
        path = Path(self.data.name) / self.cards.CARD_DIR_NAME / self.card_files()[0]
        before = path.stat().st_mtime_ns
        second = self.cards.sync_cards(force=False)
        self.assertEqual(second["updated"], 0)
        self.assertEqual(second["created"], 0)
        self.assertEqual(second["skipped"], 1)
        self.assertEqual(path.stat().st_mtime_ns, before)
        self.db.save_record_notes(sid, "新笔记")
        third = self.cards.sync_cards(force=False)
        self.assertEqual(third["updated"], 1)
        self.assertEqual(third["skipped"], 0)
        self.assertIn("新笔记", path.read_text(encoding="utf-8"))

    def test_rename_and_delete_remove_old_files(self):
        sid = self.session(title="旧标题")
        self.sync()
        old_name = self.card_files()[0]
        old_path = Path(self.data.name) / self.cards.CARD_DIR_NAME / old_name
        self.db.update_session(sid, title="新标题")
        renamed = self.cards.sync_cards(force=False)
        self.assertEqual(renamed["updated"], 1)
        self.assertFalse(old_path.exists())
        self.assertIn("新标题", (Path(self.data.name) / self.cards.CARD_DIR_NAME / self.card_files()[0]).read_text(encoding="utf-8"))
        self.db.delete_session(sid)
        deleted = self.cards.sync_cards(force=False)
        self.assertEqual(deleted["removed"], 1)
        self.assertEqual(self.card_files(), [])
        self.assertEqual(self.db.list_card_exports(), [])

    def test_empty_library_leaves_no_empty_card_dir(self):
        result = self.sync()
        self.assertEqual(result["total"], 0)
        self.assertFalse((Path(self.data.name) / self.cards.CARD_DIR_NAME).exists())

    # ---------- 列表与 API ----------
    def test_list_filters_title_and_summary_and_limit(self):
        minutes = {
            "title": "预算会", "summary": "讨论了预算缺口。", "topics": [], "conclusions": [],
            "todos": [], "terms": [],
        }
        self.session(title="预算评审", minutes=minutes, offset=0)
        self.session(title="产品发布", minutes=None, offset=10)
        self.sync()
        by_title = self.cards.list_cards("预算", limit=20)
        self.assertEqual(by_title["total"], 1)
        self.assertEqual(by_title["cards"][0]["title"], "预算评审")
        self.assertTrue(by_title["cards"][0]["path"].startswith(f"{self.cards.CARD_DIR_NAME}/"))
        by_summary = self.cards.list_cards("缺口", limit=20)
        self.assertEqual(by_summary["total"], 1)
        limited = self.cards.list_cards("", limit=1)
        self.assertEqual(limited["returned"], 1)
        self.assertEqual(limited["total"], 2)
        self.assertEqual(limited["cards"][0]["title"], "产品发布")

    def test_api_lists_and_syncs(self):
        sid = self.session()
        synced = self.client.post("/api/cards/sync", params={"force": 1})
        self.assertEqual(synced.status_code, 200, synced.text)
        self.assertEqual(synced.json()["total"], 1)
        listed = self.client.get("/api/cards", params={"q": "预算"})
        self.assertEqual(listed.status_code, 200, listed.text)
        payload = listed.json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["cards"][0]["id"], sid)
        self.assertTrue(payload["cards"][0]["path"].startswith(f"{self.cards.CARD_DIR_NAME}/"))
        self.assertNotIn(str(self.data.name), payload["cards"][0]["path"])


if __name__ == "__main__":
    unittest.main()
