// Offline tests for web/scene.js. Run: node --test tests/test_scene.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { heights, crossings, LEVEL_M, heightAt, inTunnel, ribbon, carPoses, trackSections, viaduct, pierClear, interchangeLink, STACK_M, stationShape, smooth, ringSeam, DECK_M, DEPTH_M, RAMP_M, STEP, CAR_W } from '../web/scene.js';
import { CAR_M, GAP_M, BOGIE_M, TRAIN_M, plan, slice } from '../web/motion.js';

const M = 6371008.8 * Math.PI / 180, KX = M * Math.cos(28.6 * Math.PI / 180);
const at = (east, north = 0) => [77.3 + east / KX, 28.6 + north / M];
const TRACK = Array.from({ length: 31 }, (_, i) => at(i * 100)), S = TRACK.map((_, i) => i * 100);  // 3 km due east
const north = ring => ring.map(p => (p[1] - 28.6) * M);
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const RAISED = heights([[0, 3000, 'elevated']], 3000);

test('where two lines cross at one level, the one OSM layers higher goes over, a tie to the later line', () => {
  const ns = (code, kind, layer) => ({ line: code, coords: [at(1000, -500), at(1000, 500)], s: [0, 1000], structure: [[0, 1000, kind, layer]] });
  const ew = (code, kind, layer) => ({ line: code, coords: [at(0), at(2000)], s: [0, 2000], structure: [[0, 2000, kind, layer]] });
  const dz = b => b.map(x => [Math.round(x.s), x.dz]);
  assert.deepEqual(crossings([ew('LN2', 'elevated', 3), ns('LN11', 'elevated', 2)]).map(dz), [[[1000, LEVEL_M]], []]);  // Yellow over Rapid Metro
  assert.deepEqual(crossings([ew('LN3', 'elevated', 1), ns('LN7', 'elevated', 1)]).map(dz), [[], [[500, LEVEL_M]]]);  // tie: Pink over Blue
  assert.deepEqual(crossings([ew('LN2', 'tunnel', -1), ns('LN8', 'tunnel', -1)]).map(dz), [[], [[500, -LEVEL_M]]]);  // tie: Magenta under Yellow
  assert.deepEqual(crossings([ew('LN1', 'elevated', 1), ns('LN2', 'tunnel', -1)]).map(dz), [[], []]);  // different levels already
  assert.deepEqual(crossings([ew('LN7', 'elevated', 1), ns('LN7EXTN', 'elevated', 1)]).map(dz), [[], []]);  // a line and its branch
  const H = heights([[0, 2000, 'elevated', 3]], 2000, [{ s: 1000, dz: LEVEL_M }, { s: 1004, dz: LEVEL_M }]);
  near(heightAt(H, 1000), DECK_M + LEVEL_M, 1e-9);  // both directions of the other line: one rise, not two
  near(heightAt(H, 200), DECK_M, 1e-9);
  for (let s = 400; s < 1000; s += 10) assert.ok(heightAt(H, s + 10) >= heightAt(H, s));  // a ramp up to it
});

test('rail height slopes between street and viaduct over RAMP_M', () => {
  const H = heights([[0, 1000, 'at_grade'], [1000, 3000, 'elevated']], 3000);
  assert.equal(heightAt(H, 1000 - RAMP_M / 2 - STEP), 0);
  assert.equal(heightAt(H, 1000 + RAMP_M / 2 + STEP), DECK_M);
  near(heightAt(H, 1000), DECK_M / 2, 0.6);
  for (let s = 800; s < 1200; s += 5) assert.ok(heightAt(H, s + 5) >= heightAt(H, s));
  assert.equal(heightAt(RAISED, 0), DECK_M);  // an elevated terminus stays up
  const T = heights([[0, 500, 'tunnel'], [500, 1000, 'at_grade']], 1000);
  assert.equal(inTunnel(T, 100), true);
  assert.equal(heightAt(T, 0), -DEPTH_M);
  assert.equal(inTunnel(T, 800), false);
});

test('a ribbon is the line widened, and shifted to its left', () => {
  const ys = north(ribbon(TRACK.slice(0, 2), 2));
  near(Math.min(...ys), -2, 1e-6); near(Math.max(...ys), 2, 1e-6);
  const shifted = north(ribbon(TRACK.slice(0, 2), 1, 5));  // travelling east, left is north
  near(Math.min(...shifted), 4, 1e-6); near(Math.max(...shifted), 6, 1e-6);
  assert.equal(ribbon([at(0), at(0)], 1), null);
});

test('a train is 8 cars on the rail, front and last marked, none cut short', () => {
  const east = p => (p[0] - 77.3) * KX;
  const cars = carPoses(TRACK, S, 1000, RAISED);
  assert.equal(cars.length, 8);
  assert.deepEqual(cars.map(c => [c.lead, c.last]), [[true, false], ...Array(6).fill([false, false]), [false, true]]);
  assert.deepEqual(cars.map(c => c.car), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(cars.every(c => c.cars === 8));
  for (const c of cars) {
    near(east(c.front) - east(c.rear), 2 * BOGIE_M, 1e-6);  // placed by its bogie pivots
    assert.equal(c.zRear, DECK_M); assert.equal(c.zFront, DECK_M);
  }
  near(east(cars[0].front), 1000 - CAR_M / 2 + BOGIE_M, 1e-6);
  const short = carPoses(TRACK, S, 60, RAISED);  // only 60 m of track behind the front
  assert.equal(short.length, 2);
  assert.ok(!short[1].last);  // the real last car is off the track, so no rear cab is drawn
  const six = carPoses(TRACK, S, 1000, RAISED, 6);
  assert.deepEqual(six.map(c => [c.car, c.last]), [[0, false], [1, false], [2, false], [3, false], [4, false], [5, true]]);
  // A ring whose track meets itself at 100 m and 2100 m: a car before 100 m is drawn a lap on, one
  // past 2100 m a lap back.
  const ring = carPoses(TRACK, S, 130, RAISED, 3, { at: 100, by: 2000 });
  assert.equal(ring.length, 3);
  near(east(ring[0].front), 130 - CAR_M / 2 + BOGIE_M, 1e-6);
  near(east(ring[1].front), 130 - 1.5 * CAR_M - GAP_M + BOGIE_M + 2000, 1e-6);
  near(east(carPoses(TRACK, S, 2150, RAISED, 1, { at: 100, by: 2000 })[0].front), 150 - CAR_M / 2 + BOGIE_M, 1e-6);
  const T = heights([[0, 3000, 'tunnel']], 3000);
  assert.ok(carPoses(TRACK, S, 1000, T).every(c => c.zRear === -DEPTH_M && c.zFront === -DEPTH_M));
});

test('ringSeam finds where a loop of track passes the same place again', () => {
  // A square loop 400 m round, drawn as a route that starts 20 m along one side and goes round 1.5 times.
  const sq = [at(0), at(100), at(100, 100), at(0, 100)];
  const loop = [at(20), ...[1, 2, 3, 0, 1, 2].map(i => sq[i])], d = [0, 80, 180, 280, 380, 480, 580];
  const seam = ringSeam(loop, d, 50, 400);
  assert.ok(seam.gap < 0.5, `${seam.gap}`);
  near(seam.by, 400, 1);
});

test('smooth rounds a corner into a curve and keeps distances as they were', () => {
  const corner = [at(0), at(100), at(100, 100)], s = [0, 100, 200];
  const { coords, s: s2 } = smooth(corner, s);
  assert.ok(coords.length > 10);
  assert.deepEqual([coords[0], coords.at(-1)], [corner[0], corner[2]]);
  assert.deepEqual([s2[0], s2.at(-1)], [0, 200]);
  for (let i = 1; i < s2.length; i++) assert.ok(s2[i] > s2[i - 1]);
  // The corner is cut 45 m each side (the most allowed); the curve passes inside the corner point.
  const mid = slice(coords, s2, 100, 100)[0], north2 = p => (p[1] - 28.6) * M;
  const off = Math.hypot((mid[0] - 77.3) * KX - 100, north2(mid));
  assert.ok(off > 5 && off < 20, `${off}`);
  assert.deepEqual(smooth([at(0), at(50), at(100)], [0, 50, 100]).coords.length, 3);  // straight: unchanged
});

test('track sections run end to end at rail height', () => {
  const east = p => (p[0] - 77.3) * KX;
  const H = heights([[0, 1500, 'tunnel'], [1500, 3000, 'elevated']], 3000);
  const spine = trackSections(TRACK, S, H, 7);  // 3000 m is not a whole number of steps
  assert.equal(spine.length, Math.ceil(3000 / 7) + 1);
  near(east(spine[0].at), 0, 1e-6); near(east(spine[spine.length - 1].at), 3000, 1e-6);
  assert.equal(spine[0].z, -DEPTH_M);
  assert.equal(spine[spine.length - 1].z, DECK_M);
});

test('viaduct only where the rail is raised, with piers down to the street', () => {
  const H = heights([[0, 1000, 'at_grade'], [1000, 3000, 'elevated']], 3000);
  const parts = viaduct(TRACK, S, H);
  const east = f => (f.geometry.coordinates[0][0][0] - 77.3) * KX;
  assert.ok(parts.length > 0 && parts.every(f => east(f) > 1000 - RAMP_M / 2 - STEP));
  assert.ok(parts.every(f => f.properties.part === 'pier'));  // the deck is drawn by the three.js layer
  const piers = parts;
  assert.ok(piers.length > 50 && piers.every(f => f.properties.base === 0 && f.properties.top > 0));
});

test('no pier where another line passes under the viaduct, one where a line runs alongside at its level', () => {
  const H = heights([[0, 3000, 'elevated']], 3000), mid = 1500.75;
  const across = (z, east = 1500.75) => ({ sections: [-50, 50].map(n => ({ at: at(east, n), z })) });  // a line running north
  const pierAt = spines => viaduct(TRACK, S, H, pierClear(spines)).some(f => Math.abs((f.geometry.coordinates[0][0][0] - 77.3) * KX - 1500) < 2);
  assert.ok(pierAt([]));
  assert.ok(!pierAt([across(0)]), 'over a line at street level');
  assert.ok(!pierAt([across(DECK_M - LEVEL_M / 2)]), 'over a lower viaduct');
  assert.ok(pierAt([across(-DEPTH_M)]), 'over a tunnel');
  assert.ok(pierAt([across(0, mid + 20)]), '20 m from the crossing');
  const beside = { sections: [0, 3000].map(e => ({ at: at(e, 4.5), z: DECK_M })) };  // the other direction's track
  assert.ok(pierAt([beside]));
});

test('interchanges: stacked platforms by a lift between them, others by a walkway at a concourse or the street', () => {
  const shape = (east, h, under = false) => ({ sections: [at(east - 50), at(east), at(east + 50)], bearing: 90, m: 2.5, h, under });
  const centreNorth = p => (p[1] - 28.6) * M;
  const [lift] = interchangeLink(shape(0, 12), shape(STACK_M / 2, -16, true));
  assert.deepEqual([lift.z0, lift.z1], [-16, 12]);
  near(centreNorth(lift.from), 2.5, 1e-6);  // between the tracks, 2.5 m left of the forward one
  assert.equal(interchangeLink(shape(0, 12), shape(STACK_M / 2, -16, true)).length, 1);
  const bridge = interchangeLink(shape(0, 12), shape(300, 22));
  assert.equal(bridge.length, 3);
  assert.deepEqual(bridge.map(p => [p.z0, p.z1]), [[12 - 6.8, 12], [12 - 6.8, 12 - 6.8], [12 - 6.8, 22]]);
  assert.equal(interchangeLink(shape(0, -16, true), shape(300, -25, true))[1].z0, -10);
  assert.equal(interchangeLink(shape(0, 12), shape(300, -16, true))[1].z0, 0);
});

test('station layout: along the platform, between both tracks, at rail height or underground', () => {
  const east = p => (p[0] - 77.3) * KX;
  const stop = { code: 'X', name: 'X', s: 2000, platform: null };
  const shape = stationShape(stop, TRACK, S, RAISED, at(2000, 5));  // other track 5 m to the north (left)
  near(shape.m, 2.5, 1e-6); near(shape.g, 2.5, 1e-6); near(shape.bearing, 90, 1e-6);
  assert.equal(shape.h, DECK_M); assert.equal(shape.under, false);
  const along = shape.sections.map(east);  // no mapped platform: a train length centred on the stop
  near(along[0], 2000 - TRAIN_M / 2, 1e-6); near(along.at(-1), 2000 + TRAIN_M / 2, 1e-6);
  for (let i = 1; i < along.length; i++) assert.ok(along[i] > along[i - 1] && along[i] - along[i - 1] <= 10 + 1e-6);
  const under = stationShape(stop, TRACK, S, heights([[0, 3000, 'tunnel']], 3000), null);
  assert.equal(under.under, true); assert.equal(under.h, -DEPTH_M); near(under.m, 0, 1e-9); near(under.g, 2.3, 1e-9);
});

test('real data for every line: a trip plan per track, every station built, trains on the rail', () => {
  const schedule = JSON.parse(readFileSync(new URL('../data/schedule.json', import.meta.url)));
  const consists = JSON.parse(readFileSync(new URL('../config/consists.json', import.meta.url)));
  const files = readdirSync(new URL('../data/track/', import.meta.url)).filter(f => f.endsWith('.geojson'));
  assert.equal(files.length, 13);
  for (const file of files) {
    const fc = JSON.parse(readFileSync(new URL(`../data/track/${file}`, import.meta.url)));
    for (const t of fc.features.filter(f => f.properties.kind === 'track')) {
      const { s, length_m, structure, direction, pattern, line } = t.properties;
      const H = heights(structure, length_m);
      const stops = fc.features.filter(f => f.properties.kind === 'stop' && f.properties.direction === direction && f.properties.pattern === pattern);
      assert.ok(schedule.lines[pattern ? `${line}:${pattern}` : line], `${line}:${pattern} has a timetable`);
      plan(stops.map(f => f.properties).sort((a, b) => a.seq - b.seq), t.properties.hops, length_m, consists.lines[line]);
      for (const st of stops) {
        assert.ok(stationShape(st.properties, t.geometry.coordinates, s, H, null).sections.length >= 2, st.properties.code);
        for (const c of carPoses(t.geometry.coordinates, s, st.properties.s, H)) {
          assert.ok(c.zRear >= -DEPTH_M && c.zFront <= DECK_M);
        }
      }
      const elevated = structure.filter(r => r[2] === 'elevated').reduce((m, [x, y]) => m + y - x, 0);
      assert.ok(viaduct(t.geometry.coordinates, s, H).length >= elevated / 40, `${line} piers`);  // one every 30 m, less the ramps
    }
  }
});
