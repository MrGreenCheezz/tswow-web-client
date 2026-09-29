// Read-only census of Spell.dbc rows that need an item / trade-slot / lock target, and of the skinning-like spells.
// Uses the built gateway reader (dist) so the layout is the generated one (DBC_LAYOUTS.Spell).
const { openDbcFile } = await import("file:///F:/tswowRoot/WebClient/dist/code/gateway/Dbc.js");
const DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const spells = await openDbcFile(DBC, "Spell");

const F_ITEM = 0x10, F_TRADE_ITEM = 0x1000, F_GAMEOBJECT = 0x800, F_GO_ITEM = 0x4000, F_UNIT = 0x2, F_UNIT_DEAD = 0x400;
const EFFECT_NAMES = { 33: "OPEN_LOCK", 53: "ENCHANT_ITEM", 54: "ENCHANT_ITEM_TEMP", 55: "TAME_CREATURE", 95: "SKINNING", 99: "DISENCHANT", 101: "FEED_PET", 127: "PROSPECTING", 156: "ENCHANT_ITEM_PRISMATIC", 158: "MILLING", 24: "CREATE_ITEM", 66: "CREATE_ITEM_2", 6: "APPLY_AURA" };
const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

let total = 0, withItem = 0, withTrade = 0, withBoth = 0, withGoItem = 0, targetA26 = 0;
const byEffectItem = new Map(), byEffectTrade = new Map(), openLock = [], skinning = [], itemEffectNoFlag = new Map();
const sampleItem = new Map();
for (const row of spells.rows()) {
  total++;
  const id = spells.id(row);
  const targets = spells.int(row, "Targets") >>> 0;
  const eff = [0, 1, 2].map((e) => spells.int(row, "Effect", e));
  const misc = [0, 1, 2].map((e) => spells.int(row, "EffectMiscValue", e));
  const ta = [0, 1, 2].map((e) => spells.int(row, "ImplicitTargetA", e));
  const item = (targets & F_ITEM) !== 0, trade = (targets & F_TRADE_ITEM) !== 0;
  if (item) { withItem++; for (const e of eff) if (e) tally(byEffectItem, e); if (!sampleItem.has(eff[0])) sampleItem.set(eff[0], []); const s = sampleItem.get(eff[0]); if (s.length < 3) s.push(`${id}:${spells.locstring(row, "Name_lang")}`); }
  if (trade) { withTrade++; for (const e of eff) if (e) tally(byEffectTrade, e); }
  if (item && trade) withBoth++;
  if ((targets & F_GO_ITEM) !== 0) withGoItem++;
  if (ta.includes(26)) targetA26++;
  if (eff.includes(33) && ta.includes(26)) openLock.push({ id, name: spells.locstring(row, "Name_lang"), targets: targets.toString(16), misc: misc[eff.indexOf(33)], range: spells.int(row, "RangeIndex") });
  if (eff.includes(95)) skinning.push({ id, name: spells.locstring(row, "Name_lang"), rank: spells.locstring(row, "NameSubtext_lang"), targets: targets.toString(16), misc: misc[eff.indexOf(95)], attr0: (spells.int(row, "Attributes") >>> 0).toString(16) });
  // Rows whose effect is item-directed but that carry neither flag (the core derives the target from the effect)
  if (!item && !trade) for (const e of eff) if ([53, 54, 99, 101, 127, 156, 158].includes(e)) tally(itemEffectNoFlag, e);
}
const fmt = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${EFFECT_NAMES[k] ?? k}=${v}`).join(", ");
console.log(`Spell rows: ${total}`);
console.log(`Targets & ITEM(0x10): ${withItem}; & TRADE_ITEM(0x1000): ${withTrade}; both: ${withBoth}; & GAMEOBJECT_ITEM(0x4000): ${withGoItem}; ImplicitTargetA==26 (GAMEOBJECT_ITEM_TARGET): ${targetA26}`);
console.log(`effects among ITEM rows: ${fmt(byEffectItem)}`);
console.log(`effects among TRADE_ITEM rows: ${fmt(byEffectTrade)}`);
console.log(`item-directed effects with neither flag: ${fmt(itemEffectNoFlag)}`);
for (const [effect, list] of sampleItem) console.log(`  sample ITEM rows, first effect ${EFFECT_NAMES[effect] ?? effect}: ${list.join(" | ")}`);
console.log(`OPEN_LOCK with TargetA=26: ${openLock.length}`);
for (const r of openLock.slice(0, 12)) console.log("  ", JSON.stringify(r));
console.log(`SPELL_EFFECT_SKINNING (95) rows: ${skinning.length}`);
for (const r of skinning) console.log("  ", JSON.stringify(r));
