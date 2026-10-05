// 1.24: the light table, the horizon and the terrain splat ask again after a failure (2 s / 8 s /
// 30 s, then give up); a 404 stays final; one request per wait, however often the frame asks.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { LightClient } from "../dist/code/browser/LightClient.js";
import { HorizonClient } from "../dist/code/browser/Horizon.js";
import { TerrainSplatClient } from "../dist/code/browser/TerrainSplat.js";

const GATEWAY = "ws://example.test:1234/world";
const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};
function clock() {
  const time = { now: 10_000 };
  return { time, now: () => time.now };
}
/** Installs a fake fetch answering from `answer(path, call)`; returns the call log and a restore. */
function fakeFetch(answer) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    return answer(path, calls.filter((entry) => entry === path).length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ---- light ----------------------------------------------------------------------------------

function band(times, values) { return { times, values }; }
function lightSet(colour) {
  const colours = {};
  for (const channel of ["diffuse", "ambient", "skyTop", "skyUpper", "skyMiddle", "skyLower",
    "skyHorizon", "fog", "oceanClose", "oceanFar", "riverClose", "riverFar"]) colours[channel] = band([0], [colour]);
  return { colours, fogEnd: band([0], [700]), fogScale: band([0], [0.25]) };
}
const LIGHT_TABLE = { fallback: 1, params: { 1: lightSet(0x336699) }, volumes: [] };
const lightPaths = (calls) => calls.filter((path) => path === "/dbc/light/0").length;

test("1.24 light: a 500 is asked again after 2 s and the zone's light then shows", async () => {
  const { time, now } = clock();
  const fetch = fakeFetch((_path, call) => call === 1
    ? new Response("boom", { status: 500 })
    : new Response(JSON.stringify(LIGHT_TABLE), { status: 200 }));
  try {
    const client = new LightClient(GATEWAY, now);
    assert.equal(client.sample(0, 0, 0, 720), undefined);
    await settle();
    assert.equal(lightPaths(fetch.calls), 1);
    for (let frame = 0; frame < 50; frame++) assert.equal(client.sample(0, 0, 0, 720), undefined);
    assert.equal(lightPaths(fetch.calls), 1, "no request while the wait runs, however often the frame asks");
    assert.equal(client.stats.error, 1, "a map waiting for its retry is a current failure");
    time.now += 2_000;
    assert.equal(client.sample(0, 0, 0, 720), undefined);
    assert.equal(client.sample(0, 0, 0, 720), undefined, "one request in flight, not one per frame");
    await settle();
    assert.equal(lightPaths(fetch.calls), 2);
    const sample = client.sample(0, 0, 0, 720);
    assert.ok(sample, "the second answer is used");
    assert.equal(sample.fogEnd, 700);
    assert.equal(client.stats.error, 0);
  } finally {
    fetch.restore();
  }
});

test("1.24 light: a 404, a junk body and a non-table body are final", async () => {
  for (const response of [
    () => new Response("no", { status: 404 }),
    () => new Response("{not json", { status: 200 }),
    () => new Response(JSON.stringify({ volumes: "x" }), { status: 200 }),
  ]) {
    const { time, now } = clock();
    const fetch = fakeFetch(() => response());
    try {
      const client = new LightClient(GATEWAY, now);
      client.sample(0, 0, 0, 720);
      await settle();
      time.now += 1e9;
      client.sample(0, 0, 0, 720);
      await settle();
      assert.equal(lightPaths(fetch.calls), 1);
      assert.equal(client.stats.error, 1);
    } finally {
      fetch.restore();
    }
  }
});

test("1.24 light: four failures exhaust the ladder (2 s, 8 s, 30 s), the fifth is never sent", async () => {
  const { time, now } = clock();
  const fetch = fakeFetch(() => new Response("boom", { status: 503 }));
  try {
    const client = new LightClient(GATEWAY, now);
    client.sample(0, 0, 0, 720);
    await settle();
    for (const wait of [2_000, 8_000, 30_000]) {
      time.now += wait - 1;
      client.sample(0, 0, 0, 720);
      await settle();
      time.now += 1;
      client.sample(0, 0, 0, 720);
      await settle();
    }
    assert.equal(lightPaths(fetch.calls), 4);
    time.now += 1e9;
    client.sample(0, 0, 0, 720);
    await settle();
    assert.equal(lightPaths(fetch.calls), 4);
    assert.equal(client.stats.error, 1);
  } finally {
    fetch.restore();
  }
});

// ---- horizon ---------------------------------------------------------------------------------

function emptyWdl() {
  const data = new ArrayBuffer(8 + 4 + 8 + 4096 * 4);
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  const tag = (offset, value) => [...value].reverse().forEach((letter, index) => { bytes[offset + index] = letter.charCodeAt(0); });
  tag(0, "MVER");
  view.setUint32(4, 4, true);
  view.setUint32(8, 18, true);
  tag(12, "MAOF");
  view.setUint32(16, 4096 * 4, true);
  return data;
}
const horizonPaths = (calls) => calls.filter((path) => path === "/horizon/0").length;

test("1.24 horizon: a 500 is asked again after 2 s; a 404 and an undecodable file are final", async () => {
  {
    const { time, now } = clock();
    const fetch = fakeFetch((_path, call) => call === 1
      ? new Response("boom", { status: 500 })
      : new Response(emptyWdl(), { status: 200 }));
    try {
      const client = new HorizonClient(GATEWAY, now);
      assert.equal(client.get(0), undefined);
      await settle();
      for (let frame = 0; frame < 20; frame++) client.get(0);
      assert.equal(horizonPaths(fetch.calls), 1);
      assert.equal(client.stats.error, 1);
      time.now += 2_000;
      client.get(0);
      client.get(0);
      await settle();
      assert.equal(horizonPaths(fetch.calls), 2);
      assert.equal(client.get(0)?.tiles.size, 0, "the second answer is the map's horizon");
      assert.equal(client.stats.error, 0);
    } finally {
      fetch.restore();
    }
  }
  for (const response of [() => new Response("no", { status: 404 }), () => new Response(new ArrayBuffer(16), { status: 200 })]) {
    const { time, now } = clock();
    const fetch = fakeFetch(() => response());
    try {
      const client = new HorizonClient(GATEWAY, now);
      client.get(0);
      await settle();
      time.now += 1e9;
      client.get(0);
      await settle();
      assert.equal(horizonPaths(fetch.calls), 1);
    } finally {
      fetch.restore();
    }
  }
});

// ---- terrain splat ---------------------------------------------------------------------------

function installSplatMocks() {
  const originalLoad = THREE.TextureLoader.prototype.load;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.OffscreenCanvas = class {
    getContext() {
      return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(256 * 256 * 4) }) };
    }
  };
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    const texture = new THREE.Texture();
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  };
  return () => {
    THREE.TextureLoader.prototype.load = originalLoad;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
  };
}
const splatBody = () => new Response(JSON.stringify({ layers: ["a".repeat(40)], mccv: false }), { status: 200 });
const splatPaths = (calls) => calls.filter((path) => path === "/terrain-splat/1/32/32").length;

test("1.24 splat: a 500 is asked again after 2 s and the tile then paints", async () => {
  const { time, now } = clock();
  const restore = installSplatMocks();
  const fetch = fakeFetch((path, call) => path === "/terrain-splat/1/32/32" && call === 1
    ? new Response("boom", { status: 500 })
    : path.startsWith("/terrain-splat/") && !path.endsWith(".png") ? splatBody()
    : new Response(new Blob([new Uint8Array([1])]), { status: 200 }));
  try {
    const client = new TerrainSplatClient(GATEWAY, now);
    const grid = { x: 32, y: 32 };
    client.setActiveTiles(1, [grid]);
    assert.equal(client.get(1, grid), undefined);
    await settle();
    for (let frame = 0; frame < 20; frame++) assert.equal(client.get(1, grid), undefined);
    assert.equal(splatPaths(fetch.calls), 1, "no request while the wait runs");
    assert.equal(client.stats.failed, 1);
    time.now += 2_000;
    client.get(1, grid);
    client.get(1, grid);
    await settle();
    assert.equal(splatPaths(fetch.calls), 2, "one retry, not one per frame");
    assert.ok(client.get(1, grid), "the second answer is the tile's splat");
    assert.equal(client.stats.failed, 0);
    client.dispose();
  } finally {
    fetch.restore();
    restore();
  }
});

test("1.24 splat: leaving the active set forgets the ladder; a 404 stays final", async () => {
  const { now } = clock();
  const restore = installSplatMocks();
  const fetch = fakeFetch((path) => path === "/terrain-splat/1/32/32"
    ? new Response("boom", { status: 502 })
    : path === "/terrain-splat/1/33/32" ? new Response("none", { status: 404 })
    : new Response(new Blob([new Uint8Array([1])]), { status: 200 }));
  try {
    const client = new TerrainSplatClient(GATEWAY, now);
    const grid = { x: 32, y: 32 };
    const stub = { x: 33, y: 32 };
    client.setActiveTiles(1, [grid, stub]);
    client.get(1, grid);
    client.get(1, stub);
    await settle();
    client.get(1, grid);
    assert.equal(splatPaths(fetch.calls), 1);
    client.setActiveTiles(1, [stub]);
    client.setActiveTiles(1, [grid, stub]);
    client.get(1, grid);
    await settle();
    assert.equal(splatPaths(fetch.calls), 2, "a tile that left and came back starts a new ladder");
    client.get(1, stub);
    await settle();
    assert.equal(fetch.calls.filter((path) => path === "/terrain-splat/1/33/32").length, 1, "404 is never asked again");
    client.dispose();
  } finally {
    fetch.restore();
    restore();
  }
});
