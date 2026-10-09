// Plan item 5.28, review of L6 (04.10): GiveMasterLoot gives to the name the player was shown. Wow.exe 3.3.5a 12340
// places the forty master-loot slots once, when SMSG_LOOT_MASTER_LIST arrives (handler 0x6fa690 fills 0x00ca0550 from
// the raid roster of that moment), and both GetMasterLootCandidate (0x588920) and GiveMasterLoot (0x589600) read that
// same table through 0x6fa770 (the table's only other reader; nothing else writes it). A group list that moves a raid
// member between subgroups afterwards does not move anyone's slot, so the index a dropdown or the
// CONFIRM_LOOT_DISTRIBUTION popup kept (LootFrame.lua GroupLootDropDown_GiveLoot, StaticPopup.lua) still names the
// player whose name it showed. Read 2026-10-04 (byte listing of 0x6fa770, 0x588920, 0x589600; call sites).
import assert from "node:assert/strict";
import test from "node:test";

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
