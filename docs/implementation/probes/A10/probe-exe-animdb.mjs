// A10 / 6.21 (read-only): locate the client's AnimationData table object and every code site that
// indexes it and reads the record's Bodyflags (+0x0c) — the field whose bit 0x8 the arbiter uses.
//   AnimationData record: ID +0, Name +4, Weaponflags +8, Bodyflags +0xc, Flags +0x10, Fallback +0x14,
//   BehaviorID +0x18, BehaviorTier +0x1c (tools/dbd/AnimationData.dbd, 3.3.5.12340 layout).
// Method: the table's name string is returned by a tiny virtual method (`mov eax, <string>; ret`);
// the method's address sits in a vtable in .rdata; a static initialiser stores that vtable into the
// global table object; the object's row-pointer array is at object+8 (checked on the SpellVisualKit
// table: object 0xad4a54, array 0xad4a5c, min id 0xad4a4c, max id 0xad4a48).
import { readFile } from "node:fs/promises";
import { decode, listing, parsePe } from "./x86lite.mjs";

const exe = await readFile("F:/Circle/Wow.exe.clean");
const pe = parsePe(exe);
const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; };
const findAll = (needle, from = 0) => { const out = []; for (let at = exe.indexOf(needle, from); at >= 0; at = exe.indexOf(needle, at + 1)) out.push(at); return out; };

const tableName = process.argv[2] ?? "DBFilesClient\\AnimationData.dbc";
const stringAt = exe.indexOf(Buffer.from(`${tableName}\0`, "latin1"));
const stringVa = pe.fileToVa(stringAt);
console.log(`${tableName} at va 0x${stringVa.toString(16)}`);
// 1. the tiny method: `b8 <va> c3`
const method = findAll(Buffer.concat([Buffer.from([0xb8]), u32(stringVa), Buffer.from([0xc3])]));
console.log(`getName method(s): ${method.map((o) => "0x" + pe.fileToVa(o).toString(16)).join(", ")}`);
const methodVa = pe.fileToVa(method[0]);
// 2. vtables holding it
const vtableHits = findAll(u32(methodVa)).filter((o) => /rdata|data/.test(pe.sectionOfFile(o)?.name ?? ""));
console.log(`vtable slot(s) holding it: ${vtableHits.map((o) => "0x" + pe.fileToVa(o).toString(16)).join(", ")}`);
for (const slot of vtableHits) {
  // The vtable starts a few slots earlier; try each slot index and look for stores of that start.
  for (let back = 0; back <= 12; back++) {
    const vtableVa = pe.fileToVa(slot) - back * 4;
    const stores = findAll(u32(vtableVa)).filter((o) => /text/.test(pe.sectionOfFile(o)?.name ?? ""));
    for (const store of stores) {
      // `c7 05 <obj> <vtable>` mov dword ptr [obj], vtable   |   `c7 00/01/06.. <vtable>` (this-relative: skip)
      if (exe[store - 6] === 0xc7 && exe[store - 5] === 0x05) {
        const object = exe.readUInt32LE(store - 4);
        console.log(`  vtable 0x${vtableVa.toString(16)} (slot ${back}) stored into global object 0x${object.toString(16)} at va 0x${pe.fileToVa(store - 6).toString(16)}; row array expected at 0x${(object + 8).toString(16)}`);
      }
    }
  }
}
