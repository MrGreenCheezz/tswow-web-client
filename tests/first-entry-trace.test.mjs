// 10.29 (26.10): the first entry's trace — off without ?first-entry-trace; the world is the loading screen's hide
// after it was shown (a clean start hides it first); the gateway lets the page read its answers' sizes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { firstEntryMark, firstEntrySummary, firstEntryTracing, installFirstEntryTrace } from "../dist/code/browser/app/FirstEntryTrace.js";

test("off unless the address asks; on, the marks keep their order and the early hide is not the world", () => {
  class FakeSocket { addEventListener() {} }
  installFirstEntryTrace({ location: { search: "" }, WebSocket: FakeSocket });
  assert.equal(firstEntryTracing(), false);
  firstEntryMark("world");
  assert.match(String(firstEntrySummary()), /выключена/);
  const win = { location: { search: "?first-entry-trace" }, WebSocket: FakeSocket };
  installFirstEntryTrace(win);
  assert.equal(firstEntryTracing(), true);
  assert.notEqual(win.WebSocket, FakeSocket, "sockets are counted");
  firstEntryMark("world");
  firstEntryMark("loading");
  firstEntryMark("world");
  firstEntryMark("loading");
  assert.deepEqual(firstEntrySummary().marks.map((mark) => mark.mark), ["page", "loading", "world"]);
  assert.equal(typeof win.webclientFirstEntry, "function");
});

test("the gateway answers with Timing-Allow-Origin for the page's origins", async () => {
  const source = await readFile(new URL("../src/gateway/Gateway.ts", import.meta.url), "utf8");
  assert.match(source, /response\.setHeader\("timing-allow-origin", options\.allowedOrigins\.join\(", "\)\);/);
});
