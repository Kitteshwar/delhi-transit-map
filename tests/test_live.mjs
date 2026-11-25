// Offline tests for web/live.js. Run: node --test tests/test_live.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, timeAt, matchTrain, onTrack, nearestStation } from '../web/live.js';
import { plan, trainFront } from '../web/motion.js';

const M = 6371008.8 * Math.PI / 180, KX = M * Math.cos(28.6 * Math.PI / 180);
const at = (east, north = 0) => [77.3 + east / KX, 28.6 + north / M];
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
// A straight track from `from` to `to` metres east, `north` metres north, measured in travel order.
const line = (from, to, north) => {
  const coords = [], s = [];
  for (let i = 0; i <= 20; i++) { coords.push(at(from + (to - from) * i / 20, north)); s.push(Math.abs(to - from) * i / 20); }
  return { coords, s };
};
const EAST = line(0, 2000, 0), WEST = line(2000, 0, 5);  // the two directions, 5 m apart

test('a fix projects onto a track: distance along it and metres off it', () => {
  const p = project(EAST.coords, EAST.s, at(730, 12));
  near(p.s, 730, 0.01); near(p.off, 12, 0.01);
  near(project(WEST.coords, WEST.s, at(730, 12)).s, 1270, 0.01);
});

const P = plan([{ code: 'A', s: 0, platform: { s_end: 100 } }, { code: 'B', s: 1900, platform: { s_end: 2000 } }],
  [{ from: 'A', to: 'B', seconds: 200 }], 2000);

test('timeAt is when the front first reaches a point', () => {
  for (const s of [100, 500, 1500, 2000]) near(trainFront(P, timeAt(P, s)), s, 0.01);
  assert.ok(timeAt(P, 500) < timeAt(P, 1500));
});

test('matchTrain picks the nearest departure and says how late it is', () => {
  const tau = timeAt(P, 1000);
  const late = matchTrain(P, [0, 600, 1200], 600 + tau + 90, 1000);
  assert.equal(late.k, 1); near(late.late, 90, 1e-6);
  const early = matchTrain(P, [0, 600, 1200], 600 + tau - 120, 1000);
  assert.equal(early.k, 1); near(early.late, -120, 1e-6);
  assert.equal(matchTrain(P, [0], 5000, 1000), null);  // no train within 15 minutes
});

test('onTrack tells the direction from fixes moving along a track', () => {
  const tracks = [EAST, WEST];
  assert.equal(onTrack(tracks, [at(500, 2), at(580, 3)]).index, 0);
  near(onTrack(tracks, [at(500, 2), at(580, 3)]).s, 580, 0.01);
  assert.equal(onTrack(tracks, [at(580, 3), at(500, 2)]).index, 1);
  assert.equal(onTrack(tracks, [at(500, 2), at(510, 2)]), null);    // not moved far enough to tell
  assert.equal(onTrack(tracks, [at(500, 200), at(600, 200)]), null);  // nowhere near the line
});

test('nearestStation finds the closest one within the radius', () => {
  const st = [{ code: 'A', at: at(0) }, { code: 'B', at: at(1000) }];
  assert.equal(nearestStation(st, at(900, 30)).code, 'B');
  assert.equal(nearestStation(st, at(500)), null);  // 500 m from both
});
