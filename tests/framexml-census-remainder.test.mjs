import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.31: the five names the boot census still listed as unanswered are documented no-ops
// now, and a module that defines one of them still replaces the census stub with its own function.
const { FRAMEXML_NEUTRAL_API } = await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { FRAMEXML_CENSUS_REMAINDER_NEUTRAL } = await import("../dist/code/browser/framexml/FrameXmlCensusRemainder.js");

const NAMES = ["LocalizeFrames", "RaidGroupFrame_Update", "CombatText_UpdateDisplayedMessages",
  "ArenaEnemyBackground_SetOpacity", "BNToastFrame_OnUpdate"];

test("the five census names are neutral rows that answer nothing and quote the stock call site", () => {
  assert.deepEqual(FRAMEXML_CENSUS_REMAINDER_NEUTRAL.map((entry) => entry.name), [...NAMES, "SetEuropeanNumbers"]);
  for (const name of [...NAMES, "SetEuropeanNumbers"]) {
    const entry = FRAMEXML_NEUTRAL_API.find((candidate) => candidate.name === name);
    assert.ok(entry, `${name} is in the neutral table`);
    assert.deepEqual(entry.values, [], `${name} answers nothing`);
    assert.match(entry.reason, /\w+\.(lua|xml):\d+/, `${name} names the stock caller`);
  }
});

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
let chain;
after(() => chain?.close());

const decoder = new TextDecoder("utf-8");

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "census-remainder-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("over the stock corpus: each name answers nothing, the census reports it answered, and the LoD modules keep their own", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  chain ??= await clientArchives(clientDirectory);
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(), exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  const errors = boot.errorCount;

  // RaidFrame.lua:81 reached RaidGroupFrame_Update during load: the census records an answer for it.
  const raidRecord = inventory.api.find((record) => record.name === "RaidGroupFrame_Update");
  assert.ok(raidRecord, "RaidGroupFrame_Update was reached during load");
  assert.equal(raidRecord.neutral, "—");
  for (const record of inventory.api.filter((candidate) => NAMES.includes(candidate.name))) {
    assert.notEqual(record.neutral, "", `${record.name} is not unanswered`);
  }

  for (const name of NAMES) {
    assert.deepEqual(lua(boot, `return type(${name}), select("#", ${name}())`, 2), ["function", 0], name);
  }
  assert.equal(boot.errorCount, errors);

  // The census stub is in _G now; the module's own definition must replace it on load.
  lua(boot, "__stubRaid, __stubArena = RaidGroupFrame_Update, ArenaEnemyBackground_SetOpacity", 0);
  const raid = await boot.loadAddon("Blizzard_RaidUI");
  const arena = await boot.loadAddon("Blizzard_ArenaUI");
  assert.deepEqual([raid.status, arena.status], ["loaded", "loaded"]);
  assert.deepEqual(lua(boot, `return rawget(_G, "RaidGroupFrame_Update") ~= __stubRaid,
    rawget(_G, "ArenaEnemyBackground_SetOpacity") ~= __stubArena`, 2), [true, true]);
});

test("follow-up: Localization.xml loads at its stock slot; ruRU LocalizeFrames runs clean and SetEuropeanNumbers is answered", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  chain ??= await clientArchives(clientDirectory);
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  assert.equal(FRAMEXML_VERTICAL_TOC[FRAMEXML_VERTICAL_TOC.indexOf("FontStyles.xml") + 1], "Localization.xml",
    "FrameXML.toc: GlobalStrings, Constants, Fonts, FontStyles, Localization");
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(), exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, "return LOCALE_ruRU, CATEGORY_TO_NOT_DISPLAY", 2), [true, undefined], "Localization.lua ran; LocalizeFrames not yet");
    assert.deepEqual(lua(boot, `LocalizeFrames()
      local point, relative, relativePoint, x, y = PlayerHitIndicator:GetPoint(1)
      return CATEGORY_TO_NOT_DISPLAY, point, relative and relative:GetName(), relativePoint, x, y`, 6),
    [9, "LEFT", "PlayerFrame", "TOPLEFT", 62, -42]);
    assert.equal(boot.errorCount, errors, "no Lua error");
    const record = inventory.api.find((candidate) => candidate.name === "SetEuropeanNumbers");
    assert.ok(!record || record.neutral !== "", "SetEuropeanNumbers is never an unanswered name");
    assert.deepEqual(lua(boot, `return select("#", SetEuropeanNumbers(true))`, 1), [0]);
  } finally { boot.close?.(); }
});
