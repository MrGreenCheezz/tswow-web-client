// 05.10-A7b-9 (7.18): what the environment client knows about one model, without asking for it,
// and what the tiles under the player could not carry.
import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentClient, TERRAIN_GRID_SIZE } from "../dist/code/browser/Terrain.js";
import { IMAGE_RETRY_BACKOFF_MS } from "../dist/code/browser/CharacterAtlas.js";

const settle = async () => {
  for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setImmediate(resolve));
};
const visual = () => {
  const data = new ArrayBuffer(16);
  new Uint8Array(data).set([0x57, 0x56, 0x4d, 0x31]);
  return { ok: true, status: 200, arrayBuffer: async () => data };
};
const hull = () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
const status = (code) => ({ ok: false, status: code, arrayBuffer: async () => new ArrayBuffer(0) });

/** A gateway that answers each model by its basename's prefix. */
function gateway(t, now = () => 0) {
  const calls = [];
  const pending = [];
  t.mock.method(globalThis, "fetch", (url) => {
    const parsed = new URL(String(url));
    const path = parsed.searchParams.get("path") ?? decodeURIComponent(parsed.pathname.split("/").at(-1));
    calls.push(parsed.pathname);
    const base = path.replaceAll("\\", "/").split("/").at(-1);
    const fallback = parsed.pathname.startsWith("/environment/model/");
    if (base.startsWith("Slow")) return new Promise((resolve) => pending.push(resolve));
    if (base.startsWith("Real")) return Promise.resolve(visual());
    if (base.startsWith("Shell")) return Promise.resolve(fallback ? hull() : status(404));
    if (base.startsWith("Gone")) return Promise.resolve(status(404));
    return Promise.resolve(status(500));
  });
  const client = new EnvironmentClient("ws://example.test/world", now);
  t.after(async () => {
    client.dispose();
    for (const resolve of pending) resolve(visual());
    await settle();
  });
  return { client, calls };
}

test("modelState tells the four outcomes apart, and asking it requests nothing", async (t) => {
  const { client, calls } = gateway(t);
  assert.equal(client.modelState("World\\Never.m2"), "pending", "nothing says it never will be");
  assert.equal(calls.length, 0, "modelState is a read, not a demand");
  for (const name of ["World\\Slow.m2", "World\\Real.m2", "World\\Shell.wmo", "World\\Gone.m2"]) client.model(name);
  await settle();
  assert.equal(client.modelState("World\\Slow.m2"), "pending");
  assert.equal(client.modelState("World\\Real.m2"), "resident");
  assert.equal(client.modelState("World\\Shell.wmo"), "hull", "a collision hull is not the building");
  assert.equal(client.modelState("World\\Gone.m2"), "missing", "a 404 is not a model on its way");
  const before = calls.length;
  for (let frame = 0; frame < 5; frame++) client.modelState("World\\Gone.m2");
  assert.equal(calls.length, before);
});

test("a model whose retries ran out is failed; one waiting for its retry is still pending", async (t) => {
  let clock = 0;
  const { client } = gateway(t, () => clock);
  client.model("World\\Broken.m2");
  await settle();
  assert.equal(client.modelState("World\\Broken.m2"), "pending", "a 500 is a fact about this second");
  for (const wait of IMAGE_RETRY_BACKOFF_MS) {
    clock += wait;
    client.model("World\\Broken.m2");
    await settle();
  }
  assert.equal(client.modelState("World\\Broken.m2"), "failed");
});

test("tileLosses sums what the tiles under the player could not carry", async (t) => {
  const centre = (grid) => (31.5 - grid) * TERRAIN_GRID_SIZE;
  const good = { id: 1, kind: "m2", name: "World\\Tree.m2", x: centre(32), y: centre(32), z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  const bad = { id: 2, kind: "m2", name: 7 };
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = new URL(String(url)).pathname;
    const loaded = path.endsWith("/7/32/32");
    return new Response(JSON.stringify(loaded ? [good, bad] : []), {
      status: 200,
      headers: loaded ? { "content-type": "application/json", "x-tile-truncated": "3" } : { "content-type": "application/json" },
    });
  });
  const client = new EnvironmentClient("ws://example.test/world");
  t.after(() => client.dispose());
  assert.deepEqual(client.tileLosses(), { rejected: 0, truncated: 0, generator: 0 });
  client.objectsAround(7, centre(32), centre(32));
  await settle();
  assert.deepEqual(client.tileLosses(), { rejected: 1, truncated: 0, generator: 3 });
  // The player left: the losses of a tile nobody stands on are not this scene's.
  client.objectsAround(1, centre(32), centre(32));
  assert.deepEqual(client.tileLosses(), { rejected: 0, truncated: 0, generator: 0 });
});
