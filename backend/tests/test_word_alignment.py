"""Keep original punctuation when aligner tokens remove internal separators."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace


class WordAlignmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="meetclip-word-alignment-")
        cls.previous = os.environ.get("ZHIBO_DATA_DIR")
        os.environ["ZHIBO_DATA_DIR"] = cls.temp.name
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
        import meeting
        cls.meeting = meeting

    @classmethod
    def tearDownClass(cls):
        cls.meeting.db._conn.close()
        if cls.previous is None:
            os.environ.pop("ZHIBO_DATA_DIR", None)
        else:
            os.environ["ZHIBO_DATA_DIR"] = cls.previous
        cls.temp.cleanup()

    def aligned(self, text, tokens):
        words = [{"text": word, "start": float(i), "end": i + 0.5} for i, word in enumerate(tokens)]
        units = self.meeting.word_units(text, words)
        self.assertIsNotNone(units)
        self.assertEqual("".join(u["text"] for u in units), text)
        self.assertEqual([(u["start"], u["end"]) for u in units], [(w["start"], w["end"]) for w in words])
        return units

    def test_separator_within_a_token_preserves_the_entire_original(self):
        self.aligned("今年 iPhone 18 Pro、iPhone Duo 都有更新。", ["今", "年", "iPhone", "18", "ProiPhone", "Duo", "都", "有", "更", "新"])

    def test_decimal_and_hyphen_preserve_original_spelling(self):
        self.aligned("USB-C 接口和 f1.78 光圈。", ["USBC", "接", "口", "和", "f178", "光", "圈"])

    def test_quotes_newlines_and_sentence_punctuation_are_preserved(self):
        self.aligned("「屏幕不错！」\n下一项呢？", ["屏", "幕", "不", "错", "下", "一", "项", "呢"])

    def test_unmatched_word_still_reports_a_genuine_alignment_mismatch(self):
        self.assertIsNone(self.meeting.word_units("原始内容。", [{"text": "不存在", "start": 0, "end": 1}]))

    def test_rows_keep_legacy_speaker_labels_from_segments(self):
        task = self.meeting.MeetingTask("test-attribution")
        result = SimpleNamespace(text="不知道。", chunks=[],
                                 segments=[{"text": "不", "start": 9.5, "end": 9.6, "speaker": "A"},
                                           {"text": "知", "start": 9.6, "end": 9.6, "speaker": "B"},
                                           {"text": "道", "start": 9.6, "end": 9.9, "speaker": "A"}],
                                 speaker_segments=[{"start": 0., "end": 10., "speaker": "A"},
                                                   {"start": 10., "end": 10.2, "speaker": "B"}])
        self.assertEqual(task._build_rows(result), [(9.5, 9.9, "不知道。", "A")])

    def test_completed_audio_keeps_transcribe_phase(self):
        task = self.meeting.MeetingTask("test-progress")
        task._audio_progress({"event": "chunk_completed", "progress": .999999999999,
                              "processed_audio_sec": 3380.33})
        self.assertEqual(task.phase, "transcribe")


if __name__ == "__main__":
    unittest.main()
