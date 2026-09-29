// Read-only probe: every ChrClasses row of the live dataset, with the three name columns,
// the token and the class-mask-relevant columns. Also CharBaseInfo pairs for classes 12/13 and
// the classes' talent tabs, to see which class ids own a Talent tab.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
function open(table) {
  const data = readFileSync(join(DIR, `${table}.dbc`));
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsOffset = 20 + records * recordSize;
  const int = (row, col) => data.readInt32LE(20 + row * recordSize + col * 4);
  const str = (row, col) => {
    const off = data.readUInt32LE(20 + row * recordSize + col * 4);
    if (!off) return "";
    const start = stringsOffset + off;
    return data.subarray(start, data.indexOf(0, start)).toString("utf8");
  };
  return { table, records, fields, recordSize, int, str };
}

const cls = open("ChrClasses");
console.log(`ChrClasses: records=${cls.records} fields=${cls.fields} recordSize=${cls.recordSize}`);
for (let r = 0; r < cls.records; r++) {
  const id = cls.int(r, 0);
  const loc = (base, locale) => cls.str(r, base + locale);
  console.log(JSON.stringify({
    id,
    displayPower: cls.int(r, 2),
    petNameToken: cls.str(r, 3),
    nameEn: loc(4, 0), nameRu: loc(4, 8),
    femaleEn: loc(21, 0), femaleRu: loc(21, 8),
    maleEn: loc(38, 0), maleRu: loc(38, 8),
    filename: cls.str(r, 55),
    spellClassSet: cls.int(r, 56), flags: cls.int(r, 57), cinematic: cls.int(r, 58), expansion: cls.int(r, 59),
  }));
}

const baseRaw = readFileSync(join(DIR, "CharBaseInfo.dbc"));
const baseRecords = baseRaw.readUInt32LE(4), baseSize = baseRaw.readUInt32LE(12);
const pairs = new Map();
for (let r = 0; r < baseRecords; r++) {
  const raceId = baseRaw[20 + r * baseSize], classId = baseRaw[20 + r * baseSize + 1];
  const set = pairs.get(classId) ?? new Set();
  set.add(raceId);
  pairs.set(classId, set);
}
console.log("CharBaseInfo records", baseRecords, "recordSize", baseSize,
  "races per class", JSON.stringify([...pairs].sort((a, b) => a[0] - b[0]).map(([c, s]) => [c, s.size])));

// Talent tabs: TalentTab.dbc ClassMask column. Layout 3.3.5: ID, Name[17], SpellIconID, RaceMask, ClassMask, PetTalentMask, OrderIndex, BackgroundFile
const tab = open("TalentTab");
console.log(`TalentTab: records=${tab.records} fields=${tab.fields} recordSize=${tab.recordSize}`);
const masks = new Map();
for (let r = 0; r < tab.records; r++) {
  const classMask = tab.int(r, 20);
  masks.set(classMask, (masks.get(classMask) ?? 0) + 1);
}
console.log("TalentTab ClassMask histogram", JSON.stringify([...masks].sort((a, b) => a[0] - b[0])));
