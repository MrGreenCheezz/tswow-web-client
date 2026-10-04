// Plan item 1.09: the PvP flag C API (FrameXmlPvpFlag.ts) — GetPVPDesired, SetPVP, TogglePVP,
// IsPVPTimerRunning, GetPVPTimer — with the original client's answers (Wow.exe 0x51bca0, 0x51bd60,
// 0x51bd00/0x6de7a0, 0x5168b0, 0x516840; described in FrameXmlPvpFlag.ts).
import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlPvpFlagModel, FRAMEXML_PVP_FLAG_BINDINGS, frameXmlSetPvpEnable, frameXmlRoundToInt } =
  await import("../dist/code/browser/framexml/FrameXmlPvpFlag.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { PLAYER_FLAGS_IN_PVP, PLAYER_FLAGS_PVP_TIMER, PLAYER_FLAGS_AFK } = await import("../dist/code/world/Fields.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

function model(initialFlags) {
  const clock = { now: 1000, flags: initialFlags, calls: [] };
  const flag = new FrameXmlPvpFlagModel({
    flags: () => clock.flags,
    now: () => clock.now,
    togglePvp: (...args) => { clock.calls.push(args); },
  });
  return { clock, flag };
}

test("the flag bits and constants are TrinityCore's (Player.h:363, :372)", () => {
  assert.equal(PLAYER_FLAGS_IN_PVP, 0x200);
  assert.equal(PLAYER_FLAGS_PVP_TIMER, 0x40000);
});

test("GetPVPDesired is the number 1 or 0, never a boolean; 0 without a player", () => {
  const { clock, flag } = model(0);
  const host = { pvpFlag: flag };
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.GetPVPDesired(host, [])], [0]);
  clock.flags = PLAYER_FLAGS_IN_PVP | PLAYER_FLAGS_AFK;
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.GetPVPDesired(host, [])], [1]);
  clock.flags = undefined;
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.GetPVPDesired(host, [])], [0]);
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.GetPVPDesired({}, [])], [0]);
});

test("IsPVPTimerRunning answers 1 or a single nil", () => {
  const { clock, flag } = model(0);
  const host = { pvpFlag: flag };
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.IsPVPTimerRunning(host, [])], [undefined]);
  clock.flags = PLAYER_FLAGS_PVP_TIMER;
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.IsPVPTimerRunning(host, [])], [1]);
});

test("GetPVPTimer counts the client's own five minutes from the flag change, plus 1000", () => {
  const { clock, flag } = model(PLAYER_FLAGS_IN_PVP);
  flag.enterWorld();
  const timer = () => FRAMEXML_PVP_FLAG_BINDINGS.GetPVPTimer({ pvpFlag: flag }, [])[0];
  // Timer bit clear: the helper's 300000, plus the Lua function's 1000.
  assert.equal(timer(), 301000);
  // Switched off at t=1000: the server raises the timer bit; the deadline is now + 300000.
  clock.flags = PLAYER_FLAGS_PVP_TIMER;
  flag.flagsChanged();
  clock.now = 101_000;
  assert.equal(timer(), 200_000 + 1000);
  // Another flag moving while the timer runs keeps the deadline.
  clock.flags = PLAYER_FLAGS_PVP_TIMER | PLAYER_FLAGS_AFK;
  flag.flagsChanged();
  assert.equal(timer(), 201_000);
  // Past the deadline while the bit is still up: -1 + 1000.
  clock.now = 401_000;
  assert.equal(timer(), 999);
  // Switched on again: no deadline; the bit clear answers 301000 again.
  clock.flags = PLAYER_FLAGS_IN_PVP;
  flag.flagsChanged();
  assert.equal(timer(), 301_000);
  assert.equal(FRAMEXML_PVP_FLAG_BINDINGS.GetPVPTimer({}, [])[0], 0);
});

test("entering the world with the timer already running keeps no deadline (0x6e7f50): 999", () => {
  const { flag } = model(PLAYER_FLAGS_PVP_TIMER);
  flag.flagsChanged(); // the first look is the entry into the world
  assert.equal(flag.timer(), 999);
  const fresh = model(0);
  fresh.flag.flagsChanged();
  fresh.clock.flags = PLAYER_FLAGS_PVP_TIMER;
  fresh.flag.flagsChanged();
  fresh.clock.now += 100_000;
  assert.equal(fresh.flag.timer(), 201_000);
});

test("SetPVP sends the rounded number's byte, so nil, true and 0 all switch the flag off", () => {
  const { clock, flag } = model(0);
  const host = { pvpFlag: flag };
  for (const value of [1, "1", 2, undefined, true, false, 0, 0.4, 256, "x"]) {
    assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.SetPVP(host, [value])], []);
  }
  assert.deepEqual(clock.calls, [[true], [true], [true], [false], [false], [false], [false], [false], [false], [false]]);
  assert.equal(frameXmlSetPvpEnable(1.5), true, "1.5 rounds to 2");
  assert.equal(frameXmlSetPvpEnable(0.5), false, "0.5 rounds to even 0");
  assert.equal(frameXmlRoundToInt(2.5), 2);
  assert.equal(frameXmlRoundToInt(-1.5), -2);
});

test("TogglePVP toggles: no argument reaches WorldClient.togglePvp", () => {
  const { clock, flag } = model(0);
  assert.deepEqual([...FRAMEXML_PVP_FLAG_BINDINGS.TogglePVP({ pvpFlag: flag }, ["ignored"])], []);
  assert.deepEqual(clock.calls, [[]]);
});

test("the canned and live seams bind the five names over their own player", () => {
  const canned = new CannedWorldSeam();
  assert.deepEqual(api(canned, "GetPVPDesired"), [0]);
  assert.deepEqual(api(canned, "IsPVPTimerRunning"), [undefined]);
  canned.pvpWorld.setPlayerFlags(PLAYER_FLAGS_IN_PVP);
  assert.deepEqual(api(canned, "GetPVPDesired"), [1]);
  api(canned, "SetPVP", undefined);
  api(canned, "TogglePVP");
  assert.deepEqual(canned.pvpWorld.pvpCalls, [false, undefined]);

  const self = { guid: 7n, typeId: 4, fields: new Map([[UPDATE_FIELDS.PLAYER_FLAGS.offset, PLAYER_FLAGS_IN_PVP]]) };
  const calls = [];
  const world = {
    state: { selfGuid: 7n, objects: new Map([[7n, self]]) },
    togglePvp: (...args) => { calls.push(args); },
  };
  const live = new LiveWorldSeam({ world: () => world, store: () => undefined, monotonic: () => 5 });
  assert.deepEqual(api(live, "GetPVPDesired"), [1]);
  api(live, "SetPVP", 1);
  api(live, "TogglePVP");
  assert.deepEqual(calls, [[true], [undefined]]);
  self.fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, PLAYER_FLAGS_PVP_TIMER);
  assert.deepEqual(api(live, "IsPVPTimerRunning"), [1]);
});
