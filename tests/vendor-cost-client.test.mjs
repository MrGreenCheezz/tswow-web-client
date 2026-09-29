import assert from "node:assert/strict";
import test from "node:test";

const { VendorCostClient } = await import("../dist/code/browser/VendorCostClient.js");

test("vendor cost client loads the DBC catalog once and exposes cache-only prices", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push([url, options?.cache]);
    return new Response(JSON.stringify({ costs: {
      7: { honor: 125, arena: 20, arenaBracket: 0, rating: 0,
        items: [{ entry: 29434, count: 2 }] },
    } }), { status: 200 });
  };
  try {
    const client = new VendorCostClient("ws://127.0.0.1:8090");
    let loaded = 0;
    client.onLoaded = () => { loaded += 1; };
    assert.equal(client.get(7), undefined, "a C API read before load stays unknown");
    client.load();
    client.load();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.ready, true);
    assert.equal(loaded, 1);
    assert.deepEqual(calls, [["http://127.0.0.1:8090/dbc/vendor-costs?v=1", "no-store"]],
      "the browser HTTP cache cannot retain a stale dataset catalog for an hour");
    assert.deepEqual(client.get(7), { honor: 125, arena: 20, arenaBracket: 0, rating: 0,
      items: [{ entry: 29434, count: 2 }] });
    assert.equal(client.get(8), undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("vendor cost client rejects malformed rows instead of displaying fabricated prices", async () => {
  const previousFetch = globalThis.fetch;
  let valid = false;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ costs: {
      7: { honor: 125, arena: 0, arenaBracket: 0, rating: 0,
        items: [{ entry: 29434, count: valid ? 2 : 0 }] },
    } }), { status: 200 });
  };
  try {
    const client = new VendorCostClient("ws://127.0.0.1:8090");
    const errors = [];
    client.onStatus = (message, error) => errors.push([message, error]);
    client.load();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.ready, false);
    assert.equal(client.get(7), undefined);
    assert.match(errors[0][0], /malformed vendor cost row 7/);
    assert.equal(errors[0][1], true);
    valid = true;
    client.load();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 2, "a failed first request releases its pending latch");
    assert.equal(client.ready, true);
    assert.equal(client.get(7).items[0].count, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
