import { openDbcFile } from "file:///F:/tswowRoot/WebClient/tools/dbc.mjs";
import { dbcDirectory } from "file:///F:/tswowRoot/WebClient/tools/paths.mjs";
import { openRaw, head, dump } from "file:///C:/Users/ADMINI~1/AppData/Local/Temp/claude/F--tswowRoot-WebClient/8691de39-2c7d-46b9-bb55-f8d1b969e99a/scratchpad/impl/A7a/raw.mjs";
import { ANIMATION_NAMES } from "file:///F:/tswowRoot/WebClient/src/generated/client-data/animations.ts";
const dir = dbcDirectory();
const sub = await openDbcFile(dir, "ItemSubClass");
const name = (id) => (id > 0 || id === 0 ? `${id}:${ANIMATION_NAMES?.[id] ?? "?"}` : String(id));
console.log("ItemSubClass class 2 (weapons): parry/ready/attack seq, swing size");
for (const r of sub.rows()) {
  if (sub.int(r, "ClassID") !== 2) continue;
  console.log(`  sub${sub.int(r, "SubClassID")} "${sub.string(r, "DisplayName_lang")}" flags=${sub.int(r, "Flags")} parry=${name(sub.int(r, "WeaponParrySeq"))} ready=${name(sub.int(r, "WeaponReadySeq"))} attack=${name(sub.int(r, "WeaponAttackSeq"))} swing=${sub.int(r, "WeaponSwingSize")}`);
}
for (const t of ["AttackAnimKits", "AttackAnimTypes"]) {
  const x = openRaw(t); console.log(head(x));
  for (let r = 0; r < Math.min(30, x.records); r++) console.log("   ", dump(x, r, x.fields));
}
