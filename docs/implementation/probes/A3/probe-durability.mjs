// Read-only census of DurabilityCosts.dbc / DurabilityQuality.dbc (TC layouts "niii..." (30 fields) and "nf").
import { readFileSync } from "node:fs";
const DIR = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
function open(name) {
  const b = readFileSync(`${DIR}/${name}.dbc`);
  const count = b.readUInt32LE(4), fields = b.readUInt32LE(8), size = b.readUInt32LE(12), strs = b.readUInt32LE(16);
  return { b, count, fields, size, strs, int: (r, f) => b.readUInt32LE(20 + r * size + f * 4), float: (r, f) => b.readFloatLE(20 + r * size + f * 4) };
}
const costs = open("DurabilityCosts");
const quality = open("DurabilityQuality");
console.log("DurabilityCosts", { records: costs.count, fields: costs.fields, recordSize: costs.size, strings: costs.strs, bytes: costs.b.length });
console.log("DurabilityQuality", { records: quality.count, fields: quality.fields, recordSize: quality.size, strings: quality.strs, bytes: quality.b.length });
const ids = [];
for (let r = 0; r < costs.count; r++) ids.push(costs.int(r, 0));
console.log(`costs ids: min=${Math.min(...ids)} max=${Math.max(...ids)} distinct=${new Set(ids).size}`);
for (let r = 0; r < quality.count; r++) console.log(`quality id=${quality.int(r, 0)} data=${quality.float(r, 1)}`);
const byId = new Map(); for (let r = 0; r < costs.count; r++) byId.set(costs.int(r, 0), r);
const row = (ilvl) => { const r = byId.get(ilvl); if (r === undefined) return undefined; return { weapon: [...Array(21).keys()].map((i) => costs.int(r, 1 + i)), armor: [...Array(8).keys()].map((i) => costs.int(r, 22 + i)) }; };
for (const ilvl of [1, 60, 100, 200, 264, 284]) console.log(`ilvl ${ilvl}:`, JSON.stringify(row(ilvl)));
// worked examples of Item::CalculateDurabilityRepairCost with discount 1 and RATE_REPAIRCOST 1
const q = new Map(); for (let r = 0; r < quality.count; r++) q.set(quality.int(r, 0), quality.float(r, 1));
function cost(lost, ilvl, quality4, klass, sub, discount = 1) {
  const r = byId.get(ilvl); if (r === undefined) return "no-row";
  const data = q.get((quality4 + 1) * 2); if (data === undefined) return "no-quality";
  const mult = klass === 2 ? costs.int(r, 1 + sub) : klass === 4 ? costs.int(r, 22 + sub) : 0;
  let c = Math.round(lost * mult * data); c = Math.trunc(c * discount); if (c === 0) c = 1; return { mult, data, cost: c };
}
console.log("example plate epic ilvl 200 lost 100:", JSON.stringify(cost(100, 200, 4, 4, 4)));
console.log("example 1H sword rare ilvl 60 lost 50:", JSON.stringify(cost(50, 60, 3, 2, 7)));
console.log("example cloth common ilvl 1 lost 1:", JSON.stringify(cost(1, 1, 1, 4, 1)));
console.log("discount honored 0.9 on the epic plate example:", JSON.stringify(cost(100, 200, 4, 4, 4, 0.9)));
