// A10 / 6.21 (read-only): who calls a function of Wow.exe.clean (`e8 rel32` sites), plus the C
// strings at addresses given after `--str`.   node probe-exe-callers.mjs 0x6da130 0x6ddbb0 --str 0xa321d0 0x9ff09c
import { readFile } from "node:fs/promises";
import { decode, parsePe } from "./x86lite.mjs";

const exe = await readFile("F:/Circle/Wow.exe.clean");
const pe = parsePe(exe);
const args = process.argv.slice(2);
const split = args.indexOf("--str");
const targets = (split < 0 ? args : args.slice(0, split)).map((v) => Number.parseInt(v, 16));
const strings = split < 0 ? [] : args.slice(split + 1).map((v) => Number.parseInt(v, 16));
const text = pe.sections.find((s) => s.name === ".text");
for (const target of targets) {
  const callers = [];
  for (let at = text.rawPointer; at < text.rawPointer + text.rawSize - 5; at++) {
    if (exe[at] !== 0xe8) continue;
    const site = pe.fileToVa(at);
    if ((site + 5 + exe.readInt32LE(at + 1)) >>> 0 === target) callers.push(site);
  }
  console.log(`callers of 0x${target.toString(16)}: ${callers.map((v) => "0x" + v.toString(16)).join(", ") || "(none as e8 calls — maybe virtual)"}`);
  // A virtual method: the address sits in a table.
  const pointer = Buffer.alloc(4); pointer.writeUInt32LE(target);
  for (let at = exe.indexOf(pointer, 0); at >= 0; at = exe.indexOf(pointer, at + 1)) {
    console.log(`  address stored at va 0x${(pe.fileToVa(at) ?? 0).toString(16)} in ${pe.sectionOfFile(at)?.name}`);
  }
}
for (const va of strings) {
  const offset = pe.vaToFile(va);
  const end = exe.indexOf(0, offset);
  console.log(`string at 0x${va.toString(16)}: ${JSON.stringify(exe.toString("latin1", offset, Math.min(end, offset + 160)))}`);
}
