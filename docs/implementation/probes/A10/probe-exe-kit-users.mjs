// A10 / 6.21 (read-only): the code sites that index the SpellVisualKit record array of the 3.3.5a
// client (array pointer 0xad4a5c, id range 0xad4a4c..0xad4a48, found in the function that logs
// SPELLVISUALKITIDNOTFOUND) and then read the record's StartAnimID (+4) or AnimID (+8).
// Static: Wow.exe.clean is only read.
import { readFile } from "node:fs/promises";
import { decode, listing, parsePe } from "./x86lite.mjs";

const exe = await readFile("F:/Circle/Wow.exe.clean");
const pe = parsePe(exe);
const arrayVa = Number(process.argv[2] ?? "0xad4a5c");
const window = Number(process.argv[3] ?? 40);
const pattern = Buffer.alloc(4);
pattern.writeUInt32LE(arrayVa);
const sites = [];
for (let at = exe.indexOf(pattern, 0); at >= 0; at = exe.indexOf(pattern, at + 1)) {
  const section = pe.sectionOfFile(at);
  if (section && /text/i.test(section.name)) sites.push(at);
}
console.log(`${sites.length} code sites reference va 0x${arrayVa.toString(16)}`);
let shown = 0;
for (const site of sites) {
  // The instruction that holds the address starts 1 (a1) or 2 (8b xx) bytes before it.
  const start = exe[site - 1] === 0xa1 ? site - 1 : site - 2;
  const rows = [];
  let at = start;
  for (let index = 0; index < window; index++) {
    let instruction;
    try { instruction = decode(exe, at, pe); } catch { instruction = { length: 1, text: "db ?" }; }
    rows.push({ at, length: instruction.length, text: instruction.text });
    at += instruction.length;
  }
  // The register that receives the record: the first `mov R, [X+Y*4]` after the array load.
  let register;
  for (const row of rows.slice(1)) {
    const match = /^mov (e[a-d]x|e[sd]i|ebp), dword ptr \[[a-z]+\+[a-z]+\*4\]$/.exec(row.text);
    if (match) { register = match[1]; break; }
  }
  if (!register) continue;
  const reads = rows.filter((row) => new RegExp(`\\[${register}\\+0x(4|8)\\]`).test(row.text));
  if (reads.length === 0) continue;
  shown++;
  console.log(`\n=== site va 0x${(pe.fileToVa(start) ?? 0).toString(16)}: record in ${register}; reads of +4/+8: ${reads.map((r) => r.text).join(" | ")}`);
  console.log(listing(exe, start, window, pe, new Set(reads.map((row) => row.at))));
}
console.log(`\n${shown} sites read StartAnimID/AnimID`);
