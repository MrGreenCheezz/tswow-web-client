// A7b probe (read-only): MCSH (baked terrain shadow) — how many chunks carry it, how dark, and what MCLY/MCNK flags say.
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";

const archives = await clientArchives(clientDirectory());
const tag = (d, o) => String.fromCharCode(d[o + 3], d[o + 2], d[o + 1], d[o]);
for (const directory of ["Azeroth", "Kalimdor", "Expansion01", "Northrend"]) {
  const all = [...await archives.list(`World\\Maps\\${directory}\\`)].filter((p) => /_\d+_\d+\.adt$/i.test(p));
  const sample = all.filter((_, i) => i % Math.max(1, Math.floor(all.length / 12)) === 0).slice(0, 12);
  let chunks = 0, flagged = 0, present = 0, shadowedBits = 0, totalBits = 0, sizes = new Map(), litChunks = 0, fullyShadowed = 0;
  for (const path of sample) {
    const data = await archives.read(path); if (!data) continue;
    for (let o = 0; o + 8 <= data.length;) {
      const size = data.readUInt32LE(o + 4);
      if (tag(data, o) === "MCNK") {
        chunks++;
        const start = o + 8;
        const flags = data.readUInt32LE(start);
        if (flags & 0x1) flagged++;
        const ofsShadow = data.readUInt32LE(start + 0x2C), sizeShadow = data.readUInt32LE(start + 0x30);
        sizes.set(sizeShadow, (sizes.get(sizeShadow) ?? 0) + 1);
        const at = o + ofsShadow;
        if (ofsShadow && at + 8 + 512 <= data.length && tag(data, at) === "MCSH") {
          present++;
          let bits = 0;
          for (let i = 0; i < 512; i++) { let b = data[at + 8 + i]; while (b) { bits += b & 1; b >>= 1; } }
          shadowedBits += bits; totalBits += 4096;
          if (bits === 0) litChunks++;
          if (bits === 4096) fullyShadowed++;
        }
      }
      o += 8 + size;
    }
  }
  console.log(`${directory}: ${sample.length} ADT sampled of ${all.length}; MCNK ${chunks}; flag 0x1 on ${flagged}; MCSH read ${present}; sizeShadow ${[...sizes].map(([k, v]) => `${k}:${v}`).join(",")}; shadowed area ${(100 * shadowedBits / Math.max(1, totalBits)).toFixed(1)}%; chunks with no shadow bit ${litChunks}, fully shadowed ${fullyShadowed}`);
}
archives.close();
