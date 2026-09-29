import { readFile } from "node:fs/promises";
import { parsePe, decode, listing } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A10/x86lite.mjs";
const exe = await readFile("F:/Circle/Wow.exe.clean");
const pe = parsePe(exe);
for (const va of [0x8a93d0, 0x8b9110]) {
  const needle = Buffer.alloc(4); needle.writeUInt32LE(va);
  for (let at = exe.indexOf(needle, 0); at >= 0; at = exe.indexOf(needle, at + 1)) {
    const section = pe.sectionOfFile(at);
    console.log(`va 0x${va.toString(16)} referenced at file 0x${at.toString(16)} va 0x${(pe.fileToVa(at) ?? 0).toString(16)} in ${section?.name}: ${[...exe.subarray(Math.max(0, at - 12), at + 12)].map((v) => v.toString(16).padStart(2, "0")).join(" ")}`);
  }
}
