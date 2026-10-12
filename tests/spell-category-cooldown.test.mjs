import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { castFailedPacket, cooldownEventPacket, initialSpellsPacket, settle, spellGoPacket, travelClient } from "./fixtures/world-packets.mjs";

// Plan item 3.39 (12.10): a category cooldown started mid-session holds its neighbours. Wow.exe 3.3.5a 12340
// (read-only Ghidra, 2026-10-12): the GO handler 0x0080e1b0 files the player's own cast into the history with
// RecoveryTime, Category (+0x4) and CategoryRecoveryTime — an item cast with the item's own numbers, the row's where
// the item's is negative (0x0080fa69…0x0080fc37) — held when 0x00801220 says the cooldown starts on an event; the
// cooldown event (0x00804010 → 0x00802970) starts a held entry's parts; 0x00807980 holds every spell whose Category
// is an entry's. SMSG_SPELL_COOLDOWN (0x00806dd0) files a category part only for a duration of 0. And 5.30: an item
// use is a request of the same builder (0x0080ac90, item branch → 0x0080b349): UNIT_SPELLCAST_SENT and the
// predicted global cooldown of the item's spell.
// The rows are the dataset's Spell.dbc values (read 2026-10-12): Category, RecoveryTime, CategoryRecoveryTime,
// StartRecoveryCategory/Time, and SPELL_ATTR0_DISABLED_WHILE_ACTIVE or SpellCategory.Flags 4.

const { spellCooldownParts, itemUseSpellId } = await import("../dist/code/world/SpellCooldownParts.js");

const SELF = 0x10n;
const row = (category, recoveryTime, categoryRecoveryTime, cooldownStartedOnEvent = false, extra = {}) =>
  ({ category, recoveryTime, categoryRecoveryTime, cooldownStartedOnEvent, ...extra });
const ROWS = new Map([
  [71, row(47, 0, 1000)], // Оборонительная стойка
  [2457, row(47, 0, 1000)], // Боевая стойка
  [2458, row(47, 0, 1000)], // Стойка берсерка
  [17534, row(4, 0, 10_000, true)], // the healing potion of 13446: category 4, SpellCategory.Flags 4
  [17531, row(4, 0, 60_000, true)], // the mana potion of 13444
  [8690, row(1176, 0, 1_800_000, false, { startRecoveryCategory: 133, startRecoveryTime: 1500 })], // Камень возвращения
]);

test("the parts a GO files, as Wow.exe 0x0080e1b0 files them", () => {
  assert.deepEqual(spellCooldownParts(ROWS.get(71), undefined),
    { recovery: 0, category: 47, categoryDuration: 1000, onEvent: false }, "a spell cast: the row's");
  const potion = { cooldown: -1, category: 4, categoryCooldown: 60_000 };
  assert.deepEqual(spellCooldownParts(ROWS.get(17534), potion),
    { recovery: 0, category: 4, categoryDuration: 60_000, onEvent: true }, "an item cast: the item's numbers");
  assert.deepEqual(spellCooldownParts(ROWS.get(17534), { cooldown: 5000, category: 0, categoryCooldown: -1 }),
    { recovery: 5000, category: 4, categoryDuration: 10_000, onEvent: true }, "a negative or a category below 1: the row's");
  assert.deepEqual(spellCooldownParts(undefined, potion),
    { recovery: 0, category: 4, categoryDuration: 60_000, onEvent: false }, "no row: the item's alone");
  assert.equal(spellCooldownParts(undefined, undefined), undefined, "nothing known");
  // A gateway before v=19 serves no Category: the category the login's history named stands in.
  assert.equal(spellCooldownParts({ recoveryTime: 0, categoryRecoveryTime: 1000, cooldownStartedOnEvent: false }, undefined, 5).category, 5);
  assert.equal(spellCooldownParts({ recoveryTime: 0, categoryRecoveryTime: 1000, cooldownStartedOnEvent: false }, undefined).category, 0);
  // What an item use casts: the first use trigger (0 on use, 4 soulstone, 5 no delay, 6 learning), never equip (1).
  assert.equal(itemUseSpellId({ spells: [{ spellId: 9, trigger: 1 }, { spellId: 17534, trigger: 0 }] }), 17534);
  assert.equal(itemUseSpellId({ spells: [{ spellId: 9, trigger: 1 }, { spellId: 0, trigger: 0 }] }), undefined);
  assert.equal(itemUseSpellId(undefined), undefined);
});

// ---- the gateway's column (`/dbc/spells?v=19`) ----

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };
const { DBC_LAYOUTS } = await import("../dist/code/generated/dbcLayouts.js");
const { parseSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");

/** A WDBC image of `fields` 32-bit words a record. */
function image(fields, records) {
  const recordSize = fields * 4;
  const out = Buffer.alloc(20 + records.length * recordSize + 1);
  out.write("WDBC", 0, "latin1");
  out.writeUInt32LE(records.length, 4);
  out.writeUInt32LE(fields, 8);
  out.writeUInt32LE(recordSize, 12);
  out.writeUInt32LE(1, 16);
  records.forEach((words, index) => words.forEach((word, column) => out.writeInt32LE(word | 0, 20 + index * recordSize + column * 4)));
  return out;
}
/** A Spell.dbc record: Category 1, RecoveryTime 29, CategoryRecoveryTime 30 (tools/dbd, DBCStructure.h). */
function spell(id, columns) {
  const words = Array(DBC_LAYOUTS.Spell.fieldCount).fill(0);
  words[0] = id;
  for (const [index, value] of Object.entries(columns)) words[Number(index)] = value;
  return words;
}
const SPELLS = [spell(17531, { 1: 4, 30: 60_000 }), spell(71, { 1: 47, 30: 1000 }), spell(133, {})];
const empty = (table) => image(DBC_LAYOUTS[table].fieldCount, []);

test("v=19 rows: Spell.dbc Category, raw, on every row (0 included); the route serves it", async () => {
  const parsed = parseSpellMetadata(image(DBC_LAYOUTS.Spell.fieldCount, SPELLS), empty("SpellIcon"));
  assert.deepEqual([17531, 71, 133].map((id) => [parsed.get(id).category, parsed.get(id).categoryRecoveryTime]),
    [[4, 60_000], [47, 1000], [0, 0]]);
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const directory = await mkdtemp(join(tmpdir(), "339-dbc-"));
  await writeFile(join(directory, "Spell.dbc"), image(DBC_LAYOUTS.Spell.fieldCount, SPELLS));
  for (const table of ["SpellIcon", "SpellDuration", "SpellRadius", "SpellCategory", "SpellRange", "SpellCastTimes"]) {
    await writeFile(join(directory, `${table}.dbc`), empty(table));
  }
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"], dbcDirectory: directory,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/dbc/spells?ids=17531,133&v=19`,
      { headers: { origin: "http://127.0.0.1:5173" } });
    assert.equal(response.status, 200);
    const served = new Map((await response.json()).map((entry) => [entry.id, entry]));
    assert.deepEqual([served.get(17531).category, served.get(133).category], [4, 0]);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("served Category matches Spell.dbc on every row of the dataset", withDataset, async () => {
  const [{ openDbcFile }, { loadSpellMetadata }] = await Promise.all([
    import("../dist/code/gateway/Dbc.js"), import("../dist/code/gateway/SpellMetadata.js"),
  ]);
  const [spells, metadata] = await Promise.all([openDbcFile(dbcDirectory, "Spell"), loadSpellMetadata(dbcDirectory)]);
  let rows = 0;
  for (const entry of spells.rows()) {
    const served = metadata.get(spells.id(entry));
    if (!served) continue;
    rows += 1;
    assert.equal(served.category, spells.int(entry, "Category"), `spell ${spells.id(entry)}`);
  }
  assert.ok(rows >= 49_839, `${rows} rows`);
  const at = (id) => metadata.get(id);
  assert.deepEqual([17534, 17531].map((id) => [at(id).category, at(id).cooldownStartedOnEvent]), [[4, true], [4, true]],
    "the potions share category 4, whose SpellCategory.Flags 4 starts it on the event");
  assert.deepEqual([71, 2457, 2458].map((id) => [at(id).category, at(id).categoryRecoveryTime]), [[47, 1000], [47, 1000], [47, 1000]],
    "the warrior's stances share category 47's second");
});

// ---- the world ----

/** A client that knows the stances, with the page's rows registered as EnterWorld.ts registers them. */
async function stanceClient(rows = ROWS, spells = [71, 2457, 2458]) {
  const { client, connection } = await travelClient([
    { opcode: OPCODES.SMSG_INITIAL_SPELLS, payload: initialSpellsPacket({ spells }) },
  ], SELF);
  client.spellCooldownRow = (spellId) => rows.get(spellId);
  return { client, connection };
}

const goFor = (connection, spellId, opcode = OPCODES.CMSG_CAST_SPELL) => {
  const request = connection.sentOf(opcode).at(-1);
  // CMSG_CAST_SPELL: u8 count first; CMSG_USE_ITEM: bag, slot, then the count.
  return opcode === OPCODES.CMSG_USE_ITEM ? request.payload[2] : request.payload[0];
};

test("a stance's GO files category 47: the other stances wait the realm's second, then the reset frees them", async () => {
  const { client, connection } = await stanceClient();
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { spellCastBlockReason } = await import("../dist/code/browser/SpellCastGuard.js");
  const saved = { world: game.world, spells: game.spells, gcd: game.globalCooldownUntil };
  try {
    client.castSpell(71); // no duration from the caller: Оборонительная стойка has no recovery of its own
    const castId = goFor(connection, 71);
    assert.equal(client.cooldownRemaining(2457), 0, "nothing before the realm's GO");
    const before = performance.now();
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: SELF, castId, spellId: 71 }));
    await settle();
    const remaining = client.cooldownRemaining(2457);
    assert.ok(remaining > 800 && remaining <= 1000, `Боевая стойка is held by category 47: ${remaining}`);
    assert.ok(client.cooldownRemaining(2458) > 800, "Стойка берсерка too");
    assert.ok(client.cooldownRemaining(71) > 800, "and the stance itself, by its category part");
    assert.equal(client.spellCategories.get(71), 47, "the entry is filed under its category");
    const end = client.categoryCooldowns.get(47);
    assert.ok(end >= before + 1000);
    const sweep = client.cooldownState(2457);
    assert.deepEqual([sweep?.duration, sweep?.endsAt], [1000, end],
      "a sibling's sweep is the category part's own (0x00807980 answers the entry's start and length)");
    // The press is refused at home, the way a spell on its own cooldown is (SpellCastGuard.ts).
    game.world = client;
    game.spells = new Map([...ROWS].map(([id, columns]) => [id, { id, name: `spell ${id}`, passive: false, powerType: 1,
      powerCost: 0, powerCostPercent: 0, schoolMask: 1, startRecoveryTime: 0, ...columns }]));
    game.globalCooldownUntil = 0;
    assert.equal(spellCastBlockReason(client, 2457), "cooldown");
    // SMSG_CLEAR_COOLDOWN of the stance that filed it: EraseCooldown takes the category with it (3.37(б)).
    connection.push(OPCODES.SMSG_CLEAR_COOLDOWN, cooldownEventPacket(71, SELF));
    await settle();
    assert.deepEqual([client.cooldownRemaining(2457), client.cooldownState(2457), client.categoryCooldowns.has(47)], [0, undefined, false]);
    assert.equal(spellCastBlockReason(client, 2457), undefined);
  } finally {
    game.world = saved.world;
    game.spells = saved.spells;
    game.globalCooldownUntil = saved.gcd;
    client.close();
  }
});

test("a row without Category (a gateway before v=19) files nothing beyond the caller's duration, as before 3.39", async () => {
  const old = new Map([...ROWS].map(([id, { category, ...columns }]) => [id, columns]));
  const { client, connection } = await stanceClient(old);
  try {
    client.castSpell(71, 1000);
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: SELF, castId: goFor(connection, 71), spellId: 71 }));
    await settle();
    assert.ok(client.cooldownRemaining(71) > 800, "the caller's own duration");
    assert.equal(client.cooldownRemaining(2457), 0);
    assert.equal(client.categoryCooldowns.size, 0);
  } finally {
    client.close();
  }
});

test("SMSG_SPELL_COOLDOWN with a duration files no category part (0x00806dd0: only for 0)", async () => {
  const { client, connection } = await stanceClient();
  try {
    connection.push(OPCODES.SMSG_SPELL_COOLDOWN, new PacketWriter().u64(SELF).u8(0).u32(71).u32(5000).toUint8Array());
    await settle();
    assert.ok(client.cooldownRemaining(71) > 4000);
    assert.equal(client.cooldownRemaining(2457), 0);
  } finally {
    client.close();
  }
});

/** Two potions in the backpack's first two squares (bag 255, slots 23 and 24), and the templates the realm sent. */
const POTION_A = 0x4000_0000_0000_0a01n;
const POTION_B = 0x4000_0000_0000_0a02n;
const STONE = 0x4000_0000_0000_0a03n;
function carry(client, items) {
  const player = client.state.objects.get(SELF);
  items.forEach(([guid, entry], index) => {
    const offset = UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + index * 2;
    player.fields.set(offset, Number(guid & 0xffff_ffffn));
    player.fields.set(offset + 1, Number(guid >> 32n));
    client.state.objects.set(guid, { guid, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry]]) });
  });
}
const itemSpell = (spellId, cooldown, category, categoryCooldown) =>
  ({ spellId, trigger: 0, charges: 1, cooldown, category, categoryCooldown });
const template = (entry, spells) => ({ entry, found: true, flags: 0, spells });

test("the second potion: the GO holds category 4 until the cooldown event, which starts the item's minute", async () => {
  const { client, connection } = await stanceClient();
  const sent = [];
  client.events.on("SPELL_CAST_SENT", (event) => sent.push(event));
  try {
    carry(client, [[POTION_A, 13446], [POTION_B, 13444]]);
    // The item cache's numbers (SMSG_ITEM_QUERY_SINGLE_RESPONSE): the category's minute, over the row's 10 s.
    client.itemTemplates.set(13446, template(13446, [itemSpell(17534, -1, 4, 60_000)]));
    client.itemTemplates.set(13444, template(13444, [itemSpell(17531, -1, 4, 60_000)]));
    client.useItem(255, 23, POTION_A);
    const castId = goFor(connection, 17534, OPCODES.CMSG_USE_ITEM);
    assert.deepEqual(sent, [{ spellId: 17534, castCount: castId }], "5.30: the item use is a request (0x0080ac90)");
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: POTION_A, casterUnit: SELF, castId, spellId: 17534 }));
    await settle();
    // In combat the realm starts nothing (HandleCooldowns: SetLastPotionId) and refuses the next potion
    // NOT_READY (Spell.cpp:5414); Wow.exe's GO filed the entry held, category 4 with it.
    assert.equal(client.isSpellOnHold(17534), true);
    assert.equal(client.isSpellOnHold(17531), true, "the other potion is held: its row's Category is 4 too");
    assert.equal(client.cooldownRemaining(17531), 0, "held, not counting down");
    assert.equal(client.isSpellOnHold(71), false, "another category is not");
    // Out of combat: Player::UpdatePotionCooldown → SendCooldownEvent.
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(17534, SELF));
    await settle();
    assert.equal(client.isSpellOnHold(17531), false);
    const sibling = client.cooldownRemaining(17531);
    assert.ok(sibling > 59_000 && sibling <= 60_000, `the item's minute, not the row's 10 s: ${sibling}`);
    assert.equal(client.cooldownState(17531)?.duration, 60_000);
    assert.ok(client.cooldownRemaining(17534) > 59_000, "and the potion drunk");
    connection.push(OPCODES.SMSG_CLEAR_COOLDOWN, cooldownEventPacket(17534, SELF));
    await settle();
    assert.equal(client.cooldownRemaining(17531), 0, "a reset frees the category");
  } finally {
    client.close();
  }
});

test("a stealth's GO holds it until its event, which starts its parts; a GO after its event holds nothing", async () => {
  // Незаметность 1784: SPELL_ATTR0_DISABLED_WHILE_ACTIVE, Category 38 with 10 s (the realm holds it in silence while
  // the aura lasts, SpellAuras.cpp:571-577, and sends the event when it ends).
  const rows = new Map([...ROWS, [1784, row(38, 0, 10_000, true)]]);
  const { client, connection } = await stanceClient(rows, [1784]);
  try {
    client.castSpell(1784, 10_000, true);
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: SELF, castId: goFor(connection, 1784), spellId: 1784 }));
    await settle();
    assert.deepEqual([client.isSpellOnHold(1784), client.cooldownRemaining(1784)], [true, 0], "held from the GO, no timer");
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(1784, SELF));
    await settle();
    const remaining = client.cooldownRemaining(1784);
    assert.equal(client.isSpellOnHold(1784), false);
    assert.ok(remaining > 9_000 && remaining <= 10_000, `the held entry's 10 s from the event (0x00802970): ${remaining}`);
    connection.push(OPCODES.SMSG_CLEAR_COOLDOWN, cooldownEventPacket(1784, SELF));
    await settle();
    // The event can beat the GO: it starts the timer, and the GO it answered holds nothing after it.
    client.castSpell(1784, 10_000, true);
    const castId = goFor(connection, 1784);
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(1784, SELF));
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: SELF, castId, spellId: 1784 }));
    await settle();
    assert.equal(client.isSpellOnHold(1784), false, "no hold behind a running timer");
    assert.ok(client.cooldownRemaining(1784) > 9_000);
  } finally {
    client.close();
  }
});

test("a cooldown event the client did not see coming files its row's category too (EnterWorld's own timer path)", async () => {
  const { client, connection } = await stanceClient();
  // EnterWorld.ts: the own timer from the row, max(RecoveryTime, CategoryRecoveryTime).
  client.onCooldownEvent = (spellId) => client.startLocalCooldown(spellId,
    Math.max(ROWS.get(spellId).recoveryTime, ROWS.get(spellId).categoryRecoveryTime));
  try {
    connection.push(OPCODES.SMSG_COOLDOWN_EVENT, cooldownEventPacket(17531, SELF));
    await settle();
    assert.ok(client.cooldownRemaining(17531) > 59_000);
    const sibling = client.cooldownRemaining(17534);
    assert.ok(sibling > 59_000 && sibling <= 60_000, `the drunk potion's category holds the other: ${sibling}`);
  } finally {
    client.close();
  }
});

test("5.30: an item use predicts the global cooldown of its spell; a refusal takes it back, the GO confirms it", async () => {
  const { attachPredictedGlobalCooldown } = await import("../dist/code/browser/game/PredictedGlobalCooldown.js");
  const { client, connection } = await stanceClient();
  const sink = { globalCooldownUntil: 0 };
  let clock = 50_000;
  const offs = attachPredictedGlobalCooldown(client, sink, () => ROWS, () => true, () => clock);
  const accepted = [];
  client.events.on("SPELL_CAST_ACCEPTED", (event) => accepted.push(event.castId));
  try {
    carry(client, [[STONE, 6948], [POTION_B, 13444]]);
    client.itemTemplates.set(6948, template(6948, [itemSpell(8690, -1, 0, -1)]));
    client.itemTemplates.set(13444, template(13444, [itemSpell(17531, -1, 4, 60_000)]));
    client.useItem(255, 23, STONE);
    assert.equal(sink.globalCooldownUntil, 51_500, "Камень возвращения (133/1500): from the press");
    const first = goFor(connection, 8690, OPCODES.CMSG_USE_ITEM);
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: first, spellId: 8690, result: 40 }));
    await settle();
    assert.equal(sink.globalCooldownUntil, 0, "the realm's refusal of the use takes it back");
    clock = 60_000;
    client.useItem(255, 23, STONE);
    const second = goFor(connection, 8690, OPCODES.CMSG_USE_ITEM);
    clock = 60_200;
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: STONE, casterUnit: SELF, castId: second, spellId: 8690 }));
    await settle();
    assert.deepEqual(accepted, [second], "the GO answers the item's request");
    assert.equal(sink.globalCooldownUntil, 61_500, "and confirms the end without moving it");
    // 3.39: the GO filed the item cast's entry — the row's category and its half hour (the item's are -1, 0).
    assert.ok(client.cooldownRemaining(8690) > 1_700_000, "Камень возвращения: category 1176's 30 minutes");
    // A potion (0/0) predicts nothing; an item with no use spell is no spell request.
    client.useItem(255, 24, POTION_B);
    assert.equal(sink.globalCooldownUntil, 61_500);
    client.itemTemplates.set(6948, template(6948, [{ ...itemSpell(8690, -1, 0, -1), trigger: 1 }]));
    const seen = [];
    client.events.on("SPELL_CAST_SENT", (event) => seen.push(event.spellId));
    client.useItem(255, 23, STONE);
    assert.deepEqual(seen, [], "an equip-only item: CMSG_USE_ITEM, and no UNIT_SPELLCAST_SENT");
    // A key or a pick on a chest names the object, as castSpellOnGameObject does.
    const CHEST = 0xf110_0000_0000_0042n;
    client.state.objects.set(CHEST, { guid: CHEST, typeId: 5, fields: new Map() });
    const named = [];
    client.events.on("SPELL_CAST_SENT", (event) => named.push(event));
    assert.equal(client.useItemOnGameObject(255, 24, POTION_B, 17531, CHEST), true);
    assert.deepEqual(named.map(({ spellId, targetGuid }) => [spellId, targetGuid]), [[17531, CHEST]]);
  } finally {
    for (const off of offs) off();
    client.close();
  }
});
