// Offline tests for web/motion.js. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { profile, along, plan, trainFront, ringTurns, running, secs, trainLength, DWELL, CAR_M, GAP_M } from '../web/motion.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('a run covers its distance in its time and ends at rest', () => {
  for (const [d, t] of [[617, 83], [1751, 156]]) {
    const p = profile(d, t);
    near(p.ta + p.tc + p.tb, t);
    near(along(p, t), d);
    near(along(p, t + 100), d);
  }
  const late = profile(1000, 40);  // not enough time: the fastest run, arriving late
  assert.ok(late.ta + late.tc + late.tb > 40);
  near(along(late, 1e6), 1000);
});

test('the front waits at the first platform, runs, then waits at the last', () => {
  const stops = [{ code: 'A', s: 0, platform: null }, { code: 'B', s: 1000, platform: { s_end: 1100 } }];
  const p = plan(stops, [{ from: 'A', to: 'B', seconds: 100 }], 2000);
  assert.deepEqual(p.front, [91.5, 1100]);
  assert.equal(trainFront(p, -DWELL - 1), null);
  assert.equal(trainFront(p, -5), 91.5);
  near(trainFront(p, 100 - DWELL), 1100);
  assert.equal(trainFront(p, 100 + DWELL), 1100);
  assert.equal(trainFront(p, 100 + DWELL + 1), null);
  let prev = 0;
  for (let t = 0; t <= 100; t += 0.5) { const f = trainFront(p, t); assert.ok(f >= prev); prev = f; }
  assert.throws(() => plan(stops, [{ from: 'B', to: 'A', seconds: 100 }], 2000));
});

test('on a ring the train back at the start takes the next departure, if it leaves before the one behind', () => {
  const p = { total: 1000 };  // a lap: 1000 s from leaving the first station to being ready to leave again
  // Every 300 s, then every 600 s from 1200: trains come back every 300 s but are only needed every 600 s.
  const deps = [0, 300, 600, 900, 1200, 1800, 2400];
  const { stay, held } = ringTurns(p, deps);
  // The 0 train is back at 1000 and leaves again at 1200, before the 300 train is back at 1300. The
  // 300 train is back at 1300 but the next departure, 1800, is after the 600 train is back (1600):
  // it leaves service, and the 600 train takes 1800. Likewise the 900 train goes, the 1200 one takes 2400.
  assert.deepEqual(held, [false, false, false, false, true, true, true]);
  const gone = 1000 + DWELL;
  assert.deepEqual(stay, [1200, gone, 1200, gone, 1200, gone, gone]);
  const lap = plan([{ code: 'A', s: 0, platform: { s_end: 100 } }, { code: 'B', s: 900, platform: { s_end: 1000 } }],
    [{ from: 'A', to: 'B', seconds: 1000 }], 2000);
  const shown = (k, t) => trainFront(lap, t - deps[k], held[k] ? 0 : -DWELL, stay[k]);
  assert.equal(shown(0, 1150), 1000);   // waiting at the end of its lap
  assert.equal(shown(4, 1190), null);   // the 1200 departure is that same train, not a second one
  assert.equal(shown(4, 1200), 100);
});

test('the coach count sets the train length and where it stops at an unmapped platform', () => {
  assert.equal(trainLength(8), 8 * CAR_M + 7 * GAP_M);
  const stops = [{ code: 'A', s: 0, platform: null }, { code: 'B', s: 1000, platform: null }];
  const p = plan(stops, [{ from: 'A', to: 'B', seconds: 100 }], 2000, 6);
  assert.deepEqual(p.front, [trainLength(6) / 2, 1000 + trainLength(6) / 2]);
});

// The page and headways.py must agree on how many trains run at once.
test('real Blue Line data: peak trains match headways.py and every hop is on time', () => {
  const schedule = JSON.parse(readFileSync(new URL('../data/schedule.json', import.meta.url)));
  const expected = { LN3: 94, LN4: 8 };  // headways.py output, weekday
  for (const code of ['LN3', 'LN4']) {
    const fc = JSON.parse(readFileSync(new URL(`../data/track/${code}.geojson`, import.meta.url)));
    const dirs = fc.features.filter(f => f.properties.kind === 'track').map(t => {
      const dir = t.properties.direction;
      const stops = fc.features.filter(f => f.properties.kind === 'stop' && f.properties.direction === dir)
        .map(f => f.properties).sort((a, b) => a.seq - b.seq);
      const p = plan(stops, t.properties.hops, t.properties.length_m);
      p.legs.forEach((leg, i) => assert.ok(leg.run.ta + leg.run.tc + leg.run.tb <= t.properties.hops[i].seconds - DWELL + 1e-6));
      return { p, deps: schedule.lines[code].weekday[dir].map(secs) };
    });
    let most = 0;
    for (let t = 5 * 3600; t <= 25 * 3600; t += 1) most = Math.max(most, dirs.reduce((n, d) => n + running(d.p, d.deps, t), 0));
    assert.equal(most, expected[code], code);
  }
});
