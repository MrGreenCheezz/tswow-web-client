// A5 probe (read-only): SpellShapeshiftForm.dbc form id -> BonusActionBar, from the clean client.
import { clientArchives } from "file:///F:/tswowRoot/WebClient/tools/mpq.mjs";
import { parseSpellShapeshiftFormBonuses } from "file:///F:/tswowRoot/WebClient/dist/code/gateway/SpellShapeshiftForms.js";

const chain = await clientArchives("F:/CircleClean");
const data = await chain.read("DBFilesClient\\SpellShapeshiftForm.dbc");
if (!data) throw new Error("SpellShapeshiftForm.dbc not found");
const map = parseSpellShapeshiftFormBonuses(new Uint8Array(data));
// Names of the forms as TrinityCore's ShapeshiftForm enum spells them (SharedDefines.h).
const NAMES = {
  1: "CAT", 2: "TREE", 3: "TRAVEL", 4: "AQUA", 5: "BEAR", 6: "AMBIENT", 7: "GHOUL", 8: "DIREBEAR",
  14: "CREATUREBEAR", 15: "CREATURECAT", 16: "GHOSTWOLF", 17: "BATTLESTANCE", 18: "DEFENSIVESTANCE",
  19: "BERSERKERSTANCE", 20: "ZOMBIE", 22: "FLIGHT?", 23: "STEALTH?", 24: "MOONKIN?", 25: "SPIRITOFREDEMPTION?",
  27: "FLIGHT_EPIC", 28: "SHADOW", 29: "FLIGHT", 30: "STEALTH", 31: "MOONKIN", 32: "SPIRITOFREDEMPTION",
};
for (const [id, bonus] of [...map].sort((a, b) => a[0] - b[0])) {
  console.log(`form ${String(id).padStart(2)} ${(NAMES[id] ?? "").padEnd(20)} BonusActionBar=${bonus}`);
}
chain.close();
