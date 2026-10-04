import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway, texturePriority } from "../dist/code/gateway/Gateway.js";

const ORIGIN = "http://127.0.0.1:5173";
const textureFile = (directory, path) => join(directory,
  `${createHash("sha1").update(`texture-v1\0${path.replaceAll("/", "\\").toLowerCase()}`).digest("hex")}.png`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function gatewayWith(generateTexture) {
  const texturesDirectory = await mkdtemp(join(tmpdir(), "webclient-lanes-"));
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    texturesDirectory,
    generateTexture: (path) => generateTexture(path, texturesDirectory),
    datasetPollMs: 0,
  });
  const ask = (path) => fetch(`http://127.0.0.1:${gateway.port}/texture?path=${encodeURIComponent(path)}`,
    { headers: { origin: ORIGIN } }).then(async (response) => {
    await response.arrayBuffer();
    return response.status;
  });
  return {
    ask,
    async close() {
      await gateway.close();
      await rm(texturesDirectory, { recursive: true, force: true });
    },
  };
}

test("texture priority: what makes a unit appear, then the world, then interface art", () => {
  assert.equal(texturePriority("Character\\Human\\Male\\HumanMaleSkin00_00.blp"), 2);
  assert.equal(texturePriority("Item/TextureComponents/TorsoUpperTexture/Plate_A_01Gold_Chest_TU_U.blp"), 2);
  assert.equal(texturePriority("Creature\\Wolf\\WolfSkinGrey.blp"), 2);
  assert.equal(texturePriority("Textures\\BakedNpcTextures\\CreatureDisplayExtra-12345.blp"), 2);
  assert.equal(texturePriority("World\\Generic\\Human\\Passive Doodads\\Barrel\\Barrel01.blp"), 1);
  assert.equal(texturePriority("Tileset\\Elwynn\\ElwynnGrassBase.blp"), 1);
  assert.equal(texturePriority("Textures\\Minimap\\f5a9e0c1b2.blp"), 0);
  assert.equal(texturePriority("Interface\\Icons\\INV_Misc_QuestionMark.blp"), 0);
});

test("a unit's skin queued behind minimap tiles is published before them", async () => {
  // Measured on the owner's session of 2026-09-28: 241 baked NPC skins went through the texture lane
  // behind 80 minimap tiles, 33 icons and 21 world-map tiles, first come first served, and every one
  // of those NPCs stood as a capsule until its skin was published.
  const order = [];
  let release;
  const held = new Promise((done) => { release = done; });
  const box = await gatewayWith(async (path, directory) => {
    order.push(path);
    if (order.length === 1) await held;
    await writeFile(textureFile(directory, path), "png");
  });
  try {
    const busy = box.ask("Textures\\Minimap\\busy.blp");
    while (order.length === 0) await sleep(5);
    // One at a time, so the gateway sees them in this order: parallel connections arrive in any.
    const waiting = [];
    for (const path of ["Textures\\Minimap\\tile01.blp", "World\\Generic\\Doodad\\Barrel.blp",
      "Textures\\Minimap\\tile02.blp", "Creature\\Wolf\\WolfSkin.blp"]) {
      waiting.push(box.ask(path));
      await sleep(40);
    }
    await sleep(60);
    release();
    assert.deepEqual(await Promise.all([busy, ...waiting]), [200, 200, 200, 200, 200]);
    assert.deepEqual(order.slice(1), [
      "Creature\\Wolf\\WolfSkin.blp",
      "World\\Generic\\Doodad\\Barrel.blp",
      "Textures\\Minimap\\tile01.blp",
      "Textures\\Minimap\\tile02.blp",
    ], "highest priority first, arrival order within one");
  } finally {
    await box.close();
  }
});

test("a transient failure is refused only briefly, so the browser's first retry runs the generator again", async () => {
  // The browser retries a 500 at 2 s, 8 s and 30 s (Т6). With the five-minute memory every retry was
  // refused with the same 500, so one crashed generator run lost the texture for the session.
  let runs = 0;
  const box = await gatewayWith(async (path, directory) => {
    runs++;
    if (runs === 1) throw Object.assign(new Error("worker died"), { exitCode: 3221225477 });
    await writeFile(textureFile(directory, path), "png");
  });
  try {
    assert.equal(await box.ask("Tileset\\Test\\Flaky.blp"), 500);
    assert.equal(await box.ask("Tileset\\Test\\Flaky.blp"), 500, "the burst that arrives with it shares the refusal");
    assert.equal(runs, 1);
    await sleep(1_700);
    assert.equal(await box.ask("Tileset\\Test\\Flaky.blp"), 200, "a retry after the window runs it again");
    assert.equal(runs, 2);
  } finally {
    await box.close();
  }
});

// 10.20 slice 0 (М-A10-3): the lanes live in GenerationLane.ts; promote, laneStats and lanesQuiet
// are what 10.22's preloader stands on.
const lanes = await import("../dist/code/gateway/GenerationLane.js");

/** A job that runs until released, recording its order. */
function heldJob(order, name) {
  let release;
  const held = new Promise((done) => { release = done; });
  return { run: async () => { order.push(name); await held; }, release: () => release() };
}

test("Gateway.ts re-exports the lane names other modules import from it", async () => {
  const gateway = await import("../dist/code/gateway/Gateway.js");
  assert.equal(gateway.SOURCE_MISSING_EXIT, lanes.SOURCE_MISSING_EXIT);
  assert.equal(gateway.sourceMissing, lanes.sourceMissing);
  assert.equal(gateway.texturePriority, lanes.texturePriority);
});

test("a real request for a key a background job is waiting on raises it past the other background jobs", async () => {
  const lane = lanes.generationLane();
  const order = [];
  const busy = heldJob(order, "busy");
  const running = lanes.generateOnce(lane, "busy", busy.run, 1);
  const preloads = ["a", "b", "c"].map((key) => lanes.generateOnce(lane, key, async () => { order.push(key); }, lanes.PRELOAD_PRIORITY));
  // The player asks for "c": it joins the queued preload and lifts it to its own priority.
  let ran = 0;
  const real = lanes.generateOnce(lane, "c", async () => { ran++; }, 2);
  busy.release();
  await Promise.all([running, real, ...preloads]);
  assert.deepEqual(order, ["busy", "c", "a", "b"], "the promoted job runs first, the rest in arrival order");
  assert.equal(ran, 0, "the real request shared the queued run rather than starting a second one");
});

test("promote only raises, and only a waiting job", async () => {
  const lane = lanes.generationLane();
  const order = [];
  const busy = heldJob(order, "busy");
  const running = lanes.generateOnce(lane, "busy", busy.run, 1);
  const low = lanes.generateOnce(lane, "low", async () => { order.push("low"); }, 0);
  const mid = lanes.generateOnce(lane, "mid", async () => { order.push("mid"); }, 1);
  assert.equal(lanes.promote(lane, "busy", 5), false, "a running job cannot be sped up");
  assert.equal(lanes.promote(lane, "mid", 0), true);
  assert.equal(lanes.promote(lane, "absent", 9), false);
  busy.release();
  await Promise.all([running, low, mid]);
  assert.deepEqual(order, ["busy", "mid", "low"], "a lower priority never demotes");
});

test("laneStats counts requests, cold runs, preloads, waiting and running time on the lane's clock", async () => {
  let clock = 1_000;
  const lane = lanes.generationLane(() => clock);
  const order = [];
  const first = heldJob(order, "first");
  const a = lanes.generateOnce(lane, "first", first.run, 1);
  const b = lanes.generateOnce(lane, "second", async () => { clock += 30; }, 1);
  const shared = lanes.generateOnce(lane, "second", async () => {}, 1);
  const background = lanes.generateOnce(lane, "bg", async () => { clock += 500; }, lanes.PRELOAD_PRIORITY);
  assert.equal(lanes.laneStats(lane).waiting, 2);
  assert.equal(lanes.laneStats(lane).running, true);
  clock += 100;
  first.release();
  await Promise.all([a, b, shared, background]);
  const stats = lanes.laneStats(lane);
  assert.equal(stats.requests, 4);
  assert.equal(stats.cold, 2, "two real runs; the shared request did not run");
  assert.equal(stats.preloads, 1);
  assert.equal(stats.waitMs, 100, "second waited 100 ms behind first");
  assert.equal(stats.runMs, 130, "first ran 100 ms, second 30; background time is not counted");
  assert.equal(stats.lastRealAt, 1_130, "a background job does not move the quiet window");
  assert.equal(stats.waiting, 0);
  assert.equal(stats.running, false);
});

test("lanesQuiet: every lane idle and no real job on any of them within the window", async () => {
  let clock = 10_000;
  const textures = lanes.generationLane(() => clock);
  const models = lanes.generationLane(() => clock);
  assert.equal(lanes.lanesQuiet([textures, models], clock), true, "a lane that never ran is quiet");
  const order = [];
  const held = heldJob(order, "model");
  const running = lanes.generateOnce(models, "m", held.run, 1);
  assert.equal(lanes.lanesQuiet([textures, models], clock), false, "a running lane is not quiet");
  held.release();
  await running;
  assert.equal(lanes.lanesQuiet([textures, models], clock), false, "a real job just finished on the neighbour lane");
  assert.equal(lanes.lanesQuiet([textures, models], clock + lanes.LANE_QUIET_MS - 1), false);
  assert.equal(lanes.lanesQuiet([textures, models], clock + lanes.LANE_QUIET_MS), true);
  assert.equal(lanes.lanesQuiet([textures], clock), true, "the window is per lane set the caller asks about");
});

// 10.20 slice 4: the model lane (and the model worker) take a unit's model before a doodad and a
// doodad before a city WMO, which can take 0.3–0.9 s on its own.
test("visual model priority: units, then other M2s, then WMOs", () => {
  assert.equal(lanes.visualModelPriority("Creature/Wolf/Wolf.m2"), 2);
  assert.equal(lanes.visualModelPriority("Character/Human/Male/HumanMale.m2"), 2);
  assert.equal(lanes.visualModelPriority("World/Generic/Human/Passive Doodads/Barrel/Barrel01.m2"), 1);
  assert.equal(lanes.visualModelPriority("Spells/Fireball_Missile_High.m2"), 1);
  assert.equal(lanes.visualModelPriority("World/wmo/Azeroth/Buildings/Stormwind/Stormwind.wmo"), 0);
  assert.ok(lanes.visualModelPriority("World/x.wmo") > lanes.PRELOAD_PRIORITY, "still above background work");
});

test("a creature's model queued behind a city WMO is published before it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-model-lane-"));
  const order = [];
  let release;
  const held = new Promise((done) => { release = done; });
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    visualModelsDirectory: directory,
    generateVisualModel: async (path, hash) => {
      order.push(path);
      if (order.length === 1) await held;
      await writeFile(join(directory, `${hash}.bin`), "model");
    },
    datasetPollMs: 0,
  });
  const ask = (path) => fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(path)}`,
    { headers: { origin: ORIGIN } }).then(async (response) => {
    await response.arrayBuffer();
    return response.status;
  });
  try {
    const busy = ask("World/Generic/Busy.m2");
    while (order.length === 0) await sleep(5);
    const waiting = [];
    for (const path of ["World/wmo/Test/City.wmo", "World/Generic/Barrel.m2", "Creature/Wolf/Wolf.m2"]) {
      waiting.push(ask(path));
      await sleep(40);
    }
    await sleep(60);
    release();
    assert.deepEqual(await Promise.all([busy, ...waiting]), [200, 200, 200, 200]);
    // The route spells paths with backslashes; compared with forward ones.
    assert.deepEqual(order.slice(1).map((path) => path.replaceAll("\\", "/")),
      ["Creature/Wolf/Wolf.m2", "World/Generic/Barrel.m2", "World/wmo/Test/City.wmo"]);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});
