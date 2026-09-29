import assert from "node:assert/strict";
import test from "node:test";

function makeNode(tag, id) {
  return {
    tagName: String(tag).toUpperCase(), id: id ?? "", children: [], dataset: {},
    className: "", textContent: "", hidden: false, value: "",
    append(...children) { children.forEach(() => {}); },
    replaceChildren() {}, addEventListener() {}, setAttribute() {},
    querySelector() { return makeNode("button"); },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

const byId = new Map();
globalThis.document = {
  createElement: (tag) => makeNode(tag),
  body: makeNode("body"),
  documentElement: makeNode("html"),
  getElementById: (id) => {
    if (!byId.has(id)) byId.set(id, makeNode("div", id));
    return byId.get(id);
  },
  querySelectorAll: () => [],
  hidden: false,
};
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };

const quality = await import("../dist/code/browser/AutoQuality.js");

const bad = { average: 30, p50: 30, p95: 30, p99: 35, count: 120 };
const good = { average: 10, p50: 10, p95: 10, p99: 12, count: 120 };
const thin = { average: 30, p50: 30, p95: 30, p99: 35, count: 5 };

test("two bad windows step down the ladder, twelve good ones step back up", () => {
  quality.resetAutoQuality();
  quality.setAutoQualityCeiling(100);
  assert.equal(quality.autoQualityStatus().effective, 100);
  quality.updateAutoQuality(5000, () => bad);
  assert.equal(quality.autoQualityStatus().effective, 100, "one bad window is a hiccup, not a trend");
  quality.updateAutoQuality(10000, () => bad);
  assert.equal(quality.autoQualityStatus().effective, 85);
  quality.updateAutoQuality(15000, () => bad);
  quality.updateAutoQuality(20000, () => bad);
  assert.equal(quality.autoQualityStatus().effective, 70);
  for (let step = 0; step < 11; step++) quality.updateAutoQuality(25000 + step * 5000, () => good);
  assert.equal(quality.autoQualityStatus().effective, 70, "eleven good windows are not a recovery yet");
  quality.updateAutoQuality(25000 + 11 * 5000, () => good);
  assert.equal(quality.autoQualityStatus().effective, 85, "twelve good windows climb one rung");
  quality.resetAutoQuality();
});

test("thin windows are ignored, the floor holds, and recovery climbs rung by rung", () => {
  quality.resetAutoQuality();
  quality.setAutoQualityCeiling(100);
  quality.updateAutoQuality(5000, () => thin);
  quality.updateAutoQuality(10000, () => bad);
  assert.equal(quality.autoQualityStatus().effective, 100, "thin frames are not data, one bad window is a hiccup");
  quality.updateAutoQuality(15000, () => bad);
  assert.equal(quality.autoQualityStatus().effective, 85);
  for (let pair = 0; pair < 3; pair++) {
    quality.updateAutoQuality(20000 + pair * 10000, () => bad);
    quality.updateAutoQuality(25000 + pair * 10000, () => bad);
  }
  assert.equal(quality.autoQualityStatus().effective, 40, "the ladder floor holds under endless pressure");
  quality.updateAutoQuality(55000, () => bad);
  quality.updateAutoQuality(60000, () => bad);
  assert.equal(quality.autoQualityStatus().effective, 40, "never below the manual slider's own minimum");
  for (let round = 0; round < 4; round++) {
    for (let step = 0; step < 12; step++) quality.updateAutoQuality(65000 + (round * 12 + step) * 5000, () => good);
  }
  assert.equal(quality.autoQualityStatus().effective, 100, "recovers to the ceiling, never above it");
  quality.resetAutoQuality();
});

test("the settings store always wins over the last ceiling call", () => {
  quality.resetAutoQuality();
  quality.setAutoQualityCeiling(70);
  assert.equal(quality.autoQualityStatus().effective, 70);
  // The stub store reports the default slider value (100): the next tick re-reads it.
  quality.updateAutoQuality(5000, () => good);
  assert.equal(quality.autoQualityStatus().ceiling, 100, "a live slider move takes effect at once");
  quality.resetAutoQuality();
});
