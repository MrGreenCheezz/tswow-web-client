// Read-only census of Spell.dbc DispelType (field 2) and the not-stealable attribute (AttributesExD 0x40).
const { openDbcFile } = await import("file:///F:/tswowRoot/WebClient/dist/code/gateway/Dbc.js");
const DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const spells = await openDbcFile(DBC, "Spell");
const byType = new Map(), stealable = { magic: 0, magicNotStealable: 0, magicPassive: 0 };
const probe = new Set([118, 172, 702, 5782, 2818, 3034, 55095, 8921, 1126, 1459, 21562, 20217, 25771, 6788, 34914, 44572, 12472]);
const rows = [];
for (const row of spells.rows()) {
  const id = spells.id(row);
  const dispel = spells.int(row, "DispelType");
  byType.set(dispel, (byType.get(dispel) ?? 0) + 1);
  const attrEx4 = spells.int(row, "AttributesExD") >>> 0;
  const passive = (spells.int(row, "Attributes") & 0x40) !== 0;
  if (dispel === 1) { stealable.magic++; if (attrEx4 & 0x40) stealable.magicNotStealable++; if (passive) stealable.magicPassive++; }
  if (probe.has(id)) rows.push(`${id} "${spells.locstring(row, "Name_lang")}" ${spells.locstring(row, "NameSubtext_lang")} dispel=${dispel} notStealable=${(attrEx4 & 0x40) !== 0} passive=${passive}`);
}
console.log("Spell rows by DispelType:", JSON.stringify([...byType].sort((a, b) => a[0] - b[0])));
console.log("Magic rows:", JSON.stringify(stealable));
for (const r of rows) console.log(r);
