// A7a: field offsets that the line's items read. Prints only primitives.
import { UPDATE_FIELDS } from "file:///F:/tswowRoot/WebClient/src/generated/protocol-data/updateFields.ts";

const names = process.argv.slice(2);
const want = names.length ? names : [
  "UNIT_NPC_EMOTESTATE", "UNIT_FIELD_BYTES_1", "UNIT_FIELD_BYTES_2", "PLAYER_FLAGS", "UNIT_FIELD_FLAGS",
  "UNIT_FIELD_FLAGS_2", "UNIT_DYNAMIC_FLAGS", "UNIT_VIRTUAL_ITEM_SLOT_ID", "UNIT_FIELD_MOUNTDISPLAYID",
  "PLAYER_FIELD_BYTES", "PLAYER_FIELD_BYTES2",
];
const all = Object.keys(UPDATE_FIELDS);
for (const name of want) {
  const f = UPDATE_FIELDS[name];
  console.log(name, f ? `${f.group} offset=${f.offset} size=${f.size} type=${f.type}` : "MISSING");
}
console.log("CORPSE:", all.filter((n) => n.startsWith("CORPSE_")).map((n) => `${n}@${UPDATE_FIELDS[n].offset}x${UPDATE_FIELDS[n].size}`).join(" "));
console.log("DYNOBJ:", all.filter((n) => n.startsWith("DYNAMICOBJECT_")).map((n) => `${n}@${UPDATE_FIELDS[n].offset}x${UPDATE_FIELDS[n].size}`).join(" "));
