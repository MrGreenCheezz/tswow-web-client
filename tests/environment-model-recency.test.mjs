import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EnvironmentClient } from "../dist/code/browser/Terrain.js";
import { setRecencyStampLimitForTests } from "../dist/code/browser/RecencyStamps.js";

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
