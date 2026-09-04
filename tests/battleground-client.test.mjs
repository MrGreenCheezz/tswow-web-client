import assert from "node:assert/strict";
import test from "node:test";

import {
  BATTLEGROUND_TYPE_IDS,
  BattlegroundClient,
} from "../dist/code/browser/BattlegroundMetadata.js";
import {
  FRAMEXML_BATTLEGROUND_TYPE_IDS,
  FRAMEXML_CANNED_BATTLEGROUNDS,
  FrameXmlBattlegroundClient,
} from "../dist/code/browser/framexml/FrameXmlBattlegrounds.js";

test("native and FrameXML battleground consumers share one metadata client contract", async (context) => {
  assert.equal(FrameXmlBattlegroundClient, BattlegroundClient);
  assert.equal(FRAMEXML_BATTLEGROUND_TYPE_IDS, BATTLEGROUND_TYPE_IDS);

  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => FRAMEXML_CANNED_BATTLEGROUNDS };
  };

  const client = new BattlegroundClient("http://127.0.0.1:62483/world");
  const [first, second] = await Promise.all([client.load(), client.load()]);
  assert.equal(first, second, "concurrent consumers must share one request and one catalog identity");
  assert.equal(client.catalog, first);
  assert.equal(client.ready, true);
  assert.deepEqual(urls, ["http://127.0.0.1:62483/dbc/battlegrounds"]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0].maps), true);

  assert.equal(await client.load(), first, "a loaded catalog remains synchronous and fetch-free");
  assert.equal(urls.length, 1);
});

test("the shared client rejects a malformed catalog once and reports the native-readable error", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => [] };
  };

  const statuses = [];
  const client = new BattlegroundClient("http://127.0.0.1:62483");
  client.onStatus = (message, error) => statuses.push([message, error]);
  assert.equal(await client.load(), undefined);
  assert.equal(client.ready, false);
  assert.match(statuses[0][0], /malformed battleground catalog/);
  assert.equal(statuses[0][1], true);
  assert.equal(await client.load(), undefined);
  assert.equal(calls, 1, "a failed dataset is not hammered by every repaint");
});
