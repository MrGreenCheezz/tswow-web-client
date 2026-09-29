// Outliers and orientation facts for AreaTrigger.dbc; compares the built dbc/ with dbc_source/.
import { readFileSync, existsSync } from "node:fs";

const BASE = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset";
function load(path) {
  const b = readFileSync(path);
  const count = b.readUInt32LE(4);
  const size = b.readUInt32LE(12);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const at = 20 + i * size;
    rows.push({
      id: b.readUInt32LE(at), map: b.readUInt32LE(at + 4),
      x: b.readFloatLE(at + 8), y: b.readFloatLE(at + 12), z: b.readFloatLE(at + 16),
      radius: b.readFloatLE(at + 20), length: b.readFloatLE(at + 24), width: b.readFloatLE(at + 28), height: b.readFloatLE(at + 32), yaw: b.readFloatLE(at + 36),
    });
  }
  return { b, rows };
}
const built = load(`${BASE}/dbc/AreaTrigger.dbc`);
const srcPath = `${BASE}/dbc_source/AreaTrigger.dbc`;
if (existsSync(srcPath)) {
  const src = load(srcPath);
  console.log(`dbc_source records=${src.rows.length}; identical bytes=${Buffer.compare(src.b, built.b) === 0}`);
} else console.log("no dbc_source/AreaTrigger.dbc");

const rows = built.rows;
const TWO_PI = Math.PI * 2;
console.log("yaw outside [0,2pi]:");
for (const r of rows.filter((q) => q.radius <= 0 && (q.yaw < -1e-6 || q.yaw > TWO_PI + 1e-6))) console.log("  ", JSON.stringify(r));
console.log("width > 300 or length > 300:");
for (const r of rows.filter((q) => q.radius <= 0 && (q.width > 300 || q.length > 300))) console.log("  ", JSON.stringify(r));
console.log("radius >= 100:");
for (const r of rows.filter((q) => q.radius >= 100)) console.log("  ", JSON.stringify(r));
console.log("zero-dim boxes:");
for (const r of rows.filter((q) => q.radius <= 0 && !(q.length > 0 || q.width > 0 || q.height > 0))) console.log("  ", JSON.stringify(r));
// how many boxes have a dimension of zero but not all (degenerate)
console.log("box with some zero dim (not all):", rows.filter((q) => q.radius <= 0 && (q.length === 0 || q.width === 0 || q.height === 0) && (q.length > 0 || q.width > 0 || q.height > 0)).length);
// spheres w/ radius tiny
console.log("spheres radius<2:", rows.filter((q) => q.radius > 0 && q.radius < 2).length);
// Yaw histogram of boxes (radians, buckets of pi/4)
const hist = new Array(8).fill(0);
for (const r of rows.filter((q) => q.radius <= 0 && q.yaw >= 0 && q.yaw <= TWO_PI)) hist[Math.min(7, Math.floor(r.yaw / (Math.PI / 4)))]++;
console.log("box yaw histogram (pi/4 buckets):", hist.join(","));
// Dungeon entrances: known maps with spheres/boxes vs instance maps -> print counts for instance-only maps
const cont = new Set([0, 1, 530, 571]);
const inst = new Map();
for (const r of rows) if (!cont.has(r.map)) inst.set(r.map, (inst.get(r.map) ?? 0) + 1);
console.log("instance-map trigger counts:", [...inst].sort((a, b) => a[0] - b[0]).map(([m, n]) => `${m}:${n}`).join(" "));
// Max triggers per single map (per-step cost)
const perMap = new Map();
for (const r of rows) perMap.set(r.map, (perMap.get(r.map) ?? 0) + 1);
console.log("max triggers on one map:", Math.max(...perMap.values()));
