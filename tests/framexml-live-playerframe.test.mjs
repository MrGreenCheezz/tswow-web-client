import assert from "node:assert/strict";
import test from "node:test";

// World cast events have two subscribers per attach: the player cast bar and the arena opponents' cast
// bars (FrameXmlArena.ts). The checks below are about duplicates on re-attach and a clean detach.
const CAST_SUBSCRIBERS = 2;
// seam-sweep: the combat log's SPELL_CAST_START entries no longer hear the bar's SPELL_CAST_START — since
// 3.01-castlog they come from the bus event SPELL_START (the whole SMSG_SPELL_START, Wow.exe 0x00806700 →
// 0x00805330 → 0x006fbe50 → 0x00751920; WORK_PLAN 3.01, «03.10, линия stock-small (`3.01-castlog`)»), so
// SPELL_CAST_START has the two bar subscribers and SPELL_START the combat log's one.
const CAST_START_SUBSCRIBERS = CAST_SUBSCRIBERS;
const SPELL_START_SUBSCRIBERS = 1;

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const {
  FRAMEXML_POWER_EVENTS,
  FRAMEXML_POWER_MAX_EVENTS,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

class FakeWorldEvents {
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

class FakeStore {
  listeners = new Map();

  field(_subject, name, listener) {
    this.listeners.set(name, listener);
    return () => {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    };
  }

  emit(name, object, guid) {
    this.listeners.get(name)?.(object, guid);
  }
}

function fixture() {
  const selfGuid = 0x10n;
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (1 << 8) | (1 << 24)],
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 4000],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 5000],
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 1, 250],
    [UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + 1, 1000],
  ]);
  const object = { fields };
  const events = new FakeWorldEvents();
  const store = new FakeStore();
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, object]]) },
    actionButtons: [],
    casts: new Map(),
    events,
    cooldownRemaining() { return 0; },
  };
  const fired = [];
  let now = 100;
  const pump = {
    fire(event, ...args) {
      // The combat log (3.01) hears the same world edges; nobody here listens to it.
      if (event.startsWith("COMBAT_LOG_EVENT")) return 0;
      fired.push([event, ...args]);
      return 1;
    },
    now: () => now,
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  return {
    seam, world, store, events, object, fields, fired, pump,
    advance(value) { now = value; seam.tick(value); },
  };
}

function setPower(fields, type, value, maximum) {
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (1 << 8) | (type << 24));
  fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + type, value);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + type, maximum);
}

test("LiveWorldSeam publishes initial, changed and type-switched player power exactly once", () => {
  const { seam, fields, fired, pump, advance } = fixture();
  seam.attach(pump);
  fired.length = 0;

  advance(100);
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.unitDisplayPower, "player"],
    [FRAMEXML_POWER_EVENTS[1], "player"],
    [FRAMEXML_POWER_MAX_EVENTS[1], "player"],
  ]);

  fired.length = 0;
  advance(100.03);
  assert.deepEqual(fired, [], "an unchanged sub-60ms poll stays quiet");

  fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 1, 300);
  fired.length = 0;
  advance(100.1);
  assert.deepEqual(fired, [[FRAMEXML_POWER_EVENTS[1], "player"]]);

  fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + 1, 1200);
  fired.length = 0;
  advance(100.2);
  assert.deepEqual(fired, [[FRAMEXML_POWER_MAX_EVENTS[1], "player"]]);

  setPower(fields, 0, 40, 100);
  fired.length = 0;
  advance(100.3);
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.unitDisplayPower, "player"],
    [FRAMEXML_POWER_EVENTS[0], "player"],
    [FRAMEXML_POWER_MAX_EVENTS[0], "player"],
  ], "display-power precedes current/max under the new token");

  fired.length = 0;
  advance(100.4);
  assert.deepEqual(fired, [], "an unchanged power/max/type snapshot stays quiet");
});

test("LiveWorldSeam mirrors level notifications and detaches every subscription", () => {
  const { seam, store, world, object, fired, pump } = fixture();
  seam.attach(pump);
  fired.length = 0;

  store.emit("UNIT_FIELD_LEVEL", object, 0x10n);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.unitLevel, "player"]],
    "a bare level field (login, a GM command) is UNIT_LEVEL only: ChatFrame.lua:2567 formats PLAYER_LEVEL_UP's level");

  // SMSG_LEVELUP_INFO precedes its level (Player::GiveLevel); the event waits for the level field
  // and measures the talent points InitTalentForLevel wrote beside it.
  const { fields } = object;
  fields.set(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 10);
  fields.set(UPDATE_FIELDS.PLAYER_CHARACTER_POINTS1.offset, 0);
  fired.length = 0;
  world.events.emit("LEVEL_UP", { level: 11, healthDelta: 22, powerDelta: [30, 0, 0, 0, 0, 0, 0], statDelta: [1, 1, 2, 1, 1] });
  assert.deepEqual(fired, [], "the packet precedes the level it announces");
  fields.set(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 11);
  fields.set(UPDATE_FIELDS.PLAYER_CHARACTER_POINTS1.offset, 1);
  store.emit("UNIT_FIELD_LEVEL", object, 0x10n);
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.unitLevel, "player"],
    [FRAMEXML_SEAM_EVENTS.levelUp, 11, 22, 30, 1, 1, 1, 2, 1, 1],
  ], "level, health, mana, talent points, then strength, agility, stamina, intellect, spirit");
  fired.length = 0;
  store.emit("UNIT_FIELD_LEVEL", object, 0x10n);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.unitLevel, "player"]], "announced once");
  for (const field of ["UNIT_FIELD_HEALTH", "UNIT_FIELD_MAXHEALTH", "UNIT_FIELD_LEVEL", "PLAYER_XP"]) {
    assert.ok(store.listeners.has(field), `${field} keeps a live player-field subscription`);
  }
  assert.ok(store.listeners.size >= 4, "newer player-frame fields may add subscriptions");
  assert.equal(world.events.listenerCount("SPELL_CAST_START"), CAST_START_SUBSCRIBERS);
  assert.equal(world.events.listenerCount("SPELL_START"), SPELL_START_SUBSCRIBERS); // seam-sweep

  seam.detach();
  fired.length = 0;
  store.emit("UNIT_FIELD_LEVEL", object, 0x10n);
  assert.deepEqual(fired, []);
  assert.equal(store.listeners.size, 0);
  assert.equal(world.events.listenerCount("SPELL_CAST_START"), 0);
  assert.equal(world.events.listenerCount("SPELL_START"), 0); // seam-sweep

  seam.attach(pump);
  for (const field of ["UNIT_FIELD_HEALTH", "UNIT_FIELD_MAXHEALTH", "UNIT_FIELD_LEVEL", "PLAYER_XP"]) {
    assert.ok(store.listeners.has(field), `${field} is restored on reattach`);
  }
  assert.ok(store.listeners.size >= 4, "reattach restores all current player-field subscriptions");
  assert.equal(world.events.listenerCount("SPELL_CAST_START"), CAST_START_SUBSCRIBERS,
    "reattach does not leak packet listeners");
  seam.detach();
});
