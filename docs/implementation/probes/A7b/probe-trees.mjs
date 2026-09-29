// A7b probe (read-only): what the tree stand-in regex catches over the cached visual tiles, by full path.
// The renderer tests `object.name` (the full archive path), not the basename.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = "F:/tswowRoot/WebClient/data/visual-tiles";
const regex = /tree|oak|pine|willow|bush|shrub/i;
const byDir = new Map();       // dir -> {objects, names:Set}
const nameCount = new Map();   // full path lower -> objects
let objectsTotal = 0;
for (const map of await readdir(root)) {
  const dir = join(root, map);
  if (!(await stat(dir)).isDirectory()) continue;
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".json")) continue;
    for (const o of JSON.parse(await readFile(join(dir, file), "utf8"))) {
      if (o.kind !== "m2" || o.interior) continue;
      objectsTotal++;
      const path = o.name.toLowerCase();
      nameCount.set(path, (nameCount.get(path) ?? 0) + 1);
    }
  }
}
const parts = (p) => p.split("\\");
let regexObjects = 0, regexNames = 0;
const rows = [];
for (const [path, count] of nameCount) {
  if (!regex.test(path)) continue;
  regexObjects += count; regexNames++;
  const p = parts(path);
  const dir = p.slice(0, -1).join("\\");
  const entry = byDir.get(dir) ?? { objects: 0, names: new Set() };
  entry.objects += count; entry.names.add(p.at(-1));
  byDir.set(dir, entry);
}
console.log(`outdoor m2 objects ${objectsTotal}, distinct paths ${nameCount.size}; regex: ${regexObjects} objects, ${regexNames} paths`);
// Which last-two directory names do the matches live in?
const tail = new Map();
for (const [dir, e] of byDir) {
  const key = parts(dir).slice(-1)[0];
  const t = tail.get(key) ?? { objects: 0, names: 0, dirs: 0 };
  t.objects += e.objects; t.names += e.names.size; t.dirs++;
  tail.set(key, t);
}
console.log("-- matched paths by leaf directory name (objects, distinct names, dirs)");
for (const [k, v] of [...tail].sort((a, b) => b[1].objects - a[1].objects).slice(0, 45)) console.log(`  ${k}: ${v.objects} obj, ${v.names} names, ${v.dirs} dirs`);
// Directory rule: any path segment that is a vegetation directory.
const dirRule = /\\(trees?|bushes|bush|shrubs?|foliage|plants?|flowers?|vegetation)\\/i;
let both = 0, onlyRegex = 0, onlyDir = 0; const onlyRegexNames = new Map(), onlyDirNames = new Map();
for (const [path, count] of nameCount) {
  const r = regex.test(path), d = dirRule.test(path);
  if (r && d) both += count;
  else if (r) { onlyRegex += count; onlyRegexNames.set(path, count); }
  else if (d) { onlyDir += count; onlyDirNames.set(path, count); }
}
console.log(`-- regex & dirRule ${both}; regex only ${onlyRegex} (${onlyRegexNames.size} names); dirRule only ${onlyDir} (${onlyDirNames.size} names)`);
console.log("-- regex only, top 40 by objects");
for (const [n, c] of [...onlyRegexNames].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${c}\t${n}`);
console.log("-- dirRule only, top 15");
for (const [n, c] of [...onlyDirNames].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${c}\t${n}`);
