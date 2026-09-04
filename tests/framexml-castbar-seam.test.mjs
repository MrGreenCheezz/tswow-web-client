import assert from "node:assert/strict";
import test from "node:test";

const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const {
  CannedWorldSeam,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");

const castEventNames = {
  castStart: "UNIT_SPELLCAST_START",
  castStop: "UNIT_SPELLCAST_STOP",
  castFailed: "UNIT_SPELLCAST_FAILED",
  castInterrupted: "UNIT_SPELLCAST_INTERRUPTED",
  castDelayed: "UNIT_SPELLCAST_DELAYED",
  channelStart: "UNIT_SPELLCAST_CHANNEL_START",
  channelUpdate: "UNIT_SPELLCAST_CHANNEL_UPDATE",
  channelStop: "UNIT_SPELLCAST_CHANNEL_STOP",
  interruptible: "UNIT_SPELLCAST_INTERRUPTIBLE",
  notInterruptible: "UNIT_SPELLCAST_NOT_INTERRUPTIBLE",
};

test("cast seam exposes the exact FrameXML API and event spellings", () => {
  for (const [key, value] of Object.entries(castEventNames)) {
    assert.equal(FRAMEXML_SEAM_EVENTS[key], value, `${key} event`);
  }
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.UnitCastingInfo, "function");
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.UnitChannelInfo, "function");
});

test("canned cast transitions are exact, player-only, and do not repeat", () => {
  const seam = new CannedWorldSeam();
  let now = 1000;
  const events = [];
  seam.attach({
    now: () => now,
    fire: (event, ...args) => {
      events.push([event, ...args]);
      return 1;
    },
  });
  events.length = 0;

  const call = (name, unit) => FRAMEXML_SEAM_BINDINGS[name](seam, [unit]);
  const castEvents = () => events.filter(([event]) => event.startsWith("UNIT_SPELLCAST_"));
  assert.deepEqual(call("UnitCastingInfo", "player"), [], "no cast before the first tick");
  assert.deepEqual(call("UnitCastingInfo", "target"), [], "unknown unit is nil");
  assert.deepEqual(call("UnitChannelInfo", "player"), [], "no channel before the first tick");

  seam.tick(now);
  assert.deepEqual(call("UnitCastingInfo", "player"), [
    "Огненный шар", "Уровень 1", "Огненный шар", "Interface\\Icons\\Spell_Fire_FlameBolt",
    1000000, 1001500, false, 42, false,
  ]);
  assert.deepEqual(events, [["UNIT_SPELLCAST_START", "player", "Огненный шар", "Уровень 1", 42]]);

  seam.tick(now);
  assert.deepEqual(castEvents(), [["UNIT_SPELLCAST_START", "player", "Огненный шар", "Уровень 1", 42]],
    "an unchanged tick does not repeat START");

  now = 1000.5;
  seam.tick(now);
  assert.deepEqual(call("UnitCastingInfo", "player"), [
    "Огненный шар", "Уровень 1", "Огненный шар", "Interface\\Icons\\Spell_Fire_FlameBolt",
    1000000, 1001750, false, 42, false,
  ]);
  assert.deepEqual(castEvents(), [
    ["UNIT_SPELLCAST_START", "player", "Огненный шар", "Уровень 1", 42],
    ["UNIT_SPELLCAST_DELAYED", "player", "Огненный шар", "Уровень 1", 42],
  ]);

  now = 1001.75;
  seam.tick(now);
  assert.deepEqual(call("UnitCastingInfo", "player"), [], "the cast ended");
  assert.deepEqual(call("UnitChannelInfo", "player"), [
    "Похищение жизни", "Уровень 1", "Похищение жизни", "Interface\\Icons\\Spell_Shadow_LifeDrain02",
    1001750, 1006750, false, false,
  ]);
  assert.deepEqual(castEvents(), [
    ["UNIT_SPELLCAST_START", "player", "Огненный шар", "Уровень 1", 42],
    ["UNIT_SPELLCAST_DELAYED", "player", "Огненный шар", "Уровень 1", 42],
    ["UNIT_SPELLCAST_STOP", "player", "Огненный шар", "Уровень 1", 42],
    ["UNIT_SPELLCAST_CHANNEL_START", "player"],
  ]);

  now = 1002.25;
  seam.tick(now);
  assert.deepEqual(call("UnitChannelInfo", "player"), [
    "Похищение жизни", "Уровень 1", "Похищение жизни", "Interface\\Icons\\Spell_Shadow_LifeDrain02",
    1001750, 1007000, false, false,
  ]);
  assert.deepEqual(castEvents().at(-1), ["UNIT_SPELLCAST_CHANNEL_UPDATE", "player"]);

  seam.tick(now);
  assert.deepEqual(castEvents().at(-1), ["UNIT_SPELLCAST_CHANNEL_UPDATE", "player"],
    "an unchanged channel tick does not repeat UPDATE");

  now = 1007;
  seam.tick(now);
  assert.deepEqual(call("UnitChannelInfo", "player"), []);
  assert.deepEqual(castEvents().at(-1), ["UNIT_SPELLCAST_CHANNEL_STOP", "player"]);
  seam.detach();
});

test("the first tick anchors the canned timeline after a slow mount", () => {
  const seam = new CannedWorldSeam();
  let now = 1000;
  const events = [];
  seam.attach({
    now: () => now,
    fire: (event, ...args) => {
      events.push([event, ...args]);
      return 1;
    },
  });
  events.length = 0;
  now = 1010;
  seam.tick(now);

  const castEvents = () => events.filter(([event]) => event.startsWith("UNIT_SPELLCAST_"));
  assert.deepEqual(castEvents(), [["UNIT_SPELLCAST_START", "player", "Огненный шар", "Уровень 1", 42]]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UnitCastingInfo(seam, ["player"]), [
    "Огненный шар", "Уровень 1", "Огненный шар", "Interface\\Icons\\Spell_Fire_FlameBolt",
    1010000, 1011500, false, 42, false,
  ]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UnitChannelInfo(seam, ["player"]), []);

  seam.tick(now);
  assert.deepEqual(castEvents(), [["UNIT_SPELLCAST_START", "player", "Огненный шар", "Уровень 1", 42]],
    "a repeated first tick does not duplicate START");
  seam.detach();
});
