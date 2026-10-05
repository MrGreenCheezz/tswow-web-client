import assert from "node:assert/strict";
import test from "node:test";
import {
  SPELL_VISUAL_RETRY_BACKOFF_MS, SpellVisualClient, SpellVisualKitClient,
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
    // 05.10-A7a-E: v=8 is slice E's one bump (missile motion/columns, kit shakes and chains).
    assert.equal(new URL(urls[0]).searchParams.get("v"), "8",
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

/* --- S3: the kit route, on the same engine ---------------------------------------------------- */

test("S3: kit ids batch onto their own route and remember an empty answer", async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      async json() { return [{ id: 406, kit: kit(45) }, { id: 999999 }]; },
    };
  };
  try {
    const client = new SpellVisualKitClient("ws://localhost:8090/auth");
    const loaded = [];
    client.onLoaded = (ids) => loaded.push(...ids);
    assert.equal(client.get(406), undefined);
    assert.equal(client.get(999999), undefined);
    await tick();
    await tick();
    assert.equal(urls.length, 1, "two ids in one JavaScript turn are one request");
    const asked = new URL(urls[0]);
    assert.equal(asked.pathname, "/dbc/spell-visual-kits", "a kit id is not a spell id");
    assert.equal(asked.protocol, "http:", "the websocket URL becomes the gateway origin");
    assert.equal(asked.searchParams.get("v"), "1");
    assert.deepEqual(asked.searchParams.get("ids"), "406,999999");
    assert.deepEqual(loaded, [406, 999999]);
    assert.equal(client.get(406).kit.sound, 45);
    assert.equal(client.get(999999), undefined, "a kit that resolves to nothing is an answer");
    client.get(999999);
    await tick();
    assert.equal(urls.length, 1, "and it is a permanent one");
  } finally {
    globalThis.fetch = original;
  }
});

test("S3: a malformed kit is transient, and the kit queue is not the spell queue", async () => {
  const original = globalThis.fetch;
  const urls = [];
  let now = 0;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    // `effects` is not an array of effects: the shared validator has to refuse it rather than
    // caching an entry whose `effects.map` would throw inside the planner.
    if (urls.length === 1) return { ok: true, async json() { return [{ id: 7668, kit: { startAnimation: -1, animation: 172, effects: [{ path: 1 }], sound: 0 } }]; } };
    return { ok: true, async json() { return [{ id: 7668, kit: kit(11658) }]; } };
  };
  try {
    const client = new SpellVisualKitClient("http://localhost:8090/ws", () => now);
    const loaded = [];
    client.onLoaded = (ids) => loaded.push(...ids);
    client.onStatus = () => {};
    client.get(7668);
    await tick();
    await tick();
    assert.deepEqual(loaded, [], "an invalid answer is not a cached no-kit answer");
    assert.equal(client.get(7668), undefined);

    now = SPELL_VISUAL_RETRY_BACKOFF_MS[0];
    client.get(7668);
    await tick();
    await tick();
    assert.deepEqual(loaded, [7668]);
    assert.equal(client.get(7668).kit.sound, 11658);
    assert.equal(client.pending, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("05.10-A7a-E: the v=8 missile columns are accepted, malformed ones refused, and the v=7 shape still served", async () => {
  const original = globalThis.fetch;
  const missile = { path: "Spells\\Bolt.m2", scale: 1, attachment: 22, speed: 20 };
  const answers = [
    [
      { id: 1, missile: { ...missile, motion: { id: 13, script: "transMag = 1", count: 1 }, dest: 1, pathType: 2,
        castOffset: [0, 0, 1], impactOffset: [1, 0, 0], followGround: { height: 100, dropSpeed: 0, approach: 0, flags: 6 } } },
      { id: 2, missile },
    ],
    [{ id: 3, missile: { ...missile, motion: { id: 13, script: 7, count: 1 } } }],
    [{ id: 4, missile: { ...missile, castOffset: [0, 1] } }],
  ];
  let call = 0;
  globalThis.fetch = async () => ({ ok: true, async json() { return answers[call++]; } });
  try {
    const client = new SpellVisualClient("http://localhost:8090/ws");
    client.onStatus = () => {};
    client.get(1); client.get(2);
    await tick(); await tick();
    assert.equal(client.get(1).missile.motion.id, 13);
    assert.equal(client.get(2).missile.motion, undefined, "the older gateway's answer is a valid record");
    client.get(3);
    await tick(); await tick();
    assert.equal(client.get(3), undefined, "a script that is not a string is refused");
    client.get(4);
    await tick(); await tick();
    assert.equal(client.get(4), undefined, "an offset that is not three numbers is refused");
  } finally {
    globalThis.fetch = original;
  }
});
