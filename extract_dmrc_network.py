#!/usr/bin/env python3
"""Build the Delhi Metro network model (stations, line topology, inter-station times)
from the JSON API behind delhimetrorail.com and write it as one JSON file.

The API is undocumented and sits behind Cloudflare, which answers 403 without a
Referer header. Every response is cached on disk, so a re-run within
--max-age-hours makes no network calls.

Hop times come from DMRC's route planner asked for each pair of adjacent stations.
They are additive along a line (the end of the run checks this), so each hop is
run time plus one dwell.
"""
import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://backend.delhimetrorail.com/api/v2/en"
HEADERS = {
    "User-Agent": "delhi-transit-map/0.1 (personal non-commercial project; python-urllib)",
    "Accept": "application/json",
    "Referer": "https://delhimetrorail.com/",  # Cloudflare returns 403 without it
}
IST = timezone(timedelta(hours=5, minutes=30))
HERE = Path(__file__).resolve().parent


class Api:
    """GET JSON from the DMRC API with an on-disk cache, retries and a small thread pool."""

    def __init__(self, cache_dir, max_age_s, workers=4):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.max_age_s = max_age_s
        self.workers = workers

    def get(self, path):
        cached = self.cache_dir / (urllib.parse.quote(path, safe="") + ".json")
        if cached.exists() and time.time() - cached.stat().st_mtime < self.max_age_s:
            return json.loads(cached.read_text())
        url = API + "/" + urllib.parse.quote(path)
        err = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers=HEADERS)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                cached.write_text(json.dumps(data))
                return data
            except urllib.error.HTTPError as e:
                err = e
                if e.code == 404:
                    break
            except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
                err = e
            time.sleep(2 ** attempt + random.random())
        raise RuntimeError(f"GET {url} failed: {err}")

    def get_many(self, paths):
        """Results in input order; a failed request yields its exception instead of raising."""
        def one(path):
            try:
                return self.get(path)
            except RuntimeError as e:
                return e
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            return list(pool.map(one, paths))


def line_edges(stations, line_id):
    """Directed (prev -> station) and (station -> next) edges that a line's stations declare."""
    edges = set()
    for code, st in stations.items():
        for group in st.get("prev_next_stations", []):
            for entries in group.values():
                for e in entries:
                    if e.get("line_id") != line_id:
                        continue
                    if e.get("prev_station"):
                        edges.add((e["prev_station"]["station_code"], code))
                    if e.get("next_station"):
                        edges.add((code, e["next_station"]["station_code"]))
    return edges


def patterns_from_edges(edges):
    """Every root-to-leaf path through the directed edges, each a list of station codes.

    A branch inside one line (Green: Inderlok and Kirti Nagar both feed Ashok Park Main)
    gives one pattern per root. A path that runs back into itself ends on the station it
    returns to, so a loop shows as a repeated last station. A pure cycle has no root and is
    walked once from its smallest code.
    """
    succ, pred = {}, {}
    for a, b in edges:
        succ.setdefault(a, set()).add(b)
        succ.setdefault(b, set())
        pred.setdefault(b, set()).add(a)
        pred.setdefault(a, set())
    roots = sorted(n for n in succ if not pred[n]) or sorted(succ)[:1]
    patterns = []

    def walk(path):
        here = succ[path[-1]]
        for n in sorted(here & set(path)):
            patterns.append(path + [n])
        for n in sorted(here - set(path)):
            walk(path + [n])
        if not here:
            patterns.append(path)

    for root in roots:
        walk([root])
    return patterns


def hop_pairs(patterns):
    """Unique adjacent pairs across patterns, in the direction trains run them."""
    seen, pairs = set(), []
    for p in patterns:
        for a, b in zip(p, p[1:]):
            if frozenset((a, b)) not in seen:
                seen.add(frozenset((a, b)))
                pairs.append((a, b))
    return pairs


def span_around(patterns, a, b):
    """(prev, next) enclosing the adjacent pair a->b in some pattern; None when a or b ends it."""
    for p in patterns:
        i = p.index(a) if a in p else -1
        if 0 < i and i + 2 < len(p) and p[i + 1] == b:
            return p[i - 1], p[i + 2]
    return None


def hms_to_seconds(text):
    h, m, s = (int(x) for x in text.split(":"))
    return h * 3600 + m * 60 + s


def segment_seconds(route, line_color, stops):
    """Total seconds when the planner answered with exactly one segment on this line through
    `stops` stations, else None (it took another line, or an interchange)."""
    segs = route.get("route") or []
    if len(segs) == 1 and len(segs[0].get("path") or []) == stops and segs[0].get("line") == line_color:
        return hms_to_seconds(route["total_time"])
    return None


def loop_closure(route, line_color, pattern):
    """The station the planner goes to first from the pattern's last stop, when that is an earlier
    stop of the pattern other than the one before it (the line loops back there), else None."""
    segs = route.get("route") or []
    if len(segs) != 1 or segs[0].get("line") != line_color:
        return None
    first = (segs[0].get("map-path") or [""])[0]  # "DL3-DL2": codes; display names differ for renamed stations
    head = pattern[-1] + "-"
    nxt = first[len(head):] if first.startswith(head) else None
    return nxt if nxt in pattern[:-2] else None


def station_record(st):
    def num(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return None

    return {
        "name": st["station_name"],
        "lat": num(st.get("latitude")),
        "lon": num(st.get("longitude")),
        "type": st.get("station_type"),
        "interchange": bool(st.get("interchange")),
        "opening_time": st.get("opening_time"),
        "closing_time": st.get("closing_time"),
        "lines": [l["line_code"] for l in st.get("metro_lines", []) if isinstance(l, dict)],
    }


def change_minutes(route, x, line_a, y, line_b):
    """Minutes the planner allows to change from line_a (colour name) at station x to line_b at y,
    from a trip whose first leg is on line_a ending at x and last on line_b starting at y, with
    nothing between but walks on hidden links (Dhaula Kuan's foot bridge, "FOB"): the interchange
    times of the later legs plus the walks' own times. None for any other trip."""
    legs = route.get("route") or []
    ends = lambda leg, i: (leg.get("map-path") or ["-"])[i].split("-")[i]
    if (len(legs) < 2 or legs[0].get("line") != line_a or legs[-1].get("line") != line_b
            or ends(legs[0], -1) != x or ends(legs[-1], 0) != y):
        return None
    walks = legs[1:-1]
    return (sum(leg.get("station_interchange_time") or 0 for leg in legs[1:])
            + sum(hms_to_seconds(leg["path_time"]) for leg in walks) / 60)


def interchanges(api, stations, lines, route_date):
    """Per change of line, at a station two lines share or across a hidden line's link between two
    stations: {from, to (station codes), lines: [from's, to's], minutes, via: hidden lines walked}.
    The planner is asked for trips from a neighbour on one line to a neighbour on the other, until
    one changes there. A branch and its own line (EXTN, LN4 with LN3) do not count."""
    shown = {ln["code"]: ln for ln in lines}
    family = lambda c: "LN3" if c == "LN4" else c.replace("EXTN", "")
    def neighbours(code, x):
        return sorted({p[j] for p in shown[code]["patterns"] for i, c in enumerate(p) if c == x
                       for j in (i - 1, i + 1) if 0 <= j < len(p) and p[j] != x})
    pairs = []
    for x, st in sorted(stations.items()):
        here = [c for c in st["lines"] if c in shown]
        pairs += [(x, a, x, b, []) for i, a in enumerate(here) for b in here[i + 1:] if family(a) != family(b)]
        for hidden in (c for c in st["lines"] if c not in shown):
            for y, other in sorted(stations.items()):
                if y > x and hidden in other["lines"]:
                    pairs += [(x, a, y, b, [hidden]) for a in here for b in other["lines"] if b in shown]
    trips = [[(na, nb) for na in neighbours(a, x) for nb in neighbours(b, y) if na != nb] for x, a, y, b, _ in pairs]
    found = [None] * len(pairs)
    for k in range(max(map(len, trips), default=0)):  # one more trip per round for the pairs still open
        ask = [n for n, t in enumerate(trips) if found[n] is None and k < len(t)]
        for n, ans in zip(ask, api.get_many([route_path(*trips[n][k], route_date) for n in ask])):
            x, a, y, b, _ = pairs[n]
            if not isinstance(ans, Exception):
                found[n] = change_minutes(ans, x, shown[a]["color_name"], y, shown[b]["color_name"])
    out = [{"from": x, "to": y, "lines": [a, b], "minutes": m, "via": via}
           for (x, a, y, b, via), m in zip(pairs, found) if m is not None]
    missing = [f"{x}/{y} {a}-{b}" for (x, a, y, b, _), m in zip(pairs, found) if m is None]
    return out, missing


def route_path(a, b, route_date):
    return f"station_route/{a}/{b}/least-distance/{route_date}"


def known_hops(line):
    return {frozenset((h["from"], h["to"])): h["seconds"] for h in line["hops"]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=HERE / "data" / "network.json")
    ap.add_argument("--cache-dir", type=Path, default=HERE / ".cache" / "dmrc")
    ap.add_argument("--max-age-hours", type=float, default=24, help="reuse cached API responses younger than this")
    ap.add_argument("--refresh", action="store_true", help="ignore the cache")
    args = ap.parse_args(argv)

    api = Api(args.cache_dir, 0 if args.refresh else args.max_age_hours * 3600)
    route_date = datetime.now(IST).date().isoformat()
    warnings = []
    log = lambda *a: print(*a, file=sys.stderr)

    # 1. Stations: the list, then one detail call each (coordinates, prev/next per line, hours).
    station_list = api.get("station_list")
    log(f"station_list: {len(station_list)} entries; fetching details")
    details = api.get_many([f"station/{s['station_code']}" for s in station_list])
    stations = {}
    for s, d in zip(station_list, details):
        if isinstance(d, Exception) or not isinstance(d, dict):
            warnings.append(f"station/{s['station_code']}: {d}")
        elif not any(isinstance(l, dict) for l in d.get("metro_lines", [])):
            warnings.append(f"station/{s['station_code']} ({d.get('station_name')}): no metro line, skipped")
        else:
            stations[s["station_code"]] = d

    # 2. Topology per line from the stations' prev/next declarations.
    lines = []
    for line in api.get("line_list"):
        if not line.get("show_in_frontend"):
            warnings.append(f"{line['line_code']} ({line['line_color']}): hidden on DMRC site, skipped")
            continue
        patterns = patterns_from_edges(line_edges(stations, line["id"]))
        members = {c for c, d in stations.items()
                   if any(isinstance(l, dict) and l["id"] == line["id"] for l in d["metro_lines"])}
        unwalked = sorted(members - {c for p in patterns for c in p})
        if unwalked:
            warnings.append(f"{line['line_code']}: stations on the line but not in any pattern: {unwalked}")
        unknown = sorted({c for p in patterns for c in p} - set(stations))
        if unknown:
            warnings.append(f"{line['line_code']}: pattern references stations missing from station_list: {unknown}")
        lines.append({
            "code": line["line_code"],
            "name": line["name"],
            "color_name": line["line_color"],
            "color": line.get("primary_color_code"),
            "status": line.get("status"),
            "dmrc_termini": [line.get("start_station"), line.get("end_station")],
            "patterns": patterns,
            "loop": False,
            "hops": [],
            "check": [],
        })

    # Loops the prev/next data leaves open: the Pink ring (Maujpur-Babarpur back to Yamuna Vihar) and
    # the Rapid Metro loop (Phase 3 back to Phase 2). The planner's answer for last -> first stop
    # starts with the station a train goes to after the last one; close the pattern on it.
    open_lines = [ln for ln in lines if len(ln["patterns"]) == 1 and len(ln["patterns"][0]) > 2
                  and ln["patterns"][0][-1] not in ln["patterns"][0][:-1]]
    probes = api.get_many([route_path(ln["patterns"][0][-1], ln["patterns"][0][0], route_date) for ln in open_lines])
    for ln, ans in zip(open_lines, probes):
        back_to = None if isinstance(ans, Exception) else loop_closure(ans, ln["color_name"], ln["patterns"][0])
        if back_to:
            ln["patterns"][0].append(back_to)
    for ln in lines:
        ln["loop"] = any(p[-1] in p[:-1] for p in ln["patterns"])

    # 3. Run times: one planner call per adjacent pair.
    hop_queries = [(idx, a, b) for idx, ln in enumerate(lines) for a, b in hop_pairs(ln["patterns"])]
    log(f"{len(lines)} lines, {len(hop_queries)} hop queries")
    answers = api.get_many([route_path(a, b, route_date) for _, a, b in hop_queries])
    taken_over = []
    for (idx, a, b), ans in zip(hop_queries, answers):
        secs = None if isinstance(ans, Exception) else segment_seconds(ans, lines[idx]["color_name"], 2)
        if secs is not None:
            lines[idx]["hops"].append({"from": a, "to": b, "seconds": secs})
        else:
            taken_over.append((idx, a, b, ans))

    # A pair adjacent on two lines (Karkardooma-Anand Vihar is on Blue and Pink) is answered on the
    # other line. Measure it as the three-hop span prev->next on this line minus the two known hops.
    spans = [(idx, a, b, ans, span_around(lines[idx]["patterns"], a, b)) for idx, a, b, ans in taken_over]
    span_answers = iter(api.get_many([route_path(*around, route_date) for *_, around in spans if around]))
    for idx, a, b, ans, around in spans:
        secs = None
        if around:
            span = next(span_answers)
            total = None if isinstance(span, Exception) else segment_seconds(span, lines[idx]["color_name"], 4)
            outer = [known_hops(lines[idx]).get(frozenset(pair)) for pair in ((around[0], a), (b, around[1]))]
            if total is not None and None not in outer:
                secs = total - sum(outer)
        hop = {"from": a, "to": b, "seconds": secs}
        if secs is not None:
            hop["measured_as_span"] = list(around)
        else:
            detail = ans if isinstance(ans, Exception) else [(s.get("line"), len(s.get("path") or [])) for s in ans.get("route") or []]
            warnings.append(f"{lines[idx]['code']}: no time for {a}->{b}; planner answered {detail}")
        lines[idx]["hops"].append(hop)

    # DMRC's planner carries a few impossible hops (2 s Burari->Majlis Park, 12 min Krishna Park
    # Ext->Janakpuri West); every real hop measured so far is 70-360 s. Keep the value, flag it.
    for ln in lines:
        for h in ln["hops"]:
            if h["seconds"] is not None and not 45 <= h["seconds"] <= 600:
                h["suspect"] = True
                warnings.append(f"{ln['code']}: implausible hop {h['from']}->{h['to']} = {h['seconds']}s, "
                                "estimate it from track length instead")

    # 4. Additivity check: planner end-to-end time on this line vs the sum of its hops, for a loop
    # pattern up to its last new station.
    checks = [(idx, p[:-1] if p[-1] in p[:-1] else p) for idx, ln in enumerate(lines) for p in ln["patterns"]]
    checks = [(idx, p) for idx, p in checks if len(p) > 1]
    answers = api.get_many([route_path(p[0], p[-1], route_date) for _, p in checks])
    for (idx, p), ans in zip(checks, answers):
        legs = [known_hops(lines[idx]).get(frozenset(pair)) for pair in zip(p, p[1:])]
        lines[idx]["check"].append({
            "from": p[0], "to": p[-1], "stops": len(p),
            "sum_of_hops": None if None in legs else sum(legs),
            # None when the planner preferred a route over other lines, which says nothing about our hops
            "planner_direct_same_line": None if isinstance(ans, Exception) else segment_seconds(ans, lines[idx]["color_name"], len(p)),
        })

    # 5. Walking time to change lines at each interchange.
    records = {c: station_record(d) for c, d in sorted(stations.items())}
    changes, missing = interchanges(api, records, lines, route_date)
    warnings += [f"interchange {m}: the planner gave no trip changing there" for m in missing]

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": API,
        "route_date": route_date,
        "hop_seconds_include_one_dwell": True,
        "stations": records,
        "lines": lines,
        "interchanges": changes,
        "warnings": warnings,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1, ensure_ascii=False))

    problems = sum("not in any pattern" in w or "missing from station_list" in w for w in warnings)
    for ln in lines:
        missing = sum(h["seconds"] is None for h in ln["hops"])
        problems += missing
        log(f"{ln['code']:8} {ln['color_name']:15} patterns={len(ln['patterns'])} "
            f"stops={sorted(len(p) for p in ln['patterns'])} hops={len(ln['hops'])} "
            f"missing={missing} loop={ln['loop']}")
        for c in ln["check"]:
            direct = c["planner_direct_same_line"]
            if direct is None:
                verdict = "planner routed over other lines, not comparable"
            elif direct == c["sum_of_hops"]:
                verdict = f"planner {direct}s, additive"
            else:
                verdict = f"planner {direct}s  <-- NOT additive"
                problems += 1
            log(f"         {c['from']}->{c['to']} ({c['stops']} stops): hops {c['sum_of_hops']}s; {verdict}")
    for w in warnings:
        log("warning:", w)
    log(f"wrote {args.out}: {len(out['stations'])} stations, {len(lines)} lines, {problems} problems")
    return 2 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
