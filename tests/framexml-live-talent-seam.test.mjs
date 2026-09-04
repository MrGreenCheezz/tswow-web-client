import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }

  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

test("LiveWorldSeam emits one player talent update per player packet and ignores pet packets", () => {
  const events = new FakeEvents();
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    events,
    casts: new Map(),
    actionButtons: [],
    cooldownRemaining: () => 0,
  };
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 };
  seam.attach(pump);
  fired.length = 0;

  events.emit("TALENTS_CHANGED", { pet: true });
  assert.deepEqual(fired, [], "pet talent packets do not fabricate a player event");
  events.emit("TALENTS_CHANGED", { pet: false });
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.talentsChanged],
    [FRAMEXML_SEAM_EVENTS.talentsChanged],
  ], "each authoritative player packet produces exactly one transition");

  seam.detach();
  events.emit("TALENTS_CHANGED", { pet: false });
  assert.equal(fired.length, 2, "detached worlds no longer publish stale talent transitions");
});
