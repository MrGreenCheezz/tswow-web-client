// Plan item 1.08: dungeon/raid difficulty and IsInInstance (FrameXmlDifficulty.ts), with the original
// client's answers (Wow.exe 0x5156a0, 0x515790, 0x515810, 0x526050, 0x5261a0).
import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlDifficultyModel, FRAMEXML_DIFFICULTY_BINDINGS, frameXmlDifficultyWire } =
  await import("../dist/code/browser/framexml/FrameXmlDifficulty.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { globalString } = await import("../dist/code/generated/globalStrings.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

function fixture() {
  const world = {
    dungeonDifficulty: 1,
    raidDifficulty: 3,
    group: undefined,
    state: { selfGuid: 7n },
    calls: [],
    setDifficulty(difficulty, raid) { this.calls.push([difficulty, raid]); },
  };
  const place = { type: 0, arena: false };
  const model = new FrameXmlDifficultyModel({
    world: () => world, instanceType: () => place.type, inArena: () => place.arena,
  });
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const call = (name, ...args) => [...FRAMEXML_DIFFICULTY_BINDINGS[name]({ difficulty: model }, args)];
  return { world, place, model, fired, call };
}

test("Get*Difficulty answer the 1-based value in force and the player's own", () => {
  const { world, call } = fixture();
  assert.deepEqual(call("GetDungeonDifficulty"), [2, 2]);
  assert.deepEqual(call("GetRaidDifficulty"), [4, 4]);
  world.group = { leaderGuid: 9n, dungeonDifficulty: 0 };
  assert.deepEqual(call("GetDungeonDifficulty"), [1, 2], "in a group the group's difficulty is in force");
  assert.deepEqual(call("GetRaidDifficulty"), [4, 4]);
  assert.deepEqual([...FRAMEXML_DIFFICULTY_BINDINGS.GetDungeonDifficulty({}, [])], [1, 1]);
});

test("Set*Difficulty send the 0-based word; dungeons take 1..2, raids 1..4, rounded", () => {
  const { world, call } = fixture();
  assert.deepEqual(call("SetDungeonDifficulty", 2), []);
  call("SetRaidDifficulty", 4);
  call("SetDungeonDifficulty", 1);
  call("SetRaidDifficulty", "1");
  call("SetDungeonDifficulty", 2.4);
  assert.deepEqual(world.calls, [[1, false], [3, true], [0, false], [0, true], [1, false]]);
  for (const refused of [0, 3, 9, "x", undefined, -1, 0.4]) call("SetDungeonDifficulty", refused);
  for (const refused of [0, 5, "x", undefined]) call("SetRaidDifficulty", refused);
  assert.equal(world.calls.length, 5, "values outside the accepted range send nothing");
  assert.equal(frameXmlDifficultyWire(3, 2), undefined, "the epic dungeon mode is not SetDungeonDifficulty's");
  assert.equal(frameXmlDifficultyWire(3, 4), 2);
});

test("a group member who is not the leader gets ERR_NOT_LEADER in chat and nothing is sent", () => {
  const { world, fired, call } = fixture();
  world.group = { leaderGuid: 9n, dungeonDifficulty: 0 };
  call("SetDungeonDifficulty", 2);
  call("SetRaidDifficulty", 2);
  assert.deepEqual(world.calls, []);
  const text = globalString("ERR_NOT_LEADER");
  if (text) {
    assert.deepEqual(fired.map(([event, line]) => [event, line]), [["CHAT_MSG_SYSTEM", text], ["CHAT_MSG_SYSTEM", text]]);
  }
  world.group = { leaderGuid: 7n, dungeonDifficulty: 0 };
  call("SetDungeonDifficulty", 2);
  assert.deepEqual(world.calls, [[1, false]], "the leader sends");
});

test("IsInInstance answers 1 or nil and Map.InstanceType's word; the running arena wins", () => {
  const { place, call } = fixture();
  const expected = [[undefined, "none"], [1, "party"], [1, "raid"], [1, "pvp"], [1, "arena"], [1, "none"]];
  for (let type = 0; type <= 5; type++) {
    place.type = type;
    assert.deepEqual(call("IsInInstance"), expected[type], `InstanceType ${type}`);
  }
  place.type = undefined;
  assert.deepEqual(call("IsInInstance"), [undefined, "none"], "a map outside the metadata");
  place.arena = true;
  assert.deepEqual(call("IsInInstance"), [1, "arena"]);
  assert.deepEqual([...FRAMEXML_DIFFICULTY_BINDINGS.IsInInstance({ arena: { inArena: () => true } }, [])], [1, "arena"]);
  assert.deepEqual([...FRAMEXML_DIFFICULTY_BINDINGS.IsInInstance({}, [])], [undefined, "none"]);
});

test("the seams answer IsInInstance from the map metadata and the difficulties from the world", () => {
  const canned = new CannedWorldSeam();
  assert.deepEqual(api(canned, "IsInInstance"), [undefined, "none"]);
  canned.pvpWorld.instanceType = 3;
  assert.deepEqual(api(canned, "IsInInstance"), [1, "pvp"]);
  assert.deepEqual(api(canned, "GetDungeonDifficulty"), [1, 1]);
  api(canned, "SetRaidDifficulty", 2);
  assert.deepEqual(canned.pvpWorld.difficultyCalls, [{ difficulty: 1, raid: true }]);

  const calls = [];
  const world = {
    mapId: 529,
    dungeonDifficulty: 1,
    raidDifficulty: 0,
    state: { selfGuid: 7n, objects: new Map() },
    battlefieldQueues: new Map(),
    setDifficulty: (...args) => { calls.push(args); },
  };
  const mapSource = {
    metadata: () => ({ maps: [{ id: 529, instanceType: 3 }, { id: 33, instanceType: 1 }] }),
    location: () => undefined,
  };
  const live = new LiveWorldSeam({ world: () => world, store: () => undefined, monotonic: () => 5, mapSource });
  assert.deepEqual(api(live, "IsInInstance"), [1, "pvp"]);
  world.mapId = 33;
  assert.deepEqual(api(live, "IsInInstance"), [1, "party"]);
  world.mapId = 1;
  assert.deepEqual(api(live, "IsInInstance"), [undefined, "none"]);
  assert.deepEqual(api(live, "GetDungeonDifficulty"), [2, 2]);
  api(live, "SetDungeonDifficulty", 1);
  assert.deepEqual(calls, [[0, false]]);
});

test("a leader's change reaches the members' GetDungeonDifficulty before the next group list", async () => {
  // Group::SetDungeonDifficulty answers every member with MSG_SET_DUNGEON_DIFFICULTY(difficulty, 1,
  // inGroup 1) and sends no SMSG_GROUP_LIST; the client writes the group's value from it too
  // (Wow.exe 0x525530 with its third argument set).
  const { OPCODES } = await import("../dist/code/generated/opcodes.js");
  const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
  const { travelClient, settle } = await import("./fixtures/world-packets.mjs");
  const { client, connection } = await travelClient([], 7n);
  client.group = { leaderGuid: 9n, dungeonDifficulty: 0, raidDifficulty: 0, members: [] };
  const model = new FrameXmlDifficultyModel({ world: () => client });
  assert.deepEqual([...model.dungeon()], [1, 1]);
  connection.push(OPCODES.MSG_SET_DUNGEON_DIFFICULTY, new PacketWriter().u32(1).u32(1).u32(1).toUint8Array());
  await settle();
  assert.deepEqual([...model.dungeon()], [2, 2], "the group's value follows the server's answer");
  connection.push(OPCODES.MSG_SET_DUNGEON_DIFFICULTY, new PacketWriter().u32(0).u32(1).u32(0).toUint8Array());
  await settle();
  assert.deepEqual([...model.dungeon()], [2, 1], "an answer outside the group leaves the group's value");
});

test("without a seam the neutral IsInInstance is the client's nil, \"none\"", async () => {
  const { FRAMEXML_NEUTRAL_API, FRAMEXML_NEUTRAL_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
  const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
  const entry = FRAMEXML_NEUTRAL_API.find((candidate) => candidate.name === "IsInInstance");
  assert.equal(entry.values, undefined, "answered by the Lua half: a constant table cannot start with nil");
  const vm = new GlueLuaVm();
  try {
    vm.setGlobal("__fxNeutralImpl", {});
    vm.setGlobal("__fxAddonModules", []);
    assert.equal(vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@difficulty:neutral").ok, true);
    const run = vm.execute(`
      local inInstance, kind = __fxNeutralImpl.IsInInstance()
      __count = select("#", __fxNeutralImpl.IsInInstance())
      __isNil = inInstance == nil
      __kind = kind
    `, "@difficulty:probe");
    assert.equal(run.ok, true, run.error);
    assert.equal(vm.getGlobal("__count"), 2);
    assert.equal(vm.getGlobal("__isNil"), true);
    assert.equal(vm.getGlobal("__kind"), "none");
  } finally {
    vm.close();
  }
});
