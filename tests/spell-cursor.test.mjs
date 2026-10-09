// Plan item 2.05 (mechanism M3): the item-target spell cursor (game/SpellCursor.ts) — who raises it,
// what a click on an item sends, what drops it — without DOM.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const cursor = await import("../dist/code/browser/game/SpellCursor.js");
const ground = await import("../dist/code/browser/game/GroundTarget.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const item = (entry) => ({ typeId: 1, fields: new Map([[ENTRY, entry]]) });

/** A world double that records what the cursor sends. */
function world(extra = {}) {
  const calls = [];
  return {
    calls,
    mapId: 0,
    itemTemplates: new Map([
      [2770, { flags: 0x0004_0000 }], // Copper Ore: prospectable
      [2589, { flags: 0 }], // Linen Cloth: neither
      [765, { flags: 0x2000_0000 }], // Silverleaf: millable
    ]),
    onSpellStatus() {},
    useItemOnItem(...args) { calls.push(["useItemOnItem", ...args]); return true; },
    castSpellOnItem(...args) { calls.push(["castSpellOnItem", ...args]); },
    castSpellOnTradeSlot(...args) { calls.push(["castSpellOnTradeSlot", ...args]); return true; },
    ...extra,
  };
}

function reset() {
  cursor.cancelItemTarget();
  ground.cancelGroundTarget();
  game.world = undefined;
  game.spells.clear();
}

test("an item whose own spell waits for an item raises the cursor; nothing is sent", () => {
  reset();
  const live = world();
  game.world = live;
  const templates = new Map([[2892, { spells: [{ spellId: 2823, trigger: 0 }] }]]);
  const spells = new Map([[2823, { requiredTargetMode: cursor.ITEM_TARGET_MODE }]]);
  let sent = 0;
  ground.requestItemUse({ bag: 255, slot: 23, guid: 0x101n, entry: 2892 }, () => { sent++; }, templates, spells);
  assert.equal(sent, 0, "no targetless CMSG_USE_ITEM for a poison");
  const pending = cursor.pendingItemTarget();
  assert.equal(pending?.kind, "item-use");
  assert.equal(pending?.spellId, 2823);
  assert.deepEqual(pending?.source, { bag: 255, slot: 23, guid: 0x101n });
  assert.equal(ground.pendingGroundTarget(), undefined);
  // A unit or ground spell does not raise it.
  const unitSpells = new Map([[2823, { requiredTargetMode: 1 }]]);
  cursor.cancelItemTarget();
  ground.requestItemUse({ bag: 255, slot: 23, guid: 0x101n, entry: 2892 }, () => { sent++; }, templates, unitSpells);
  assert.equal(sent, 1);
  assert.equal(cursor.pendingItemTarget(), undefined);
  reset();
});

test("a click on an item sends the item's use with that target once and drops the cursor", () => {
  reset();
  const live = world();
  game.world = live;
  assert.equal(cursor.armItemTarget(live, 2823, { bag: 255, slot: 23, guid: 0x101n }), true);
  // An empty place does nothing and the cursor stays.
  assert.equal(cursor.targetItemWithCursor(undefined, 0n, live).kind, "none");
  assert.equal(cursor.pendingItemTarget()?.spellId, 2823);
  const outcome = cursor.targetItemWithCursor(item(25), 0x202n, live, () => undefined);
  assert.equal(outcome.kind, "sent");
  assert.deepEqual(live.calls, [["useItemOnItem", 255, 23, 0x101n, 2823, 0x202n]]);
  assert.equal(cursor.pendingItemTarget(), undefined);
  assert.equal(cursor.targetItemWithCursor(item(25), 0x202n, live).kind, "none", "a second click is ordinary");
  assert.equal(live.calls.length, 1);
  reset();
});

test("a stale source item lets the cursor go and the click is ordinary", () => {
  reset();
  const live = world({ useItemOnItem() { return false; } });
  game.world = live;
  cursor.armItemTarget(live, 2823, { bag: 255, slot: 23, guid: 0x101n });
  assert.equal(cursor.targetItemWithCursor(item(25), 0x202n, live, () => undefined).kind, "none");
  assert.equal(cursor.pendingItemTarget(), undefined);
  reset();
});

test("a book spell sends CMSG_CAST_SPELL on the item with its cooldown", () => {
  reset();
  const live = world();
  game.world = live;
  cursor.armItemTarget(live, 13262);
  const facts = { requiredTargetMode: 2, effects: [99, 0, 0], recoveryTime: 0, categoryRecoveryTime: 0 };
  assert.equal(cursor.targetItemWithCursor(item(25), 0x202n, live, () => facts).kind, "sent");
  assert.deepEqual(live.calls, [["castSpellOnItem", 13262, 0x202n, 0, false]]);
  reset();
});

test("prospecting and milling refuse the wrong item themselves and keep the cursor", () => {
  reset();
  const live = world();
  game.world = live;
  const prospect = { effects: [127, 0, 0] };
  const mill = { effects: [158, 0, 0] };
  cursor.armItemTarget(live, 31252);
  assert.deepEqual(cursor.targetItemWithCursor(item(2589), 0x303n, live, () => prospect),
    { kind: "refused", error: "SPELL_FAILED_CANT_BE_PROSPECTED" });
  assert.equal(cursor.pendingItemTarget()?.spellId, 31252, "the cursor stays after a refusal");
  assert.equal(live.calls.length, 0);
  assert.equal(cursor.targetItemWithCursor(item(2770), 0x304n, live, () => prospect).kind, "sent");
  cursor.armItemTarget(live, 51005);
  assert.deepEqual(cursor.targetItemWithCursor(item(2770), 0x304n, live, () => mill),
    { kind: "refused", error: "SPELL_FAILED_CANT_BE_MILLED" });
  assert.equal(cursor.targetItemWithCursor(item(765), 0x305n, live, () => mill).kind, "sent");
  // An unknown template leaves the verdict to the realm.
  assert.equal(cursor.itemTargetRefusal(prospect, undefined), undefined);
  assert.equal(cursor.itemTargetRefusal({ effects: [99] }, { flags: 0 }), undefined);
  reset();
});

test("a new world or a new map drops the cursor; the reticle and the cursor replace each other", () => {
  reset();
  const live = world();
  game.world = live;
  cursor.armItemTarget(live, 13262);
  live.mapId = 1;
  assert.equal(cursor.pendingItemTarget(), undefined, "a map change drops it");
  live.mapId = 0;
  cursor.armItemTarget(live, 13262);
  game.world = world();
  assert.equal(cursor.pendingItemTarget(), undefined, "a new world drops it");
  game.world = live;
  cursor.armItemTarget(live, 13262);
  assert.equal(ground.beginGroundTarget(133), true);
  assert.equal(cursor.pendingItemTarget(), undefined, "the reticle replaces the item cursor");
  const templates = new Map([[2892, { spells: [{ spellId: 2823, trigger: 0 }] }]]);
  ground.requestItemUse({ bag: 255, slot: 23, guid: 0x101n, entry: 2892 }, () => {}, templates,
    new Map([[2823, { requiredTargetMode: 2 }]]));
  assert.equal(ground.pendingGroundTarget(), undefined, "the item cursor replaces the reticle");
  assert.equal(cursor.pendingItemTarget()?.spellId, 2823);
  reset();
});

test("observers follow the cursor up and down once each", () => {
  reset();
  const live = world();
  game.world = live;
  const seen = [];
  const stop = cursor.observeItemTarget((armed) => seen.push(armed));
  cursor.armItemTarget(live, 13262);
  cursor.armItemTarget(live, 31252);
  cursor.cancelItemTarget();
  assert.equal(cursor.cancelItemTarget(), false, "one SpellStopTargeting drops one cursor");
  stop();
  cursor.armItemTarget(live, 13262);
  // L1-review (03.10): the replacing arm is an edge too — Wow.exe 0x0080cce0 raises 0x0053b480
  // (CURRENT_SPELL_CAST_CHANGED) on every arm, which hides a question asked for the spell it replaced.
  assert.deepEqual(seen, [true, true, false]);
  reset();
});

test("a book spell with the item contract raises the cursor through requestSpellCast", () => {
  reset();
  const live = world({
    state: { selfGuid: 1n, objects: new Map() },
    knownSpells: [{ id: 13262 }],
    cooldownRemaining: () => 0,
  });
  game.world = live;
  game.spells.set(13262, {
    id: 13262, requiredTargetMode: 2, passive: false, hidden: false, startRecoveryTime: 0,
    powerType: 0, powerCost: 0, powerCostPercent: 0,
  });
  let sent = 0;
  ground.requestSpellCast(13262, () => { sent++; });
  assert.equal(sent, 0);
  assert.equal(cursor.pendingItemTarget()?.kind, "spell");
  game.spells.set(13262, { ...game.spells.get(13262), requiredTargetMode: 1 });
  cursor.cancelItemTarget();
  ground.requestSpellCast(13262, () => { sent++; });
  assert.equal(sent, 1, "a unit spell goes out as before");
  reset();
});

test("the trade slot takes a book spell; an item's own spell is refused there", () => {
  reset();
  const live = world();
  game.world = live;
  cursor.armItemTarget(live, 13262);
  assert.equal(cursor.targetTradeSlotWithCursor(live, () => undefined).kind, "sent");
  assert.deepEqual(live.calls, [["castSpellOnTradeSlot", 13262, 0, false]]);
  assert.equal(cursor.pendingItemTarget(), undefined);
  cursor.armItemTarget(live, 2823, { bag: 255, slot: 23, guid: 0x101n });
  assert.deepEqual(cursor.targetTradeSlotWithCursor(live, () => undefined),
    { kind: "refused", error: "SPELL_FAILED_ITEM_ENCHANT_TRADE_WINDOW" });
  assert.equal(live.calls.length, 1, "no doomed packet");
  reset();
});

test("an item spell row not loaded yet is fetched once before deciding; a failed fetch fails open", async () => {
  reset();
  const live = world({ itemTemplates: new Map([[2892, { spells: [{ spellId: 2823, trigger: 0 }] }]]) });
  game.world = live;
  const previous = game.spellMetadataClient;
  let asked = 0;
  game.spellMetadataClient = { async load(ids) { asked += 1; return new Map(ids.map((id) => [id, { id, requiredTargetMode: 2 }])); } };
  try {
    let sent = 0;
    ground.requestItemUse({ bag: 255, slot: 23, guid: 0x101n, entry: 2892 }, () => { sent++; });
    assert.equal(sent, 0, "the first click on a poison does not send a targetless use");
    await new Promise(setImmediate);
    assert.equal(asked, 1);
    assert.equal(sent, 0);
    assert.equal(cursor.pendingItemTarget()?.spellId, 2823, "decided once the row arrived");
    cursor.cancelItemTarget();
    game.spells.clear();
    game.spellMetadataClient = { async load() { throw new Error("offline"); } };
    ground.requestItemUse({ bag: 255, slot: 23, guid: 0x101n, entry: 2892 }, () => { sent++; });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.equal(sent, 1, "no row: the plain use goes out, as before");
    assert.equal(cursor.pendingItemTarget(), undefined);
  } finally {
    game.spellMetadataClient = previous;
    reset();
  }
});

let dbcDirectory;
try { dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory(); } catch { dbcDirectory = undefined; }
const DBC_SKIP = dbcDirectory !== undefined && existsSync(join(dbcDirectory, "Spell.dbc"))
  ? false : "no tswow dataset Spell.dbc on this machine";

test("real Spell.dbc rows: poisons, stones, disenchant, prospect, mill, feed pet, sockets raise the cursor", { skip: DBC_SKIP }, async () => {
  const { openDbcFile } = await import("../dist/code/gateway/Dbc.js");
  const { spellRequiredTargeting } = await import("../dist/code/gateway/SpellMetadata.js");
  const spells = await openDbcFile(dbcDirectory, "Spell");
  const mode = (id) => {
    const row = spells.rowOf(id);
    assert.notEqual(row, undefined, `Spell.dbc has ${id}`);
    return spellRequiredTargeting(spells.int(row, "Targets")).requiredTargetMode;
  };
  for (const id of [2823, 2828, 13262, 31252, 51005, 6991, 55628]) {
    assert.equal(cursor.isItemTargetSpell({ requiredTargetMode: mode(id) }), true, `spell ${id} waits for an item`);
  }
  // Skinning and herb gathering are unit casts; Pick Lock (GAMEOBJECT_ITEM) is not in this contract yet.
  for (const id of [8613, 32605, 1804]) {
    assert.equal(cursor.isItemTargetSpell({ requiredTargetMode: mode(id) }), false, `spell ${id} does not`);
  }
  // Every row with Targets & ITEM gets the Item mode (the probe's 768 of 768).
  let itemRows = 0;
  let itemMode = 0;
  for (const row of spells.rows()) {
    const targets = spells.int(row, "Targets") >>> 0;
    if ((targets & 0x10) === 0) continue;
    itemRows += 1;
    if (spellRequiredTargeting(targets).requiredTargetMode === cursor.ITEM_TARGET_MODE) itemMode += 1;
  }
  assert.ok(itemRows > 0);
  assert.equal(itemMode, itemRows);
});
