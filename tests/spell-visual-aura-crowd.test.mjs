import assert from "node:assert/strict";
import test from "node:test";
import { SpellVisualCoordinator } from "../dist/code/browser/SpellVisualLifecycle.js";
import { planSpellAuraDone, planSpellAuraState } from "../dist/code/browser/SpellVisuals.js";

// Aura packets in a crowd. The coordinator reconciles only the unit a packet names and hands the
// renderer one coalesced picture per frame; the reference below is the plain whole-world
// algorithm it replaced, restated without queues, caps or indexes. Both are driven by the same
// randomized packets and must leave the renderer, the one-shot plans and the sounds identical.

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

function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const kit = (animation, sound, effects, startAnimation = -1) => ({ startAnimation, animation, sound, effects });

/** Every shape a spell's aura phases take: state and done, either alone, none, a start pose, twins. */
function visualFor(id, kind) {
  const fx = (name, extra = {}) => ({ path: `${name}-${id}.m2`, attachment: 7, scale: 1, ...extra });
  switch (kind) {
    case "full": return { id, state: kit(14, 34, [fx("state")]), stateDone: kit(15, 35, [fx("done")]) };
    case "start": return { id, state: kit(41, 44, [fx("state")], 40), stateDone: kit(15, 0, [fx("done")]) };
    case "twin": return { id, state: kit(14, 0, [
      fx("layer", { occurrence: "model-attach:1" }), fx("layer", { occurrence: "model-attach:2" }),
    ]) };
    case "stateOnly": return { id, state: kit(-1, 36, [fx("glow", { transform: { offset: [0, 0, 1], rotation: [0, 0, 0] } })]) };
    case "doneOnly": return { id, stateDone: kit(15, 37, [fx("pop")]) };
    case "castOnly": return { id, cast: kit(12, 38, [fx("cast")]) };
    case "none": return null;
    default: throw new Error(kind);
  }
}
const KINDS = ["full", "start", "twin", "stateOnly", "doneOnly", "castOnly", "none", "full", "stateOnly", "none", "full"];
const SPELLS = KINDS.map((_, index) => 100 + index);

/** The renderer surface both sides report to, flattened into one comparable log. */
function recorder() {
  const log = [];
  let handles = 0;
  const renderer = {
    playSpellVisual(plan) { log.push(["play", structuredClone(plan)]); return { id: ++handles }; },
    setStateVisuals(byUnit) {
      log.push(["state", [...byUnit].map(([guid, effects]) => [guid, structuredClone(effects)])]);
    },
    cancelSpellVisual(handle) { log.push(["cancel", handle.id]); },
    retimeSpellVisual(handle, at) { log.push(["retime", handle.id, at]); },
    clearSpellVisuals() { log.push(["clear"]); },
  };
  return { log, renderer };
}

/**
 * The whole-world algorithm, restated: every packet walks every aura of every unit and hands the
 * renderer the complete picture. No caps, no TTL (the sequences below stay inside both), no
 * indexes — just the rules for when a StateKit or StateDone is played, deferred or dropped.
 */
class ReferenceAuraVisuals {
  constructor({ metadata, world, renderer, now }) {
    Object.assign(this, { metadata, world, rendererOf: renderer, now });
    this.snapshot = new Map();
    this.shown = new Set();
    this.owned = new Map();
    this.pending = [];
    this.deferred = [];
    this.knownNoVisual = new Set();
    this.lastRenderer = undefined;
    this.sounds = [];
    world.events.on("AURA_CHANGED", (event) => this.onAuraChanged(event));
    this.restart();
  }

  restart() {
    const renderer = this.rendererOf();
    for (const handle of this.owned.values()) renderer?.cancelSpellVisual(handle);
    Object.assign(this, { shown: new Set(), owned: new Map(), pending: [], deferred: [] });
    renderer?.clearSpellVisuals();
    renderer?.setStateVisuals(new Map());
    this.lastRenderer = renderer;
    this.snapshot = new Map();
    for (const [guid, auras] of this.world.auras) if (auras.size > 0) this.snapshot.set(guid, new Map(auras));
    this.reconcile(false);
  }

  visual(spellId) {
    return this.knownNoVisual.has(spellId) ? undefined : this.metadata.get(spellId);
  }

  point(guid) {
    const position = this.world.state.objects.get(guid)?.position;
    return position ? { x: position.x, y: position.y, z: position.z } : undefined;
  }

  present(state) {
    return this.snapshot.get(state.guid)?.get(state.slot)?.spellId === state.spellId;
  }

  dispatch(plan, receivedAt, now, state, deferIfMissing = true) {
    const animations = plan.animations.filter((animation) => animation.hold <= 0 || animation.at + animation.hold > now);
    const renderer = this.rendererOf();
    if (!renderer) {
      if (deferIfMissing && (animations.length > 0 || plan.sounds.length > 0)) {
        this.deferred.push({ plan, receivedAt, state });
      }
      return undefined;
    }
    for (const sound of plan.sounds) this.sounds.push([sound.sound, sound.point]);
    if (animations.length === 0) return undefined;
    return renderer.playSpellVisual({ instances: [], animations, sounds: [] });
  }

  stateOnly(plan) {
    return { instances: [], animations: plan.animations, sounds: plan.sounds };
  }

  add(guid, aura, now, playAnimation) {
    const key = `${guid}:${aura.slot}:${aura.spellId}`;
    this.deferred = this.deferred.filter((entry) => entry.state.key !== key || entry.state.expectedPresent);
    this.pending = this.pending.filter((entry) => !(entry.done && entry.key === key));
    if (this.shown.has(key) || this.pending.some((entry) => !entry.done && entry.key === key)) return;
    const captured = this.point(guid);
    const replay = (replayNow) => {
      const current = this.snapshot.get(guid)?.get(aura.slot);
      if (current?.spellId !== aura.spellId) return;
      const visual = this.visual(aura.spellId);
      if (!visual?.state) return;
      const point = captured ?? this.point(guid);
      if (!point) {
        this.shown.add(key);
        return;
      }
      const plan = planSpellAuraState(visual, { guid, point }, now, current.expiresAt ?? Number.POSITIVE_INFINITY);
      if (playAnimation) {
        const handle = this.dispatch(this.stateOnly(plan), now, replayNow,
          { key, guid, slot: aura.slot, spellId: aura.spellId, expectedPresent: true });
        if (handle !== undefined) this.owned.set(key, handle);
      }
      this.shown.add(key);
    };
    if (!this.visual(aura.spellId)) {
      if (!this.knownNoVisual.has(aura.spellId)) this.pending.push({ spellId: aura.spellId, key, done: false, replay });
      return;
    }
    replay(now);
  }

  remove(guid, aura, now) {
    const key = `${guid}:${aura.slot}:${aura.spellId}`;
    if (this.owned.has(key)) this.rendererOf()?.cancelSpellVisual(this.owned.get(key));
    this.owned.delete(key);
    this.deferred = this.deferred.filter((entry) => entry.state.key !== key);
    this.shown.delete(key);
    this.pending = this.pending.filter((entry) => entry.done || entry.key !== key);
    const captured = this.point(guid);
    const replay = (replayNow) => {
      if (this.snapshot.get(guid)?.get(aura.slot)?.spellId === aura.spellId) return;
      const visual = this.visual(aura.spellId);
      if (!visual?.stateDone || !captured) return;
      this.dispatch(this.stateOnly(planSpellAuraDone(visual, { guid, point: captured }, now)), now, replayNow,
        { key, guid, slot: aura.slot, spellId: aura.spellId, expectedPresent: false });
    };
    if (!this.visual(aura.spellId)) {
      if (!this.knownNoVisual.has(aura.spellId)) this.pending.push({ spellId: aura.spellId, key, done: true, replay });
      return;
    }
    replay(now);
  }

  reconcile(replayAdd = true) {
    const byUnit = new Map();
    for (const [guid, auras] of this.snapshot) {
      for (const aura of auras.values()) {
        this.add(guid, aura, this.now(), replayAdd);
        const visual = this.visual(aura.spellId);
        if (!visual?.state) continue;
        const effects = byUnit.get(guid) ?? [];
        for (const effect of visual.state.effects) {
          effects.push({
            spellId: aura.spellId, path: effect.path, attachment: effect.attachment, scale: effect.scale,
            ...(effect.occurrence ? { occurrence: effect.occurrence } : {}),
            ...(effect.transform ? { transform: effect.transform } : {}),
          });
        }
        if (effects.length > 0) byUnit.set(guid, effects);
      }
    }
    this.rendererOf()?.setStateVisuals(byUnit);
  }

  onAuraChanged(event) {
    const now = this.now();
    if (event.current.size > 0) this.snapshot.set(event.guid, new Map(event.current));
    else this.snapshot.delete(event.guid);
    for (const aura of event.removed) this.remove(event.guid, aura, now);
    for (const aura of event.added) this.add(event.guid, aura, now, true);
    for (const { before, after } of event.updated) {
      if (before.spellId !== after.spellId) continue;
      const key = `${event.guid}:${after.slot}:${after.spellId}`;
      const endsAt = after.expiresAt ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(endsAt)) continue;
      if (this.owned.has(key)) this.rendererOf()?.retimeSpellVisual(this.owned.get(key), endsAt);
      for (const entry of this.deferred) {
        if (entry.state.key !== key || !entry.state.expectedPresent) continue;
        for (const animation of entry.plan.animations) {
          const hold = Math.max(0, endsAt - animation.at);
          if (animation.mode === "hold") animation.hold = hold;
          if (animation.followUp?.mode === "hold") animation.followUp.hold = hold;
        }
        entry.receivedAt = now;
      }
    }
    this.reconcile();
  }

  onLoaded(ids) {
    const now = this.now();
    let replayed = false;
    for (const id of ids) {
      if (!this.metadata.get(id)) this.knownNoVisual.add(id);
      for (let index = this.pending.length - 1; index >= 0; index--) {
        const entry = this.pending[index];
        if (entry.spellId !== id) continue;
        this.pending.splice(index, 1);
        entry.replay(now);
        replayed = true;
      }
    }
    if (replayed) this.reconcile();
  }

  tick(now) {
    const renderer = this.rendererOf();
    if (renderer === this.lastRenderer) return;
    this.lastRenderer = renderer;
    if (!renderer) return;
    for (const entry of this.deferred.splice(0)) {
      const { state } = entry;
      if (this.present(state) !== state.expectedPresent) continue;
      if (state.expectedPresent && !this.shown.has(state.key)) continue;
      const handle = this.dispatch(entry.plan, entry.receivedAt, now, state, false);
      if (state.expectedPresent && handle !== undefined && this.shown.has(state.key)) this.owned.set(state.key, handle);
    }
    this.reconcile(false);
  }
}

function auraDiff(previous, current) {
  const added = [];
  const removed = [];
  const updated = [];
  for (const [slot, before] of previous) {
    const after = current.get(slot);
    if (!after) removed.push(before);
    else if (after.spellId !== before.spellId) {
      removed.push(before);
      added.push(after);
    } else if (after !== before) updated.push({ before, after });
  }
  for (const [slot, after] of current) if (!previous.has(slot)) added.push(after);
  return { added, removed, updated };
}

function lastState(log) {
  for (let index = log.length - 1; index >= 0; index--) if (log[index][0] === "state") return log[index][1];
  return undefined;
}

function runParitySeed(seed, steps) {
  const random = rng(seed);
  const pick = (values) => values[Math.floor(random() * values.length)];
  let now = 1_000;
  const known = new Map();
  const metadata = { get: (id) => known.get(id) ?? undefined };
  const objects = new Map();
  for (let guid = 1n; guid <= 9n; guid++) {
    objects.set(guid, { position: { x: Number(guid), y: 2, z: 3, orientation: 0 }, targetGuid: undefined });
  }
  const auras = new Map();
  for (const spell of SPELLS) if (random() < 0.25) known.set(spell, visualFor(spell, KINDS[spell - 100]));
  for (let guid = 2n; guid <= 9n; guid++) {
    if (random() >= 0.3) continue;
    const initial = new Map();
    for (let slot = 0; slot < 3; slot++) {
      if (random() < 0.5) initial.set(slot, { slot, spellId: pick(SPELLS), flags: 0, casterLevel: 1, applications: 1 });
    }
    if (initial.size > 0) auras.set(guid, initial);
  }
  let rendererPresent = random() < 0.6;
  let flipped = false;
  const expected = recorder();
  const actual = recorder();
  const actualSounds = [];
  const referenceWorld = { events: new Events(), state: { selfGuid: 1n, objects }, auras, targetGuid: undefined };
  const world = { events: new Events(), state: { selfGuid: 1n, objects }, auras, targetGuid: undefined };
  const reference = new ReferenceAuraVisuals({
    metadata, world: referenceWorld, renderer: () => (rendererPresent ? expected.renderer : undefined), now: () => now,
  });
  const coordinator = new SpellVisualCoordinator({
    metadata, renderer: () => (rendererPresent ? actual.renderer : undefined), now: () => now,
    playSound: (id, point) => { actualSounds.push([id, point]); },
  });
  coordinator.bindWorld(world);
  const loaded = new Set(known.keys());
  const pushes = { expected: 0, actual: 0 };

  const frame = (label) => {
    now += Math.floor(random() * 16);
    reference.tick(now);
    coordinator.tick(now);
    flipped = false;
    const strip = (log) => log.filter((entry) => entry[0] !== "state");
    assert.deepEqual(strip(actual.log), strip(expected.log), `${label}: one-shot plans, cancels and retimes`);
    assert.deepEqual(actualSounds, reference.sounds, `${label}: sounds`);
    // What is still waiting for a row: a removal forgets its StateKit, a re-add its StateDone.
    assert.equal(coordinator.pendingCounts().aura, reference.pending.length, `${label}: auras waiting for metadata`);
    const pushedExpected = expected.log.length > pushes.expected
      && expected.log.slice(pushes.expected).some((entry) => entry[0] === "state");
    const pushedActual = actual.log.length > pushes.actual
      && actual.log.slice(pushes.actual).some((entry) => entry[0] === "state");
    pushes.expected = expected.log.length;
    pushes.actual = actual.log.length;
    // A renderer the game has let go of draws nothing, so what it was last told is unobservable.
    if (!rendererPresent) return;
    assert.deepEqual(lastState(actual.log), lastState(expected.log), `${label}: persistent state per unit`);
    assert.equal(pushedActual, pushedExpected, `${label}: a frame with aura news hands the picture over`);
  };

  for (let step = 0; step < steps; step++) {
    const label = `seed ${seed} step ${step}`;
    const roll = random();
    const guid = BigInt(2 + Math.floor(random() * 8));
    const previous = new Map(auras.get(guid) ?? []);
    let next = new Map(previous);
    if (roll < 0.22) {
      const slot = Math.floor(random() * 6);
      if (!next.has(slot)) {
        next.set(slot, {
          slot, spellId: pick(SPELLS), flags: 0, casterLevel: 1, applications: 1,
          ...(random() < 0.3 ? { expiresAt: now + 500 + Math.floor(random() * 5_000) } : {}),
        });
      }
    } else if (roll < 0.32) {
      const slots = [...next.keys()];
      if (slots.length > 0) next.delete(pick(slots));
    } else if (roll < 0.37) {
      const slots = [...next.keys()];
      if (slots.length > 0) {
        const slot = pick(slots);
        next.set(slot, { slot, spellId: pick(SPELLS), flags: 0, casterLevel: 1, applications: 1 });
      }
    } else if (roll < 0.44) {
      const slots = [...next.keys()];
      if (slots.length > 0) {
        const slot = pick(slots);
        const before = next.get(slot);
        next.set(slot, {
          ...before, applications: before.applications + 1,
          ...(random() < 0.7 ? { expiresAt: now + 200 + Math.floor(random() * 6_000) } : {}),
        });
      }
    } else if (roll < 0.48) {
      next = new Map();
    } else if (roll < 0.52) {
      next = new Map();
      for (let slot = 0; slot < 5; slot++) {
        if (random() >= 0.5) continue;
        next.set(slot, previous.get(slot) && random() < 0.5
          ? previous.get(slot)
          : { slot, spellId: pick(SPELLS), flags: 0, casterLevel: 1, applications: 1 });
      }
    } else if (roll < 0.66) {
      const unknown = SPELLS.filter((spell) => !loaded.has(spell));
      if (unknown.length > 0) {
        const ids = unknown.filter(() => random() < 0.4);
        if (ids.length === 0) ids.push(pick(unknown));
        for (const id of ids) {
          known.set(id, visualFor(id, KINDS[id - 100]));
          loaded.add(id);
        }
        reference.onLoaded(ids);
        coordinator.onLoaded(ids);
      }
      continue;
    } else if (roll < 0.88) {
      frame(label);
      continue;
    } else if (roll < 0.93) {
      if (objects.has(guid)) objects.delete(guid);
      else objects.set(guid, { position: { x: Number(guid) + random(), y: 5, z: 3, orientation: 0 }, targetGuid: undefined });
      continue;
    } else if (roll < 0.97) {
      // game.renderer is never swapped out and back inside one frame; the tick notices a new one.
      if (!flipped) {
        rendererPresent = !rendererPresent;
        flipped = true;
      }
      continue;
    } else {
      reference.restart();
      coordinator.worldChanged(world);
      continue;
    }
    if (next.size > 0) auras.set(guid, next);
    else auras.delete(guid);
    const event = { guid, previous, current: new Map(next), ...auraDiff(previous, next) };
    referenceWorld.events.emit("AURA_CHANGED", event);
    world.events.emit("AURA_CHANGED", event);
  }
  if (!rendererPresent) {
    frame(`seed ${seed} before the renderer returns`);
    rendererPresent = true;
  }
  frame(`seed ${seed} final`);
}

test("per-unit reconciliation leaves the renderer exactly where the whole-world pass left it", () => {
  for (let seed = 1; seed <= 160; seed++) runParitySeed(seed, 140);
});

/* --- the crowd itself ------------------------------------------------------------------------ */

const crowdGuid = (index) => BigInt(1_000 + index);

function crowd(units, perUnit, distinct) {
  const events = new Events();
  const objects = new Map();
  for (let index = 0; index <= units; index++) {
    objects.set(crowdGuid(index), { position: { x: index, y: index, z: 0 }, targetGuid: undefined });
  }
  const world = { events, state: { selfGuid: crowdGuid(0), objects }, auras: new Map(), targetGuid: undefined };
  const unitAuras = (index) => {
    const map = new Map();
    for (let slot = 0; slot < perUnit; slot++) {
      map.set(slot, { slot, spellId: 1_000 + ((index * 7 + slot * 13) % distinct), flags: 0x18, casterLevel: 80, applications: 1 });
    }
    return map;
  };
  const arrive = (index) => {
    const guid = crowdGuid(index + 1);
    const previous = new Map(world.auras.get(guid) ?? []);
    const current = unitAuras(index);
    world.auras.set(guid, current);
    events.emit("AURA_CHANGED", { guid, previous, current: new Map(current), added: [...current.values()], removed: [], updated: [] });
  };
  const leave = (index) => {
    const guid = crowdGuid(index + 1);
    const previous = new Map(world.auras.get(guid) ?? []);
    world.auras.delete(guid);
    events.emit("AURA_CHANGED", { guid, previous, current: new Map(), added: [], removed: [...previous.values()], updated: [] });
  };
  return { world, arrive, leave };
}

/** Every third spell draws a state; the rest show nothing persistent, as most buffs do. */
function crowdVisual(id) {
  return (id % 3 === 0)
    ? { id, state: kit(14, 0, [{ path: `state-${id}.m2`, attachment: 7, scale: 1 }]), stateDone: kit(15, 0, [{ path: `done-${id}.m2`, attachment: 7, scale: 1 }]) }
    : { id, cast: kit(12, 0, [{ path: `cast-${id}.m2`, attachment: 7, scale: 1 }]) };
}

test("a crowd arriving while its rows are in flight costs each packet only its own auras", () => {
  const UNITS = 200;
  const PER = 10;
  const DISTINCT = 80;
  const { world, arrive, leave } = crowd(UNITS, PER, DISTINCT);
  const answers = new Map();
  let asked = 0;
  const metadata = { get(id) { asked++; return answers.get(id); } };
  const plans = [];
  const states = [];
  const renderer = {
    playSpellVisual(plan) { plans.push(plan); return { id: plans.length }; },
    setStateVisuals(byUnit) { states.push(byUnit); },
  };
  let now = 1_000;
  const coordinator = new SpellVisualCoordinator({ metadata, renderer, now: () => now });
  coordinator.bindWorld(world);
  states.length = 0;

  let worstAsked = 0;
  const started = performance.now();
  for (let index = 0; index < UNITS; index++) {
    const before = asked;
    arrive(index);
    worstAsked = Math.max(worstAsked, asked - before);
  }
  const burstMs = performance.now() - started;
  // The whole-world pass asked about every aura of every unit on every packet: 2,000 per packet by
  // the end of this burst, and three seconds in all. A packet now asks about its own ten.
  assert.ok(worstAsked <= 3 * PER, `one packet asked the metadata source ${worstAsked} times`);
  assert.ok(burstMs < 750, `200 units x 10 cold auras took ${burstMs.toFixed(1)} ms`);
  assert.equal(states.length, 0, "no packet hands the renderer the picture; the frame does");
  assert.ok(coordinator.pendingCounts().aura <= 256, "the metadata wait keeps its memory bound");

  now += 16;
  coordinator.tick(now);
  assert.equal(states.length, 1, "one frame, one hand-over");

  // The rows land in one batch. Every aura with a StateKit plays it exactly once — including the
  // ones whose entry the queue cap pushed out — and every unit wearing a state shows it.
  for (let id = 1_000; id < 1_000 + DISTINCT; id++) answers.set(id, crowdVisual(id));
  now += 30;
  coordinator.onLoaded(Array.from({ length: DISTINCT }, (_, offset) => 1_000 + offset));
  // The ones the cap let go of are found through the units wearing them, in arrival order — the
  // order the whole-world pass would have met them in.
  const recovered = plans.flatMap((plan) => plan.animations)
    .filter((animation) => animation.animation === 14 && animation.at === now)
    .map((animation) => animation.guid);
  assert.ok(recovered.length > 0);
  assert.deepEqual(recovered, [...recovered].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  const statePlays = new Map();
  for (const plan of plans) {
    for (const animation of plan.animations) {
      if (animation.animation === 14) statePlays.set(animation.guid, (statePlays.get(animation.guid) ?? 0) + 1);
    }
  }
  let expectedPlays = 0;
  const expectedUnits = new Set();
  for (const [guid, unitAuras] of world.auras) {
    const count = [...unitAuras.values()].filter((aura) => aura.spellId % 3 === 0).length;
    expectedPlays += count;
    if (count > 0) expectedUnits.add(guid);
    assert.equal(statePlays.get(guid) ?? 0, count, `unit ${guid} plays each StateKit once`);
  }
  assert.ok(expectedPlays > 256, "the batch covers more auras than the queue could hold");
  const picture = states.at(-1);
  assert.deepEqual(new Set(picture.keys()), expectedUnits);
  assert.equal(coordinator.pendingCounts().aura, 0);

  // Leaving is one unit's business too.
  let worstLeave = 0;
  for (let index = 0; index < UNITS; index++) {
    const before = asked;
    leave(index);
    worstLeave = Math.max(worstLeave, asked - before);
  }
  assert.ok(worstLeave <= 3 * PER, `one departure asked the metadata source ${worstLeave} times`);
  now += 16;
  coordinator.tick(now);
  assert.equal(states.at(-1).size, 0, "the frame after everybody left shows nobody");
});

test("a unit's packets never re-queue another unit's evicted wait, and its row still finds it", () => {
  let now = 1_000;
  const answers = new Map();
  const asked = new Map();
  const metadata = { get(id) { asked.set(id, (asked.get(id) ?? 0) + 1); return answers.get(id); } };
  const plans = [];
  const renderer = {
    playSpellVisual(plan) { plans.push(plan); return { id: plans.length }; },
    setStateVisuals() {},
  };
  const coordinator = new SpellVisualCoordinator({ metadata, renderer, now: () => now, queueCaps: { aura: 4 } });
  const objects = new Map([[1n, { position: { x: 1, y: 2, z: 3 } }], [2n, { position: { x: 5, y: 2, z: 3 } }]]);
  const world = { events: new Events(), state: { selfGuid: 1n, objects }, auras: new Map(), targetGuid: undefined };
  coordinator.bindWorld(world);
  const aurasOf = (spells) => new Map(spells.map((spellId, slot) => [slot, { slot, spellId, flags: 0, casterLevel: 1, applications: 1 }]));
  // Unit 1 wears six auras whose rows are all in flight; the cap keeps the last four.
  const first = aurasOf([501, 502, 503, 504, 505, 506]);
  world.events.emit("AURA_CHANGED", { guid: 1n, previous: new Map(), current: first, added: [...first.values()], removed: [], updated: [] });
  assert.equal(coordinator.pendingCounts().aura, 4);
  // Unit 2 is busy with a spell already answered as "nothing". None of it may touch unit 1.
  answers.set(600, undefined);
  coordinator.onLoaded([600]);
  const noise = aurasOf([600]);
  asked.clear();
  for (let packet = 0; packet < 20; packet++) {
    now += 1;
    world.events.emit("AURA_CHANGED", { guid: 2n, previous: noise, current: noise, added: [], removed: [], updated: [] });
  }
  assert.equal(coordinator.pendingCounts().aura, 4, "the evicted two stay evicted");
  assert.equal(asked.get(501) ?? 0, 0, "and nobody asks about them on unit 2's behalf");
  assert.equal(asked.get(600) ?? 0, 0, "a spell known to show nothing is not asked about again");

  // The batch lands: the four still waiting replay with their receipt time, the two the cap let
  // go of are found through the unit that wears them and play now. Each exactly once.
  const loadedAt = now + 40;
  now = loadedAt;
  for (let id = 501; id <= 506; id++) answers.set(id, visualFor(id, "full"));
  coordinator.onLoaded([501, 502, 503, 504, 505, 506]);
  const played = plans.flatMap((plan) => plan.animations).filter((animation) => animation.animation === 14);
  assert.equal(played.length, 6);
  assert.equal(new Set(played.map((animation) => animation.at)).size, 2);
  assert.equal(played.filter((animation) => animation.at === loadedAt).length, 2);
  assert.equal(coordinator.pendingCounts().aura, 0);
});

test("a frame hands over every packet since the last one, once, and a quiet frame hands over nothing", () => {
  let now = 1_000;
  const values = new Map([[7, visualFor(7, "full")], [8, visualFor(8, "twin")]]);
  const states = [];
  const renderer = { playSpellVisual: () => ({}), setStateVisuals(byUnit) { states.push(byUnit); } };
  const coordinator = new SpellVisualCoordinator({ metadata: { get: (id) => values.get(id) }, renderer, now: () => now });
  const objects = new Map([[1n, { position: { x: 1, y: 2, z: 3 } }], [2n, { position: { x: 5, y: 2, z: 3 } }]]);
  const world = { events: new Events(), state: { selfGuid: 1n, objects }, auras: new Map(), targetGuid: undefined };
  coordinator.bindWorld(world);
  states.length = 0;
  const one = new Map([[0, { slot: 0, spellId: 7, flags: 0, casterLevel: 1, applications: 1 }]]);
  const two = new Map([[3, { slot: 3, spellId: 8, flags: 0, casterLevel: 1, applications: 1 }]]);
  world.events.emit("AURA_CHANGED", { guid: 2n, previous: new Map(), current: one, added: [...one.values()], removed: [], updated: [] });
  world.events.emit("AURA_CHANGED", { guid: 1n, previous: new Map(), current: two, added: [...two.values()], removed: [], updated: [] });
  world.events.emit("AURA_CHANGED", { guid: 2n, previous: one, current: new Map(), added: [], removed: [...one.values()], updated: [] });
  world.events.emit("AURA_CHANGED", { guid: 2n, previous: new Map(), current: one, added: [...one.values()], removed: [], updated: [] });
  assert.equal(states.length, 0);
  coordinator.tick(now += 16);
  assert.equal(states.length, 1);
  assert.deepEqual([...states[0]].map(([guid, effects]) => [guid, effects.map((effect) => effect.path)]), [
    [1n, ["layer-8.m2", "layer-8.m2"]],
    [2n, ["state-7.m2"]],
  ], "the last packet's picture, in snapshot order: unit 2 left and came back behind unit 1");
  coordinator.tick(now += 16);
  assert.equal(states.length, 1, "nothing new, nothing handed over");
});

test("an aura with no StateKit still warms the StateDone it ends with, on its own unit's packets", () => {
  const values = new Map([[9, { id: 9, stateDone: kit(15, 0, [{ path: "pop.m2", attachment: 7, scale: 1 }]) }]]);
  const prewarmed = [];
  const renderer = {
    playSpellVisual: () => ({}), setStateVisuals() {}, prewarmSpellModels(paths) { prewarmed.push([...paths]); },
  };
  const coordinator = new SpellVisualCoordinator({ metadata: { get: (id) => values.get(id) }, renderer, now: () => 1_000 });
  const objects = new Map([[2n, { position: { x: 1, y: 2, z: 3 } }], [3n, { position: { x: 5, y: 2, z: 3 } }]]);
  const world = { events: new Events(), state: { selfGuid: 2n, objects }, auras: new Map(), targetGuid: undefined };
  coordinator.bindWorld(world);
  const worn = new Map([[0, { slot: 0, spellId: 9, flags: 0, casterLevel: 1, applications: 1 }]]);
  world.events.emit("AURA_CHANGED", { guid: 2n, previous: new Map(), current: worn, added: [...worn.values()], removed: [], updated: [] });
  assert.deepEqual(prewarmed, [["pop.m2"], ["pop.m2"]], "the add, then its unit's pass, as before");
  const other = new Map([[0, { slot: 0, spellId: 9, flags: 0, casterLevel: 1, applications: 1 }]]);
  world.events.emit("AURA_CHANGED", { guid: 3n, previous: new Map(), current: other, added: [...other.values()], removed: [], updated: [] });
  assert.equal(prewarmed.length, 4, "unit 3's packet warms unit 3's aura, not unit 2's again");
  world.events.emit("AURA_CHANGED", { guid: 2n, previous: worn, current: worn, added: [], removed: [], updated: [] });
  assert.equal(prewarmed.length, 5);
  assert.equal(coordinator.pendingCounts().aura, 0, "a row that is here is not waited for");
});

test("a renderer that appears is handed the picture on its first frame, even an empty one", () => {
  let now = 1_000;
  let present = false;
  const states = [];
  const renderer = { playSpellVisual: () => ({}), setStateVisuals(byUnit) { states.push(byUnit); } };
  const coordinator = new SpellVisualCoordinator({
    metadata: { get: () => undefined }, renderer: () => (present ? renderer : undefined), now: () => now,
  });
  const world = { events: new Events(), state: { selfGuid: 1n, objects: new Map() }, auras: new Map(), targetGuid: undefined };
  coordinator.bindWorld(world);
  coordinator.tick(now += 16);
  assert.equal(states.length, 0);
  present = true;
  coordinator.tick(now += 16);
  assert.equal(states.length, 1);
  assert.equal(states[0].size, 0);
  coordinator.tick(now += 16);
  assert.equal(states.length, 1);
});

test("a live aura whose row failed is asked for again every frame, and only while it is worn", () => {
  let now = 1_000;
  const asked = [];
  const metadata = { get(id) { asked.push(id); return undefined; } };
  const renderer = { playSpellVisual: () => ({}), setStateVisuals() {} };
  const coordinator = new SpellVisualCoordinator({ metadata, renderer, now: () => now, ttlMs: 2_000 });
  const objects = new Map([[1n, { position: { x: 1, y: 2, z: 3 } }], [2n, { position: { x: 5, y: 2, z: 3 } }]]);
  const world = { events: new Events(), state: { selfGuid: 1n, objects }, auras: new Map(), targetGuid: undefined };
  coordinator.bindWorld(world);
  const worn = new Map([[0, { slot: 0, spellId: 77, flags: 0, casterLevel: 1, applications: 1 }]]);
  world.events.emit("AURA_CHANGED", { guid: 2n, previous: new Map(), current: worn, added: [...worn.values()], removed: [], updated: [] });
  // The batch fails (no onLoaded) and the wait outlives its TTL; nobody's packet mentions 77 again.
  now += 2_500;
  coordinator.tick(now);
  asked.length = 0;
  for (let frame = 0; frame < 3; frame++) coordinator.tick(now += 16);
  assert.deepEqual(asked, [77, 77, 77], "the retry that every packet used to give it, once a frame");
  world.events.emit("AURA_CHANGED", { guid: 2n, previous: worn, current: new Map(), added: [], removed: [...worn.values()], updated: [] });
  asked.length = 0;
  for (let frame = 0; frame < 3; frame++) coordinator.tick(now += 16);
  assert.deepEqual(asked, [], "a spell nobody wears is not asked about");
});
