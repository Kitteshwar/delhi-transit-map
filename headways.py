#!/usr/bin/env python3
"""Expand config/headways.json into terminal departure times per line, direction and day type, and
write data/schedule.json for the map client. Every departure is an estimate (the config says where
each number comes from); the client runs each one along the line with the hop times in
data/network.json. Also prints how many trains the profile keeps on the line at once, as a check
against the real fleet."""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DAYS = ("weekday", "saturday", "sunday")
DIRECTIONS = ("forward", "reverse")  # forward = the DMRC pattern's stop order, as in data/track/


def secs(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 3600 + int(m) * 60


def hms(t):
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def check(code, profile):
    """Raise ValueError naming the first thing wrong with a line's profile."""
    firsts = []
    for d in DIRECTIONS:
        first, last = secs(profile["first_departure"][d]), secs(profile["last_departure"][d])
        if first > last:
            raise ValueError(f"{code} {d}: first departure is after the last")
        firsts.append(first)
    for day in DAYS:
        bands = profile["headways"][day]
        starts = [secs(s) for s, _ in bands]
        if not bands or starts != sorted(set(starts)):
            raise ValueError(f"{code} {day}: headway bands must exist and start at increasing times")
        if any(not isinstance(h, int) or h <= 0 for _, h in bands):
            raise ValueError(f"{code} {day}: headways must be positive whole seconds")
        if starts[0] > min(firsts):
            raise ValueError(f"{code} {day}: no headway band covers the first departure")


def departures(profile, direction, day):
    """Departure seconds after midnight from the first terminal, from the first train to the last."""
    bands = [(secs(s), h) for s, h in profile["headways"][day]]
    t, last = secs(profile["first_departure"][direction]), secs(profile["last_departure"][direction])
    out = []
    while t <= last:
        out.append(t)
        headway = next(h for s, h in reversed(bands) if s <= t)
        t += headway
    # DMRC's last train leaves at a fixed time: always end on it. Moving the final train onto it
    # instead would open a gap of up to 1.5 headways (LN4: 18:48 against a 14-minute headway).
    if out[-1] != last:
        out.append(last)
    return out


def most_in_service(trips):
    """Most trains running at once; trips are (departure, run seconds). Time at the terminals is not
    counted, so the real fleet needed is higher."""
    events = sorted([(d, 1) for d, _ in trips] + [(d + r, -1) for d, r in trips])  # arrivals sort first on a tie
    n = best = 0
    for _, step in events:
        n += step
        best = max(best, n)
    return best


def run_seconds(line, pattern=0):
    hop = {frozenset((h["from"], h["to"])): h["seconds"] for h in line["hops"]}
    p = line["patterns"][pattern]
    legs = [hop.get(frozenset(pair)) for pair in zip(p, p[1:])]
    if None in legs:
        raise ValueError(f"{line['code']}: network.json has a hop without a time")
    return sum(legs)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=HERE / "config" / "headways.json")
    ap.add_argument("--network", type=Path, default=HERE / "data" / "network.json")
    ap.add_argument("--out", type=Path, default=HERE / "data" / "schedule.json")
    args = ap.parse_args(argv)

    config = json.loads(args.config.read_text())
    lines = {ln["code"]: ln for ln in json.loads(args.network.read_text())["lines"]}
    out = {"status": config.get("status", "estimated"),
           "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "config": str(args.config), "lines": {}}
    for key, profile in config["lines"].items():
        code, _, pattern = key.partition(":")  # "LN5:1" is LN5's second DMRC pattern
        if code not in lines or not pattern.isdigit() and pattern:
            sys.exit(f"{key} is in {args.config} but not a line in {args.network}")
        if int(pattern or 0) >= len(lines[code]["patterns"]):
            sys.exit(f"{key}: {code} has {len(lines[code]['patterns'])} patterns")
        check(key, profile)
        run = run_seconds(lines[code], int(pattern or 0))
        entry = {"run_seconds": run}
        for day in DAYS:
            deps = {d: departures(profile, d, day) for d in DIRECTIONS}
            entry[day] = {d: [hms(t) for t in deps[d]] for d in DIRECTIONS}
            peak = most_in_service([(t, run) for d in DIRECTIONS for t in deps[d]])
            print(f"{key} {day:8} departures forward {len(deps['forward'])}, reverse {len(deps['reverse'])}; "
                  f"most trains running at once {peak} ({run / 60:.0f} min end to end)", file=sys.stderr)
        out["lines"][key] = entry
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1))
    print(f"wrote {args.out} ({out['status']})", file=sys.stderr)


if __name__ == "__main__":
    main()
