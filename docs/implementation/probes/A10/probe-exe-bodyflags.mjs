// A10 / 6.21 (read-only): code in the 3.3.5a client that tests bit 0x8 of a dword at record+0x0c —
// what AnimationData.Bodyflags would look like. The pattern is not unique to that table, so each hit
// is printed with the instructions before it, and the ones that fetch a record by id (the
// min/max/array pattern seen for SpellVisualKit) are marked.
import { readFile } from "node:fs/promises";
import { decode, listing, parsePe } from "./x86lite.mjs";

const exe = await readFile("F:/Circle/Wow.exe.clean");
const pe = parsePe(exe);
const text = pe.sections.find((s) => s.name === ".text");
const hits = [];
for (let at = text.rawPointer; at < text.rawPointer + text.rawSize - 8; at++) {
  const b = exe[at];
  // test byte ptr [reg+0xc], imm8 with bit 3 in the mask: f6 /0 ib
  if (b === 0xf6 && (exe[at + 1] & 0xf8) === 0x40 && (exe[at + 1] & 7) !== 4 && exe[at + 2] === 0x0c && (exe[at + 3] & 0x08) !== 0) hits.push({ at, kind: "test byte" });
  // test dword ptr [reg+0xc], imm32: f7 /0 id
  else if (b === 0xf7 && (exe[at + 1] & 0xf8) === 0x40 && (exe[at + 1] & 7) !== 4 && exe[at + 2] === 0x0c && (exe[at + 3] & 0x08) !== 0) hits.push({ at, kind: "test dword" });
  // mov reg, [reg2+0xc]  (8b /r disp8) — followed closely by a bit-3 test of the destination
  else if (b === 0x8b && (exe[at + 1] & 0xc0) === 0x40 && (exe[at + 1] & 7) !== 4 && exe[at + 2] === 0x0c) {
    const dest = (exe[at + 1] >> 3) & 7;
    const next = exe.subarray(at + 3, at + 9);
    // test r, 8: f6 c0+r 08 (byte regs) | f7 c0+r 08 00 00 00 | 83 e0+r 08 (and) | a8 08 (al)
    const testsBit3 = (next[0] === 0xf7 && next[1] === (0xc0 | dest) && (next[2] & 8) !== 0)
      || (next[0] === 0x83 && next[1] === (0xe0 | dest) && (next[2] & 8) !== 0)
      || (next[0] === 0xa8 && dest === 0 && (next[1] & 8) !== 0)
      || (next[0] === 0xf6 && next[1] === (0xc0 | dest) && (next[2] & 8) !== 0);
    if (testsBit3) hits.push({ at, kind: "load+test" });
  }
}
console.log(`${hits.length} hits of "bit 3 of dword at record+0xc"`);
const arrayIndexPattern = /mov (e[a-d]x|e[sd]i), dword ptr \[[a-z]+\+[a-z]+\*4\]/;
for (const hit of hits) {
  // Function start guess.
  let start = -1;
  for (let at = hit.at; at > Math.max(text.rawPointer, hit.at - 3000); at--) {
    if (exe[at] === 0x55 && exe[at + 1] === 0x8b && exe[at + 2] === 0xec && (exe[at - 1] === 0xcc || exe[at - 1] === 0xc3)) { start = at; break; }
  }
  if (start < 0) start = hit.at - 120;
  const rows = [];
  let at = start;
  while (at < hit.at + 60) {
    let instruction;
    try { instruction = decode(exe, at, pe); } catch { instruction = { length: 1, text: "db ?" }; }
    rows.push({ at, length: instruction.length, text: instruction.text });
    at += instruction.length;
  }
  const index = rows.findIndex((row) => hit.at >= row.at && hit.at < row.at + row.length);
  if (index < 0) continue;
  const near = rows.slice(Math.max(0, index - 14), index + 1);
  const fetchesById = near.some((row) => arrayIndexPattern.test(row.text));
  hit.summary = `${fetchesById ? "[BY-ID] " : ""}va 0x${(pe.fileToVa(hit.at) ?? 0).toString(16)} (${hit.kind}) in function va 0x${(pe.fileToVa(start) ?? 0).toString(16)}`;
  hit.first = rows[Math.max(0, index - 14)].at;
  hit.byId = fetchesById;
}
const byId = hits.filter((hit) => hit.byId);
console.log(`${byId.length} of them right after a fetch-by-id; all hits:`);
for (const hit of hits) console.log(`  ${hit.summary ?? `unresolved @0x${hit.at.toString(16)}`}`);
for (const hit of byId.slice(0, 6)) {
  console.log(`\n=== ${hit.summary}`);
  console.log(listing(exe, hit.first, 30, pe, new Set([hit.at])));
}
