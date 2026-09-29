// A7b probe (read-only): candidate rule for 1.23 evaluated over every outdoor M2 path in the cached visual tiles.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const OLD = /tree|oak|pine|willow|bush|shrub/i;
// Candidate: same stems, but on the basename, with vetoes for what is named after a tree without being one.
const STEM = /(?:tree|oak|pine|willow|bush|shrub)/;
const VETO = /(?:street|spine|smoke|stump|hut|log|branch|root|trunk|lamp|fx|rocktree|dragonspine|cones?)/;
const VETO_DIR = /(?:tradeskillnodes|skillactivated|bones|smoke|lamps?|lampposts|firefx|skeleton|treehuts|treelogs|treestumps|stumps|rocktrees)/;
function candidate(path) {
  const lower = path.toLowerCase().replaceAll("/", "\\");
  const parts = lower.split("\\");
  const base = parts.at(-1).replace(/\.m2$/, "");
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => VETO_DIR.test(d))) return false;
  if (VETO.test(base) && !/pinecones/.test(base)) return false;
  if (STEM.test(base)) return true;
  return dirs.some((d) => /(?:trees?|bushes|bush|shrubs?)$/.test(d));
}
const root = "F:/tswowRoot/WebClient/data/visual-tiles";
const counts = new Map();
for (const map of await readdir(root)) {
  const dir = join(root, map);
  if (!(await stat(dir)).isDirectory()) continue;
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".json")) continue;
    for (const o of JSON.parse(await readFile(join(dir, file), "utf8"))) {
      if (o.kind !== "m2" || o.interior) continue;
      counts.set(o.name.toLowerCase(), (counts.get(o.name.toLowerCase()) ?? 0) + 1);
    }
  }
}
let both = 0, oldOnly = 0, newOnly = 0; const A = [], B = [];
for (const [n, c] of counts) {
  const o = OLD.test(n), k = candidate(n);
  if (o && k) both += c; else if (o) { oldOnly += c; A.push([n, c]); } else if (k) { newOnly += c; B.push([n, c]); }
}
console.log(`old&new ${both}; old-only (dropped) ${oldOnly} (${A.length} names); new-only (added) ${newOnly} (${B.length} names)`);
console.log("-- dropped (old yes, candidate no): by why");
const why = new Map();
for (const [n] of A) {
  const parts = n.split("\\"); const base = parts.at(-1).replace(/\.m2$/, "");
  const key = parts.slice(0, -1).find((d) => VETO_DIR.test(d)) ? "dir:" + parts.slice(0, -1).find((d) => VETO_DIR.test(d))
    : (base.match(VETO) ?? ["?"])[0] === "?" ? "other" : "veto:" + base.match(VETO)[0];
  const e = why.get(key) ?? { names: 0, objects: 0, ex: [] }; e.names++; e.objects += counts.get(n); if (e.ex.length < 2) e.ex.push(base); why.set(key, e);
}
for (const [k, e] of [...why].sort((a, b) => b[1].objects - a[1].objects)) console.log(`  ${k}: ${e.names} names, ${e.objects} obj, e.g. ${e.ex.join(", ")}`);
console.log("-- added (candidate yes, old no):");
for (const [n, c] of B.sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${c}\t${n.split("\\").slice(-3).join("\\")}`);
console.log("-- still accepted but suspicious (contains stem inside a longer word):");
const suspicious = [];
for (const [n, c] of counts) if (candidate(n)) { const base = n.split("\\").pop(); if (/(?:street|spine|cloak|soak|alpine|ambush|bushel|pinecone|oakenshield|streets)/.test(base)) suspicious.push([base, c]); }
console.log(suspicious.length ? suspicious.map(([b, c]) => `${b} x${c}`).join(", ") : "  none");
let kept = 0, total = 0; for (const [n, c] of counts) { total += c; if (candidate(n)) kept += c; }
console.log(`candidate accepts ${kept} of ${total} outdoor m2 objects (${(100 * kept / total).toFixed(1)}%); old rule accepted ${both + oldOnly}`);
