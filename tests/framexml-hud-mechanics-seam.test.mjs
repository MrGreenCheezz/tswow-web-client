import assert from "node:assert/strict";
import test from "node:test";

// The totem bar, the hit indicator and the temporary weapon enchants over a fake world
// (FrameXmlHudMechanicsLive.ts through LiveWorldSeam), and the two packets WorldClient sends.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FrameXmlHudMechanicsLive } = await import("../dist/code/browser/framexml/FrameXmlHudMechanicsLive.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { HITINFO_AFFECTS_VICTIM, VICTIMSTATE_DODGE } = await import("../dist/code/world/CombatProtocol.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(name);
    };
  }

  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }

  listenerCount(name) {
    return this.#listeners.get(name)?.size ?? 0;
  }
}

const ENCHANT = UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset;
const TEMP = ENCHANT + 1 * 3;
const INVENTORY = UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset;
const MAINHAND_GUID = 0x400000000000abcdn;
const OFFHAND_GUID = 0x400000000000abcen;
const STONESKIN = 58753;

function fixture() {
  const selfGuid = 0x10n;
  const targetGuid = 0x20n;
  const events = new FakeEvents();
  const player = { guid: selfGuid, typeId: 4, fields: new Map() };
  const target = { guid: targetGuid, typeId: 3, fields: new Map() };
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, player], [targetGuid, target]]) },
    targetGuid,
    auras: new Map(),
    aurasFor: () => [],
    events,
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    names: new Map(),
    creatureTemplates: new Map(),
    totems: new Map(),
    destroyTotem: (slot) => destroyed.push(slot),
    cancelTempEnchantment: (slot) => cancelled.push(slot),
  };
  const destroyed = [];
  const cancelled = [];
  const fired = [];
  let pumpNow = 100;
  let monotonic = 1000;
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => pumpNow };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => id === STONESKIN
      ? { id, name: "Тотем каменной кожи", rank: "Уровень 10", iconPath: "Interface\\Icons\\Spell_Nature_StoneSkinTotem", passive: false }
      : undefined,
    monotonic: () => monotonic,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  /** Wear an item with a temporary enchant (id, duration in ms, charges) in an equipment slot. */
  const wear = (slot, guid, enchant) => {
    const item = { guid, typeId: 1, fields: new Map() };
    if (enchant) {
      item.fields.set(TEMP, enchant.id);
      item.fields.set(TEMP + 1, enchant.duration ?? 0);
      item.fields.set(TEMP + 2, enchant.charges ?? 0);
    }
    world.state.objects.set(guid, item);
    player.fields.set(INVENTORY + slot * 2, Number(guid & 0xffffffffn));
    player.fields.set(INVENTORY + slot * 2 + 1, Number(guid >> 32n));
    return item;
  };
  return {
    seam, world, events, fired, pump, destroyed, cancelled, selfGuid, targetGuid, call, wear,
    setPumpNow: (value) => { pumpNow = value; },
    setMonotonic: (value) => { monotonic = value; },
  };
}

test("GetTotemInfo/GetTotemTimeLeft follow the packet record in GetTime terms; an empty slot answers numbers", () => {
  const { seam, world, events, fired, pump, call, setMonotonic } = fixture();
  seam.attach(pump);
  assert.deepEqual(call("GetTotemInfo", 2), [false, "", 0, 0, ""]);
  assert.deepEqual(call("GetTotemTimeLeft", 2), [0]);
  assert.deepEqual(call("GetTotemInfo", 5), [false, "", 0, 0, ""], "out-of-range slots are empty, not errors");
  fired.length = 0;

  // SMSG_TOTEM_CREATED: packet slot 1 is the client's slot 2 (earth), duration in milliseconds.
  world.totems.set(1, { guid: 77n, duration: 60_000, spellId: STONESKIN, startedAt: 1000 });
  events.emit("TOTEM_CREATED", { slot: 1, guid: 77n, duration: 60_000, spellId: STONESKIN });
  assert.deepEqual(fired, [["PLAYER_TOTEM_UPDATE", 2]]);
  setMonotonic(4000);
  assert.deepEqual(call("GetTotemInfo", 2),
    [true, "Тотем каменной кожи", 100 - 3, 60, "Interface\\Icons\\Spell_Nature_StoneSkinTotem"]);
  assert.deepEqual(call("GetTotemTimeLeft", 2), [57]);
  assert.deepEqual(call("GetTotemInfo", 1), [false, "", 0, 0, ""], "the other slots stay empty");

  // Expiry: the record is never cleared by the wire, so the countdown is the edge.
  fired.length = 0;
  setMonotonic(1000 + 59_999);
  seam.hudMechanics.tick();
  assert.deepEqual(fired, []);
  setMonotonic(1000 + 60_000);
  seam.hudMechanics.tick();
  assert.deepEqual(fired, [["PLAYER_TOTEM_UPDATE", 2]]);
  assert.deepEqual(call("GetTotemInfo", 2), [false, "", 0, 0, ""]);
  assert.deepEqual(call("GetTotemTimeLeft", 2), [0]);
  seam.hudMechanics.tick();
  assert.deepEqual(fired, [["PLAYER_TOTEM_UPDATE", 2]], "an expired slot is announced once");
  seam.detach();
});

test("a totem whose creature was seen and then destroyed leaves its slot; an unseen one is still coming", () => {
  const { seam, world, events, fired, pump, call, setMonotonic } = fixture();
  seam.attach(pump);
  world.totems.set(0, { guid: 78n, duration: 120_000, spellId: STONESKIN, startedAt: 1000 });
  events.emit("TOTEM_CREATED", { slot: 0, guid: 78n, duration: 120_000, spellId: STONESKIN });
  fired.length = 0;
  // The packet precedes the create block: nothing in the store yet, and that is not a loss.
  seam.hudMechanics.tick();
  assert.deepEqual(fired, []);
  assert.equal(call("GetTotemInfo", 1)[0], true);
  world.state.objects.set(78n, { guid: 78n, typeId: 3, fields: new Map() });
  seam.hudMechanics.tick();
  assert.deepEqual(fired, []);
  world.state.objects.delete(78n);
  setMonotonic(5000);
  seam.hudMechanics.tick();
  assert.deepEqual(fired, [["PLAYER_TOTEM_UPDATE", 1]]);
  assert.deepEqual(call("GetTotemInfo", 1), [false, "", 0, 0, ""]);
  // A recast into the slot is a new record with a new guid: announced, and active again.
  fired.length = 0;
  world.totems.set(0, { guid: 79n, duration: 120_000, spellId: STONESKIN, startedAt: 5000 });
  events.emit("TOTEM_CREATED", { slot: 0, guid: 79n, duration: 120_000, spellId: STONESKIN });
  assert.deepEqual(fired, [["PLAYER_TOTEM_UPDATE", 1]]);
  assert.equal(call("GetTotemInfo", 1)[0], true);
  seam.hudMechanics.tick();
  assert.deepEqual(fired, [["PLAYER_TOTEM_UPDATE", 1]], "the tick after the packet adds no second edge");
  seam.detach();
});

test("DestroyTotem sends the packet slot of an active totem and nothing for an empty slot", () => {
  const { seam, world, events, pump, call, destroyed } = fixture();
  seam.attach(pump);
  call("DestroyTotem", 2);
  assert.deepEqual(destroyed, [], "no totem, no packet");
  world.totems.set(1, { guid: 77n, duration: 60_000, spellId: STONESKIN, startedAt: 1000 });
  events.emit("TOTEM_CREATED", { slot: 1, guid: 77n, duration: 60_000, spellId: STONESKIN });
  call("DestroyTotem", 2);
  call("DestroyTotem", 3);
  call("DestroyTotem", 0);
  assert.deepEqual(destroyed, [1], "the client's slot 2 is the wire's slot 1");
  seam.detach();
});

test("a totem placed before the mount is read by the PLAYER_ENTERING_WORLD refresh, not announced", () => {
  const { seam, world, fired, pump, call } = fixture();
  world.totems.set(3, { guid: 80n, duration: 300_000, spellId: STONESKIN, startedAt: 500 });
  seam.attach(pump);
  seam.hudMechanics.tick();
  assert.deepEqual(fired.filter(([event]) => event === "PLAYER_TOTEM_UPDATE"), []);
  assert.equal(call("GetTotemInfo", 4)[0], true);
  seam.detach();
});

test("an unnamed totem spell is fetched outside the C-API read and repainted once its name arrives", () => {
  const fired = [];
  const prefetched = [];
  const world = { events: new FakeEvents(), state: { selfGuid: 1n, objects: new Map() }, totems: new Map() };
  const spells = new Map();
  const model = new FrameXmlHudMechanicsLive({
    world: () => world, monotonic: () => 0, spell: (id) => spells.get(id), unitGuid: () => undefined,
    prefetchSpells: (ids, onLoaded) => prefetched.push({ ids: [...ids], onLoaded }),
  });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  world.totems.set(2, { guid: 81n, duration: 30_000, spellId: 8071, startedAt: 0 });
  world.events.emit("TOTEM_CREATED", { slot: 2, guid: 81n, duration: 30_000, spellId: 8071 });
  assert.deepEqual(fired, [["PLAYER_TOTEM_UPDATE", 3]]);
  assert.deepEqual(prefetched.map((entry) => entry.ids), [[8071]]);
  assert.deepEqual(model.totemInfo(3), [true, "", 0, 30, ""], "unnamed until the fetch answers");
  spells.set(8071, { name: "Тотем каменной кожи", iconPath: "Interface\\Icons\\Spell_Nature_StoneSkinTotem" });
  prefetched[0].onLoaded();
  assert.deepEqual(fired, [["PLAYER_TOTEM_UPDATE", 3], ["PLAYER_TOTEM_UPDATE", 3]]);
  assert.deepEqual(model.totemInfo(3), [true, "Тотем каменной кожи", 0, 30, "Interface\\Icons\\Spell_Nature_StoneSkinTotem"]);
  model.detach();
  prefetched[0].onLoaded();
  assert.equal(fired.length, 2, "a fetch answered after detach fires nothing");
});

test("UNIT_COMBAT reaches every stock token the target is, worded by the pure mapping, and stops at detach", () => {
  const { seam, events, fired, pump, selfGuid, targetGuid } = fixture();
  seam.attach(pump);
  fired.length = 0;
  const log = (targetGuid, overrides = {}) => ({
    targetGuid, casterGuid: 0x99n, spellId: 133, damage: 1234, overkill: 0, schoolMask: 0x04, absorbed: 0,
    resisted: 0, periodic: false, blocked: 0, hitInfo: 2, critical: true, ...overrides,
  });
  events.emit("UNIT_COMBAT", { source: "spellDamage", log: log(selfGuid) });
  assert.deepEqual(fired, [["UNIT_COMBAT", "player", "WOUND", "CRITICAL", 1234, 4]]);
  fired.length = 0;
  events.emit("UNIT_COMBAT", { source: "spellDamage", log: log(targetGuid, { critical: false, damage: 10 }) });
  assert.deepEqual(fired, [["UNIT_COMBAT", "target", "WOUND", "", 10, 4]]);
  fired.length = 0;
  events.emit("UNIT_COMBAT", { source: "melee", swing: {
    hitInfo: HITINFO_AFFECTS_VICTIM, attacker: targetGuid, victim: selfGuid, damage: 0, overkill: 0,
    victimState: VICTIMSTATE_DODGE, blocked: 0, damages: [{ schoolMask: 1, damage: 0, absorbed: 0, resisted: 0 }],
  } });
  assert.deepEqual(fired, [["UNIT_COMBAT", "player", "DODGE", "", 0, 1]]);
  fired.length = 0;
  events.emit("UNIT_COMBAT", { source: "heal", log: {
    targetGuid: 0x77n, casterGuid: selfGuid, spellId: 2050, amount: 300, overheal: 0, absorbed: 0, critical: false,
  } });
  assert.deepEqual(fired, [], "a unit no stock frame shows gets no event");
  events.emit("UNIT_COMBAT", { source: "periodic", log: {
    targetGuid: selfGuid, casterGuid: 0x99n, spellId: 172, auraType: 53, amount: 0, overAmount: 0, schoolMask: 0,
    absorbed: 0, resisted: 0, critical: false, powerType: undefined,
  } });
  assert.deepEqual(fired, [], "a leech tick shows nothing");
  seam.detach();
  events.emit("UNIT_COMBAT", { source: "spellDamage", log: log(selfGuid) });
  assert.deepEqual(fired, []);
  assert.equal(events.listenerCount("UNIT_COMBAT"), 0);
});

test("GetWeaponEnchantInfo reads the worn weapons' temporary enchant triples; the time packet re-stamps the countdown", () => {
  const { seam, events, pump, call, wear, selfGuid, setMonotonic } = fixture();
  seam.attach(pump);
  assert.deepEqual(call("GetWeaponEnchantInfo"), [false, undefined, undefined, false, undefined, undefined]);

  wear(15, MAINHAND_GUID, { id: 3265, duration: 1_800_000, charges: 0 });
  assert.deepEqual(call("GetWeaponEnchantInfo"), [true, 1_800_000, 0, false, undefined, undefined],
    "a weapon first seen with a duration counts from that sighting");
  setMonotonic(61_000);
  assert.deepEqual(call("GetWeaponEnchantInfo"), [true, 1_740_000, 0, false, undefined, undefined]);

  // SMSG_ITEM_ENCHANT_TIME_UPDATE restates what is left in whole seconds and is authoritative.
  events.emit("ITEM_ENCHANT_TIME_UPDATE", { itemGuid: MAINHAND_GUID, slot: 1, duration: 600, playerGuid: selfGuid, receivedAt: 61_000 });
  assert.deepEqual(call("GetWeaponEnchantInfo"), [true, 600_000, 0, false, undefined, undefined]);
  setMonotonic(71_000);
  assert.deepEqual(call("GetWeaponEnchantInfo"), [true, 590_000, 0, false, undefined, undefined]);
  events.emit("ITEM_ENCHANT_TIME_UPDATE", { itemGuid: MAINHAND_GUID, slot: 0, duration: 5, playerGuid: selfGuid, receivedAt: 71_000 });
  assert.deepEqual(call("GetWeaponEnchantInfo"), [true, 590_000, 0, false, undefined, undefined],
    "another enchantment slot's time is not the temporary one's");
  setMonotonic(700_000);
  assert.deepEqual(call("GetWeaponEnchantInfo"), [true, 0, 0, false, undefined, undefined],
    "past its time the enchant stays until the realm clears the field, with no countdown left");

  // An off-hand poison with charges and no duration has no countdown at all.
  wear(16, OFFHAND_GUID, { id: 2630, duration: 0, charges: 5 });
  assert.deepEqual(call("GetWeaponEnchantInfo"), [true, 0, 0, true, undefined, 5]);
  seam.detach();
});

test("CancelItemTempEnchantment maps the stock 1/2 (and the buttons' 16/17) to equipment slots 15/16 and sends only for a real enchant", () => {
  const { seam, pump, call, wear, cancelled } = fixture();
  seam.attach(pump);
  call("CancelItemTempEnchantment", 1);
  call("CancelItemTempEnchantment", 2);
  assert.deepEqual(cancelled, [], "nothing worn, nothing sent");
  wear(15, MAINHAND_GUID, { id: 3265, duration: 1_800_000, charges: 0 });
  wear(16, OFFHAND_GUID, undefined);
  call("CancelItemTempEnchantment", 1);
  call("CancelItemTempEnchantment", 2);
  call("CancelItemTempEnchantment", 16);
  call("CancelItemTempEnchantment", 17);
  call("CancelItemTempEnchantment", 3);
  assert.deepEqual(cancelled, [15, 15], "the off hand carries no temporary enchant");
  seam.detach();
});

test("UNIT_INVENTORY_CHANGED fires once when a temporary enchant appears, is re-stamped, or goes", () => {
  const { seam, events, fired, pump, wear, selfGuid } = fixture();
  seam.attach(pump);
  fired.length = 0;
  seam.hudMechanics.tick();
  assert.deepEqual(fired, []);
  const item = wear(15, MAINHAND_GUID, { id: 3265, duration: 1_800_000, charges: 0 });
  seam.hudMechanics.tick();
  seam.hudMechanics.tick();
  assert.deepEqual(fired, [["UNIT_INVENTORY_CHANGED", "player"]]);
  events.emit("ITEM_ENCHANT_TIME_UPDATE", { itemGuid: MAINHAND_GUID, slot: 1, duration: 600, playerGuid: selfGuid, receivedAt: 1000 });
  seam.hudMechanics.tick();
  assert.equal(fired.length, 2, "a fresh stamp is a change worth repainting");
  item.fields.set(TEMP, 0);
  seam.hudMechanics.tick();
  seam.hudMechanics.tick();
  assert.equal(fired.length, 3, "the realm clearing the id is the expiry edge");
  seam.detach();
});

// ---- WorldClient: the packets and the enchant-time field ----------------------------------------

function connection() {
  const packets = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload) {
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume({ opcode, payload });
      } else packets.push({ opcode, payload });
    },
    read() {
      return packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve) => { wake = resolve; });
    },
    send(opcode, payload) { this.sent.push({ opcode, payload }); },
    close() {},
  };
}

async function settle() {
  for (let index = 0; index < 6; index++) await new Promise(setImmediate);
}

async function loggedIn() {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  await world.loginCharacter(1n);
  await settle();
  transport.sent.length = 0;
  return { world, transport };
}

test("WorldClient sends CMSG_TOTEM_DESTROYED as one byte and CMSG_CANCEL_TEMP_ENCHANTMENT as the equipment slot", async () => {
  const { world, transport } = await loggedIn();
  try {
    world.destroyTotem(2);
    world.destroyTotem(4);
    world.destroyTotem(-1);
    world.cancelTempEnchantment(15);
    world.cancelTempEnchantment(16);
    world.cancelTempEnchantment(19);
    assert.deepEqual(transport.sent.map((packet) => [packet.opcode, [...packet.payload]]), [
      [OPCODES.CMSG_TOTEM_DESTROYED, [2]],
      [OPCODES.CMSG_CANCEL_TEMP_ENCHANTMENT, [15, 0, 0, 0]],
      [OPCODES.CMSG_CANCEL_TEMP_ENCHANTMENT, [16, 0, 0, 0]],
    ]);
  } finally { world.close(); }
});

test("SMSG_ITEM_ENCHANT_TIME_UPDATE lands in the item's duration field in milliseconds and on the bus with its stamp", async () => {
  const { world, transport } = await loggedIn();
  try {
    const item = { guid: MAINHAND_GUID, typeId: 1, fields: new Map([[TEMP, 3265], [TEMP + 1, 1_800_000]]) };
    world.state.objects.set(MAINHAND_GUID, item);
    const updates = [];
    world.events.on("ITEM_ENCHANT_TIME_UPDATE", (update) => updates.push(update));
    transport.push(OPCODES.SMSG_ITEM_ENCHANT_TIME_UPDATE,
      new PacketWriter().u64(MAINHAND_GUID).u32(1).u32(1795).u64(1n).toUint8Array());
    await settle();
    assert.equal(item.fields.get(TEMP + 1), 1_795_000);
    assert.equal(updates.length, 1);
    assert.deepEqual({ ...updates[0], receivedAt: typeof updates[0].receivedAt },
      { itemGuid: MAINHAND_GUID, slot: 1, duration: 1795, playerGuid: 1n, receivedAt: "number" });
  } finally { world.close(); }
});

test("WorldClient emits UNIT_COMBAT for a spell miss list and an immunity log", async () => {
  const { world, transport } = await loggedIn();
  try {
    const combat = [];
    world.events.on("UNIT_COMBAT", (event) => combat.push(event));
    transport.push(OPCODES.SMSG_SPELLLOGMISS,
      new PacketWriter().u32(133).u64(0x99n).u8(0).u32(2).u64(1n).u8(3).u64(0x20n).u8(7).toUint8Array());
    transport.push(OPCODES.SMSG_SPELLORDAMAGE_IMMUNE,
      new PacketWriter().u64(0x99n).u64(1n).u32(10).toUint8Array());
    await settle();
    assert.deepEqual(combat, [
      { source: "miss", casterGuid: 0x99n, targetGuid: 1n, spellId: 133, missInfo: 3 },
      { source: "miss", casterGuid: 0x99n, targetGuid: 0x20n, spellId: 133, missInfo: 7 },
      { source: "immune", log: { casterGuid: 0x99n, targetGuid: 1n, spellId: 10 } },
    ]);
  } finally { world.close(); }
});

// ---- The death knight's runes (FrameXmlRunes.ts): GetRuneType, GetRuneCooldown and their events ----

const RUNE_REGEN = UPDATE_FIELDS.PLAYER_RUNE_REGEN_1.offset;
/** An update field's raw word for a float, as the realm writes PLAYER_RUNE_REGEN_1..4. */
function floatBits(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}
/** `WorldClient.runes` after SMSG_RESYNC_RUNES: fresh records, core types 0..3, readiness 255 = ready. */
const resynced = (...runes) => runes.map(([type, readiness]) => ({ type, readiness }));
/** Player.cpp runeSlotTypes, all ready. */
const FRESH = [[0, 255], [0, 255], [1, 255], [1, 255], [2, 255], [2, 255]];
const runeEvents = (fired) => fired.filter(([event]) => event.startsWith("RUNE_"));

test("GetRuneType answers RuneFrame.lua's 1..4 for rune ids 1..6, nil outside them and before any resync", () => {
  const { seam, world, events, fired, pump, call } = fixture();
  world.runes = [];
  seam.attach(pump);
  assert.deepEqual(call("GetRuneType", 1), [], "no resync yet: no type, and the button hides its icon");
  assert.deepEqual(call("GetRuneCooldown", 1), [0, 10, true], "and nothing to count down; the duration is still answered");
  fired.length = 0;
  world.runes = resynced(...FRESH);
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((id) => call("GetRuneType", id)), [[1], [1], [2], [2], [3], [3]]);
  for (const outside of [0, 7, -1, "x"]) {
    assert.deepEqual(call("GetRuneType", outside), [], `GetRuneType(${outside})`);
    assert.deepEqual(call("GetRuneCooldown", outside), [], `GetRuneCooldown(${outside})`);
  }
  assert.deepEqual(runeEvents(fired), [1, 2, 3, 4, 5, 6].map((id) => ["RUNE_TYPE_UPDATE", id]),
    "the first resync after the mount paints every icon; a ready rune needs no power edge");
  // A type this bar has no icon for (RuneFrame.lua's four) is no type: RuneButton_Update would index nil.
  world.runes[5].type = 4;
  assert.deepEqual(call("GetRuneType", 6), []);
  seam.detach();
});

test("GetRuneCooldown counts a spent rune from its resync on the GetTime clock; PLAYER_RUNE_REGEN is the duration", () => {
  const { seam, world, events, pump, call, setPumpNow, setMonotonic } = fixture();
  const player = world.state.objects.get(world.state.selfGuid);
  world.runes = resynced(...FRESH);
  seam.attach(pump);
  setPumpNow(99);
  // 128 leaves 127/255 of RUNE_BASE_COOLDOWN to wait (Player::ResyncRunes): 4.98 s, whatever the haste.
  world.runes = resynced([0, 128], [0, 255], [1, 128], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  setPumpNow(100);
  setMonotonic(987_654);
  const remaining = 127 / 255 * 10;
  const [start, duration, ready] = call("GetRuneCooldown", 3);
  assert.equal(ready, false);
  assert.equal(duration, 10, "no PLAYER_RUNE_REGEN yet: the base ten seconds");
  assert.ok(Math.abs(start - (99 + remaining - 10)) < 1e-9, `start ${start}: read one GetTime second ago`);
  assert.ok(Math.abs(start - (100 - 6.02)) < 0.01);
  assert.deepEqual(call("GetRuneCooldown", 2), [0, 10, true], "a ready rune answers its duration too");
  // Unholy (runes 3, 4) hasted to eight seconds: PLAYER_RUNE_REGEN_1 + 1 = 1000 / 8000 runes a second.
  player.fields.set(RUNE_REGEN + 1, floatBits(0.125));
  const [hastedStart, hastedDuration, hastedReady] = call("GetRuneCooldown", 3);
  assert.deepEqual([hastedDuration, hastedReady], [8, false]);
  assert.ok(Math.abs(hastedStart - (99 + remaining - 8)) < 1e-9, `hasted start ${hastedStart}`);
  assert.equal(call("GetRuneCooldown", 1)[1], 10, "blood reads its own field (index 0)");
  assert.deepEqual(call("GetRuneCooldown", 4), [0, 8, true], "a ready unholy rune answers the hasted duration");
  // Past the wait with no packet — dead, or off the map in a far teleport, the core stops counting —
  // the rune stays unready until the realm says it is: the sweep has run out, the button still waits.
  setPumpNow(99 + remaining + 30);
  assert.deepEqual(call("GetRuneCooldown", 3), [hastedStart, 8, false]);
  seam.detach();
});

test("a waiting rune's start is one number however the two real clocks drift, so the sweep is not repainted every frame", async () => {
  const world = { events: new FakeEvents(), state: { selfGuid: 1n, objects: new Map() }, totems: new Map(), runes: resynced(...FRESH) };
  const model = new FrameXmlHudMechanicsLive({
    world: () => world, monotonic: () => performance.now(), spell: () => undefined, unitGuid: () => undefined,
  });
  // FrameXmlBoot's pump: GetTime is Date.now() / 1000, whole milliseconds; monotonic is performance.now().
  model.attach({ fire: () => 1, now: () => Date.now() / 1000 });
  world.runes = resynced([0, 255], [0, 255], [1, 40], [1, 255], [2, 255], [2, 255]);
  world.events.emit("RUNES_CHANGED", {});
  const starts = [];
  for (let frame = 0; frame < 12; frame++) {
    starts.push(model.runeCooldown(3)[0]);
    await new Promise((resolve) => setTimeout(resolve, 7));
  }
  assert.equal(new Set(starts).size, 1, `one start across twelve frames: ${starts.join(", ")}`);
  model.detach();
});

test("a rune waiting at the mount, or past its estimate, is announced again on its next unready reading", () => {
  const { seam, world, events, fired, pump, call, setPumpNow } = fixture();
  // A remount mid-cooldown (ReloadUI, a switch of interface mode): the stock frame draws every rune
  // ready — its PLAYER_ENTERING_WORLD repaints icons only — and nothing may fire before that event.
  world.runes = resynced([0, 255], [0, 255], [1, 100], [1, 255], [2, 255], [2, 255]);
  seam.attach(pump);
  assert.deepEqual(runeEvents(fired), [], "nothing from attach: RuneFrame_FixRunes has not run yet");
  assert.equal(call("GetRuneCooldown", 3)[2], false);
  world.runes = resynced([0, 255], [0, 255], [1, 104], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(runeEvents(fired), [["RUNE_POWER_UPDATE", 3, false]], "the first reading after the mount hangs the sweep");
  world.runes = resynced([0, 255], [0, 255], [1, 108], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  assert.equal(runeEvents(fired).length, 1, "and the stream after it is quiet");
  // Dead: Player::Update regenerates only while alive, so no resync comes and the estimate runs out.
  setPumpNow(100 + 60);
  assert.equal(call("GetRuneCooldown", 3)[2], false, "still unready: only the realm says ready");
  // Resurrected: the frozen cooldown resumes with a reading that still waits — announced once more.
  world.runes = resynced([0, 255], [0, 255], [1, 108], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(runeEvents(fired), [["RUNE_POWER_UPDATE", 3, false], ["RUNE_POWER_UPDATE", 3, false]]);
  world.runes = resynced([0, 255], [0, 255], [1, 112], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  assert.equal(runeEvents(fired).length, 2, "quiet again while the new estimate runs");
  world.runes = resynced(...FRESH);
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(runeEvents(fired).at(-1), ["RUNE_POWER_UPDATE", 3, true]);
  seam.detach();
});

test("RUNE_POWER_UPDATE and RUNE_TYPE_UPDATE are edges: the resync stream is quiet, convert is a type edge, detach unsubscribes", () => {
  const { seam, world, events, fired, pump, call } = fixture();
  world.runes = resynced(...FRESH);
  seam.attach(pump);
  assert.deepEqual(runeEvents(fired), [], "runes known at the mount are PLAYER_ENTERING_WORLD's to paint, not announced");
  fired.length = 0;
  world.runes = resynced([0, 255], [0, 255], [1, 0], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(fired, [["RUNE_POWER_UPDATE", 3, false]]);
  // Player::SetRuneCooldown resyncs every regen tick while a rune waits: the same shape, no edge.
  world.runes = resynced([0, 255], [0, 255], [1, 26], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  world.runes = resynced([0, 255], [0, 255], [1, 51], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(fired, [["RUNE_POWER_UPDATE", 3, false]]);
  // SMSG_ADD_RUNE_POWER: WorldClient marks the masked runes ready in place.
  world.runes[2].readiness = 255;
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(fired, [["RUNE_POWER_UPDATE", 3, false], ["RUNE_POWER_UPDATE", 3, true]]);
  // SMSG_CONVERT_RUNE: one rune's type, in place.
  fired.length = 0;
  world.runes[2].type = 3;
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(fired, [["RUNE_TYPE_UPDATE", 3]]);
  assert.deepEqual(call("GetRuneType", 3), [4], "a death rune");
  seam.detach();
  world.runes = resynced([3, 0], [0, 0], [1, 0], [1, 0], [2, 0], [2, 0]);
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(fired, [["RUNE_TYPE_UPDATE", 3]], "nothing after detach");
  assert.equal(events.listenerCount("RUNES_CHANGED"), 0);
});

test("a convert keeps the running cooldown's stamp; only a new reading of the rune re-stamps it", () => {
  const { seam, world, events, pump, call, setPumpNow, setMonotonic } = fixture();
  world.runes = resynced(...FRESH);
  seam.attach(pump);
  setPumpNow(50);
  world.runes = resynced([0, 0], [0, 255], [1, 255], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  setPumpNow(52);
  setMonotonic(4000);
  world.runes[0].type = 3;
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(call("GetRuneCooldown", 1), [50, 10, false], "spent at 50, not at the convert");
  // A resync at 53 that leaves 204/255 of ten seconds re-stamps: eight seconds from 53.
  setPumpNow(53);
  world.runes = resynced([3, 51], [0, 255], [1, 255], [1, 255], [2, 255], [2, 255]);
  events.emit("RUNES_CHANGED", {});
  assert.deepEqual(call("GetRuneCooldown", 1), [51, 10, false]);
  seam.detach();
});

test("WorldClient's three rune packets reach the stock rune events through the live model", async () => {
  const { world, transport } = await loggedIn();
  try {
    const fired = [];
    const model = new FrameXmlHudMechanicsLive({
      world: () => world, monotonic: () => 0, spell: () => undefined, unitGuid: () => undefined,
    });
    model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
    const resync = (...runes) => {
      const writer = new PacketWriter().u32(runes.length);
      for (const [type, readiness] of runes) writer.u8(type).u8(readiness);
      return writer.toUint8Array();
    };
    transport.push(OPCODES.SMSG_RESYNC_RUNES, resync(...FRESH));
    await settle();
    assert.deepEqual(fired, [1, 2, 3, 4, 5, 6].map((id) => ["RUNE_TYPE_UPDATE", id]));
    fired.length = 0;
    transport.push(OPCODES.SMSG_RESYNC_RUNES, resync([0, 255], [0, 255], [1, 0], [1, 255], [2, 255], [2, 255]));
    transport.push(OPCODES.SMSG_RESYNC_RUNES, resync([0, 255], [0, 255], [1, 25], [1, 255], [2, 255], [2, 255]));
    await settle();
    transport.push(OPCODES.SMSG_CONVERT_RUNE, new PacketWriter().u8(2).u8(3).toUint8Array());
    await settle();
    transport.push(OPCODES.SMSG_ADD_RUNE_POWER, new PacketWriter().u32(0b100).toUint8Array());
    await settle();
    assert.deepEqual(fired, [["RUNE_POWER_UPDATE", 3, false], ["RUNE_TYPE_UPDATE", 3], ["RUNE_POWER_UPDATE", 3, true]]);
    assert.equal(model.runeType(3), 4);
    assert.deepEqual(model.runeCooldown(3), [0, 10, true]);
    model.detach();
  } finally { world.close(); }
});
