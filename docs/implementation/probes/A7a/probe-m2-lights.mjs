// A7a: how many M2 models carry a lights block? Reads whole files (MPQ has no partial read) within a time budget.
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
const budgetMs = Number(process.argv[2] ?? 90000);
const archives = await clientArchives(clientDirectory());
const roots = ["World\\", "Spells\\", "Creature\\", "Item\\", "Dungeons\\", "Character\\", "Environments\\", "Particles\\"];
const all = [];
for (const root of roots) for (const p of await archives.list(root)) if (/\.m2$|\.mdx$/i.test(p)) all.push(p);
console.log("m2 listed:", all.length, "budget ms", budgetMs);
// deterministic shuffle
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
const start = Date.now();
const stats = new Map();
const withLights = [];
let done = 0, failed = 0;
for (const path of all) {
  if (Date.now() - start > budgetMs) break;
  const top = path.split("\\")[0];
  const s = stats.get(top) ?? { n: 0, lights: 0 }; stats.set(top, s);
  try {
    const data = await archives.read(path);
    if (!data || data.byteLength < 0x130 || data.toString("latin1", 0, 4) !== "MD20") { failed++; continue; }
    s.n++; done++;
    const count = data.readUInt32LE(0x108);
    if (count > 0 && count < 64 && data.readUInt32LE(0x10c) < data.byteLength) { s.lights++; if (withLights.length < 40) withLights.push(`${path}:${count}`); }
  } catch { failed++; }
}
console.log(`read ${done} (failed ${failed}) in ${Date.now() - start} ms`);
for (const [top, s] of stats) console.log(`  ${top}: sampled ${s.n}, with lights ${s.lights}`);
console.log("examples:", withLights.join(" | "));
archives.close?.();
