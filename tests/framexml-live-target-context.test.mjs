import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const {
  CannedWorldSeam,
  CANNED_FOCUS,
  CANNED_TARGET,
  CANNED_TARGET_TARGET,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { AURA_FLAGS } = await import("../dist/code/world/AuraProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

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

function object(guid, typeId) {
  return { guid, typeId, fields: new Map() };
}

function fixture() {
  const selfGuid = 0x10n;
  const targetGuid = 0x20n;
  const nextTargetGuid = 0x30n;
  const events = new FakeEvents();
  const self = object(selfGuid, 4);
  const target = object(targetGuid, 3);
  const nextTarget = object(nextTargetGuid, 3);
  const objects = new Map([
    [selfGuid, self],
    [targetGuid, target],
    [nextTargetGuid, nextTarget],
  ]);
  const targetAura = {
    slot: 1,
    spellId: 6673,
    flags: AURA_FLAGS.positive,
    casterLevel: 80,
    applications: 2,
    casterGuid: selfGuid,
    maxDuration: 30_000,
    duration: 20_000,
    expiresAt: 21_500,
  };
  const targetDebuff = {
    slot: 2,
    spellId: 172,
    flags: AURA_FLAGS.negative,
    casterLevel: 80,
    applications: 1,
    casterGuid: targetGuid,
  };
  const auras = new Map([
    [targetGuid, [targetAura, targetDebuff]],
    [nextTargetGuid, []],
  ]);
  const cast = {
    spellId: 42,
    startedAt: 900,
    duration: 2_500,
    channel: false,
    castCount: 7,
  };
  const world = {
    state: { selfGuid, objects },
    targetGuid,
    casts: new Map([[targetGuid, cast]]),
    aurasFor: (guid) => auras.get(guid) ?? [],
    events,
    actionButtons: [],
    cooldownState: () => undefined,
    cooldownRemaining: () => 0,
    names: new Map([[targetGuid, "Цель"]]),
    creatureTemplates: new Map(),
  };
  const fired = [];
  const pump = {
    now: () => 123.456,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => ({
      id,
      name: id === 6673 ? "Боевой крик" : id === 172 ? "Порча" : "Test Spell",
      rank: id === 6673 ? "Уровень 1" : id === 172 ? "Уровень 2" : "Rank 2",
      iconPath: id === 6673
        ? "Interface\\Icons\\Ability_Warrior_BattleShout"
        : id === 172
          ? "Interface\\Icons\\Spell_Shadow_Abomination"
          : "Interface\\Icons\\Spell_Test",
    }),
    monotonic: () => 1_000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  return { seam, world, events, fired, selfGuid, targetGuid, nextTargetGuid, cast, targetAura };
}

test("target queries expose a cast and filtered aura snapshot already active at selection", () => {
  const { seam, fired, targetGuid } = fixture();
  seam.attach({ now: () => 123.456, fire: (event, ...args) => {
    fired.push([event, ...args]);
    return 1;
  } });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("UnitCastingInfo", "target"), [
    "Test Spell", "Rank 2", "Test Spell", "Interface\\Icons\\Spell_Test",
    123_356, 125_856, false, 7, false,
  ]);
  assert.deepEqual(call("UnitChannelInfo", "target"), []);
  assert.deepEqual(call("UnitAura", "target", 1, "HELPFUL"), [
    "Боевой крик", "Уровень 1", "Interface\\Icons\\Ability_Warrior_BattleShout", 2, undefined,
    30, 123.456 + (21_500 - 1_000) / 1_000, "player", false, false, 6673,
  ]);
  assert.deepEqual(call("UnitBuff", "target", 1), call("UnitAura", "target", 1, "HELPFUL"));
  assert.deepEqual(call("UnitDebuff", "target", 1), [
    "Порча", "Уровень 2", "Interface\\Icons\\Spell_Shadow_Abomination", 1, undefined,
    0, 0, "target", false, false, 172,
  ]);
  assert.deepEqual(call("UnitAura", "player", 1, "HELPFUL"), [], "player behavior stays unchanged");
  assert.equal(targetGuid, 0x20n);
  seam.detach();
});

test("target cast and aura edges are bounded by selected identity and detach", () => {
  const { seam, world, events, fired, targetGuid, nextTargetGuid } = fixture();
  seam.attach({ now: () => 123.456, fire: (event, ...args) => {
    fired.push([event, ...args]);
    return 1;
  } });
  fired.length = 0;

  events.emit("SPELL_CAST_START", {
    casterGuid: targetGuid, spellId: 42, castTime: 2_500, channel: false,
  });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.castStart, "target", "Test Spell", "Rank 2", 7]]);

  fired.length = 0;
  events.emit("AURA_CHANGED", { guid: targetGuid });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.aura, "target"]]);

  fired.length = 0;
  world.casts.set(targetGuid, {
    spellId: 42, startedAt: 900, duration: 4_000, channel: true,
  });
  events.emit("SPELL_CAST_START", {
    casterGuid: targetGuid, spellId: 42, castTime: 4_000, channel: true,
  });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.channelStart, "target"]]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UnitChannelInfo(seam, ["target"]), [
    "Test Spell", "Rank 2", "Test Spell", "Interface\\Icons\\Spell_Test",
    123_356, 127_356, false, false,
  ]);
  fired.length = 0;
  events.emit("SPELL_CHANNEL_UPDATE", { casterGuid: targetGuid, spellId: 42, remaining: 2_000 });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.channelUpdate, "target"]]);
  fired.length = 0;
  world.casts.delete(targetGuid);
  events.emit("SPELL_CAST_STOP", { casterGuid: targetGuid, spellId: 42, interrupted: false });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.channelStop, "target"]]);

  world.targetGuid = nextTargetGuid;
  seam.tick(1);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged), [
    [FRAMEXML_SEAM_EVENTS.targetChanged],
  ]);
  fired.length = 0;

  // The old target's delayed/stop packet is still on the bus, but it must not repaint new target.
  events.emit("SPELL_CAST_DELAYED", { casterGuid: targetGuid, delay: 125 });
  events.emit("SPELL_CAST_STOP", {
    casterGuid: targetGuid, spellId: 42, interrupted: true, reason: "interrupted",
  });
  events.emit("AURA_CHANGED", { guid: targetGuid });
  assert.deepEqual(fired, []);

  // The new target may become active independently and gets stock-compatible target arguments.
  world.casts.set(nextTargetGuid, {
    spellId: 42, startedAt: 900, duration: 2_500, channel: false, castCount: 8,
  });
  events.emit("SPELL_CAST_START", {
    casterGuid: nextTargetGuid, spellId: 42, castTime: 2_500, channel: false,
  });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.castStart, "target", "Test Spell", "Rank 2", 8]]);

  seam.detach();
  fired.length = 0;
  events.emit("SPELL_CAST_START", {
    casterGuid: nextTargetGuid, spellId: 42, castTime: 2_500, channel: false,
  });
  events.emit("AURA_CHANGED", { guid: nextTargetGuid });
  assert.deepEqual(fired, []);
  assert.equal(events.listenerCount("SPELL_CAST_START"), 0);
});

test("canned target selection exposes bounded cast and aura aliases without changing player state", () => {
  const seam = new CannedWorldSeam();
  let now = 100;
  const fired = [];
  seam.attach({
    now: () => now,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  });
  fired.length = 0;
  seam.tick(now);
  seam.tick(now);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("UnitCastingInfo", "target"), [
    "Огненный шар", "Уровень 1", "Огненный шар", "Interface\\Icons\\Spell_Fire_FlameBolt",
    100_000, 102_000, false, 42, false,
  ]);
  assert.deepEqual(call("UnitChannelInfo", "target"), []);
  assert.deepEqual(call("UnitBuff", "target", 1), [
    "Боевой крик", "", "Interface\\Icons\\Ability_Warrior_BattleShout", 1, undefined,
    30, 120, "player", false, false, 6673,
  ]);
  assert.deepEqual(call("UnitDebuff", "target", 1), [
    "Порча", "", "Interface\\Icons\\Spell_Shadow_Abomination", 1, undefined,
    10, 108, "target", false, false, 172,
  ]);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.targetChanged), [
    [FRAMEXML_SEAM_EVENTS.targetChanged],
  ]);
  seam.detach();
});

test("live focus and target-of-target keep current identities and never alias player/target", () => {
  const selfGuid = 0x10n;
  const targetGuid = 0x20n;
  const focusGuidA = 0x30n;
  const focusGuidB = 0x40n;
  const totGuidA = 0x50n;
  const totGuidB = 0x60n;
  const events = new FakeEvents();
  const self = object(selfGuid, 4);
  const target = object(targetGuid, 3);
  const focusA = object(focusGuidA, 3);
  const focusB = object(focusGuidB, 3);
  const totA = object(totGuidA, 3);
  const totB = object(totGuidB, 3);
  const setField = (state, name, value) => state.fields.set(UPDATE_FIELDS[name].offset, value);
  setField(self, "UNIT_FIELD_HEALTH", 4000);
  setField(self, "UNIT_FIELD_MAXHEALTH", 5000);
  setField(target, "UNIT_FIELD_HEALTH", 1200);
  setField(target, "UNIT_FIELD_MAXHEALTH", 2000);
  setField(focusA, "UNIT_FIELD_HEALTH", 700);
  setField(focusA, "UNIT_FIELD_MAXHEALTH", 900);
  setField(focusB, "UNIT_FIELD_HEALTH", 500);
  setField(focusB, "UNIT_FIELD_MAXHEALTH", 800);
  setField(totA, "UNIT_FIELD_HEALTH", 300);
  setField(totA, "UNIT_FIELD_MAXHEALTH", 600);
  setField(totB, "UNIT_FIELD_HEALTH", 200);
  setField(totB, "UNIT_FIELD_MAXHEALTH", 400);
  setField(target, "UNIT_FIELD_TARGET", totGuidA);
  const objects = new Map([
    [selfGuid, self], [targetGuid, target], [focusGuidA, focusA], [focusGuidB, focusB],
    [totGuidA, totA], [totGuidB, totB],
  ]);
  const auras = new Map([
    [focusGuidA, [{ slot: 1, spellId: 6673, flags: AURA_FLAGS.positive, applications: 1, casterGuid: selfGuid }]],
    [focusGuidB, []], [totGuidA, [{ slot: 1, spellId: 172, flags: AURA_FLAGS.negative, applications: 1, casterGuid: selfGuid }]],
    [totGuidB, []],
  ]);
  const casts = new Map();
  let selectedFocus;
  const world = {
    state: { selfGuid, objects },
    get targetGuid() { return this._targetGuid; },
    _targetGuid: undefined,
    casts,
    aurasFor: (guid) => auras.get(guid) ?? [],
    events,
    actionButtons: [],
    cooldownState: () => undefined,
    cooldownRemaining: () => 0,
    names: new Map([[focusGuidA, "Фокус A"], [focusGuidB, "Фокус B"], [totGuidA, "Тот A"], [totGuidB, "Тот B"]]),
    creatureTemplates: new Map(),
  };
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => ({ field: () => () => {}, events }),
    spell: (id) => ({ id, name: `spell-${id}`, rank: "", iconPath: "Interface\\Icons\\Spell_Test" }),
    focusGuid: () => selectedFocus,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const pump = {
    now: () => 100,
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
  };
  seam.attach(pump);
  fired.length = 0;
  world._targetGuid = targetGuid;
  selectedFocus = focusGuidA;
  seam.tick(1);
  assert.deepEqual(fired.filter(([event]) => [
    FRAMEXML_SEAM_EVENTS.targetChanged, FRAMEXML_SEAM_EVENTS.focusChanged, "UNIT_TARGET",
  ].includes(event)), [
    [FRAMEXML_SEAM_EVENTS.targetChanged],
    ["UNIT_TARGET", "target"],
    [FRAMEXML_SEAM_EVENTS.focusChanged],
  ]);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  assert.deepEqual(call("UnitName", "focus"), ["Фокус A"]);
  assert.deepEqual(call("UnitHealth", "focus"), [700]);
  assert.deepEqual(call("UnitHealth", "player"), [4000]);
  assert.deepEqual(call("UnitHealth", "target"), [1200]);
  assert.deepEqual(call("UnitName", "targettarget"), ["Тот A"]);
  assert.deepEqual(call("UnitHealth", "targettarget"), [300]);
  assert.deepEqual(call("UnitHealth", "focus"), [700], "focus is not the selected target");

  fired.length = 0;
  events.emit("UNIT_HEALTH", { guid: focusGuidA });
  events.emit("UNIT_POWER", { guid: focusGuidA });
  events.emit("UNIT_HEALTH", { guid: totGuidA });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.health, "focus"], ["UNIT_MANA", "focus"],
    [FRAMEXML_SEAM_EVENTS.health, "targettarget"],
  ]);
  fired.length = 0;
  events.emit("AURA_CHANGED", { guid: focusGuidA });
  events.emit("AURA_CHANGED", { guid: totGuidA });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.aura, "focus"], [FRAMEXML_SEAM_EVENTS.aura, "targettarget"],
  ]);

  casts.set(focusGuidA, { spellId: 7, startedAt: 900, duration: 2000, channel: false, castCount: 1 });
  events.emit("SPELL_CAST_START", { casterGuid: focusGuidA, spellId: 7, channel: false });
  assert.deepEqual(fired.at(-1), [FRAMEXML_SEAM_EVENTS.castStart, "focus", "spell-7", "", 1]);
  setField(target, "UNIT_FIELD_TARGET", totGuidB);
  fired.length = 0;
  events.emit("UNIT_TARGET", { guid: targetGuid });
  assert.deepEqual(fired, [["UNIT_TARGET", "target"]]);
  assert.deepEqual(call("UnitName", "targettarget"), ["Тот B"]);
  events.emit("AURA_CHANGED", { guid: totGuidA });
  events.emit("SPELL_CAST_START", { casterGuid: totGuidA, spellId: 7, channel: false });
  assert.deepEqual(fired, [["UNIT_TARGET", "target"]], "old target-of-target cannot repaint the new one");

  fired.length = 0;
  selectedFocus = focusGuidB;
  seam.tick(1.1);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.focusChanged), [
    [FRAMEXML_SEAM_EVENTS.focusChanged],
  ]);
  events.emit("AURA_CHANGED", { guid: focusGuidA });
  events.emit("SPELL_CAST_DELAYED", { casterGuid: focusGuidA, delay: 100 });
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.aura
    || event === FRAMEXML_SEAM_EVENTS.castDelayed), [], "old focus cannot repaint a new focus");
  assert.deepEqual(call("UnitName", "focus"), ["Фокус B"]);
  selectedFocus = undefined;
  seam.tick(1.2);
  assert.deepEqual(call("UnitExists", "focus"), [false]);
  assert.deepEqual(call("UnitHealth", "focus"), [0]);
  assert.deepEqual(call("UnitHealth", "player"), [4000], "focus loss does not alias player");
  seam.detach();
});

test("canned focus and target-of-target setters expose separate current fixtures", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({ now: () => 100, fire: (event, ...args) => {
    fired.push([event, ...args]);
    return 1;
  } });
  fired.length = 0;
  assert.ok(seam.setTarget(CANNED_TARGET) > 0);
  assert.ok(seam.setFocus(CANNED_FOCUS) > 0);
  assert.ok(seam.setTargetTarget(CANNED_TARGET_TARGET) > 0);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  assert.deepEqual(call("UnitName", "focus"), [CANNED_FOCUS.name]);
  assert.deepEqual(call("UnitHealth", "focus"), [CANNED_FOCUS.health]);
  assert.deepEqual(call("UnitName", "targettarget"), [CANNED_TARGET_TARGET.name]);
  assert.deepEqual(call("UnitHealth", "target"), [CANNED_TARGET.health]);
  assert.deepEqual(call("UnitHealth", "player"), [4230], "extra unit fixtures do not alias player");
  assert.deepEqual(call("UnitBuff", "focus", 1), call("UnitBuff", "target", 1));
  assert.ok(seam.setFocusCast(true) > 0);
  assert.notDeepEqual(call("UnitCastingInfo", "focus"), [], "focus cast is current while selected");
  assert.ok(seam.setTargetTargetCast(true) > 0);
  assert.notDeepEqual(call("UnitCastingInfo", "targettarget"), []);
  seam.setFocus(undefined);
  seam.setTargetTarget(undefined);
  assert.deepEqual(call("UnitExists", "focus"), [false]);
  assert.deepEqual(call("UnitExists", "targettarget"), [false]);
  assert.deepEqual(call("UnitBuff", "focus", 1), []);
  assert.deepEqual(call("UnitCastingInfo", "targettarget"), []);
  seam.detach();
});
