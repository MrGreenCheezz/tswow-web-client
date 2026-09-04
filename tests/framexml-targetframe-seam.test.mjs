import assert from "node:assert/strict";
import test from "node:test";

const {
  CANNED_TARGET,
  CannedWorldSeam,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

test("canned target is absent, then acquired, updated and lost once", () => {
  const seam = new CannedWorldSeam();
  let now = 100;
  const events = [];
  seam.attach({
    now: () => now,
    fire: (event, ...args) => {
      events.push([event, ...args]);
      return 1;
    },
  });
  events.length = 0;
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("UnitExists", "target"), [false]);
  assert.deepEqual(call("UnitName", "target"), []);
  assert.deepEqual(call("UnitIsConnected", "target"), [false]);

  seam.tick(now);
  assert.deepEqual(call("UnitExists", "target"), [false], "first tick anchors the target timeline");
  seam.tick(now);
  assert.deepEqual(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged), [
    [FRAMEXML_SEAM_EVENTS.targetChanged],
  ]);
  assert.deepEqual(call("UnitName", "target"), [CANNED_TARGET.name]);
  assert.deepEqual(call("UnitLevel", "target"), [CANNED_TARGET.level]);
  assert.deepEqual(call("UnitHealth", "target"), [CANNED_TARGET.health]);
  assert.deepEqual(call("UnitHealthMax", "target"), [CANNED_TARGET.healthMax]);
  assert.deepEqual(call("UnitPower", "target"), [CANNED_TARGET.power]);
  assert.deepEqual(call("UnitPowerMax", "target"), [CANNED_TARGET.powerMax]);
  assert.deepEqual(call("UnitPowerType", "target"), [0, "MANA"]);
  assert.deepEqual(call("UnitClass", "target"), [CANNED_TARGET.className, CANNED_TARGET.classToken]);
  assert.deepEqual(call("UnitRace", "target"), [CANNED_TARGET.raceName, CANNED_TARGET.raceToken]);
  assert.deepEqual(call("UnitFactionGroup", "target"), [CANNED_TARGET.factionGroup]);
  assert.deepEqual(call("UnitClassification", "target"), [CANNED_TARGET.classification]);
  assert.deepEqual(call("UnitIsPlayer", "target"), [true]);
  assert.deepEqual(call("UnitIsConnected", "target"), [true]);
  assert.deepEqual(call("UnitIsEnemy", "player", "target"), [true]);
  assert.deepEqual(call("UnitIsFriend", "player", "target"), [false]);
  assert.deepEqual(call("UnitCanAttack", "player", "target"), [true]);
  assert.deepEqual(call("UnitSelectionColor", "target"), [1, 0, 0]);

  // A repeated rendered frame is quiet: the target edge is not a polling heartbeat.
  seam.tick(now);
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged).length, 1);

  now += 0.5;
  seam.tick(now);
  assert.deepEqual(events.filter(([event, ...args]) =>
    event === FRAMEXML_SEAM_EVENTS.health && args[0] === "target"), [
    [FRAMEXML_SEAM_EVENTS.health, "target"],
  ]);
  assert.equal(call("UnitHealth", "target")[0], Math.round(CANNED_TARGET.healthMax * 0.65));

  now += 0.5;
  seam.tick(now);
  assert.deepEqual(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged), [
    [FRAMEXML_SEAM_EVENTS.targetChanged],
    [FRAMEXML_SEAM_EVENTS.targetChanged],
  ]);
  assert.deepEqual(call("UnitExists", "target"), [false]);
  assert.deepEqual(call("UnitName", "target"), []);
  assert.deepEqual(call("UnitHealth", "target"), [0]);
  assert.deepEqual(call("UnitSelectionColor", "target"), []);
  seam.tick(now);
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged).length, 2);
  seam.detach();
  seam.detach();
});

test("canned target override preserves identity and exact selection edges", () => {
  const seam = new CannedWorldSeam();
  const events = [];
  seam.attach({
    now: () => 100,
    fire: (event, ...args) => {
      events.push([event, ...args]);
      return 1;
    },
  });
  events.length = 0;
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  assert.equal(seam.setTarget(undefined), 0);
  assert.equal(seam.setTarget(CANNED_TARGET), 1);
  assert.deepEqual(events, [[FRAMEXML_SEAM_EVENTS.targetChanged]]);
  events.length = 0;
  assert.equal(seam.setTarget(CANNED_TARGET), 0);
  assert.deepEqual(events, []);
  assert.equal(seam.setTargetHealth(0), 1);
  assert.deepEqual(events, [[FRAMEXML_SEAM_EVENTS.health, "target"]]);
  events.length = 0;
  const neutral = Object.freeze({ ...CANNED_TARGET, reaction: 0 });
  assert.equal(seam.setTarget(neutral), 1);
  assert.deepEqual(events, [[FRAMEXML_SEAM_EVENTS.targetChanged]]);
  assert.deepEqual(call("UnitIsEnemy", "player", "target"), [false]);
  assert.deepEqual(call("UnitIsFriend", "player", "target"), [false]);
  assert.deepEqual(call("UnitCanAttack", "player", "target"), [true]);
  assert.deepEqual(call("UnitSelectionColor", "target"), [1, 1, 0]);
  seam.detach();
});
