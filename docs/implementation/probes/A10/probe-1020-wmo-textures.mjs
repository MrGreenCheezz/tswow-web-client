// A10 / 10.20 (read-only): how much of the per-WMO texture encoding is repetition.
// `tools/generate-visual-model.mjs` (WMO branch) calls `writeBlpAsPng` for every texture of every
// WMO into `<hash>-<index>.png`; `/texture` publishes the same BLP as `data/textures/<id>.png` with
// the same `blpToPng`. If one BLP is used by many WMOs the encode is repeated for each.
// Counts, over the root .wmo files of the client: references (MOTX strings per file) and distinct
// paths; plus what the published caches hold now.
import { readdir, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

const repo = process.cwd();
const load = (path) => import(pathToFileURL(resolve(repo, path)).href);
const { clientDirectory } = await load("tools/paths.mjs");
const { clientArchives } = await load("tools/mpq.mjs");
const archives = await clientArchives(clientDirectory());
const tag = (data, offset) => [...data.subarray(offset, offset + 4)].reverse().map((v) => String.fromCharCode(v)).join("");

const roots = [...await archives.list("World\\")].filter((path) => /\.wmo$/i.test(path) && !/_\d{3}\.wmo$/i.test(path));
console.log(`root WMO files: ${roots.length}`);
const uses = new Map();
let references = 0;
let filesWithTextures = 0;
const perFile = [];
for (const path of roots) {
  const data = await archives.read(path);
  if (!data) continue;
  let names = [];
  for (let offset = 0; offset + 8 <= data.length;) {
    const size = data.readUInt32LE(offset + 4);
    if (tag(data, offset) === "MOTX") {
      names = data.subarray(offset + 8, offset + 8 + size).toString("latin1").split("\0").filter((name) => /\.blp$/i.test(name));
      break;
    }
    offset += 8 + size;
  }
  if (names.length === 0) continue;
  filesWithTextures++;
  const unique = new Set(names.map((name) => name.toLowerCase()));
  references += unique.size;
  perFile.push([path, unique.size]);
  for (const name of unique) uses.set(name, (uses.get(name) ?? 0) + 1);
}
const distinct = uses.size;
console.log(`WMO roots with textures: ${filesWithTextures}; texture references (distinct per file): ${references}; distinct texture paths: ${distinct}; average reuse ${(references / distinct).toFixed(2)}x`);
const reused = [...uses.values()].filter((n) => n > 1).length;
console.log(`paths used by more than one WMO: ${reused} (${(100 * reused / distinct).toFixed(1)} %), covering ${[...uses.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0)} of the ${references} references`);
console.log("most reused:", [...uses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => `${name.split("\\").pop()}×${n}`).join(" "));
for (const [needle, label] of [["gundrak", "Gundrak"], ["stormwind", "Stormwind"], ["dalaran", "Dalaran"], ["ironforge", "Ironforge"]]) {
  const matching = perFile.filter(([path]) => path.toLowerCase().includes(needle));
  console.log(`${label}: ${matching.length} root WMOs, ${matching.reduce((n, [, u]) => n + u, 0)} texture references`);
}
archives.close?.();

// What is published now.
const visualModels = resolve(repo, "data/visual-models");
const pngs = (await readdir(visualModels).catch(() => [])).filter((name) => /-\d+\.png$/.test(name));
let bytes = 0;
for (const name of pngs) bytes += (await stat(join(visualModels, name))).size;
const textures = (await readdir(resolve(repo, "data/textures")).catch(() => [])).filter((name) => name.endsWith(".png"));
let textureBytes = 0;
for (const name of textures.slice(0, 5000)) textureBytes += (await stat(join(resolve(repo, "data/textures"), name))).size;
console.log(`published now: ${pngs.length} per-WMO PNGs in data/visual-models (${(bytes / 1048576).toFixed(1)} MB); ${textures.length} shared PNGs in data/textures (${(textureBytes / 1048576).toFixed(1)} MB for the first ${Math.min(5000, textures.length)})`);
