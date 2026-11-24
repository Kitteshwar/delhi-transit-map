# delhi-transit-map

Animated Delhi Metro map fed by DMRC's own data. So far: the network model
(`extract_dmrc_network.py`) and the track geometry from OpenStreetMap (`fetch_osm_track.py`).

## extract_dmrc_network.py

Builds `data/network.json` from the JSON API behind delhimetrorail.com
(`https://backend.delhimetrorail.com/api/v2/en`, undocumented, Cloudflare wants a `Referer`).

```
python3 extract_dmrc_network.py            # ~530 requests on a cold cache, about a minute
python3 extract_dmrc_network.py --refresh  # ignore the 24 h response cache in .cache/dmrc
python3 -m unittest discover -s tests      # offline tests
```

Exit code 2 when a line has a station not reachable from its prev/next data, a hop with
no time, or a line whose hop times do not add up to the planner's end-to-end time.

### What it does

1. `station_list`, then `station/{code}` for each: coordinates, type, interchange flag,
   opening/closing hours, and the prev/next station per line.
2. Per line in `line_list`: turn the prev/next declarations into directed edges and walk
   every root-to-leaf path. One path = one **pattern**. Green Line has two (Inderlok and
   Kirti Nagar both feed Ashok Park Main). Blue is two DMRC lines (LN3 Dwarka Sec 21-Noida
   Electronic City, LN4 Yamuna Bank-Vaishali); the Vaishali trains run through onto LN3 in
   practice, which is a timetable fact, not a topology one.
3. Per adjacent pair: `station_route/{a}/{b}/least-distance/{date}`. The answer must be one
   two-stop segment on the same line. Karkardooma-Anand Vihar is adjacent on Blue *and* Pink
   and the planner always answers Blue, so the Pink hop is measured as the three-hop span
   around it minus its two known neighbours (`measured_as_span`).
4. Loops: DMRC's prev/next data leaves two loops open, the Pink ring (Maujpur-Babarpur back to
   Yamuna Vihar) and the Rapid Metro loop (Phase 3 back to Phase 2). For a single-pattern line
   the planner is asked for last -> first stop; when its first step goes to an earlier stop of
   the pattern, the pattern ends on that stop and `loop: true` is set, so Rapid Metro reads
   `S55 ... SKRP, DL2, BEL, GAT, MAL, DL3, DL2`. A loop declared in prev/next data is kept the
   same way.
5. Check: for every pattern (a loop up to its last new station), planner end-to-end time on
   that line against the sum of its hops. They match to the second, so each hop is run time plus one dwell
   (`hop_seconds_include_one_dwell`). Where the planner prefers a route over other lines the
   check is reported as not comparable.
6. Hops outside 45-600 s are kept but marked `suspect` (DMRC's data has 2 s and 720 s hops).

### Output shape

```json
{
  "generated_at": "...", "source": "...", "route_date": "YYYY-MM-DD",
  "hop_seconds_include_one_dwell": true,
  "stations": {"KG": {"name": "KASHMERE GATE", "lat": 28.6675, "lon": 77.2282, "type": "Underground",
                      "interchange": true, "opening_time": "05:20:00", "closing_time": "23:47:00",
                      "lines": ["LN2", "LN1", "LN6"]}},
  "lines": [{"code": "LN2", "name": "Line 2", "color_name": "Yellow Line", "color": "#f6d71a",
             "status": "Normal Service", "dmrc_termini": ["...", "..."],
             "patterns": [["SPBI", "RISE", "..."]], "loop": false,
             "hops": [{"from": "SPBI", "to": "RISE", "seconds": 124}],
             "check": [{"from": "SPBI", "to": "HCC", "stops": 37, "sum_of_hops": 5002,
                        "planner_direct_same_line": 5002}]}],
  "warnings": ["..."]
}
```

Not included on purpose: platforms (DMRC only has platform numbers; `fetch_osm_track.py` gets
them from OSM),
the FOB pseudo-line (hidden on the DMRC site) and the Badli depot pseudo-station. Hops carry no
direction: the planner runs the Rapid Metro loop one way (Phase 3 to Moulsari Avenue goes the
long way round), which network.json does not record yet.

## fetch_osm_track.py

Builds `data/track/<LINE>.geojson`: per line and direction, the track as one line with distance
along it, DMRC's stations placed on it, platform extents and the tunnel/elevated stretches. Reads
station order and hop times from `data/network.json`, so run `extract_dmrc_network.py` first.
Geometry comes from OpenStreetMap through one Overpass query.

```
python3 fetch_osm_track.py                       # Blue Line (LN3 and LN4), about a minute cold
python3 fetch_osm_track.py --line LN2 --line LN7EXTN --line LN11  # other lines
python3 fetch_osm_track.py --refresh             # ignore the 24 h answer cache in .cache/osm
```

`--line` takes any line in `data/network.json` with a known OSM route: a numbered line (`LN<n>`)
is the Delhi Metro route whose `ref` is that number, an extension (`LN7EXTN`) is found on its
parent line's routes, `LN10` is `ref=AEx` and `LN11` is network `Rapid Metro Gurgaon`, `ref=RMGL`.
Every line has been run (OSM data of 24 Nov 2026; Blue Line of 18 Nov). Exit code 2 when a pattern direction has no OSM route that pairs with it, the route's
track has a gap, a DMRC station name does not match its OSM stop, or a stop is not past the one
before it along the track. Everything else is a warning, printed and kept in the file.

### What it does

1. Fetches the Delhi Metro `route=subway` relations with that `ref`, their track ways and stop
   nodes, and every `railway=platform` / `public_transport=platform` way within 60 m of a stop.
2. Joins each relation's ways into one line in travel order and measures distance along it
   (`s`, metres). A way that does not start where the last one ended is a gap.
3. At a terminus where OSM's track ends partway along the platform (it usually stops at the stop
   node), runs the track on straight to the platform's far end. The metres added before the
   start and past the end are `extended_m`; that piece takes the tags of the way next to it.
4. Pairs a run of the relation's stop nodes with a DMRC pattern by position in the list, forward
   or reversed, whichever leaves the lowest median DMRC-to-OSM offset under 300 m. By order, not
   by distance, because a few DMRC coordinates are far off (Dwarka Mor: 812 m). Warns over 100 m.
   The run can be part of the relation: the Pink Line extension (Maujpur to Shiv Vihar) and the
   Green Line's Kirti Nagar branch share their routes with other stops. A ring (LN7 starts and
   ends at Yamuna Vihar) may start at any of its stations, and is started where OSM starts it,
   at Maujpur. The track is then cut to 300 m either side of the run's first and last stop.
   A station whose OSM name differs from DMRC's but whose position matches is listed in
   `OSM_NAMES` and not reported (DMRC's North Pitampura is OSM's "Haiderpur Village", 170 m off).
5. For each stop, the platform within 30 m of its node, as `s_start`-`s_end` along the track.
   Under 120 m is `partial` (OSM maps a fragment; Blue Line platforms are about 180 m).
6. Tunnel, elevated (`bridge=*`) and at-grade runs from the way tags, and per hop the track
   metres against DMRC's seconds as average km/h, warning outside 15-80 km/h. A hop that
   `network.json` marks `suspect` (DMRC gives 2 s or 720 s) gets its track metres at the
   direction's median hop speed instead, marked `estimated` (LN8 Krishna Park Extension to
   Janakpuri West: 720 s replaced by 248 s for 2,250 m).

### Output shape

A GeoJSON FeatureCollection; open it in geojson.io or QGIS to check it by eye. Values below are
real ones from LN3 and LN4, shortened.

```json
{
  "type": "FeatureCollection", "generated_at": "...", "osm_base": "...", "attribution": "...",
  "warnings": ["..."],
  "features": [
    {"geometry": {"type": "LineString", "coordinates": [[77.058427, 28.55201], "..."]},
     "properties": {"kind": "track", "line": "LN3", "pattern": 0, "direction": "forward",
                    "from": "DSTO", "to": "NECC", "osm_relation": 8037669, "osm_name": "...",
                    "length_m": 55644.0, "extended_m": [0.0, 0.0], "s": [0.0, 420.8, "..."],
                    "structure": [[0.0, 1027.4, "tunnel"], "..."],
                    "hops": [{"from": "DSTO", "to": "DSET", "track_m": 1751.1, "seconds": 181, "avg_kmh": 34.8}]}},
    {"geometry": {"type": "Point", "coordinates": [77.267951, 28.623307]},
     "properties": {"kind": "stop", "line": "LN4", "pattern": 0, "direction": "forward", "seq": 0,
                    "code": "YB", "name": "YAMUNA BANK", "osm_name": "Yamuna Bank",
                    "osm_node": 5737168028, "s": 97.5, "dmrc_offset_m": 5.1,
                    "platform": {"osm_way": 696173227, "s_start": 0.0, "s_end": 179.3, "length_m": 179.3, "partial": false}}}
  ]
}
```

`direction` is relative to the DMRC pattern: `forward` runs the pattern's stops in order, and
`reverse` runs them back. `platform` is `null` where OSM maps none.

Blue Line as of OSM data from 18 Nov 2026: LN3 55.6 km (3.4 km tunnel, 50.4 km elevated) with a
full platform at 6 of 50 stations; LN4 8.4 km with 3 of 8. Stop nodes sit mid-platform (83-106 m
from a platform end), so a train's front stops about half a train length past its stop node.

Track, stops and platforms are (c) OpenStreetMap contributors under the ODbL: credit OSM wherever
they are shown or published.
