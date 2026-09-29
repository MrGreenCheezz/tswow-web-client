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
