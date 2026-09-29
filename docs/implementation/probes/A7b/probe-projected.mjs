// A7b probe (read-only): would adding set 0 to every WMO placement push a cached visual tile over the 10,000 cap?
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const tilesRoot = "F:/tswowRoot/WebClient/data/visual-tiles";
const doodadRoot = "F:/tswowRoot/WebClient/data/visual-wmo-doodads";
const cache = new Map();
async function sets(name) {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const hash = createHash("sha1").update(`wmo-doodad-light-v1\0${key}`).digest("hex");
  let value;
  try { value = JSON.parse(await readFile(join(doodadRoot, `${hash}.json`), "utf8")).sets ?? []; } catch { value = undefined; }
  cache.set(key, value);
  return value;
}
const rows = [];
let missingCache = 0;
for (const map of await readdir(tilesRoot)) {
  const dir = join(tilesRoot, map);
  if (!(await stat(dir)).isDirectory()) continue;
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".json")) continue;
    const objects = JSON.parse(await readFile(join(dir, file), "utf8"));
    let added = 0, placementsWithSet = 0;
    for (const o of objects) {
      if (o.kind !== "wmo" || !(o.doodadSet > 0)) continue;
      const s = await sets(o.name);
      if (!s) { missingCache++; continue; }
      placementsWithSet++;
      added += s[0]?.length ?? 0;
    }
    rows.push({ key: `${map}/${file.replace(".json", "")}`, total: objects.length, added, projected: objects.length + added, placementsWithSet });
  }
}
rows.sort((a, b) => b.projected - a.projected);
console.log(`tiles ${rows.length}; placements without a doodad cache entry: ${missingCache}`);
for (const r of rows.slice(0, 8)) console.log(JSON.stringify(r));
console.log(`tiles that would reach >= 10000: ${rows.filter((r) => r.projected >= 10000).map((r) => r.key).join(", ") || "none"}`);
console.log(`tiles gaining >= 200 objects: ${rows.filter((r) => r.added >= 200).length}; total objects added over all tiles: ${rows.reduce((s, r) => s + r.added, 0)}`);
