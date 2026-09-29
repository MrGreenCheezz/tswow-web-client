// Read-only census of the dataset's AreaTrigger.dbc (TC layout "niffffffff": ID, ContinentID, X, Y, Z, Radius, BoxLength, BoxWidth, BoxHeight, BoxYaw).
import { readFileSync } from "node:fs";

const DIR = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const b = readFileSync(`${DIR}/AreaTrigger.dbc`);
const magic = b.toString("latin1", 0, 4);
const count = b.readUInt32LE(4);
const fields = b.readUInt32LE(8);
const size = b.readUInt32LE(12);
const strs = b.readUInt32LE(16);
console.log({ magic, count, fields, size, strs, bytes: b.length });

const rows = [];
for (let i = 0; i < count; i++) {
  const at = 20 + i * size;
  rows.push({
    id: b.readUInt32LE(at),
    map: b.readUInt32LE(at + 4),
    x: b.readFloatLE(at + 8),
    y: b.readFloatLE(at + 12),
    z: b.readFloatLE(at + 16),
    radius: b.readFloatLE(at + 20),
    length: b.readFloatLE(at + 24),
    width: b.readFloatLE(at + 28),
    height: b.readFloatLE(at + 32),
    yaw: b.readFloatLE(at + 36),
  });
}

const sphere = rows.filter((r) => r.radius > 0);
const box = rows.filter((r) => !(r.radius > 0));
const boxZeroSized = box.filter((r) => !(r.length > 0 || r.width > 0 || r.height > 0));
console.log(`records=${rows.length} sphere(radius>0)=${sphere.length} box(radius<=0)=${box.length} boxAllZeroDims=${boxZeroSized.length}`);
const stat = (arr, f) => {
  if (arr.length === 0) return "n/a";
  const v = arr.map(f).sort((p, q) => p - q);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return `min=${v[0].toFixed(2)} p50=${q(0.5).toFixed(2)} p90=${q(0.9).toFixed(2)} max=${v[v.length - 1].toFixed(2)}`;
};
console.log(`sphere radius: ${stat(sphere, (r) => r.radius)}`);
console.log(`box length:    ${stat(box, (r) => r.length)}`);
console.log(`box width:     ${stat(box, (r) => r.width)}`);
console.log(`box height:    ${stat(box, (r) => r.height)}`);
console.log(`box yaw!=0:    ${box.filter((r) => Math.abs(r.yaw) > 1e-6).length} of ${box.length}; yaw range ${stat(box, (r) => r.yaw)}`);
console.log(`sphere with nonzero box fields: ${sphere.filter((r) => r.length || r.width || r.height || r.yaw).length}`);
console.log(`box with nonzero radius (=0): 0; boxes with radius < 0: ${box.filter((r) => r.radius < 0).length}`);
console.log(`NaN/inf rows: ${rows.filter((r) => Object.values(r).some((v) => typeof v === "number" && !Number.isFinite(v))).length}`);

// per map
const perMap = new Map();
for (const r of rows) {
  const e = perMap.get(r.map) ?? { sphere: 0, box: 0 };
  if (r.radius > 0) e.sphere++; else e.box++;
  perMap.set(r.map, e);
}
const mapsSorted = [...perMap].sort((p, q) => q[1].sphere + q[1].box - (p[1].sphere + p[1].box));
console.log(`distinct maps=${perMap.size}`);
console.log("top maps: " + mapsSorted.slice(0, 20).map(([m, e]) => `${m}:${e.sphere}s/${e.box}b`).join(" "));

// Ids unique?
const ids = new Set(rows.map((r) => r.id));
console.log(`unique ids=${ids.size} minId=${Math.min(...ids)} maxId=${Math.max(...ids)}`);

// Bounding sizes: how many big triggers (potential for per-step cost) and the largest extent
const extent = (r) => (r.radius > 0 ? r.radius : Math.hypot(r.length / 2, r.width / 2));
const big = rows.filter((r) => extent(r) > 50);
console.log(`triggers with horizontal extent > 50: ${big.length}; max extent ${Math.max(...rows.map(extent)).toFixed(1)}`);
console.log(`triggers with extent < 3 (small, tunnelling risk at 14 y/s): ${rows.filter((r) => extent(r) < 3).length}`);
console.log(`box height < 2: ${box.filter((r) => r.height < 2).length}`);

// Some well-known ids
const show = (id) => { const r = rows.find((x) => x.id === id); return r ? JSON.stringify(r) : `#${id} missing`; };
for (const id of [2166, 2171, 2173, 2175, 78, 45, 2214, 2216, 3187, 3646, 4871, 5030, 5073, 5077, 4406]) console.log(show(id));
// Maps holding triggers grouped by continent (0,1,530,571) vs instances
const cont = new Set([0, 1, 530, 571]);
console.log(`on continents: ${rows.filter((r) => cont.has(r.map)).length}; on other maps: ${rows.filter((r) => !cont.has(r.map)).length}`);
// Height of boxes on continents vs total
console.log(`spheres per map class: cont=${sphere.filter((r) => cont.has(r.map)).length} other=${sphere.filter((r) => !cont.has(r.map)).length}; boxes: cont=${box.filter((r) => cont.has(r.map)).length} other=${box.filter((r) => !cont.has(r.map)).length}`);
