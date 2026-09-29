import assert from "node:assert/strict";
import test from "node:test";
import { SpellMetadataClient } from "../dist/code/browser/SpellMetadata.js";

// A crowd's aura packets used to call `load` once per packet, each with every aura id in view: two
// hundred overlapping requests before the first came back, and an id the gateway has no row for was
// asked again on every one of them. These pin the in-flight sharing and the answered-empty memory.

function row(id) {
  return {
    id, name: `Заклинание ${id}`, rank: "", description: "", iconId: 1, iconPath: "",
    passive: false, autoRepeat: false, displayInStanceBar: false, stanceBarOrder: 0,
    powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, effectAura: [0, 0, 0],
    effectMiscValue: [0, 0, 0], effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0],
    effectPeriod: [0, 0, 0], duration: 0, procChance: 0, spellLevel: 0, spellClassSet: 0,
    spellClassMask: [0, 0, 0], auraDescription: "",
  };
}

/** A gateway that holds every request until `release`, and knows only the ids in `known`. */
function gateway(known) {
  const requests = [];
  const held = [];
  const fetcher = (url) => {
    const ids = new URL(url).searchParams.get("ids").split(",").map(Number);
    requests.push(ids);
    return new Promise((resolve, reject) => {
      held.push({
        answer: () => resolve({ ok: true, json: async () => ids.filter((id) => known.has(id)).map(row) }),
        fail: () => reject(new Error("offline")),
      });
    });
  };
  return {
    requests,
    held,
    fetcher,
    release() { for (const request of held.splice(0)) request.answer(); },
  };
}

const settle = async () => { for (let round = 0; round < 8; round += 1) await Promise.resolve(); };

test("callers that need the same rows share the request already asking for them", async () => {
  const server = gateway(new Set([1, 2, 3, 4]));
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/", server.fetcher);
  const first = client.load([1, 2]);
  const second = client.load([1, 2, 3]);
  const third = client.load([2, 3, 4]);
  assert.deepEqual(server.requests, [[1, 2], [3], [4]], "each id is asked for once, by the first caller that needed it");
  server.release();
  await settle();
  server.release();
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.deepEqual([...a.keys()], [1, 2]);
  assert.deepEqual([...b.keys()], [1, 2, 3], "a caller gets the rows it waited for, in its own order");
  assert.deepEqual([...c.keys()], [2, 3, 4]);
  assert.equal(server.requests.length, 3);
});

test("an id answered without a row is not asked for again", async () => {
  const server = gateway(new Set([10]));
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/", server.fetcher);
  const pending = client.load([10, 61418]);
  server.release();
  const loaded = await pending;
  assert.deepEqual([...loaded.keys()], [10]);
  assert.equal(client.answered(61418), true, "the gateway's empty answer is final");
  assert.equal(client.answered(10), true);
  assert.equal(client.answered(99), false, "never asked is not answered");
  const again = await client.load([10, 61418]);
  assert.deepEqual([...again.keys()], [10]);
  assert.equal(server.requests.length, 1, "neither the row nor the known miss costs a second request");
});

test("a failed request remembers nothing, and a waiter asks for itself what the failure left", async () => {
  const server = gateway(new Set([7, 8]));
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/", server.fetcher);
  const owner = client.load([7]);
  const waiter = client.load([7, 8]);
  assert.deepEqual(server.requests, [[7], [8]]);
  const [shared, own] = server.held.splice(0);
  shared.fail();
  own.answer();
  await assert.rejects(owner, /offline/, "the caller whose request failed is told, as before");
  await settle();
  assert.equal(client.answered(7), false, "a failure is not an answer");
  assert.deepEqual(server.requests, [[7], [8], [7]],
    "the waiter asks for the id its shared request lost — the request it would have made alone");
  server.release();
  assert.deepEqual([...(await waiter).keys()], [7, 8]);
});

test("route-sized chunks are asked one after another and each chunk is shared on its own", async () => {
  const ids = Array.from({ length: 450 }, (_, index) => index + 1);
  const server = gateway(new Set(ids));
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/", server.fetcher);
  const all = client.load(ids);
  assert.equal(server.requests.length, 1, "the first chunk goes out at once, the rest wait their turn");
  assert.equal(server.requests[0].length, 200);
  const late = client.load([300, 451]);
  assert.deepEqual(server.requests.map((request) => request.length), [200, 1],
    "an id of a later chunk is not asked twice; a new id is");
  server.release();
  await settle();
  server.release();
  await settle();
  server.release();
  await settle();
  const [everything, some] = await Promise.all([all, late]);
  assert.equal(everything.size, 450);
  assert.deepEqual([...some.keys()], [300], "451 is unknown to this gateway");
  assert.deepEqual(server.requests.map((request) => request.length), [200, 1, 200, 50]);
});
