"""文本卫生：识别噪声清洗、定稿不如草稿时用草稿、断句续接与合并。"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


class TextHygieneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory(prefix="meetclip-hygiene-tests-")
        cls.environment = patch.dict(os.environ, {"ZHIBO_DATA_DIR": cls.data.name})
        cls.environment.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        cls.hygiene = importlib.import_module("text_hygiene")

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.data.cleanup()

    def test_clean_collapses_noise(self):
        h = self.hygiene
        self.assertEqual(h.clean("in.........."), "in…")
        self.assertEqual(h.clean(", , that is"), "that is")
        self.assertEqual(h.clean(". , that is"), "that is")
        self.assertEqual(h.clean("UALE , next"), "UALE, next")
        self.assertEqual(h.clean("…，你好"), "你好")
        self.assertEqual(h.clean("…… 嗯"), "嗯")
        self.assertEqual(h.clean("好  。"), "好。")
        self.assertEqual(h.clean(""), "")

    def test_clean_keeps_normal_text(self):
        h = self.hygiene
        self.assertEqual(h.clean("这个季度的预算缺口是二十万。"), "这个季度的预算缺口是二十万。")
        self.assertEqual(h.clean("We need the budget by Friday."), "We need the budget by Friday.")

    def test_clean_drops_language_and_control_tags(self):
        h = self.hygiene
        # 空白片段上识别器会把语言标记当正文吐出来，重复很多次也一样。
        self.assertEqual(h.clean("<chinese>"), "")
        self.assertEqual(h.clean("<chinese>" * 200), "")
        self.assertEqual(h.clean("<|zh|>\n<|NEUTRAL|>\n<|Speech|><|woitn|>"), "")
        self.assertEqual(h.clean("…… <chinese>"), "")
        self.assertEqual(h.clean("[Music]"), "")
        # 标记夹在正文里时只去掉标记，正文一个字都不丢。
        self.assertEqual(h.clean("<chinese>大家好<|NEUTRAL|>，发布会现在开始。"), "大家好，发布会现在开始。")
        self.assertEqual(h.clean("先看价格<chinese>：4299 元。"), "先看价格：4299 元。")

    def test_noise_detects_tag_only_text(self):
        h = self.hygiene
        self.assertTrue(h.noise("<chinese>" * 3))
        self.assertTrue(h.noise("<|zh|> ，。"))
        self.assertTrue(h.noise(""))
        self.assertFalse(h.noise("<chinese>你好"))
        self.assertEqual(h.strip_tags("<|zh|>你好<chinese>"), "你好")

    def test_fuller_prefers_draft_only_when_it_keeps_words(self):
        h = self.hygiene
        final = "needs the budget."
        draft = "needs the budget for next year by the end of this month in."
        self.assertEqual(h.fuller(final, draft), h.clean(draft))
        # 只差一点就不换：定稿的标点更可信
        self.assertEqual(h.fuller("预算缺口二十万。", "预算缺口二十"), "预算缺口二十万。")
        self.assertEqual(h.fuller("ok", ""), "ok")

    def test_continues_and_join(self):
        h = self.hygiene
        self.assertTrue(h.continues("我们下个季度要", "先把开支压下来", gap=0.4))
        self.assertFalse(h.continues("我们下个季度要", "先把开支压下来", gap=3.0))
        self.assertFalse(h.continues("这样好吗？", "好的", gap=0.2))
        # 问号/感叹号结尾一定不接
        self.assertFalse(h.continues("真的！", "然后呢", gap=0.2))
        # 我们自己按停顿切的句号（cut）后面是小写 → 其实没说完
        self.assertTrue(h.continues("we are going to be.", "in the office", gap=0.5, cut=True))
        self.assertFalse(h.continues("we are done.", "Next topic", gap=0.5, cut=True))
        self.assertEqual(h.join("we are going to be.", "in the office"), "we are going to be in the office")
        self.assertEqual(h.join("预算缺口是", "二十万。"), "预算缺口是二十万。")

    def test_merge_joins_fragments(self):
        rows = [{"start": 0.0, "end": 1.2, "text": "我们下个季度要", "speaker": "S1"},
                {"start": 1.5, "end": 3.0, "text": "先把开支压下来。", "speaker": "S1"},
                {"start": 3.2, "end": 5.0, "text": "另外招人要停。", "speaker": "S2"}]
        merged = self.hygiene.merge(rows)
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]["text"], "我们下个季度要先把开支压下来。")
        self.assertEqual(merged[0]["end"], 3.0)
        self.assertEqual(merged[1]["speaker"], "S2")


if __name__ == "__main__":
    unittest.main()
