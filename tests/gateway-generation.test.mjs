import assert from "node:assert/strict";
import test from "node:test";

import {
  beginGatewayCacheBypass, gatewayCacheGeneration, noteGatewayCacheGeneration, resetGatewayGeneration, withGeneration,
} from "../dist/code/browser/GatewayGeneration.js";
import {
  installPatchChainWatch, readPatchStatus, reloadBypassingCache, resetPatchChainWatch,
} from "../dist/code/browser/PatchChainChanged.js";
import { EnvironmentClient, TerrainClient } from "../dist/code/browser/Terrain.js";
import { VISUAL_TILE_ROUTE_VERSION } from "../dist/code/browser/EnvironmentTileDecode.js"; // 05.10 suite-fix 2
import { IMMUTABLE, LEGACY_TILE_HOUR, REVALIDATE, tileCacheControl } from "../dist/code/gateway/CachePolicy.js";

// 10.12, browser half: tile URLs carry the gateway's `cacheGeneration` once it is known.

const GATEWAY = "http://127.0.0.1:8090";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

test("without a published generation every URL is left exactly as it was", () => {
  resetGatewayGeneration();
  assert.equal(gatewayCacheGeneration(), undefined);
  assert.equal(withGeneration(`${GATEWAY}/terrain/0/31/31`), `${GATEWAY}/terrain/0/31/31`);
  assert.equal(withGeneration(`${GATEWAY}/collision/model/a.wmo?v=3`), `${GATEWAY}/collision/model/a.wmo?v=3`);
});

test("a published generation is appended to the gateway's URLs only, with ? or &", () => {
  resetGatewayGeneration();
  assert.equal(noteGatewayCacheGeneration(`${GATEWAY}/`, "a1b2c3d4e5f6000ff00ba12"), true);
  assert.equal(withGeneration(`${GATEWAY}/terrain/0/31/31`), `${GATEWAY}/terrain/0/31/31?g=a1b2c3d4e5f6000ff00ba12`);
  assert.equal(
    withGeneration(`${GATEWAY}/collision/model/a.wmo?groups=1,2&v=3`),
    `${GATEWAY}/collision/model/a.wmo?groups=1,2&v=3&g=a1b2c3d4e5f6000ff00ba12`,
  );
  assert.equal(withGeneration("http://127.0.0.1:5173/icons/1.png"), "http://127.0.0.1:5173/icons/1.png", "another origin");
  assert.equal(withGeneration("http://127.0.0.1:80901/terrain/0/1/1"), "http://127.0.0.1:80901/terrain/0/1/1", "a longer port is another origin");
  assert.equal(noteGatewayCacheGeneration(GATEWAY, "a1b2c3d4e5f6000ff00ba12"), false, "the same value is no change");
  assert.equal(noteGatewayCacheGeneration(GATEWAY, "bad value/../"), true, "a malformed value clears it");
  assert.equal(withGeneration(`${GATEWAY}/terrain/0/31/31`), `${GATEWAY}/terrain/0/31/31`);
  resetGatewayGeneration();
});

test("the gateway serves the URL a page builds as immutable, and the old generation's URL as revalidated", () => {
  resetGatewayGeneration();
  noteGatewayCacheGeneration(GATEWAY, "n1");
  const before = new URL(withGeneration(`${GATEWAY}/environment/0/31/31`));
  noteGatewayCacheGeneration(GATEWAY, "n2");
  const after = new URL(withGeneration(`${GATEWAY}/environment/0/31/31`));
  assert.notEqual(before.href, after.href, "a new generation is a new cache key");
  assert.equal(tileCacheControl(after.searchParams.get("g"), "n2", LEGACY_TILE_HOUR), IMMUTABLE);
  assert.equal(tileCacheControl(before.searchParams.get("g"), "n2", LEGACY_TILE_HOUR), REVALIDATE);
  resetGatewayGeneration();
});

test("readPatchStatus files cacheGeneration; an older gateway's answer and a 404 leave no g", async () => {
  resetPatchChainWatch();
  const answer = (body) => async () => json(200, body);
  let read = await readPatchStatus(GATEWAY, { summary: true, fetch: answer({ generation: "abcdef0123", stale: false, cacheGeneration: "f00d1" }) });
  assert.equal(read.kind, "ok");
  assert.equal(gatewayCacheGeneration(), "f00d1");
  assert.match(withGeneration(`${GATEWAY}/horizon/0`), /\?g=f00d1$/);

  read = await readPatchStatus(GATEWAY, { summary: true, fetch: answer({ generation: "abcdef0123", stale: false }) });
  assert.equal(read.kind, "ok");
  assert.equal(gatewayCacheGeneration(), undefined, "a gateway without the field: no g");
  assert.equal(withGeneration(`${GATEWAY}/horizon/0`), `${GATEWAY}/horizon/0`);

  await readPatchStatus(GATEWAY, { summary: true, fetch: answer({ generation: "abcdef0123", stale: false, cacheGeneration: "f00d2" }) });
  read = await readPatchStatus(GATEWAY, { summary: true, fetch: async () => new Response("", { status: 404 }) });
  assert.equal(read.kind, "unsupported");
  assert.equal(gatewayCacheGeneration(), undefined);

  await readPatchStatus(GATEWAY, { summary: true, fetch: answer({ generation: "abcdef0123", stale: false, cacheGeneration: "f00d3" }) });
  read = await readPatchStatus(GATEWAY, { summary: true, fetch: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(read.kind, "unreachable");
  assert.equal(gatewayCacheGeneration(), "f00d3", "a gateway that does not answer changes nothing");
  resetPatchChainWatch();
  assert.equal(gatewayCacheGeneration(), undefined, "the test reset also forgets the generation");
});

test("terrain, environment and collision fallbacks request their tiles with g", async () => {
  resetGatewayGeneration();
  noteGatewayCacheGeneration(GATEWAY, "c0ffee");
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(null, { status: 404 });
  };
  try {
    const terrain = new TerrainClient("ws://127.0.0.1:8090/world");
    terrain.heightAt(0, 0, 0);
    const environment = new EnvironmentClient("ws://127.0.0.1:8090/world");
    environment.objectsAround(0, 0, 0, 10);
    environment.model("World\\Missing.m2", "normal");
    await settle();
    environment.dispose();
    const terrainUrl = urls.find((url) => url.includes("/terrain/"));
    assert.equal(terrainUrl, `${GATEWAY}/terrain/0/32/32?g=c0ffee`);
    assert.ok(urls.some((url) => url === `${GATEWAY}/visual/environment/0/32/32?v=${VISUAL_TILE_ROUTE_VERSION}&g=c0ffee`), urls.join("\n"));
    assert.ok(urls.some((url) => url === `${GATEWAY}/environment/model/Missing.m2?g=c0ffee`), "the hull fallback");
    const visualModel = urls.find((url) => url.includes("/visual/model"));
    assert.ok(visualModel && !visualModel.includes("g="), "visual models revalidate by ETag, not by g");
  } finally {
    globalThis.fetch = originalFetch;
    resetGatewayGeneration();
  }
});

/** The browser globals the watch touches: session storage, window.location.reload. */
function withPageGlobals(storage, run) {
  return async () => {
    const saved = { sessionStorage: globalThis.sessionStorage, window: globalThis.window, fetch: globalThis.fetch };
    const reloads = [];
    Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true, writable: true });
    globalThis.window = { location: { reload: () => reloads.push(Date.now()) } };
    resetPatchChainWatch();
    try {
      await run(reloads);
    } finally {
      resetPatchChainWatch();
      globalThis.fetch = saved.fetch;
      if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window;
      Object.defineProperty(globalThis, "sessionStorage", { value: saved.sessionStorage, configurable: true, writable: true });
    }
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("the banner's reload: until the gateway answers, tile URLs carry a token no cache entry can match", withPageGlobals(memoryStorage(), async (reloads) => {
  const storage = globalThis.sessionStorage;
  reloadBypassingCache();
  assert.equal(reloads.length, 1, "the page is reloaded");
  assert.equal(storage.values.size, 1, "and the next page is told why");

  let answer;
  globalThis.fetch = () => new Promise((resolve) => { answer = resolve; });
  installPatchChainWatch(() => GATEWAY);
  assert.equal(storage.values.size, 0, "the flag is taken once");
  const early = new URL(withGeneration(`${GATEWAY}/terrain/0/31/31`));
  assert.match(early.searchParams.get("g") ?? "", /^r[0-9a-z]+$/, "a bypass token before the boot read");
  assert.equal(tileCacheControl(early.searchParams.get("g"), "c1", LEGACY_TILE_HOUR), REVALIDATE,
    "the gateway does not make the token's answer immutable");
  answer(json(200, { generation: "abcdef0123", stale: false, cacheGeneration: "c1" }));
  await settle();
  assert.equal(withGeneration(`${GATEWAY}/terrain/0/31/31`), `${GATEWAY}/terrain/0/31/31?g=c1`, "then the gateway's generation");
}));

test("after the banner's reload an older gateway still gets plain URLs once it has answered", withPageGlobals(memoryStorage(), async () => {
  reloadBypassingCache();
  let answer;
  globalThis.fetch = () => new Promise((resolve) => { answer = resolve; });
  installPatchChainWatch(() => GATEWAY);
  answer(json(200, { generation: "abcdef0123", stale: false }));
  await settle();
  assert.equal(withGeneration(`${GATEWAY}/terrain/0/31/31`), `${GATEWAY}/terrain/0/31/31`);
}));

test("an ordinary page start, or a stale flag, sends no token", withPageGlobals(memoryStorage(), async () => {
  globalThis.sessionStorage.setItem("webclient.patchReloadAt", String(Date.now() - 10 * 60_000));
  globalThis.fetch = () => new Promise(() => {});
  installPatchChainWatch(() => GATEWAY);
  assert.equal(withGeneration(`${GATEWAY}/terrain/0/31/31`), `${GATEWAY}/terrain/0/31/31`);
  assert.equal(globalThis.sessionStorage.values.size, 0, "a stale flag is still cleared");
  beginGatewayCacheBypass(GATEWAY, "bad token!");
  assert.equal(withGeneration(`${GATEWAY}/terrain/0/31/31`), `${GATEWAY}/terrain/0/31/31`, "a malformed token is refused");
}));
