import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentClient } from "../dist/code/browser/Terrain.js";

// 10.21 (c): the three environment lanes (models 4, WMO groups 4, animation sidecars 2) share one
// budget of four requests, plus one for critical work — not ten requests against six sockets.

const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function wmoHeader(groupCount) {
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

function classify(url) {
  const address = new URL(String(url));
  if (address.pathname.includes("animations")) return "animation";
  if (address.searchParams.has("group")) return "group";
  return "model";
}

test("20 models, 8 WMO groups and 4 animation sidecars never hold more than 4 (+1 critical) fetches", async () => {
  const originalFetch = globalThis.fetch;
  const pending = [];
  const started = { model: 0, group: 0, animation: 0 };
  const inits = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let parentServed = false;
  globalThis.fetch = (url, init) => {
    const kind = classify(url);
    // The WMO parent the groups belong to is answered at once, before the measured burst.
    if (!parentServed && kind === "model" && String(url).includes("City.wmo")) {
      parentServed = true;
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => wmoHeader(8) });
    }
    started[kind]++;
    inits.push({ kind, priority: init?.priority });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => pending.push({
      kind,
      resolve: () => {
        inFlight--;
        resolve({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
      },
    }));
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    client.endResourceFrame();
    await settle();
    assert.ok(client.model("City.wmo")?.wmo, "the WMO parent is resident");

    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    for (let index = 0; index < 20; index++) client.model(`World\\Scenery${index}.m2`, index % 2 ? "background" : "normal");
    client.requestModelGroups("City.wmo", [0, 1, 2, 3, 4, 5, 6, 7]);
    for (let index = 0; index < 4; index++) client.animations(`Creature\\Rig${index}.m2`, 1, "normal");
    client.endResourceFrame();
    await settle();
    assert.equal(inFlight, 4, "the burst fills the shared budget");
    assert.equal(maxInFlight, 4, "and no more: the three lanes no longer add up to ten");

    client.model("Character\\Self.m2", "critical");
    await settle();
    assert.equal(maxInFlight, 5, "a critical model takes the one spare slot");
    assert.equal(inits.at(-1).kind, "model");

    // Drain everything one completion at a time: every request still starts (no lost wake-up),
    // and the ceiling holds throughout.
    for (let guard = 0; guard < 200 && pending.length > 0; guard++) {
      pending.shift().resolve();
      await settle();
      assert.ok(inFlight <= 5, `at most 4 + 1 in flight (saw ${inFlight})`);
    }
    assert.equal(pending.length, 0);
    assert.deepEqual(started, { model: 21, group: 8, animation: 4 }, "every queued request was made once");
    assert.equal(maxInFlight, 5);
    // The groups were not starved behind twenty models: the first group starts before the last model.
    const firstGroup = inits.findIndex((entry) => entry.kind === "group");
    const lastModel = inits.findLastIndex((entry) => entry.kind === "model");
    assert.ok(firstGroup >= 0 && firstGroup < lastModel, "lanes take turns for freed slots");
    // Scenery is marked low for Chromium's scheduler; normal and critical work keep the default.
    assert.ok(inits.some((entry) => entry.kind === "model" && entry.priority === "low"));
    assert.ok(inits.every((entry) => entry.priority === undefined || entry.priority === "low"));
    assert.ok(inits.filter((entry) => entry.kind === "group").every((entry) => entry.priority === undefined));
    client.dispose();
  } finally {
    for (const request of pending) request.resolve();
    await settle();
    globalThis.fetch = originalFetch;
  }
});
