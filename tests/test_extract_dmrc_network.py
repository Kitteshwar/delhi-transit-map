"""Offline tests for the topology logic; no network. Run: python3 -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from extract_dmrc_network import (hms_to_seconds, hop_pairs, line_edges, loop_closure,  # noqa: E402
                                  patterns_from_edges, segment_seconds, span_around)


def station(code, line_id, prev, nxt, line_name="Line 5"):
    """A station detail record in DMRC's shape, with one prev/next entry."""
    entry = {"line_id": line_id,
             "prev_station": {"station_code": prev} if prev else None,
             "next_station": {"station_code": nxt} if nxt else None}
    return {"station_code": code, "prev_next_stations": [{line_name: [entry]}]}


class TopologyTest(unittest.TestCase):
    def test_linear_line_is_one_pattern_from_the_terminal_without_prev(self):
        stations = {c: station(c, 2, p, n) for c, p, n in [("A", None, "B"), ("B", "A", "C"), ("C", "B", None)]}
        self.assertEqual(patterns_from_edges(line_edges(stations, 2)), [["A", "B", "C"]])

    def test_green_line_branch_gives_two_patterns_and_hops_are_not_duplicated(self):
        # Kirti Nagar -> Satguru Ram Singh Marg -> Ashok Park Main <- Inderlok; trunk continues to Punjabi Bagh.
        edges = {("KNR", "SRSM"), ("SRSM", "APMN"), ("ILOK", "APMN"), ("APMN", "PBGA")}
        patterns = patterns_from_edges(edges)
        self.assertEqual(patterns, [["ILOK", "APMN", "PBGA"], ["KNR", "SRSM", "APMN", "PBGA"]])
        self.assertEqual(hop_pairs(patterns), [("ILOK", "APMN"), ("APMN", "PBGA"), ("KNR", "SRSM"), ("SRSM", "APMN")])

    def test_cycle_without_terminals_is_walked_once_and_ends_where_it_started(self):
        self.assertEqual(patterns_from_edges({("A", "B"), ("B", "C"), ("C", "A")}), [["A", "B", "C", "A"]])

    def test_a_tail_that_runs_into_a_loop_ends_on_the_station_it_returns_to(self):
        edges = {("S55", "SKRP"), ("SKRP", "DL2"), ("DL2", "BEL"), ("BEL", "DL3"), ("DL3", "DL2")}
        patterns = patterns_from_edges(edges)
        self.assertEqual(patterns, [["S55", "SKRP", "DL2", "BEL", "DL3", "DL2"]])
        self.assertEqual(hop_pairs(patterns)[-1], ("DL3", "DL2"))

    def test_edges_come_only_from_the_requested_line_and_skip_null_neighbours(self):
        x = {"station_code": "X", "prev_next_stations": [
            {"Line 1": [{"line_id": 1, "prev_station": None, "next_station": {"station_code": "Y"}}]},
            {"Line 2": [{"line_id": 2, "prev_station": {"station_code": "P"}, "next_station": None}]}]}
        self.assertEqual(line_edges({"X": x}, 1), {("X", "Y")})
        self.assertEqual(line_edges({"X": x}, 2), {("P", "X")})
        self.assertEqual(line_edges({"X": x}, 3), set())

    def test_neighbours_declaring_the_same_edge_collapse_to_one(self):
        stations = {"A": station("A", 7, None, "B"), "B": station("B", 7, "A", None)}
        self.assertEqual(line_edges(stations, 7), {("A", "B")})


class SpanTest(unittest.TestCase):
    def test_span_encloses_an_interior_pair_and_refuses_pairs_at_the_ends(self):
        patterns = [["KKDC", "KKDA", "AVIT", "IPEX", "MDPR"]]
        self.assertEqual(span_around(patterns, "KKDA", "AVIT"), ("KKDC", "IPEX"))
        self.assertIsNone(span_around(patterns, "KKDC", "KKDA"))   # nothing before KKDC
        self.assertIsNone(span_around(patterns, "IPEX", "MDPR"))   # nothing after MDPR
        self.assertIsNone(span_around(patterns, "AVIT", "KKDA"))   # not in this direction
        self.assertIsNone(span_around(patterns, "ZZZ", "AVIT"))


class LoopClosureTest(unittest.TestCase):
    pattern = ["S55", "SKRP", "DL2", "BEL", "MAL", "DL3"]

    def answer(self, *codes, line="RMGL"):
        return {"route": [{"line": line, "map-path": [f"{a}-{b}" for a, b in zip(codes, codes[1:])]}]}

    def test_first_step_to_an_earlier_stop_closes_the_loop_there(self):
        self.assertEqual(loop_closure(self.answer("DL3", "DL2", "SKRP", "S55"), "RMGL", self.pattern), "DL2")

    def test_ring_closing_on_the_first_stop(self):
        self.assertEqual(loop_closure(self.answer("DL3", "S55"), "RMGL", self.pattern), "S55")

    def test_going_back_the_way_it_came_is_not_a_loop(self):
        self.assertIsNone(loop_closure(self.answer("DL3", "MAL", "BEL", "DL2"), "RMGL", self.pattern))

    def test_other_line_or_empty_path_is_not_a_loop(self):
        self.assertIsNone(loop_closure(self.answer("DL3", "DL2", line="Yellow Line"), "RMGL", self.pattern))
        self.assertIsNone(loop_closure({"route": [{"line": "RMGL", "map-path": []}]}, "RMGL", self.pattern))
        self.assertIsNone(loop_closure({"route": []}, "RMGL", self.pattern))


class PlannerParsingTest(unittest.TestCase):
    def test_single_segment_on_the_right_line_with_the_expected_stop_count(self):
        ans = {"total_time": "0:02:13", "route": [{"line": "Yellow Line", "path": [{"name": "A"}, {"name": "B"}]}]}
        self.assertEqual(segment_seconds(ans, "Yellow Line", 2), 133)
        self.assertIsNone(segment_seconds(ans, "Blue Line", 2))
        self.assertIsNone(segment_seconds(ans, "Yellow Line", 3))

    def test_multi_segment_or_multi_stop_answers_are_rejected(self):
        two_segments = {"total_time": "0:10:00", "route": [
            {"line": "Yellow Line", "path": [{}, {}]}, {"line": "Blue Line", "path": [{}, {}]}]}
        three_stops = {"total_time": "0:06:44", "route": [{"line": "RMGL", "path": [{}, {}, {}]}]}
        self.assertIsNone(segment_seconds(two_segments, "Yellow Line", 2))
        self.assertIsNone(segment_seconds(three_stops, "RMGL", 2))
        self.assertIsNone(segment_seconds({"message": "Service Unavailable"}, "RMGL", 2))

    def test_hms(self):
        self.assertEqual(hms_to_seconds("1:23:22"), 5002)
        self.assertEqual(hms_to_seconds("0:00:00"), 0)


if __name__ == "__main__":
    unittest.main()
