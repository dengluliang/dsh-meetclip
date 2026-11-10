"""云端说话人接线位：无 provider 时保持原样，注册后按时间重叠标注。"""
import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

DATA = tempfile.TemporaryDirectory(prefix="meetclip-speakers-cloud-")
os.environ["ZHIBO_DATA_DIR"] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
speakers_cloud = importlib.import_module("speakers_cloud")


class SpeakersCloudTests(unittest.TestCase):
    def tearDown(self):
        speakers_cloud.PROVIDERS.clear()

    def test_without_provider_rows_are_unchanged(self):
        rows = [(0.0, 5.0, "你好", None)]
        self.assertEqual(speakers_cloud.maybe_label(rows, Path("/tmp/x.wav"), {}), (rows, {}))
        self.assertFalse(speakers_cloud.available())

    def test_label_rows_uses_overlap_then_nearest_turn(self):
        turns = [{"start": 0.0, "end": 2.0, "speaker": "A"},
                 {"start": 2.0, "end": 4.0, "speaker": "B"}]
        rows = [(0.0, 3.0, "一", None), (4.2, 4.4, "二", None), (0.0, 1.0, "三", "keep")]
        labeled = speakers_cloud.label_rows(rows, turns)
        self.assertEqual([row[3] for row in labeled], ["A", "B", "keep"])

    def test_registered_provider_labels_rows_and_builds_mapping(self):
        turns = [{"start": 0.0, "end": 3.0, "speaker": "SPEAKER_00"},
                 {"start": 3.0, "end": 6.0, "speaker": "SPEAKER_01"}]
        speakers_cloud.register("fake", lambda _wav, _count: turns)
        rows, speakers = speakers_cloud.maybe_label([(0.0, 2.0, "甲", None), (3.0, 5.0, "乙", None)], Path("/tmp/x.wav"), {})
        self.assertEqual([row[3] for row in rows], ["SPEAKER_00", "SPEAKER_01"])
        self.assertEqual(speakers, {"SPEAKER_00": "发言人 1", "SPEAKER_01": "发言人 2"})

    def test_unregister_disables_provider(self):
        speakers_cloud.register("fake", lambda _wav, _count: [])
        speakers_cloud.unregister("fake")
        self.assertFalse(speakers_cloud.available())


if __name__ == "__main__":
    unittest.main()
