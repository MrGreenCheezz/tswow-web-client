// A10 / 6.21 (read-only): a listing window around a virtual address of Wow.exe.clean, synced from
// the function start, or the C string at an address.
//   node probe-exe-window.mjs code 0x6da1cf 60 40      (instructions before / after the address)
//   node probe-exe-window.mjs str 0xbd07a8
//   node probe-exe-window.mjs fn 0x71af70 40            (from a known function start)
import { readFile } from "node:fs/promises";
import { decode, listing, parsePe } from "./x86lite.mjs";

const exe = await readFile("F:/Circle/Wow.exe.clean");
const pe = parsePe(exe);
const [mode, addressText, a, b] = process.argv.slice(2);
const va = Number.parseInt(addressText, 16);
const offset = pe.vaToFile(va);
if (offset === undefined) throw new Error(`0x${va.toString(16)} is not in a section`);
if (mode === "str") {
  const end = exe.indexOf(0, offset);
  console.log(JSON.stringify(exe.toString("latin1", offset, Math.min(end, offset + 200))));
} else if (mode === "fn") {
  console.log(listing(exe, offset, Number(a ?? 40), pe));
} else {
  const before = Number(a ?? 40);
  const after = Number(b ?? 30);
  const text = pe.sectionOfFile(offset);
  let start = -1;
  for (let at = offset; at > Math.max(text.rawPointer, offset - 6000); at--) {
    if (exe[at] === 0x55 && exe[at + 1] === 0x8b && exe[at + 2] === 0xec && (exe[at - 1] === 0xcc || exe[at - 1] === 0xc3)) { start = at; break; }
  }
  if (start < 0) start = offset - 200;
  const rows = [];
  let at = start;
  while (at < offset + 600) {
    let instruction;
    try { instruction = decode(exe, at, pe); } catch { instruction = { length: 1, text: "db ?" }; }
    rows.push({ at, length: instruction.length });
    at += instruction.length;
  }
  const index = rows.findIndex((row) => offset >= row.at && offset < row.at + row.length);
  const first = Math.max(0, index - before);
  console.log(`function start guess va 0x${(pe.fileToVa(start) ?? 0).toString(16)}`);
  console.log(listing(exe, rows[first].at, Math.min(rows.length - first, before + after), pe, new Set([rows[index].at])));
}
