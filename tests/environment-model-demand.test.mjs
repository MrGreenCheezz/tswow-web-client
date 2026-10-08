import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EnvironmentClient } from "../dist/code/browser/Terrain.js";
import { setRecencyStampLimitForTests } from "../dist/code/browser/RecencyStamps.js";

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
