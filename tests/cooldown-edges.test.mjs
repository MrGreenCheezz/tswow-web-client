import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { cooldownEventPacket, initialSpellsPacket, settle, travelClient } from "./fixtures/world-packets.mjs";

// 3.37 (WORK_PLAN; found by the P1-16 review, 07.10): the cooldown holes of the world and the
// stock bar. (а) a hold's release raised no redraw, so a held button stayed grey; (б) a reset or a
// shortened timer left its category's shared lockout behind, and a new spell list kept old ones;
// (в) an item slot whose timer has no snapshot of its own (a category lockout) heard no end.
// (г) — the vehicle's sweeps on 121–126 — is in framexml-vehicle.test.mjs.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { ACTION_BUTTON_ITEM, ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");

const SELF = 0x1234n;
const STEALTH = 1784;
const POTION = 13446;
const POTION_SPELL = 17534;
/** Healing potions' category (Spell.dbc Category 4): one potion locks out the others. */
const POTIONS = 4;
const OTHER_POTION_SPELL = 17531;

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const CD = FRAMEXML_SEAM_EVENTS.actionCooldown;
const US = FRAMEXML_SEAM_EVENTS.actionUsable;
const SPELL_CD = FRAMEXML_SEAM_EVENTS.spellUpdateCooldown;

/** The live seam over a world double whose timers, holds and categories follow WorldClient's rules. */
function fixture() {
  const fired = [];
  const clock = { monotonic: 100_000, lua: 500 };
  const potion = { guid: 2n, typeId: 1, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, POTION], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 3],
  ]) };
  const player = { guid: 1n, typeId: 4, fields: new Map([[UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 2]]) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player], [2n, potion]]) },
    knownSpells: [{ id: STEALTH, slot: 0 }],
    actionButtons: [
      { slot: 0, action: POTION, type: ACTION_BUTTON_ITEM },
      { slot: 12, action: STEALTH, type: ACTION_BUTTON_SPELL },
    ],
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(),
    cooldownHolds: new Map(), categoryCooldowns: new Map(),
    spellCategories: new Map([[POTION_SPELL, POTIONS], [OTHER_POTION_SPELL, POTIONS]]),
    itemTemplates: new Map([[POTION, { found: true, entry: POTION, quality: 1, name: "Зелье", stackable: 20,
      spells: [{ spellId: POTION_SPELL, trigger: 0 }] }]]),
    // WorldClient.cooldownRemaining and isSpellOnHold, over the same maps.
    cooldownRemaining(id, now) {
      const own = (world.cooldownSnapshots.get(id)?.endsAt ?? 0) - now;
      const category = world.spellCategories.get(id);
      const shared = category === undefined ? 0 : (world.categoryCooldowns.get(category) ?? 0) - now;
      return Math.max(0, own, shared);
    },
    cooldownState: (id) => world.cooldownSnapshots.get(id),
    isSpellOnHold(id) {
      if (world.cooldownHolds.has(id)) return true;
      const category = world.spellCategories.get(id);
      return category !== undefined && [...world.cooldownHolds.values()].includes(category);
    },
    isActiveMountSpell: () => false,
    events: { on: () => () => {} },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined,
    // 19.10: Spell.dbc 1784's attribute words: SPELL_ATTR0_DISABLED_WHILE_ACTIVE (0x2000000) is the gate a hold greys by.
    spell: (id) => (id === STEALTH
      ? { id, name: "Незаметность", rank: "", iconPath: "", passive: false, attributes: [0x1a150010, 0x10, 0x200000, 0x4000000, 0, 0, 0, 0] } : undefined),
    monotonic: () => clock.monotonic, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const pump = { now: () => clock.lua, fire: (name, ...args) => { fired.push([name, ...args]); return 1; } };
  const count = (name) => fired.filter(([event]) => event === name).length;
  // The seam's reads run on its 60 ms poll (LIVE_POLL_SECONDS): each tick is a tenth of a second on.
  const tick = () => { clock.lua += 0.1; clock.monotonic += 100; seam.tick(clock.lua); };
  return { seam, world, fired, clock, pump, count, tick };
}

test("3.37(а): a held bar spell's release redraws its button and the book once, with no timer behind it", () => {
  const { seam, world, fired, pump, count, tick } = fixture();
  world.cooldownHolds.set(STEALTH, 0);
  seam.attach(pump);
  tick();
  assert.deepEqual(call(seam, "IsUsableAction", 13), [false, false], "held: refused, grey");
  // 3.39 (12.10): `enable` 0, so nothing to sweep, with Wow.exe 0x00807980's numbers — started now, the held entry's
  // 1 ms (this double files no parts: WorldClient.heldCooldown's fallback).
  assert.deepEqual(call(seam, "GetActionCooldown", 13), [500.1, 0.001, 0], "and nothing to sweep");
  fired.length = 0;
  tick();
  assert.equal(count(CD) + count(US) + count(SPELL_CD), 0, "a hold that stays is no news");

  // SMSG_CLEAR_COOLDOWN (or a COOLDOWN_EVENT whose handler started nothing): the hold is gone.
  world.cooldownHolds.delete(STEALTH);
  tick();
  assert.deepEqual(call(seam, "IsUsableAction", 13), [true, false]);
  assert.equal(count(US), 1, "ActionButton_UpdateUsable repaints the icon");
  assert.equal(count(CD), 1, "the pair stays a pair");
  assert.equal(count(SPELL_CD), 1, "the spellbook's grey goes too");
  fired.length = 0;
  tick();
  assert.equal(count(CD) + count(US) + count(SPELL_CD), 0, "once");

  // A new hold (a re-sent spell list) is an edge as well.
  world.cooldownHolds.set(STEALTH, 0);
  tick();
  assert.equal(count(US), 1);
  assert.equal(count(SPELL_CD), 1);
  seam.detach();
});

test("3.37(в): an item slot under a category lockout with no snapshot of its own hears the lockout end", () => {
  const { seam, world, fired, clock, pump, count, tick } = fixture();
  // SMSG_INITIAL_SPELLS: another potion was drunk before the login; this potion's slot is locked by
  // the category alone.
  world.categoryCooldowns.set(POTIONS, 101_000);
  seam.attach(pump);
  tick();
  const [, duration, enable] = call(seam, "GetActionCooldown", 1);
  assert.equal(enable, 1);
  assert.ok(duration > 0, "the slot sweeps the shared lockout");
  // 19.10: and stays usable under it — UpdateUsableAction (0x005a9e20) greys an item for a hold only (0x0080ac10).
  assert.deepEqual(call(seam, "IsUsableAction", 1), [true, false]);
  fired.length = 0;
  clock.monotonic = 100_500;
  clock.lua = 500.5;
  tick();
  assert.equal(count(CD) + count(US), 0, "the countdown itself is reads");
  clock.monotonic = 101_001;
  clock.lua = 501.001;
  tick();
  // 3.47 (12.10): ready, `enable` 1 as 0x00807980 sets it (was 0, 0, 0).
  assert.deepEqual(call(seam, "GetActionCooldown", 1), [0, 0, 1]);
  assert.deepEqual(call(seam, "IsUsableAction", 1), [true, false]);
  assert.equal(count(CD), 1, "the end redraws the sweep");
  assert.equal(count(US), 1, "and the icon");
  fired.length = 0;
  tick();
  assert.equal(count(CD) + count(US), 0, "once");
  seam.detach();
});

/** `SMSG_MODIFY_COOLDOWN` — `SpellHistory::ModifyCooldown` (SpellHistory.cpp:409-430): `u32 spell, u64 owner, i32 ms`. */
function modifyCooldownPacket(spellId, guid, delta) {
  return new PacketWriter().u32(spellId).u64(guid).i32(delta).toUint8Array();
}

/** A potion drunk before the login: its own record carries the category's 60 s lockout. */
const lockedList = () => initialSpellsPacket({
  spells: [POTION_SPELL, OTHER_POTION_SPELL],
  cooldowns: [
    { spellId: POTION_SPELL, categoryId: POTIONS, cooldown: 0, categoryCooldown: 60_000 },
    { spellId: OTHER_POTION_SPELL, categoryId: POTIONS, cooldown: 0, categoryCooldown: 0 },
  ],
});

test("3.37(б): a reset drops the category lockout with the spell's entry (SpellHistory::EraseCooldown)", async () => {
  const { client, connection } = await travelClient([], SELF);
  try {
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, lockedList());
    await settle();
    assert.ok(client.cooldownRemaining(OTHER_POTION_SPELL) > 59_000, "the sibling is locked by the category");
    connection.push(OPCODES.SMSG_CLEAR_COOLDOWN, cooldownEventPacket(POTION_SPELL, SELF));
    await settle();
    assert.equal(client.cooldownRemaining(POTION_SPELL), 0);
    assert.equal(client.cooldownRemaining(OTHER_POTION_SPELL), 0, "the core casts it now (HasCooldown finds no category entry)");
    assert.equal(client.categoryCooldowns.has(POTIONS), false);
  } finally {
    client.close();
  }
});

test("3.37(б): a modification past now erases the entry and its lockout; a shorter one keeps the lockout", async () => {
  const { client, connection } = await travelClient([], SELF);
  try {
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, lockedList());
    await settle();
    connection.push(OPCODES.SMSG_MODIFY_COOLDOWN, modifyCooldownPacket(POTION_SPELL, SELF, -1_000));
    await settle();
    assert.ok(client.cooldownRemaining(OTHER_POTION_SPELL) > 58_000, "ModifyCooldown moves CooldownEnd only");
    connection.push(OPCODES.SMSG_MODIFY_COOLDOWN, modifyCooldownPacket(POTION_SPELL, SELF, -120_000));
    await settle();
    assert.equal(client.cooldownRemaining(POTION_SPELL), 0);
    assert.equal(client.cooldownRemaining(OTHER_POTION_SPELL), 0, "past now: EraseCooldown, the category too");
  } finally {
    client.close();
  }
});

test("3.37(б): a new spell list is the whole history — a lockout it does not carry is gone", async () => {
  const { client, connection } = await travelClient([], SELF);
  try {
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, lockedList());
    await settle();
    assert.ok(client.cooldownRemaining(OTHER_POTION_SPELL) > 0);
    connection.push(OPCODES.SMSG_INITIAL_SPELLS, initialSpellsPacket({ spells: [POTION_SPELL, OTHER_POTION_SPELL] }));
    await settle();
    assert.equal(client.categoryCooldowns.size, 0);
    assert.equal(client.cooldownRemaining(OTHER_POTION_SPELL), 0);
  } finally {
    client.close();
  }
});
