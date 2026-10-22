// 22.10 (6.26): what the client keeps between sessions (PersistentAssetStore.ts): keys carry the gateway, the kind and
// the generation; another generation never answers and is dropped on first use; the spaces are bounded, least
// recently used first; a failing backend is "nothing kept", never an error.
import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryAssetBackend, PersistentAssetStore, persistentAssetKey,
} from "../dist/code/browser/PersistentAssetStore.js";

const GATEWAY = "http://127.0.0.1:8090";

function storeWith(limits = { rows: 100, blobs: 100 }) {
  let clock = 1_000;
  const backend = new MemoryAssetBackend();
  const store = new PersistentAssetStore(backend, limits, () => clock);
  return { backend, store, tick: (ms = 1) => { clock += ms; } };
}

test("a record is filed under gateway, kind and generation, and only that generation reads it back", async () => {
  const { backend, store } = storeWith();
  store.put("rows", GATEWAY, "creature-display-v14", "g1", [["49", { id: 49 }], ["50", { id: 50 }]]);
  await store.flush();
  assert.ok(backend.spaces.rows.has(persistentAssetKey(GATEWAY, "creature-display-v14", "g1", "49")));
  assert.deepEqual(await store.getMany("rows", GATEWAY, "creature-display-v14", "g1", ["49", "51", "50"]),
    [{ id: 49 }, undefined, { id: 50 }]);
  assert.deepEqual(await store.getMany("rows", GATEWAY, "creature-display-v13", "g1", ["49"]), [undefined], "another kind");
  assert.deepEqual(await store.getMany("rows", "http://other:8090", "creature-display-v14", "g1", ["49"]), [undefined],
    "another gateway");
  assert.equal(await store.get("rows", GATEWAY, "creature-display-v14", "g1", "49").then((row) => row.id), 49);
});

test("the first use of a new generation drops the old one, and the old one never answers", async () => {
  const first = storeWith();
  first.store.put("rows", GATEWAY, "kind", "old", [["1", "a"]]);
  first.store.put("rows", GATEWAY, "other-kind", "old", [["1", "kept"]]);
  await first.store.flush();
  // The next session: same disk, a gateway that publishes a new generation.
  const next = new PersistentAssetStore(first.backend, { rows: 100, blobs: 100 });
  assert.deepEqual(await next.getMany("rows", GATEWAY, "kind", "new", ["1"]), [undefined]);
  await next.flush();
  assert.equal(first.backend.spaces.rows.has(persistentAssetKey(GATEWAY, "kind", "old", "1")), false, "dropped");
  assert.equal(first.backend.spaces.rows.has(persistentAssetKey(GATEWAY, "other-kind", "old", "1")), true,
    "another kind keeps its own generation until it is used");
  // A generation whose name starts like the kept one's is another generation all the same.
  next.put("rows", GATEWAY, "kind", "new", [["2", "b"]]);
  next.put("rows", GATEWAY, "kind", "newer", [["3", "c"]]);
  await next.flush();
  const after = new PersistentAssetStore(first.backend, { rows: 100, blobs: 100 });
  assert.deepEqual(await after.getMany("rows", GATEWAY, "kind", "new", ["2", "3"]), ["b", undefined]);
  await after.flush();
  assert.equal(first.backend.spaces.rows.has(persistentAssetKey(GATEWAY, "kind", "newer", "3")), false);
});

test("a space is bounded by count, the least recently used going first; a read counts as a use", async () => {
  const { backend, store, tick } = storeWith({ rows: 3, blobs: 2 });
  for (const id of ["a", "b", "c"]) {
    store.put("blobs", GATEWAY, "atlas", "g", [[id, id]]);
    tick();
  }
  await store.flush();
  assert.equal(backend.spaces.blobs.size, 2, "bounded");
  assert.deepEqual(await store.getMany("blobs", GATEWAY, "atlas", "g", ["a", "b", "c"]), [undefined, "b", "c"], "oldest out");
  // A new session reads `b`, which makes `c` the least recently used.
  const later = new PersistentAssetStore(backend, { rows: 3, blobs: 2 }, () => 5_000);
  assert.equal(await later.get("blobs", GATEWAY, "atlas", "g", "b"), "b");
  later.put("blobs", GATEWAY, "atlas", "g", [["d", "d"]]);
  await later.flush();
  assert.deepEqual(await later.getMany("blobs", GATEWAY, "atlas", "g", ["b", "c", "d"]), ["b", undefined, "d"]);
  assert.ok(later.stats.evicted >= 1);
});

test("a miss costs no database read once the generation's ids are listed", async () => {
  const backend = new MemoryAssetBackend();
  let reads = 0;
  const counted = Object.assign(Object.create(Object.getPrototypeOf(backend)), backend, {
    getMany: async (space, keys) => { reads++; return backend.getMany(space, keys); },
    keys: (space, prefix) => backend.keys(space, prefix),
  });
  const store = new PersistentAssetStore(counted, { rows: 10, blobs: 10 });
  assert.deepEqual(await store.getMany("rows", GATEWAY, "kind", "g", ["1", "2"]), [undefined, undefined]);
  assert.equal(reads, 0, "nothing stored: answered from the listing");
  store.put("rows", GATEWAY, "kind", "g", [["1", "one"]]);
  await store.flush();
  assert.deepEqual(await store.getMany("rows", GATEWAY, "kind", "g", ["1", "2"]), ["one", undefined]);
  assert.equal(reads, 1, "only the id it holds is read");
});

test("a backend that fails keeps nothing and throws nothing", async () => {
  const failing = {
    getMany: async () => { throw new Error("quota"); },
    put: async () => { throw new Error("quota"); },
    touch: async () => { throw new Error("quota"); },
    deleteOtherGenerations: async () => { throw new Error("quota"); },
    evict: async () => { throw new Error("quota"); },
    keys: async () => { throw new Error("blocked"); },
  };
  const store = new PersistentAssetStore(failing, { rows: 10, blobs: 10 });
  assert.deepEqual(await store.getMany("rows", GATEWAY, "kind", "g", ["1"]), [undefined]);
  store.put("rows", GATEWAY, "kind", "g", [["1", "x"]]);
  await store.flush();
  assert.ok(store.stats.failures > 0);
});
