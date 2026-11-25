// Optional live corrections from the user's own location: which track a GPS fix lies on, and which
// scheduled train the user is on or waiting for, so the map can run that train late or early to
// match. Pure functions; the page keeps every fix in memory only and sends none anywhere.
import { trainFront } from './motion.js';

const M_PER_DEG = 6371008.8 * Math.PI / 180;

// Nearest point of a track (coords [lon, lat], distances s) to `at` [lon, lat]: {s, off} in metres.
export function project(coords, s, at) {
  const kx = M_PER_DEG * Math.cos(at[1] * Math.PI / 180);
  let best = { s: 0, off: Infinity };
  for (let i = 0; i + 1 < coords.length; i++) {
    const ax = (coords[i][0] - at[0]) * kx, ay = (coords[i][1] - at[1]) * M_PER_DEG;
    const dx = (coords[i + 1][0] - at[0]) * kx - ax, dy = (coords[i + 1][1] - at[1]) * M_PER_DEG - ay;
    const seg = dx * dx + dy * dy, f = seg ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / seg)) : 0;
    const off = Math.hypot(ax + f * dx, ay + f * dy);
    if (off < best.off) best = { s: s[i] + f * (s[i + 1] - s[i]), off };
  }
  return best;
}

// Seconds after leaving its first station at which a train on plan p first has its front at s.
export function timeAt(p, s) {
  let lo = 0, hi = p.total;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (trainFront(p, mid) < s) lo = mid; else hi = mid;
  }
  return hi;
}

// The departure whose train is nearest to having its front at s at time `now` (seconds, on the
// departures' clock), and how many seconds late it is (negative: early); null if none is within
// `window` seconds.
export function matchTrain(p, departures, now, s, window = 900) {
  const tau = timeAt(p, s);
  let best = null;
  departures.forEach((dep, k) => {
    const late = now - dep - tau;
    if (Math.abs(late) <= window && (!best || Math.abs(late) < Math.abs(best.late))) best = { k, late };
  });
  return best;
}

// From fixes ([lon, lat], oldest first) taken on board, the track ({coords, s}) the train runs on:
// every fix within `near` metres of it, and moving forward along it by at least `moved` metres
// (on the other direction's track they move backwards). The one with most progress wins.
// Returns {index, s} with s at the latest fix, or null while that is not yet clear.
export function onTrack(tracks, fixes, near = 60, moved = 40) {
  let best = null;
  tracks.forEach((t, index) => {
    const at = fixes.map(f => project(t.coords, t.s, f));
    if (at.some(a => a.off > near)) return;
    const gain = at[at.length - 1].s - at[0].s;
    if (gain >= moved && (!best || gain > best.gain)) best = { index, s: at[at.length - 1].s, gain };
  });
  return best && { index: best.index, s: best.s };
}

// The station ({at: [lon, lat]}) nearest `at`, if within `within` metres, else null.
export function nearestStation(stations, at, within = 400) {
  const kx = M_PER_DEG * Math.cos(at[1] * Math.PI / 180);
  let best = null, bestD = within;
  for (const st of stations) {
    const d = Math.hypot((st.at[0] - at[0]) * kx, (st.at[1] - at[1]) * M_PER_DEG);
    if (d <= bestD) { bestD = d; best = st; }
  }
  return best;
}
