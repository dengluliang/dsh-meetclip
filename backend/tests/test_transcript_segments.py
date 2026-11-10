"""Paragraph boundaries: continuous speech, pauses, names and alignment artifacts.

Run: .venv/bin/python tests/test_transcript_segments.py
Uses synthetic timing/audio; never changes a user record or loads ASR weights.
"""
from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from transcript_segments import merge_paragraphs
from speaker_attribution import assign_speakers


def characters(text, start=0.0, step=0.2, speaker=None):
    return [{"text": char, "start": start + i * step, "end": start + (i + 1) * step,
             "speaker": speaker} for i, char in enumerate(text)]


class TranscriptParagraphTests(unittest.TestCase):
    def assert_text_preserved(self, units, rows):
        self.assertEqual("".join(r[2] for r in rows), "".join(u["text"] for u in units))
        self.assertTrue(all(r[0] <= r[1] for r in rows))
        self.assertTrue(all(a[0] <= b[0] for a, b in zip(rows, rows[1:])))

    def test_six_minutes_without_punctuation_are_bounded(self):
        text = "屏幕亮度清晰度颜色一致性都需要仔细测试才能判断实际体验" * 70
        units = characters(text)
        rows = merge_paragraphs(units)
        self.assertGreater(len(rows), 10)
        self.assertLessEqual(max(r[1] - r[0] for r in rows), 45.5)
        self.assert_text_preserved(units, rows)

    def test_audible_pause_splits_at_the_next_spoken_word(self):
        first = "我们已经详细介绍了屏幕亮度和颜色接下来介绍手机的实际拍摄体验" * 2
        second = "首先我们来看看主摄像头在白天的画面表现和实际拍摄体验" * 2
        left = characters(first)
        start = left[-1]["end"] + 1.4
        right = characters(second, start)
        audio = np.ones(int(right[-1]["end"] * 16000), dtype=np.float32) * 0.1
        audio[int(left[-1]["end"] * 16000):int(start * 16000)] = 0
        rows = merge_paragraphs(left + right, audio=audio)
        self.assertEqual(rows[0][2], first)
        self.assertEqual(rows[1][0], start)
        self.assert_text_preserved(left + right, rows)

    def test_alignment_gap_with_audible_speech_is_not_a_pause(self):
        left = characters("我们仔细测试屏幕的亮度颜色和画面效果并且进行了大量对比" * 2)
        right = characters("这次测试的结果确实比之前更加清楚", left[-1]["end"] + 3.5)
        audio = np.ones(int(right[-1]["end"] * 16000), dtype=np.float32) * 0.1
        rows = merge_paragraphs(left + right, audio=audio)
        self.assertEqual(len(rows), 1)
        self.assert_text_preserved(left + right, rows)

    def test_product_name_and_zero_duration_number_stay_together(self):
        units = characters("接下来我们详细介绍这些手机的实际影像表现和测试结果" * 2)
        t = units[-1]["end"]
        units += [
            {"text": "iPhone ", "start": t, "end": t + 0.6, "speaker": None},
            {"text": "18 ", "start": t + 3.9, "end": t + 3.9, "speaker": None},
            {"text": "Pro", "start": t + 7.8, "end": t + 8.4, "speaker": None},
        ] + characters("的影像硬件其实和去年基本保持了一致", t + 8.4)
        rows = merge_paragraphs(units)
        self.assertTrue(any("iPhone 18 Pro" in row[2] for row in rows))
        self.assertNotIn("18", [r[2] for r in rows])
        self.assert_text_preserved(units, rows)

    def test_large_gap_does_not_split_a_chinese_word(self):
        left = characters("欢迎收看我们今天的手机评测这次的内容非常丰富我们一起看看警")
        right = characters("告检测到空间结构异常所有人员请立即撤离", left[-1]["end"] + 3.5)
        rows = merge_paragraphs(left + right)
        self.assertTrue(any("警告" in r[2] for r in rows))
        self.assert_text_preserved(left + right, rows)

    def test_filler_between_long_gaps_is_not_a_separate_paragraph(self):
        units = characters("我们详细讲完了这个可变光圈的优点接下来需要继续看看实际表现" * 2)
        t = units[-1]["end"]
        units += [{"text": "那", "start": t + 3.5, "end": t + 3.58, "speaker": None}]
        units += characters("讲完了优点我们现在必须得讲这次测试中发现的明显缺点", t + 16.8)
        rows = merge_paragraphs(units)
        self.assertFalse(any(row[2] == "那" for row in rows))
        self.assertTrue(any("那讲完" in row[2] for row in rows))
        self.assert_text_preserved(units, rows)

    def test_speaker_change_always_remains_a_boundary(self):
        units = characters("我们今天讨论的是手机屏幕", speaker="S1")
        units += characters("我补充一点", start=units[-1]["end"], speaker="S2")
        rows = merge_paragraphs(units)
        self.assertEqual([r[3] for r in rows], ["S1", "S2"])
        self.assert_text_preserved(units, rows)

    def test_zero_duration_wrong_speaker_cannot_split_a_word(self):
        units = [{"text": "不", "start": 1., "end": 1.2, "speaker": "A"},
                 {"text": "知", "start": 1.2, "end": 1.2, "speaker": "B"},
                 {"text": "道。", "start": 1.2, "end": 1.5, "speaker": "A"}]
        self.assertEqual(merge_paragraphs(units), [(1., 1.5, "不知道。", "A")])
        self.assertEqual(units[1]["speaker"], "B")

    def test_timed_word_internal_label_flip_is_stabilized(self):
        units = characters("给大家介绍", speaker="A", step=.08)
        units[2]["speaker"] = "B"
        self.assertEqual([r[2:] for r in merge_paragraphs(units)], [("给大家介绍", "A")])

    def test_two_character_flip_does_not_split_the_following_word(self):
        units = [{"text": "我刚才说", "start": 0., "end": 1., "speaker": "A"},
                 {"text": "的那", "start": 1., "end": 1.32, "speaker": "B"},
                 {"text": "个问题", "start": 1.32, "end": 2., "speaker": "A"}]
        self.assertEqual([r[2:] for r in merge_paragraphs(units)], [("我刚才说的那个问题", "A")])

    def test_timed_acknowledgement_remains_a_separate_speaker(self):
        units = characters("我们来讨论", speaker="A")
        t = units[-1]["end"]
        units += [{"text": "嗯", "start": t, "end": t + .08, "speaker": "B"}]
        units += characters("这个问题", start=t + .08, speaker="A")
        rows = merge_paragraphs(units)
        self.assertEqual([r[3] for r in rows], ["A", "B", "A"])
        self.assertEqual(rows[1][2], "嗯")
        self.assert_text_preserved(units, rows)

    def test_zero_duration_acknowledgement_with_an_acoustic_turn_is_retained(self):
        units = [{"text": "我们来讨论", "start": 0., "end": 1., "speaker": "A"},
                 {"text": "嗯", "start": 1., "end": 1., "speaker": "wrong"},
                 {"text": "这个问题", "start": 1.1, "end": 2., "speaker": "A"}]
        turns = [{"start": 0., "end": 1., "speaker": "A"},
                 {"start": 1., "end": 1.1, "speaker": "B"},
                 {"start": 1.1, "end": 2., "speaker": "A"}]
        rows = merge_paragraphs(assign_speakers(units, turns))
        self.assertEqual([r[3] for r in rows], ["A", "B", "A"])
        self.assertEqual(rows[1][2], "嗯")

    def test_brief_negative_reply_is_retained(self):
        units = characters("今天有没有", speaker="A", step=.1)
        units += characters("没有", start=units[-1]["end"], speaker="B", step=.08)
        units += characters("那就明天再试", start=units[-1]["end"], speaker="A", step=.1)
        self.assertEqual([r[3] for r in merge_paragraphs(units)], ["A", "B", "A"])

    def test_unfinished_period_does_not_split_modifier_from_noun(self):
        units = characters("我们先介绍今年的系统以及每个子赛道下面可能有具体的。")
        units += characters("支撑的这个新功能点然后我们再继续介绍评估的方式。", start=units[-1]["end"] + 1.5)
        rows = merge_paragraphs(units)
        self.assertTrue(any("具体的。支撑的" in r[2] for r in rows))
        self.assert_text_preserved(units, rows)

    def test_complete_acknowledgement_sentence_keeps_its_boundary(self):
        units = characters("我们仔细讨论了这个系统的功能和用户体验结论应该是好的。")
        units += characters("接下来介绍新功能的价值和我们计划采用的评估方式。", start=units[-1]["end"] + 1.5)
        self.assertTrue(merge_paragraphs(units)[0][2].endswith("好的。"))

    def test_punctuated_sentences_keep_their_endings(self):
        units = characters("我们仔细测试了这个屏幕的亮度颜色和画面效果。" * 12)
        rows = merge_paragraphs(units)
        self.assertTrue(all(row[2].endswith("。") for row in rows))
        self.assert_text_preserved(units, rows)

    def test_music_does_not_hide_an_explicit_sentence_boundary(self):
        left = characters("欢迎大家观看今天的手机评测我们会一起分析这些产品的优点和缺点。")
        right = characters("现在进入下一个部分我们来继续介绍屏幕的实际表现", left[-1]["end"] + 3.0)
        audio = np.ones(int(right[-1]["end"] * 16000), dtype=np.float32) * 0.1
        rows = merge_paragraphs(left + right, audio=audio)
        self.assertEqual(rows[0][2], "".join(u["text"] for u in left))
        self.assert_text_preserved(left + right, rows)

    def test_decimal_number_is_not_split_at_its_period(self):
        units = characters("下面我们继续详细测试手机的屏幕亮度颜色和实际体验" * 2)
        t = units[-1]["end"]
        units += [{"text": "10.", "start": t, "end": t + 0.6, "speaker": None},
                  {"text": "5", "start": t + 3.6, "end": t + 4.0, "speaker": None}]
        units += characters("英寸的屏幕可以带来更大的实际画面", t + 4.0)
        rows = merge_paragraphs(units)
        self.assertTrue(any("10.5" in row[2] for row in rows))
        self.assert_text_preserved(units, rows)

    def test_unaligned_thirty_second_chunks_are_not_merged_for_minutes(self):
        units = [{"text": "没有时间戳模型时只能使用音频块的近似起止时间" * 4,
                  "start": i * 30.0, "end": (i + 1) * 30.0, "speaker": None} for i in range(20)]
        rows = merge_paragraphs(units)
        self.assertLessEqual(max(r[1] - r[0] for r in rows), 60)
        self.assert_text_preserved(units, rows)

    def test_empty_input(self):
        self.assertEqual(merge_paragraphs([]), [])


if __name__ == "__main__":
    unittest.main()
