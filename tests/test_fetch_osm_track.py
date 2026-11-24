"""Offline tests for running the track on to terminal platforms; no network.
Run: python3 -m unittest discover -s tests"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fetch_osm_track import R, chain, cumulative, cut, dist_m, osm_route, pair_stops, platform_for, project, run_on  # noqa: E402

LAT, LON = 28.6, 77.3
K = R * math.pi / 180


def at(east, north=0.0):
    """(lat, lon) of a point `east`, `north` metres from (LAT, LON)."""
    return LAT + north / K, LON + east / (K * math.cos(math.radians(LAT)))


TRACK = [at(e) for e in range(0, 1001, 100)]  # 1 km due east, a node every 100 m


def platform(*east, north=3.0):
    pts = [at(e, north) for e in east]
    return {"id": 1, "points": pts, "s": cumulative(pts)}


class RunOnTest(unittest.TestCase):
    def test_vaishali_case_track_ending_mid_platform_runs_on_to_its_far_end(self):
        to = run_on(TRACK, platform(917, 1104)["points"], -1)  # platform from 83 m before to 104 m past the end
        self.assertAlmostEqual(dist_m(to, TRACK[-1]), 104, delta=0.5)
        self.assertAlmostEqual(to[0], LAT, places=6)  # straight on, not towards the platform's side

    def test_runs_on_before_the_start_too(self):
        to = run_on(TRACK, platform(-97, 82)["points"], 0)
        self.assertAlmostEqual(dist_m(to, TRACK[0]), 97, delta=0.5)
        self.assertLess(to[1], LON)

    def test_platform_inside_the_track_or_far_to_the_side_adds_nothing(self):
        self.assertIsNone(run_on(TRACK, platform(800, 980)["points"], -1))
        self.assertIsNone(run_on(TRACK, platform(900, 1100, north=80)["points"], -1))

    def test_track_shorter_than_the_direction_baseline_adds_nothing(self):
        self.assertIsNone(run_on([at(0), at(10)], platform(0, 100)["points"], -1))

    def test_platform_measures_its_full_length_once_the_track_runs_on(self):
        plat = platform(917, 1104)
        before = platform_for(at(1000, 3), [plat], TRACK, cumulative(TRACK))
        self.assertTrue(before["partial"])  # the bug: only the 83 m before the track end counted
        points, _, gaps = chain([TRACK, [TRACK[-1], run_on(TRACK, plat["points"], -1)]])
        after = platform_for(at(1000, 3), [plat], points, cumulative(points))
        self.assertEqual(gaps, [])
        self.assertAlmostEqual(after["length_m"], 187, delta=1)
        self.assertFalse(after["partial"])


def stations(*east):
    """DMRC stations S0, S1, ... at `east` metres, and OSM stop nodes 20 m off each."""
    return ({f"S{i}": dict(zip(("lat", "lon"), at(e))) for i, e in enumerate(east)},
            [{"id": i, "at": at(e, 20), "name": f"S{i}"} for i, e in enumerate(east)])


class PairingTest(unittest.TestCase):
    def test_a_branch_pairs_with_part_of_a_longer_relation(self):
        st, stops = stations(0, 1000, 2000, 3000)
        direction, pairs = pair_stops(["S1", "S2"], st, stops)
        self.assertEqual(direction, "forward")
        self.assertEqual([(c, n["id"]) for c, n, _ in pairs], [("S1", 1), ("S2", 2)])
        direction, pairs = pair_stops(["S2", "S1"], st, stops)  # run the other way: reversed, in relation order
        self.assertEqual(direction, "reverse")
        self.assertEqual([c for c, *_ in pairs], ["S1", "S2"])
        self.assertEqual(pair_stops(["S0", "S1"], st, stops[2:]), (None, []))

    def test_a_ring_is_started_where_the_relation_starts_it(self):
        st, stops = stations(0, 1000, 2000, 3000)
        ring = stops[:3] + [dict(stops[0], id=9)] + stops[3:]  # S0 S1 S2 S0 then on to S3
        direction, pairs = pair_stops(["S1", "S2", "S0", "S1"], st, ring)
        self.assertEqual(direction, "forward")
        self.assertEqual([(c, n["id"]) for c, n, _ in pairs], [("S0", 0), ("S1", 1), ("S2", 2), ("S0", 9)])

    def test_project_looks_past_a_distance_for_a_ring_coming_back(self):
        loop = TRACK + TRACK[-2::-1]  # out 1 km and back
        s = cumulative(loop)
        self.assertAlmostEqual(project(loop, s, at(0))[0], 0)
        self.assertAlmostEqual(project(loop, s, at(0), 500)[0], 2000)

    def test_cut_keeps_the_nodes_round_a_stretch_and_measures_from_them(self):
        s = cumulative(TRACK)
        points, s2, runs = cut(TRACK, s, [[0, 450, "tunnel"], [450, 1000, "elevated"]], 250, 620)
        self.assertEqual(points, TRACK[2:8])
        self.assertAlmostEqual(s2[0], 0)
        self.assertAlmostEqual(s2[-1], 500, delta=0.1)
        self.assertEqual([r[2] for r in runs], ["tunnel", "elevated"])
        self.assertAlmostEqual(runs[0][1], 250, delta=0.1)

    def test_osm_routes_for_numbered_extension_and_named_lines(self):
        self.assertEqual(osm_route("LN3"), ("Delhi Metro", "3"))
        self.assertEqual(osm_route("LN7EXTN"), ("Delhi Metro", "7"))
        self.assertEqual(osm_route("LN11"), ("Rapid Metro Gurgaon", "RMGL"))
        self.assertIsNone(osm_route("FOB"))


if __name__ == "__main__":
    unittest.main()
