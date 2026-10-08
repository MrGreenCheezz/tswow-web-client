// 05.10-5.17: LockType.dbc CursorName through /dbc/locks?v=1 — the gateway reads the column
// (gateway/LockMetadata.ts, tools/dbd/LockType.dbd), the browser asks the versioned route and hands
// the name to the hover cursor (LockClient.lockTypeCursor → input/Cursors.ts lockCursor).
import assert from "node:assert/strict";
import test from "node:test";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

test("the gateway's lock table carries every non-empty LockType CursorName", withDataset, async () => {
  const { loadLockData } = await import("../dist/code/gateway/LockMetadata.js");
  const data = await loadLockData(dbcDirectory);
  // Every non-empty CursorName of the dataset's LockType.dbc, read here with the tools' own reader;
  // the empty ones are left out. The base dataset (08.10) has 21 rows and the four stock names; the
  // install with modules also had its own 1000 «Лесозаготовка» → Mine.
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const table = await openDbcFile(dbcDirectory, "LockType");
  const expected = {};
  for (const row of table.rows()) {
    const cursor = table.string(row, "CursorName");
    if (cursor) expected[table.id(row)] = cursor;
  }
  assert.deepEqual(data.lockTypeCursors, expected);
  assert.deepEqual(Object.fromEntries(Object.entries(expected).filter(([id]) => Number(id) < 1000)),
    { 1: "PickLock", 2: "GatherHerbs", 3: "Mine", 19: "FishingCursor" }, "the four stock names");
  assert.ok(Object.keys(data.locks).length > 300, "the locks as before");
  assert.ok(data.openers.length > 100, "the openers as before");
});

test("the browser asks /dbc/locks?v=1 and answers a lock type's cursor; an older gateway's answer has none", async () => {
  const { LockClient } = await import("../dist/code/browser/LockClient.js");
  const realFetch = globalThis.fetch;
  const asked = [];
  let body = { locks: { 7: [{ type: 2, index: 1000, skill: 1 }] }, openers: [], lockTypeCursors: { 1000: "Mine", 1: "PickLock" } };
  globalThis.fetch = async (url) => { asked.push(String(url)); return { ok: true, json: async () => body }; };
  try {
    const client = new LockClient("ws://127.0.0.1:8090/ws");
    client.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(asked, ["http://127.0.0.1:8090/dbc/locks?v=1"]);
    assert.equal(client.lockTypeCursor(1000), "Mine");
    assert.equal(client.lockTypeCursor(4), undefined);
    body = { locks: {}, openers: [] };
    const old = new LockClient("ws://127.0.0.1:8090/ws");
    old.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(old.ready, true);
    assert.equal(old.lockTypeCursor(1000), undefined, "an older gateway: the stock names stand in");
  } finally {
    globalThis.fetch = realFetch;
  }
});
