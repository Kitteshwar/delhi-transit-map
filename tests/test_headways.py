"""Offline tests for expanding the headway profile. Run: python3 -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from headways import check, departures, most_in_service, run_seconds, secs  # noqa: E402


def profile(bands, first="06:00", last="07:00"):
    return {"first_departure": {"forward": first, "reverse": first},
            "last_departure": {"forward": last, "reverse": last},
            "headways": {day: bands for day in ("weekday", "saturday", "sunday")}}


def at(*times):
    return [secs(t) for t in times]


class DeparturesTest(unittest.TestCase):
    def test_steps_by_the_band_each_departure_falls_in(self):
        p = profile([["06:00", 600], ["06:30", 300]], last="06:45")
        self.assertEqual(departures(p, "forward", "weekday"),
                         at("06:00", "06:10", "06:20", "06:30", "06:35", "06:40", "06:45"))

    def test_ends_on_the_last_train_without_a_gap_longer_than_the_headway(self):
        self.assertEqual(departures(profile([["06:00", 600]], last="06:22"), "forward", "weekday"),
                         at("06:00", "06:10", "06:20", "06:22"))
        self.assertEqual(departures(profile([["06:00", 600]], last="06:27"), "forward", "weekday"),
                         at("06:00", "06:10", "06:20", "06:27"))

    def test_check_rejects_bad_profiles(self):
        for bad in (profile([["06:30", 600]]),                          # no band covers the first train
                    profile([["06:00", 600], ["06:00", 300]]),          # band starts must increase
                    profile([["06:00", 0]]),                            # headway must be positive
                    profile([["06:00", 600]], first="08:00", last="07:00")):
            with self.assertRaises(ValueError):
                check("LN3", bad)
        check("LN3", profile([["06:00", 600]]))

    def test_most_in_service_counts_overlapping_trips(self):
        self.assertEqual(most_in_service([(0, 100), (50, 100), (100, 100)]), 2)  # first arrives as third leaves
        self.assertEqual(most_in_service([]), 0)


class RunSecondsTest(unittest.TestCase):
    def test_sums_the_hops_of_the_pattern_asked_for(self):
        line = {"code": "LN5", "patterns": [["A", "B", "C"], ["D", "B"]],
                "hops": [{"from": "A", "to": "B", "seconds": 100}, {"from": "B", "to": "C", "seconds": 50},
                         {"from": "D", "to": "B", "seconds": 70}]}
        self.assertEqual(run_seconds(line), 150)
        self.assertEqual(run_seconds(line, 1), 70)


if __name__ == "__main__":
    unittest.main()
