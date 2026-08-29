import assert from "node:assert/strict";
import test from "node:test";
import {
  SPELL_VISUAL_RETRY_BACKOFF_MS, SpellVisualClient,
} from "../dist/code/browser/SpellVisualClient.js";

const kit = (sound = 0) => ({ startAnimation: -1, animation: -1, effects: [], sound });

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("SpellVisualClient batches same-turn ids once and permanently remembers successful no-visual answers", async () => {
  const original = globalThis.fetch;
  const urls = [];
  const ids = Array.from({ length: 24 }, (_, index) => 11 + index);
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      async json() { return [{ id: ids[0], precast: kit(7) }, ...ids.slice(1).map((id) => ({ id }))]; },
    };
  };
  try {
    const client = new SpellVisualClient("http://localhost:8090/ws");
    const loaded = [];
    client.onLoaded = (ids) => loaded.push(...ids);
    for (const id of ids) assert.equal(client.get(id), undefined);
    await tick();
    await tick();
    assert.deepEqual(loaded, ids);
    assert.equal(client.get(11).precast.sound, 7);
    assert.equal(client.get(12), undefined);
    assert.equal(urls.length, 1, "one JavaScript turn becomes one metadata batch");
    assert.equal(new URL(urls[0]).searchParams.get("v"), "6",
      "non-cacheable visual metadata rolls the old client cache contract");
    assert.equal(new URL(urls[0]).searchParams.get("ids"), ids.join(","));
    client.get(12);
    await tick();
    assert.equal(urls.length, 1, "a successful no-visual answer is a permanent cache entry");
  } finally {
    globalThis.fetch = original;
  }
});

test("transient metadata failures retry only after the injected backoff and never duplicate in flight", async () => {
  const original = globalThis.fetch;
  const pending = [];
  const urls = [];
  let now = 10_000;
  globalThis.fetch = (url) => {
    urls.push(String(url));
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  try {
    const client = new SpellVisualClient("http://localhost:8090/ws", () => now);
    let loaded = 0;
    let status = 0;
    client.onLoaded = () => loaded++;
    client.onStatus = () => status++;
    client.get(99);
    await tick();
    client.get(99);
    client.get(99);
    assert.equal(urls.length, 1, "polling while the request is active does not enqueue it twice");
    pending.shift().reject(new Error("offline"));
    await tick();
    assert.equal(loaded, 0);
    assert.equal(status, 1);

    now += SPELL_VISUAL_RETRY_BACKOFF_MS[0] - 1;
    client.get(99);
    await tick();
    assert.equal(urls.length, 1, "the failed id stays quiet before its retry deadline");

    now++;
    client.get(99);
    client.get(99);
    await tick();
    assert.equal(urls.length, 2, "the deadline admits exactly one retry");
    pending.shift().resolve({
      ok: true,
      async json() { return [{ id: 99, precast: kit(9) }]; },
    });
    await tick();
    assert.equal(client.get(99).precast.sound, 9);
    assert.equal(loaded, 1);
    assert.equal(urls.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("invalid JSON is transient rather than a cached no-visual answer", async () => {
  const original = globalThis.fetch;
  let now = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return {
      ok: true,
      async json() { throw new SyntaxError("invalid JSON"); },
    };
    return { ok: true, async json() { return [{ id: 41, precast: kit(4) }]; } };
  };
  try {
    const client = new SpellVisualClient("http://localhost:8090/ws", () => now);
    const loaded = [];
    client.onLoaded = (ids) => loaded.push(...ids);
    client.get(41);
    await tick();
    await tick();
    assert.deepEqual(loaded, []);
    assert.equal(client.get(41), undefined);
    assert.equal(client.pending, 0);

    now = SPELL_VISUAL_RETRY_BACKOFF_MS[0];
    client.get(41);
    await tick();
    await tick();
    assert.deepEqual(loaded, [41]);
    assert.equal(client.get(41).precast.sound, 4);
  } finally {
    globalThis.fetch = original;
  }
});

test("the transient retry ladder stays capped instead of poisoning an id for the session", async () => {
  const original = globalThis.fetch;
  let now = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("offline");
  };
  try {
    const client = new SpellVisualClient("http://localhost:8090/ws", () => now);
    client.get(73);
    await tick();
    await tick();
    for (const delay of [2_000, 8_000, 30_000, 30_000]) {
      now += delay;
      client.get(73);
      await tick();
      await tick();
    }
    assert.equal(calls, 5, "later callers retain one retry every thirty seconds");
  } finally {
    globalThis.fetch = original;
  }
});
