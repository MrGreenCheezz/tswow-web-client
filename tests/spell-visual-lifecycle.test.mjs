import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { SpellVisualCoordinator, usesStockRangedRelease } from "../dist/code/browser/SpellVisualLifecycle.js";
import { IMPACT_KIT_MS, PACKET_KIT_MS } from "../dist/code/browser/SpellVisuals.js";

class Events {
  #listeners = new Map();
  on(name, listener) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener);
    this.#listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name, value) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(value);
  }
}

function world() {
  return {
    events: new Events(),
    state: { selfGuid: 1n, objects: new Map([[1n, {
      position: { x: 1, y: 2, z: 3, orientation: 0 }, targetGuid: 2n,
    }], [2n, { position: { x: 11, y: 2, z: 3, orientation: Math.PI } }]]) },
    auras: new Map(), targetGuid: 2n,
  };
}

function kit({ sound = 0, startAnimation = -1, animation = -1, effects = [] } = {}) {
  return { startAnimation, animation, effects, sound };
}

function metadata(visual) {
  const values = new Map();
  return {
    values,
    get(id) { return values.get(id); },
    put(id, value = visual) { values.set(id, value); },
  };
}

function go(spellId = 7, overrides = {}) {
  return {
    casterGuid: 1n, casterUnit: 1n, castId: 0, spellId, castFlags: 0, castTime: 0,
    hits: [2n], misses: [], ...overrides,
  };
}

function rendererRef() {
  let value;
  const calls = { plans: [], states: [], cancelled: [], retimed: [], actions: [], order: [], currentAction: undefined };
  const renderer = {
    playSpellVisual(plan) {
      calls.order.push("visual");
      calls.currentAction = "visual";
      calls.plans.push(plan);
      return { id: calls.plans.length };
    },
    setStateVisuals(map) { calls.states.push(map); },
    cancelSpellVisual(handle) { calls.cancelled.push(handle); },
    retimeSpellVisual(handle, at) { calls.retimed.push({ handle, at }); },
    cancelUnitAction(guid) {
      calls.order.push("cancel");
      calls.currentAction = undefined;
      calls.cancelled.push(guid);
    },
    playUnitAction(guid, action, hold) {
      calls.order.push("fallback");
      calls.currentAction = "fallback";
      calls.actions.push({ guid, action, hold });
    },
  };
  return { calls, get: () => value, set: (next) => { value = next; }, renderer };
}

function visual() {
  return {
    id: 7,
    precast: kit({ animation: 11, sound: 31, effects: [{ path: "pre.m2", attachment: -1, scale: 1 }] }),
    channel: kit({ animation: 16, sound: 36, effects: [{ path: "channel.m2", attachment: -1, scale: 1 }] }),
    cast: kit({ animation: 12, sound: 32, effects: [{ path: "cast.m2", attachment: -1, scale: 1 }] }),
    impact: kit({ animation: 13, sound: 33, effects: [{ path: "hit.m2", attachment: -1, scale: 1 }] }),
    state: kit({ animation: 14, sound: 34, effects: [{ path: "state.m2", attachment: 7, scale: 1 }] }),
    stateDone: kit({ animation: 15, sound: 35, effects: [{ path: "done.m2", attachment: -1, scale: 1 }] }),
    missile: { path: "bolt.m2", scale: 1, attachment: -1, speed: 24 },
  };
}

test("GO is exact-once per packet identity, but equal castId=0 packets remain separate", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  const current = world();
  coordinator.bindWorld(current);
  const first = go();
  current.events.emit("SPELL_GO", first);
  current.events.emit("SPELL_GO", first);
  const second = go();
  current.events.emit("SPELL_GO", second);
  assert.equal(coordinator.pendingCounts().go, 2);
  source.put(7, visual());
  coordinator.onLoaded([7]);
  assert.equal(ref.calls.plans.length, 2);
});

test("metadata and renderer arriving after GO replay the original plan once", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now });
  const current = world();
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go());
  source.put(7, visual());
  coordinator.onLoaded([7]);
  assert.equal(ref.calls.plans.length, 0);
  ref.set(ref.renderer);
  now = 1100;
  coordinator.tick();
  coordinator.tick();
  assert.equal(ref.calls.plans.length, 1);
  assert.ok(ref.calls.plans[0].instances.some((instance) => instance.path === "bolt.m2"));
});

test("GO waits for authored metadata instead of double-playing generic release", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go());
  assert.equal(ref.calls.actions.length, 0, "metadata in flight must not guess a release pose");
  source.put(7, visual());
  coordinator.onLoaded([7]);
  assert.equal(ref.calls.actions.length, 0);
  ref.set(ref.renderer);
  coordinator.tick();
  assert.equal(ref.calls.actions.length, 0, "authored cast animation owns the release");
  assert.equal(ref.calls.plans.length, 1);
});

test("a resolved no-visual GO remains animation-silent when a renderer becomes ready", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go());
  assert.equal(ref.calls.actions.length, 0);
  coordinator.onLoaded([7]);
  assert.equal(ref.calls.actions.length, 0);
  ref.set(ref.renderer);
  coordinator.tick();
  coordinator.tick();
  assert.equal(ref.calls.actions.length, 0,
    "absence of an authored kit is data, not permission to invent a generic cast");
});

test("an explicit queued ranged release expires by TTL and is invalidated by a world epoch", () => {
  let now = 1000;
  const source = metadata();
  source.put(75, { id: 75, autoRepeat: true });
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now, ttlMs: 2000 });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go(75));
  now = 4001;
  ref.set(ref.renderer);
  coordinator.tick();
  assert.equal(ref.calls.actions.length, 0, "a renderer arriving after TTL must not revive the old release");

  const ref2 = rendererRef();
  let now2 = 1000;
  const current2 = world();
  const source2 = metadata();
  source2.put(75, { id: 75, autoRepeat: true });
  const coordinator2 = new SpellVisualCoordinator({ metadata: source2, renderer: ref2.get, now: () => now2 });
  coordinator2.bindWorld(current2);
  current2.events.emit("SPELL_GO", go(75));
  coordinator2.worldChanged(current2);
  ref2.set(ref2.renderer);
  coordinator2.tick();
  assert.equal(ref2.calls.actions.length, 0, "teleport epoch must drop queued release");
});

test("Auto Shot uses the explicit ranged release action and no generic cast pose", () => {
  const source = metadata();
  source.put(75, { id: 75, autoRepeat: true });
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer });
  coordinator.bindWorld(current);

  current.events.emit("SPELL_GO", go(75));

  assert.deepEqual(ref.calls.actions, [{ guid: 1n, action: "shoot", hold: undefined }]);
});

test("an auto-repeat row with an authored caster animation does not invent a weapon shot", () => {
  const autoVisual = { ...visual(), autoRepeat: true };
  const source = metadata(autoVisual);
  source.put(75);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer });
  coordinator.bindWorld(current);

  current.events.emit("SPELL_GO", go(75));

  assert.deepEqual(ref.calls.order, ["visual"]);
  assert.equal(ref.calls.currentAction, "visual", "the DBC kit remains the caster authority");
  assert.deepEqual(ref.calls.actions, []);
});

test("the generic ranged fallback is limited to stock Auto Shot and wand Shoot", () => {
  assert.equal(usesStockRangedRelease(75, { id: 75, autoRepeat: true }), true);
  assert.equal(usesStockRangedRelease(5019, { id: 5019, autoRepeat: true }), true);
  for (const spellId of [1485, 31317, 38196]) {
    assert.equal(usesStockRangedRelease(spellId, { id: spellId, autoRepeat: true }), false,
      `${spellId} carries the repeat bit but is not a stock ranged release`);
  }

  const source = metadata();
  source.put(1485, { id: 1485, autoRepeat: true });
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go(1485));
  assert.deepEqual(ref.calls.actions, [], "an unrelated repeat-flag row stays animation-silent");
});

test("renderer-ready transition renders a deferred cast start exactly once", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 1000, channel: false });
  assert.equal(ref.calls.plans.length, 0);
  ref.set(ref.renderer);
  coordinator.tick();
  coordinator.tick();
  assert.equal(ref.calls.plans.length, 1);
});

test("GO uses only an authored release pose; a sound-only kit stays animation-silent", () => {
  let now = 1000;
  const ref = rendererRef();
  const source = metadata(visual());
  source.put(7);
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go());
  assert.equal(ref.calls.actions.filter((action) => action.action === "cast").length, 0);

  const soundOnly = visual();
  soundOnly.cast = kit({ sound: 99 });
  const source2 = metadata(soundOnly);
  source2.put(7);
  const ref2 = rendererRef();
  const current2 = world();
  const coordinator2 = new SpellVisualCoordinator({ metadata: source2, renderer: ref2.renderer, now: () => now });
  coordinator2.bindWorld(current2);
  current2.events.emit("SPELL_GO", go());
  assert.equal(ref2.calls.actions.length, 0);
});

test("start delay retimes a loaded handle and stop cancels it", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  const current = world();
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 500, channel: false });
  assert.equal(ref.calls.plans.length, 1);
  now = 1100;
  current.events.emit("SPELL_CAST_DELAYED", { casterGuid: 1n, delay: 250 });
  assert.equal(ref.calls.retimed.length, 1);
  current.events.emit("SPELL_CAST_STOP", { casterGuid: 1n, spellId: 7, interrupted: true });
  assert.ok(ref.calls.cancelled.length > 0);
});

test("late authored precast arrives without a speculative pose preceding it", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 1000, channel: false });
  assert.equal(ref.calls.currentAction, undefined);
  source.put(7, visual());
  coordinator.onLoaded([7]);
  assert.deepEqual(ref.calls.order, ["visual"]);
  assert.equal(ref.calls.currentAction, "visual",
    "the authored visual action is the first and only pose");
});

test("sound-only precast dispatches once across cast delay refreshes", () => {
  let now = 1000;
  const source = metadata();
  const soundOnly = visual();
  soundOnly.precast = kit({ sound: 88 });
  source.put(7, soundOnly);
  const ref = rendererRef();
  const sounds = [];
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: source, renderer: ref.renderer, now: () => now,
    playSound: (id) => { sounds.push(id); },
  });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 1000, channel: false });
  assert.deepEqual(sounds, [88]);
  now = 1100;
  current.events.emit("SPELL_CAST_DELAYED", { casterGuid: 1n, delay: 250 });
  now = 1200;
  current.events.emit("SPELL_CAST_DELAYED", { casterGuid: 1n, delay: 250 });
  assert.deepEqual(sounds, [88], "delay packets retime the fallback but do not replay the sound-only kit");
});

test("sound-only and effect+sound starts wait for renderer and dispatch sound once", () => {
  let now = 1000;
  const source = metadata();
  const soundOnly = visual();
  soundOnly.precast = kit({ sound: 88 });
  source.put(7, soundOnly);
  const ref = rendererRef();
  const sounds = [];
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: source, renderer: ref.get, now: () => now,
    playSound: (id) => { sounds.push(id); },
  });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 1000, channel: false });
  now = 1100;
  current.events.emit("SPELL_CAST_DELAYED", { casterGuid: 1n, delay: 250 });
  assert.deepEqual(sounds, []);
  ref.set(ref.renderer);
  coordinator.tick();
  coordinator.tick();
  assert.deepEqual(sounds, [88]);

  now = 2000;
  const effectAndSound = visual();
  effectAndSound.precast = kit({ sound: 89, effects: [{ path: "pre-only.m2", attachment: -1, scale: 1 }] });
  source.put(8, effectAndSound);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 8, castTime: 1000, channel: false });
  assert.deepEqual(sounds, [88, 89]);
  now = 2100;
  current.events.emit("SPELL_CAST_DELAYED", { casterGuid: 1n, delay: 250 });
  assert.deepEqual(sounds, [88, 89]);
});

test("a delayed channel refresh keeps the original start time while extending metadata TTL", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 500, channel: true });
  now = 3000;
  current.events.emit("SPELL_CHANNEL_UPDATE", { casterGuid: 1n, spellId: 7, remaining: 5000 });
  now = 6000;
  source.put(7, visual());
  coordinator.onLoaded([7]);
  assert.equal(ref.calls.plans.length, 1);
  assert.ok(ref.calls.plans[0].instances.every((instance) => instance.startedAt === 1000));
});

test("SPELL_GO releases a channel but does not cancel it before zero remaining", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 2000, channel: true });
  const cancelledBeforeGo = ref.calls.cancelled.length;
  current.events.emit("SPELL_GO", go());
  assert.equal(ref.calls.cancelled.length, cancelledBeforeGo);
  current.events.emit("SPELL_CHANNEL_UPDATE", { casterGuid: 1n, spellId: 7, remaining: 0 });
  assert.ok(ref.calls.cancelled.length > cancelledBeforeGo);
});

test("a metadata-pending channel survives SPELL_GO and replays when its row arrives", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 2000, channel: true });
  current.events.emit("SPELL_GO", go());
  source.put(7, visual());
  coordinator.onLoaded([7]);
  assert.ok(ref.calls.plans.some((plan) => plan.instances.some((instance) => instance.path === "channel.m2")),
    "the channel start remains queued across SPELL_GO");
  const cancelledAfterLoad = ref.calls.cancelled.length;
  current.events.emit("SPELL_CHANNEL_UPDATE", { casterGuid: 1n, spellId: 7, remaining: 0 });
  assert.ok(ref.calls.cancelled.length > cancelledAfterLoad);
});

test("a resolved no-visual start remains pose-silent when renderer arrives late", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 1000, channel: false });
  coordinator.onLoaded([7]);
  ref.set(ref.renderer);
  coordinator.tick();
  coordinator.tick();
  assert.equal(ref.calls.actions.length, 0);
});

test("initial aura snapshot restores persistent state without replaying add sound", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const sounds = [];
  const current = world();
  current.auras.set(2n, new Map([[3, { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1 }]]));
  const coordinator = new SpellVisualCoordinator({
    metadata: source, renderer: ref.renderer, now: () => now,
    playSound: (id, point) => { sounds.push({ id, point }); },
  });
  coordinator.bindWorld(current);
  source.put(7, visual());
  coordinator.onLoaded([7]);
  assert.equal(sounds.length, 0);
  assert.ok([...ref.calls.states.at(-1).values()][0].some((effect) => effect.path === "state.m2"));
});

test("persistent aura state preserves duplicate authored model-attach occurrences", () => {
  const authored = visual();
  const shared = {
    path: "Spells\\AuraLayer.m2", attachment: 17, scale: 1,
    transform: { offset: [0, 0, 0], rotation: [0, 0, 0] },
  };
  authored.state = kit({ effects: [
    { ...shared, occurrence: "model-attach:4085" },
    { ...shared, occurrence: "model-attach:4086" },
  ] });
  const source = metadata(authored);
  source.put(7);
  const ref = rendererRef();
  const current = world();
  current.auras.set(2n, new Map([[3, {
    slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1,
  }]]));
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer });
  coordinator.bindWorld(current);

  const effects = [...ref.calls.states.at(-1).values()][0];
  assert.deepEqual(effects.map((effect) => effect.occurrence), [
    "model-attach:4085", "model-attach:4086",
  ], "the lifecycle must not discard the DBC row identity before renderer reconciliation");
  assert.equal(effects[0].path, effects[1].path, "the regression is two otherwise identical effects");
});

test("epoch invalidates queued sounds and old world replay", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const sounds = [];
  let ready = false;
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: source, renderer: ref.renderer, now: () => now,
    playSound: (id, point, guard) => {
      if (!ready) return false;
      sounds.push({ id, point, valid: guard() });
    },
  });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go());
  assert.equal(sounds.length, 0);
  const oldEpoch = coordinator.epoch;
  coordinator.worldChanged(current);
  assert.ok(coordinator.epoch > oldEpoch);
  ready = true;
  current.events.emit("SPELL_GO", go(7, { castId: 1 }));
  assert.equal(sounds.filter((sound) => sound.valid).length, 1);
  now += 4000;
  coordinator.tick();
  assert.equal(coordinator.pendingCounts().sounds, 0);
});

test("misses and a destination produce one static synthetic target, never origin", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go(7, {
    hits: [], misses: [{ guid: 99n, reason: 1 }],
    targets: { targetFlags: 0x40, destination: { x: 40, y: 41, z: 42 } },
  }));
  const bolt = ref.calls.plans[0].instances.find((instance) => instance.path === "bolt.m2");
  assert.deepEqual(bolt.flight.to, { x: 40, y: 41, z: 42 });
  assert.notDeepEqual(bolt.flight.from, { x: 0, y: 0, z: 0 });
});

test("StateDone does not invent an origin point after its unit disappears", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const previous = new Map([[3, { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1 }]]);
  current.state.objects.delete(2n);
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous, current: new Map(), added: [], removed: [...previous.values()], updated: [],
  });
  assert.equal(ref.calls.plans.length, 0);
});

test("aura remove followed by re-add drops stale pending StateDone", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const current = world();
  const aura = { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1 };
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, aura]]), current: new Map(), added: [], removed: [aura], updated: [],
  });
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  source.put(7, visual());
  coordinator.onLoaded([7]);
  assert.ok(ref.calls.plans.some((plan) => plan.animations.some((animation) => animation.animation === 14)));
  assert.equal(ref.calls.plans.some((plan) => plan.animations.some((animation) => animation.animation === 15)), false);
});

test("failed enterWorld login cleans only its own spell visual coordinator/client", async () => {
  const source = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(source, /if \(game\.spellVisualCoordinator === spellVisualCoordinator\) \{[\s\S]*?spellVisualCoordinator\.clear\(\);/);
  assert.match(source, /if \(game\.spellVisuals === spellVisuals\) \{[\s\S]*?spellVisuals\.onLoaded = undefined;[\s\S]*?game\.spellVisuals = undefined;/);
  assert.equal((source.match(/world\.events\.on\("SPELL_GO"/g) ?? []).length, 0,
    "SPELL_GO must not manufacture a creature exertion for healing or utility casts");
  assert.match(source, /for \(const voice of spellCombatVoices\(line\)\)/,
    "semantic combat-log classification owns the optional damage effort voice");
  const sounds = await readFile(new URL("../src/browser/game/GameSounds.ts", import.meta.url), "utf8");
  assert.match(sounds, /playCreatureSound\(guid: bigint, which: CreatureSound, guard\?: \(\) => boolean\)/);
  assert.match(sounds, /deferSound\(\(\) => playCreatureSound\(guid, which, guard\)\)/);
});

test("pending visual and sound queues stay within their configured caps", () => {
  let now = 1000;
  const source = metadata();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: source, renderer: ref.renderer, now: () => now,
    queueCaps: { go: 2, start: 2, aura: 2, sounds: 2 },
  });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go(7));
  current.events.emit("SPELL_GO", go(8));
  current.events.emit("SPELL_GO", go(9));
  assert.equal(coordinator.pendingCounts().go, 2);

  const soundSource = metadata(visual());
  soundSource.put(7);
  let ready = false;
  const soundCoordinator = new SpellVisualCoordinator({
    metadata: soundSource, renderer: ref.renderer, now: () => now,
    queueCaps: { sounds: 2 },
    playSound: () => { if (!ready) return false; },
  });
  const soundWorld = world();
  soundCoordinator.bindWorld(soundWorld);
  soundWorld.events.emit("SPELL_GO", go(7, { castId: 1 }));
  soundWorld.events.emit("SPELL_GO", go(7, { castId: 2 }));
  soundWorld.events.emit("SPELL_GO", go(7, { castId: 3 }));
  assert.equal(soundCoordinator.pendingCounts().sounds, 2);
  ready = true;
  now += 1000;
  soundCoordinator.tick();
  assert.equal(soundCoordinator.pendingCounts().sounds, 0);
});

test("deferred sound keeps the receipt point after the source object moves", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const sounds = [];
  let ready = false;
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: source, renderer: ref.renderer, now: () => now,
    playSound: (id, point) => {
      if (!ready) return false;
      sounds.push({ id, point });
    },
  });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_GO", go());
  current.state.objects.get(1n).position.x = 900;
  current.state.objects.get(1n).position.y = 901;
  ready = true;
  coordinator.tick();
  assert.deepEqual(sounds[0].point, { x: 1, y: 2, z: 3 });
});

test("StateKit animation ownership is cancelled on true aura removal and retimed on refresh", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const aura = { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1, expiresAt: 3000 };
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  assert.ok(ref.calls.plans[0].animations.some((animation) => animation.animation === 14));
  now = 1100;
  const refreshed = { ...aura, expiresAt: 4500 };
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, aura]]), current: new Map([[3, refreshed]]),
    added: [], removed: [], updated: [{ before: aura, after: refreshed }],
  });
  assert.deepEqual(ref.calls.retimed.at(-1), { handle: { id: 1 }, at: 4500 });
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, refreshed]]), current: new Map(),
    added: [], removed: [refreshed], updated: [],
  });
  assert.deepEqual(ref.calls.cancelled[0], { id: 1 });
});

test("StateKit deferred while renderer is absent is removed before renderer readiness", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now });
  coordinator.bindWorld(current);
  const aura = { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1 };
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, aura]]), current: new Map(), added: [], removed: [aura], updated: [],
  });
  ref.set(ref.renderer);
  coordinator.tick();
  assert.equal(ref.calls.plans.filter((plan) => plan.animations.some((animation) => animation.animation === 14)).length, 0);
});

test("deferred StateDone is canceled by re-add, while a true removal still drains once", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const sounds = [];
  let ready = false;
  const current = world();
  const aura = { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1 };
  const coordinator = new SpellVisualCoordinator({
    metadata: source, renderer: ref.get, now: () => now,
    playSound: (id) => { if (!ready) return false; sounds.push(id); },
  });
  coordinator.bindWorld(current);
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, aura]]), current: new Map(), added: [], removed: [aura], updated: [],
  });
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  ref.set(ref.renderer);
  coordinator.tick();
  assert.equal(ref.calls.plans.some((plan) => plan.animations.some((animation) => animation.animation === 15)), false);
  assert.deepEqual(sounds, []);
  ready = true;
  coordinator.tick();
  assert.deepEqual(sounds, [34], "only the live StateKit sound may survive the re-add");

  const ref2 = rendererRef();
  const sounds2 = [];
  const current2 = world();
  const coordinator2 = new SpellVisualCoordinator({
    metadata: source, renderer: ref2.get, now: () => now,
    playSound: (id) => sounds2.push(id),
  });
  coordinator2.bindWorld(current2);
  current2.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, aura]]), current: new Map(), added: [], removed: [aura], updated: [],
  });
  ref2.set(ref2.renderer);
  coordinator2.tick();
  assert.equal(ref2.calls.plans.filter((plan) => plan.animations.some((animation) => animation.animation === 15)).length, 1);
  assert.deepEqual(sounds2, [35]);
});

test("removing an aura cancels a queued StateKit sound before StateDone replaces it", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const sounds = [];
  let ready = false;
  const current = world();
  const aura = { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1 };
  const coordinator = new SpellVisualCoordinator({
    metadata: source, renderer: ref.renderer, now: () => now,
    playSound: (id) => { if (!ready) return false; sounds.push(id); },
  });
  coordinator.bindWorld(current);
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, aura]]), current: new Map(), added: [], removed: [aura], updated: [],
  });
  ready = true;
  coordinator.tick();
  assert.deepEqual(sounds, [35], "the removed aura's queued StateKit sound must not leak");
});

test("finite deferred StateKit refresh updates its absolute hold before renderer readiness", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const aura = { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1, expiresAt: 2000 };
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  now = 1100;
  const refreshed = { ...aura, expiresAt: 5000 };
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, aura]]), current: new Map([[3, refreshed]]), added: [], removed: [],
    updated: [{ before: aura, after: refreshed }],
  });
  ref.set(ref.renderer);
  coordinator.tick();
  const animation = ref.calls.plans[0].animations.find((entry) => entry.animation === 14);
  assert.equal(animation.at, 1000);
  assert.equal(animation.hold, 4000);
});

test("finite deferred StateKit refresh retimes a held startAnimation primary", () => {
  let now = 1000;
  const authored = visual();
  authored.state = kit({ startAnimation: 40, animation: 41, effects: [{ path: "state.m2", attachment: 7, scale: 1 }] });
  const source = metadata(authored);
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const aura = { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1, expiresAt: 2000 };
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  now = 1100;
  const refreshed = { ...aura, expiresAt: 5000 };
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, aura]]), current: new Map([[3, refreshed]]), added: [], removed: [],
    updated: [{ before: aura, after: refreshed }],
  });
  ref.set(ref.renderer);
  coordinator.tick();
  const animation = ref.calls.plans[0].animations[0];
  assert.equal(animation.mode, "once");
  assert.equal(animation.followUp.mode, "hold");
  assert.equal(animation.followUp.hold, 4000);
});

test("a drained StateKit handle is owned once and cancelled on later removal", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.get, now: () => now });
  coordinator.bindWorld(current);
  const aura = { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1 };
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  ref.set(ref.renderer);
  coordinator.tick();
  coordinator.tick();
  assert.equal(ref.calls.plans.length, 1);
  const handle = { id: 1 };
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map([[3, aura]]), current: new Map(), added: [], removed: [aura], updated: [],
  });
  assert.deepEqual(ref.calls.cancelled[0], handle);
  coordinator.tick();
  assert.equal(ref.calls.plans.filter((plan) => plan.animations.some((animation) => animation.animation === 14)).length, 1);
});

test("world epoch and clear retire StateKit ownership", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer: ref.renderer, now: () => now });
  coordinator.bindWorld(current);
  const aura = { slot: 3, spellId: 7, flags: 0, casterLevel: 1, applications: 1 };
  current.events.emit("AURA_CHANGED", {
    guid: 2n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  const oldEpoch = coordinator.epoch;
  coordinator.worldChanged(current);
  assert.ok(coordinator.epoch > oldEpoch);
  assert.deepEqual(ref.calls.cancelled[0], { id: 1 });
  coordinator.clear();
  assert.equal(coordinator.pendingCounts().aura, 0);
});

test("a channel GO keeps the held channel action while still dispatching impact effects", () => {
  let now = 1000;
  const source = metadata(visual());
  source.put(7);
  const plans = [];
  let action;
  const renderer = {
    playSpellVisual(plan) {
      plans.push(plan);
      for (const animation of plan.animations) {
        if (animation.at <= now) action = animation.animation;
      }
      return { id: plans.length };
    },
    setStateVisuals() {},
    cancelSpellVisual() {},
    playUnitAction(_guid, next) { action = next; },
  };
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: source, renderer, now: () => now });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 2000, channel: true });
  assert.equal(action, 16);
  current.events.emit("SPELL_GO", go());
  assert.equal(action, 16);
  assert.ok(plans[1].instances.some((instance) => instance.path === "cast.m2"));
  assert.ok(!plans[1].animations.some((animation) => animation.guid === 1n && animation.animation === 12));
});

test("channel GO suppresses every caster animation but keeps target animations, effects and sounds", () => {
  let now = 1000;
  const source = metadata();
  const channelVisual = visual();
  channelVisual.cast = kit({ animation: 12, sound: 32, effects: [{ path: "go-cast.m2", attachment: -1, scale: 1 }] });
  channelVisual.casterImpact = kit({ animation: 17, sound: 37, effects: [{ path: "caster-impact.m2", attachment: -1, scale: 1 }] });
  channelVisual.instantArea = kit({ animation: 18, sound: 38, effects: [{ path: "instant-area.m2", attachment: 7, scale: 1 }] });
  channelVisual.impactArea = kit({ animation: 19, sound: 39, effects: [{ path: "impact-area.m2", attachment: 7, scale: 1 }] });
  channelVisual.persistentArea = kit({ animation: 20, sound: 40, effects: [{ path: "persistent-area.m2", attachment: 7, scale: 1 }] });
  channelVisual.impact = kit({ animation: 21, sound: 41, effects: [{ path: "target-impact.m2", attachment: 7, scale: 1 }] });
  source.put(7, channelVisual);
  const ref = rendererRef();
  const sounds = [];
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: source, renderer: ref.renderer, now: () => now,
    playSound: (id) => { sounds.push(id); },
  });
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 2000, channel: true });
  current.events.emit("SPELL_GO", go(7, { hits: [1n, 2n] }));
  const release = ref.calls.plans.at(-1);
  assert.ok(release.instances.some((instance) => instance.path === "caster-impact.m2"));
  assert.ok(release.instances.some((instance) => instance.path === "impact-area.m2"));
  assert.ok(release.animations.some((animation) => animation.guid === 2n && animation.animation === 21));
  assert.equal(release.animations.some((animation) => animation.guid === 1n), false,
    "no GO animation may steal the held channel caster slot");
  assert.ok(sounds.includes(37));
  assert.equal(ref.calls.currentAction, "visual", "the channel action remains installed");
});

/* --- S3: kits the server names by number ------------------------------------------------------ */

function kitSource() {
  const values = new Map();
  return {
    values,
    get(id) { return values.get(id); },
    /** `undefined` records the gateway answer "this kit resolves to nothing". */
    put(id, record) { values.set(id, record === undefined ? { id } : { id, kit: record }); },
  };
}

const FOOD = kit({
  animation: 61, sound: 45,
  effects: [{ path: "Spells\Food_HealEffect_Base.m2", attachment: 19, scale: 1 }],
});

test("S3: a kit named by number draws on the unit it names", () => {
  let now = 1000;
  const kits = kitSource();
  kits.put(406, FOOD);
  const ref = rendererRef();
  const sounds = [];
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: metadata(), kitMetadata: kits, renderer: ref.renderer, now: () => now,
    playSound: (id) => { sounds.push(id); },
  });
  coordinator.bindWorld(current);
  coordinator.playVisualKit(2n, 406, false);
  assert.equal(ref.calls.plans.length, 1, "the kit is drawn, not only heard");
  const plan = ref.calls.plans[0];
  assert.deepEqual(plan.instances.map((instance) => instance.path),
    ["Spells\Food_HealEffect_Base.m2"]);
  assert.equal(plan.instances[0].anchor, 2n, "and hangs on the unit the packet named");
  assert.equal(plan.instances[0].attachment, 19);
  assert.equal(plan.instances[0].endsAt - plan.instances[0].startedAt, PACKET_KIT_MS);
  assert.deepEqual(plan.animations.map((animation) => animation.animation), [61],
    "the kit's authored AnimID reaches the unit action path");
  assert.equal(plan.animations[0].guid, 2n);
  assert.deepEqual(sounds, [45], "and the kit's own SoundID still plays");
});

test("S3: an impact kit takes the shorter window", () => {
  let now = 1000;
  const kits = kitSource();
  kits.put(406, FOOD);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: metadata(), kitMetadata: kits, renderer: ref.renderer, now: () => now,
  });
  coordinator.bindWorld(current);
  coordinator.playVisualKit(2n, 406, true);
  const instance = ref.calls.plans[0].instances[0];
  assert.equal(instance.endsAt - instance.startedAt, IMPACT_KIT_MS);
  assert.ok(IMPACT_KIT_MS < PACKET_KIT_MS, "a hit is shorter than a flourish");
});

test("S3: a kit whose metadata is still on the wire is replayed when it lands", () => {
  let now = 1000;
  const kits = kitSource();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: metadata(), kitMetadata: kits, renderer: ref.renderer, now: () => now,
  });
  coordinator.bindWorld(current);
  coordinator.playVisualKit(2n, 7668, false);
  assert.equal(ref.calls.plans.length, 0);
  assert.equal(coordinator.pendingCounts().kit, 1);
  kits.put(7668, kit({ animation: 172, sound: 11658, effects: [{ path: "shadow_nova_area.m2", attachment: 1, scale: 0.1 }] }));
  now += 50;
  coordinator.onKitsLoaded([7668]);
  assert.equal(coordinator.pendingCounts().kit, 0);
  assert.equal(ref.calls.plans.length, 1);
  assert.equal(ref.calls.plans[0].instances[0].path, "shadow_nova_area.m2");
});

test("S3: a queued kit older than the TTL is dropped rather than drawn late", () => {
  let now = 1000;
  const kits = kitSource();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: metadata(), kitMetadata: kits, renderer: ref.renderer, now: () => now, ttlMs: 2000,
  });
  coordinator.bindWorld(current);
  coordinator.playVisualKit(2n, 7668, false);
  now += 2001;
  coordinator.tick(now);
  assert.equal(coordinator.pendingCounts().kit, 0, "frame expiry sweeps the kit queue too");
  kits.put(7668, FOOD);
  coordinator.onKitsLoaded([7668]);
  assert.equal(ref.calls.plans.length, 0);
});

test("S3: a kit the route answered for with nothing stops being asked about", () => {
  let now = 1000;
  const kits = kitSource();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: metadata(), kitMetadata: kits, renderer: ref.renderer, now: () => now,
  });
  coordinator.bindWorld(current);
  coordinator.playVisualKit(2n, 21, false);
  assert.equal(coordinator.pendingCounts().kit, 1);
  kits.put(21, undefined);
  coordinator.onKitsLoaded([21]);
  assert.equal(coordinator.pendingCounts().kit, 0);
  assert.equal(ref.calls.plans.length, 0);
  coordinator.playVisualKit(2n, 21, false);
  assert.equal(coordinator.pendingCounts().kit, 0, "a resolved empty answer is not re-queued");
});

test("S3: a kit for a unit this client has not got draws nothing at the world origin", () => {
  let now = 1000;
  const kits = kitSource();
  kits.put(406, FOOD);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: metadata(), kitMetadata: kits, renderer: ref.renderer, now: () => now,
  });
  coordinator.bindWorld(current);
  coordinator.playVisualKit(0x999n, 406, false);
  assert.equal(ref.calls.plans.length, 0);
  coordinator.playVisualKit(0n, 406, false);
  assert.equal(ref.calls.plans.length, 0);
});

test("S3: without a kit route the packet behaves exactly as it did before the slice", () => {
  let now = 1000;
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: metadata(), renderer: ref.renderer, now: () => now,
  });
  coordinator.bindWorld(current);
  coordinator.playVisualKit(2n, 406, false);
  assert.equal(ref.calls.plans.length, 0);
  assert.equal(coordinator.pendingCounts().kit, 0);
});

test("S3: a kit that arrives before the renderer is deferred, not lost", () => {
  let now = 1000;
  const kits = kitSource();
  kits.put(406, FOOD);
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: metadata(), kitMetadata: kits, renderer: () => ref.get(), now: () => now,
  });
  coordinator.bindWorld(current);
  coordinator.playVisualKit(2n, 406, false);
  assert.equal(ref.calls.plans.length, 0, "there is no renderer yet");
  ref.set(ref.renderer);
  now += 10;
  coordinator.tick(now);
  assert.equal(ref.calls.plans.length, 1, "the frame that gets one draws it");
  assert.equal(ref.calls.plans[0].instances[0].anchor, 2n);
});

test("S3: a world change invalidates a kit that was still waiting for its metadata", () => {
  let now = 1000;
  const kits = kitSource();
  const ref = rendererRef();
  const current = world();
  const coordinator = new SpellVisualCoordinator({
    metadata: metadata(), kitMetadata: kits, renderer: ref.renderer, now: () => now,
  });
  coordinator.bindWorld(current);
  coordinator.playVisualKit(2n, 406, false);
  assert.equal(coordinator.pendingCounts().kit, 1);
  coordinator.worldChanged(current);
  assert.equal(coordinator.pendingCounts().kit, 0);
  kits.put(406, FOOD);
  coordinator.onKitsLoaded([406]);
  assert.equal(ref.calls.plans.length, 0, "a teleport is not a reason to draw the old map's kit");
});
