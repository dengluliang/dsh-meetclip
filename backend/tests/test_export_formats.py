"""导出：SRT/VTT 时间轴、DOCX 结构、Markdown 带纪要、ZIP 附带字幕。"""
import importlib
import io
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid
import zipfile
from unittest.mock import patch


class ExportFormatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-export-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.database = importlib.import_module("database")
        if Path(cls.database.DATA_DIR) != Path(cls.data.name):
            raise unittest.SkipTest("请单独运行本测试文件（数据库模块已被其他测试以不同目录加载）")
        cls.db = cls.database.db
        cls.main = importlib.import_module("main")
        cls.auth = importlib.import_module("auth")
        cls.export_srt = importlib.import_module("export_srt")
        cls.export_md = importlib.import_module("export_md")
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
        for table in ("session_minutes", "transcripts", "marks", "screenshots", "sessions"):
            self.db.execute(f"DELETE FROM {table}")

    def session(self, rows, kind="meeting", duration=120.0):
        sid = uuid.uuid4().hex[:12]
        self.db.create_session(sid, "预算评审", "", source_type="import", kind=kind)
        self.db.update_session(sid, status="done", duration=duration, started_at=time.time())
        self.db.update_meta(sid, speakers={"S1": "张三"}, language="Chinese")
        for start, end, text, speaker in rows:
            self.db.add_transcript(sid, start, end, text, speaker)
        return sid

    # ---------- SRT ----------
    def test_srt_timing_rules(self):
        sid = self.session([(0.0, 0.2, "短句。", "S1"),
                            (0.3, 1.0, "紧接着的一句。", "S1"),
                            (60.0, 61.0, "隔了很久。", "S1")])
        srt = self.export_srt.build_srt(sid)
        blocks = srt.strip().split("\n\n")
        self.assertEqual(len(blocks), 3)
        self.assertTrue(blocks[0].startswith("1\n00:00:00,000 --> "))
        # 下一行只隔 0.3 秒：最少给 1 秒
        self.assertIn("00:00:00,000 --> 00:00:01,000", blocks[0])
        # 中间隔了 59 秒：最多给 8 秒
        self.assertIn("00:00:00,300 --> 00:00:08,300", blocks[1])
        # 最后一行没有下一行：给 4 秒
        self.assertIn("00:01:00,000 --> 00:01:04,000", blocks[2])
        self.assertNotIn("张三", srt)

    def test_vtt_carries_speaker(self):
        sid = self.session([(3.0, 5.0, "先看预算。", "S1")])
        vtt = self.export_srt.build_vtt(sid)
        self.assertTrue(vtt.startswith("WEBVTT"))
        self.assertIn("<v 张三>先看预算。", vtt)
        self.assertIn("00:00:03.000 --> 00:00:07.000", vtt)

    def test_vtt_without_speaker(self):
        sid = self.session([(0.0, 2.0, "没有发言人。", None)])
        self.assertIn("\n没有发言人。\n", self.export_srt.build_vtt(sid))

    # ---------- DOCX ----------
    def test_docx_is_a_valid_package(self):
        sid = self.session([(0.0, 2.0, "先说结论。", "S1")])
        self.db.save_minutes(sid, {"title": "预算评审", "summary": "确认缺口。",
                                   "topics": [{"start": 0, "title": "预算", "summary": "",
                                               "points": [{"text": "缺口二十万", "t": 0.5}],
                                               "fishbone": None}],
                                   "conclusions": [{"text": "压缩开支", "t": 0.5}],
                                   "todos": [{"text": "补预算表", "owner": "张三", "t": 1.0}],
                                   "terms": [{"name": "会摘", "note": "产品名", "heard": ["会窄"]}]},
                          covered=2.0, kind="final", lang="Simplified Chinese")
        blob = self.export_srt.build_docx(sid)
        archive = zipfile.ZipFile(io.BytesIO(blob))
        names = set(archive.namelist())
        self.assertEqual(names, {"[Content_Types].xml", "_rels/.rels", "word/document.xml"})
        document = archive.read("word/document.xml").decode("utf-8")
        self.assertIn("预算评审", document)
        self.assertIn("纪要", document)
        self.assertIn("缺口二十万", document)
        self.assertIn("☐ 补预算表", document)
        self.assertIn("先说结论。", document)

    # ---------- 下载接口 ----------
    def test_download_endpoints(self):
        sid = self.session([(0.0, 2.0, "一句话。", "S1")])
        srt = self.client.get(f"/api/sessions/{sid}/export.srt")
        self.assertEqual(srt.status_code, 200)
        self.assertIn("attachment", srt.headers["content-disposition"])
        self.assertIn("一句话。", srt.text)
        vtt = self.client.get(f"/api/sessions/{sid}/export.vtt")
        self.assertEqual(vtt.status_code, 200)
        self.assertTrue(vtt.text.startswith("WEBVTT"))
        docx = self.client.get(f"/api/sessions/{sid}/export.docx")
        self.assertEqual(docx.status_code, 200)
        self.assertTrue(docx.content.startswith(b"PK"))
        self.assertIn("wordprocessingml", docx.headers["content-type"])

    # ---------- Markdown + ZIP ----------
    def test_markdown_includes_minutes_and_zip_includes_subtitles(self):
        sid = self.session([(0.0, 2.0, "先说结论。", "S1"), (60.0, 62.0, "再补充。", "S1")])
        self.db.save_minutes(sid, {"title": "预算评审", "summary": "确认缺口。",
                                   "topics": [{"start": 0, "title": "预算", "summary": "缺口",
                                               "points": [{"text": "缺口二十万", "t": 0.5}],
                                               "fishbone": None}],
                                   "conclusions": [], "todos": [], "terms": []},
                          covered=62.0, kind="final", lang="Simplified Chinese")
        result = self.export_md.export_markdown(sid)
        markdown = result["markdown"]
        self.assertIn("## 纪要", markdown)
        self.assertIn("### 总结", markdown)
        self.assertIn("### 主题", markdown)
        self.assertIn("[00:00] 预算", markdown)
        self.assertIn("- [00:00] 缺口二十万", markdown)
        archive = zipfile.ZipFile(result["zip"])
        names = set(archive.namelist())
        self.assertIn("transcript.srt", names)
        self.assertIn("transcript.vtt", names)
        self.assertIn("transcript.docx", names)


if __name__ == "__main__":
    unittest.main()
