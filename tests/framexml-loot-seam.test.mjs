import assert from "node:assert/strict";
import test from "node:test";

// FrameXmlLoot.ts over fake worlds: the client-side rules the stock Lua cannot see — slot numbering,
// bind confirmation by slot type, auto-loot, the window closing itself, roll ids and their end,
// master-loot indices — and the seam wiring (bindings, prelude, LiveWorldSeam) around them.
const { FrameXmlLootModel, FRAMEXML_LOOT_BINDINGS, FRAMEXML_LOOT_PRELUDE, frameXmlLootCoinIcon } =
  await import("../dist/code/browser/framexml/FrameXmlLoot.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const SELF = 1n;
const CORPSE = 0xf130000c3500002an;

function template(entry, name, quality, extra = {}) {
  return { entry, found: true, name, quality, displayInfoId: entry * 10, bonding: 0, flags2: 0, requiredDisenchantSkill: 0xffffffff, ...extra };
}

function slot(index, itemId, extra = {}) {
  return { index, itemId, count: 1, displayId: itemId * 10, randomSuffix: 0, randomPropertyId: 0, slotType: 0, taken: false, ...extra };
}

/** A structural WorldClient: loot fields, templates, positions and recorded commands. */
function fakeWorld(extra = {}) {
  const calls = [];
  const world = {
    calls,
    loot: undefined,
    lootRolls: new Map(),
    masterLootCandidates: [],
    group: undefined,
    state: { selfGuid: SELF, objects: new Map() },
    itemTemplates: new Map([
      [100, template(100, "Льняной материал", 1)],
      [200, template(200, "Ореол превосходства", 4, { bonding: 1, requiredDisenchantSkill: 300 })],
      [300, template(300, "Кольцо", 4, { bonding: 1, flags2: 0x100 })],
    ]),
    asked: [],
    itemTemplate(entry) { const known = this.itemTemplates.get(entry); if (!known) this.asked.push(entry); return known; },
    displayName: (guid) => ({ 1: "Сам", 2: "Бета", 3: "Гамма", 4: "Дельта" })[Number(guid)] ?? "",
    takeLootSlot(index) { calls.push(`take ${index}`); },
    takeLootMoney() { calls.push("money"); },
    closeLoot() { calls.push("release"); world.loot = undefined; },
    rollForLoot(guid, type) { calls.push(`roll ${guid} ${type}`); },
    giveMasterLoot(index, target) { calls.push(`give ${index} ${target}`); },
    ...extra,
  };
  return world;
}

function harness(options = {}) {
  const world = options.world ?? fakeWorld();
  let now = options.now ?? 1_000_000;
  const events = [];
  const sounds = [];
  const model = new FrameXmlLootModel({
    world: () => world,
    playerLevel: () => 60,
    autoLootDefault: () => options.autoLoot ?? false,
    autoLootModifier: () => options.shift ?? false,
    displayIcon: (displayId) => `icon/${displayId}`,
    playSound: (name) => sounds.push(name),
    now: () => now,
  });
  model.attach({ fire: (event, ...args) => { events.push([event, ...args].join(":")); return 1; } });
  model.owned = options.owned ?? true;
  return {
    world, model, sounds,
    tick() { model.tick(); },
    events() { return events.splice(0); },
    advance(ms) { now += ms; },
  };
}

function corpse(slots, gold = 0) {
  return { guid: CORPSE, lootType: 1, gold, slots };
}

test("the money is slot 1 and items follow in wire order; the numbering is frozen for the opening", () => {
  const { world, model, tick, events } = harness();
  world.loot = corpse([slot(3, 100, { count: 5 }), slot(7, 200)], 12345);
  tick();
  assert.deepEqual(events(), ["LOOT_OPENED:0"]);
  assert.equal(model.numItems(), 3);
  assert.deepEqual(model.slotInfo(1), [frameXmlLootCoinIcon(12345), undefined, 0, 0, undefined, 12345]);
  assert.deepEqual(model.slotInfo(2), ["icon/1000", "Льняной материал", 5, 1, undefined, undefined]);
  assert.equal(model.slotIsCoin(1), true);
  assert.equal(model.slotIsItem(2), true);
  assert.equal(model.slotLink(3), "|cffa335ee|Hitem:200:0:0:0:0:0:0:0:60|h[Ореол превосходства]|h|r");
  // Taking the money clears slot 1 without renumbering; the coin sound plays once.
  world.loot.gold = 0;
  tick();
  assert.deepEqual(events(), ["LOOT_SLOT_CLEARED:1"]);
  assert.equal(model.numItems(), 3);
  assert.equal(model.slotIsCoin(1), false);
  assert.equal(model.slotIsItem(2), true);
  tick();
  assert.deepEqual(events(), []);
});

test("the coin icon follows the amount; an unknown item waits for its query and repaints its slot", () => {
  assert.equal(frameXmlLootCoinIcon(99), "Interface\\Icons\\INV_Misc_Coin_05");
  assert.equal(frameXmlLootCoinIcon(100), "Interface\\Icons\\INV_Misc_Coin_03");
  assert.equal(frameXmlLootCoinIcon(10000), "Interface\\Icons\\INV_Misc_Coin_01");
  const { world, model, tick, events } = harness();
  world.loot = corpse([slot(0, 999)]);
  tick();
  assert.deepEqual(world.asked, [999], "the item query leaves from the tick, not a C-API read");
  assert.deepEqual(events(), ["LOOT_OPENED:0"]);
  assert.equal(model.slotInfo(1)[1], undefined, "RETRIEVING_ITEM_INFO comes from the Lua shim");
  world.itemTemplates.set(999, template(999, "Руническая ткань", 1));
  tick();
  assert.deepEqual(events(), ["LOOT_SLOT_CHANGED:1"]);
  assert.equal(model.slotInfo(1)[1], "Руническая ткань");
});

test("bind confirmation follows the slot type: ALLOW_LOOT asks, OWNER (solo) stores at once", () => {
  const { world, model, tick, events } = harness();
  world.loot = corpse([slot(0, 200), slot(1, 200, { slotType: 4 }), slot(2, 100)]);
  tick();
  events();
  model.lootSlot(1);
  model.lootSlot(2);
  model.lootSlot(3);
  assert.deepEqual(world.calls, ["take 1", "take 2"]);
  tick();
  assert.deepEqual(events(), ["LOOT_BIND_CONFIRM:1"]);
  model.confirmLootSlot(1);
  assert.deepEqual(world.calls.at(-1), "take 0");
});

test("a confirmation whose slot or roll is gone by the next frame is not delivered", () => {
  // Click → another looter's SMSG_LOOT_REMOVED → the frame that delivers LOOT_BIND_CONFIRM. UIParent
  // would index ITEM_QUALITY_COLORS[nil] (UIParent.lua:583): dropped, the slot's clear follows.
  const { world, model, tick, events } = harness();
  world.loot = corpse([slot(0, 200), slot(1, 200)]);
  tick();
  events();
  model.lootSlot(1);
  world.loot.slots[0].taken = true;
  tick();
  assert.deepEqual(events(), ["LOOT_SLOT_CLEARED:1"]);
  model.lootSlot(2);
  tick();
  assert.deepEqual(events(), ["LOOT_BIND_CONFIRM:2"], "a slot still on the corpse still asks");
  assert.deepEqual(world.calls, []);

  // Need on a bind-on-pickup roll, then a new world before the frame: no CONFIRM_LOOT_ROLL for a
  // roll GetLootRollItemInfo no longer answers, only its CANCEL_LOOT_ROLL.
  let current = fakeWorld();
  current.lootRolls.set(0x70n, roll(0x70n, 200, 1_000_000));
  const rolls = new FrameXmlLootModel({ world: () => current, playerLevel: () => 60, autoLootDefault: () => false, now: () => 1_000_000 });
  const fired = [];
  rolls.attach({ fire: (...args) => { fired.push(args.join(":")); return 1; } });
  rolls.owned = true;
  rolls.tick();
  rolls.rollOnLoot(1, 1);
  current = fakeWorld();
  rolls.tick();
  assert.deepEqual(fired, ["START_LOOT_ROLL:1:60000", "CANCEL_LOOT_ROLL:1"]);
});

test("locked, rolling and master slots: red, the roll-pending error, the candidate list", () => {
  const { world, model, tick, events } = harness();
  world.masterLootCandidates = [SELF, 2n];
  world.loot = corpse([slot(0, 100, { slotType: 3 }), slot(1, 100, { slotType: 1 }), slot(2, 100, { slotType: 2 })]);
  tick();
  events();
  assert.equal(model.slotInfo(1)[4], true);
  assert.equal(model.slotInfo(2)[4], true);
  assert.equal(model.slotInfo(3)[4], undefined, "a master looter's own slot is not red");
  model.lootSlot(1);
  model.lootSlot(2);
  model.lootSlot(3);
  tick();
  assert.deepEqual(world.calls, []);
  assert.deepEqual(events(), ["UI_ERROR_MESSAGE:Этот предмет пока не разыграли.", "OPEN_MASTER_LOOT_LIST"]);
  assert.equal(model.masterLootCandidate(2), "Бета");
  model.giveMasterLoot(3, 2);
  assert.deepEqual(world.calls, ["give 2 2"]);
  // A new list for the same opening: UPDATE_MASTER_LOOT_LIST.
  world.masterLootCandidates = [SELF];
  tick();
  assert.deepEqual(events(), ["UPDATE_MASTER_LOOT_LIST"]);
});

test("in a raid a master-loot index is the raid slot: subgroup × 5 + place", () => {
  const world = fakeWorld();
  world.group = { groupType: 0x02, ownSubGroup: 1, members: [
    { guid: 2n, name: "Бета", subGroup: 0 }, { guid: 3n, name: "Гамма", subGroup: 1 }, { guid: 4n, name: "Дельта", subGroup: 1 },
  ] };
  world.masterLootCandidates = [2n, SELF, 4n];
  const { model } = harness({ world });
  assert.equal(model.masterLootCandidate(1), "Бета");
  assert.equal(model.masterLootCandidate(2), undefined);
  // 5.28 (04.10, L6): Wow.exe 0x6fa690 packs a subgroup's candidates in packet order — Гамма, not a
  // candidate, holds no place, so Дельта is 7 (it was 8 by roster order before).
  assert.equal(model.masterLootCandidate(6), "Сам", "the player comes first in the packet, so first in the subgroup");
  assert.equal(model.masterLootCandidate(7), "Дельта");
  assert.equal(model.masterLootCandidate(8), undefined);
});

test("auto-loot: autoLootDefault or Shift (not both) takes money and free slots; bind asks, locked stays", () => {
  for (const [autoLoot, shift, expected] of [[true, false, 1], [false, true, 1], [true, true, 0], [false, false, 0]]) {
    const { world, tick, events } = harness({ autoLoot, shift });
    world.loot = corpse([slot(0, 100), slot(1, 200), slot(2, 100, { slotType: 1 }), slot(3, 200, { slotType: 4 })], 50);
    tick();
    const fired = events();
    assert.equal(fired[0], `LOOT_OPENED:${expected}`);
    assert.deepEqual(world.calls, expected ? ["money", "take 0", "take 3"] : [], `auto ${autoLoot} shift ${shift}`);
    assert.deepEqual(fired.slice(1), expected ? ["LOOT_BIND_CONFIRM:3"] : []);
  }
  // A slot whose template is still on its way waits for it, then is taken.
  const { world, tick, events } = harness({ autoLoot: true });
  world.loot = corpse([slot(0, 555)]);
  tick();
  assert.deepEqual(world.calls, []);
  world.itemTemplates.set(555, template(555, "Шелк", 1));
  tick();
  assert.deepEqual(world.calls, ["take 0"]);
  events();

  // …at most AUTO_LOOT_TEMPLATE_WAIT_MS (3 s): one that never comes is left to the player, and a
  // template landing after that does not take it behind their back.
  const late = harness({ autoLoot: true });
  late.world.loot = corpse([slot(0, 556)]);
  late.tick();
  late.advance(2999);
  late.tick();
  assert.deepEqual(late.world.calls, [], "still waiting at 2.999 s");
  late.advance(1);
  late.tick();
  late.world.itemTemplates.set(556, template(556, "Шелк", 1));
  late.tick();
  assert.deepEqual(late.world.calls, [], "given up at 3 s: the late template is the player's to click");
  assert.deepEqual(late.events(), ["LOOT_OPENED:1", "LOOT_SLOT_CHANGED:1"]);

  // Two bind-on-pickup ALLOW_LOOT slots: one LOOT_BIND popup per pass (StaticPopup's LOOT_BIND is
  // exclusive), the free slot still taken.
  const twice = harness({ autoLoot: true });
  twice.world.loot = corpse([slot(0, 200), slot(1, 200), slot(2, 100)]);
  twice.tick();
  assert.deepEqual(twice.events(), ["LOOT_OPENED:1", "LOOT_BIND_CONFIRM:1"]);
  assert.deepEqual(twice.world.calls, ["take 2"]);
});

test("walking away closes only past both the server's radius and the distance the window opened at", () => {
  // Opened at 9 yd from a creature the server let us loot (it measures from the corpse's edge): the
  // window stays at 9 yd and closer, and closes once the player is farther than at the opening.
  const world = fakeWorld();
  const reach = UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset;
  const floatBits = (value) => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
  const self = { typeId: 4, position: { x: 0, y: 0, z: 0 }, fields: new Map([[reach, floatBits(1.5)]]) };
  world.state.objects.set(SELF, self);
  world.state.objects.set(CORPSE, { typeId: 3, position: { x: 9, y: 0, z: 0 }, fields: new Map([[reach, floatBits(1.5)]]) });
  const { tick, events } = harness({ world });
  world.loot = corpse([slot(0, 100)]);
  tick();
  tick();
  assert.deepEqual(world.calls, [], "9 yd is past 5 + 1.5 + 1.5, but it is where the window opened");
  self.position = { x: 0.5, y: 0, z: 0 };
  tick();
  assert.deepEqual(world.calls, [], "8.5 yd: closer than at the opening");
  self.position = { x: -0.4, y: 0, z: 0 };
  tick();
  assert.deepEqual(world.calls, ["release"], "9.4 yd: farther than at the opening");
  events();
});

test("the window releases itself once every slot is cleared, never on an opening that started empty", () => {
  const { world, tick, events } = harness();
  world.loot = corpse([], 0);
  tick();
  tick();
  assert.deepEqual(events(), ["LOOT_OPENED:0"]);
  assert.deepEqual(world.calls, [], "an empty corpse stays open (LOOTWINDOWOPENEMPTY)");
  world.loot = corpse([slot(0, 100)], 5);
  tick();
  events();
  world.loot.gold = 0;
  world.loot.slots[0].taken = true;
  tick();
  assert.deepEqual(events(), ["LOOT_SLOT_CLEARED:1", "LOOT_SLOT_CLEARED:2"]);
  assert.deepEqual(world.calls, ["release"]);
  tick();
  assert.deepEqual(events(), ["LOOT_CLOSED"]);
});

test("walking away from the looted creature past the server's radius releases it; fishing never does", () => {
  const world = fakeWorld();
  const reach = UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset;
  const floatBits = (value) => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
  const self = { typeId: 4, position: { x: 0, y: 0, z: 0 }, fields: new Map([[reach, floatBits(1.5)]]) };
  const body = { typeId: 3, position: { x: 4, y: 0, z: 0 }, fields: new Map([[reach, floatBits(1.5)]]) };
  world.state.objects.set(SELF, self);
  world.state.objects.set(CORPSE, body);
  const { tick, events } = harness({ world });
  world.loot = corpse([slot(0, 100)]);
  tick();
  events();
  self.position = { x: -3.9, y: 0, z: 0 };
  tick();
  assert.deepEqual(world.calls, [], "7.9 yd is inside 5 + 1.5 + 1.5");
  self.position = { x: -4.1, y: 0, z: 0 };
  tick();
  assert.deepEqual(world.calls, ["release"], "8.1 yd is past it");
  tick();
  assert.deepEqual(events(), ["LOOT_CLOSED"]);
  // The body despawning while looted closes it too.
  self.position = { x: 0, y: 0, z: 0 };
  world.loot = corpse([slot(0, 100)]);
  tick();
  events();
  world.state.objects.delete(CORPSE);
  tick();
  assert.deepEqual(world.calls, ["release", "release"]);
  // A bobber is far by design.
  world.state.objects.set(CORPSE, { ...body, typeId: 3, position: { x: 30, y: 0, z: 0 } });
  world.loot = { ...corpse([slot(0, 100)]), lootType: 3 };
  tick();
  tick();
  assert.equal(world.calls.length, 2, "fishing loot is not range-checked");
});

test("CloseLoot releases only what stock shows; a replacement opening survives the old frame's OnHide", () => {
  const world = fakeWorld();
  const fired = [];
  const model = new FrameXmlLootModel({ world: () => world, playerLevel: () => 60, autoLootDefault: () => false });
  // LootFrame's OnHide calls CloseLoot inside the LOOT_CLOSED delivery; this pump does the same.
  model.attach({ fire: (event) => { fired.push(event); if (event === "LOOT_CLOSED") model.closeLoot(); return 1; } });
  model.owned = true;
  model.closeLoot();
  assert.deepEqual(world.calls, [], "nothing shown, nothing released");
  world.loot = corpse([slot(0, 100)]);
  model.tick();
  // Player::SendLoot released the old corpse itself and sent the new one within one frame.
  world.loot = { ...corpse([slot(0, 100)]), guid: 42n };
  model.tick();
  assert.deepEqual(fired, ["LOOT_OPENED", "LOOT_CLOSED", "LOOT_OPENED"]);
  assert.deepEqual(world.calls, [], "the replacement was not released by the old frame's OnHide");
  model.closeLoot();
  assert.deepEqual(world.calls, ["release"]);
});

test("a refused opening is the client's ERR_ string once; unowned or muted, nothing fires and nothing is sent", () => {
  const { world, model, tick, events } = harness();
  model.useGlobalStrings((name) => ({ ERR_LOOT_LOCKED: "Кто-то другой уже обыскивает этот труп." })[name]);
  world.loot = { guid: CORPSE, lootType: 0, gold: 0, slots: [], error: 6 };
  tick();
  tick();
  assert.deepEqual(events(), ["UI_ERROR_MESSAGE:Кто-то другой уже обыскивает этот труп."]);
  world.loot = { guid: CORPSE, lootType: 0, gold: 0, slots: [], error: 12 };
  tick();
  assert.deepEqual(events(), ["UI_ERROR_MESSAGE:У игрока полна сумка"], "an unresolved name falls back to the native wording");

  const quiet = harness({ owned: false, autoLoot: true });
  quiet.world.loot = corpse([slot(0, 100)], 5);
  quiet.tick();
  quiet.model.lootSlot(2);
  quiet.model.closeLoot();
  assert.deepEqual(quiet.events(), []);
  assert.deepEqual(quiet.world.calls, [], "the native window owns loot until publication");
  assert.equal(quiet.model.numItems(), 0);
  // Taking ownership: the open corpse is handed over (LOOT_OPENED:0) without a second auto-loot.
  quiet.model.owned = true;
  quiet.tick();
  assert.deepEqual(quiet.events(), ["LOOT_OPENED:0"]);
  assert.deepEqual(quiet.world.calls, []);
  quiet.model.muted(() => { quiet.model.lootSlot(2); quiet.model.closeLoot(); });
  assert.deepEqual(quiet.world.calls, []);
  // A refusal the native window already showed is not repeated at the ownership edge.
  const late = harness({ owned: false });
  late.world.loot = { guid: CORPSE, lootType: 0, gold: 0, slots: [], error: 4 };
  late.model.owned = true;
  late.tick();
  assert.deepEqual(late.events(), []);
});

function roll(itemGuid, itemId, startedAt, extra = {}) {
  return { start: { itemGuid, mapId: 409, itemSlot: 1, itemId, randomSuffix: 0, randomPropertyId: 0, count: 1,
    countdown: 60000, voteMask: 0x07, ...extra }, startedAt, votes: [] };
}

test("rolls: small ids, need reasons from the item, bind-on-pickup asks, answers and ends take frames down", () => {
  const { world, model, tick, events, advance } = harness();
  world.lootRolls.set(0x40n, roll(0x40n, 200, 1_000_000, { voteMask: 0x0f }));
  world.lootRolls.set(0x41n, roll(0x41n, 300, 1_000_000, { voteMask: 0x05 }));
  world.lootRolls.set(0x42n, roll(0x42n, 100, 1_000_000, { voteMask: 0x05 }));
  world.lootRolls.set(0x43n, roll(0x43n, 200, 1_000_000));
  tick();
  assert.deepEqual(events(), ["START_LOOT_ROLL:1:60000", "START_LOOT_ROLL:2:60000", "START_LOOT_ROLL:3:60000",
    "START_LOOT_ROLL:4:60000"]);
  // Every button offered: bind on pickup, need/greed/disenchant, no reasons.
  assert.deepEqual(model.rollItemInfo(1).slice(4), [true, true, true, true, 0, 0, 0, 300]);
  // Disenchant withheld: the helm has a skill (reason 4, 300), the ring and the cloth none (reason 3).
  assert.deepEqual(model.rollItemInfo(4).slice(7), [false, 0, 0, 4, 300]);
  // Need stripped: greed-only flag → reason 5; otherwise the finder's class rule → reason 1.
  assert.deepEqual(model.rollItemInfo(2).slice(5, 11), [false, true, false, 5, 0, 3]);
  assert.deepEqual(model.rollItemInfo(3).slice(5, 11), [false, true, false, 1, 0, 3]);
  assert.equal(model.rollTimeLeft(1), 60000);
  advance(1500);
  assert.equal(model.rollTimeLeft(1), 58500);
  model.rollOnLoot(2, 1);
  assert.deepEqual(world.calls, [], "need is not in roll 2's mask");
  model.rollOnLoot(1, 1);
  model.rollOnLoot(1, 3);
  model.rollOnLoot(3, 2);
  tick();
  assert.deepEqual(events(), ["CONFIRM_LOOT_ROLL:1:1", "CONFIRM_DISENCHANT_ROLL:1:3", "CANCEL_LOOT_ROLL:3"]);
  assert.deepEqual(world.calls, [`roll ${0x42n} 2`]);
  model.confirmLootRoll(1, 1);
  model.rollOnLoot(2, 0);
  assert.deepEqual(world.calls.slice(1), [`roll ${0x40n} 1`, `roll ${0x41n} 0`], "pass never asks");
  tick();
  assert.deepEqual(events(), ["CANCEL_LOOT_ROLL:1", "CANCEL_LOOT_ROLL:2"]);
  assert.equal(model.rollItemInfo(1), undefined, "a finished roll answers nothing");
});

test("rolls end for the frames on a vote echo, a win, all-pass, the countdown, and a new world", () => {
  const { world, tick, events, advance, model } = harness();
  world.lootRolls.set(0x50n, roll(0x50n, 100, 1_000_000));
  world.lootRolls.set(0x51n, roll(0x51n, 100, 1_000_000));
  world.lootRolls.set(0x52n, roll(0x52n, 100, 1_000_000));
  world.lootRolls.set(0x53n, roll(0x53n, 100, 1_000_000));
  tick();
  assert.equal(events().length, 4);
  // The player's own vote came back (answered on the native card before publication, or elsewhere).
  world.lootRolls.get(0x50n).votes.push({ playerGuid: SELF, rollType: 2, rollNumber: 128 });
  world.lootRolls.get(0x51n).won = { winnerGuid: 2n };
  world.lootRolls.get(0x52n).passed = true;
  tick();
  assert.deepEqual(events(), ["CANCEL_LOOT_ROLL:1", "CANCEL_LOOT_ROLL:2", "CANCEL_LOOT_ROLL:3"]);
  advance(60000);
  tick();
  assert.deepEqual(events(), ["CANCEL_LOOT_ROLL:4"]);
  world.lootRolls.set(0x54n, roll(0x54n, 100, 1_060_000));
  tick();
  assert.deepEqual(events(), ["START_LOOT_ROLL:5:60000"]);
  // A relog: the old world's rolls are over for this client.
  const next = fakeWorld();
  const swapped = new FrameXmlLootModel({ world: () => current, playerLevel: () => 60, autoLootDefault: () => false, now: () => 1_060_000 });
  let current = world;
  const fired = [];
  swapped.attach({ fire: (...args) => { fired.push(args.join(":")); return 1; } });
  swapped.owned = true;
  swapped.tick();
  current = next;
  swapped.tick();
  assert.deepEqual(fired, ["START_LOOT_ROLL:1:60000", "CANCEL_LOOT_ROLL:1"]);
  assert.ok(model);
});

test("a roll waits for its item's name, then shows after the grace anyway", () => {
  const { world, tick, events, advance } = harness();
  world.lootRolls.set(0x60n, roll(0x60n, 777, 1_000_000));
  tick();
  assert.deepEqual(events(), []);
  assert.deepEqual(world.asked, [777]);
  advance(999);
  tick();
  assert.deepEqual(events(), []);
  advance(1);
  tick();
  assert.deepEqual(events(), ["START_LOOT_ROLL:1:60000"]);
});

test("the seam carries the loot bindings and their Lua shim; the live and canned seams own a model", () => {
  for (const name of Object.keys(FRAMEXML_LOOT_BINDINGS)) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_LOOT_BINDINGS[name], `${name} is spread into the seam`);
  }
  assert.ok(FRAMEXML_SEAM_PRELUDE.includes(FRAMEXML_LOOT_PRELUDE));
  assert.match(FRAMEXML_LOOT_PRELUDE, /impl\.GetLootSlotInfo = function/);
  assert.match(FRAMEXML_LOOT_PRELUDE, /impl\.GetLootRollItemInfo = function/);
  // A seam without the model answers nothing, never throws.
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNumLootItems({}, []), []);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.WebClientLootSlotInfo({}, [1]), []);
  const canned = new CannedWorldSeam();
  assert.ok(canned.loot instanceof FrameXmlLootModel);
  canned.lootWorld.openCorpse();
  canned.loot.owned = true;
  const fired = [];
  canned.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => Date.now() / 1000 });
  canned.loot.owned = true;
  canned.tick(Date.now() / 1000);
  assert.ok(fired.includes("LOOT_OPENED"), "the canned seam's tick drives the loot model");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNumLootItems(canned, []), [7]);
  canned.detach();
  assert.equal(canned.loot.owned, false, "detach disowns");

  const world = fakeWorld();
  const live = new LiveWorldSeam({
    world: () => world, monotonic: () => 0, spell: () => undefined,
    lootHost: { displayIcon: (id) => `display/${id}`, autoLootDefault: () => true },
  });
  assert.ok(live.loot instanceof FrameXmlLootModel);
  const played = [];
  live.playSound = (name) => played.push(name);
  live.loot.attach({ fire: () => 1 });
  live.loot.owned = true;
  world.loot = corpse([slot(0, 100)], 1);
  live.loot.tick();
  assert.deepEqual(world.calls, ["money", "take 0"], "the live host's autoLootDefault reaches the model");
  assert.equal(live.loot.slotInfo(2)[0], "display/1000", "the loot packet's display id picks the icon");
  world.loot.gold = 0;
  live.loot.tick();
  assert.deepEqual(played, ["LOOTWINDOWCOINSOUND"]);
});
