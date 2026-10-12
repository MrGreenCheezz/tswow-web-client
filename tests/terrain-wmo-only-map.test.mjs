import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TerrainClient } from "../dist/code/browser/Terrain.js";
import { streamingHarness } from "./terrain-streaming-harness.mjs";

// 12.10 7.32: the Dungeon Finder put the character in Ragefire Chasm (map 389), a dungeon that is one
// WMO named in its WDT and has no ADT: the server holds no `389*.map`, so every `/terrain/389/x/y` is
// a 404. Each of those raised a red notice with the failure sound, and every cell of the 3×3 ring was
// built anyway — flat at the character's height in the bare terrain green, through the whole cave.
// Wow.exe asks for an ADT only where the WDT's MAIN cell has bit 0x1 (0x007bf8b0, 0x007b5950).

const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
const MAP = 389;
// Where `areatrigger_teleport` 2230 (the Dungeon Finder's way in) puts the character: tile 31/32.
const ARRIVAL = { x: 3.81, y: -14.82, z: -17.84, orientation: 0 };
const settle = async () => {
  for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
};
const tileOf = (url) => new URL(String(url)).pathname.split("/").slice(-2).map(Number);

/** A TrinityCore `.map` tile with one flat height (`MHGT` flag 0x1), as `tests/terrain.test.mjs` builds it. */
function flatTerrainTile(height) {
  const data = new ArrayBuffer(60);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  bytes.set([..."MAPS"].map((c) => c.charCodeAt(0)), 0);
  view.setUint32(4, 10, true);
  view.setUint32(20, 44, true);
  bytes.set([..."MHGT"].map((c) => c.charCodeAt(0)), 44);
  view.setUint32(48, 0x01, true);
  view.setFloat32(52, height, true);
  view.setFloat32(56, height, true);
  return data;
}

async function withFetch(answer, body) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return answer(url);
  };
  try {
    return await body(requests);
  } finally {
    globalThis.fetch = original;
  }
}

/** The renderer's own `#updateTerrain` over a real TerrainClient, for `frames` frames with the network between. */
async function drive(renderer, terrain, frames, player = ARRIVAL) {
  for (let frame = 0; frame < frames; frame++) {
    renderer.updateTerrain(player, MAP, (x, y) => terrain.heightAt(MAP, x, y), terrain, undefined);
    await settle();
  }
}

test("a terrain tile's 404 is status, not an error notice; a gateway failure still is one", async () => {
  await withFetch((url) => new Response(null, { status: tileOf(url)[0] === 31 ? 404 : 500 }), async () => {
    const terrain = new TerrainClient("ws://example.test:1234/world");
    const statuses = [];
    terrain.onStatus = (message, error) => statuses.push({ message, error });
    terrain.isReady(MAP, ARRIVAL.x, ARRIVAL.y);
    terrain.isReady(MAP, -540, ARRIVAL.y);
    await settle();
    assert.deepEqual(statuses.find((status) => /389\/31\/32/.test(status.message)),
      { message: "Terrain tile 389/31/32 не найден", error: false }, "no ADT here is the WDT's answer");
    assert.equal(statuses.find((status) => /returned 500/.test(status.message))?.error, true,
      "a failed request is still reported as one");
    assert.equal(terrain.isReady(MAP, ARRIVAL.x, ARRIVAL.y), true, "and the 404 still releases the curtain");
  });
});

test("a map with no ADT at all builds no ground: not while its tiles are on the wire, not after their 404", async () => {
  await withFetch(() => new Response(null, { status: 404 }), async (requests) => {
    const terrain = new TerrainClient("ws://example.test:1234/world");
    const renderer = streamingHarness(source);
    // The first frame runs before any answer: nothing may stand in for the cave floor meanwhile.
    renderer.updateTerrain(ARRIVAL, MAP, (x, y) => terrain.heightAt(MAP, x, y), terrain, undefined);
    assert.equal(renderer.builds, 0, "no flat plane at the character's height while the tiles are asked for");
    assert.equal(requests.length, 9, "asking is what the visible ring still does");
    await settle();
    await drive(renderer, terrain, 6);
    assert.equal(renderer.builds, 0);
    assert.equal(renderer.terrains.size, 0);
    assert.equal(renderer.scene.children.length, 0, "nothing green under, over or through the dungeon");
    assert.equal(new Set(requests).size, requests.length, "each 404 is final: no tile is asked twice");
    // Walking across the tile line at the origin brings new cells into the ring; they get no ground either.
    await drive(renderer, terrain, 4, { ...ARRIVAL, x: -12 });
    assert.equal(renderer.builds, 0);
    assert.equal(renderer.scene.children.length, 0);
  });
});

test("an ADT-backed tile is built from its own answer, and taken down when a fresh answer has none", async () => {
  let ground = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withFetch(async (url) => {
    const [x, y] = tileOf(url);
    // Only the centre tile exists; it answers when the test says so.
    if (x !== 31 || y !== 32) return new Response(null, { status: 404 });
    await gate;
    return ground ? new Response(flatTerrainTile(-20), { status: 200 }) : new Response(null, { status: 500 });
  }, async () => {
    const terrain = new TerrainClient("ws://example.test:1234/world");
    const renderer = streamingHarness(source);
    await drive(renderer, terrain, 3);
    assert.equal(renderer.builds, 0, "the centre tile is on the wire: a hole, not a plane at -17.84");
    release();
    await drive(renderer, terrain, 3);
    assert.equal(renderer.builds, 1, "built once its own heights are in");
    assert.deepEqual([...renderer.terrains.keys()], ["389/31/32"], "and only the tile that has them");
    const built = renderer.terrains.get("389/31/32");

    // The same ground asked of a client that no longer holds it (a new session's, an eviction): while
    // it is on the wire the mesh stays; when the answer is a failure, the mesh goes.
    ground = false;
    const geometry = built.mesh.geometry;
    const repairs = renderer.repairAdvances;
    const again = new TerrainClient("ws://example.test:1234/world");
    renderer.updateTerrain(ARRIVAL, MAP, (x, y) => again.heightAt(MAP, x, y), again, undefined);
    assert.equal(again.ownRevision(MAP, { x: 31, y: 32 }), 0);
    assert.equal(renderer.terrains.get("389/31/32"), built, "on the wire again: the old ground stays");
    assert.equal(built.mesh.geometry, geometry, "as it was: no repair from heights that are not there");
    assert.equal(renderer.repairAdvances, repairs);
    await settle();
    await drive(renderer, again, 3);
    assert.equal(renderer.terrains.has("389/31/32"), false, "answered with nothing: taken down, never flattened");
    assert.equal(renderer.builds, 1, "and not rebuilt flat");
    assert.equal(renderer.scene.children.length, 0);
  });
});
