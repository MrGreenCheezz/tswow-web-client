import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ENVIRONMENT_ANIMATION_CACHE_LIMIT,
  ENVIRONMENT_MODEL_CACHE_LIMIT,
  ENVIRONMENT_MODEL_QUEUE_LIMIT,
  ENVIRONMENT_MODEL_GROUP_QUEUE_LIMIT,
  EnvironmentClient,
} from "../dist/code/browser/Terrain.js";

const settle = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function emptyModel() {
  const data = new ArrayBuffer(16);
  const bytes = new Uint8Array(data);
  bytes.set([0x57, 0x56, 0x4d, 0x31]);
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

function wmoHeader(groupCount = 1) {
  const data = new ArrayBuffer(24 + groupCount * 40);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  bytes.set([0x57, 0x57, 0x4d, 0x31]);
  view.setUint32(4, groupCount, true);
  view.setUint32(16, data.byteLength, true);
  for (let group = 0; group < groupCount; group++) {
    const offset = 24 + group * 40;
    view.setFloat32(offset, -1, true);
    view.setFloat32(offset + 4, -1, true);
    view.setFloat32(offset + 8, -1, true);
    view.setFloat32(offset + 12, 1, true);
    view.setFloat32(offset + 16, 1, true);
    view.setFloat32(offset + 20, 1, true);
    view.setUint32(offset + 28, 1, true);
  }
  return data;
}

function wmoGroup(x, index = 0) {
  const data = new ArrayBuffer(40);
  const view = new DataView(data);
  view.setUint32(0, 1, true);
  view.setUint8(10, 2);
  view.setUint16(12, index, true);
  view.setFloat32(16, x, true);
  return data;
}

function modelPath(url) {
  return new URL(String(url)).searchParams.get("path");
}

test("EnvironmentClient exports and validates conservative decoded-resource entry caps", () => {
  assert.equal(ENVIRONMENT_MODEL_CACHE_LIMIT, 256);
  assert.equal(ENVIRONMENT_ANIMATION_CACHE_LIMIT, 128);
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new EnvironmentClient("ws://example.test/world", Date.now, 64, limit, 1),
      RangeError,
    );
    assert.throws(
      () => new EnvironmentClient("ws://example.test/world", Date.now, 64, 1, limit),
      RangeError,
    );
  }
});

test("EnvironmentClient model LRU touches hits and refetches an evicted positive entry", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(modelPath(url));
    return { ok: true, status: 200, arrayBuffer: async () => emptyModel() };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 2, 2);
    for (const name of ["A.m2", "B.m2"]) {
      client.beginResourceFrame();
      client.model(name, "critical");
      client.endResourceFrame();
      await settle();
    }

    client.beginResourceFrame();
    assert.ok(client.model("A.m2"), "a cache hit is available and becomes most recently used");
    client.model("C.m2", "critical");
    client.endResourceFrame();
    await settle();
    assert.equal(client.stats.residentModels, 2);

    client.beginResourceFrame();
    client.model("B.m2", "critical");
    client.endResourceFrame();
    await settle();
    assert.equal(requests.filter((name) => name === "B.m2").length, 2,
      "the evicted terminal entry re-arms its request ownership");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient LRU-touches null hits and refetches the evicted known-missing entry", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(null, { status: 404 });
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 2, 1);
    for (const name of ["AbsentA.m2", "AbsentB.m2"]) {
      client.beginResourceFrame();
      client.model(name, "critical");
      client.endResourceFrame();
      await settle();
    }
    client.beginResourceFrame();
    assert.equal(client.model("AbsentA.m2", "critical"), undefined,
      "a terminal null hit is still the degraded undefined answer");
    client.model("AbsentC.m2", "critical");
    client.endResourceFrame();
    await settle();

    client.beginResourceFrame();
    client.model("AbsentB.m2", "critical");
    client.endResourceFrame();
    await settle();
    assert.equal(requests.filter((url) => url.includes("path=AbsentB.m2")).length, 2,
      "both visual attempts are made after null re-entry");
    assert.equal(requests.filter((url) => url.includes("/environment/model/AbsentB.m2")).length, 2,
      "both terminal fallback checks are made after null re-entry");
    assert.equal(requests.filter((url) => url.includes("path=AbsentA.m2")).length, 1,
      "touching a terminal null makes it more recent than the evicted entry");
    assert.equal(client.stats.knownMissingModels, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient keeps an active model footprint above its cap until a later empty frame", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => emptyModel() });
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 1, 1);
    client.beginResourceFrame();
    client.model("A.m2", "critical");
    client.model("B.m2", "critical");
    client.endResourceFrame();
    await settle();
    assert.equal(client.stats.residentModels, 2, "the exact active set is retained even above the cap");

    client.beginResourceFrame();
    client.endResourceFrame();
    assert.equal(client.stats.residentModels, 1, "an empty frame releases the previous pins atomically");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a late inactive model result cannot displace the current active pin", async () => {
  const originalFetch = globalThis.fetch;
  const releases = new Map();
  const requests = [];
  globalThis.fetch = (url) => {
    const name = modelPath(url);
    requests.push(name);
    return new Promise((resolve) => releases.set(name, resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 1, 1);
    client.beginResourceFrame();
    client.model("Old.m2", "critical");
    client.endResourceFrame();
    await settle(1);

    client.beginResourceFrame();
    client.model("Current.m2", "critical");
    client.endResourceFrame();
    await settle(1);

    releases.get("Current.m2")({ ok: true, status: 200, arrayBuffer: async () => emptyModel() });
    await settle();
    releases.get("Old.m2")({ ok: true, status: 200, arrayBuffer: async () => emptyModel() });
    await settle();
    assert.equal(client.stats.residentModels, 1);
    assert.ok(client.model("Current.m2"), "the current pin survives an older settlement");

    client.beginResourceFrame();
    client.model("Old.m2", "critical");
    client.endResourceFrame();
    await settle(1);
    assert.equal(requests.filter((name) => name === "Old.m2").length, 2,
      "the late inactive entry was evicted and can be requested again");
  } finally {
    for (const release of releases.values()) {
      release({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    }
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("WMO group work is bound to the exact parent model across eviction and reload", async () => {
  const originalFetch = globalThis.fetch;
  const groupReleases = [];
  let baseRequests = 0;
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (address.searchParams.has("group")) {
      return new Promise((resolve) => groupReleases.push(resolve));
    }
    baseRequests++;
    return { ok: true, status: 200, arrayBuffer: async () => wmoHeader() };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 1, 1);
    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    client.endResourceFrame();
    await settle();
    const oldModel = client.model("City.wmo");
    assert.ok(oldModel?.wmo);
    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    client.requestModelGroups("City.wmo", [0]);
    client.endResourceFrame();
    assert.equal(groupReleases.length, 1);
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [0, 1]);

    client.beginResourceFrame();
    client.model("Other.wmo", "critical");
    client.endResourceFrame();
    await settle();
    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    client.endResourceFrame();
    await settle();
    const replacement = client.model("City.wmo");
    assert.ok(replacement?.wmo);
    assert.notStrictEqual(replacement, oldModel);
    assert.equal(baseRequests, 3);

    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    client.requestModelGroups("City.wmo", [0]);
    client.endResourceFrame();
    assert.equal(groupReleases.length, 2, "the replacement identity gets its own group request");
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [0, 2]);
    groupReleases[1]({ ok: true, status: 200, arrayBuffer: async () => wmoGroup(22) });
    await settle();
    assert.equal(replacement.wmo.groups[0].mesh.positions[0], 22);

    groupReleases[0]({ ok: true, status: 200, arrayBuffer: async () => wmoGroup(11) });
    await settle();
    assert.equal(oldModel.wmo.groups[0].mesh.positions[0], 11,
      "the old job may finish only into the old renderer-held identity");
    assert.equal(replacement.wmo.groups[0].mesh.positions[0], 22,
      "stale completion cannot corrupt the replacement");
  } finally {
    for (const release of groupReleases) {
      release({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    }
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("evicting a WMO parent releases queued groups while active I/O keeps its exact parent", async () => {
  const originalFetch = globalThis.fetch;
  const groupRequests = [];
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (address.searchParams.has("group")) {
      return new Promise((resolve) => groupRequests.push({
        name: address.searchParams.get("path"),
        group: Number(address.searchParams.get("group")),
        resolve,
      }));
    }
    return { ok: true, status: 200, arrayBuffer: async () => wmoHeader(6) };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 1, 1);
    client.beginResourceFrame();
    client.model("Old.wmo", "critical");
    client.endResourceFrame();
    await settle();
    const oldModel = client.model("Old.wmo");
    assert.ok(oldModel?.wmo);
    client.beginResourceFrame();
    client.model("Old.wmo", "critical");
    client.requestModelGroups("Old.wmo", [0, 1, 2, 3, 4, 5]);
    client.endResourceFrame();
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [2, 4]);

    client.beginResourceFrame();
    client.model("Other.wmo", "critical");
    client.endResourceFrame();
    await settle();
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [0, 4],
      "eviction removes queued old-parent jobs while the four in-flight requests remain visible");

    client.beginResourceFrame();
    client.model("Old.wmo", "critical");
    client.endResourceFrame();
    await settle();
    const replacement = client.model("Old.wmo");
    assert.ok(replacement?.wmo);
    client.beginResourceFrame();
    client.model("Old.wmo", "critical");
    client.requestModelGroups("Old.wmo", [4, 5]);
    client.endResourceFrame();
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [2, 4],
      "the replacement can requeue the groups released with the old identity");

    for (const request of groupRequests) request.resolve({
      ok: true,
      status: 200,
      arrayBuffer: async () => wmoGroup(request.group + 1, request.group),
    });
    await settle(8);
  } finally {
    for (const request of groupRequests) request.resolve({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("a failed group request from an evicted WMO identity does not leak readiness state", async () => {
  const originalFetch = globalThis.fetch;
  let releaseGroup;
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (address.searchParams.has("group")) return new Promise((resolve) => { releaseGroup = resolve; });
    return { ok: true, status: 200, arrayBuffer: async () => wmoHeader() };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 1, 1);
    client.beginResourceFrame();
    client.model("Old.wmo", "critical");
    client.endResourceFrame();
    await settle();
    client.requestModelGroups("Old.wmo", [0]);
    client.beginResourceFrame();
    client.model("Current.wmo", "critical");
    client.endResourceFrame();
    await settle();
    releaseGroup({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
    await settle();
    assert.deepEqual([client.stats.deferredGroups, client.stats.failedGroups], [0, 0]);
  } finally {
    releaseGroup?.({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("an empty committed frame cancels queued WMO groups while old active work may settle", async () => {
  const originalFetch = globalThis.fetch;
  const groupRequests = [];
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (address.searchParams.has("group")) {
      return new Promise((resolve) => groupRequests.push(resolve));
    }
    return { ok: true, status: 200, arrayBuffer: async () => wmoHeader(6) };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.beginResourceFrame();
    client.model("Old.wmo", "critical");
    client.endResourceFrame();
    await settle();
    assert.ok(client.model("Old.wmo")?.wmo);
    client.beginResourceFrame();
    client.model("Old.wmo", "critical");
    client.requestModelGroups("Old.wmo", [0, 1, 2, 3, 4, 5]);
    client.endResourceFrame();
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [2, 4]);

    client.beginResourceFrame();
    client.endResourceFrame();
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [0, 4],
      "the empty footprint drops queued groups while old active requests remain visible");

    for (const release of groupRequests) release({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
    await settle();
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups, client.stats.deferredGroups], [0, 0, 0],
      "old active settlement cannot block the committed empty footprint");
  } finally {
    for (const release of groupRequests) release({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("cached WMO group deferred and terminal states clear off-footprint and re-enter without a request storm", async () => {
  const originalFetch = globalThis.fetch;
  const requests = new Map();
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (!address.searchParams.has("group")) return { ok: true, status: 200, arrayBuffer: async () => wmoHeader() };
    const name = address.searchParams.get("path");
    requests.set(name, (requests.get(name) ?? 0) + 1);
    if (name === "Deferred.wmo") return new Response(null, { status: 503 });
    if (name === "Failed.wmo") return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "2097153" }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    return new Response(null, { status: 404 });
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    for (const name of ["Deferred.wmo", "Failed.wmo", "Missing.wmo"]) {
      client.beginResourceFrame();
      client.model(name, "critical");
      client.endResourceFrame();
      await settle();
      assert.ok(client.model(name)?.wmo);
      client.requestModelGroups(name, [0]);
      await settle();
      client.beginResourceFrame();
      client.endResourceFrame();
      assert.deepEqual([client.stats.deferredGroups, client.stats.failedGroups], [0, 0],
        `${name}: old group state is hidden after leaving the footprint`);

      client.beginResourceFrame();
      client.model(name, "critical");
      client.requestModelGroups(name, [0]);
      client.endResourceFrame();
      assert.deepEqual([client.stats.deferredGroups, client.stats.failedGroups],
        name === "Deferred.wmo" ? [1, 0] : name === "Failed.wmo" ? [0, 1] : [0, 0],
        `${name}: re-entry restores the cached group outcome`);
      await settle();
      assert.equal(requests.get(name), 1, `${name}: cached group outcome avoids a duplicate request`);
    }
  } finally {
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("exact group demand switches hide old deferred or failed state and re-entry reuses it", async () => {
  const originalFetch = globalThis.fetch;
  const modes = ["deferred", "failed"];
  for (const mode of modes) {
    const counts = new Map();
    let now = 0;
    globalThis.fetch = async (url) => {
      const address = new URL(String(url));
      if (address.searchParams.has("group")) {
        const group = Number(address.searchParams.get("group"));
        counts.set(group, (counts.get(group) ?? 0) + 1);
        if (group === 0 && mode === "deferred") return new Response(null, { status: 503 });
        if (group === 0) return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": "2097153" }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
        return { ok: true, status: 200, arrayBuffer: async () => wmoGroup(7, group) };
      }
      return { ok: true, status: 200, arrayBuffer: async () => wmoHeader(2) };
    };
    try {
      const client = new EnvironmentClient("ws://example.test/world", () => now);
      const demand = (groups) => {
        client.beginResourceFrame();
        client.model("Exact.wmo", "critical");
        client.requestModelGroups("Exact.wmo", groups);
        client.endResourceFrame();
      };

      client.model("Exact.wmo", "critical");
      await settle();
      demand([0]);
      await settle();
      assert.deepEqual([client.stats.deferredGroups, client.stats.failedGroups],
        mode === "deferred" ? [1, 0] : [0, 1]);
      assert.equal(counts.get(0), 1);

      demand([1]);
      await settle();
      assert.deepEqual([client.stats.deferredGroups, client.stats.failedGroups], [0, 0],
        `${mode}: changing exact group demand hides group 0 state`);

      demand([0]);
      assert.deepEqual([client.stats.deferredGroups, client.stats.failedGroups],
        mode === "deferred" ? [1, 0] : [0, 1],
        `${mode}: re-entry exposes the cached group 0 outcome`);
      await settle();
      assert.equal(counts.get(0), 1, `${mode}: cached group 0 outcome avoids a duplicate fetch`);
      client.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("same-parent exact group demand switch prunes queued groups", async () => {
  const originalFetch = globalThis.fetch;
  const groupRequests = [];
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (address.searchParams.has("group")) {
      return new Promise((resolve) => groupRequests.push({
        group: Number(address.searchParams.get("group")),
        resolve,
      }));
    }
    return { ok: true, status: 200, arrayBuffer: async () => wmoHeader(6) };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.beginResourceFrame();
    client.model("Switch.wmo", "critical");
    client.endResourceFrame();
    await settle();

    client.beginResourceFrame();
    client.model("Switch.wmo", "critical");
    client.requestModelGroups("Switch.wmo", [0, 1, 2, 3, 4, 5]);
    client.endResourceFrame();
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [2, 4]);

    client.beginResourceFrame();
    client.model("Switch.wmo", "critical");
    client.requestModelGroups("Switch.wmo", [0, 1, 2, 3]);
    client.endResourceFrame();
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [0, 4]);
    assert.deepEqual(groupRequests.map(({ group }) => group), [0, 1, 2, 3],
      "groups removed from exact demand never start after the switch");

    for (const request of groupRequests) {
      request.resolve({ ok: true, status: 200, arrayBuffer: async () => wmoGroup(1, request.group) });
    }
    await settle();
    assert.equal(groupRequests.length, 4);
    client.dispose();
  } finally {
    for (const request of groupRequests) request.resolve({ ok: false, status: 500 });
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("old active WMO groups remain counted until settlement after exact demand switch", async () => {
  const originalFetch = globalThis.fetch;
  const groupRequests = [];
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (address.searchParams.has("group")) {
      return new Promise((resolve) => groupRequests.push({
        group: Number(address.searchParams.get("group")),
        resolve,
      }));
    }
    return { ok: true, status: 200, arrayBuffer: async () => wmoHeader(5) };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.beginResourceFrame();
    client.model("ActiveSwitch.wmo", "critical");
    client.endResourceFrame();
    await settle();

    client.beginResourceFrame();
    client.model("ActiveSwitch.wmo", "critical");
    client.requestModelGroups("ActiveSwitch.wmo", [0, 1, 2, 3]);
    client.endResourceFrame();
    assert.equal(client.stats.activeGroups, 4);

    client.beginResourceFrame();
    client.model("ActiveSwitch.wmo", "critical");
    client.requestModelGroups("ActiveSwitch.wmo", [4]);
    client.endResourceFrame();
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [1, 4]);

    for (const request of groupRequests.slice(0, 4)) {
      request.resolve({ ok: true, status: 200, arrayBuffer: async () => wmoGroup(1, request.group) });
    }
    await settle();
    assert.equal(groupRequests.length, 5, "queued current-demand group starts after old work settles");
    assert.equal(client.stats.activeGroups, 1, "only settled old work leaves the active count");
    groupRequests[4].resolve({ ok: true, status: 200, arrayBuffer: async () => wmoGroup(1, 4) });
    await settle();
    assert.equal(client.stats.activeGroups, 0);
    client.dispose();
  } finally {
    for (const request of groupRequests) request.resolve({ ok: false, status: 500 });
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("WMO group queue has a hard cap and dropped groups re-arm after the backlog drains", async () => {
  const originalFetch = globalThis.fetch;
  const groupRequests = [];
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (address.searchParams.has("group")) {
      return new Promise((resolve) => groupRequests.push({
        group: Number(address.searchParams.get("group")),
        resolve,
      }));
    }
    return { ok: true, status: 200, arrayBuffer: async () => wmoHeader(300) };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.model("Many.wmo", "critical");
    await settle();
    assert.ok(client.model("Many.wmo")?.wmo);
    client.requestModelGroups("Many.wmo", Array.from({ length: 300 }, (_, index) => index));
    assert.deepEqual([client.stats.queuedGroups, client.stats.activeGroups], [
      ENVIRONMENT_MODEL_GROUP_QUEUE_LIMIT - 4,
      4,
    ]);

    let released = 0;
    while (released < groupRequests.length || client.stats.queuedGroups > 0 || client.stats.activeGroups > 0) {
      const end = groupRequests.length;
      while (released < end) {
        const request = groupRequests[released++];
        request.resolve({ ok: true, status: 200, arrayBuffer: async () => wmoGroup(1, request.group) });
      }
      await settle();
      if (released === groupRequests.length && client.stats.queuedGroups === 0 && client.stats.activeGroups === 0) break;
    }
    assert.equal(groupRequests.some((request) => request.group === 299), false,
      "work beyond the cap is not admitted until demanded again");
    client.requestModelGroups("Many.wmo", [299]);
    assert.equal(client.stats.activeGroups, 1, "a dropped group re-arms after the capped backlog drains");
    const retry = groupRequests.at(-1);
    retry.resolve({ ok: true, status: 200, arrayBuffer: async () => wmoGroup(2, 299) });
    await settle();
    assert.equal(client.stats.activeGroups, 0);
  } finally {
    for (const request of groupRequests) request.resolve({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("WMO group 5xx, network, decode, and index failures use demand-driven bounded retries", async () => {
  const originalFetch = globalThis.fetch;
  let now = 0;
  let attempts = 0;
  let mismatchAttempts = 0;
  let missingAttempts = 0;
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (!address.searchParams.has("group")) return { ok: true, status: 200, arrayBuffer: async () => wmoHeader() };
    if (address.searchParams.get("path") === "Missing.wmo") {
      missingAttempts++;
      return new Response(null, { status: 404 });
    }
    if (address.searchParams.get("path") === "Mismatch.wmo") {
      mismatchAttempts++;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => mismatchAttempts === 1 ? wmoGroup(3, 1) : wmoGroup(4, 0),
      };
    }
    attempts++;
    if (attempts === 1) return new Response(null, { status: 503 });
    if (attempts === 2) throw new Error("network failure");
    if (attempts === 3) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => wmoGroup(4, 0) };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", () => now);
    client.model("Retry.wmo", "critical");
    await settle();
    assert.ok(client.model("Retry.wmo")?.wmo);

    client.requestModelGroups("Retry.wmo", [0]);
    await settle();
    assert.deepEqual([attempts, client.stats.deferredGroups, client.stats.failedGroups], [1, 1, 0]);
    client.requestModelGroups("Retry.wmo", [0]);
    await settle();
    assert.equal(attempts, 1, "backoff does not retry on every demand");

    now += 2_000;
    client.requestModelGroups("Retry.wmo", [0]);
    await settle();
    assert.deepEqual([attempts, client.stats.deferredGroups, client.stats.failedGroups], [2, 1, 0]);
    now += 8_000;
    client.requestModelGroups("Retry.wmo", [0]);
    await settle();
    assert.deepEqual([attempts, client.stats.deferredGroups, client.stats.failedGroups], [3, 1, 0]);
    now += 30_000;
    client.requestModelGroups("Retry.wmo", [0]);
    await settle();
    assert.deepEqual([attempts, client.stats.deferredGroups, client.stats.failedGroups], [4, 0, 0]);
    assert.equal(client.model("Retry.wmo")?.wmo?.groups[0]?.mesh?.positions[0], 4);
    client.requestModelGroups("Retry.wmo", [0]);
    await settle();
    assert.equal(attempts, 4, "a successful group is not requested again");

    client.model("Mismatch.wmo", "critical");
    await settle();
    assert.ok(client.model("Mismatch.wmo")?.wmo);
    client.requestModelGroups("Mismatch.wmo", [0]);
    await settle();
    assert.deepEqual([mismatchAttempts, client.stats.deferredGroups, client.stats.failedGroups], [1, 1, 0]);
    now += 2_000;
    client.requestModelGroups("Mismatch.wmo", [0]);
    await settle();
    assert.deepEqual([mismatchAttempts, client.stats.deferredGroups, client.stats.failedGroups], [2, 0, 0]);

    client.model("Missing.wmo", "critical");
    await settle();
    assert.ok(client.model("Missing.wmo")?.wmo);
    client.requestModelGroups("Missing.wmo", [0]);
    await settle();
    assert.deepEqual([missingAttempts, client.stats.deferredGroups, client.stats.failedGroups], [1, 0, 0]);
    now += 60_000;
    client.requestModelGroups("Missing.wmo", [0]);
    await settle();
    assert.equal(missingAttempts, 1, "a terminal 404 has no retry storm");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model queue cap admits critical work and re-arms off-footprint work after a frame commit", async () => {
  const originalFetch = globalThis.fetch;
  const releases = [];
  globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    for (let index = 0; index < 4; index++) client.model(`Active${index}.m2`, "critical");
    for (let index = 0; index < ENVIRONMENT_MODEL_QUEUE_LIMIT; index++) client.model(`Queued${index}.m2`, "background");
    assert.equal(client.stats.queuedModels, ENVIRONMENT_MODEL_QUEUE_LIMIT);
    client.model("Urgent.m2", "critical");
    assert.equal(client.stats.queuedModels, ENVIRONMENT_MODEL_QUEUE_LIMIT,
      "critical admission displaces a lower-priority queued path without growing the queue");

    await settle();
    client.beginResourceFrame();
    client.model("Current.m2", "critical");
    client.endResourceFrame();
    assert.equal(client.stats.queuedModels, 1, "queued work outside the committed footprint is canceled");
    client.beginResourceFrame();
    client.model("Queued255.m2", "background");
    client.endResourceFrame();
    assert.equal(client.stats.queuedModels, 1, "a dropped path owns a fresh request on re-entry");
  } finally {
    for (const release of releases) release({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    await settle();
    globalThis.fetch = originalFetch;
  }
});

test("a late off-footprint model failure is pruned and can be requested again", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(modelPath(url));
    return new Response(null, { status: 503 });
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.model("Old.m2", "critical");
    await settle();
    assert.equal(client.stats.deferredModels, 1);

    client.beginResourceFrame();
    client.model("Current.m2", "critical");
    client.endResourceFrame();
    assert.equal(client.stats.deferredModels, 0, "commit prunes failures outside the exact active footprint");

    client.beginResourceFrame();
    client.model("Old.m2", "critical");
    client.endResourceFrame();
    assert.equal(client.stats.queuedModels, 1, "re-entry owns a fresh queued request");
    await settle();
    assert.equal(requests.filter((name) => name === "Old.m2").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient animation LRU refetches an evicted positive entry", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(modelPath(url));
    return { ok: true, status: 200, arrayBuffer: async () => emptyAnimations() };
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 1, 2);
    for (const name of ["A.m2", "B.m2"]) {
      client.beginResourceFrame();
      client.animations(name, 1);
      client.endResourceFrame();
      await settle();
    }
    client.beginResourceFrame();
    assert.deepEqual(client.animations("A.m2", 1), []);
    client.animations("C.m2", 1);
    client.endResourceFrame();
    await settle();

    client.beginResourceFrame();
    client.animations("B.m2", 1);
    client.endResourceFrame();
    await settle();
    assert.equal(requests.filter((name) => name === "B.m2").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production wraps warmup and renderer consumers in one committed EnvironmentClient frame", async () => {
  const source = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const exclusive = source.indexOf("if (formalRenderBenchmarkExclusiveActive())");
  const begin = source.indexOf("environment?.beginResourceFrame()", exclusive);
  const frame = source.indexOf("frame(now)", begin);
  const finallyAt = source.indexOf("finally", frame);
  const end = source.indexOf("environment?.endResourceFrame()", finallyAt);
  assert.ok(exclusive >= 0 && begin > exclusive, "formal-exclusive frames do not start live residency tracking");
  assert.ok(frame > begin && finallyAt > frame && end > finallyAt,
    "the whole production frame commits resource pins from a finally block");
});
