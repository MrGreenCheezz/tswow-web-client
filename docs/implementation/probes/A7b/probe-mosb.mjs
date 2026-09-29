// A7b probe (read-only): which MOGP flag marks the groups of a WMO that show its MOSB skybox?
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { clientDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";

const archives = await clientArchives(clientDirectory());
const chunkMap = (data) => {
  const map = new Map();
  for (let o = 0; o + 8 <= data.length;) {
    const tag = [...data.subarray(o, o + 4)].reverse().map((v) => String.fromCharCode(v)).join("");
    const size = data.readUInt32LE(o + 4);
    if (o + 8 + size > data.length) break;
    if (!map.has(tag)) map.set(tag, data.subarray(o + 8, o + 8 + size));
    o += 8 + size;
  }
  return map;
};
const roots = [...await archives.list("World\\wmo\\")].filter((p) => /\.wmo$/i.test(p) && !/_\d{3}\.wmo$/i.test(p));
let scanned = 0; const flagHistogram = new Map(); const sky = [];
for (const path of roots) {
  const root = await archives.read(path); if (!root) continue;
  const chunks = chunkMap(root); scanned++;
  const mosb = chunks.get("MOSB");
  const skyName = mosb && mosb.length > 1 ? mosb.toString("latin1").split("\0")[0] : "";
  if (!skyName || !/\.(mdx|m2)$/i.test(skyName)) continue;
  const mohd = chunks.get("MOHD");
  const groups = mohd.readUInt32LE(4);
  const base = path.replace(/\.wmo$/i, "");
  let with40000 = 0, total = 0, outdoor = 0; const hits = [];
  for (let g = 0; g < groups; g++) {
    const data = await archives.read(`${base}_${String(g).padStart(3, "0")}.wmo`); if (!data) continue;
    const mogp = chunkMap(data).get("MOGP"); if (!mogp) continue;
    const flags = mogp.readUInt32LE(8); total++;
    if (flags & 0x40000) { with40000++; hits.push(g); }
    if (flags & 0x8) outdoor++;
    for (let bit = 0; bit < 32; bit++) if (flags & (1 << bit)) flagHistogram.set(bit, (flagHistogram.get(bit) ?? 0) + 1);
  }
  sky.push(`${path.split("\\").slice(-2).join("\\")}: MOSB "${skyName.replace(/^.*\\DATA\\/i, "")}" groups ${total}, flag 0x40000 on ${with40000} [${hits.slice(0, 8).join(",")}], outdoor(0x8) on ${outdoor}, MOHD.wmoID ${mohd.readUInt32LE(32)}`);
}
console.log(`roots scanned ${scanned}`);
for (const line of sky) console.log(line);
console.log("flag bit histogram over groups of those roots:", [...flagHistogram].sort((a, b) => a[0] - b[0]).map(([b, c]) => `0x${(1 << b).toString(16)}:${c}`).join(" "));
archives.close();
