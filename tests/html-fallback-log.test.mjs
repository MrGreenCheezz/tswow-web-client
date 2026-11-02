// 4.17 stage 1: what the temporary watch counts, and what it takes for an HTML surface on the page.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HtmlFallbackLog, parseHtmlFallbackLog, visibleHtmlSurfaces,
} from "../dist/code/browser/ui/HtmlFallbackLog.js";

const seen = (...names) => new Set(names);

test("an appearance is counted once however many looks it stays for", () => {
  const log = new HtmlFallbackLog();
  assert.deepEqual(log.observe(seen("#vendor-window"), 1000), ["#vendor-window"]);
  assert.deepEqual(log.observe(seen("#vendor-window"), 1500), []);
  assert.deepEqual(log.observe(seen("#vendor-window"), 2000), []);
  const [entry] = log.entries(2000);
  assert.equal(entry.times, 1);
  assert.equal(entry.shownMs, 1000);
  assert.equal(entry.firstAt, 1000);
});

test("leaving and coming back is a second appearance, and the time between is not counted", () => {
  const log = new HtmlFallbackLog();
  log.observe(seen("#loot-window"), 0);
  log.observe(seen(), 400);
  assert.deepEqual(log.observe(seen("#loot-window"), 10_000), ["#loot-window"]);
  log.observe(seen(), 10_100);
  const [entry] = log.entries(20_000);
  assert.equal(entry.times, 2);
  assert.equal(entry.shownMs, 500);
  assert.equal(entry.lastAt, 10_100);
});

test("asking for the report counts what is on screen without counting it twice", () => {
  const log = new HtmlFallbackLog();
  log.observe(seen("#trade-window"), 0);
  assert.equal(log.entries(300)[0].shownMs, 300);
  assert.equal(log.entries(300)[0].shownMs, 300);
  assert.equal(log.entries(500)[0].shownMs, 500);
  assert.deepEqual(log.observe(seen("#trade-window"), 600), [], "the report did not end the appearance");
});

test("a saved log carries on, and the most frequent surface comes first", () => {
  const log = new HtmlFallbackLog(parseHtmlFallbackLog(JSON.stringify([
    { name: "#mail-window", times: 1, shownMs: 50, firstAt: 1, lastAt: 2 },
    { name: "#bank", times: 3, shownMs: 10, firstAt: 1, lastAt: 2 },
  ])));
  log.observe(seen("#mail-window"), 100);
  log.observe(seen(), 200);
  log.observe(seen("#mail-window"), 300);
  log.observe(seen(), 400);
  log.observe(seen("#mail-window"), 500);
  const entries = log.entries(600);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.times]), [["#mail-window", 4], ["#bank", 3]]);
  assert.equal(entries[0].firstAt, 1, "the first sighting is the saved one");
});

test("whatever else a browser kept reads as an empty log", () => {
  assert.deepEqual(parseHtmlFallbackLog(null), []);
  assert.deepEqual(parseHtmlFallbackLog("{not json"), []);
  assert.deepEqual(parseHtmlFallbackLog('{"name":"#a"}'), []);
  assert.deepEqual(parseHtmlFallbackLog('[null,{"name":"#a"},{"name":1,"times":1,"shownMs":1,"firstAt":1,"lastAt":1}]'), []);
});

function surface(id, { className = "", visible = true, width = 100, height = 50, children = [] } = {}) {
  return {
    id, className, children,
    checkVisibility: () => visible,
    getBoundingClientRect: () => ({ width, height }),
  };
}

test("a look reports the windows, looks inside the holders and passes over the rest", () => {
  const viewport = surface("world-viewport", { children: [
    surface("world-3d-canvas"),
    surface("framexml-world-host"),
    surface("diagnostics-window"),
    surface("vendor-window"),
    surface("trade-window", { visible: false }),
    surface("party-frames", { width: 0 }),
    surface("", { className: "bag-window framed" }),
    surface("", { className: "" }),
    surface("left-rail", { children: [surface("player-hud"), surface("player-auras", { visible: false })] }),
    surface("right-rail", { visible: false, children: [surface("boss-frames")] }),
  ] });
  assert.deepEqual([...visibleHtmlSurfaces(viewport)].sort(), ["#player-hud", "#vendor-window", ".bag-window", "(без имени)"].sort());
});

test("the watch is on for each world and tells a stock interface still coming up from HTML on screen", async () => {
  const enter = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(enter, /entryLifecycle\.track\(watchHtmlFallbacks\(\)\);/);
  const watch = await readFile(new URL("../src/browser/ui/HtmlFallbackWatch.ts", import.meta.url), "utf8");
  assert.match(watch, /nativeHudReplaced\(NATIVE_LANES_REPLACED\) \? visibleHtmlSurfaces\(viewport\) : new Set\(\[STOCK_NOT_UP\]\)/);
});
