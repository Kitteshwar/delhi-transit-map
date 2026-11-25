// Offline checks of the car model's dimensions (no browser). Run: node --test tests/test_train3d.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.min.js';
import { carGeometries, LEAVES, DOOR_OPEN_M, sweep, runs, PROFILES, pantographGeometry, overheadLines, MAST, noseGeometry, carDetail, hasPantograph, simplify, sleeperSpots, stationGeometry, linkGeometry } from '../web/train3d.js';
import { CAR_M, GAP_M } from '../web/motion.js';
import { CAR_W } from '../web/scene.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

const MIDDLE = ['band', 'body', 'dark', 'doorway', 'glass', 'grey', 'pinstripe'];

test('every part of both kinds of car fits it: length, width, height and above the rail', () => {
  const { middle, cab, low } = carGeometries();
  assert.deepEqual(Object.keys(middle).sort(), MIDDLE);
  assert.deepEqual(Object.keys(cab).sort(), [...MIDDLE, 'display', 'face', 'headlamp', 'ladies', 'red', 'taillamp'].sort());
  for (const [name, g] of [...Object.entries(middle), ...Object.entries(cab).map(([k, v]) => [`cab ${k}`, v]), ['low', low]]) {
    const { min, max } = g.boundingBox;
    assert.ok(min.x >= -CAR_M / 2 - GAP_M && max.x <= CAR_M / 2, `${name} x ${min.x}..${max.x}`);
    assert.ok(Math.max(-min.y, max.y) <= CAR_W / 2 + 0.08, `${name} y ${min.y}..${max.y}`);
    assert.ok(min.z >= -1e-6 && max.z <= 4.2, `${name} z ${min.z}..${max.z}`);
    assert.equal(g.getAttribute('position').count, g.getAttribute('normal').count);
  }
  assert.equal(low.getAttribute('color').count, low.getAttribute('position').count);
  const colours = new Set(Array.from(low.getAttribute('color').array, v => v.toFixed(3)));
  assert.ok(colours.has('1.000'), 'the far-off body is white, to take the line colour');
  for (const body of [middle.body.boundingBox, cab.body.boundingBox]) {  // the nose ends where the body would
    near(body.max.y, CAR_W / 2); near(body.max.z, 3.85, 1e-5); near(body.min.z, 1.0, 1e-5);
    near(body.max.x - body.min.x, CAR_M - 0.2, 1e-5);
  }
});

test('door leaves: four sets, each on its side of the car and in its half of every doorway', () => {
  const { leaves, middle } = carGeometries();
  assert.equal(leaves.length, LEAVES.length);
  leaves.forEach(({ doors, glass }, k) => {
    const [side, dir] = LEAVES[k];
    for (const g of [doors, glass]) {
      const ys = points(g).map(([, y]) => y * side);
      assert.ok(Math.min(...ys) >= CAR_W / 2 - 1e-6 && Math.max(...ys) <= CAR_W / 2 + 0.08);
    }
    const xs = points(doors).map(([x]) => x);
    for (const door of [-8.25, -2.75, 2.75, 8.25]) {  // each leaf covers its half of the doorway, and clears it open
      const mine = xs.filter(x => Math.abs(x - door) < 1);
      near(Math.min(...mine.map(x => dir * (x - door))), 0.01, 1e-5);
      assert.ok(Math.min(...mine.map(x => dir * (x - door))) + DOOR_OPEN_M >= 0.71 - 1e-6);
    }
  });
  const way = middle.doorway.boundingBox;  // the dark doorway lies behind the shut leaves
  assert.ok(way.max.y < Math.min(...leaves.map(l => l.doors.boundingBox.max.y).filter(y => y > 0)));
});

test('interchange links: a raised walkway is a glazed bridge on columns, a tower stands on the street, tunnel ones are see-through', () => {
  const bridge = linkGeometry([{ a: [0, 0], b: [100, 0], z0: 5, z1: 5 }]);
  assert.deepEqual(Object.keys(bridge).sort(), ['concourse', 'pane', 'pier', 'roof', 'steel']);
  near(bridge.concourse.boundingBox.max.z, 5, 1e-5);
  near(bridge.pier.boundingBox.min.z, 0, 1e-5);
  near(bridge.pier.boundingBox.max.z, 4.6, 1e-5);
  near(bridge.roof.boundingBox.min.x, 0, 1e-5); near(bridge.roof.boundingBox.max.x, 100, 1e-5);
  assert.deepEqual(Object.keys(linkGeometry([{ a: [0, 0], b: [100, 0], z0: 0, z1: 0 }])).sort(), ['roof', 'steel']);  // along the street
  assert.deepEqual(Object.keys(linkGeometry([{ a: [0, 0], b: [100, 0], z0: -10, z1: -10 }])), ['hall']);
  const tower = linkGeometry([{ a: [5, 5], b: [5, 5], z0: -16, z1: 12 }]);
  near(tower.hall.boundingBox.min.z, -16, 1e-5); near(tower.hall.boundingBox.max.z, 0, 1e-5);
  near(tower.pane.boundingBox.min.z, 0, 1e-5); near(tower.roof.boundingBox.min.z, 12 + 3.7, 1e-5);
});

test('the cab nose is closed, faces outwards and leans back above the windscreen foot', () => {
  const g = noseGeometry(), p = g.getAttribute('position').array, bb = g.boundingBox;
  for (let i = 0; i < p.length; i += 9) {
    const v = k => [p[i + 3 * k], p[i + 3 * k + 1], p[i + 3 * k + 2]];
    const [a, b, c] = [v(0), v(1), v(2)], u = b.map((x, j) => x - a[j]), w = c.map((x, j) => x - a[j]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const out = n.reduce((s, x, j) => s + x * ((a[j] + b[j] + c[j]) / 3 - [9.4, 0, 2.4][j]), 0);
    assert.ok(out > 0, `triangle ${i / 9} faces in`);
  }
  near(bb.min.x, 9.4, 1e-5); near(bb.max.x, CAR_M / 2 - 0.1, 1e-5);
  const top = Array.from({ length: p.length / 3 }, (_, i) => [p[3 * i], p[3 * i + 2]]).filter(([, z]) => z > 3.6);
  assert.ok(Math.max(...top.map(([x]) => x)) < bb.max.x - 0.5);  // the top of the front is set back
});

test('windscreens, lamps and displays are on the front face', () => {
  const { cab } = carGeometries(), front = cab.body.boundingBox.max.x;
  for (const name of ['headlamp', 'taillamp']) assert.ok(cab[name].boundingBox.min.x >= front, name);
  for (const name of ['face', 'display']) assert.ok(cab[name].boundingBox.min.x > 10.2, name);
  // The red logo, a ring 0.4 m across on the front door and 0.36 m on each side, its cut-outs left open.
  const red = points(cab.red), frontLogo = red.filter(([x, y]) => x > 10 && Math.abs(y) < 0.3), sideLogo = red.filter(([x]) => x < 10);
  assert.ok(frontLogo.length > 0 && frontLogo.every(([, y, z]) => Math.hypot(y, z - 1.75) <= 0.2 * 1.01));
  assert.ok(!frontLogo.some(([, y, z]) => Math.hypot(y, z - 1.75 - 0.12) < 0.02));  // the top cut-out is not filled
  assert.ok(sideLogo.every(([x, , z]) => Math.hypot(x - 5.5, z - 1.3) <= 0.18 * 1.01));
  assert.ok(sideLogo.some(([, y]) => y > 1.6) && sideLogo.some(([, y]) => y < -1.6));
  assert.ok(cab.glass.boundingBox.max.x > 10.3 && carGeometries().middle.glass.boundingBox.max.x < 10.6);
});

test('pantographs on the motor cars next to each end', () => {
  const on = cars => Array.from({ length: cars }, (_, j) => j).filter(j => hasPantograph(j, cars));
  assert.deepEqual(on(8), [1, 6]);
  assert.deepEqual(on(6), [1, 4]);
  assert.deepEqual(on(4), [1, 2]);
});

test('level of detail: full close up, simple far off, nothing out of view', () => {
  const cam = new THREE.PerspectiveCamera(60, 1, 1, 20000);
  cam.up.set(0, 0, 1); cam.position.set(0, -100, 50); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const f = new THREE.Frustum().setFromProjectionMatrix(vp);
  const car = y => [new THREE.Vector3(-11, y, 0), new THREE.Vector3(11, y, 0)];
  assert.equal(carDetail(vp, f, ...car(0), 1000, 1000), 'full');   // about 170 px long
  assert.equal(carDetail(vp, f, ...car(3000), 1000, 1000), 'low');  // about 6 px
  assert.equal(carDetail(vp, f, ...car(-300), 1000, 1000), 'none'); // behind the camera
  assert.equal(carDetail(vp, f, new THREE.Vector3(500, 0, 0), new THREE.Vector3(522, 0, 0), 1000, 1000), 'none');  // off to the side
});

// Positions of a geometry, as [x, y, z] triples.
function points(g) {
  return Array.from({ length: g.getAttribute('position').count }, (_, i) => [0, 1, 2].map(j => g.getAttribute('position').array[3 * i + j]));
}

test('a sweep follows the track: the size of its profile, sloping smoothly with no steps', () => {
  const g = sweep([{ p: [0, 0], z: 0 }, { p: [10, 0], z: 0.5 }, { p: [20, 0], z: 1 }], PROFILES.deck);
  const bb = g.boundingBox;
  near(bb.min.x, 0); near(bb.max.x, 20); near(bb.max.y, 2.4); near(bb.min.y, -2.4);
  near(bb.min.z, -1.2); near(bb.max.z, 1);
  assert.equal(g.getAttribute('position').count, 3 * (2 * 4 * 2 + 2 * 2));  // 2 joins x 4 faces x 2 triangles, 2 caps
  // Top and underside are each one straight slope: every vertex is at z = x / 20, or 1.2 m below it.
  for (const [x, , z] of points(g)) near(Math.min(Math.abs(z - x / 20), Math.abs(z - x / 20 + 1.2)), 0, 1e-5);
});

test('a sweep is closed and faces outwards, so it can be drawn one-sided', () => {
  const g = sweep([{ p: [0, 0], z: 0 }, { p: [10, 0], z: 0.5 }, { p: [20, 5], z: 1 }], PROFILES.deck);
  const p = points(g);
  for (let i = 0; i < p.length; i += 3) {
    const [a, b, c] = [p[i], p[i + 1], p[i + 2]], u = b.map((x, j) => x - a[j]), w = c.map((x, j) => x - a[j]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const mid = [0, 1, 2].map(j => (a[j] + b[j] + c[j]) / 3);
    // The deck's middle line: 0.6 m under the spine, which runs (0,0) -> (10,0) -> (20,5).
    const along = mid[0] <= 10 ? [mid[0], 0, mid[0] / 20 - 0.6] : [mid[0], (mid[0] - 10) / 2, mid[0] / 20 - 0.6];
    const out = n.reduce((d, x, j) => d + x * (mid[j] - along[j]), 0);
    const cap = Math.abs(mid[0]) < 0.3 ? -1 : mid[0] > 19 ? 1 : 0;  // the ends face back and forward
    assert.ok(cap ? n[0] * cap > 0 : out > 0, `triangle ${i / 3} at ${mid.map(x => x.toFixed(2))} faces in`);
  }
});

test('an arched profile sweeps outward-facing, its ends filled only inside the arch', () => {
  const N = 12, arch = u => 1.4 * (1 - (u / 6) ** 2);
  const upper = Array.from({ length: N + 1 }, (_, i) => [-6 + i, arch(-6 + i) + 0.25]);
  const lower = Array.from({ length: N + 1 }, (_, i) => [6 - i, arch(6 - i)]);
  const p = points(sweep([{ p: [0, 0], z: 0 }, { p: [10, 0], z: 0 }], [...upper, ...lower]));
  let capArea = 0;
  for (let i = 0; i < p.length; i += 3) {
    const [a, b, c] = [p[i], p[i + 1], p[i + 2]];
    const n = [0, 1, 2].map(j => [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])][j]);
    if ([a, b, c].every(q => Math.abs(q[0]) < 1e-9)) { capArea += Math.abs(n[0]) / 2; assert.ok(n[0] < 0, 'front end faces back'); continue; }
    if ([a, b, c].every(q => Math.abs(q[0] - 10) < 1e-9)) { assert.ok(n[0] > 0, 'far end faces forward'); continue; }
    if ([a, b, c].every(q => Math.abs(Math.abs(q[1]) - 6) < 1e-5)) continue;  // the arch's feet
    const top = [a, b, c].every(q => Math.abs(q[2] - arch(q[1]) - 0.25) < 1e-5);
    assert.ok(top ? n[2] > 0 : n[2] < 0, `triangle ${i / 3} faces into the roof`);
  }
  near(capArea, 12 * 0.25, 1e-6);  // a 0.25 m thick arch 12 m across, not the space under it
});

test('a station: platforms clear the trains, columns hold the roof, a concourse on piers under a raised one', () => {
  const sections = [0, 10, 20, 30, 40, 50, 60].map(x => [x, 0]);
  const st = stationGeometry(sections, { m: 2.5, g: 2.5, h: 12, under: false });  // tracks at y = 0 and y = 5
  assert.deepEqual(Object.keys(st).sort(), ['concourse', 'edge', 'glass', 'pier', 'platform', 'roof', 'steel', 'window']);
  const bb = k => st[k].boundingBox;
  assert.ok(points(st.platform).every(([, y]) => y <= -1.65 + 1e-5 || y >= 6.65 - 1e-5));  // 1.65 m from each track: a car is 1.6 m half-wide
  near(bb('platform').max.z, 13.1);
  near(bb('steel').min.z, 13.1); near(bb('steel').max.z, 18.6);
  near(bb('roof').min.z, 18.6); near(bb('roof').max.z, 20.25);
  assert.ok(bb('roof').min.y < bb('platform').min.y && bb('roof').max.y > bb('platform').max.y);  // it covers both platforms
  near(bb('concourse').min.z, 5.2); near(bb('concourse').max.z, 10.8);
  near(bb('pier').min.z, 0); near(bb('pier').max.z, 5.2);
  const under = stationGeometry(sections, { m: 0, g: 2.3, h: -16, under: true });
  assert.deepEqual(Object.keys(under).sort(), ['canopy', 'edge', 'glass', 'hall', 'platform', 'steel']);
  near(under.glass.boundingBox.min.z, 0); near(under.canopy.boundingBox.max.z, 3.4);  // the entrance stands on the street
  near(under.hall.boundingBox.max.z, -10);
});

test('on a bend the section turns half way, so pieces meet without a notch', () => {
  // Right-angle bend at (10, 0): the middle section lies along the diagonal x + y = 10.
  const g = sweep([{ p: [0, 0], z: 0 }, { p: [10, 0], z: 0 }, { p: [10, 10], z: 0 }], PROFILES.bed);
  const onDiagonal = points(g).filter(([x, y]) => Math.abs(x + y - 10) < 1e-4 && Math.abs(x - 10) > 1e-4);
  assert.ok(onDiagonal.length > 0);
  for (const [x, y] of onDiagonal) near(Math.hypot(x - 10, y), 1.7, 1e-4);
});

test('a third rail runs beside the track, clear of the sleepers and the wheels', () => {
  const us = PROFILES.thirdRail.map(([u]) => u), sleeperHalf = 2.75 / 2;
  assert.ok(Math.min(...us) > sleeperHalf - 0.1 && Math.min(...us) > 0.873 + 0.06 + 0.3);
  assert.ok(Math.max(...PROFILES.thirdRail.map(([, v]) => v)) > 0.28);  // its top above the running rails
});

test('profiles: broad-gauge rails, a tunnel the train fits in, bed below the rails', () => {
  near(Math.max(...PROFILES.railLeft.map(([u]) => u)), 0.873 + 0.035);  // 1676 mm gauge plus half a rail head
  near(Math.max(...PROFILES.railLeft.map(([, v]) => v)), 0.28);
  near(Math.max(...PROFILES.bed.map(([, v]) => v)), 0);
  const car = carGeometries().middle.body.boundingBox, tube = PROFILES.tube;
  assert.ok(Math.max(...tube.map(([u]) => u)) > car.max.y + 1 && Math.max(...tube.map(([, v]) => v)) > car.max.z + 0.28 + 1);
});

test('simplify drops sections on straight even track and keeps bends and changes of grade', () => {
  const straight = Array.from({ length: 11 }, (_, i) => ({ p: [10 * i, 0], z: 12 }));
  assert.equal(simplify(straight).length, 2);
  const bend = [...straight.slice(0, 6), ...Array.from({ length: 5 }, (_, i) => ({ p: [50 + 10 * (i + 1), 2 * (i + 1)], z: 12 }))];
  assert.deepEqual(simplify(bend).map(c => c.p), [[0, 0], [50, 0], [100, 10]]);
  const ramp = straight.map((c, i) => ({ ...c, z: Math.min(i, 5) }));  // up 1 m every section, then level
  assert.deepEqual(simplify(ramp).map(c => c.p[0]), [0, 50, 100]);
});

test('sleepers every 0.65 m along the track, square to it, across section joins', () => {
  const spots = sleeperSpots([{ p: [0, 0], z: 0 }, { p: [10, 0], z: 1 }, { p: [10, 10], z: 1 }]);
  assert.equal(spots.length, Math.floor((20 - 0.325) / 0.65) + 1);
  near(spots[0][0], 0.325); near(spots[0][2], 0.0325); near(spots[0][3], 0);
  const turned = spots.filter(([x, y]) => y > 0);
  assert.ok(turned.every(([x, , , h]) => x === 10 && Math.abs(h - Math.PI / 2) < 1e-9));
  for (let i = 1; i < spots.length; i++) {
    const [a, b] = [spots[i - 1], spots[i]];
    near(Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]), 0.65, 1e-6);  // along x, then along y; round the corner it adds up
  }
});

test('runs: stretches that keep, overlapping one section either side', () => {
  const zs = [0, 5, 5, 0, 0, 5].map(z => ({ z }));
  assert.deepEqual(runs(zs, c => c.z > 1).map(r => r.map(c => c.z)), [[0, 5, 5, 0], [0, 5]]);
  assert.deepEqual(runs([{ z: 0 }], c => c.z > 1), []);
});

test('the pantograph stands on the roof and its head touches the contact wire', () => {
  const bb = pantographGeometry().boundingBox, body = carGeometries().middle.body.boundingBox;
  near(bb.min.z, 3.89);                       // base frame sits on the 3.85 m roof
  near(bb.max.z, 5.3);                        // collector head at the contact wire
  assert.ok(bb.min.x > body.min.x && bb.max.x < body.max.x && bb.max.y <= 0.96);
});

test('overhead line: contact wire throughout, messenger and droppers only outside tunnel', () => {
  const spine = [0, 10, 20, 30].map((x, i) => ({ p: [x, 0], z: i < 2 ? 12 : -16 }));
  const pts = overheadLines(spine), zs = [];
  for (let i = 2; i < pts.length; i += 3) zs.push(pts[i]);
  const count = h => zs.filter(z => Math.abs(z - h) < 1e-4).length;
  assert.equal(count(12 + 0.28 + 5.3) + count(-16 + 0.28 + 5.3), 3 * 2 + 2);  // 3 contact segments, a dropper end at each outside section
  assert.equal(count(12 + 0.28 + 6.7), 2 + 2);  // one messenger segment between the outside sections, plus 2 dropper tops
  assert.equal(count(-16 + 0.28 + 6.7), 0);     // no messenger in the tunnel
  assert.equal(pts.length % 6, 0);
});

test('mast stands beside the track and reaches over it at messenger height', () => {
  const bb = MAST.boundingBox;
  near(bb.min.z, 0); near(bb.max.z, 0.28 + 6.7 + 0.6);
  assert.ok(bb.max.y > 2.3 && bb.min.y < 0 && bb.min.y > -0.1);  // pole on the left, arms out to the track centre
});
