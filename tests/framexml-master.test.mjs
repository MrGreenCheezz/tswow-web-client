import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 2 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-master-loot-snapshot.test.mjs
{
// Plan item 5.28, review of L6 (04.10): GiveMasterLoot gives to the name the player was shown. Wow.exe 3.3.5a 12340
// places the forty master-loot slots once, when SMSG_LOOT_MASTER_LIST arrives (handler 0x6fa690 fills 0x00ca0550 from
// the raid roster of that moment), and both GetMasterLootCandidate (0x588920) and GiveMasterLoot (0x589600) read that
// same table through 0x6fa770 (the table's only other reader; nothing else writes it). A group list that moves a raid
// member between subgroups afterwards does not move anyone's slot, so the index a dropdown or the
// CONFIRM_LOOT_DISTRIBUTION popup kept (LootFrame.lua GroupLootDropDown_GiveLoot, StaticPopup.lua) still names the
// player whose name it showed. Read 2026-10-04 (byte listing of 0x6fa770, 0x588920, 0x589600; call sites).

const { FrameXmlLootModel } = await import("../dist/code/browser/framexml/FrameXmlLoot.js");

const SELF = 1n;
const CORPSE = 0xf130000c3500002an;
const NAMES = new Map([[SELF, "Сам"], [2n, "Бета"], [3n, "Гамма"], [4n, "Дельта"]]);

function raid(subGroups) {
  return {
    groupType: 0x02, ownSubGroup: 1,
    members: [...subGroups].map(([guid, subGroup]) => ({ guid, name: NAMES.get(guid), subGroup })),
  };
}

function harness() {
  const calls = [];
  const world = {
    loot: { guid: CORPSE, lootType: 1, gold: 0, slots: [
      { index: 0, itemId: 200, count: 1, displayId: 2000, randomSuffix: 0, randomPropertyId: 0, slotType: 2, taken: false },
    ] },
    lootRolls: new Map(),
    masterLootCandidates: [],
    group: raid([[2n, 0], [3n, 1], [4n, 0]]),
    state: { selfGuid: SELF, objects: new Map() },
    itemTemplates: new Map([[200, { entry: 200, found: true, name: "Ореол", quality: 4, displayInfoId: 2000, bonding: 1, flags2: 0, requiredDisenchantSkill: 0xffffffff }]]),
    itemTemplate(entry) { return this.itemTemplates.get(entry); },
    displayName: (guid) => NAMES.get(guid) ?? "",
    names: { get: (guid) => NAMES.get(guid) },
    requestName: () => {},
    takeLootSlot() {}, takeLootMoney() {}, closeLoot() {}, rollForLoot() {},
    giveMasterLoot(index, target) { calls.push([index, target]); },
  };
  const model = new FrameXmlLootModel({
    world: () => world, playerLevel: () => 80, autoLootDefault: () => false, now: () => 0,
  });
  model.attach({ fire: () => 1 });
  model.owned = true;
  model.tick();
  return { world, model, calls };
}

/** The raid dropdown's names by index, as GroupLootDropDown_Initialize reads them (1..40). */
function shown(model) {
  const names = new Map();
  for (let index = 1; index <= 40; index++) {
    const name = model.masterLootCandidate(index);
    if (name !== undefined) names.set(index, name);
  }
  return names;
}

test("a subgroup move after the list keeps every slot: the kept index gives to the name shown", () => {
  const { world, model, calls } = harness();
  // Packet order Дельта, Бета: both in subgroup 0, so slots 1 and 2; the player is first in subgroup 1.
  world.masterLootCandidates = [4n, 2n, SELF];
  model.tick();
  const before = shown(model);
  assert.deepEqual([...before], [[1, "Дельта"], [2, "Бета"], [6, "Сам"]]);
  // The CONFIRM_LOOT_DISTRIBUTION popup keeps index 1 («Дельта») while the leader moves Дельта to subgroup 3;
  // the realm sends a new group list (a new object), no new SMSG_LOOT_MASTER_LIST.
  world.group = raid([[2n, 0], [3n, 1], [4n, 3]]);
  model.tick();
  assert.deepEqual([...shown(model)], [...before], "the slots are the list's, not the new roster's (0x6fa690)");
  model.giveMasterLoot(1, 1);
  assert.deepEqual(calls, [[0, 4n]], "Дельта, whose name the popup showed — not Бета");
});

test("a new SMSG_LOOT_MASTER_LIST places the slots again, by the roster of that moment", () => {
  const { world, model, calls } = harness();
  world.masterLootCandidates = [4n, 2n, SELF];
  model.tick();
  assert.equal(model.masterLootCandidate(1), "Дельта");
  world.group = raid([[2n, 0], [3n, 1], [4n, 3]]);
  world.masterLootCandidates = [4n, 2n, SELF];
  model.tick();
  assert.deepEqual([...shown(model)], [[1, "Бета"], [6, "Сам"], [16, "Дельта"]]);
  model.giveMasterLoot(1, 16);
  assert.deepEqual(calls, [[0, 4n]]);
});

test("the slots are placed by the roster of the frame the list came in, not of the first read", () => {
  const { world, model, calls } = harness();
  world.masterLootCandidates = [4n, 2n, SELF];
  model.tick();
  world.group = raid([[2n, 0], [3n, 1], [4n, 3]]);
  assert.deepEqual([...shown(model)], [[1, "Дельта"], [2, "Бета"], [6, "Сам"]]);
  model.giveMasterLoot(1, 2);
  assert.deepEqual(calls, [[0, 2n]]);
});

test("a guid off the raid roster takes no place, even ahead of everyone (0x6fa690 drops it)", async () => {
  const { frameXmlMasterLootTable } = await import("../dist/code/browser/framexml/FrameXmlMasterLoot.js");
  const table = frameXmlMasterLootTable([77n, 2n], { selfGuid: SELF, ownSubGroup: 1, members: [{ guid: 2n, subGroup: 0 }] });
  assert.deepEqual(table.slice(0, 2), [2n, undefined]);
  assert.equal(table.filter((guid) => guid !== undefined).length, 1);
});

test("the unit tooltip's loot lines: a master looter whose name is not known yet writes no line", async () => {
  const { frameXmlLootOwnerLines } = await import("../dist/code/browser/framexml/FrameXmlLootOwnerTooltip.js");
  assert.deepEqual(frameXmlLootOwnerLines({ masterLooterGuid: 8n, allowedLooterGuid: 0n }, () => undefined), []);
});

test("in a party the index is the packet place whatever the group list does", () => {
  const { world, model, calls } = harness();
  world.group = { groupType: 0, ownSubGroup: 0, members: [{ guid: 2n, name: "Бета", subGroup: 0 }, { guid: 4n, name: "Дельта", subGroup: 0 }] };
  world.masterLootCandidates = [SELF, 4n, 2n];
  model.tick();
  assert.deepEqual([...shown(model)], [[1, "Сам"], [2, "Дельта"], [3, "Бета"]]);
  world.group = { ...world.group, members: [...world.group.members].reverse() };
  model.giveMasterLoot(1, 2);
  assert.deepEqual(calls, [[0, 4n]]);
});
}

// ── framexml-master-loot.test.mjs
{
// Plan item 5.28 (04.10, L6): GetMasterLootCandidate as Wow.exe 3.3.5a 12340 answers it — the forty slots of
// SMSG_LOOT_MASTER_LIST (0x6fa690: packet order outside a raid, the first free place of the candidate's
// subgroup inside one, a guid off the roster dropped), slot i - 1 (0x6fa770), the name from the name cache
// (0x67d770) and UPDATE_MASTER_LOOT_LIST when an asked name comes (0x588150); read 2026-10-04.

const { frameXmlMasterLootTable, FRAMEXML_MASTER_LOOT_SLOTS } = await import("../dist/code/browser/framexml/FrameXmlMasterLoot.js");
const { FrameXmlLootModel } = await import("../dist/code/browser/framexml/FrameXmlLoot.js");

const SELF = 1n;

test("the table: packet order out of a raid; in one, packed per subgroup in packet order; strangers dropped", () => {
  assert.equal(FRAMEXML_MASTER_LOOT_SLOTS, 40);
  const party = frameXmlMasterLootTable([5n, SELF, 3n], undefined);
  assert.deepEqual(party.slice(0, 4), [5n, SELF, 3n, undefined]);
  assert.equal(party.length, 40);
  const raid = { selfGuid: SELF, ownSubGroup: 1, members: [
    { guid: 2n, subGroup: 0 }, { guid: 3n, subGroup: 1 }, { guid: 4n, subGroup: 1 }, { guid: 9n, subGroup: 7 },
  ] };
  const table = frameXmlMasterLootTable([4n, 2n, 77n, SELF, 9n], raid);
  assert.deepEqual([table[0], table[1], table[5], table[6], table[7], table[35]], [2n, undefined, 4n, SELF, undefined, 9n],
    "Дельта came before the player in the packet; 77 is not on the roster; subgroup 7 starts at 35");
  const full = frameXmlMasterLootTable([11n, 12n, 13n, 14n, 15n, 16n],
    { selfGuid: SELF, ownSubGroup: 0, members: [11n, 12n, 13n, 14n, 15n, 16n].map((guid) => ({ guid, subGroup: 0 })) });
  assert.deepEqual(full.slice(0, 6), [11n, 12n, 13n, 14n, 15n, undefined], "a sixth in a full subgroup has no place");
});

function lootModel(world) {
  const events = [];
  const model = new FrameXmlLootModel({
    world: () => world, playerLevel: () => 80, autoLootDefault: () => false, now: () => 0,
  });
  model.attach({ fire: (event) => { events.push(event); return 1; } });
  model.owned = true;
  return { model, events };
}

test("the name comes from the name cache: nil and asked while unknown, UPDATE_MASTER_LOOT_LIST once it comes", () => {
  const names = new Map([[2n, "Бета"]]);
  const asked = [];
  const world = {
    loot: undefined, lootRolls: new Map(), masterLootCandidates: [SELF, 2n, 3n], group: undefined,
    state: { selfGuid: SELF, objects: new Map() }, itemTemplates: new Map(), itemTemplate: () => undefined,
    displayName: (guid) => (guid === SELF ? "Сам" : `0x${guid.toString(16).padStart(16, "0")}`),
    names: { get: (guid) => names.get(guid) }, requestName: (guid) => asked.push(guid),
  };
  const { model, events } = lootModel(world);
  assert.equal(model.masterLootCandidate(1), "Сам", "the player's own name is always there");
  assert.equal(model.masterLootCandidate(2), "Бета");
  assert.equal(model.masterLootCandidate(3), undefined, "not the hex stand-in: nil until the name comes");
  assert.deepEqual(asked, [3n]);
  model.tick();
  assert.deepEqual(events, []);
  names.set(3n, "Гамма");
  model.tick();
  assert.deepEqual(events, ["UPDATE_MASTER_LOOT_LIST"]);
  model.tick();
  assert.deepEqual(events, ["UPDATE_MASTER_LOOT_LIST"], "once");
  assert.equal(model.masterLootCandidate(3), "Гамма");
  assert.equal(model.masterLootCandidate(41), undefined);
});

// SMSG_LOOT_LIST's consumer (5.28): the unit tooltip's MASTER_LOOTER and LOOT lines (Wow.exe 0x622220, the owners
// kept on the unit by 0x71ca50; a list for a unit not in view is dropped).
const { frameXmlLootOwnerLines, frameXmlLootOwnerText } = await import("../dist/code/browser/framexml/FrameXmlLootOwnerTooltip.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");

test("the loot lines: master looter then looter, a name not known yet leaves its line out", () => {
  const names = new Map([[5n, "Мастер"], [6n, "Счастливчик"]]);
  const lines = frameXmlLootOwnerLines({ masterLooterGuid: 5n, allowedLooterGuid: 6n }, (guid) => names.get(guid));
  assert.deepEqual(lines, [{ globalName: "MASTER_LOOTER", name: "Мастер" }, { globalName: "LOOT", name: "Счастливчик" }]);
  const strings = { MASTER_LOOTER: "Ответственный за добычу", LOOT: "Добыча" };
  assert.deepEqual(lines.map((line) => frameXmlLootOwnerText(line, (key) => strings[key])),
    ["Ответственный за добычу: Мастер", "Добыча: Счастливчик"]);
  assert.deepEqual(frameXmlLootOwnerLines({ masterLooterGuid: 0n, allowedLooterGuid: 7n }, (guid) => names.get(guid)), [],
    "a zero guid writes nothing, an unknown name neither");
  assert.deepEqual(frameXmlLootOwnerLines(undefined, () => "x"), []);
});

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

test("WorldClient keeps a loot list on its corpse, drops one for a unit not in view", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  const corpse = 0xf130000c3500002an;
  client.state.setField(corpse, 0, 1);
  const list = (guid, master, looter) => new PacketWriter().u64(guid).packedGuid(master).packedGuid(looter).toUint8Array();
  connection.push(OPCODES.SMSG_LOOT_LIST, list(corpse, 5n, 6n));
  connection.push(OPCODES.SMSG_LOOT_LIST, list(0xf130000c3500002bn, 7n, 0n));
  await settle();
  assert.deepEqual([...client.lootOwnersByUnit.keys()], [corpse]);
  assert.equal(client.lootOwnersByUnit.get(corpse).allowedLooterGuid, 6n);
  assert.equal(client.lootOwners.corpseGuid, 0xf130000c3500002bn, "the last list is still the window's");
  client.close();
});

test("LiveWorldSeam.unitLootOwners: the unit's lines, an unknown name asked for", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const corpse = 0x77n;
  const asked = [];
  const world = {
    state: { selfGuid: SELF, objects: new Map([[corpse, { guid: corpse, typeId: 3, fields: new Map() }]]) },
    events: { on: () => () => {} },
    targetGuid: corpse,
    lootOwnersByUnit: new Map([[corpse, { corpseGuid: corpse, masterLooterGuid: 5n, allowedLooterGuid: 6n }]]),
    names: { get: (guid) => (guid === 5n ? "Мастер" : undefined) },
    requestName: (guid) => asked.push(guid),
    group: { members: [] },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  assert.deepEqual(seam.unitLootOwners("target"), [{ globalName: "MASTER_LOOTER", name: "Мастер" }]);
  assert.deepEqual(asked, [6n]);
});
}
