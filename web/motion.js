// Train motion for the scheduled animation: where a train's front is along its track at a given
// time, from DMRC's hop times and the OSM track model. Pure functions, shared by the page and tests.

export const ACCEL = 1.0;  // m/s2, typical metro
export const BRAKE = 1.0;  // m/s2
export const DWELL = 25;   // s at each station, taken out of DMRC's hop time (which includes one dwell)
export const CAR_M = 22;   // DMRC car length
export const CARS = 8;     // default coaches per train; the page reads each line's from config/consists.json
export const GAP_M = 1;
export const BOGIE_M = 7.4; // bogie pivots either side of a car's middle
export const trainLength = cars => cars * CAR_M + (cars - 1) * GAP_M;
export const TRAIN_M = trainLength(CARS);

const K = 1 / (2 * ACCEL) + 1 / (2 * BRAKE);

// Accelerate, cruise, brake over `dist` metres in `time` seconds. With too little time it takes the
// fastest run (no cruise) and arrives late. There is no speed cap: DMRC's times are measured runs.
export function profile(dist, time) {
  const disc = time * time - 4 * K * dist;
  const v = disc >= 0 ? (time - Math.sqrt(disc)) / (2 * K) : Math.sqrt(dist / K);
  return { dist, v, ta: v / ACCEL, tc: (dist - K * v * v) / v, tb: v / BRAKE };
}

// Metres covered t seconds into a run; dist once it has stopped.
export function along(p, t) {
  if (t <= 0) return 0;
  if (t < p.ta) return 0.5 * ACCEL * t * t;
  const sa = 0.5 * ACCEL * p.ta * p.ta;
  if (t < p.ta + p.tc) return sa + p.v * (t - p.ta);
  const tr = Math.min(t - p.ta - p.tc, p.tb);
  return Math.min(sa + p.v * p.tc + p.v * tr - 0.5 * BRAKE * tr * tr, p.dist);
}

// A trip plan for one direction: where the front stops at each station and one run per hop.
// stops and hops are the track GeoJSON's stop properties (in seq order) and its track's hops.
export function plan(stops, hops, length, cars = CARS) {
  if (hops.length !== stops.length - 1 || hops.some((h, i) => h.from !== stops[i].code || h.to !== stops[i + 1].code)) {
    throw new Error('hops do not join the stops in order');
  }
  // The stop node is mid-platform: the front stops at the platform's far end, or half a train on.
  const front = stops.map(st => Math.min(st.platform ? st.platform.s_end : st.s + trainLength(cars) / 2, length));
  const legs = [];
  let start = 0;
  hops.forEach((h, i) => {
    const dist = front[i + 1] - front[i];
    if (!(dist > 0) || !(h.seconds > DWELL)) throw new Error(`bad hop ${h.from}->${h.to}`);
    legs.push({ start, run: profile(dist, h.seconds - DWELL) });
    start += h.seconds;
  });
  return { front, legs, total: start };
}

// Front position tau seconds after the train leaves its first station; null when it is not on the
// line. It shows at the first platform one dwell before leaving and at the last one dwell after,
// unless told when it is shown from and until.
export function trainFront(p, tau, from = -DWELL, until = p.total + DWELL) {
  if (tau < from || tau > until) return null;
  if (tau <= 0) return p.front[0];
  let i = 0;
  while (i < p.legs.length - 1 && p.legs[i + 1].start <= tau) i++;
  return p.front[i] + along(p.legs[i].run, tau - p.legs[i].start);
}

// On a ring, the train back at its first station after a lap takes the next departure from there,
// waiting in between, if it leaves before the train behind comes round; otherwise it leaves
// service there. Per departure: how long after it its train stays on the line (`stay`), and whether
// a train already waiting takes it (`held`), so that no second train turns up for it.
export function ringTurns(p, departures) {
  const stay = departures.map(() => p.total + DWELL), held = departures.map(() => false);
  let j = 0;
  departures.forEach((d, k) => {
    const back = d + p.total, behind = k + 1 < departures.length ? departures[k + 1] + p.total : Infinity;
    while (j < departures.length && departures[j] < back) j++;
    if (j < departures.length && departures[j] < behind) {
      held[j] = true;
      stay[k] = departures[j] - d;
      j++;
    }
  });
  return { stay, held };
}

// Trains between leaving the first station and reaching the last, as headways.py counts them.
export function running(p, departures, t) {
  return departures.filter(d => t >= d && t < d + p.total).length;
}

function point(coords, s, d) {
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= d) lo = mid; else hi = mid;
  }
  const f = s[hi] > s[lo] ? Math.min(Math.max((d - s[lo]) / (s[hi] - s[lo]), 0), 1) : 0;
  return [[coords[lo][0] + f * (coords[hi][0] - coords[lo][0]), coords[lo][1] + f * (coords[hi][1] - coords[lo][1])], lo];
}

// The track between distances a < b, in travel order, as [lon, lat] pairs.
export function slice(coords, s, a, b) {
  const [pa, ia] = point(coords, s, a);
  const [pb, ib] = point(coords, s, b);
  return [pa, ...coords.slice(ia + 1, ib + 1), pb];
}

export function secs(hms) {
  const [h, m, x = 0] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + x;
}