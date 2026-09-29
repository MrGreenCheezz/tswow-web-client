// A7b probe (read-only): does AreaTable.LightID rescue the 62 maps that have no Light.dbc row?
import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";

const dir = dbcDirectory();
const [maps, areas, light, wmoAreas] = await Promise.all(["Map", "AreaTable", "Light", "WMOAreaTable"].map((t) => openDbcFile(dir, t).catch(() => undefined)));
console.log("WMOAreaTable dbd:", wmoAreas ? "opened" : "no layout");
const lightMaps = new Set(); const lightById = new Map();
for (const row of light.rows()) { lightMaps.add(light.int(row, "ContinentID")); lightById.set(light.id(row), light.int(row, "ContinentID")); }
let nonzeroLightId = 0, total = 0;
for (const row of areas.rows()) { total++; if (areas.int(row, "LightID") > 0) nonzeroLightId++; }
console.log(`AreaTable rows ${total}, with LightID>0: ${nonzeroLightId}`);
const without = [];
for (const row of maps.rows()) if (!lightMaps.has(maps.id(row))) without.push(row);
console.log(`maps without Light rows: ${without.length}`);
let helped = 0;
for (const row of without) {
  const id = maps.id(row);
  const type = maps.int(row, "InstanceType");
  const areaId = maps.int(row, "AreaTableID");
  const areaRow = areas.rowOf(areaId);
  const lightId = areaRow === undefined ? -1 : areas.int(areaRow, "LightID");
  const parent = areaRow === undefined ? -1 : areas.int(areaRow, "ParentAreaID");
  const flags = areaRow === undefined ? -1 : areas.int(areaRow, "Flags");
  const lm = lightId > 0 ? lightById.get(lightId) : undefined;
  if (lightId > 0 && lm !== undefined) helped++;
  if (type > 0 && type < 5) console.log(`  map ${id} ${maps.string(row, "Directory")} t${type}: area ${areaId} parent ${parent} flags 0x${flags.toString(16)} LightID ${lightId}${lm !== undefined ? ` (Light row on map ${lm})` : ""}`);
}
console.log(`maps whose zone row names an existing Light row: ${helped} of ${without.length}`);
archives_done();
function archives_done() {}
