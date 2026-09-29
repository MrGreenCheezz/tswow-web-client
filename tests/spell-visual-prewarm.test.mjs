// S1 — what the prewarm is made of, driven without a renderer or a canvas.
//
// Three mechanisms carry the slice and each is tested where it can be observed: the warm lease
// pool (the trap — a prewarmed texture with nobody holding it is evicted before its cast), the
// coordinator's prewarm seam (which paths, on which packet), and the payload-aware action wait.

import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSET_WARMUP_BUDGET, ASSET_WARMUP_LONG_LANE_START_MS, ASSET_WARMUP_SOFT_WINDOW_MS,
  SessionAssetWarmup, WARM_LEASE_POOL_LIMIT, WarmLeasePool, loadedVisualWarmPaths,
} from "../dist/code/browser/AssetWarmup.js";
import { SpellVisualCoordinator } from "../dist/code/browser/SpellVisualLifecycle.js";
import {
  spellAuraPrewarmPaths, spellCastPrewarmPaths,
} from "../dist/code/browser/SpellVisuals.js";
import { ACTION_SIDECAR_WAIT, pendingActionFate } from "../dist/code/browser/AnimatedModel.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { ACTION_BUTTON_SPELL } from "../dist/code/world/ActionBarProtocol.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));

function leases() {
  const taken = [];
  const acquire = (url) => {
    const lease = { url, released: false, release() { this.released = true; } };
    taken.push(lease);
    return lease;
  };
  return { taken, acquire, live: () => taken.filter((lease) => !lease.released).map((lease) => lease.url) };
}

test("a warm lease pool holds claims across frames and gives every one of them up", () => {
  const { taken, acquire, live } = leases();
  const pool = new WarmLeasePool(acquire, 3, 1_000);

  pool.warm("a", 0);
  pool.warm("b", 0);
  pool.warm("c", 0);
  assert.deepEqual(pool.urls, ["a", "b", "c"]);
  assert.deepEqual(live(), ["a", "b", "c"], "a claim survives the frame it was made on");

  // Re-warming is a promotion, not a second lease: one claim per URL, moved to the back.
  pool.warm("a", 500);
  assert.deepEqual(pool.urls, ["b", "c", "a"]);
  assert.equal(taken.length, 3);

  pool.warm("d", 500);
  assert.deepEqual(pool.urls, ["c", "a", "d"], "the cap evicts the oldest claim, not the newest");
  assert.equal(taken.find((lease) => lease.url === "b").released, true);

  // TTL is measured from the last warm, so the promoted entry outlives the two beside it.
  pool.expire(1_400);
  assert.deepEqual(pool.urls, ["a", "d"]);
  assert.equal(taken.find((lease) => lease.url === "c").released, true);

  pool.expire(1_600);
  assert.deepEqual(pool.urls, []);
  assert.deepEqual(live(), [], "nothing outlives its own lifetime");
});

test("a warm pool releases everything on teardown and re-acquires a dead claim", () => {
  const { taken, acquire, live } = leases();
  const pool = new WarmLeasePool(acquire, WARM_LEASE_POOL_LIMIT, 10_000);
  pool.warm("a", 0);
  pool.warm("b", 0);
  pool.clear();
  assert.deepEqual(live(), []);
  assert.equal(pool.size, 0);
  pool.clear();

  // The loader can drop a lease under the pool (a cache clear detaches every lease it holds).
  // Reporting warmth nobody is holding is exactly the failure this pool exists to prevent.
  pool.warm("a", 0);
  taken.at(-1).release();
  assert.equal(pool.warm("a", 1), true);
  assert.equal(taken.length, 4, "the dead claim is replaced rather than reported as held");
  assert.deepEqual(live(), ["a"]);

  // An acquire that cannot be served is not a claim.
  const refusing = new WarmLeasePool(() => undefined);
  assert.equal(refusing.warm("a", 0), false);
  assert.equal(refusing.size, 0);
  const disabled = new WarmLeasePool(acquire, 0);
  assert.equal(disabled.warm("a", 0), false);
});

function kit(effects) {
  return { startAnimation: -1, animation: -1, sound: 0, effects: effects.map((path) => ({ path, attachment: -1, scale: 1 })) };
}

function visual() {
  return {
    id: 7,
    precast: kit(["pre.m2"]),
    cast: kit(["cast.m2"]),
    channel: kit(["channel.m2"]),
    impact: kit(["hit.m2"]),
    targetImpact: kit(["target-hit.m2"]),
    state: kit(["state.m2"]),
    stateDone: kit(["done.m2"]),
    missile: { path: "bolt.m2", scale: 1, attachment: -1, speed: 24 },
  };
}

test("prewarm path sets are split by the packet that drives them", () => {
  assert.deepEqual(spellCastPrewarmPaths(visual()), [
    "pre.m2", "cast.m2", "channel.m2", "bolt.m2", "hit.m2", "target-hit.m2",
  ]);
  assert.deepEqual(spellAuraPrewarmPaths(visual()), ["state.m2", "done.m2"]);
  assert.deepEqual(spellCastPrewarmPaths({ id: 1 }), [], "a spell with no phases warms nothing");
});

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
    state: { selfGuid: 1n, objects: new Map([[1n, { position: { x: 1, y: 2, z: 3, orientation: 0 }, targetGuid: 2n }]]) },
    auras: new Map(),
    targetGuid: 2n,
  };
}

function recordingRenderer() {
  const prewarmed = [];
  return {
    prewarmed,
    playSpellVisual() { return { id: prewarmed.length }; },
    setStateVisuals() {},
    cancelSpellVisual() {},
    prewarmSpellModels(paths) { prewarmed.push([...paths]); },
  };
}

test("cast start prewarms the cast phases, with or without a caster to draw on", () => {
  let now = 1_000;
  const values = new Map();
  const renderer = recordingRenderer();
  const coordinator = new SpellVisualCoordinator({
    metadata: { get: (id) => values.get(id) }, renderer, now: () => now,
  });
  const current = world();
  coordinator.bindWorld(current);

  // Cold: no metadata yet, so there is nothing to name and nothing to warm.
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 1_500, channel: false });
  assert.deepEqual(renderer.prewarmed, []);

  // The metadata replay is the first moment the files are knowable, and it still has most of the
  // cast bar left to spend.
  values.set(7, visual());
  coordinator.onLoaded([7]);
  assert.deepEqual(renderer.prewarmed, [[
    "pre.m2", "cast.m2", "channel.m2", "bolt.m2", "hit.m2", "target-hit.m2",
  ]], "the aura phases belong to the aura packet, not to this one");

  // A caster the client has never seen cannot be drawn on, and its assets are wanted anyway: the
  // SPELL_GO that follows will place them somewhere.
  now = 2_000;
  current.events.emit("SPELL_CAST_START", { casterGuid: 9n, spellId: 7, castTime: 1_500, channel: false });
  assert.equal(renderer.prewarmed.length, 2);
});

test("an aura application prewarms its state and the flash it ends with", () => {
  let now = 1_000;
  const values = new Map([[7, visual()]]);
  const renderer = recordingRenderer();
  const coordinator = new SpellVisualCoordinator({
    metadata: { get: (id) => values.get(id) }, renderer, now: () => now,
  });
  const current = world();
  coordinator.bindWorld(current);
  const aura = { slot: 3, spellId: 7, expiresAt: 4_000 };
  current.events.emit("AURA_CHANGED", {
    guid: 1n, previous: new Map(), current: new Map([[3, aura]]), added: [aura], removed: [], updated: [],
  });
  assert.deepEqual(renderer.prewarmed, [["state.m2", "done.m2"]]);

  // Reconciliation runs on every aura change; an aura already shown is not applied again.
  current.events.emit("AURA_CHANGED", {
    guid: 1n, previous: new Map([[3, aura]]), current: new Map([[3, aura]]), added: [], removed: [], updated: [],
  });
  assert.equal(renderer.prewarmed.length, 1);
});

test("a renderer without the seam is simply a renderer that does not prewarm", () => {
  let now = 1_000;
  const values = new Map([[7, visual()]]);
  const plans = [];
  const coordinator = new SpellVisualCoordinator({
    metadata: { get: (id) => values.get(id) },
    renderer: { playSpellVisual(plan) { plans.push(plan); return { id: plans.length }; }, setStateVisuals() {} },
    now: () => now,
  });
  const current = world();
  coordinator.bindWorld(current);
  current.events.emit("SPELL_CAST_START", { casterGuid: 1n, spellId: 7, castTime: 1_500, channel: false });
  assert.equal(plans.length, 1, "the optional seam changes nothing about the plan itself");
});

test("an in-flight sidecar buys a bounded extra wait, and nothing else does", () => {
  const base = { hasClip: false, promised: true, now: 1_000, waitUntil: 900 };
  // The ordinary window has already run out in every row below; only the sidecar fact differs.
  assert.equal(pendingActionFate(base), "drop");
  assert.equal(pendingActionFate({ ...base, sidecarInFlight: true }), "drop",
    "an extension with no deadline is not an extension");
  assert.equal(pendingActionFate({ ...base, sidecarInFlight: true, sidecarWaitUntil: 3_000 }), "wait");
  assert.equal(pendingActionFate({ ...base, sidecarInFlight: false, sidecarWaitUntil: 3_000 }), "drop",
    "no request in flight means nothing is coming");
  assert.equal(
    pendingActionFate({ ...base, promised: false, sidecarInFlight: true, sidecarWaitUntil: 3_000 }),
    "drop",
    "a sidecar cannot contain a pose the rig does not claim",
  );
  assert.equal(
    pendingActionFate({ ...base, now: 3_000, sidecarInFlight: true, sidecarWaitUntil: 3_000 }),
    "drop",
    "the larger bound is still a bound",
  );
  assert.equal(
    pendingActionFate({ ...base, hasClip: true, sidecarInFlight: true, sidecarWaitUntil: 3_000 }),
    "play",
  );
  // The ordinary window still owns the decision while it is open.
  assert.equal(pendingActionFate({ ...base, now: 500 }), "wait");
  assert.ok(ACTION_SIDECAR_WAIT > 900);
});

test("one metadata batch warms a bounded set of paths, in arrival order", () => {
  const values = new Map([[7, visual()], [8, { id: 8, cast: kit(["other.m2", "cast.m2"]) }]]);
  assert.deepEqual(loadedVisualWarmPaths([7, 8, 9], (id) => values.get(id), 4), [
    "pre.m2", "cast.m2", "channel.m2", "bolt.m2",
  ]);
  assert.deepEqual(
    loadedVisualWarmPaths([8, 7], (id) => values.get(id), 3),
    ["other.m2", "cast.m2", "pre.m2"],
    "a path named by two spells spends one slot",
  );
  assert.deepEqual(loadedVisualWarmPaths([9], (id) => values.get(id)), []);
});

function playerState() {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, 49);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1);
  fields.set(UPDATE_FIELDS.PLAYER_BYTES.offset, 0);
  fields.set(UPDATE_FIELDS.PLAYER_BYTES_2.offset, 0);
  return { typeId: 4, fields, position: { x: 0, y: 0, z: 0, orientation: 0 } };
}

test("the spell lane outlives the soft window while scenery and player stop at it", async () => {
  let now = 0;
  const modelCalls = [];
  const fetched = [];
  const asked = new Set();
  const known = [4_001, 4_002, 4_003, 4_004, 4_005, 4_006];
  const controller = new SessionAssetWarmup({
    environment: {
      baseUrl: "http://gateway.test",
      model(path, priority) {
        modelCalls.push({ path, priority });
        return undefined;
      },
    },
    creatureModels: {
      request() {},
      get() { return { id: 49, model: "PlayerBase.m2", textures: "", scale: 1, collisionHeight: 2 }; },
      playerAppearance() { return undefined; },
    },
    itemMetadata: { load: async () => false, get: () => undefined },
    spellVisuals: {
      get(id) {
        asked.add(id);
        return { id, missile: { path: `Spell${id}.m2`, scale: 1, attachment: 22, speed: 20 } };
      },
    },
  }, {
    now: () => now,
    knownSpellIds: () => known,
    fetcher: async (url) => {
      fetched.push(url);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    },
  });

  const scenery = Array.from({ length: 4 }, (_, index) => ({
    id: index, kind: "m2", name: `Scenery${index}.m2`, x: index + 1, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  }));
  now = 1_000;
  controller.tick({
    player: playerState(),
    environment: scenery,
    actionButtons: [{ slot: 0, action: 2_000, type: ACTION_BUTTON_SPELL }],
  });
  assert.deepEqual([...asked], [2_000], "inside the window the action bar is the whole seed");
  const inWindowSpellModels = new Set(
    modelCalls.filter((call) => call.priority === "normal").map((call) => call.path),
  ).size;
  assert.ok(modelCalls.some((call) => call.priority === "background"), "scenery is warmed inside the window");

  // Past the window: the two short-lived lanes go quiet and the spell lane keeps going.
  now = ASSET_WARMUP_SOFT_WINDOW_MS + 1;
  modelCalls.length = 0;
  controller.tick({
    player: playerState(),
    environment: [...scenery],
    actionButtons: [{ slot: 0, action: 2_000, type: ACTION_BUTTON_SPELL }, { slot: 1, action: 2_001, type: ACTION_BUTTON_SPELL }],
  });
  assert.equal(modelCalls.some((call) => call.priority === "background"), false, "scenery is over");
  assert.equal(modelCalls.some((call) => call.priority === "critical"), false, "so is the player's own body");
  assert.ok(modelCalls.every((call) => call.priority === "normal"));
  assert.ok(inWindowSpellModels > 0);

  // A few new models per tick rather than a spellbook's worth in one frame. An unresolved model is
  // asked for again on the next tick, which is what keeps a pruned request from being lost.
  assert.equal(
    new Set(modelCalls.map((call) => call.path)).size,
    inWindowSpellModels + ASSET_WARMUP_BUDGET.spellLaneTickAdmissions,
  );

  // The spellbook feeds in over several ticks and is not re-read once it has all been admitted.
  for (let tick = 0; tick < 8; tick++) {
    now += 1;
    controller.tick({ player: playerState(), environment: scenery, actionButtons: [] });
  }
  assert.deepEqual([...asked].filter((id) => id >= 4_000), known);

  // The sidecar lane: the player's own rig, once, through the response-only queue.
  await turn();
  assert.deepEqual(fetched.filter((url) => url.includes("/visual/animations")).length, 1);
  assert.ok(fetched.some((url) => url.includes("PlayerBase.m2")));
  now += 1;
  controller.tick({ player: playerState(), environment: scenery, actionButtons: [] });
  await turn();
  assert.equal(fetched.filter((url) => url.includes("/visual/animations")).length, 1,
    "9.4 MiB is asked for once a session, not once a tick");
  assert.equal(ASSET_WARMUP_LONG_LANE_START_MS, ASSET_WARMUP_SOFT_WINDOW_MS);
  controller.dispose();
  assert.equal(controller.stats.closed, true, "both lanes close with the session");
});

test("S3: a kit named by number warms its own models before it draws them", () => {
  let now = 1_000;
  const kits = new Map();
  const renderer = recordingRenderer();
  const coordinator = new SpellVisualCoordinator({
    metadata: { get: () => undefined },
    kitMetadata: { get: (id) => kits.get(id) },
    renderer, now: () => now,
  });
  const current = world();
  coordinator.bindWorld(current);

  // Cold: the packet arrives, nothing is knowable yet, so nothing is warmed.
  coordinator.playVisualKit(1n, 406, false);
  assert.deepEqual(renderer.prewarmed, []);

  // The metadata replay is the same seam a cast start uses — the one difference being that this
  // packet has no cast bar to spend, so the warm and the draw happen on the same tick and the
  // benefit is the texture claim rather than the model fetch.
  kits.set(406, { id: 406, kit: {
    startAnimation: -1, animation: 61, sound: 45,
    effects: [{ path: "food.m2", attachment: 19, scale: 1 }, { path: "tankard.m2", attachment: 22, scale: 1 }],
  } });
  coordinator.onKitsLoaded([406]);
  assert.deepEqual(renderer.prewarmed, [["food.m2", "tankard.m2"]]);
});
