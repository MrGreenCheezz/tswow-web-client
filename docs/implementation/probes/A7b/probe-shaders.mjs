// A7b probe (read-only): the client's own shader effect files (terrain repeat, liquid, sky).
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
const archives = await clientArchives(clientDirectory());
const list = [...await archives.list("Shaders\\")].sort();
console.log(`Shaders\\ entries: ${list.length}`);
const names = new Set(list.map((p) => p.split("\\").slice(0, 3).join("\\")));
console.log([...names].join("\n"));
for (const p of list) if (/effects\\[^\\]*\.wfx$/i.test(p)) console.log("WFX " + p);
for (const p of list) if (/(terrain|liquid|water|sky|cloud|celest|mapchunk)/i.test(p)) console.log("MATCH " + p);
for (const p of ["Shaders\\Effects\\Terrain.wfx", "Shaders\\Effects\\Sky.wfx", "Shaders\\Effects\\Liquid.wfx"]) {
  const d = await archives.read(p);
  console.log(`== ${p}: ${d ? d.length + " bytes" : "absent"}`);
  if (d) console.log(d.toString("latin1").slice(0, 1500));
}
archives.close();
