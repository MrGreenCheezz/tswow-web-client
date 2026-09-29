// A6 / 1.19, 2.07 probe (read-only): how the 3.3.5a client (F:/Circle/Wow.exe.clean, the unpatched copy)
// maps a response code to a GlueStrings key. Finds the pointer table that holds "RESPONSE_SUCCESS",
// prints the strings it points at in order, and lists the glue events around FORCE_RENAME_CHARACTER.
import { readFile } from "node:fs/promises";

const exe = await readFile("F:/Circle/Wow.exe.clean");
const peOffset = exe.readUInt32LE(0x3c);
const sectionCount = exe.readUInt16LE(peOffset + 6);
const optionalSize = exe.readUInt16LE(peOffset + 20);
const imageBase = exe.readUInt32LE(peOffset + 24 + 28);
const sections = [];
for (let i = 0; i < sectionCount; i++) {
  const at = peOffset + 24 + optionalSize + i * 40;
  sections.push({
    name: exe.toString("latin1", at, at + 8).replace(/\0+$/, ""),
    virtualSize: exe.readUInt32LE(at + 8), virtualAddress: exe.readUInt32LE(at + 12),
    rawSize: exe.readUInt32LE(at + 16), rawPointer: exe.readUInt32LE(at + 20),
  });
}
console.log(`imageBase 0x${imageBase.toString(16)}`, sections.map((s) => `${s.name}@0x${s.virtualAddress.toString(16)}`).join(" "));
const vaOf = (offset) => {
  for (const s of sections) if (offset >= s.rawPointer && offset < s.rawPointer + s.rawSize) return imageBase + s.virtualAddress + (offset - s.rawPointer);
  return undefined;
};
const offsetOf = (va) => {
  for (const s of sections) {
    const rva = va - imageBase;
    if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) return s.rawPointer + (rva - s.virtualAddress);
  }
  return undefined;
};
const cstringAt = (va) => {
  const start = offsetOf(va);
  if (start === undefined || start >= exe.length) return undefined;
  let end = start;
  while (end < exe.length && end - start < 80 && exe[end] !== 0) end++;
  const text = exe.toString("latin1", start, end);
  return /^[ -~]{3,79}$/.test(text) ? text : undefined;
};
function allOffsets(text) {
  const needle = Buffer.from(`${text}\0`, "latin1");
  const hits = [];
  let at = -1;
  while ((at = exe.indexOf(needle, at + 1)) >= 0) if (at === 0 || exe[at - 1] === 0) hits.push(at);
  return hits;
}
function pointerHits(va) {
  const needle = Buffer.alloc(4); needle.writeUInt32LE(va);
  const hits = [];
  let at = -1;
  while ((at = exe.indexOf(needle, at + 1)) >= 0) hits.push(at);
  return hits;
}
function dumpTable(anchor) {
  for (const stringOffset of allOffsets(anchor)) {
    const va = vaOf(stringOffset);
    if (va === undefined) continue;
    for (const hit of pointerHits(va)) {
      // Walk backwards to the start of a run of valid string pointers, then forwards.
      const stride = 4;
      let first = hit;
      while (first - stride >= 0 && cstringAt(exe.readUInt32LE(first - stride)) !== undefined) first -= stride;
      const rows = [];
      for (let at = first; at + 4 <= exe.length; at += stride) {
        const text = cstringAt(exe.readUInt32LE(at));
        if (text === undefined) break;
        rows.push(text);
      }
      if (rows.length < 4) continue;
      console.log(`\n== pointer table containing ${anchor}: file offset 0x${first.toString(16)}, ${rows.length} entries, ${rows.indexOf(anchor)} = index of ${anchor}`);
      rows.forEach((text, index) => console.log(`${String(index).padStart(3)} ${text}`));
      return true;
    }
  }
  return false;
}
// A6 / 1.19, 10.06 probe: the AuthResult (0x00..0x20) -> LOGIN_* key table of the client, printed slot by slot
// (a null slot is an AuthResult the client does not name).
for (const anchor of ["LOGIN_INCORRECT_PASSWORD"]) {
  for (const stringOffset of allOffsets(anchor)) {
    const va = vaOf(stringOffset);
    for (const hit of pointerHits(va)) {
      console.log(`\n== slots around a pointer to ${anchor} at file offset 0x${hit.toString(16)} (slot 0 = 0x${(hit - 4 * 8).toString(16)})`);
      for (let slot = -12; slot <= 40; slot++) {
        const at = hit + slot * 4;
        const value = exe.readUInt32LE(at);
        const text = value === 0 ? "(null)" : cstringAt(value) ?? `0x${value.toString(16)}`;
        console.log(`${String(slot).padStart(4)} @0x${at.toString(16)} ${text}`);
      }
    }
  }
}
