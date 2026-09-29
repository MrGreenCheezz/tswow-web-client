import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { AURA_FLAGS } = await import("../dist/code/world/AuraProtocol.js");

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

function fixture({ metadata = true, passive = false } = {}) {
  const selfGuid = 0x10n;
  const targetGuid = 0x20n;
  const events = new FakeEvents();
  const object = { guid: selfGuid, typeId: 4, fields: new Map() };
  const target = { guid: targetGuid, typeId: 3, fields: new Map() };
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, object], [targetGuid, target]]) },
    targetGuid,
    auras: new Map([[selfGuid, new Map([
      [2, { slot: 2, spellId: 172, flags: AURA_FLAGS.negative, casterLevel: 80, applications: 1,
        maxDuration: 15_000, duration: 10_000, expiresAt: 11_500 }],
      [5, { slot: 5, spellId: 6673, flags: AURA_FLAGS.positive | AURA_FLAGS.caster, casterLevel: 80,
        applications: 2, maxDuration: 30_000, duration: 20_000, expiresAt: 21_000 }],
    ])], [targetGuid, new Map([[1, {
      slot: 1, spellId: 172, flags: AURA_FLAGS.negative, casterLevel: 80, applications: 1,
    }]])]]),
    aurasFor(guid) {
      return [...(this.auras.get(guid)?.values() ?? [])].sort((left, right) => left.slot - right.slot);
    },
    events,
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    names: new Map(),
    creatureTemplates: new Map(),
    cancelAura: (spellId) => cancelled.push(spellId),
  };
  const fired = [];
  let pumpNow = 100;
  let monotonic = 1000;
  const pump = {
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
    now: () => pumpNow,
  };
  const cancelled = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => metadata ? ({
      id,
      name: id === 6673 ? "Боевой крик" : "Порча",
      rank: id === 6673 ? "Уровень 1" : "Уровень 2",
      iconPath: id === 6673 ? "Interface\\Icons\\Ability_Warrior_BattleShout" : "Interface\\Icons\\Spell_Shadow_Abomination",
      passive,
    }) : undefined,
    monotonic: () => monotonic,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  return {
    seam, world, events, fired, pump, cancelled, selfGuid, targetGuid,
    setPumpNow: (value) => { pumpNow = value; },
    setMonotonic: (value) => { monotonic = value; },
  };
}

test("live UnitAura maps packet flags, metadata and performance expiration to GetTime", () => {
  const { seam, pump } = fixture();
  seam.attach(pump);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("UnitAura", "player", 1, "HARMFUL"), [
    "Порча", "Уровень 2", "Interface\\Icons\\Spell_Shadow_Abomination", 1, undefined,
    15, 100 + (11_500 - 1_000) / 1_000, undefined, false, false, 172,
  ]);
  assert.deepEqual(call("UnitAura", "player", 1, "HELPFUL"), [
    "Боевой крик", "Уровень 1", "Interface\\Icons\\Ability_Warrior_BattleShout", 2, undefined,
    30, 100 + (21_000 - 1_000) / 1_000, "player", false, false, 6673,
  ]);
  assert.deepEqual(call("UnitAura", "player", 2, "HELPFUL"), []);
  assert.deepEqual(call("UnitAura", "target", 1, "HARMFUL"), [
    "Порча", "Уровень 2", "Interface\\Icons\\Spell_Shadow_Abomination", 1, undefined,
    0, 0, undefined, false, false, 172,
  ]);
  seam.detach();
});

test("live UNIT_AURA preserves the selected target identity and detaches", () => {
  const { seam, events, fired, pump, selfGuid, targetGuid } = fixture();
  seam.attach(pump);
  fired.length = 0;

  events.emit("AURA_CHANGED", { guid: targetGuid });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.aura, "target"]]);
  fired.length = 0;
  events.emit("AURA_CHANGED", { guid: selfGuid });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.aura, "player"]]);
  events.emit("AURA_CHANGED", { guid: selfGuid });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.aura, "player"],
    [FRAMEXML_SEAM_EVENTS.aura, "player"],
  ]);

  seam.detach();
  fired.length = 0;
  events.emit("AURA_CHANGED", { guid: selfGuid });
  assert.deepEqual(fired, []);
  assert.equal(events.listenerCount("AURA_CHANGED"), 0);
});

test("live known active helpful cancellation resolves the filtered index and sends once", () => {
  const { seam, pump, cancelled } = fixture();
  seam.attach(pump);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 1, "HELPFUL"]);
  assert.deepEqual(cancelled, [6673]);
  seam.detach();
});

test("live unknown metadata keeps aura visible with synchronous fallback and cancellation resolves filtered index", () => {
  const { seam, pump, cancelled } = fixture({ metadata: false });
  seam.attach(pump);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  assert.deepEqual(call("UnitAura", "player", 1, "HELPFUL"), [
    "Заклинание 6673", "", "", 2, undefined, 30, 120, "player", false, false, 6673,
  ]);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 1, "HELPFUL"]);
  assert.deepEqual(cancelled, []);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 1, "HARMFUL"]);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["target", 1, "HELPFUL"]);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 2, "HELPFUL"]);
  assert.deepEqual(cancelled, []);
  seam.detach();
});

test("live passive helpful, harmful, target, and out-of-range cancellation do nothing", () => {
  const { seam, pump, cancelled } = fixture({ passive: true });
  seam.attach(pump);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 1, "HELPFUL"]);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 1, "HARMFUL"]);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["target", 1, "HELPFUL"]);
  FRAMEXML_SEAM_BINDINGS.CancelUnitBuff(seam, ["player", 2, "HELPFUL"]);
  assert.deepEqual(cancelled, []);
  seam.detach();
});

test("live aura metadata refresh is throttled to the existing 60ms poll", () => {
  const second = fixture({ metadata: true });
  second.world.targetGuid = undefined;
  let label = "Боевой крик";
  const metadata = (id) => ({
    id, name: label, rank: "Уровень 1", iconPath: "Interface\\Icons\\Ability_Warrior_BattleShout",
  });
  const refreshed = new LiveWorldSeam({
    world: () => second.world,
    store: () => undefined,
    spell: metadata,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  refreshed.attach(second.pump);
  second.fired.length = 0;
  refreshed.tick(100);
  assert.deepEqual(second.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.aura), []);
  label = "Боевой крик (обновлён)";
  refreshed.tick(100.03);
  assert.deepEqual(second.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.aura), []);
  refreshed.tick(100.07);
  assert.deepEqual(second.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.aura), [
    [FRAMEXML_SEAM_EVENTS.aura, "player"],
  ], "metadata changes publish one refresh on the existing 60ms poll");
  assert.equal(FRAMEXML_SEAM_BINDINGS.UnitAura(refreshed, ["player", 1, "HELPFUL"])[0], "Боевой крик (обновлён)");
  refreshed.tick(100.1);
  assert.equal(second.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.aura).length, 1,
    "unchanged metadata does not repeat refresh");
});
