// What the gateway's own targeting contract says for the item-target spells of 2.05 (real Spell.dbc rows).
const { loadSpellMetadata } = await import("file:///F:/tswowRoot/WebClient/dist/code/gateway/SpellMetadata.js");
const { openDbcFile } = await import("file:///F:/tswowRoot/WebClient/dist/code/gateway/Dbc.js");
const DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
const meta = await loadSpellMetadata(DBC);
const ids = [2823, 2828, 13262, 31252, 51005, 6991, 55628, 58510, 1804, 19646, 491, 8917, 8613, 32605, 3365, 21651, 5763];
for (const id of ids) {
  const m = meta.get(id);
  if (!m) { console.log(id, "missing"); continue; }
  console.log(id, JSON.stringify({ name: m.name, mode: m.requiredTargetMode, mask: m.requiredTargetMask, explicit: m.explicitTargetMask, client: m.clientSelectionMask, supports: m.supportsExplicitTarget, ver: m.explicitTargetContractVersion }));
}
// Census over the 768 rows with Targets & ITEM.
const spells = await openDbcFile(DBC, "Spell");
let itemRows = 0, supports = 0, clientItem = 0, modeItem = 0, unsupported = [];
for (const row of spells.rows()) {
  const targets = spells.int(row, "Targets") >>> 0;
  if ((targets & 0x10) === 0) continue;
  itemRows++;
  const m = meta.get(spells.id(row));
  if (!m) continue;
  if (m.supportsExplicitTarget) supports++; else if (unsupported.length < 12) unsupported.push(`${m.id}:${m.name}`);
  if ((m.clientSelectionMask ?? 0) & 2) clientItem++;
  if (m.requiredTargetMode === 2) modeItem++;
}
console.log(`Targets&ITEM rows=${itemRows}; supportsExplicitTarget=${supports}; clientSelectionMask has Item=${clientItem}; requiredTargetMode==Item=${modeItem}`);
console.log("unsupported sample:", unsupported.join(" | "));
// Which spells get Item in clientSelectionMask overall and how many of them lack the raw 0x10 flag (effect-derived)?
let overall = 0, derived = 0;
for (const [, m] of meta) if ((m.clientSelectionMask ?? 0) & 2) { overall++; if ((m.targets & 0x10) === 0) derived++; }
console.log(`clientSelectionMask has Item overall=${overall}; of them without raw 0x10 (derived from effects)=${derived}`);
