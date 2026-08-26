import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSET_WARMUP_BUDGET, ASSET_WARMUP_SOFT_WINDOW_MS, BoundedWarmFetchQueue, SessionAssetWarmup,
  actionBarWarmSpellIds, boundedUnique,
  nearestSceneryModelPaths, spellVisualModelPaths,
} from "../dist/code/browser/AssetWarmup.js";
import { ACTION_BUTTON_ITEM, ACTION_BUTTON_SPELL } from "../dist/code/world/ActionBarProtocol.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("warm-up selectors deduplicate and stop at their hard budgets", () => {
  assert.deepEqual(boundedUnique(["a", "a", "b", "c", "d"], 3), ["a", "b", "c"]);
  assert.deepEqual(boundedUnique(["a"], 0), []);

  const buttons = [];
  for (let slot = 29; slot >= 0; slot--) {
    buttons.push({ slot, action: 1_000 + (slot % 27), type: ACTION_BUTTON_SPELL });
  }
  buttons.push({ slot: 1, action: 9_999, type: ACTION_BUTTON_ITEM });
  const spells = actionBarWarmSpellIds(buttons);
  assert.equal(spells.length, ASSET_WARMUP_BUDGET.spellIds);
  assert.deepEqual(spells.slice(0, 3), [1_000, 1_001, 1_002], "server slot order wins, not packet array order");
  assert.equal(new Set(spells).size, spells.length);
  assert.equal(spells.includes(9_999), false, "items do not consume the spell metadata budget");
});

test("spell and scenery selection keeps distinct nearest paths only", () => {
  const effect = (path) => ({ path, attachment: 19, scale: 1 });
  const visual = {
    id: 7,
    precast: { startAnimation: -1, animation: -1, sound: 0, effects: [effect("A.m2"), effect("A.m2")] },
    missile: { path: "B.m2", attachment: 22, scale: 1, speed: 20 },
    impact: { startAnimation: -1, animation: -1, sound: 0, effects: [effect("C.m2")] },
  };
  assert.deepEqual(spellVisualModelPaths(visual), ["A.m2", "B.m2", "C.m2"]);

  const objects = [
    { id: 1, name: "FarOriginButInside.wmo", x: 1_000, y: 1_000, bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 } },
    { id: 2, name: "Near.m2", x: 4, y: 0 },
    { id: 3, name: "Near.m2", x: 2, y: 0 },
    { id: 4, name: "Third.m2", x: 8, y: 0 },
  ];
  assert.deepEqual(
    nearestSceneryModelPaths(objects, { x: 0, y: 0 }, 2),
    ["FarOriginButInside.wmo", "Near.m2"],
    "a WMO is ranked from its bounds and duplicate placements spend one slot",
  );
});

test("texture warm-up consumes at most two responses concurrently and 24 in total", async () => {
  const releases = [];
  const started = [];
  let active = 0;
  let maximum = 0;
  const fetcher = (url) => {
    started.push(url);
    active++;
    maximum = Math.max(maximum, active);
    return new Promise((resolve) => releases.push({
      done: false,
      release() {
        if (this.done) return;
        this.done = true;
        active--;
        resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
      },
    }));
  };
  const queue = new BoundedWarmFetchQueue(fetcher);
  const urls = Array.from({ length: 30 }, (_, index) => `/texture/${index}`);
  assert.equal(queue.add([...urls, urls[0], urls[1]]), ASSET_WARMUP_BUDGET.textures);
  assert.equal(queue.accepted, ASSET_WARMUP_BUDGET.textures);
  await turn();
  assert.equal(started.length, ASSET_WARMUP_BUDGET.textureConcurrency);

  const idle = queue.waitForIdle();
  for (let wave = 0; wave < 20; wave++) {
    for (const release of releases) release.release();
    await turn();
    if (started.length === ASSET_WARMUP_BUDGET.textures && active === 0) break;
  }
  await idle;
  assert.equal(maximum, ASSET_WARMUP_BUDGET.textureConcurrency);
  assert.equal(started.length, ASSET_WARMUP_BUDGET.textures);
  assert.equal(new Set(started).size, started.length);
  queue.close();
  assert.equal(queue.add(["/too-late"]), 0, "a disposed session cannot enqueue stale work");
});

test("closing a warm queue aborts active work and never starts its backlog", async () => {
  let started = 0;
  let aborted = 0;
  const queue = new BoundedWarmFetchQueue((_url, { signal }) => {
    started++;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted++;
        reject(new Error("aborted"));
      }, { once: true });
    });
  }, 8, 2);
  queue.add(["a", "b", "c", "d"]);
  await turn();
  assert.equal(started, 2);
  queue.close();
  await queue.waitForIdle();
  assert.equal(aborted, 2);
  assert.equal(started, 2, "queued stale URLs never begin after session disposal");
});

test("texture queue promotes duplicate URLs and drains player before spell before scenery", async () => {
  const started = [];
  const releases = [];
  const queue = new BoundedWarmFetchQueue((url) => {
    started.push(url);
    return new Promise((resolve) => releases.push(() => resolve({
      ok: true, arrayBuffer: async () => new ArrayBuffer(1),
    })));
  }, 8, 1);
  queue.add(["shared", "scenery"], "scenery");
  queue.add(["spell"], "spell");
  assert.equal(queue.add(["shared", "player"], "player"), 1, "promotion does not spend a second URL");
  assert.equal(queue.accepted, 4);
  await turn();
  assert.deepEqual(started, ["shared"], "the promoted first occurrence keeps FIFO within player");
  for (const expected of ["player", "spell", "scenery"]) {
    releases.shift()();
    await turn();
    assert.equal(started.at(-1), expected);
  }
  releases.shift()();
  await queue.waitForIdle();
  assert.equal(started.filter((url) => url === "shared").length, 1, "same URL is fetched once");
});

test("non-finite queue options normalize to the fixed 24/2 safety ceiling", async () => {
  const started = [];
  const queue = new BoundedWarmFetchQueue((url, { signal }) => {
    started.push(url);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
  }, Number.POSITIVE_INFINITY, Number.NaN);
  assert.equal(queue.add(Array.from({ length: 40 }, (_, index) => `u${index}`)), ASSET_WARMUP_BUDGET.textures);
  await turn();
  assert.equal(queue.accepted, ASSET_WARMUP_BUDGET.textures);
  assert.equal(started.length, ASSET_WARMUP_BUDGET.textureConcurrency);
  queue.close();
  await queue.waitForIdle();

  const empty = new BoundedWarmFetchQueue(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }), -1, 2);
  assert.equal(empty.add(["never"]), 0);
  assert.equal(empty.accepted, 0);
});

function playerState() {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, 49);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1);
  fields.set(UPDATE_FIELDS.PLAYER_BYTES.offset, 0);
  fields.set(UPDATE_FIELDS.PLAYER_BYTES_2.offset, 0);
  return { typeId: 4, fields, position: { x: 0, y: 0, z: 0, orientation: 0 } };
}

function watchedArray(values, onIterate) {
  return new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        return function iterator() {
          onIterate();
          return target[Symbol.iterator]();
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

test("an unchanged second tick does not rerun action-bar or scenery selectors", () => {
  let now = 0;
  let actionScans = 0;
  let sceneryScans = 0;
  const actionButtons = watchedArray([
    { slot: 0, action: 2_000, type: ACTION_BUTTON_SPELL },
  ], () => actionScans++);
  const environment = watchedArray([
    { id: 1, kind: "m2", name: "Tree.m2", x: 1, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 },
  ], () => sceneryScans++);
  const controller = new SessionAssetWarmup({
    environment: { baseUrl: "http://gateway.test", model() { return undefined; } },
    creatureModels: { request() {}, get() { return undefined; }, playerAppearance() { return undefined; } },
    itemMetadata: { load: async () => false, get: () => undefined },
    spellVisuals: { get() { return undefined; } },
  }, { now: () => now });
  const frame = { player: playerState(), environment, actionButtons };
  now = 1_000;
  controller.tick(frame);
  assert.deepEqual([actionScans, sceneryScans], [1, 1]);
  now++;
  controller.tick(frame);
  assert.deepEqual([actionScans, sceneryScans], [1, 1], "stable references bypass both selectors");
  controller.dispose();
});

test("equipment warm-up asks new entries and re-arms unanswered metadata", async () => {
  let now = 0;
  let fail = true;
  const loads = [];
  const metadata = new Map();
  const controller = new SessionAssetWarmup({
    environment: { baseUrl: "http://gateway.test", model() { return undefined; } },
    creatureModels: { request() {}, get() { return undefined; }, playerAppearance() { return undefined; } },
    itemMetadata: {
      load(entries) {
        loads.push([...entries]);
        if (fail) {
          fail = false;
          return Promise.reject(new Error("temporary"));
        }
        return Promise.resolve(false);
      },
      get(entry) { return metadata.get(entry); },
    },
    spellVisuals: { get() { return undefined; } },
  }, { now: () => now });
  const player = playerState();
  const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
  player.fields.set(first, 100);
  const frame = { player, environment: [], actionButtons: [] };
  controller.tick(frame);
  await turn();
  now++;
  controller.tick(frame);
  assert.deepEqual(loads, [[100], [100]], "a failed/unanswered entry reaches ItemMetadata's retry policy again");
  await turn();

  player.fields.set(first, 200);
  now++;
  controller.tick(frame);
  assert.deepEqual(loads.at(-1), [200], "equipment changed after the first request is still warmed");
  metadata.set(200, { entry: 200 });
  await turn();
  now++;
  controller.tick(frame);
  assert.equal(loads.filter((entries) => entries.includes(200)).length, 1, "resolved entries stay deduplicated");
  controller.dispose();
});

test("session model and texture categories keep their independent caps", async () => {
  const modelCalls = [];
  const fetched = [];
  let now = 0;
  const appearance = {
    body: Array.from({ length: 10 }, (_, index) => ({ path: `Body${index}.blp` })),
    hair: "Hair.blp",
    cloak: "Cloak.blp",
    geosets: [],
    attached: Array.from({ length: 10 }, (_, index) => ({
      slot: index, inventoryType: 1, side: "left", model: `PlayerAttached${index}.m2`, texture: `Item${index}.blp`,
    })),
  };
  const environmentClient = {
    baseUrl: "http://gateway.test",
    model(path, priority) {
      modelCalls.push({ path, priority });
      return { vertices: [], indices: [], textureUrl: `http://assets.test/${priority}/${path}.png` };
    },
  };
  const controller = new SessionAssetWarmup({
    environment: environmentClient,
    creatureModels: {
      request() {},
      get() { return { id: 49, model: "PlayerBase.m2", textures: "", scale: 1, collisionHeight: 2 }; },
      playerAppearance() { return appearance; },
    },
    itemMetadata: { load: async () => false, get: () => undefined },
    spellVisuals: {
      get(id) { return { id, missile: { path: `Spell${id}.m2`, scale: 1, attachment: 22, speed: 20 } }; },
    },
  }, {
    now: () => now,
    fetcher: async (url) => {
      fetched.push(url);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    },
  });
  const buttons = Array.from({ length: 30 }, (_, slot) => ({ slot, action: 2_000 + slot, type: ACTION_BUTTON_SPELL }));
  const environment = Array.from({ length: 10 }, (_, index) => ({
    id: index, kind: "m2", name: `Scenery${index}.m2`, x: index + 1, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  }));
  now = 1_000;
  controller.tick({ player: playerState(), environment, actionButtons: buttons });
  for (let index = 0; index < 4; index++) await turn();

  const pathsFor = (priority) => new Set(modelCalls.filter((call) => call.priority === priority).map((call) => call.path));
  assert.equal(pathsFor("critical").size, ASSET_WARMUP_BUDGET.playerModels);
  assert.equal(pathsFor("normal").size, ASSET_WARMUP_BUDGET.spellModels);
  assert.equal(pathsFor("background").size, ASSET_WARMUP_BUDGET.sceneryModels);
  assert.equal(fetched.length, ASSET_WARMUP_BUDGET.textures);
  assert.equal(fetched.filter((url) => url.includes("/normal/")).length, ASSET_WARMUP_BUDGET.spellTextures);
  assert.equal(fetched.filter((url) => url.includes("/background/")).length, ASSET_WARMUP_BUDGET.sceneryTextures);
  assert.equal(
    fetched.length - fetched.filter((url) => url.includes("/normal/") || url.includes("/background/")).length,
    ASSET_WARMUP_BUDGET.playerTextures,
  );
  controller.dispose();
});

test("expired and disposed session warm-up ticks are no-ops", () => {
  let now = 0;
  let calls = 0;
  const controller = new SessionAssetWarmup({
    environment: { baseUrl: "http://gateway.test", model() { calls++; } },
    creatureModels: { request() { calls++; }, get() { calls++; }, playerAppearance() { calls++; } },
    itemMetadata: { load: async () => { calls++; return false; }, get() { calls++; } },
    spellVisuals: { get() { calls++; } },
  }, { now: () => now, fetcher: async () => { calls++; throw new Error("must not fetch"); } });
  const frame = { player: playerState(), environment: [], actionButtons: [] };
  now = ASSET_WARMUP_SOFT_WINDOW_MS + 1;
  controller.tick(frame);
  assert.equal(calls, 0);
  controller.dispose();
  now = 0;
  controller.tick(frame);
  assert.equal(calls, 0);
});
