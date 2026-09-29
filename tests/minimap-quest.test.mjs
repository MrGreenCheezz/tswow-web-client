import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  QUEST_STATUS_AVAILABLE,
  QUEST_STATUS_LOW_LEVEL_AVAILABLE,
  QUEST_STATUS_LOW_LEVEL_REWARD_REP,
  QUEST_STATUS_REWARD,
} from "../dist/code/world/QuestProtocol.js";

// `Minimap.ts` takes `rightRail` out of `Dom.ts` at import time: the stub answers any id.
const fakeNode = () => {
  const node = {
    children: [], dataset: {}, className: "", textContent: "", hidden: false, disabled: false,
    value: "", type: "",
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append() {}, appendChild(child) { return child; }, replaceChildren() {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector: () => fakeNode(), querySelectorAll: () => [],
  };
  return node;
};
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.document = {
  createElement: fakeNode, createElementNS: (_ns, _tag) => fakeNode(),
  body: fakeNode(), documentElement: fakeNode(), head: fakeNode(),
  getElementById: fakeNode, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
const { minimapQuestMark } = await import("../dist/code/browser/ui/Minimap.js");

// V9: quest givers mark the minimap with the plates' own `!`/`?` — the last thing the map
// could not say about the world around the player.

test("only quest-giving statuses mark, with the plate's own letters", () => {
  assert.equal(minimapQuestMark(QUEST_STATUS_REWARD), "?");
  assert.equal(minimapQuestMark(QUEST_STATUS_LOW_LEVEL_REWARD_REP), "?");
  assert.equal(minimapQuestMark(QUEST_STATUS_AVAILABLE), "!");
  assert.equal(minimapQuestMark(QUEST_STATUS_LOW_LEVEL_AVAILABLE), "!");
  assert.equal(minimapQuestMark(0), undefined, "no status is no mark");
  assert.equal(minimapQuestMark(1), undefined, "an uninvolved state draws nothing");
});

test("the marks are drawn as text at the giver's blip, in range", async () => {
  const source = await readFile(new URL("../src/browser/ui/Minimap.ts", import.meta.url), "utf8");
  assert.match(source, /minimapQuestMark\(status\)/, "every unit's giver status is read");
  assert.match(source, /strokeText\(mark, at\.column, at\.row\)/, "the letter is painted, outlined like the plates'");
  assert.match(source, /distanceSquared <= reachSquared/, "out-of-range givers stay off the map");
});
