import assert from "node:assert/strict";
import test from "node:test";

// This regression is MPQ-backed on purpose: the QuestLog cluster, its templates and Lua sidecars
// must come from the retail 3.3.5a client rather than a fixture that repeats their names.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const {
  FRAMEXML_TOC_PATH,
  FRAMEXML_VERTICAL_TOC,
} = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

const QUESTLOG_TOC = Object.freeze([
  "QuestFrame.xml",
  "QuestPOI.xml",
  "WatchFrame.xml",
  "QuestLogFrame.xml",
  "QuestInfo.xml",
]);
const QUESTLOG_FILES = Object.freeze([
  "interface/framexml/questframe.xml",
  "interface/framexml/questpoi.xml",
  "interface/framexml/watchframe.xml",
  "interface/framexml/questlogframe.xml",
  "interface/framexml/questinfo.xml",
  "interface/framexml/questframe.lua",
  "interface/framexml/questframetemplates.xml",
  "interface/framexml/questpoi.lua",
  "interface/framexml/watchframe.lua",
  "interface/framexml/questlogframe.lua",
  "interface/framexml/questinfo.lua",
]);
const HYBRID_FILES = Object.freeze([
  "interface/framexml/hybridscrollframe.lua",
  "interface/framexml/hybridscrollframe.xml",
]);
const HYBRID_TOC = Object.freeze([
  "HybridScrollFrame.lua",
  "HybridScrollFrame.xml",
]);
const QUESTLOG_ROOTS = Object.freeze([
  "QuestFrame",
  "WatchFrame",
  "QuestLogFrame",
  "QuestLogDetailFrame",
  "QuestInfoFrame",
]);
const QUESTLOG_TEMPLATES = Object.freeze([
  "QuestFramePanelTemplate",
  "QuestItemTemplate",
  "QuestTitleButtonTemplate",
  "QuestLogTitleButtonTemplate",
  "QuestLogRewardItemTemplate",
  "WatchFontTemplate",
  "WatchFrameLinkButtonTemplate",
  "WatchFrameItemButtonTemplate",
  "WatchFrameLineTemplate",
  "QuestInfoRewardItemTemplate",
  "QuestReputationTemplate",
  "QuestHonorFrameTemplate",
  "QuestArenaPointsFrameTemplate",
  "QuestTalentFrameTemplate",
  "QuestXPFrameTemplate",
  "QuestPlayerTitleFrameTemplate",
  "QuestPOITemplate",
  "QuestPOICompletedTemplate",
  "HybridScrollBarButton",
  "HybridScrollBarTemplate",
  "HybridScrollFrameTemplate",
  "BasicHybridScrollFrameTemplate",
]);
const HYBRID_FUNCTIONS = Object.freeze([
  "HybridScrollFrame_OnLoad",
  "HybridScrollFrame_OnValueChanged",
  "HybridScrollFrame_CreateButtons",
  "HybridScrollFrame_SetOffset",
]);
const QUESTLOG_WIDGETS = Object.freeze([
  ["QuestFramePortrait", "Texture"],
  ["QuestFrameCloseButton", "Button"],
  ["QuestFrameAcceptButton", "Button"],
  ["QuestFrameCompleteButton", "Button"],
  ["QuestLogFrameCloseButton", "Button"],
  ["QuestLogDetailFrameCloseButton", "Button"],
  ["QuestLogCount", "Frame"],
  ["QuestLogQuestCount", "FontString"],
  ["QuestInfoTitleHeader", "FontString"],
  ["QuestInfoItem1", "Button"],
  ["WatchFrameTitle", "FontString"],
  ["WatchFrameCollapseExpandButton", "Button"],
  ["QuestLogScrollFrame", "ScrollFrame"],
  ["QuestLogScrollFrameScrollBar", "Slider"],
]);
const EXPECTED_DELTA = Object.freeze({
  files: 11,
  bytes: 217_315,
  widgets: 891,
  roots: 8,
  templates: 18,
  lua: 5,
  luaFailed: 0,
});
const EXPECTED_CANDIDATE_ERRORS = Object.freeze([]);
const decoder = new TextDecoder("utf-8");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

async function loadFromMpq(chain, subset) {
  const requests = [];
  const provider = {
    async read(path) {
      requests.push(normalized(path));
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const boot = new FrameXmlBoot({
    provider,
    locale: "ruRU",
    subset,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, inventory, requests: new Set(requests) };
}

function metrics(inventory) {
  return {
    files: inventory.files.total,
    bytes: inventory.files.bytes,
    widgets: inventory.widgets.total,
    roots: inventory.widgets.roots,
    templates: inventory.widgets.templates,
    lua: inventory.lua.executed,
    luaFailed: inventory.lua.failed,
  };
}

function errorKey(error) {
  return `${error.file}:${error.line}:${error.message}`;
}

test("MPQ QuestLog vertical reaches stock roots, templates and key widgets", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    // Earlier slices may add an entry before QuestFrame (currently ReputationFrame.xml).  Anchor
    // this proof at QuestFrame itself and compare the exact before/after dependency delta below;
    // an absolute vertical length would turn an unrelated, intentional promotion into a QuestLog
    // regression.
    const questStart = FRAMEXML_VERTICAL_TOC.indexOf("QuestFrame.xml");
    assert.ok(questStart >= 0, "the bounded vertical contains QuestFrame.xml");
    assert.deepEqual(FRAMEXML_VERTICAL_TOC.slice(questStart, questStart + QUESTLOG_TOC.length),
      QUESTLOG_TOC,
    "QuestLog ownership occupies its measured stock slot before the bags tail");
    const hybridStart = FRAMEXML_VERTICAL_TOC.indexOf("ItemButtonTemplate.xml") + 1;
    assert.deepEqual(FRAMEXML_VERTICAL_TOC.slice(hybridStart, hybridStart + HYBRID_TOC.length),
      HYBRID_TOC,
    "HybridScrollFrame ownership stays at its measured stock slot before GameMenuFrame");

    const toc = await chain.read(FRAMEXML_TOC_PATH);
    assert.ok(toc, "FrameXML.toc is present in the MPQ chain");
    const realEntries = parseGlueToc(decoder.decode(toc), "interface/framexml/");
    const realPaths = realEntries.map((entry) => normalized(entry.path));
    const verticalPositions = FRAMEXML_VERTICAL_TOC.map((entry) => realPaths.indexOf(
      normalized(`interface/framexml/${entry}`),
    ));
    assert.ok(verticalPositions.every((position) => position >= 0),
      `every vertical entry is in the stock TOC: ${JSON.stringify(verticalPositions)}`);
    assert.ok(verticalPositions.every((position, index) => index === 0
      || position > verticalPositions[index - 1]),
    "vertical entries preserve stock TOC order");
    const questPositions = QUESTLOG_TOC.map((entry) => realPaths.indexOf(
      normalized(`interface/framexml/${entry}`),
    ));
    assert.deepEqual(questPositions, [82, 83, 84, 85, 86],
      "QuestLog entries occupy the measured consecutive stock TOC slots");
    const hybridPositions = HYBRID_TOC.map((entry) => realPaths.indexOf(
      normalized(`interface/framexml/${entry}`),
    ));
    assert.deepEqual(hybridPositions, [22, 23],
      "HybridScrollFrame entries occupy the measured consecutive stock TOC slots");

    const questEntries = new Set(QUESTLOG_TOC.map(normalized));
    baseline = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC.filter(
      (entry) => !questEntries.has(normalized(entry)),
    ));
    candidate = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC);

    for (const name of QUESTLOG_ROOTS) {
      assert.equal(baseline.boot.bridge.getFrame(name), undefined,
        `baseline does not have ${name}`);
    }
    const resolvedQuestFiles = QUESTLOG_FILES.filter((path) => candidate.requests.has(path));
    assert.deepEqual(resolvedQuestFiles, QUESTLOG_FILES,
      "the five XML entries resolve exactly their QuestFrameTemplates.xml and five Lua sidecars");
    for (const path of HYBRID_FILES) {
      assert.ok(baseline.requests.has(path), `${path} is the real HybridScrollFrame stock dependency`);
      assert.ok(candidate.requests.has(path), `${path} remains requested by the candidate`);
    }
    assert.equal(candidate.inventory.files.missing.length, 0,
      "QuestLog vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "QuestLog XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "QuestLog Lua sidecars execute successfully");

    const after = metrics(candidate.inventory);
    const before = metrics(baseline.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.deepEqual(delta, EXPECTED_DELTA,
      `exact QuestLog dependency-closure delta: ${JSON.stringify(delta)}`);

    for (const name of QUESTLOG_ROOTS) {
      const root = candidate.boot.bridge.getFrame(name);
      assert.ok(root, `${name} exists in the MPQ candidate`);
      assert.equal(root.type, "Frame", `${name} is a stock Frame root`);
    }
    for (const name of QUESTLOG_TEMPLATES) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template exists`);
    }
    for (const name of HYBRID_FUNCTIONS) {
      assert.ok(candidate.boot.vm.globalFunction(name), `${name} comes from real HybridScrollFrame.lua`);
      assert.equal(candidate.inventory.api.some((record) => record.name === name), false,
        `${name} is defined by the stock Lua sidecar rather than a stub`);
    }
    for (const [name, type] of QUESTLOG_WIDGETS) {
      const widget = candidate.boot.bridge.getFrame(name);
      assert.ok(widget, `${name} exists in the stock QuestLog cluster`);
      assert.equal(widget.type, type, `${name} keeps its stock widget type`);
    }

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecificErrors = candidate.inventory.errors.filter(
      (error) => !baselineErrors.has(errorKey(error)),
    );
    assert.deepEqual(candidateSpecificErrors.map((error) => ({
      file: error.file,
      line: error.line,
      message: error.message,
      count: error.count,
      handled: error.handled,
    })), EXPECTED_CANDIDATE_ERRORS,
    "QuestLog reaches WatchFrame without candidate-specific Lua errors");
    assert.deepEqual(candidateSpecificErrors.filter((error) => !error.handled), [],
      "QuestLog adds no candidate-specific unhandled Lua errors");
    const watchedCount = candidate.inventory.neutral.find((entry) => entry.name === "GetNumQuestWatches");
    assert.equal(watchedCount?.answer, "0", "the neutral world gives WatchFrame a numeric empty count");
    assert.ok((watchedCount?.calls ?? 0) > 0,
      "WatchFrame actually reaches the typed GetNumQuestWatches contract");

    console.log(`[framexml QuestLog] MPQ delta ${JSON.stringify({
      baseline: before,
      candidate: after,
      delta,
      resolvedQuestFiles,
      candidateSpecificErrors,
    })}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
