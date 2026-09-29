// A7a: M2 sequence variations (idle fidgets) and sheath attachment points 26..33. Read-only census.
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
import { ANIMATION_NAMES } from "file:///F:/tswowRoot/WebClient/src/generated/client-data/animations.ts";
const archives = await clientArchives(clientDirectory());
const rd = (b, o) => b.readUInt32LE(o);
function sequences(b) {
  const n = rd(b, 0x1c), o = rd(b, 0x20); const out = [];
  for (let i = 0; i < n; i++) {
    const at = o + i * 64;
    out.push({ i, id: b.readUInt16LE(at), variation: b.readUInt16LE(at + 2), duration: rd(b, at + 4), flags: rd(b, at + 12), frequency: b.readInt16LE(at + 16),
      replayMin: rd(b, at + 20), replayMax: rd(b, at + 24), blend: rd(b, at + 28), next: b.readInt16LE(at + 0x3c), alias: b.readUInt16LE(at + 0x3e) });
  }
  return out;
}
function attachments(b) {
  const n = rd(b, 0xf0), o = rd(b, 0xf4); const out = [];
  for (let i = 0; i < n && n < 256; i++) { const at = o + i * 40; out.push({ id: rd(b, at), bone: b.readUInt16LE(at + 4), pos: [b.readFloatLE(at + 8), b.readFloatLE(at + 12), b.readFloatLE(at + 16)] }); }
  return out;
}
for (const path of ["Character/Human/Male/HumanMale.m2", "Character/Orc/Male/OrcMale.m2", "Character/Tauren/Male/TaurenMale.m2", "Character/Gnome/Female/GnomeFemale.m2"].map((p) => p.replaceAll("/", "\\"))) {
  const b = await archives.read(path);
  if (!b) { console.log(path, "missing"); continue; }
  const seq = sequences(b);
  const byId = new Map();
  for (const s of seq) { const e = byId.get(s.id) ?? []; e.push(s); byId.set(s.id, e); }
  const multi = [...byId.entries()].filter(([, v]) => v.length > 1).map(([id, v]) => `${id}:${ANIMATION_NAMES?.[id] ?? "?"}x${v.length}[freq ${v.map((s) => s.frequency).join("/")}; replay ${v.map((s) => `${s.replayMin}-${s.replayMax}`).join("/")}; next ${v.map((s) => s.next).join("/")}]`);
  console.log(`${path}: sequences=${seq.length}, ids with variations=${multi.length}`);
  console.log("   ", multi.slice(0, 12).join(" ; "));
  const at = attachments(b).filter((a) => a.id >= 26 && a.id <= 39);
  console.log("    attachments 26..39:", at.map((a) => `${a.id}@bone${a.bone}(${a.pos.map((v) => v.toFixed(2)).join(",")})`).join(" "));
}
if (process.argv[2] === "skip") { archives.close?.(); process.exit(0); }
let models = 0, withVar = 0, varRows = 0; const idHist = new Map();
for (const root of ["Creature\\", "Character\\"]) for (const p of await archives.list(root)) {
  if (!/\.m2$/i.test(p)) continue;
  const b = await archives.read(p); if (!b || b.byteLength < 0x100 || b.toString("latin1", 0, 4) !== "MD20") continue;
  models++;
  const seq = sequences(b); let any = false;
  for (const s of seq) if (s.variation !== 0) { any = true; varRows++; idHist.set(s.id, (idHist.get(s.id) ?? 0) + 1); }
  if (any) withVar++;
}
console.log(`creature+character models=${models}, with variation rows=${withVar}, variation rows=${varRows}`);
console.log("top variation animation ids:", [...idHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, n]) => `${id}:${ANIMATION_NAMES?.[id] ?? "?"}x${n}`).join(" "));
archives.close?.();
