#!/usr/bin/env python3
"""Fetch Delhi Metro track geometry from OpenStreetMap and build a track model per line and
direction: the track as one polyline with distance along it (s, metres), DMRC's stations placed
on it from OSM's stop nodes, platform extents where OSM maps them, and the stretches in tunnel
or on viaduct. Where OSM's route track stops short of the far end of a terminal platform, the
track is run on straight to it (extended_m on the track feature).

Reads data/network.json (from extract_dmrc_network.py) for station order and hop times and
writes data/track/<LINE>.geojson, which geojson.io or QGIS can open for a visual check.
Track, stops and platforms are (c) OpenStreetMap contributors, ODbL: credit OSM where shown.
"""
import argparse
import hashlib
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "delhi-transit-map/0.1 (personal non-commercial project; python-urllib)"
BBOX = "28.30,76.80,28.85,77.60"  # Delhi NCR, every DMRC line
R = 6371008.8  # mean earth radius, m
PAIR_MEDIAN_M = 300  # accept a stop pairing whose median DMRC-to-OSM offset is under this (Blue: ~20 m)
DMRC_OFFSET_WARN_M = 100
PLATFORM_RADIUS_M = 30  # stop node -> its platform outline
PARTIAL_PLATFORM_M = 120  # Blue Line platforms are ~180 m; shorter ones are mapped in pieces
CUT_MARGIN_M = 300  # track kept past the first and last stop when a route runs further than the line
TRACK_HALF_M = 2.25  # half the distance between the two tracks, for a route OSM maps as one line
HERE = Path(__file__).resolve().parent
# OSM route (network, ref) per DMRC line: by default the line number on Delhi Metro, with an
# extension (LN7EXTN) found on its parent line's routes.
OSM_ROUTES = {"LN10": ("Delhi Metro", "AEx"), "LN11": ("Rapid Metro Gurgaon", "RMGL")}
# Stations OSM names differently from DMRC, checked by position: DMRC's North Pitampura is 170 m
# from OSM's "Haiderpur Village" (its Prashant Vihar is 15 m from OSM's "North Pitampura - Prashant
# Vihar"), and both are the stops between Haiderpur Badli Mor and Madhuban Chowk in each source.
OSM_NAMES = {"NPPR": "Haiderpur Village"}


def osm_route(code):
    if code in OSM_ROUTES:
        return OSM_ROUTES[code]
    m = re.fullmatch(r"LN(\d+)(EXTN)?", code)
    return ("Delhi Metro", m.group(1)) if m else None


def overpass(query, cache_dir, max_age_s, url=OVERPASS):
    """POST an Overpass query; the JSON answer is cached on disk by query text."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / (hashlib.sha1(query.encode()).hexdigest()[:16] + ".json")
    if cached.exists() and time.time() - cached.stat().st_mtime < max_age_s:
        return json.loads(cached.read_text())
    body = urllib.parse.urlencode({"data": query}).encode()
    err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=240) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            # Overpass reports a timeout or out-of-memory as HTTP 200 with partial data and a remark
            if "error" in data.get("remark", "").lower():
                raise ValueError(data["remark"])
            cached.write_text(json.dumps(data))
            return data
        except (urllib.error.URLError, ValueError, OSError) as e:  # 429/502/504: busy, wait and retry
            err = e
            if attempt < 2:
                time.sleep(15 * (attempt + 1))
    raise RuntimeError(f"Overpass query failed: {err}")


def dist_m(a, b):
    """Great-circle distance between two (lat, lon) points."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b[1] - a[1]) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def cumulative(points):
    s = [0.0]
    for a, b in zip(points, points[1:]):
        s.append(s[-1] + dist_m(a, b))
    return s


def xy(p, origin):
    """(east, north) metres of p from origin; flat earth, fine within a few hundred metres."""
    k = R * math.pi / 180
    return (p[1] - origin[1]) * k * math.cos(math.radians(origin[0])), (p[0] - origin[0]) * k


def run_on(points, platform, end):
    """The point to continue the track to, straight on past its start (end=0) or its finish (end=-1),
    so that it reaches the far end of `platform` (a list of (lat, lon)). None when the platform does
    not reach past that end of the track."""
    tip = points[end]
    back = next((p for p in (points[1:] if end == 0 else points[-2::-1]) if dist_m(p, tip) >= 20), None)
    if back is None:
        return None
    ux, uy = xy(tip, back)
    n = math.hypot(ux, uy)
    ux, uy = ux / n, uy / n
    past = max((x * ux + y * uy for x, y in (xy(p, tip) for p in platform)
                if abs(x * uy - y * ux) <= 2 * PLATFORM_RADIUS_M), default=0)
    if past < 1:
        return None
    k = R * math.pi / 180
    return tip[0] + uy * past / k, tip[1] + ux * past / (k * math.cos(math.radians(tip[0])))


def chain(ways):
    """Join track ways (lists of (lat, lon), in relation order, each drawn in either direction)
    into one polyline. Returns (points, spans, gaps): spans[i] is way i's first and last point
    index; gaps lists (point index, metres) wherever a way does not start where the last ended."""
    points, spans, gaps = [], [], []
    for i, w in enumerate(ways):
        if not points:
            nxt = ways[i + 1] if i + 1 < len(ways) else None
            if nxt and w[0] in (nxt[0], nxt[-1]):
                w = w[::-1]
            spans.append((0, len(w) - 1))
            points.extend(w)
            continue
        end = points[-1]
        if w[-1] == end or (w[0] != end and dist_m(end, w[-1]) < dist_m(end, w[0])):
            w = w[::-1]
        if w[0] == end:
            spans.append((len(points) - 1, len(points) - 2 + len(w)))
            points.extend(w[1:])
        else:
            gaps.append((len(points) - 1, round(dist_m(end, w[0]), 1)))
            spans.append((len(points), len(points) - 1 + len(w)))
            points.extend(w)
    return points, spans, gaps


def project(points, s, at, after=-1.0):
    """(distance along the polyline of its point nearest to `at`, metres from `at` to it), looking
    only past distance `after` (a ring passes its first station again at the end).
    Flat-earth maths around `at`, accurate at station scale."""
    k = R * math.pi / 180
    kx = k * math.cos(math.radians(at[0]))
    best_off, best_s = float("inf"), 0.0
    for i in range(len(points) - 1):
        if s[i + 1] <= after:
            continue
        ax, ay = (points[i][1] - at[1]) * kx, (points[i][0] - at[0]) * k
        dx, dy = (points[i + 1][1] - at[1]) * kx - ax, (points[i + 1][0] - at[0]) * k - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
        off = math.hypot(ax + t * dx, ay + t * dy)
        if off < best_off and s[i] + t * (s[i + 1] - s[i]) > after:
            best_off, best_s = off, s[i] + t * (s[i + 1] - s[i])
    return best_s, best_off


def cut(points, s, runs, a, b):
    """The polyline between distances a and b (at its nodes, so a little longer), with distances
    and structure runs measured from its new start."""
    i = max(j for j in range(len(s)) if s[j] <= a or j == 0)
    k = min(j for j in range(len(s)) if s[j] >= b or j == len(s) - 1)
    base = s[i]
    runs = [[round(max(x, s[i]) - base, 1), round(min(y, s[k]) - base, 1), *rest] for x, y, *rest in runs if y > s[i] and x < s[k]]
    return points[i:k + 1], [v - base for v in s[i:k + 1]], runs


def structure(spans, way_tags, s):
    """[s_start, s_end, kind, layer] runs along the track: kind is tunnel, elevated or at_grade, and
    layer OSM's `layer` tag (0 when unset), which tells which line is above where two cross."""
    runs = []
    for (a, b), tags in zip(spans, way_tags):
        kind = ("tunnel" if tags.get("tunnel", "no") != "no" else
                "elevated" if tags.get("bridge", "no") != "no" else "at_grade")
        try:
            layer = int(float(tags.get("layer", 0)))
        except ValueError:  # a malformed tag counts as unset
            layer = 0
        if runs and runs[-1][2:] == [kind, layer]:
            runs[-1][1] = s[b]
        else:
            runs.append([s[a], s[b], kind, layer])
    return [[round(a, 1), round(b, 1), kind, layer] for a, b, kind, layer in runs]


def pair_stops(pattern, stations, stops):
    """Pair a DMRC pattern with a run of an OSM relation's stop nodes by position in the list,
    forward or reversed, whichever puts the nodes closest to DMRC's stations. The run may be part of
    the relation (a branch or extension shares its parent's route), and a ring (first station
    again at the end) may start anywhere on it. Pairing by order, not by distance, because a few
    DMRC coordinates are hundreds of metres off (Dwarka Mor: 812 m). Returns
    (direction, [(code, node, metres from DMRC's coordinates)]) in the relation's order, or
    (None, []) when no run fits."""
    ring = pattern[:-1] if len(pattern) > 2 and pattern[0] == pattern[-1] else None
    cands = [ring[k:] + ring[:k + 1] for k in range(len(ring))] if ring else [pattern]
    best = (PAIR_MEDIAN_M, None, [])
    for cand in cands:
        for direction, nodes in (("forward", stops), ("reverse", stops[::-1])):
            for w in range(len(nodes) - len(cand) + 1):
                pairs = [(code, n, dist_m((stations[code]["lat"], stations[code]["lon"]), n["at"]))
                         for code, n in zip(cand, nodes[w:w + len(cand)])]
                median = sorted(off for *_, off in pairs)[len(pairs) // 2]
                if median <= best[0]:
                    best = (median, direction, pairs if direction == "forward" else pairs[::-1])
    return best[1], best[2]


def inner_loop(codes):
    """(i, j) where a station comes twice inside a pattern, codes[i] == codes[j], other than a ring's
    first and last station; else None. Such a loop is single track, run one way: Rapid Metro's from
    DLF Phase 2."""
    for j in range(1, len(codes)):
        if codes[j] in codes[:j] and not (j == len(codes) - 1 and codes[0] == codes[j]):
            return codes.index(codes[j]), j
    return None


def return_leg(pattern):
    """The stations trains call at coming back: a one-way loop inside the pattern is left out."""
    loop = inner_loop(pattern)
    return pattern[:loop[0]] + pattern[loop[1]:] if loop else pattern


def shift_left(points, s, d, keep=()):
    """Each point moved d metres to the left of the direction of travel (Delhi's trains run on the
    left), for a route OSM maps as one line used both ways. Inside the (lo, hi) ranges of s in
    `keep`, single track, the shift tapers to nothing over 100 m."""
    k, out = R * math.pi / 180, []
    for i, p in enumerate(points):
        east, north = xy(points[min(i + 1, len(points) - 1)], points[max(i - 1, 0)])
        n = math.hypot(east, north) or 1
        f = min([1.0] + [max(0.0, 1 - min(s[i] - lo, hi - s[i]) / 100) if lo < s[i] < hi else 1.0 for lo, hi in keep])
        out.append((p[0] + east / n * d * f / k, p[1] - north / n * d * f / (k * math.cos(math.radians(p[0])))))
    return out


def point_at(points, s, v):
    """The point at distance v along the polyline."""
    i = max(j for j in range(len(s) - 1) if s[j] <= v or j == 0)
    f = (v - s[i]) / (s[i + 1] - s[i]) if s[i + 1] > s[i] else 0.0
    return tuple(points[i][c] + f * (points[i + 1][c] - points[i][c]) for c in (0, 1))


def same_name(dmrc, osm):
    """Whether DMRC's and OSM's station names share a word ("SECTOR - 61 NOIDA" / "Noida Sector 61")."""
    words = lambda name: set(re.findall(r"[a-z0-9]+", (name or "").lower())) - {"sector", "metro", "station", "line", "blue"}
    return bool(words(dmrc) & words(osm))


def nearest_platform(at, platforms):
    """The OSM platform nearest `at` if it is within PLATFORM_RADIUS_M, else None."""
    near = [(project(p["points"], p["s"], at)[1], p) for p in platforms]
    near = [(off, p) for off, p in near if off <= PLATFORM_RADIUS_M]
    return min(near, key=lambda x: x[0])[1] if near else None


def platform_for(at, platforms, points, s):
    """The OSM platform nearest the stop node (within PLATFORM_RADIUS_M) as its extent along the
    track, or None. partial marks a platform mapped shorter than PARTIAL_PLATFORM_M."""
    p = nearest_platform(at, platforms)
    if p is None:
        return None
    along = [a for a, off in (project(points, s, pt) for pt in p["points"]) if off <= 2 * PLATFORM_RADIUS_M]
    if not along:
        return None
    length = max(along) - min(along)
    return {"osm_way": p["id"], "s_start": round(min(along), 1), "s_end": round(max(along), 1),
            "length_m": round(length, 1), "partial": length < PARTIAL_PLATFORM_M}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--line", action="append", help="DMRC line code, repeatable (default: LN3 LN4, the Blue Line)")
    ap.add_argument("--network", type=Path, default=HERE / "data" / "network.json")
    ap.add_argument("--out-dir", type=Path, default=HERE / "data" / "track")
    ap.add_argument("--cache-dir", type=Path, default=HERE / ".cache" / "osm")
    ap.add_argument("--max-age-hours", type=float, default=24, help="reuse a cached Overpass answer younger than this")
    ap.add_argument("--refresh", action="store_true", help="ignore the cache")
    args = ap.parse_args(argv)
    log = lambda *a: print(*a, file=sys.stderr)

    net = json.loads(args.network.read_text())
    lines = {ln["code"]: ln for ln in net["lines"]}
    codes = args.line or ["LN3", "LN4"]
    bad = [c for c in codes if c not in lines or not osm_route(c)]
    if bad:
        ap.error(f"no OSM route known for {bad} in {args.network}")

    nets = {}
    for c in codes:
        nets.setdefault(osm_route(c)[0], set()).add(osm_route(c)[1])
    rels = "".join(f'rel["type"="route"]["route"="subway"]["network"="{n}"]["ref"~"^({"|".join(sorted(refs))})$"]({BBOX});'
                   for n, refs in sorted(nets.items()))
    query = (f'[out:json][timeout:180];({rels})->.r;'
             f'.r out geom;(way(r.r);node(r.r););out tags;'
             f'node(r.r:"stop")->.s;'
             f'(way["railway"="platform"](around.s:60);way["public_transport"="platform"](around.s:60););out geom;')
    data = overpass(query, args.cache_dir, 0 if args.refresh else args.max_age_hours * 3600)

    tags, platforms, relations = {}, [], []
    for e in data["elements"]:
        if e["type"] == "relation":
            relations.append(e)
        elif "geometry" in e:
            pts = [(g["lat"], g["lon"]) for g in e["geometry"]]
            platforms.append({"id": e["id"], "points": pts, "s": cumulative(pts)})
        else:
            tags[(e["type"], e["id"])] = e.get("tags", {})

    # Which OSM relation runs each DMRC pattern, and in which direction.
    found, stop_counts = {}, {}
    for r in relations:
        here = [c for c in codes if osm_route(c) == (r["tags"].get("network"), r["tags"].get("ref"))]
        if not here:
            continue
        track = [m for m in r["members"] if m["type"] == "way" and m["role"] == "" and m.get("geometry")]
        ways = [[(g["lat"], g["lon"]) for g in m["geometry"]] for m in track]
        way_tags = [tags.get(("way", m["ref"]), {}) for m in track]
        stops = [{"id": m["ref"], "at": (m["lat"], m["lon"]), "name": tags.get(("node", m["ref"]), {}).get("name")}
                 for m in r["members"] if m["type"] == "node" and m["role"].startswith("stop")]
        points, spans, gaps = chain(ways)
        # OSM route tracks often end at a terminus's stop node, mid-platform (Vaishali: 104 m short of
        # the platform's far end). Add a straight way out to that end, tagged like its neighbour.
        extended = [0.0, 0.0]
        for end in (0, -1):
            plat = nearest_platform(stops[end]["at"], platforms) if stops else None
            to = run_on(points, plat["points"], end) if plat else None
            if to and end == 0:
                ways, way_tags = [[to, points[0]]] + ways, way_tags[:1] + way_tags
            elif to:
                ways, way_tags = ways + [[points[-1], to]], way_tags + way_tags[-1:]
            if to:
                extended[end] = round(dist_m(to, points[end]), 1)
        if any(extended):
            points, spans, gaps = chain(ways)
        full_s = cumulative(points)
        runs = structure(spans, way_tags, full_s)
        for code in here:
            stop_counts.setdefault(code, []).append(f"{r['id']}: {len(stops)}")
            # Where each of the relation's stops is along it, in its order: a stop it calls at twice
            # (Rapid Metro's DLF Phase 2, before and after the loop) gets each visit's own place.
            along, prev = {}, -1.0
            for n in stops:
                prev = along[id(n)] = project(points, full_s, n["at"], prev)[0]
            # Each pattern one way, and back with any one-way loop left out.
            legs = [(pi, want, pat) for pi, pattern in enumerate(lines[code]["patterns"])
                    for want, pat in (("forward", pattern), ("reverse", return_leg(pattern)))]
            for pi, want, pat in legs:
                direction, pairs = pair_stops(pat, net["stations"], stops)
                if direction != want:
                    continue
                # Keep the track from just before the first stop to just after the last.
                first, last = along[id(pairs[0][1])], along[id(pairs[-1][1])]
                a, b = max(first - CUT_MARGIN_M, 0), min(last + CUT_MARGIN_M, full_s[-1])
                kept, s, kept_runs = cut(points, full_s, runs, a, b)
                found.setdefault((code, pi, direction), []).append({
                    "relation": r, "points": kept, "s": s, "pairs": pairs, "structure": kept_runs, "ways": {m["ref"] for m in track},
                    "gaps": [(full_s[i] - a, metres) for i, metres in gaps if a <= full_s[i] <= b],
                    "extended": [extended[0] if a == 0 else 0.0, extended[1] if b == full_s[-1] else 0.0]})

    problems, warnings, out_files = 0, [], []
    for code in codes:
        line = lines[code]
        hop_seconds = {frozenset((h["from"], h["to"])): None if h.get("suspect") else h["seconds"] for h in line["hops"]}
        features, line_warnings = [], []
        for pi, pattern in enumerate(line["patterns"]):
            for direction in ("forward", "reverse"):
                label = f"{code} pattern {pi} {direction}"
                cands = sorted(found.get((code, pi, direction), []), key=lambda c: c["s"][-1])
                if not cands:
                    line_warnings.append(f"{label}: no OSM relation pairs with its {len(pattern)} stations; "
                                         f"stop nodes per relation: {stop_counts.get(code)}")
                    problems += 1
                    continue
                if len(cands) > 1:
                    line_warnings.append(f"{label}: {len(cands)} OSM relations fit, using the shortest")
                c = cands[0]
                rel, points, s = c["relation"], c["points"], c["s"]
                for at_s, metres in c["gaps"]:
                    line_warnings.append(f"{label}: track gap of {metres} m at s={at_s:.0f} in relation {rel['id']}")
                    problems += 1
                placed, stop_props = [], []
                for seq, (stn, node, offset) in enumerate(c["pairs"]):
                    along, off_track = project(points, s, node["at"], placed[-1]["s"] if placed else -1.0)
                    name = net["stations"][stn]["name"]
                    if not same_name(name, node["name"]) and OSM_NAMES.get(stn) != node["name"]:
                        line_warnings.append(f"{label}: {stn} '{name}' paired with OSM stop '{node['name']}'")
                        problems += 1
                    if offset > DMRC_OFFSET_WARN_M:
                        line_warnings.append(f"{label}: DMRC coordinates for {stn} '{name}' are {offset:.0f} m from OSM's stop")
                    if off_track > 25:
                        line_warnings.append(f"{label}: OSM stop for {stn} is {off_track:.0f} m off the track")
                    if placed and along <= placed[-1]["s"]:
                        line_warnings.append(f"{label}: {stn} is not past {placed[-1]['code']} along the track")
                        problems += 1
                    plat = platform_for(node["at"], platforms, points, s)
                    if plat and plat["partial"]:
                        line_warnings.append(f"{label}: OSM platform at {stn} is mapped only {plat['length_m']:.0f} m long")
                    placed.append({"code": stn, "s": along})
                    props = {"kind": "stop", "line": code, "pattern": pi, "direction": direction,
                             "seq": seq, "code": stn, "name": name, "osm_name": node["name"],
                             "osm_node": node["id"], "s": round(along, 1),
                             "dmrc_offset_m": round(offset, 1), "platform": plat}
                    stop_props.append(props)
                    features.append({"type": "Feature",
                                     "geometry": {"type": "Point", "coordinates": [round(node["at"][1], 6), round(node["at"][0], 6)]},
                                     "properties": props})
                hops = []
                for a, b in zip(placed, placed[1:]):
                    metres, secs = b["s"] - a["s"], hop_seconds.get(frozenset((a["code"], b["code"])))
                    kmh = round(metres / secs * 3.6, 1) if secs else None
                    hops.append({"from": a["code"], "to": b["code"], "track_m": round(metres, 1), "seconds": secs, "avg_kmh": kmh})
                    if kmh is not None and not 15 <= kmh <= 80:
                        line_warnings.append(f"{label}: {a['code']}->{b['code']} {metres:.0f} m in {secs} s = {kmh} km/h")
                # DMRC's time for a hop network.json marks suspect (2 s, 720 s) is replaced by its
                # track length at this direction's median hop speed, dwell included.
                speeds = sorted(h["avg_kmh"] for h in hops if h["avg_kmh"])
                for h in hops:
                    if h["seconds"] is None and speeds and h["track_m"] > 0:
                        h.update(seconds=round(h["track_m"] / (speeds[len(speeds) // 2] / 3.6)),
                                 avg_kmh=speeds[len(speeds) // 2], estimated=True)
                        line_warnings.append(f"{label}: {h['from']}->{h['to']} time estimated as {h['seconds']} s from its {h['track_m']:.0f} m")
                # OSM maps some routes (Rapid Metro) as one line used both ways: draw each direction on
                # its own track, left of that line, except on a single-track one-way loop.
                other = found.get((code, pi, "reverse" if direction == "forward" else "forward"), [])
                if other and min(other, key=lambda o: o["s"][-1])["ways"] == c["ways"]:
                    loop = inner_loop([p["code"] for p in placed])
                    keep = [(placed[loop[0]]["s"] + 50, placed[loop[1]]["s"] - 50)] if loop else []
                    if direction == "reverse" and return_leg(pattern) != pattern:  # it starts on the loop's single track
                        keep.append((-1e9, placed[0]["s"] - 50))
                    points = shift_left(points, s, TRACK_HALF_M, keep)
                    for f, p in zip(features[-len(placed):], placed):  # this direction's stops, on its own track
                        lat, lon = point_at(points, s, p["s"])
                        f["geometry"]["coordinates"] = [round(lon, 6), round(lat, 6)]
                features.append({"type": "Feature",
                                 "geometry": {"type": "LineString", "coordinates": [[round(lon, 6), round(lat, 6)] for lat, lon in points]},
                                 "properties": {"kind": "track", "line": code, "pattern": pi, "direction": direction,
                                                "from": placed[0]["code"], "to": placed[-1]["code"],
                                                "osm_relation": rel["id"], "osm_name": rel["tags"].get("name"),
                                                "length_m": round(s[-1], 1), "extended_m": c["extended"], "s": [round(v, 1) for v in s],
                                                "structure": c["structure"], "hops": hops}})
                log_summary(log, label, rel, s, c["structure"], stop_props, hops)
                if any(c["extended"]):
                    log(f"    track run on {c['extended'][0]} m before its start and {c['extended'][1]} m past its end "
                        "to reach terminal platforms")
        out = {"type": "FeatureCollection",
               "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "osm_base": data.get("osm3s", {}).get("timestamp_osm_base"),
               "attribution": "Track, stops and platforms (c) OpenStreetMap contributors, ODbL; station order and hop times DMRC",
               "warnings": line_warnings,
               "features": features}
        args.out_dir.mkdir(parents=True, exist_ok=True)
        path = args.out_dir / f"{code}.geojson"
        path.write_text(json.dumps(out, ensure_ascii=False))
        out_files.append(path)
        warnings += line_warnings
    for w in warnings:
        log("warning:", w)
    log(f"wrote {', '.join(str(p) for p in out_files)}; {problems} problems")
    return 2 if problems else 0


def log_summary(log, label, rel, s, runs, stops, hops):
    plats = [p["platform"]["length_m"] for p in stops if p["platform"] and not p["platform"]["partial"]]
    kmh = sorted(h["avg_kmh"] for h in hops if h["avg_kmh"])
    km = {}
    for a, b, kind, *_ in runs:
        km[kind] = km.get(kind, 0) + (b - a) / 1000
    log(f"{label}: relation {rel['id']} '{rel['tags'].get('name')}', {s[-1] / 1000:.2f} km, {len(stops)} stops; "
        + ", ".join(f"{k} {v:.1f} km" for k, v in sorted(km.items())))
    log(f"    full platforms {len(plats)}/{len(stops)}" + (f" ({min(plats):.0f}-{max(plats):.0f} m)" if plats else "")
        + (f"; hop average speed {kmh[0]}-{kmh[-1]} km/h, median {kmh[len(kmh) // 2]}" if kmh else ""))


if __name__ == "__main__":
    sys.exit(main())
