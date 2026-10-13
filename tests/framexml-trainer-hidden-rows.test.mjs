// Plan item 3.29 (13.10): the trainer window's whole row array as Wow.exe 3.3.5a 12340 keeps it — hidden rows
// after the visible ones, reached by every index function (DAT_00c0e4a0), sorted by the CRT qsort 0x0040be50
// (VS2005) — and the collapse and line filter surviving everything but a new list (0x00596450 vs 0x00596b00).
import assert from "node:assert/strict";
import test from "node:test";

const { frameXmlMsvcQsort } = await import("../dist/code/browser/framexml/FrameXmlMsvcQsort.js");
const { frameXmlTrainerSort, frameXmlTrainerSortedSelection } =
  await import("../dist/code/browser/framexml/FrameXmlTrainerSort.js");
const { FrameXmlTrainerList } = await import("../dist/code/browser/framexml/FrameXmlTrainerGroups.js");
const { FrameXmlTrainerListChanges } = await import("../dist/code/browser/framexml/FrameXmlTrainerListChange.js");
const { frameXmlTrainerBuyAll } = await import("../dist/code/browser/framexml/FrameXmlTrainerSkillLines.js");

const byKey = (a, b) => a.key - b.key;
const items = (keys) => [...keys].map((key, index) => ({ key: Number(key), name: String.fromCharCode(97 + index) }));
const names = (list) => list.map((item) => item.name).join("");

test("the VS2005 qsort: shortsort moves the first of equal maxima last; a 9-run partitions then shortsorts", () => {
  const three = items("000");
  frameXmlMsvcQsort(three, byKey);
  assert.equal(names(three), "bca", "selection of the maximum into the last place, from the left");
  const nine = items("101010101");
  frameXmlMsvcQsort(nine, byKey);
  assert.equal(names(nine), "bfdhegcai", "median of three, the partition walk, then shortsort of 0..7");
  const ten = items("0000000000");
  frameXmlMsvcQsort(ten, byKey);
  assert.equal(names(ten), "abcdefghij", "an all-equal run over 8 is left as it is");
  const even = items("1010101010");
  frameXmlMsvcQsort(even, byKey);
  assert.equal(names(even), "fbhdjgciae", "the middle of an even run is lo + size/2; the pivot follows its swap");
  for (let seed = 1; seed <= 40; seed += 1) {
    let state = seed * 2654435761 >>> 0;
    const random = Array.from({ length: 1 + (seed * 7) % 60 }, () => {
      state = (state * 1103515245 + 12345) >>> 0;
      return { key: state % 9, name: "" };
    });
    frameXmlMsvcQsort(random, byKey);
    for (let index = 1; index < random.length; index += 1) assert.ok(random[index - 1].key <= random[index].key, `seed ${seed}`);
  }
});

/** A mage's lines, as framexml-trainer-groups.test.mjs has them. */
const LINES = { 8: "Огонь", 6: "Магия льда", 237: "Тайная магия" };
const SPELLS = {
  133: { name: "Огненный шар", rank: "Уровень 1", line: 8 },
  143: { name: "Огненный шар", rank: "Уровень 2", line: 8 },
  116: { name: "Ледяная стрела", rank: "Уровень 1", line: 6 },
  1459: { name: "Чародейский интеллект", rank: "Уровень 1", line: 237 },
};
function row(spellId, usable, requiredLevel = 1) {
  return { spellId, usable, moneyCost: 100, pointCost: [0, 0], requiredLevel, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0] };
}
function source(shown = [true, true, false]) {
  return {
    tradeskill: false,
    state: (r) => r.usable,
    group: (r) => SPELLS[r.spellId]?.line ?? 0,
    groupName: (id) => LINES[id],
    name: (r) => SPELLS[r.spellId].name,
    rank: (r) => SPELLS[r.spellId].rank,
    shown: (state) => shown[state],
  };
}
const describe = (entries) => entries.map((entry) => entry.header ? `[${entry.name}${entry.expanded ? "" : " +"}]` : `${entry.row.spellId}`);

test("the hidden rows stay after the visible ones in the qsort's order, not packet order", () => {
  const rows = [row(133, 0, 1), row(143, 0, 4), row(116, 0, 4), row(1459, 0, 1)];
  const sorted = frameXmlTrainerSort(rows, source(), new Set([8]));
  assert.equal(sorted.visible, 5);
  // Laid out 133 143 116 1459 [Магия льда] [Огонь] [Тайная магия]; shortsort of 7 leaves the collapsed
  // Огонь services reversed behind the visible rows.
  assert.deepEqual(describe(sorted.entries),
    ["[Магия льда]", "116", "[Огонь +]", "[Тайная магия]", "1459", "143", "133"]);
  assert.equal(frameXmlTrainerSortedSelection(sorted), 116);
  // A rebuild sorts the array as it stands (0x00594ba0): the same shortsort now puts them back.
  const again = frameXmlTrainerSort(rows, source(), new Set([8]), undefined, sorted.entries);
  assert.deepEqual(describe(again.entries).slice(5), ["133", "143"]);
  // Nothing visible available: the array's second element, hidden or not (0x00594ba0's tail).
  const none = frameXmlTrainerSort([row(133, 1, 1), row(143, 1, 4)], source(), new Set([8]));
  assert.deepEqual(describe(none.entries), ["[Огонь +]", "143", "133"]);
  assert.equal(frameXmlTrainerSortedSelection(none), 143);
});

test("an index past the visible rows reaches a hidden row; «everything» stops at the visible ones", () => {
  const rows = [row(133, 0, 1), row(143, 0, 4), row(116, 0, 4), row(1459, 0, 1)];
  const list = new FrameXmlTrainerList({ ...source(), rows: () => rows, describable: () => true, grouped: () => true });
  list.listChanged();
  assert.equal(list.setExpanded(3, false), true, "row 3 is the Огонь header");
  assert.equal(list.count(), 5, "GetNumTrainerServices: the visible rows");
  assert.deepEqual(list.info(6), ["Огненный шар", "Уровень 2", "available", true], "GetTrainerServiceInfo(6)");
  assert.equal(list.service(7)?.spellId, 133, "BuyTrainerService(7) and the cost/icon lookups reach 133");
  assert.equal(list.service(8), undefined, "past the whole array: nothing");
  list.select(6);
  assert.equal(list.selectionIndex(), 6, "SelectTrainerService reaches a hidden row too");
  const bought = [];
  frameXmlTrainerBuyAll(list.entries(), (id) => bought.push(id));
  assert.deepEqual(bought, [116, 1459], "BuyTrainerService(0): the visible available rows only");
});

test("a state change keeps the collapse, the line filter and the array's order; a new list resets them", () => {
  let rows = [row(133, 0, 1), row(143, 0, 4), row(116, 0, 4), row(1459, 0, 1)];
  const list = new FrameXmlTrainerList({ ...source(), rows: () => rows, describable: () => true, grouped: () => true });
  list.listChanged();
  list.setExpanded(3, false);
  assert.equal(list.setSkillLineFilter(2, false, false), true, "Тайная магия off");
  assert.deepEqual(describe(list.entries()), ["[Магия льда]", "116", "[Огонь +]"]);
  rows = [row(133, 0, 1), row(143, 0, 4), row(116, 2, 4), row(1459, 0, 1)]; // 116 learned: a new packet object
  list.stateChanged();
  assert.deepEqual(describe(list.entries()), ["[Огонь +]"], "116 used and filtered; Огонь still collapsed, the line still off");
  assert.equal(list.skillLineFilter(2), false);
  list.listChanged();
  assert.deepEqual(describe(list.entries()), ["[Огонь]", "133", "143", "[Тайная магия]", "1459"],
    "a new list: every line expanded and on");
});

test("WorldClient's callbacks: a purchase's answer changes no list, its refresh is a state change", () => {
  const changes = new FrameXmlTrainerListChanges();
  const first = { guid: 7n };
  assert.equal(changes.classify({ trainer: first }), "list");
  assert.equal(changes.classify({ trainer: first, merchantMessage: { error: false } }), "none", "BUY_SUCCEEDED");
  const refreshed = { guid: 7n };
  assert.equal(changes.classify({ trainer: refreshed }), "state", "the list WorldClient asked again");
  assert.equal(changes.classify({ trainer: refreshed, merchantMessage: { error: true } }), "none", "BUY_FAILED asks nothing");
  assert.equal(changes.classify({ trainer: { guid: 7n } }), "list", "a new talk to the same trainer");
  assert.equal(changes.classify({ trainer: { guid: 9n } }), "list", "another trainer");
  assert.equal(changes.classify({}), "list", "closed");
  assert.equal(changes.classify({}), "none");
});
