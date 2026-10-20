import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { IMAGE_RETRY_BACKOFF_MS } from "../dist/code/browser/CharacterAtlas.js";
import { setRecencyStampLimitForTests } from "../dist/code/browser/RecencyStamps.js";
import { EnvironmentClient, TERRAIN_GRID_SIZE } from "../dist/code/browser/Terrain.js";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── environment-model-demand.test.mjs
{
// P1-10a-2 (MEM-2): the model keys a resource frame demands live in one map kept across frames
// (key → frame number and whether the committed frame had it) instead of a `Set` rebuilt from empty
// every frame. Everything that read the two sets must answer as before: what eviction pins, which
// failed entries `stats` counts — also while the next frame is open — and which failed requests keep
// a retry ledger. A reference below replays the same operations with the old pair of sets.

const settle = async (turns = 40) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function emptyModel() {
  const data = new ArrayBuffer(16);
  new Uint8Array(data).set([0x57, 0x56, 0x4d, 0x31]);
  return data;
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** What each model's request answers: a busy gateway (500), an oversized body (terminal), or a model. */
const outcomeOf = (index) => (index % 5 === 0 ? "busy" : index % 5 === 1 ? "oversized" : "ok");
const RESPONSE_LIMIT = 32;

/** The client before P1-10a-2, as far as the demand sets reach: frame/active sets, LRU, ledger. */
class Reference {
  constructor(limit) {
    this.limit = limit;
    this.entries = new Map(); // name → "ok" | "failed", oldest first
    this.frame = new Set();
    this.active = new Set();
    this.open = false;
    this.committed = false;
    this.requested = new Set();
    this.ledger = new Set();
  }
  begin() { this.open = true; this.frame = new Set(); }
  end() {
    this.open = false;
    this.active = this.frame;
    this.committed = true;
    for (const name of [...this.ledger]) if (!this.active.has(name)) this.ledger.delete(name);
    this.evict();
  }
  touch(name) {
    const value = this.entries.get(name);
    this.entries.delete(name);
    this.entries.set(name, value);
  }
  /** `model()`: true when a request is started. */
  model(name) {
    if (this.open) this.frame.add(name);
    if (this.entries.has(name)) {
      this.touch(name);
      return false;
    }
    if (this.requested.has(name) || this.ledger.has(name)) return false;
    this.requested.add(name);
    return true;
  }
  groups(name) {
    if (this.open) this.frame.add(name);
  }
  /** A request settles. */
  settle(name, outcome) {
    if (!this.requested.has(name)) return;
    this.requested.delete(name);
    if (outcome === "busy") {
      const demanded = this.open ? this.frame.has(name) : this.active.has(name);
      if (this.committed && !demanded) this.ledger.delete(name);
      else this.ledger.add(name);
      return;
    }
    this.ledger.delete(name);
    this.entries.delete(name);
    this.entries.set(name, outcome === "oversized" ? "failed" : "ok");
    if (!this.open) this.evict();
  }
  evict() {
    while (this.entries.size > this.limit) {
      let victim;
      for (const name of this.entries.keys()) if (!this.active.has(name)) { victim = name; break; }
      if (victim === undefined) return;
      this.entries.delete(victim);
      this.requested.delete(victim);
      this.ledger.delete(victim);
    }
  }
  failedModels() {
    let count = 0;
    for (const [name, value] of this.entries) {
      if (value === "failed" && (!this.committed || this.active.has(name))) count++;
    }
    return count;
  }
}

/**
 * `frames` random frames over `nameCount` models; some frames let requests settle while still open.
 * Returns how many frames ran, for the callers' sanity checks.
 */
async function replay(seed, frames, nameCount) {
  const next = random(seed);
  const limit = 3 + Math.floor(next() * 6);
  const names = Array.from({ length: nameCount }, (_, index) => `Doodad${index}.m2`);
  const outcome = new Map(names.map((name, index) => [name, outcomeOf(index)]));
  const originalFetch = globalThis.fetch;
  const settled = [];
  globalThis.fetch = async (url) => {
    const name = new URL(String(url)).searchParams.get("path");
    settled.push(name);
    const kind = outcome.get(name);
    if (kind === "busy") return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
    const data = kind === "oversized" ? new ArrayBuffer(RESPONSE_LIMIT * 2) : emptyModel();
    return { ok: true, status: 200, arrayBuffer: async () => data };
  };
  const reference = new Reference(limit);
  const requests = new Map();
  const expectedRequests = new Map();
  // Requests settle in the order they were made; the reference applies them as the client does.
  const flush = async () => {
    await settle();
    for (const name of settled.splice(0)) {
      requests.set(name, (requests.get(name) ?? 0) + 1);
      reference.settle(name, outcome.get(name));
    }
  };
  const check = (label) => {
    const stats = client.stats;
    assert.equal(stats.failedModels, reference.failedModels(), `${label}: failed models`);
    assert.equal(stats.deferredModels, reference.ledger.size, `${label}: deferred models`);
    // A busy model with a ledger is "pending" (its retry is merely not due); every entry is not.
    const resident = names.filter((name) => client.modelState(name) !== "pending");
    assert.deepEqual(resident, names.filter((name) => reference.entries.has(name)), `${label}: resident models`);
  };
  const client = new EnvironmentClient("ws://example.test/world", () => 1000, 64, limit, 1,
    { visualModelResponseBytes: RESPONSE_LIMIT });
  try {
    for (let frame = 0; frame < frames; frame++) {
      client.beginResourceFrame();
      reference.begin();
      client.retainModelPrefetch([]);
      const operations = 1 + Math.floor(next() * 6);
      const settleInside = next() < 0.3 ? Math.floor(next() * operations) : -1;
      for (let index = 0; index < operations; index++) {
        if (index === settleInside) await flush();
        const name = names[Math.floor(next() * names.length)];
        const roll = next();
        if (roll < 0.65) {
          client.model(name, "critical");
          if (reference.model(name)) expectedRequests.set(name, (expectedRequests.get(name) ?? 0) + 1);
        } else if (roll < 0.85) {
          client.requestModelGroups(name, [0]);
          reference.groups(name);
        } else {
          check(`seed ${seed} frame ${frame} (open)`);
        }
      }
      client.endResourceFrame();
      reference.end();
      await flush();
      check(`seed ${seed} frame ${frame}`);
    }
    for (const name of names) {
      assert.equal(requests.get(name) ?? 0, expectedRequests.get(name) ?? 0, `seed ${seed}: requests for ${name}`);
    }
    client.dispose();
    return frames;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("P1-10a-2: pins, failed-entry counts and retry ledgers follow the old frame/active sets", async () => {
  for (const seed of [1, 2, 3]) await replay(seed, 300, 14);
});

test("P1-10a-2: the same after idle keys are swept (700+ frames, more keys than four footprints + 256)", async () => {
  // 400 models, a handful a frame: the demand map passes 4 · active + 256 and is swept past 600 frames.
  for (const seed of [4, 5]) await replay(seed, 900, 400);
});

test("P1-10a-2: the same across frame renumbering", async () => {
  setRecencyStampLimitForTests(5);
  try {
    for (const seed of [6, 7]) await replay(seed, 300, 14);
    await replay(8, 700, 400);
  } finally {
    setRecencyStampLimitForTests();
  }
});

test("P1-10a-2: frame demand is written in place, with no per-frame set", async () => {
  const source = await readFile(new URL("../src/browser/Terrain.ts", import.meta.url), "utf8");
  const body = (head) => {
    const start = source.indexOf(`  ${head}(`);
    assert.ok(start >= 0, head);
    return source.slice(start, source.indexOf("\n  }\n", start));
  };
  assert.doesNotMatch(source, /this\.#(frameModelKeys|activeModelKeys)/, "the two sets are gone");
  assert.match(body("#touchModelDemand"), /this\.#modelDemand\.set\(key, frame \* 2 \+ carried\);/);
});
}

// ── environment-model-recency.test.mjs
{
// P1-10a (MEM-2): `EnvironmentClient` stamps model hits in place instead of re-inserting them into
// `#models`. Eviction must still remove exactly what the re-insertion LRU removed: a reference
// `Map`-LRU below replays the same random operations and the resident sets must agree throughout.

const settle = async (turns = 160) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function emptyModel() {
  const data = new ArrayBuffer(16);
  new Uint8Array(data).set([0x57, 0x56, 0x4d, 0x31]);
  return data;
}

/** Deterministic PRNG so a failure replays. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The re-insertion LRU the client used to be: Map order oldest first, a hit moves to the back. */
class ReferenceLru {
  constructor(limit) { this.limit = limit; this.entries = new Map(); this.active = new Set(); }
  has(name) { return this.entries.has(name); }
  touch(name) {
    if (!this.entries.has(name)) return;
    this.entries.delete(name);
    this.entries.set(name, true);
  }
  store(name) {
    this.entries.delete(name);
    this.entries.set(name, true);
    this.evict();
  }
  evict() {
    while (this.entries.size > this.limit) {
      let victim;
      for (const name of this.entries.keys()) if (!this.active.has(name)) { victim = name; break; }
      if (victim === undefined) return;
      this.entries.delete(victim);
    }
  }
}

/**
 * One random run. `big`: some frames demand 20–60 of 60 models, so a later commit overflows the cap
 * by more than 16 and eviction takes its sorted path. Returns how many commits overflowed that far.
 */
async function replay(seed, steps, { big = false } = {}) {
  const next = random(seed);
  const limit = 3 + Math.floor(next() * 6);
  const names = Array.from({ length: big ? 60 : limit + 6 }, (_, index) => `Doodad${index}.m2`);
  let bigCommits = 0;
  const originalFetch = globalThis.fetch;
  const requests = new Map();
  globalThis.fetch = async (url) => {
    const name = new URL(String(url)).searchParams.get("path");
    requests.set(name, (requests.get(name) ?? 0) + 1);
    return { ok: true, status: 200, arrayBuffer: async () => emptyModel() };
  };
  const expectedRequests = new Map();
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, limit, 1);
    const reference = new ReferenceLru(limit);
    let done = 0;
    while (done < steps) {
      client.beginResourceFrame();
      client.retainModelPrefetch(names);
      const frameKeys = new Set();
      const asked = [];
      const operations = big && next() < 0.3 ? 20 + Math.floor(next() * 40) : 1 + Math.floor(next() * 6);
      for (let index = 0; index < operations && done < steps; index++, done++) {
        const name = names[Math.floor(next() * names.length)];
        const roll = next();
        if (roll < 0.6) {
          const resident = reference.has(name);
          const answer = client.model(name, "critical");
          assert.equal(answer !== undefined, resident, `seed ${seed} step ${done}: model(${name}) hit`);
          frameKeys.add(name);
          if (resident) reference.touch(name);
          else if (!asked.includes(name)) {
            asked.push(name);
            expectedRequests.set(name, (expectedRequests.get(name) ?? 0) + 1);
          }
        } else if (roll < 0.8) {
          // A prefetch hit renews recency without pinning; a miss would start background work.
          if (!reference.has(name)) continue;
          assert.ok(client.prefetchModel(name), `seed ${seed} step ${done}: prefetch hit ${name}`);
          reference.touch(name);
        } else {
          // Group demand pins the model for the frame; a model without a WMO is not touched.
          client.requestModelGroups(name, [0]);
          frameKeys.add(name);
        }
      }
      if (reference.entries.size - limit > 16) bigCommits++;
      client.endResourceFrame();
      reference.active = frameKeys;
      reference.evict();
      await settle();
      for (const name of asked) reference.store(name);
      const resident = names.filter((name) => client.modelState(name) !== "pending");
      const expected = names.filter((name) => reference.has(name));
      assert.deepEqual(resident, expected, `seed ${seed} after step ${done}: resident models`);
    }
    for (const name of names) {
      assert.equal(requests.get(name) ?? 0, expectedRequests.get(name) ?? 0, `seed ${seed}: requests for ${name}`);
    }
    client.dispose();
    return bigCommits;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("P1-10a: model eviction follows the re-insertion LRU over 2000 random operations", async () => {
  for (const seed of [1, 2, 3, 4]) await replay(seed, 500);
});

test("P1-10a: a commit that overflows by more than 16 evicts in the same order (sorted path)", async () => {
  let bigCommits = 0;
  for (const seed of [5, 6, 7, 8]) bigCommits += await replay(seed, 600, { big: true });
  assert.ok(bigCommits >= 4, `the sorted path ran (${bigCommits} commits)`);
});

test("P1-10a: renumbering the stamps mid-run keeps the eviction order", async () => {
  setRecencyStampLimitForTests(5);
  try {
    for (const seed of [9, 10]) await replay(seed, 500);
    await replay(11, 500, { big: true });
  } finally {
    setRecencyStampLimitForTests();
  }
});

test("P1-10a: model hits are stamped in place and the frame sets are not rebuilt at commit", async () => {
  const source = await readFile(new URL("../src/browser/Terrain.ts", import.meta.url), "utf8");
  const body = (head) => {
    const start = source.indexOf(`  ${head}(`);
    assert.ok(start >= 0, head);
    return source.slice(start, source.indexOf("\n  }\n", start));
  };
  assert.doesNotMatch(body("#touchModel"), /\.delete\(/, "#touchModel re-inserts nothing");
  assert.doesNotMatch(body("#lookupModel"), /\.delete\(/, "#lookupModel re-inserts nothing");
  assert.doesNotMatch(body("endResourceFrame"), /new (Set|Map)/, "endResourceFrame allocates no frame sets");
});
}

// ── environment-model-state.test.mjs
{
// 05.10-A7b-9 (7.18): what the environment client knows about one model, without asking for it,
// and what the tiles under the player could not carry.

const settle = async () => {
  for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setImmediate(resolve));
};
const visual = () => {
  const data = new ArrayBuffer(16);
  new Uint8Array(data).set([0x57, 0x56, 0x4d, 0x31]);
  return { ok: true, status: 200, arrayBuffer: async () => data };
};
const hull = () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
const status = (code) => ({ ok: false, status: code, arrayBuffer: async () => new ArrayBuffer(0) });

/** A gateway that answers each model by its basename's prefix. */
function gateway(t, now = () => 0) {
  const calls = [];
  const pending = [];
  t.mock.method(globalThis, "fetch", (url) => {
    const parsed = new URL(String(url));
    const path = parsed.searchParams.get("path") ?? decodeURIComponent(parsed.pathname.split("/").at(-1));
    calls.push(parsed.pathname);
    const base = path.replaceAll("\\", "/").split("/").at(-1);
    const fallback = parsed.pathname.startsWith("/environment/model/");
    if (base.startsWith("Slow")) return new Promise((resolve) => pending.push(resolve));
    if (base.startsWith("Real")) return Promise.resolve(visual());
    if (base.startsWith("Shell")) return Promise.resolve(fallback ? hull() : status(404));
    if (base.startsWith("Gone")) return Promise.resolve(status(404));
    return Promise.resolve(status(500));
  });
  const client = new EnvironmentClient("ws://example.test/world", now);
  t.after(async () => {
    client.dispose();
    for (const resolve of pending) resolve(visual());
    await settle();
  });
  return { client, calls };
}

test("modelState tells the four outcomes apart, and asking it requests nothing", async (t) => {
  const { client, calls } = gateway(t);
  assert.equal(client.modelState("World\\Never.m2"), "pending", "nothing says it never will be");
  assert.equal(calls.length, 0, "modelState is a read, not a demand");
  for (const name of ["World\\Slow.m2", "World\\Real.m2", "World\\Shell.wmo", "World\\Gone.m2"]) client.model(name);
  await settle();
  assert.equal(client.modelState("World\\Slow.m2"), "pending");
  assert.equal(client.modelState("World\\Real.m2"), "resident");
  assert.equal(client.modelState("World\\Shell.wmo"), "hull", "a collision hull is not the building");
  assert.equal(client.modelState("World\\Gone.m2"), "missing", "a 404 is not a model on its way");
  const before = calls.length;
  for (let frame = 0; frame < 5; frame++) client.modelState("World\\Gone.m2");
  assert.equal(calls.length, before);
});

test("a model whose retries ran out is failed; one waiting for its retry is still pending", async (t) => {
  let clock = 0;
  const { client } = gateway(t, () => clock);
  client.model("World\\Broken.m2");
  await settle();
  assert.equal(client.modelState("World\\Broken.m2"), "pending", "a 500 is a fact about this second");
  for (const wait of IMAGE_RETRY_BACKOFF_MS) {
    clock += wait;
    client.model("World\\Broken.m2");
    await settle();
  }
  assert.equal(client.modelState("World\\Broken.m2"), "failed");
});

test("tileLosses sums what the tiles under the player could not carry", async (t) => {
  const centre = (grid) => (31.5 - grid) * TERRAIN_GRID_SIZE;
  const good = { id: 1, kind: "m2", name: "World\\Tree.m2", x: centre(32), y: centre(32), z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  const bad = { id: 2, kind: "m2", name: 7 };
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = new URL(String(url)).pathname;
    const loaded = path.endsWith("/7/32/32");
    return new Response(JSON.stringify(loaded ? [good, bad] : []), {
      status: 200,
      headers: loaded ? { "content-type": "application/json", "x-tile-truncated": "3" } : { "content-type": "application/json" },
    });
  });
  const client = new EnvironmentClient("ws://example.test/world");
  t.after(() => client.dispose());
  assert.deepEqual(client.tileLosses(), { rejected: 0, truncated: 0, generator: 0 });
  client.objectsAround(7, centre(32), centre(32));
  await settle();
  assert.deepEqual(client.tileLosses(), { rejected: 1, truncated: 0, generator: 3 });
  // The player left: the losses of a tile nobody stands on are not this scene's.
  client.objectsAround(1, centre(32), centre(32));
  assert.deepEqual(client.tileLosses(), { rejected: 0, truncated: 0, generator: 0 });
});
}
