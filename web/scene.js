// 3D scene for the map: rail height along each track, and footprints of cars, viaduct and stations
// as GeoJSON polygons carrying base and top heights, for MapLibre fill-extrusion layers. Pure functions.
import { slice, CAR_M, GAP_M, TRAIN_M, CARS, BOGIE_M } from './motion.js';

export const DECK_M = 12;   // rail height on a viaduct; DMRC viaducts carry the track roughly 10-15 m up
export const RAMP_M = 400;  // slope length between levels: 12 m up to a viaduct is a 3% grade
export const DEPTH_M = 16;  // rail depth in tunnel; Delhi's underground sections run about 12-20 m down
export const CAR_W = 3.2;   // DMRC broad-gauge car width
export const STEP = 10;     // metres between height samples, and the length of one viaduct piece
export const LEVEL_M = 10;  // how far a line rises over (or dips under) another it crosses at its own level
const CROSS_M = 250;        // the raised (or lowered) stretch either side of the crossing, before the ramps
const M_PER_DEG = 6371008.8 * Math.PI / 180;

// Rail height above the street (negative in tunnel) every STEP metres along a track, from its structure runs
// ([s_start, s_end, 'tunnel' | 'elevated' | 'at_grade']), and whether each sample is in tunnel.
// bumps: {s, dz} from crossings(), where the track rises over or dips under another line.
export function heights(structure, length, bumps = []) {
  const n = Math.floor(length / STEP) + 1, raw = new Float64Array(n), tunnel = new Array(n);
  let r = 0;
  for (let i = 0; i < n; i++) {
    while (r < structure.length - 1 && structure[r][1] < i * STEP) r++;
    const kind = structure.length ? structure[r][2] : 'at_grade';
    raw[i] = kind === 'elevated' ? DECK_M : kind === 'tunnel' ? -DEPTH_M : 0;
    tunnel[i] = kind === 'tunnel';
    let up = 0, down = 0;  // one rise and one dip at most: each direction of a crossing line is a bump
    for (const b of bumps) if (Math.abs(i * STEP - b.s) <= CROSS_M) { up = Math.max(up, b.dz); down = Math.min(down, b.dz); }
    raw[i] += up + down;
  }
  // A moving average over RAMP_M turns each change of level into a straight slope.
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + raw[i];
  const w = Math.round(RAMP_M / STEP / 2), h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1);
    h[i] = (pre[hi] - pre[lo]) / (hi - lo);
  }
  return { h, tunnel };
}

export function heightAt(H, s) {
  const x = Math.min(Math.max(s / STEP, 0), H.h.length - 1), i = Math.floor(x), j = Math.min(i + 1, H.h.length - 1);
  return H.h[i] + (x - i) * (H.h[j] - H.h[i]);
}

// Where tracks ({line, coords, s, structure}) of different lines cross at the same level, both on
// viaducts or both in tunnel, which one goes over: the one OSM's layer tag (4th structure field)
// puts higher; on a tie the later line (higher DMRC number), which rises over on a viaduct and dips
// under in tunnel, as Delhi's newer lines were built across its older ones. Returns, per track, the
// places it rises (dz = LEVEL_M) or dips (-LEVEL_M), as heights() takes them. A grid of 200 m
// cells keeps it to segments that could meet.
export function crossings(tracks) {
  const kx = M_PER_DEG * Math.cos(28.6 * Math.PI / 180), CELL = 200;
  const pts = tracks.map(t => t.coords.map(([lon, lat]) => [lon * kx, lat * M_PER_DEG]));
  const family = code => code.replace('EXTN', '').replace(/^LN4$/, 'LN3');  // a branch meets its own line by design
  const runAt = (st, d) => st.find(([a, b]) => a <= d && d <= b) || st[st.length - 1];
  const grid = new Map();
  pts.forEach((P, t) => P.slice(1).forEach((q, i) => {
    const p = P[i], [x0, x1, y0, y1] = [p[0], q[0], p[1], q[1]].map(v => Math.floor(v / CELL));
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      const key = `${x},${y}`;
      (grid.get(key) || grid.set(key, []).get(key)).push([t, i]);
    }
  }));
  const bumps = tracks.map(() => []), seen = new Set();
  for (const list of grid.values()) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
    const [t1, i] = list[a], [t2, j] = list[b], key = `${t1},${i},${t2},${j}`;
    if (family(tracks[t1].line) === family(tracks[t2].line) || seen.has(key)) continue;
    seen.add(key);
    const [p1, p2, p3, p4] = [pts[t1][i], pts[t1][i + 1], pts[t2][j], pts[t2][j + 1]];
    const den = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (!den) continue;
    const u = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / den;
    const v = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / den;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const s1 = tracks[t1].s[i] + u * (tracks[t1].s[i + 1] - tracks[t1].s[i]), s2 = tracks[t2].s[j] + v * (tracks[t2].s[j + 1] - tracks[t2].s[j]);
    const r1 = runAt(tracks[t1].structure, s1), r2 = runAt(tracks[t2].structure, s2);
    if (r1[2] !== r2[2] || r1[2] === 'at_grade') continue;  // already at different levels
    const over = r1[2] === 'elevated', l1 = r1[3] || 0, l2 = r2[3] || 0;
    const firstMoves = l1 !== l2 ? (over ? l1 > l2 : l1 < l2) : parseInt(tracks[t1].line.slice(2), 10) > parseInt(tracks[t2].line.slice(2), 10);
    bumps[firstMoves ? t1 : t2].push({ s: firstMoves ? s1 : s2, dz: over ? LEVEL_M : -LEVEL_M });
  }
  return bumps;
}

export const inTunnel = (H, s) => H.tunnel[Math.min(Math.max(Math.round(s / STEP), 0), H.tunnel.length - 1)];

// The track with each corner between OSM's straight pieces rounded into a curve, so cars and rails
// follow it instead of cutting the corner (OSM draws curves as straight pieces, median 56 m on the
// Yellow Line, and a car across a corner put its wheels up to 2.2 m off the track). Each corner is a
// quadratic Bezier no tighter than `radius` metres would make it and taking at most 45% of either
// piece, sampled finely enough to stay within `tol` metres of it. Distances keep OSM's measure, so
// stops, platforms and structure runs still line up.
export function smooth(coords, s, radius = 600, tol = 0.02) {
  const kx = M_PER_DEG * Math.cos(coords[0][1] * Math.PI / 180);
  const P = coords.map(([lon, lat]) => [lon * kx, lat * M_PER_DEG]);
  const out = [coords[0]], outS = [s[0]];
  for (let i = 1; i + 1 < P.length; i++) {
    const [a, v, b] = [P[i - 1], P[i], P[i + 1]];
    const l1 = Math.hypot(v[0] - a[0], v[1] - a[1]), l2 = Math.hypot(b[0] - v[0], b[1] - v[1]);
    const cos = l1 && l2 ? ((v[0] - a[0]) * (b[0] - v[0]) + (v[1] - a[1]) * (b[1] - v[1])) / (l1 * l2) : 1;
    const turn = Math.acos(Math.max(-1, Math.min(1, cos)));
    const t = Math.min(radius * Math.tan(turn / 2), 0.45 * l1, 0.45 * l2);
    if (!(t > 0.01)) { out.push(coords[i]); outS.push(s[i]); continue; }
    const r = t / Math.tan(turn / 2), n = Math.min(64, Math.max(2, Math.ceil(2 * t / Math.sqrt(8 * r * tol))));
    const A = [0, 1].map(j => v[j] + (a[j] - v[j]) * t / l1), B = [0, 1].map(j => v[j] + (b[j] - v[j]) * t / l2);
    const sa = s[i] - t * (s[i] - s[i - 1]) / l1, sb = s[i] + t * (s[i + 1] - s[i]) / l2;
    for (let k = 0; k <= n; k++) {
      const f = k / n, p = [0, 1].map(j => (1 - f) ** 2 * A[j] + 2 * f * (1 - f) * v[j] + f * f * B[j]);
      out.push([p[0] / kx, p[1] / M_PER_DEG]);
      outS.push(sa + f * (sb - sa));
    }
  }
  out.push(coords[coords.length - 1]);
  outS.push(s[s.length - 1]);
  return { coords: out, s: outS };
}

// Polygon ring around a line ([lon, lat] pairs): the line moved `shift` metres to its left and
// widened `half` metres each side. null for a line of one point.
export function ribbon(line, half, shift = 0) {
  const pts = line.filter((p, i) => i === 0 || p[0] !== line[i - 1][0] || p[1] !== line[i - 1][1]);
  if (pts.length < 2) return null;
  const kx = M_PER_DEG * Math.cos(pts[0][1] * Math.PI / 180);
  const left = [], right = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * M_PER_DEG, n = Math.hypot(dx, dy);
    const at = d => [p[0] - dy / n * d / kx, p[1] + dx / n * d / M_PER_DEG];
    left.push(at(shift + half));
    right.push(at(shift - half));
  });
  return [...left, ...right.reverse(), left[0]];
}

const box = (ring, base, top, props) =>
  ring && { type: 'Feature', properties: { base, top, ...props }, geometry: { type: 'Polygon', coordinates: [ring] } };

// Where each car of a `cars`-coach train whose front is at s=front sits: the track under its rear
// and front bogie pivots ([lon, lat]) and the rail heights there. Hung between its bogies, a car's
// wheels stay on the rails and its ends overhang the outside of a curve, as a real car's do. Cars
// that would hang off the start of the track are left out, so a train cut there has no rear cab.
// On a ring, wrap (a ringSeam) draws the track as one loop: a car before the seam is drawn a lap
// on, and one past the seam's second pass a lap back.
export function carPoses(coords, s, front, H, cars = CARS, wrap = null) {
  const poses = [];
  for (let j = 0; j < cars; j++) {
    let mid = front - j * (CAR_M + GAP_M) - CAR_M / 2;
    if (wrap && mid < wrap.at) mid += wrap.by;
    else if (wrap && mid > wrap.at + wrap.by) mid -= wrap.by;
    if (mid - CAR_M / 2 < 0) continue;
    const a = mid - BOGIE_M, b = mid + BOGIE_M;
    poses.push({ rear: slice(coords, s, a, a)[0], front: slice(coords, s, b, b)[0], zRear: heightAt(H, a), zFront: heightAt(H, b),
                 car: j, cars, lead: j === 0, last: j === cars - 1 });
  }
  return poses;
}

// Where a ring's track meets itself. OSM draws a ring as one route from its first station round to
// that station again, often on another platform track there (16-18 m apart at Maujpur), the two
// tracks joining beyond it. Returns the distance `at` within 600 m of the first stop where the
// track is closest to where it passes again `by` metres on, near `lap` (last stop minus first).
export function ringSeam(coords, s, first, lap) {
  const kx = M_PER_DEG * Math.cos(coords[0][1] * Math.PI / 180);
  const xy = d => { const [lon, lat] = slice(coords, s, d, d)[0]; return [lon * kx, lat * M_PER_DEG]; };
  let best = { gap: Infinity, at: first, by: lap };
  for (let a = Math.max(first - 600, 0); a <= first + 600; a += 5) {
    const p = xy(a);
    for (let b = a + lap - 100; b <= Math.min(a + lap + 100, s[s.length - 1]); b += 1) {
      const q = xy(b), gap = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (gap < best.gap) best = { gap, at: a, by: b - a };
    }
  }
  return best;
}

// Viaduct piers under one track wherever the rail is raised, every 30 m, where clear(at, top) (see
// pierClear) lets one stand. The deck is drawn by the three.js layer, which slopes it smoothly:
// extrusions are flat, so a deck built from them steps.
export function viaduct(coords, s, H, clear = () => true) {
  const out = [], L = s[s.length - 1];
  for (let a = 0; a + 1.5 <= L; a += 30) {
    const h = heightAt(H, a + 0.75);
    if (h - 1.2 >= 0.5 && clear(slice(coords, s, a + 0.75, a + 0.75)[0], h - 1.2)) {  // deck underside clears the street
      out.push(box(ribbon(slice(coords, s, a, a + 1.5), 0.9), 0, h - 1.2, { part: 'pier' }));
    }
  }
  return out.filter(Boolean);
}

// For viaduct(): whether a pier at `at` ([lon, lat]) standing up to `top` metres misses every track
// in spines ({sections: trackSections list}) that passes within CLEAR_M of it in plan, above the
// street and below its top: where one line rises over another, its piers would come up through the
// lower line's deck. Real crossings span the lower line with a longer beam or a portal frame.
const CLEAR_M = 4.5;  // deck half-width 2.4 m, pier half-width 0.9 m, and a margin
export function pierClear(spines) {
  const kx = M_PER_DEG * Math.cos(28.6 * Math.PI / 180), CELL = 50, grid = new Map();
  const xy = ([lon, lat]) => [lon * kx, lat * M_PER_DEG], cell = v => Math.floor(v / CELL);
  for (const { sections } of spines) for (let i = 0; i + 1 < sections.length; i++) {
    const [a, b] = [sections[i], sections[i + 1]];
    if (Math.max(a.z, b.z) < -0.5) continue;  // in tunnel, under the piers' footings
    const seg = [xy(a.at), xy(b.at), a.z, b.z], [p, q] = seg;
    for (let x = cell(Math.min(p[0], q[0]) - CLEAR_M); x <= cell(Math.max(p[0], q[0]) + CLEAR_M); x++) {
      for (let y = cell(Math.min(p[1], q[1]) - CLEAR_M); y <= cell(Math.max(p[1], q[1]) + CLEAR_M); y++) {
        const key = `${x},${y}`;
        (grid.get(key) || grid.set(key, []).get(key)).push(seg);
      }
    }
  }
  return (at, top) => {
    const p = xy(at);
    for (const [a, b, za, zb] of grid.get(`${cell(p[0])},${cell(p[1])}`) || []) {
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      const f = L2 ? Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0), 1) : 0;
      const z = za + f * (zb - za);
      if (z > -0.5 && z < top - 0.5 && Math.hypot(a[0] + f * dx - p[0], a[1] + f * dy - p[1]) < CLEAR_M) return false;
    }
    return true;
  };
}

// Points every `step` metres from one end of the track to the other, with the rail height at each:
// the spine that rails, deck, bed and tunnel are swept along.
export function trackSections(coords, s, H, step) {
  const L = s[s.length - 1], n = Math.ceil(L / step), out = [];
  for (let i = 0; i <= n; i++) {
    const d = Math.min(i * step, L);
    out.push({ at: slice(coords, s, d, d)[0], z: heightAt(H, d) });
  }
  return out;
}

// The layout of a station across both tracks, built round the forward-direction stop, for the
// three.js layer to draw: `sections`, points ([lon, lat]) every 10 m along the forward track over
// the platform; `m`, metres left of that track to the middle between the two tracks; `g`, half
// the distance between them (at least 2.3 m); `h`, the rail height; `under`, in tunnel. rev is the
// other direction's stop node [lon, lat], or null. Side platforms, as at most DMRC stations.
export function stationShape(stop, coords, s, H, rev) {
  const L = s[s.length - 1];
  const from = Math.max(stop.platform ? stop.platform.s_start : stop.s - TRAIN_M / 2, 0);
  const to = Math.min(stop.platform ? stop.platform.s_end : stop.s + TRAIN_M / 2, L);
  const around = slice(coords, s, Math.max(stop.s - 5, 0), Math.min(stop.s + 5, L));
  const a = around[0], b = around[around.length - 1];
  const kx = M_PER_DEG * Math.cos(a[1] * Math.PI / 180);
  const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * M_PER_DEG, n = Math.hypot(dx, dy) || 1;
  // How far the other track is to the left of this one (negative: to the right).
  const lat = rev ? ((rev[0] - a[0]) * kx * -dy + (rev[1] - a[1]) * M_PER_DEG * dx) / n : 0;
  const sections = [];
  for (let d = from; d < to; d += 10) sections.push(slice(coords, s, d, d)[0]);
  sections.push(slice(coords, s, to, to)[0]);
  return { code: stop.code, name: stop.name, bearing: Math.atan2(dx, dy) * 180 / Math.PI, sections,
           m: lat / 2, g: Math.max(Math.abs(lat) / 2, 2.3), h: heightAt(H, stop.s), under: inTunnel(H, stop.s) };
}

// How the platforms of two lines at an interchange (stationShape objects) join, in outline: stacked
// one over the other (centres under STACK_M apart) by a lift tower between their levels; otherwise
// by a walkway at the lower concourse when both are raised (a foot bridge), at the upper one when
// both are in tunnel, else along the street, with a lift tower at each end from its platform to
// it. Each tower stands beside its station on the side facing the other, clear of the tracks and
// concourse. Pieces {from, to: [lon, lat], z0, z1} in metres above the street; a tower's from and
// to are one point. A sketch, not a survey: neither OSM nor DMRC's data maps the passages.
export const STACK_M = 40;
export const LIFT_OUT_M = 7.5;  // tower centre past the station's half-gap: clear of its 5.5 m wide concourse
export function interchangeLink(A, B) {
  const frame = st => {
    const [lon, lat] = st.sections[st.sections.length >> 1], b = st.bearing * Math.PI / 180, kx = M_PER_DEG * Math.cos(lat * Math.PI / 180);
    const left = [-Math.cos(b), Math.sin(b)];  // metres east, north
    return { kx, left, at: d => [lon + left[0] * d / kx, lat + left[1] * d / M_PER_DEG], centre: [lon + left[0] * st.m / kx, lat + left[1] * st.m / M_PER_DEG] };
  };
  const fa = frame(A), fb = frame(B);
  // The point beside st's station on the side towards `to`.
  const beside = (st, f, to) => {
    const side = (to[0] - f.centre[0]) * f.kx * f.left[0] + (to[1] - f.centre[1]) * M_PER_DEG * f.left[1] < 0 ? -1 : 1;
    return f.at(st.m + side * (st.g + LIFT_OUT_M));
  };
  const lift = (at, z0, z1) => ({ from: at, to: at, z0: Math.min(z0, z1), z1: Math.max(z0, z1) });
  const apart = Math.hypot((fb.centre[0] - fa.centre[0]) * fa.kx, (fb.centre[1] - fa.centre[1]) * M_PER_DEG);
  if (apart < STACK_M) return [lift(beside(A, fa, fb.at(B.m + B.g + LIFT_OUT_M)), A.h, B.h)];
  const a = beside(A, fa, fb.centre), b = beside(B, fb, fa.centre);
  const hall = st => st.under ? st.h + 6 : st.h > 10 ? st.h - 6.8 : 0;  // as train3d.js stationGeometry draws them
  const level = !A.under && !B.under ? Math.min(hall(A), hall(B)) : A.under && B.under ? Math.max(hall(A), hall(B)) : 0;
  return [lift(a, A.h, level), { from: a, to: b, z0: level, z1: level }, lift(b, B.h, level)];
}
