// 05.10-A7b-5 (7.04 slice 0, 7.15, 7.10): the day curve of the LightIntBand channels 8-13 and
// the LightFloatBand channels 2-5 for a few parameter sets, plus the facts the light payload v5
// leans on — slot 4 of Light.dbc, LiquidType.LightID and the darkening columns.
//
// Reads the dataset's DBC files directly (fixed WDBC layouts, see tools/dbd); no client archive.
// Usage: node docs/implementation/probes/A7b/probe-light-strips.mjs [dbcDirectory]
import { readFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2] ?? "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";

function open(name) {
  const data = readFileSync(join(directory, `${name}.dbc`));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records = view.getUint32(4, true);
  const fields = view.getUint32(8, true);
  const size = view.getUint32(12, true);
  const strings = 20 + records * size;
  const rows = new Map();
  for (let row = 0; row < records; row++) rows.set(view.getInt32(20 + row * size, true), 20 + row * size);
  return {
    records, fields, rows,
    int: (at, field) => view.getInt32(at + field * 4, true),
    float: (at, field) => view.getFloat32(at + field * 4, true),
    string: (at, field) => {
      let start = strings + view.getUint32(at + field * 4, true);
      let end = start;
      while (data[end] !== 0) end++;
      return data.subarray(start, end).toString("latin1");
    },
  };
}

const light = open("Light");
const params = open("LightParams");
const ints = open("LightIntBand");
const floats = open("LightFloatBand");
const liquid = open("LiquidType");

function sample(table, id, time, isFloat) {
  const at = table.rows.get(id);
  if (at === undefined) return undefined;
  const count = Math.min(table.int(at, 1), 16);
  if (count === 0) return undefined;
  const times = [];
  const values = [];
  for (let key = 0; key < count; key++) {
    times.push(table.int(at, 2 + key));
    values.push(isFloat ? table.float(at, 18 + key) : table.int(at, 18 + key) & 0xffffff);
  }
  let before = count - 1;
  for (let key = 0; key < count; key++) if (times[key] <= time) before = key;
  return values[before];
}

const hex = (value) => value === undefined ? "-" : `#${value.toString(16).padStart(6, "0")}`;
const TIMES = [0, 360, 720, 1080, 1440, 1800, 2160, 2520];
for (const set of [12, 3, 4, 21, 22]) {
  if (!params.rows.has(set)) continue;
  const row = params.rows.get(set);
  console.log(`set ${set}: HighlightSky=${params.int(row, 1)} LightSkyboxID=${params.int(row, 2)} CloudTypeID=${params.int(row, 3)}`);
  for (let channel = 8; channel <= 13; channel++) {
    const id = (set - 1) * 18 + 1 + channel;
    console.log(`  int ${String(channel).padStart(2)}: ${TIMES.map((time) => hex(sample(ints, id, time, false))).join(" ")}`);
  }
  for (let channel = 2; channel <= 5; channel++) {
    const id = (set - 1) * 6 + 1 + channel;
    console.log(`  flt ${channel}: ${TIMES.map((time) => (sample(floats, id, time, true) ?? NaN).toFixed(2)).join(" ")}`);
  }
}

// Slot 4: how many rows differ from slot 0, and which sets they name.
const deathSets = new Map();
let deathDiffers = 0;
for (const at of light.rows.values()) {
  const clear = light.int(at, 7);
  const death = light.int(at, 7 + 4);
  if (death !== clear) deathDiffers++;
  deathSets.set(death, (deathSets.get(death) ?? 0) + 1);
}
console.log(`Light rows ${light.records}; slot 4 differs from slot 0 on ${deathDiffers}; sets ${[...deathSets].sort((a, b) => b[1] - a[1]).map(([set, count]) => `${set}x${count}`).join(" ")}`);
for (const set of deathSets.keys()) {
  const row = params.rows.get(set);
  if (row !== undefined) console.log(`  death set ${set}: LightSkyboxID=${params.int(row, 2)} Glow=${params.float(row, 4).toFixed(2)}`);
}

// LiquidType: the light row and the darkening columns.
for (const at of liquid.rows.values()) {
  const id = liquid.int(at, 0);
  const lightId = liquid.int(at, 10);
  const depth = liquid.float(at, 6);
  console.log(`liquid ${String(id).padStart(3)} ${liquid.string(at, 1).padEnd(28)} bank=${liquid.int(at, 3)} light=${lightId} material=${liquid.int(at, 14)} darken=${depth}/${liquid.float(at, 7)}/${liquid.float(at, 8)}/${liquid.float(at, 9)} tex0=${liquid.string(at, 15)}`);
}
for (const id of [6, 7]) {
  const at = light.rows.get(id);
  if (at === undefined) continue;
  console.log(`Light ${id}: map ${light.int(at, 1)} slots ${[0, 1, 2, 3, 4, 5, 6, 7].map((slot) => light.int(at, 7 + slot)).join(",")}`);
}
