// Delhi Metro cars as 3D models in a MapLibre custom layer, drawn with three.js so they share the
// map's depth: they run on the viaduct and under station roofs. Each part is one InstancedMesh.
// Styled after DMRC's Blue Line stainless-steel stock: silver body, waist band and thin stripe,
// four double-leaf doors a side, roof air-conditioning units, bogies with wheels, and at each end a
// rounded cab: two windscreens in a dark surround either side of a front door with the red DMRC
// logo (also on the sides), red-ringed lamp housings, orange destination
// displays, a coupler and skirt. The band takes the line's colour; pink panels by the doors mark
// the women's coach (front car). Every line gets the same car; sizes and livery are approximate.
// Level of detail: below LOD_ZOOM every car is one simple box; closer in, only cars in view are
// drawn, in full unless they are under DETAIL_PX long on screen.
// It also draws the track: two broad-gauge rails on concrete sleepers (built 500 m at a time, only
// near the middle of the view when zoomed in), the ballast bed off the viaduct,
// and in tunnel the track, a see-through tunnel and the underground stations at their depth, which
// MapLibre's own extrusions cannot do because they stop at the street.
import * as THREE from './vendor/three.module.min.js';
import { CAR_M, BOGIE_M } from './motion.js';
import { CAR_W } from './scene.js';

const MAX_CARS = 4000;   // the estimated weekday peak runs about 2,700 cars on all lines; headroom for overlaps
const HALF = CAR_M / 2;  // car frame: x along the car (front +x), y to its left, z up, metres,
const W = CAR_W / 2;     // origin on the rail at the car's middle
const BODY_HALF = HALF - 0.1;
const DOORS_X = [-8.25, -2.75, 2.75, 8.25];
const GAUGE_HALF = 0.873;  // rail centre from track centre: broad gauge, 1676 mm between the rails
const RAIL_TOP = 0.28;     // rail top above the deck or bed: 0.12 m sleeper, 0.16 m rail
const CONTACT_M = 5.3;     // 25 kV contact wire above the rail top (typical; DMRC's design height is not public)
const MESSENGER_M = 6.7;   // messenger wire carrying it, 1.4 m above
const MAST_EVERY = 5;      // a mast every 5th 10 m section: 50 m spans
const SILL = 1.0, ROOF = 3.85, ROOF_R = 0.55;  // body bottom and roof top above the rail, roof corner radius
const NOSE_X = 9.4;        // cab car: where the nose starts; its foot is NOSE_L on, at the body's end
const NOSE_L = BODY_HALF - NOSE_X;
const WINDOWS = [[-9.85, 1.3], [-6.5, 1.75], [-4.5, 1.75], [-1, 1.75], [1, 1.75], [4.5, 1.75], [6.5, 1.75], [9.85, 1.3]];  // [x, width]
export const LOD_ZOOM = 15;  // below this every car is drawn as one simple box
export const DETAIL_PX = 14; // closer in, a car shorter than this on screen is drawn simply too
// The motor cars next to each end car carry a pantograph: cars 1 and 6 of 8, counted from the front.
export const hasPantograph = (car, cars) => cars >= 4 && (car === 1 || car === cars - 2);
const PANTO_X = 2.0;       // pantograph along its car, clear of the roof units
const SLEEPER_M = 0.65;    // concrete sleepers every 0.65 m
const CHUNK = 50;          // track sections (10 m) per rails-and-sleepers chunk
const MAX_CHUNKS = 600;    // chunks kept built; the least recently seen go first
const BUILD_PER_FRAME = 6; // chunks built per frame, so zooming in does not stall
const RAILS_ZOOM = 13.5, SLEEPERS_ZOOM = 15;  // rails and sleepers are below a pixel further out
const reach = zoom => 1500 * 2 ** (16 - zoom);  // rails and sleepers drawn this far from the view's middle
// DMRC logo, traced from its SVG (the red ring with two bars joined by a slant): the red outline and
// its four cut-outs as [across, up] in radii of the ring, and its triangles.
const LOGO = {"outer":[[-0.067,0.998],[0.033,1.0],[0.132,0.992],[0.231,0.974],[0.327,0.946],[0.42,0.909],[0.509,0.862],[0.611,0.793],[0.704,0.711],[0.787,0.619],[0.857,0.517],[0.915,0.408],[0.958,0.292],[0.985,0.18],[0.999,0.067],[1.0,-0.048],[0.988,-0.162],[0.963,-0.273],[0.926,-0.381],[0.871,-0.493],[0.804,-0.597],[0.723,-0.692],[0.632,-0.776],[0.531,-0.848],[0.422,-0.907],[0.317,-0.949],[0.208,-0.979],[0.097,-0.996],[-0.016,-1.0],[-0.129,-0.992],[-0.24,-0.971],[-0.348,-0.938],[-0.453,-0.892],[-0.551,-0.835],[-0.642,-0.766],[-0.725,-0.689],[-0.799,-0.602],[-0.86,-0.51],[-0.911,-0.412],[-0.951,-0.309],[-0.98,-0.203],[-0.996,-0.094],[-1.0,0.017],[-0.99,0.143],[-0.964,0.268],[-0.922,0.388],[-0.865,0.502],[-0.795,0.608],[-0.711,0.704],[-0.621,0.784],[-0.522,0.853],[-0.416,0.91],[-0.304,0.953],[-0.187,0.983]],"holes":[[[-0.282,0.771],[-0.374,0.731],[-0.46,0.68],[-0.539,0.619],[-0.61,0.549],[-0.672,0.471],[-0.725,0.386],[-0.483,0.386],[-0.241,0.386],[0.0,0.386],[0.242,0.386],[0.484,0.386],[0.725,0.386],[0.674,0.47],[0.614,0.546],[0.544,0.615],[0.467,0.676],[0.383,0.727],[0.294,0.767],[0.2,0.797],[0.104,0.815],[0.006,0.821],[-0.092,0.816],[-0.189,0.799]],[[-0.788,0.228],[-0.805,0.159],[-0.816,0.088],[-0.821,0.017],[-0.819,-0.054],[-0.811,-0.125],[-0.797,-0.194],[-0.724,-0.194],[-0.651,-0.194],[-0.578,-0.195],[-0.505,-0.195],[-0.431,-0.194],[-0.358,-0.192],[-0.283,-0.123],[-0.209,-0.053],[-0.134,0.017],[-0.06,0.087],[0.015,0.157],[0.089,0.228],[-0.057,0.227],[-0.204,0.227],[-0.35,0.227],[-0.496,0.227],[-0.642,0.227]],[[0.291,0.216],[0.218,0.148],[0.146,0.079],[0.073,0.011],[0.0,-0.057],[-0.073,-0.126],[-0.145,-0.194],[0.012,-0.194],[0.17,-0.194],[0.328,-0.194],[0.485,-0.194],[0.643,-0.194],[0.801,-0.194],[0.813,-0.124],[0.82,-0.053],[0.822,0.017],[0.817,0.088],[0.807,0.158],[0.791,0.227],[0.715,0.227],[0.638,0.227],[0.562,0.227],[0.486,0.227],[0.41,0.227],[0.334,0.227],[0.326,0.227],[0.318,0.227],[0.311,0.227],[0.303,0.225],[0.297,0.222]],[[-0.742,-0.353],[-0.681,-0.458],[-0.606,-0.553],[-0.517,-0.637],[-0.418,-0.706],[-0.309,-0.761],[-0.194,-0.798],[-0.113,-0.813],[-0.031,-0.82],[0.051,-0.819],[0.133,-0.81],[0.213,-0.793],[0.292,-0.768],[0.387,-0.725],[0.476,-0.67],[0.557,-0.604],[0.629,-0.528],[0.691,-0.444],[0.742,-0.353],[0.495,-0.353],[0.247,-0.353],[0.0,-0.353],[-0.247,-0.353],[-0.494,-0.353]]]};
const LOGO_POINTS = [LOGO.outer, ...LOGO.holes].flat();
const LOGO_TRIS = THREE.ShapeUtils.triangulateShape(LOGO.outer.map(([u, v]) => new THREE.Vector2(u, v)),
  LOGO.holes.map(h => h.map(([u, v]) => new THREE.Vector2(u, v))));

// Whether triangle a, b, c, wound as given, faces away from the point `inside`.
function outward(a, b, c, inside) {
  const u = [0, 1, 2].map(j => b[j] - a[j]), v = [0, 1, 2].map(j => c[j] - a[j]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return [0, 1, 2].reduce((d, j) => d + n[j] * ((a[j] + b[j] + c[j]) / 3 - inside[j]), 0) >= 0;
}

function box(lx, ly, lz, x, y, z) {
  const g = new THREE.BoxGeometry(lx, ly, lz).toNonIndexed();
  g.translate(x, y, z);
  return g;
}

// Concatenate non-indexed geometries into one (positions and normals unless told otherwise).
function merge(geoms, names = ['position', 'normal']) {
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const arrays = geoms.map(g => g.getAttribute(name).array);
    const all = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrays) { all.set(a, o); o += a.length; }
    out.setAttribute(name, new THREE.BufferAttribute(all, 3));
  }
  out.computeBoundingBox();
  return out;
}

const bothSides = make => [make(1), make(-1)];

// Set m to stand a part on the line from a to b (local [x, y]) at heights za and zb: its x runs
// from a to b, tilted with the grade.
const tilt = new THREE.Matrix4();
function place(m, a, b, za, zb) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  m.makeRotationZ(Math.atan2(dy, dx)).multiply(tilt.makeRotationY(-Math.atan2(zb - za, Math.hypot(dx, dy) || 1)));
  return m.setPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (za + zb) / 2);
}

export const SLEEPER = merge([box(0.26, 2.75, 0.12, 0, 0, 0.06)]);  // concrete, across the track

const rect = (u0, u1, v0, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
// Cross-sections swept along the track: [across to the left, up] in metres from the rail-level spine.
export const PROFILES = {
  deck: rect(-2.4, 2.4, -1.2, 0),
  bed: rect(-1.7, 1.7, -0.4, 0),
  tube: rect(-2.9, 2.9, -0.2, 6.0),
  railLeft: rect(GAUGE_HALF - 0.035, GAUGE_HALF + 0.035, RAIL_TOP - 0.16, RAIL_TOP),
  railRight: rect(-GAUGE_HALF - 0.035, -GAUGE_HALF + 0.035, RAIL_TOP - 0.16, RAIL_TOP),
  conductor: rect(-0.06, 0.06, RAIL_TOP + CONTACT_M, RAIL_TOP + CONTACT_M + 0.12),  // rigid overhead rail in tunnel
  thirdRail: rect(GAUGE_HALF + 0.5, GAUGE_HALF + 0.58, RAIL_TOP - 0.05, RAIL_TOP + 0.15),  // beside the track, on its left
};

// One solid swept along track sections ({p: local [x, y], z}): the profile is stood square to the
// track at every section, turned to the average of the directions either side so pieces meet
// without notches on curves, and joined to the next section so slopes are smooth. Ends are capped.
export function sweep(sections, profile) {
  const frames = sections.map((c, i) => {
    const a = sections[Math.max(i - 1, 0)].p, b = sections[Math.min(i + 1, sections.length - 1)].p;
    const n = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / n, (b[1] - a[1]) / n];
  });
  const rings = sections.map((c, i) => profile.map(([u, v]) => [c.p[0] - frames[i][1] * u, c.p[1] + frames[i][0] * u, c.z + v]));
  // Every triangle faces out of the solid, so it can be drawn one-sided: cut open by the camera's
  // near plane it shows nothing, rather than its inside walls (which looked like a tunnel). Out is
  // taken from the profile's own edges, so a profile that is not convex (an arched roof) works too.
  const area = profile.reduce((A, [u, v], k) => { const [u2, v2] = profile[(k + 1) % profile.length]; return A + u * v2 - u2 * v; }, 0);
  const turn = area >= 0 ? 1 : -1, pos = [];
  const tri = (dir, a, b, c) => {
    const u = [0, 1, 2].map(j => b[j] - a[j]), w = [0, 1, 2].map(j => c[j] - a[j]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const q of (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] >= 0 ? [a, b, c] : [a, c, b])) pos.push(q[0], q[1], q[2]);
  };
  for (let i = 0; i + 1 < rings.length; i++) {
    const [tx, ty] = frames[i];
    profile.forEach(([u, v], k) => {
      const k2 = (k + 1) % profile.length, [u2, v2] = profile[k2];
      const nu = turn * (v2 - v), nv = turn * (u - u2), dir = [-ty * nu, tx * nu, nv];  // out of this face
      tri(dir, rings[i][k], rings[i][k2], rings[i + 1][k2]);
      tri(dir, rings[i][k], rings[i + 1][k2], rings[i + 1][k]);
    });
  }
  // The ends, filled by triangulating the profile: a fan from one corner would also fill the space
  // under an arch.
  const capTris = THREE.ShapeUtils.triangulateShape(profile.map(([u, v]) => new THREE.Vector2(u, v)), []);
  for (const [i, sign] of [[0, -1], [rings.length - 1, 1]]) {
    const dir = [sign * frames[i][0], sign * frames[i][1], 0];
    for (const [a, b, c] of capTris) tri(dir, rings[i][a], rings[i][b], rings[i][c]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

// The stretches of sections where keep() holds, each widened by one section either side so the
// next part starts where this one ends. Stretches of one section are dropped.
export function runs(sections, keep) {
  const out = [];
  let start = -1;
  sections.forEach((c, i) => {
    if (keep(c) && start < 0) start = i;
    const ends = start >= 0 && (!keep(c) || i === sections.length - 1);
    if (ends) {
      const last = keep(c) ? i : i - 1;
      out.push(sections.slice(Math.max(start - 1, 0), Math.min(last + 2, sections.length)));
      start = -1;
    }
  });
  return out.filter(r => r.length > 1);
}

// Body from x0 to x1: straight sides from SILL, roof rounded at the corners.
function body(x0, x1) {
  const r = ROOF_R, b = SILL, t = ROOF, s = new THREE.Shape();
  s.moveTo(-W, b); s.lineTo(W, b); s.lineTo(W, t - r); s.quadraticCurveTo(W, t, W - r, t);
  s.lineTo(-W + r, t); s.quadraticCurveTo(-W, t, -W, t - r); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: x1 - x0, bevelEnabled: false, curveSegments: 6 });  // already non-indexed
  g.deleteAttribute('uv');
  // The shape is drawn in (x, y) and extruded along z; turn it so the car runs along x.
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  g.translate(x0, 0, 0);
  return merge([g]);
}

// Triangles ([x, y, z] corners) as a geometry, each wound to face away from the point `inside`.
function faces(tris, inside) {
  const pos = [];
  for (const [a, b, c] of tris) {
    const out = outward(a, b, c, inside);
    pos.push(...a, ...(out ? b : c), ...(out ? c : b));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}
const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
const INSIDE = [0, 0, 2.4];  // a point inside the car, for facing panels outwards

// The nose: the body section lofted forward from NOSE_X (u = 0) to the front (u = 1), narrowing in
// plan, its roof dipping and the windscreen above 2 m leaning back 0.6 m at the top.
const rake = z => z <= 2 ? 1 : 1 - 0.4 * (z - 2) / (ROOF - 2);
const dip = z => 0.2 * Math.max(z - 2, 0) / (ROOF - 2);
const noseAt = (y, z, u) => [NOSE_X + NOSE_L * u * rake(z), y * (1 - 0.14 * u * u), z - u * u * dip(z)];
// A point `lift` metres proud of the front face, y across it as drawn.
const facePoint = (y, z, lift) => [NOSE_X + NOSE_L * rake(z) + lift, y, z - dip(z)];
// Half the body section, [y, z] from the sill up the side and round the roof corner to the top.
const SECTION = [[W, SILL], [W, 2], [W, ROOF - ROOF_R],
  ...[1, 2, 3, 4].map(k => [W - ROOF_R + ROOF_R * Math.cos(k * Math.PI / 8), ROOF - ROOF_R + ROOF_R * Math.sin(k * Math.PI / 8)])];

export function noseGeometry() {
  const ring = [...SECTION, ...SECTION.slice().reverse().map(([y, z]) => [-y, z])], U = [0, 0.25, 0.5, 0.75, 1], tris = [];
  for (let i = 0; i + 1 < U.length; i++) {
    ring.forEach(([y, z], k) => {
      const [y2, z2] = ring[(k + 1) % ring.length];
      tris.push(...quad(noseAt(y, z, U[i]), noseAt(y2, z2, U[i]), noseAt(y2, z2, U[i + 1]), noseAt(y, z, U[i + 1])));
    });
  }
  for (let k = 0; k + 1 < SECTION.length; k++) {  // the front, in strips between the section's heights
    const [[ya, za], [yb, zb]] = [SECTION[k], SECTION[k + 1]];
    tris.push(...quad(noseAt(-ya, za, 1), noseAt(ya, za, 1), noseAt(yb, zb, 1), noseAt(-yb, zb, 1)));
  }
  return faces(tris, [NOSE_X, 0, 2.4]);
}

// A rectangle on the front face, split where the face bends at 2 m so it lies flat on it.
function facePanel(y0, y1, z0, z1, lift) {
  const zs = z0 < 2 && z1 > 2 ? [z0, 2, z1] : [z0, z1], tris = [];
  for (let i = 0; i + 1 < zs.length; i++) {
    tris.push(...quad(facePoint(y0, zs[i], lift), facePoint(y1, zs[i], lift), facePoint(y1, zs[i + 1], lift), facePoint(y0, zs[i + 1], lift)));
  }
  return tris;
}
// A strip along one side of the nose between heights z0 and z1, `lift` metres out, from u0 to u1.
function noseSide(side, z0, z1, lift, u0 = 0, u1 = 1) {
  const tris = [], y = side * (W + lift);
  for (let i = 0; i < 4; i++) {
    const ua = u0 + (u1 - u0) * i / 4, ub = u0 + (u1 - u0) * (i + 1) / 4;
    tris.push(...quad(noseAt(y, z0, ua), noseAt(y, z0, ub), noseAt(y, z1, ub), noseAt(y, z1, ua)));
  }
  return tris;
}
const both = make => [...make(1), ...make(-1)];
const wheel = (x, y) => {
  const g = new THREE.CylinderGeometry(0.43, 0.43, 0.12, 12).toNonIndexed();  // 860 mm wheels; the cylinder's axis is y
  g.translate(x, y, 0.43);
  return g;
};

// The logo r metres across as triangles, each corner placed by at(across, up) in metres from its centre.
const logo = (r, at) => LOGO_TRIS.map(tri => tri.map(i => at(LOGO_POINTS[i][0] * r, LOGO_POINTS[i][1] * r)));

// The spine ({p, z} sections) with sections dropped where the track runs straight and evenly
// sloped: each dropped one is within tol metres of the line between the kept ones either side.
export function simplify(spine, tol = 0.03) {
  const keep = new Uint8Array(spine.length), stack = [[0, spine.length - 1]];
  keep[0] = keep[spine.length - 1] = 1;
  while (stack.length) {
    const [i, j] = stack.pop(), a = spine[i], b = spine[j];
    const d = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.z - a.z], n2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1;
    let worst = tol, at = -1;
    for (let k = i + 1; k < j; k++) {
      const c = spine[k], e = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.z - a.z];
      const f = (e[0] * d[0] + e[1] * d[1] + e[2] * d[2]) / n2;
      const off = Math.hypot(e[0] - f * d[0], e[1] - f * d[1], e[2] - f * d[2]);
      if (off > worst) { worst = off; at = k; }
    }
    if (at >= 0) { keep[at] = 1; stack.push([i, at], [at, j]); }
  }
  return spine.filter((_, k) => keep[k]);
}

// Where the sleepers go along a spine: [x, y, z, heading] every SLEEPER_M, or every `every` metres.
export function sleeperSpots(spine, every = SLEEPER_M) {
  const out = [];
  let d = every / 2;
  for (let i = 0; i + 1 < spine.length; i++) {
    const a = spine[i], b = spine[i + 1], len = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
    const heading = Math.atan2(b.p[1] - a.p[1], b.p[0] - a.p[0]);
    for (; d < len; d += every) {
      const f = d / len;
      out.push([a.p[0] + f * (b.p[0] - a.p[0]), a.p[1] + f * (b.p[1] - a.p[1]), a.z + f * (b.z - a.z), heading]);
    }
    d -= len;
  }
  return out;
}

// A square bar of width w from (x0, z0) to (x1, z1) in the car's x-z plane, at lateral offset y.
function bar(x0, z0, x1, z1, y, w) {
  const g = new THREE.BoxGeometry(Math.hypot(x1 - x0, z1 - z0), w, w).toNonIndexed();
  g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return g;
}

// Pantograph on the roof (top at 3.85 m), raised so its collector head touches the contact wire.
export function pantographGeometry() {
  const head = CONTACT_M - 0.06;
  return merge([
    box(1.6, 1.3, 0.12, PANTO_X, 0, 3.95),                                                  // base frame
    ...bothSides(side => bar(PANTO_X - 0.6, 4.0, PANTO_X + 0.5, 4.75, side * 0.45, 0.07)),  // lower arms
    ...bothSides(side => bar(PANTO_X + 0.5, 4.75, PANTO_X - 0.1, head, side * 0.3, 0.05)),   // upper arms
    box(0.35, 1.9, 0.06, PANTO_X - 0.1, 0, head + 0.03),                                    // collector head
  ]);
}

// Overhead line mast, origin on the deck or bed at the track centre: a steel pole on the track's
// left, which on Delhi's left-running lines is the outer side, with arms out over the track.
export const MAST = merge([
  box(0.3, 0.3, RAIL_TOP + MESSENGER_M + 0.6, 0, 2.3, (RAIL_TOP + MESSENGER_M + 0.6) / 2),
  box(0.1, 2.4, 0.1, 0, 1.15, RAIL_TOP + MESSENGER_M),      // cantilever holding the messenger wire
  box(0.08, 2.35, 0.08, 0, 1.15, RAIL_TOP + CONTACT_M + 0.3),  // arm steadying the contact wire
]);

// The overhead wires for one track spine ({p: local [x, y], z}) as pairs of points for line
// segments: the contact wire all the way, and outside tunnels the messenger above it with a
// dropper down to the contact wire at every section.
export function overheadLines(spine) {
  const pts = [];
  const at = (c, h) => [c.p[0], c.p[1], c.z + RAIL_TOP + h];
  for (let i = 0; i + 1 < spine.length; i++) pts.push(...at(spine[i], CONTACT_M), ...at(spine[i + 1], CONTACT_M));
  const open = c => c.z > -0.5;
  spine.forEach((c, i) => {
    if (!open(c)) return;
    if (i + 1 < spine.length && open(spine[i + 1])) pts.push(...at(c, MESSENGER_M), ...at(spine[i + 1], MESSENGER_M));
    pts.push(...at(c, MESSENGER_M), ...at(c, CONTACT_M));
  });
  return new Float32Array(pts);
}

// Each part's geometry in the car frame, for a middle car and an end (cab) car, keyed by material,
// and the low-detail box. Exported for the tests.
export function carGeometries() {
  const windows = cab => WINDOWS.filter(([x]) => !cab || x < NOSE_X)
    .flatMap(([x, w]) => bothSides(side => box(w, 0.03, 0.9, x, side * (W + 0.015), 2.55)));
  const common = cab => {
    const end = cab ? NOSE_X : BODY_HALF;
    return {
      body: cab ? merge([body(-BODY_HALF, NOSE_X), noseGeometry()]) : body(-BODY_HALF, BODY_HALF),
      doors: merge(DOORS_X.flatMap(x => [-0.36, 0.36].flatMap(dx => bothSides(side => box(0.7, 0.05, 2.0, x + dx, side * (W + 0.02), 2.05))))),
      glass: merge([
        ...windows(cab),
        ...DOORS_X.flatMap(x => [-0.36, 0.36].flatMap(dx => bothSides(side => box(0.42, 0.02, 0.95, x + dx, side * (W + 0.05), 2.5)))),
        ...(cab ? [faces([
          ...both(side => facePanel(side * 0.5, side * 1.25, 2.15, 3.3, 0.03)),  // windscreens
          ...facePanel(-0.26, 0.26, 2.3, 3.2, 0.02),                              // front door window
          ...both(side => noseSide(side, 2.15, 3.0, 0.015, 0.05, 0.6)),           // cab side windows
        ], INSIDE)] : []),
      ]),
      band: merge([
        ...bothSides(side => box(end + BODY_HALF, 0.02, 0.3, (end - BODY_HALF) / 2, side * (W + 0.06), 1.7)),
        ...(cab ? [faces(both(side => noseSide(side, 1.55, 1.85, 0.06)), INSIDE)] : []),
      ]),
      pinstripe: merge([
        ...bothSides(side => box(end + BODY_HALF, 0.02, 0.06, (end - BODY_HALF) / 2, side * (W + 0.06), 1.93)),
        ...(cab ? [faces(both(side => noseSide(side, 1.9, 1.96, 0.06)), INSIDE)] : []),
      ]),
      dark: merge([
        box(9.5, 2.3, 0.6, 0, 0, 0.72),                                            // underframe equipment
        ...[-BOGIE_M, BOGIE_M].map(x => box(2.9, 2.0, 0.35, x, 0, 0.6)),           // bogie frames
        ...[-BOGIE_M, BOGIE_M].flatMap(x => [x - 1.1, x + 1.1]).flatMap(x => [wheel(x, GAUGE_HALF), wheel(x, -GAUGE_HALF)]),
        box(1.0, 2.3, 2.4, -HALF - 0.45, 0, 2.2),                                  // gangway to the car behind
        ...(cab ? [box(0.5, 0.3, 0.25, BODY_HALF - 0.2, 0, 0.85)] : []),           // coupler
      ]),
      grey: merge([
        ...[-5.5, 5.5].map(x => box(3.0, 1.8, 0.3, x, 0, ROOF + 0.15)),            // roof air-conditioning units
        ...(cab ? [box(0.5, 2.6, 0.5, BODY_HALF - 0.35, 0, 0.75)] : []),           // skirt under the nose
      ]),
    };
  };
  return {
    middle: common(false),
    cab: {
      ...common(true),
      face: faces(both(side => facePanel(side * 0.42, side * 1.32, 1.8, 3.35, 0.015)), INSIDE),  // dark surround
      red: faces([
        ...both(side => facePanel(side * 0.62, side * 1.28, 1.22, 1.68, 0.015)),                  // lamp housings
        ...logo(0.2, (u, v) => facePoint(u, 1.75 + v, 0.03)),                                    // DMRC logo on the front door
        ...both(side => logo(0.18, (u, v) => [5.5 - side * u, side * (W + 0.03), 1.3 + v])),     // and the sides, not mirrored
      ], INSIDE),
      display: faces(both(side => facePanel(side * 0.6, side * 1.15, 3.38, 3.5, 0.03)), INSIDE),
      headlamp: faces(both(side => facePanel(side * 0.95, side * 1.2, 1.3, 1.6, 0.03)), INSIDE),
      taillamp: faces(both(side => facePanel(side * 0.7, side * 0.88, 1.33, 1.57, 0.03)), INSIDE),
      ladies: merge(DOORS_X.flatMap(x => [-0.8, 0.8].flatMap(dx => bothSides(side => box(0.1, 0.02, 1.9, x + dx, side * (W + 0.012), 2.0))))),
    },
    ...lowGeometry(),
  };
}

// One box per car with a dark window band. The body is white here, so the per-car colour makes
// it the line's colour: far off, a silver car on a grey viaduct was lost in the track.
function lowGeometry() {
  const tint = (g, hex) => {
    const c = new THREE.Color(hex), n = g.getAttribute('position').count, a = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], 3 * i);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  return {
    low: merge([
      tint(box(2 * BODY_HALF, 2 * W, ROOF - 0.5, 0, 0, (ROOF + 0.5) / 2), 0xffffff),
      tint(box(2 * BODY_HALF - 0.6, 2 * W + 0.04, 0.85, 0, 0, 2.55), 0x18202b),
    ], ['position', 'normal', 'color']),
  };
}

// How to draw a car whose ends are at a and b (Vector3s, layer frame) seen through vp, whose
// frustum is given: 'none' out of view, 'low' when under DETAIL_PX long on a width x height
// screen, else 'full'.
const sphere = new THREE.Sphere(), v4 = new THREE.Vector4();
export function carDetail(vp, frustum, a, b, width, height) {
  sphere.center.addVectors(a, b).multiplyScalar(0.5);
  sphere.center.z += 2;
  sphere.radius = HALF + 1.5;
  if (!frustum.intersectsSphere(sphere)) return 'none';
  const ndc = p => { v4.set(p.x, p.y, p.z, 1).applyMatrix4(vp); return v4.w > 0 ? [v4.x / v4.w, v4.y / v4.w] : null; };
  const pa = ndc(a), pb = ndc(b);
  if (!pa || !pb) return 'full';  // an end behind the camera: the car is right by it
  return Math.hypot((pa[0] - pb[0]) * width / 2, (pa[1] - pb[1]) * height / 2) < DETAIL_PX ? 'low' : 'full';
}

// One station's parts as geometries in the layer frame, by material, from a scene.js stationShape
// with its sections turned to layer [x, y]. Across the track u is metres to the left of the forward
// track and v metres above the rail, as in PROFILES. Above ground: side platforms with a yellow
// edge strip and glass side screens, steel columns under an arched roof, and on a viaduct the
// concourse floor with a window band, on piers over the street. In tunnel: the platforms, columns
// and see-through station box at rail depth, and an entrance pavilion with a red canopy on each
// side of the street above. Sizes are typical, not surveyed.
export function stationGeometry(sections, { m, g, h, under }) {
  const sec = sections.map(p => ({ p, z: h })), parts = {};
  const add = (part, geometry) => (parts[part] ||= []).push(geometry);
  const span = (a, b, v0, v1) => rect(Math.min(a, b), Math.max(a, b), v0, v1);
  const posts = (part, run, every, u, v0, v1, size) => {
    for (const [x, y, z, heading] of sleeperSpots(run, every)) {
      const post = box(size, size, v1 - v0, 0, 0, z + (v0 + v1) / 2);
      post.rotateZ(heading);
      post.translate(x - Math.sin(heading) * u, y + Math.cos(heading) * u, 0);
      add(part, post);
    }
  };
  // The middle of the platform, leaving `frac` of it off each end.
  const trim = frac => { const k = Math.floor(sec.length * frac); return sec.length - 2 * k >= 2 ? sec.slice(k, sec.length - k) : sec; };
  const roofBase = under ? 5.8 : 6.6, wide = g + 5.5;
  for (const side of [-1, 1]) {
    const mid = m + side * (g + 3.4), inner = mid - side * 1.75, outer = mid + side * 1.75;
    add('platform', sweep(sec, span(inner, outer, under ? -0.3 : Math.max(-1.2, -h), 1.1)));
    add('edge', sweep(sec, span(inner, inner + side * 0.5, 1.1, 1.13)));  // tactile strip by the platform edge
    if (!under) add('glass', sweep(sec, span(outer - side * 0.08, outer, 1.1, 2.4)));
    posts('steel', sec, 12, outer - side * 0.6, 1.1, roofBase, 0.45);
  }
  if (under) {
    add('hall', sweep(sec, span(m - wide, m + wide, -0.5, 6)));
    const street = -h, entry = trim(0.35);
    for (const side of [-1, 1]) {
      add('glass', sweep(entry, span(m + side * (g + 7), m + side * (g + 12), street, street + 3)));
      add('canopy', sweep(entry, span(m + side * (g + 6.4), m + side * (g + 12.6), street + 3, street + 3.4)));
    }
  } else {
    // Arched roof across both platforms: 1.4 m rise, 0.25 m thick.
    const L = m - (g + 6.2), R = m + (g + 6.2), N = 12, arch = i => roofBase + 1.4 * (1 - (2 * i / N - 1) ** 2);
    const upper = Array.from({ length: N + 1 }, (_, i) => [L + (R - L) * i / N, arch(i) + 0.25]);
    const lower = Array.from({ length: N + 1 }, (_, i) => [L + (R - L) * (N - i) / N, arch(N - i)]);
    add('roof', sweep(sec, [...upper, ...lower]));
    if (h - 1.2 >= 3) {
      const floor = h > 10 ? -6.8 : -h, hall = trim(0.2);
      add('concourse', sweep(hall, span(m - wide, m + wide, floor, -1.2)));
      for (const side of [-1, 1]) {
        const face = m + side * wide;
        if (floor + 1 < -2.2) add('window', sweep(hall, span(face, face + side * 0.04, floor + 1, -2.2)));
        if (floor > -h + 0.5) posts('pier', hall, 18, m + side * (g + 2.5), -h, floor, 1.4);
      }
    }
  }
  return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, merge(v)]));
}

export function trainLayer(map, origin) {
  const o = maplibregl.MercatorCoordinate.fromLngLat(origin, 0), k = o.meterInMercatorCoordinateUnits();
  // Layer frame: metres east, north and up from `origin`.
  const frame = new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).scale(new THREE.Vector3(k, -k, k));
  const toLocal = lngLat => {
    const c = maplibregl.MercatorCoordinate.fromLngLat(lngLat, 0);
    return [(c.x - o.x) / k, -(c.y - o.y) / k];
  };
  const g = carGeometries();
  const mat = (color, extra) => new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.5, ...extra });
  // Parts laid on the body's surface (doors, windows, band, logo, lamps) sit only 1-5 cm proud of it,
  // too little for the map's depth buffer at a distance: they flickered through each other. Each
  // layer is drawn a step nearer the camera than the one it lies on instead.
  const onTop = (material, layer) => Object.assign(material, { polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -4 * layer });
  const lamp = layer => onTop(new THREE.MeshBasicMaterial({ color: 0xffffff }), layer);  // lit or not by instance colour
  const MATERIALS = {
    body: mat(0xd3d8de, { metalness: 0.35, roughness: 0.35 }), doors: onTop(mat(0xc3c9d0, { metalness: 0.3, roughness: 0.4 }), 1),
    glass: onTop(mat(0x18202b, { metalness: 0.3, roughness: 0.15 }), 2), band: onTop(mat(0xffffff), 3), pinstripe: onTop(mat(0xffffff), 3),
    dark: mat(0x303338, { roughness: 0.85 }), grey: mat(0x9ba1a8, { roughness: 0.6 }), face: onTop(mat(0x45494f, { roughness: 0.6 }), 1),
    red: onTop(mat(0xd0202a), 2), display: onTop(new THREE.MeshBasicMaterial({ color: 0xff8c1a }), 2), headlamp: lamp(3), taillamp: lamp(3),
    ladies: onTop(mat(0xe75480), 2),
  };
  const meshes = {};
  const add = (name, geometry, material, capacity = MAX_CARS) => {
    const m = new THREE.InstancedMesh(geometry, material, capacity);
    m.frustumCulled = false;  // instances spread far beyond the geometry's own bounds
    m.count = 0;
    meshes[name] = m;
  };
  for (const kind of ['middle', 'cab']) for (const [part, geometry] of Object.entries(g[kind])) add(`${kind}.${part}`, geometry, MATERIALS[part]);
  add('low', g.low, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.25, roughness: 0.45 }));
  add('pantographs', pantographGeometry(), new THREE.MeshStandardMaterial({ color: 0x2b2d30, metalness: 0.4, roughness: 0.5 }));
  // Per-car colours: lamps lit or not, and the band and stripe in the line's colour.
  const COLOURED = ['cab.headlamp', 'cab.taillamp', 'low', ...['middle', 'cab'].flatMap(k => [`${k}.band`, `${k}.pinstripe`])];
  for (const name of COLOURED) meshes[name].setColorAt(0, new THREE.Color());  // creates the colour buffer
  const liveries = new Map();
  const livery = hex => liveries.get(hex) || liveries.set(hex, { band: new THREE.Color(hex), pin: new THREE.Color(hex).lerp(new THREE.Color(0xffffff), 0.45) }).get(hex);
  // Parts every car of a kind gets; lamps and the women's-coach panels depend on the car.
  const PARTS = Object.fromEntries(['middle', 'cab'].map(kind =>
    [kind, Object.keys(g[kind]).filter(p => !['headlamp', 'taillamp', 'ladies', 'band', 'pinstripe'].includes(p)).map(p => `${kind}.${p}`)]));
  const LIT = new THREE.Color(0xfff3c4), OFF = new THREE.Color(0x5a5f66), RED = new THREE.Color(0xff2020), RED_OFF = new THREE.Color(0x4a1414);
  const frustum = new THREE.Frustum();
  let placed = [];
  const pool = [];

  const scene = new THREE.Scene(), camera = new THREE.Camera();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.position.set(-0.6, -1, 1.6);
  scene.add(sun, ...Object.values(meshes));
  const m = new THREE.Matrix4();
  const statics = {}, stations = [];
  let renderer, lastView = null;
  const addStatic = (name, geometry, material, pieces) => {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(pieces.length, 1));
    mesh.count = pieces.length;
    mesh.frustumCulled = false;
    pieces.forEach((p, i) => mesh.setMatrixAt(i, place(m, toLocal(p.a), toLocal(p.b), p.za, p.zb)));
    statics[name] = mesh;
    scene.add(mesh);
  };
  const see = (color, opacity) => new THREE.MeshStandardMaterial({ color, transparent: true, opacity, depthWrite: false });

  const put = (mesh, matrix) => {
    if (mesh.count < mesh.instanceMatrix.count) mesh.setMatrixAt(mesh.count++, matrix);
  };
  // Fill the car meshes for this frame: all as boxes when vp is null, else only those in its view.
  const drawCars = (vp, width, height) => {
    for (const mesh of Object.values(meshes)) mesh.count = 0;
    const tint = (mesh, colour) => { mesh.setColorAt(mesh.count, colour); put(mesh, c.m); };
    let c;
    for (c of placed) {
      const detail = vp ? carDetail(vp, frustum, c.a, c.b, width, height) : 'low';
      if (detail === 'none') continue;
      if (detail === 'low') { tint(meshes.low, c.livery.band); continue; }
      const kind = c.lead || c.last ? 'cab' : 'middle';
      for (const name of PARTS[kind]) put(meshes[name], c.m);
      tint(meshes[`${kind}.band`], c.livery.band);
      tint(meshes[`${kind}.pinstripe`], c.livery.pin);
      if (kind === 'cab') {
        tint(meshes['cab.headlamp'], c.lead ? LIT : OFF);
        tint(meshes['cab.taillamp'], c.last && !c.lead ? RED : RED_OFF);
        if (c.lead) put(meshes['cab.ladies'], c.m);
      }
      if (c.panto) put(meshes.pantographs, c.m);
    }
    // Upload only the instances in use: the whole buffers (room for MAX_CARS in each of 25 meshes)
    // are 6 MB, too much to send to the GPU every frame at a 120 Hz refresh.
    const upload = (attribute, count) => {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    };
    for (const mesh of Object.values(meshes)) upload(mesh.instanceMatrix, mesh.count);
    for (const name of COLOURED) upload(meshes[name].instanceColor, meshes[name].count);
  };

  // Rails and sleepers, built a chunk at a time where the camera is close and in view.
  const chunks = [];
  let frameNo = 0;
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9da3aa, metalness: 0.6, roughness: 0.3 });
  const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x8e8b85, roughness: 0.9 });
  const buildChunk = c => {
    const spots = sleeperSpots(c.part);
    const sleepers = new THREE.InstancedMesh(SLEEPER, sleeperMat, Math.max(spots.length, 1));
    sleepers.count = spots.length;
    spots.forEach(([x, y, z, heading], i) => sleepers.setMatrixAt(i, m.makeRotationZ(heading).setPosition(x, y, z)));
    const rails = [PROFILES.railLeft, PROFILES.railRight, ...(c.thirdRail ? [PROFILES.thirdRail] : [])].map(profile => sweep(c.part, profile));
    c.meshes = [new THREE.Mesh(merge(rails), railMat), sleepers];
    for (const mesh of c.meshes) mesh.frustumCulled = false;
    scene.add(...c.meshes);
  };
  const dropChunk = c => {
    scene.remove(...c.meshes);
    c.meshes[0].geometry.dispose();
    c.meshes[1].dispose();
    c.meshes = null;
  };
  const drawTrack = zoom => {
    frameNo++;
    const [cx, cy] = toLocal(map.getCenter()), far = reach(zoom);
    let budget = BUILD_PER_FRAME, built = 0;
    for (const c of chunks) {
      const { center, radius } = c.sphere;
      const show = zoom >= RAILS_ZOOM && Math.hypot(center.x - cx, center.y - cy) < far + radius && frustum.intersectsSphere(c.sphere);
      if (show && !c.meshes) {
        if (budget-- > 0) buildChunk(c); else map.triggerRepaint();  // finish next frame
      }
      if (!c.meshes) continue;
      c.meshes[0].visible = show;
      c.meshes[1].visible = show && zoom >= SLEEPERS_ZOOM;
      if (show) c.seen = frameNo;
      built++;
    }
    if (built > MAX_CHUNKS) {
      chunks.filter(c => c.meshes && c.seen < frameNo).sort((a, b) => a.seen - b.seen).slice(0, built - MAX_CHUNKS).forEach(dropChunk);
    }
  };

  return {
    id: 'trains3d', type: 'custom', renderingMode: '3d',
    onAdd(_, gl) {
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(gl, matrix) {
      const zoom = map.getZoom();
      for (const name of ['wires', 'masts', 'conductor', 'station.steel', 'station.edge', 'station.window']) if (statics[name]) statics[name].visible = zoom >= 14;
      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(frame);
      lastView = camera.projectionMatrix;
      frustum.setFromProjectionMatrix(camera.projectionMatrix);
      drawTrack(zoom);
      drawCars(zoom >= LOD_ZOOM ? camera.projectionMatrix : null, gl.drawingBufferWidth, gl.drawingBufferHeight);
      renderer.resetState();
      renderer.render(scene, camera);
    },
    // Tracks, each {sections: a scene.js trackSections list, thirdRail: powered by a third rail rather
    // than overhead wires}. Call once.
    setTrack(tracks) {
      const parts = { deck: [], bed: [], tube: [], conductor: [] }, wires = [], masts = [];
      for (const { sections, thirdRail } of tracks) {
        const spine = sections.map(c => ({ p: toLocal(c.at), z: c.z }));
        if (!thirdRail) {
          wires.push(overheadLines(spine));
          for (const run of runs(spine, c => c.z < -0.5)) parts.conductor.push(sweep(simplify(run), PROFILES.conductor));
          for (let i = 0; i + 1 < sections.length; i += MAST_EVERY) {
            if (sections[i].z > -0.5) masts.push({ a: sections[i].at, b: sections[i + 1].at, za: sections[i].z, zb: sections[i].z });
          }
        }
        // The 1.2 m deck where its underside clears the street, the ballast bed below that.
        for (const run of runs(spine, c => c.z >= 1.2)) parts.deck.push(sweep(simplify(run), PROFILES.deck));
        for (const run of runs(spine, c => c.z < 1.2)) parts.bed.push(sweep(simplify(run), PROFILES.bed));
        for (const run of runs(spine, c => c.z < -0.5)) parts.tube.push(sweep(simplify(run), PROFILES.tube));
        for (let i = 0; i + 1 < spine.length; i += CHUNK) {
          const part = simplify(spine.slice(i, Math.min(i + CHUNK, spine.length - 1) + 1));
          const sphere = new THREE.Box3().setFromPoints(part.map(c => new THREE.Vector3(c.p[0], c.p[1], c.z))).getBoundingSphere(new THREE.Sphere());
          sphere.radius += 2;  // rails and sleepers stand out from the spine
          chunks.push({ part, sphere, thirdRail, meshes: null, seen: 0 });
        }
      }
      const solid = (color, extra) => new THREE.MeshStandardMaterial({ color, ...extra });
      const addMesh = (name, geoms, material) => {
        if (!geoms.length) return;
        const mesh = new THREE.Mesh(merge(geoms), material);
        mesh.frustumCulled = false;
        statics[name] = mesh;
        scene.add(mesh);
      };
      addMesh('deck', parts.deck, solid(0x9a958c, { roughness: 0.9 }));
      addMesh('bed', parts.bed, solid(0x57524b, { roughness: 1 }));
      addMesh('tube', parts.tube, Object.assign(see(0x5c7391, 0.12), { side: THREE.DoubleSide }));
      addMesh('conductor', parts.conductor, solid(0x3a3d42, { roughness: 0.6 }));
      addStatic('masts', MAST, new THREE.MeshStandardMaterial({ color: 0x7d8288, metalness: 0.4, roughness: 0.6 }), masts);
      // Wires as 1-pixel lines: real ones are 12-15 mm thick, too thin to draw as solids at map scale.
      const wireGeometry = new THREE.BufferGeometry();
      const all = new Float32Array(wires.reduce((n, w) => n + w.length, 0));
      wires.reduce((o, w) => { all.set(w, o); return o + w.length; }, 0);
      wireGeometry.setAttribute('position', new THREE.BufferAttribute(all, 3));
      statics.wires = new THREE.LineSegments(wireGeometry, new THREE.LineBasicMaterial({ color: 0x2a2a2a }));
      statics.wires.frustumCulled = false;
      scene.add(statics.wires);
      map.triggerRepaint();
    },
    // Stations: scene.js stationShape objects. Call once.
    setStations(shapes) {
      const byPart = {};
      for (const shape of shapes) {
        const local = shape.sections.map(toLocal);
        for (const [part, geometry] of Object.entries(stationGeometry(local, shape))) (byPart[part] ||= []).push(geometry);
        const [x, y] = local[local.length >> 1];
        stations.push({ shape, at: new THREE.Vector4(x, y, shape.under ? 1.5 : shape.h + 3, 1) });
      }
      const STATION_MATERIALS = {
        platform: new THREE.MeshStandardMaterial({ color: 0xe4ded2, roughness: 0.8 }),
        edge: onTop(new THREE.MeshStandardMaterial({ color: 0xf0c419, roughness: 0.7 }), 1),
        glass: new THREE.MeshStandardMaterial({ color: 0x4d5e6b, metalness: 0.3, roughness: 0.2 }),
        steel: new THREE.MeshStandardMaterial({ color: 0x7d8590, metalness: 0.5, roughness: 0.5 }),
        roof: new THREE.MeshStandardMaterial({ color: 0xeceff2, metalness: 0.3, roughness: 0.4 }),
        concourse: new THREE.MeshStandardMaterial({ color: 0xd9d3c7, roughness: 0.8 }),
        window: onTop(new THREE.MeshStandardMaterial({ color: 0x2c3b48, metalness: 0.3, roughness: 0.2 }), 1),
        pier: new THREE.MeshStandardMaterial({ color: 0x9a958c, roughness: 0.9 }),
        hall: see(0xcfc6b8, 0.22),
        canopy: new THREE.MeshStandardMaterial({ color: 0xc0282c, roughness: 0.6 }),
      };
      for (const [part, geoms] of Object.entries(byPart)) {
        const mesh = new THREE.Mesh(merge(geoms), STATION_MATERIALS[part]);
        mesh.frustumCulled = false;
        statics[`station.${part}`] = mesh;
        scene.add(mesh);
      }
      map.triggerRepaint();
    },
    // The station drawn nearest the screen point (x, y) in CSS pixels, within `radius`, or null. Picked
    // from the view the map last drew, so a raised station is found where it is drawn, not under it.
    pick(x, y, radius = 30) {
      if (!lastView) return null;
      const canvas = map.getCanvas(), v = new THREE.Vector4();
      let best = null, bestD = radius;
      for (const st of stations) {
        v.copy(st.at).applyMatrix4(lastView);
        if (v.w <= 0) continue;
        const d = Math.hypot((v.x / v.w + 1) / 2 * canvas.clientWidth - x, (1 - v.y / v.w) / 2 * canvas.clientHeight - y);
        if (d < bestD) { bestD = d; best = st.shape; }
      }
      return best;
    },
    // poses from scene.js carPoses: one per car, in any order. Drawn at the next render, which
    // picks each car's detail for the camera then.
    setCars(poses) {
      placed = poses.map((p, i) => {
        const c = (pool[i] ||= { m: new THREE.Matrix4(), a: new THREE.Vector3(), b: new THREE.Vector3() });
        const flip = p.last && !p.lead;  // the last car is turned round so its cab faces backwards
        const [ra, fa, zr, zf] = flip ? [p.front, p.rear, p.zFront, p.zRear] : [p.rear, p.front, p.zRear, p.zFront];
        const la = toLocal(ra), lb = toLocal(fa);
        place(c.m, la, lb, zr + RAIL_TOP, zf + RAIL_TOP);
        c.a.set(la[0], la[1], zr + RAIL_TOP);
        c.b.set(lb[0], lb[1], zf + RAIL_TOP);
        Object.assign(c, { lead: p.lead, last: p.last, panto: !p.thirdRail && hasPantograph(p.car, p.cars), livery: livery(p.color || '#3b76c0') });
        return c;
      });
      map.triggerRepaint();
    },
  };
}
