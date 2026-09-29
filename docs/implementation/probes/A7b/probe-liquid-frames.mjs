// A7b probe (read-only): which LiquidType texture families really have frames in the client, and their size.
import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { decodeBlp } from "file:///F:/tswowRoot/WebClient/tools/blp.mjs";
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory, dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";

const archives = await clientArchives(clientDirectory());
const types = await openDbcFile(dbcDirectory(), "LiquidType");
const seen = new Map();
for (const row of types.rows()) {
  const id = types.id(row);
  const patterns = [];
  for (let i = 0; i < 6; i++) { const p = types.string(row, "Texture", i); if (p) patterns.push(p); }
  for (const pattern of patterns) {
    if (seen.has(pattern)) { seen.get(pattern).rows.push(id); continue; }
    let frames = 0, size = "";
    if (pattern.includes("%d")) {
      for (let f = 1; f <= 40; f++) {
        const path = pattern.replace("%d", String(f));
        if (!await archives.has(path)) break;
        frames++;
        if (f === 1) { const d = decodeBlp(await archives.read(path)); size = `${d.width}x${d.height}`; }
      }
    } else {
      const path = pattern.endsWith(".blp") ? pattern : `${pattern}.blp`;
      const has = await archives.has(path);
      frames = has ? 1 : 0;
      if (has) { try { const d = decodeBlp(await archives.read(path)); size = `${d.width}x${d.height}`; } catch { size = "undecodable"; } }
    }
    seen.set(pattern, { rows: [id], frames, size });
  }
}
for (const [pattern, v] of seen) console.log(`${pattern}: frames ${v.frames} ${v.size} rows ${v.rows.join(",")}`);
// Light rows 6 and 7 (slime, magma) — what colours would an underwater view in them use?
const light = await openDbcFile(dbcDirectory(), "Light");
for (const id of [6, 7]) {
  const row = light.rowOf(id);
  console.log(`Light ${id}: ${row === undefined ? "absent" : `map ${light.int(row, "ContinentID")} params ${[0, 1, 2, 3, 4].map((s) => light.int(row, "LightParamsID", s)).join(",")}`}`);
}
archives.close();
