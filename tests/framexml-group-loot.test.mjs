import assert from "node:assert/strict";
import test from "node:test";

const { frameXmlLootMethod } = await import("../dist/code/browser/framexml/FrameXmlGroupLoot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function group(overrides = {}) {
  return {
    groupType: 0, ownSubGroup: 0, ownFlags: 0, ownRoles: 0, guid: 100n, counter: 1,
    members: [
      { guid: 2n, name: "Первый", subGroup: 0 },
      { guid: 3n, name: "Второй", subGroup: 0 },
    ],
    leaderGuid: 1n, lootMethod: 3, masterLooterGuid: 0n, lootThreshold: 2,
    dungeonDifficulty: 0, raidDifficulty: 0, ...overrides,
  };
}

test("realm loot enums map to stock tokens without inventing master unit indices", () => {
  for (const [lootMethod, token] of ["freeforall", "roundrobin", "master", "group", "needbeforegreed"].entries()) {
    assert.deepEqual(frameXmlLootMethod(group({ lootMethod }), 1n), [token, undefined, undefined]);
  }
  assert.deepEqual(frameXmlLootMethod(group({ lootMethod: 2, masterLooterGuid: 1n }), 1n), ["master", 0, undefined]);
  assert.deepEqual(frameXmlLootMethod(group({ lootMethod: 2, masterLooterGuid: 3n }), 1n), ["master", 2, undefined]);
  assert.deepEqual(frameXmlLootMethod(group({ lootMethod: 2, masterLooterGuid: 99n }), 1n), ["master", undefined, undefined]);
  assert.deepEqual(frameXmlLootMethod(group({ groupType: 2, lootMethod: 2, masterLooterGuid: 3n }), 1n),
    ["master", undefined, undefined], "raid offsets excluding self are not party aliases or proven raid indices");
  assert.deepEqual(frameXmlLootMethod(undefined, 1n), ["freeforall", undefined, undefined]);
  assert.equal(frameXmlLootMethod(group({ lootMethod: 99 }), 1n), undefined, "unknown wire enums stay unknown");
});

test("stock loot settings forward existing group protocol commands and await server updates", () => {
  const requests = [];
  const player = { guid: 1n, typeId: 4, fields: new Map() };
  const world = {
    group: group(), state: { selfGuid: 1n, objects: new Map([[1n, player]]) },
    names: new Map([[1n, "Игрок"]]),
    setLootMethod: (...args) => requests.push(args),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  assert.deepEqual(call("GetLootMethod"), ["group", undefined, undefined]);
  assert.deepEqual(call("GetLootThreshold"), [2]);
  call("SetLootMethod", "master", "Второй");
  call("SetLootMethod", "master", "party1", 3);
  call("SetLootMethod", "master", "player");
  call("SetLootMethod", "roundrobin");
  call("SetLootThreshold", 4);
  assert.deepEqual(requests, [[2, 3n, 2], [2, 2n, 3], [2, 1n, 2], [1, 0n, 2], [3, 0n, 4]]);
  assert.deepEqual(call("GetLootMethod"), ["group", undefined, undefined], "commands do not rewrite authoritative state");
  assert.deepEqual(call("GetLootThreshold"), [2]);
  call("SetLootMethod", "master", "Не в группе");
  call("SetLootMethod", "unknown");
  call("SetLootThreshold", 1);
  call("SetLootThreshold", 7);
  call("SetLootThreshold", 2.5);
  assert.equal(requests.length, 5, "invalid master/method/threshold never reaches the packet builder");
  world.group = group({ lootMethod: 2, masterLooterGuid: 3n, lootThreshold: 4 });
  assert.deepEqual(call("GetLootMethod"), ["master", 2, undefined]);
  call("SetLootThreshold", 5);
  assert.deepEqual(requests.at(-1), [2, 3n, 5], "threshold-only command preserves authoritative master");
  world.group = group({ leaderGuid: 2n });
  call("SetLootThreshold", 4);
  world.group = group({ groupType: 8 });
  call("SetLootMethod", "freeforall");
  assert.equal(requests.length, 6, "leader and LFG guards agree with HandleLootMethodOpcode");
});
