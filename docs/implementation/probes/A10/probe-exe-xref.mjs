// A10 / 6.21 (read-only): where the client code touches a string, with a listing around it.
//   node probe-exe-xref.mjs "<string>" [instructions-before=40] [instructions-after=40] [max-hits=4]
// Reads F:/Circle/Wow.exe.clean only. Never runs it.
import { readFile } from "node:fs/promises";
import { decode, listing, parsePe } from "./x86lite.mjs";

const exe = await readFile("F:/Circle/Wow.exe.clean");
const pe = parsePe(exe);
const needle = process.argv[2];
const before = Number(process.argv[3] ?? 40);
const after = Number(process.argv[4] ?? 40);
const maxHits = Number(process.argv[5] ?? 4);
console.log(`image base 0x${pe.imageBase.toString(16)}; sections: ${pe.sections.map((s) => `${s.name}@0x${(pe.imageBase + s.rva).toString(16)}+0x${s.virtualSize.toString(16)}`).join(" ")}`);

let from = 0;
const stringOffsets = [];
const directVa = /^0x[0-9a-f]+$/i.test(needle) ? Number.parseInt(needle, 16) : undefined;
for (; directVa === undefined;) {
  const at = exe.indexOf(Buffer.from(needle, "latin1"), from);
  if (at < 0) break;
  // Whole-string matches only: the byte before is a terminator or padding.
  if (at === 0 || exe[at - 1] === 0) stringOffsets.push(at);
  from = at + 1;
}
console.log(`"${needle}": ${directVa === undefined ? stringOffsets.length + " string copies at " + stringOffsets.map((o) => "0x" + o.toString(16) + "(va 0x" + (pe.fileToVa(o) ?? 0).toString(16) + ")").join(", ") : "direct address"}`);
for (const offset of directVa === undefined ? stringOffsets : [0]) {
  const va = directVa ?? pe.fileToVa(offset);
  const pattern = Buffer.alloc(4);
  pattern.writeUInt32LE(va);
  const hits = [];
  for (let at = exe.indexOf(pattern, 0); at >= 0; at = exe.indexOf(pattern, at + 1)) hits.push(at);
  console.log(`  va 0x${va.toString(16)}: ${hits.length} 4-byte references`);
  for (const hit of hits.slice(0, maxHits)) {
    const section = pe.sectionOfFile(hit);
    console.log(`  -- reference at file 0x${hit.toString(16)} va 0x${(pe.fileToVa(hit) ?? 0).toString(16)} in ${section?.name}`);
    if (!section || !/text/i.test(section.name)) {
      console.log(`     data: ${[...exe.subarray(Math.max(0, hit - 16), hit + 32)].map((v) => v.toString(16).padStart(2, "0")).join(" ")}`);
      continue;
    }
    // Function start: the nearest `55 8B EC` after int3/ret padding within 6 KiB.
    let start = -1;
    for (let at = hit; at > Math.max(section.rawPointer, hit - 6144); at--) {
      if (exe[at] === 0x55 && exe[at + 1] === 0x8b && exe[at + 2] === 0xec
        && (exe[at - 1] === 0xcc || exe[at - 1] === 0xc3 || exe[at - 3] === 0xc2)) { start = at; break; }
    }
    if (start < 0) start = hit - 150;
    // Sweep from the start, remember the instruction that contains the hit.
    const rows = [];
    let at = start;
    while (at < hit + 400 && at < exe.length) {
      let instruction;
      try { instruction = decode(exe, at, pe); } catch { instruction = { length: 1, text: "db ?" }; }
      rows.push({ at, length: instruction.length });
      at += instruction.length;
    }
    const index = rows.findIndex((row) => hit >= row.at && hit < row.at + row.length);
    const first = Math.max(0, index - before);
    console.log(`     function start guess va 0x${(pe.fileToVa(start) ?? 0).toString(16)}; showing instructions ${first}..${Math.min(rows.length, index + after)} of the sweep`);
    console.log(listing(exe, rows[first].at, Math.min(rows.length - first, before + after), pe, new Set([rows[Math.max(index, 0)]?.at])));
  }
}
