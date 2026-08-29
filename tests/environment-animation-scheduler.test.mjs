import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ENVIRONMENT_ANIMATION_LOAD_CONCURRENCY,
  ENVIRONMENT_ANIMATION_QUEUE_LIMIT,
  EnvironmentClient,
} from "../dist/code/browser/Terrain.js";

const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function emptyModel() {
  const data = new ArrayBuffer(16);
  new Uint8Array(data).set([0x57, 0x56, 0x4d, 0x31]);
  return data;
}

function emptyAnimations(bones = 1) {
  const data = new ArrayBuffer(12);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  bytes.set([0x57, 0x56, 0x41, 0x31]);
  view.setUint32(4, data.byteLength, true);
  view.setUint16(8, bones, true);
  return data;
}

function animationPath(url) {
  return new URL(String(url)).searchParams.get("path");
}

test("animation scheduler exports conservative caps and starts priority work with exact-key dedupe", async () => {
  assert.equal(ENVIRONMENT_ANIMATION_LOAD_CONCURRENCY, 2);
  assert.equal(ENVIRONMENT_ANIMATION_QUEUE_LIMIT, 256);
  const originalFetch = globalThis.fetch;
  const requests = [];
  const releases = [];
  globalThis.fetch = (url) => {
    requests.push(animationPath(url));
    return new Promise((resolve) => releases.push(resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.animations("A.m2", 1, "background");
    client.animations("a.M2", 1, "background");
    client.animations("B.m2", 1, "background");
    client.animations("Critical.m2", 1, "critical");
    client.animations("Critical.m2", 1, "critical");
    await settle(2);
    assert.deepEqual(requests, ["Critical.m2", "A.m2"]);
    assert.equal(client.stats.activeAnimations, 2);
    assert.equal(client.stats.queuedAnimations, 1);
    for (const release of releases) {
      release({ ok: true, status: 200, arrayBuffer: async () => emptyAnimations() });
    }
    await settle();
    client.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("animation queue cap admits urgent work, cancels inactive queued work, and rearms it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const capped = new EnvironmentClient("ws://example.test/world");
    for (let index = 0; index < ENVIRONMENT_ANIMATION_QUEUE_LIMIT; index++) {
      capped.animations(`Background${index}.m2`, 1, "background");
    }
    capped.animations("Critical.m2", 1, "critical");
    assert.equal(capped.stats.queuedAnimations, ENVIRONMENT_ANIMATION_QUEUE_LIMIT);
    capped.dispose();

    const client = new EnvironmentClient("ws://example.test/world");
    client.animations("LaneA.m2", 1, "critical");
    client.animations("LaneB.m2", 1, "critical");
    await settle(2);
    client.animations("Queued.m2", 1, "normal");
    await settle(2);
    assert.equal(client.stats.queuedAnimations, 1);
    client.beginResourceFrame();
    client.endResourceFrame();
    assert.equal(client.stats.queuedAnimations, 0);
    client.beginResourceFrame();
    client.animations("Queued.m2", 1, "normal");
    client.endResourceFrame();
    assert.equal(client.stats.queuedAnimations, 1);
    client.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inflight animation work coalesces and a late inactive result cannot displace an active rig", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url) => new Promise((resolve) => requests.push({ name: animationPath(url), resolve }));
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 256, 1);
    client.beginResourceFrame();
    client.animations("Old.m2", 1, "critical");
    client.animations("Old.m2", 1, "critical");
    client.endResourceFrame();
    await settle(2);
    assert.equal(requests.filter(({ name }) => name === "Old.m2").length, 1);

    client.beginResourceFrame();
    client.animations("Current.m2", 1, "critical");
    client.endResourceFrame();
    await settle(2);
    requests.find(({ name }) => name === "Current.m2").resolve({
      ok: true, status: 200, arrayBuffer: async () => emptyAnimations(),
    });
    await settle();
    requests.find(({ name }) => name === "Old.m2").resolve({
      ok: true, status: 200, arrayBuffer: async () => emptyAnimations(),
    });
    await settle();
    assert.equal(client.stats.residentAnimations, 1);

    client.beginResourceFrame();
    client.animations("Old.m2", 1, "critical");
    client.endResourceFrame();
    await settle(2);
    assert.equal(requests.filter(({ name }) => name === "Old.m2").length, 2);
    client.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("animation transient retries use exact 2s, 8s, and 30s demand deadlines", async () => {
  const originalFetch = globalThis.fetch;
  let now = 0;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: false, status: 500 };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", () => now);
    client.animations("Retry.m2", 1);
    await settle();
    assert.equal(requests, 1);
    assert.equal(client.stats.deferredAnimations, 1);
    now = 1_999;
    client.animations("Retry.m2", 1);
    await settle(2);
    assert.equal(requests, 1);
    for (const deadline of [2_000, 10_000, 40_000]) {
      now = deadline;
      client.animations("Retry.m2", 1);
      await settle();
    }
    assert.equal(requests, 4);
    assert.equal(client.stats.deferredAnimations, 0);
    assert.equal(client.stats.failedAnimations, 1);
    client.animations("Retry.m2", 1);
    await settle(2);
    assert.equal(requests, 4);
    client.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("animation terminal HTTP outcomes and rig mismatch are isolated by path plus bones", async () => {
  const originalFetch = globalThis.fetch;
  const counts = new Map();
  globalThis.fetch = async (url) => {
    const name = animationPath(url);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (name === "Missing.m2") return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => emptyAnimations(2) };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.animations("Missing.m2", 1);
    client.animations("Shared.m2", 1);
    client.animations("Shared.m2", 2);
    await settle();
    assert.equal(client.stats.failedAnimations, 2);
    assert.equal(client.stats.residentAnimations, 1);
    client.animations("Missing.m2", 1);
    client.animations("Shared.m2", 1);
    client.animations("Shared.m2", 2);
    await settle(2);
    assert.equal(counts.get("Missing.m2"), 1);
    assert.equal(counts.get("Shared.m2"), 2);
    client.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terminal animation failures block only the committed current footprint and re-entry uses the cached null", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: false, status: 404 };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.beginResourceFrame();
    client.animations("Terminal.m2", 1, "critical");
    client.endResourceFrame();
    await settle();
    assert.equal(requests, 1);
    assert.equal(client.stats.failedAnimations, 1);

    // A newly committed empty footprint must not inherit the previous scene's terminal null as a
    // readiness blocker. The null remains in the bounded cache for a cheap re-entry.
    client.beginResourceFrame();
    client.endResourceFrame();
    assert.equal(client.stats.failedAnimations, 0);

    client.beginResourceFrame();
    client.animations("Terminal.m2", 1, "critical");
    client.endResourceFrame();
    await settle();
    assert.equal(requests, 1, "re-entry should use the terminal cache entry without another fetch");
    assert.equal(client.stats.failedAnimations, 1);
    client.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an HD animation response above the stock 8 MiB ceiling is admitted", async () => {
  const originalFetch = globalThis.fetch;
  const statuses = [];
  globalThis.fetch = async () => new Response(emptyAnimations(), {
    status: 200,
    headers: { "content-length": "10294856" },
  });
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.onStatus = (message, error) => statuses.push({ message, error });
    client.animations("HD-character.m2", 1);
    await settle();
    assert.deepEqual(statuses, []);
    assert.equal(client.stats.residentAnimations, 1);
    assert.equal(client.stats.failedAnimations, 0);
    client.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed animation response retries with cache reload and failure ledgers stay bounded", async () => {
  const originalFetch = globalThis.fetch;
  let now = 0;
  const cacheModes = [];
  let decodeRequests = 0;
  globalThis.fetch = async (url, init = {}) => {
    const name = animationPath(url);
    if (name === "Decode.m2") {
      cacheModes.push(init.cache);
      decodeRequests++;
      return {
        ok: true,
        status: 200,
        ...(decodeRequests === 2
          ? { ok: false, status: 500 }
          : { ok: true, status: 200, arrayBuffer: async () => decodeRequests === 1 ? new ArrayBuffer(4) : emptyAnimations() }),
      };
    }
    return { ok: false, status: 500 };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", () => now, 64, 256, 2);
    client.animations("Decode.m2", 1);
    await settle();
    now = 2_000;
    client.animations("Decode.m2", 1);
    await settle();
    now = 10_000;
    client.animations("Decode.m2", 1);
    await settle();
    assert.deepEqual(cacheModes, [undefined, "reload", "reload"]);
    assert.equal(client.stats.residentAnimations, 1);

    for (let index = 0; index < 8; index++) client.animations(`Failure${index}.m2`, 1);
    await settle(20);
    assert.equal(client.stats.activeAnimations, 0);
    assert.equal(client.stats.queuedAnimations, 0);
    assert.ok(client.stats.deferredAnimations <= 2);
    client.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("open-frame animation failure pruning protects prior and current rig demands", async () => {
  const originalFetch = globalThis.fetch;
  let now = 0;
  const requests = [];
  const releases = [];
  globalThis.fetch = (url) => {
    const name = animationPath(url);
    requests.push(name);
    if (requests.length === 1) return Promise.resolve({ ok: false, status: 500 });
    return new Promise((resolve) => releases.push(resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", () => now, 64, 256, 1);
    client.beginResourceFrame();
    client.animations("RigA.m2", 1, "critical");
    client.endResourceFrame();
    await settle();
    assert.equal(requests.length, 1);

    now = 2_000;
    client.animations("RigA.m2", 1, "critical");
    await settle(2);
    client.beginResourceFrame();
    client.animations("RigA.m2", 1, "critical");
    client.animations("RigB.m2", 1, "critical");
    await settle(2);
    assert.deepEqual(requests, ["RigA.m2", "RigA.m2", "RigB.m2"]);

    for (const release of releases) release({ ok: false, status: 500 });
    await settle();
    client.endResourceFrame();
    client.animations("RigA.m2", 1, "critical");
    client.animations("RigB.m2", 1, "critical");
    await settle(2);
    assert.equal(requests.length, 3, "repeating both failed rigs before their 2s deadlines does not refetch");
    client.dispose();
  } finally {
    for (const release of releases) release({ ok: false, status: 500 });
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("dispose aborts every owned request and ignores late tile, model, and animation settlement", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = (url, init = {}) => new Promise((resolve) => {
    requests.push({ url: String(url), signal: init.signal, resolve });
  });
  try {
    const statuses = [];
    const client = new EnvironmentClient("ws://example.test/world");
    client.onStatus = (...args) => statuses.push(args);
    client.objectsAround(0, 0, 0, 0);
    client.model("Late.m2", "critical");
    client.animations("Late.m2", 1, "critical");
    await settle(2);
    assert.ok(requests.length >= 3);
    client.dispose();
    assert.ok(requests.every(({ signal }) => signal?.aborted === true));
    for (const request of requests) {
      if (request.url.includes("/visual/environment/")) {
        request.resolve({ ok: true, status: 200, json: async () => [] });
      } else if (request.url.includes("/visual/animations")) {
        request.resolve({ ok: true, status: 200, arrayBuffer: async () => emptyAnimations() });
      } else {
        request.resolve({ ok: true, status: 200, arrayBuffer: async () => emptyModel() });
      }
    }
    await settle();
    assert.deepEqual(statuses, []);
    assert.deepEqual(client.stats, {
      residentTiles: 0, knownMissingTiles: 0, failedTiles: 0, activeTiles: 0, residentObjects: 0,
      residentModels: 0, knownMissingModels: 0, deferredModels: 0, failedModels: 0,
      queuedModels: 0, activeModels: 0, queuedGroups: 0, activeGroups: 0,
      deferredGroups: 0, failedGroups: 0, residentAnimations: 0, failedAnimations: 0,
      deferredAnimations: 0, queuedAnimations: 0, activeAnimations: 0,
      modelDecodedTypedBackingBytes: 0, modelDecodedNumericArrayElements: 0,
      modelDecodedTypedBackingOverflowBytes: 0, modelDecodedNumericArrayOverflowElements: 0,
      animationDecodedTypedBackingBytes: 0, animationDecodedNumericArrayElements: 0,
      animationDecodedTypedBackingOverflowBytes: 0,
    });
    const before = requests.length;
    client.objectsAround(0, 0, 0, 0);
    client.model("Never.m2");
    client.animations("Never.m2", 1);
    await settle(2);
    assert.equal(requests.length, before);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const source = await readFile(new URL("../src/browser/game/Context.ts", import.meta.url), "utf8");
  assert.ok(source.indexOf("game.environment?.dispose();") < source.indexOf("game.environment = undefined;"));
});
