import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentClient } from "../dist/code/browser/Terrain.js";

// 10.21 (c) review (02.10): a slot freed by one lane goes to the other lanes first. The group lane
// re-drained itself synchronously after its own release, ahead of the wake-ups it had just queued,
// so a long group queue kept every slot and ordinary models waited until the last group had started.

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

test("a long WMO group queue does not keep ordinary models waiting until the last group", async () => {
  const originalFetch = globalThis.fetch;
  const pending = [];
  const order = [];
  let parentServed = false;
  globalThis.fetch = (url) => {
    const kind = classify(url);
    if (!parentServed && kind === "model" && String(url).includes("City.wmo")) {
      parentServed = true;
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => wmoHeader(40) });
    }
    order.push(kind);
    return new Promise((resolve) => pending.push(() => resolve({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) })));
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
    for (let index = 0; index < 8; index++) client.model(`World\Scenery${index}.m2`, "normal");
    client.requestModelGroups("City.wmo", Array.from({ length: 40 }, (_, group) => group));
    client.endResourceFrame();
    await settle();
    for (let guard = 0; guard < 400 && pending.length > 0; guard++) {
      pending.shift()();
      await settle();
    }
    assert.equal(pending.length, 0);
    assert.equal(order.filter((kind) => kind === "model").length, 8);
    assert.equal(order.filter((kind) => kind === "group").length, 40);
    const lastModel = order.lastIndexOf("model");
    const lastGroup = order.lastIndexOf("group");
    assert.ok(lastModel < lastGroup, `the eighth model started at ${lastModel}, after every group (last ${lastGroup})`);
    client.dispose();
  } finally {
    for (const resolve of pending) resolve();
    await settle();
    globalThis.fetch = originalFetch;
  }
});
