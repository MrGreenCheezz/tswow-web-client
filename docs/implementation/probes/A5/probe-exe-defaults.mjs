// A5 probe (read-only): where does the 3.3.5a client keep its DEFAULT key bindings?
// Bindings.xml carries only command names. Look in the clean exe for the command strings and
// for pointer tables that pair a key name with a command name.
import { readFileSync } from "node:fs";

const buf = readFileSync("F:/CircleClean/CleanWow.exe");
const peOff = buf.readUInt32LE(0x3c);
const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const imageBase = buf.readUInt32LE(peOff + 24 + 28);
const secOff = peOff + 24 + optSize;
const sections = [];
for (let i = 0; i < numSections; i++) {
  const o = secOff + i * 40;
  sections.push({
    name: buf.toString("latin1", o, o + 8).replace(/\0+$/, ""),
    vsize: buf.readUInt32LE(o + 8), rva: buf.readUInt32LE(o + 12),
    rawSize: buf.readUInt32LE(o + 16), raw: buf.readUInt32LE(o + 20),
  });
}
console.log("imageBase", imageBase.toString(16), sections.map((s) => `${s.name}@${s.rva.toString(16)}+${s.vsize.toString(16)}`).join(" "));
const vaToOff = (va) => {
  const rva = va - imageBase;
  for (const s of sections) if (rva >= s.rva && rva < s.rva + Math.min(s.vsize, s.rawSize)) return s.raw + (rva - s.rva);
  return -1;
};
const offToVa = (off) => {
  for (const s of sections) if (off >= s.raw && off < s.raw + s.rawSize) return imageBase + s.rva + (off - s.raw);
  return -1;
};
const cstr = (va) => {
  const off = vaToOff(va);
  if (off < 0) return undefined;
  let end = off;
  while (end < buf.length && buf[end] !== 0 && end - off < 80) end++;
  const s = buf.toString("latin1", off, end);
  return /^[ -~]+$/.test(s) ? s : undefined;
};

function findAll(needle) {
  const out = [];
  let from = 0;
  const n = Buffer.from(needle, "latin1");
  for (;;) {
    const at = buf.indexOf(n, from);
    if (at < 0) break;
    out.push(at);
    from = at + 1;
  }
  return out;
}

for (const name of ["TOGGLESHEATH", "MOVEFORWARD", "ACTIONBUTTON1", "TARGETPARTYMEMBER1"]) {
  const hits = findAll(`${name}\0`).filter((at) => at === 0 || buf[at - 1] === 0);
  console.log(`\n"${name}" string hits: ${hits.length}`);
  for (const at of hits.slice(0, 4)) {
    const va = offToVa(at);
    console.log(`  offset ${at.toString(16)} va ${va.toString(16)}`);
    // Pointers to this string anywhere in the file.
    const ptr = Buffer.alloc(4);
    ptr.writeUInt32LE(va);
    let from = 0;
    let shown = 0;
    for (;;) {
      const p = buf.indexOf(ptr, from);
      if (p < 0 || shown >= 6) break;
      from = p + 1;
      shown++;
      const ctx = [];
      for (let k = -4; k <= 4; k++) {
        const w = buf.readUInt32LE(p + k * 4);
        const s = cstr(w);
        ctx.push(s !== undefined ? JSON.stringify(s) : w.toString(16));
      }
      console.log(`    ptr at file ${p.toString(16)} (va ${offToVa(p).toString(16)}): ${ctx.join("  ")}`);
    }
  }
}
