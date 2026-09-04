import assert from "node:assert/strict";
import test from "node:test";

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
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.levelUp],
    [FRAMEXML_SEAM_EVENTS.unitLevel, "player"],
  ]);
  for (const field of ["UNIT_FIELD_HEALTH", "UNIT_FIELD_MAXHEALTH", "UNIT_FIELD_LEVEL", "PLAYER_XP"]) {
    assert.ok(store.listeners.has(field), `${field} keeps a live player-field subscription`);
  }
  assert.ok(store.listeners.size >= 4, "newer player-frame fields may add subscriptions");
  assert.equal(world.events.listenerCount("SPELL_CAST_START"), 1);

  seam.detach();
  fired.length = 0;
  store.emit("UNIT_FIELD_LEVEL", object, 0x10n);
  assert.deepEqual(fired, []);
  assert.equal(store.listeners.size, 0);
  assert.equal(world.events.listenerCount("SPELL_CAST_START"), 0);

  seam.attach(pump);
  for (const field of ["UNIT_FIELD_HEALTH", "UNIT_FIELD_MAXHEALTH", "UNIT_FIELD_LEVEL", "PLAYER_XP"]) {
    assert.ok(store.listeners.has(field), `${field} is restored on reattach`);
  }
  assert.ok(store.listeners.size >= 4, "reattach restores all current player-field subscriptions");
  assert.equal(world.events.listenerCount("SPELL_CAST_START"), 1,
    "reattach does not leak packet listeners");
  seam.detach();
});
