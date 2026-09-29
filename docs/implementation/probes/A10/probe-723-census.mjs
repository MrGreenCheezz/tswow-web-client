// A10 / 7.23 (read-only): how many ADT tiles would `tools/generate-terrain-splat.mjs` refuse, per map.
// The parse below repeats `parseAdt` / `parseMapChunk` of the generator (same checks, same order):
//   MTEX names, every MCNK: column/row <= 15, layer count 1..4 (`layerCount === 0` is the stub case),
//   and at the end "no MTEX or no MCNK".
// It also records whether the failing tile is a WHOLE stub (every chunk has 0 layers) or a tile in
// which only some chunks have 0 layers — the second kind is a real, textured tile that the strict
// check throws away.
//   .runtime/node/node.exe --import ./tools/register-test-sources.mjs <this file> [map ids...]
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repo = process.cwd();
const load = (path) => import(pathToFileURL(resolve(repo, path)).href);
const { openDbcFile } = await load("tools/dbc.mjs");
const { dbcDirectory, clientDirectory } = await load("tools/paths.mjs");
const { clientArchives } = await load("tools/mpq.mjs");

const maps = await openDbcFile(dbcDirectory(), "Map");
console.log("Map.dbc fields:", maps.fieldNames.join(", "));
const wanted = new Set(process.argv.slice(2).map(Number));
const archives = await clientArchives(clientDirectory());
const tag = (data, offset) => [...data.subarray(offset, offset + 4)].reverse().map((v) => String.fromCharCode(v)).join("");

function classify(adt) {
  let textures = 0;
  const chunks = [];
  let truncated = false;
  for (let offset = 0; offset + 8 <= adt.length;) {
    const name = tag(adt, offset);
    const size = adt.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > adt.length) { truncated = true; break; }
    if (name === "MTEX") textures = adt.subarray(start, start + size).toString("latin1").split("\0").filter(Boolean).length;
    else if (name === "MCNK") {
      chunks.push({ layers: adt.readUInt32LE(start + 12), column: adt.readUInt32LE(start + 4), row: adt.readUInt32LE(start + 8) });
    }
    offset = start + size;
  }
  if (truncated) return { kind: "truncated", chunks: chunks.length, zero: 0, over: 0, textures };
  const zero = chunks.filter((c) => c.layers === 0).length;
  const over = chunks.filter((c) => c.layers > 4).length;
  const badIndex = chunks.filter((c) => c.column > 15 || c.row > 15).length;
  if (badIndex > 0 || zero > 0 || over > 0) {
    const kind = zero === chunks.length ? "stub: every chunk has 0 layers" : zero > 0 ? "partial: some chunks have 0 layers" : over > 0 ? "chunk with >4 layers" : "bad chunk index";
    return { kind, chunks: chunks.length, zero, over, textures };
  }
  if (textures === 0 || chunks.length === 0) return { kind: "no MTEX or no MCNK", chunks: chunks.length, zero, over, textures };
  return { kind: "ok", chunks: chunks.length, zero: 0, over: 0, textures };
}

const total = { ok: 0 };
const perMap = [];
const examples = new Map();
for (const row of maps.rows()) {
  const id = maps.id(row);
  if (wanted.size > 0 && !wanted.has(id)) continue;
  const directory = maps.string(row, "Directory");
  if (!directory) continue;
  const prefix = `World\\Maps\\${directory}\\`;
  let files;
  try { files = [...await archives.list(prefix)].filter((path) => /_(\d+)_(\d+)\.adt$/i.test(path) && !/_(tex|obj)\d\.adt$/i.test(path)); } catch { continue; }
  if (files.length === 0) continue;
  const stat = { id, directory, instanceType: (() => { try { return maps.int(row, "InstanceType"); } catch { return "?"; } })(), tiles: files.length, kinds: {} };
  const stubTiles = [];
  for (const path of files) {
    const adt = await archives.read(path);
    if (!adt) continue;
    const result = classify(adt);
    stat.kinds[result.kind] = (stat.kinds[result.kind] ?? 0) + 1;
    total[result.kind] = (total[result.kind] ?? 0) + 1;
    if (result.kind !== "ok") {
      const [, a, b] = /_(\d+)_(\d+)\.adt$/i.exec(path);
      // The generator names the file `<map>_<gridY>_<gridX>.adt`.
      stubTiles.push(`${b}/${a}${result.kind.startsWith("partial") ? `(${result.zero}/${result.chunks})` : ""}`);
      const list = examples.get(result.kind) ?? [];
      if (list.length < 6) list.push(`${id}:${directory} ${b}/${a} zero=${result.zero}/${result.chunks} textures=${result.textures}`);
      examples.set(result.kind, list);
    }
  }
  stat.failing = stubTiles;
  perMap.push(stat);
}
archives.close?.();
console.log(`\nmaps with ADTs: ${perMap.length}; tiles: ${perMap.reduce((n, m) => n + m.tiles, 0)}`);
console.log("totals:", JSON.stringify(total));
console.log("\nper map (only maps that have a failing tile), gridX/gridY as the URL /terrain-splat/<map>/<gridX>/<gridY> spells them:");
for (const stat of perMap.filter((m) => Object.keys(m.kinds).some((k) => k !== "ok"))) {
  console.log(`${stat.id} ${stat.directory} (InstanceType ${stat.instanceType}): ${stat.tiles} tiles; ${JSON.stringify(stat.kinds)}; failing: ${stat.failing.slice(0, 40).join(" ")}${stat.failing.length > 40 ? " …" : ""}`);
}
console.log("\nmaps whose every tile is ok:", perMap.filter((m) => Object.keys(m.kinds).every((k) => k === "ok")).length);
for (const [kind, list] of examples) console.log(`examples of "${kind}": ${list.join(" | ")}`);
