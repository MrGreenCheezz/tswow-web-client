// A9 (read-only): the client's own cursor art, and the shape of the transport / vehicle DBCs.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";

const archives = await clientArchives(clientDirectory());
const cursors = [...await archives.list("Interface\\Cursor\\")].sort();
console.log(`Interface\\Cursor\\ entries: ${cursors.length}`);
for (const path of cursors) console.log(`  ${path}`);
const vehicles = [...await archives.list("Interface\\Vehicles\\")].sort();
console.log(`Interface\\Vehicles\\ entries: ${vehicles.length}`);
for (const path of vehicles.slice(0, 40)) console.log(`  ${path}`);
archives.close();

const DIR = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
function open(table) {
  const file = join(DIR, `${table}.dbc`);
  if (!existsSync(file)) return undefined;
  const data = readFileSync(file);
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const int = (row, col) => data.readInt32LE(20 + row * recordSize + col * 4);
  const float = (row, col) => data.readFloatLE(20 + row * recordSize + col * 4);
  return { table, records, fields, recordSize, int, float };
}
for (const table of ["TransportAnimation", "TransportRotation", "TaxiPathNode", "TaxiPath", "Vehicle", "VehicleSeat",
  "VehicleUIIndicator", "VehicleUIIndSeat"]) {
  const dbc = open(table);
  console.log(dbc ? `${table}: records=${dbc.records} fields=${dbc.fields} recordSize=${dbc.recordSize}` : `${table}: MISSING`);
}
const anim = open("TransportAnimation");
if (anim) {
  const entries = new Map();
  for (let row = 0; row < anim.records; row++) {
    const entry = anim.int(row, 1);
    const entryRows = entries.get(entry) ?? [];
    entryRows.push({ time: anim.int(row, 2), x: anim.float(row, 3), y: anim.float(row, 4), z: anim.float(row, 5) });
    entries.set(entry, entryRows);
  }
  console.log(`TransportAnimation distinct TransportID: ${entries.size}`);
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  console.log(`  ids: ${sorted.map(([id, rows]) => `${id}(${rows.length})`).join(" ")}`);
}
const node = open("TaxiPathNode");
if (node) {
  const paths = new Map();
  for (let row = 0; row < node.records; row++) {
    const pathId = node.int(row, 1);
    const continent = node.int(row, 3);
    const flags = node.int(row, 7);
    const item = paths.get(pathId) ?? { nodes: 0, continents: new Set(), flags: new Set() };
    item.nodes++;
    item.continents.add(continent);
    item.flags.add(flags);
    paths.set(pathId, item);
  }
  console.log(`TaxiPathNode rows=${node.records} distinct paths=${paths.size}`);
  const multi = [...paths].filter(([, item]) => item.continents.size > 1);
  console.log(`  paths crossing continents: ${multi.length} -> ${multi.slice(0, 20).map(([id, item]) => `${id}[${[...item.continents]}]`).join(" ")}`);
  const maxId = Math.max(...paths.keys());
  console.log(`  path id range: ${Math.min(...paths.keys())}..${maxId}`);
}
