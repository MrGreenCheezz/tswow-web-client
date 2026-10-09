// Plan item 5.28 (04.10, L6): GetMasterLootCandidate as Wow.exe 3.3.5a 12340 answers it — the forty slots of
// SMSG_LOOT_MASTER_LIST (0x6fa690: packet order outside a raid, the first free place of the candidate's
// subgroup inside one, a guid off the roster dropped), slot i - 1 (0x6fa770), the name from the name cache
// (0x67d770) and UPDATE_MASTER_LOOT_LIST when an asked name comes (0x588150); read 2026-10-04.
import assert from "node:assert/strict";
import test from "node:test";

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
