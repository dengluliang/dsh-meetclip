"""Speaker attribution regressions without loading any model or user database."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from speaker_attribution import assign_speakers, attach_zero_duration


class SpeakerAttributionTests(unittest.TestCase):
    def unit(self, start, end, speaker="wrong", text="word"):
        return {"text": text, "start": start, "end": end, "speaker": speaker}

    def test_zero_duration_inside_long_turn_does_not_choose_short_neighbor(self):
        turns = [{"start": 0., "end": 10., "speaker": "A"},
                 {"start": 10., "end": 10.2, "speaker": "B"},
                 {"start": 10.2, "end": 20., "speaker": "A"}]
        units = [self.unit(9.6, 9.6), self.unit(10., 10.)]
        self.assertEqual([u["speaker"] for u in assign_speakers(units, turns)], ["A", "B"])
        self.assertEqual(units[0]["speaker"], "wrong")

    def test_uncovered_word_uses_nearest_edge_not_nearest_center(self):
        turns = [{"start": 0., "end": 10., "speaker": "A"},
                 {"start": 11., "end": 11.2, "speaker": "B"}]
        self.assertEqual(assign_speakers([self.unit(10.1, 10.2)], turns)[0]["speaker"], "A")

    def test_overlap_is_accumulated_by_speaker(self):
        turns = [{"start": 0., "end": .4, "speaker": "A"},
                 {"start": .4, "end": 1., "speaker": "B"},
                 {"start": 1., "end": 1.4, "speaker": "A"}]
        self.assertEqual(assign_speakers([self.unit(0., 1.4)], turns)[0]["speaker"], "A")

    def test_overlapping_turns_use_largest_overlap(self):
        turns = [{"start": 0., "end": 2., "speaker": "A"},
                 {"start": 1., "end": 4., "speaker": "B"}]
        self.assertEqual(assign_speakers([self.unit(1.8, 2.8)], turns)[0]["speaker"], "B")

    def test_zero_duration_run_uses_same_timed_neighbors(self):
        units = [self.unit(0., 1., "A"), self.unit(1., 1., "B"),
                 self.unit(1., 1., "C"), self.unit(1., 2., "A")]
        self.assertEqual([u["speaker"] for u in attach_zero_duration(units)], ["A"] * 4)
        self.assertEqual(units[1]["speaker"], "B")

    def test_true_switch_and_remote_zero_duration_label_are_retained(self):
        units = [self.unit(0., 1., "A"), self.unit(1., 1., "B"), self.unit(1., 2., "B"),
                 self.unit(5., 5., "C")]
        self.assertEqual([u["speaker"] for u in attach_zero_duration(units)], ["A", "B", "B", "C"])

    def test_empty_turns_preserve_labels(self):
        units = [self.unit(0., 1., "A")]
        self.assertEqual(assign_speakers(units, []), units)

    def test_zero_duration_supported_by_its_own_turn_is_not_overridden_by_neighbors(self):
        units = [self.unit(0., 1., "A"), self.unit(1., 1., "wrong", "reply"),
                 self.unit(1.1, 2., "A")]
        turns = [{"start": 0., "end": 1., "speaker": "A"},
                 {"start": 1., "end": 1.1, "speaker": "B"},
                 {"start": 1.1, "end": 2., "speaker": "A"}]
        reconciled = assign_speakers(units, turns)
        self.assertEqual([u["speaker"] for u in attach_zero_duration(reconciled)], ["A", "B", "A"])


if __name__ == "__main__":
    unittest.main()
