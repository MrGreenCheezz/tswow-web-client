import assert from "node:assert/strict";
import test from "node:test";

const { frameXmlQuestGate } = await import(
  "../dist/code/browser/framexml/FrameXmlQuestController.js",
);

function makeFrame(name, type, parent, scripts = []) {
  const frame = {
    name,
    type,
    named: true,
    parent,
    children: [],
    visible: name === "UIParent" || name === "WatchFrame",
    scriptSources: new Map(scripts.map((script) => [script, ""])),
    scriptFunctions: new Map(),
    scripts: new Map(),
    registeredEvents: new Set(),
  };
  if (parent) parent.children.push(frame);
  return frame;
}

function makeElement(name, type, parent) {
  const element = {
    parentElement: parent,
    getAttribute(attribute) {
      if (attribute === "data-framexml-name") return name;
      if (attribute === "data-framexml-type") return type;
      return null;
    },
  };
  return element;
}

function fixture() {
  const ui = makeFrame("UIParent", "Frame");
  const quest = makeFrame("QuestLogFrame", "Frame", ui,
    ["OnLoad", "OnEvent", "OnShow", "OnHide", "OnUpdate"]);
  const watch = makeFrame("WatchFrame", "Frame", ui,
    ["OnLoad", "OnEvent", "OnUpdate"]);
  const detail = makeFrame("QuestLogDetailFrame", "Frame", ui,
    ["OnLoad", "OnShow", "OnHide"]);
  const scroll = makeFrame("QuestLogScrollFrame", "ScrollFrame", quest, ["OnLoad"]);
  const scrollChild = makeFrame("QuestLogScrollFrameScrollChild", "Frame", scroll);
  const scrollBar = makeFrame("QuestLogScrollFrameScrollBar", "Slider", scroll,
    ["OnLoad", "OnValueChanged"]);
  const close = makeFrame("QuestLogFrameCloseButton", "Button", quest, ["OnClick"]);
  const detailClose = makeFrame("QuestLogDetailFrameCloseButton", "Button", detail, ["OnClick"]);
  const detailScroll = makeFrame("QuestLogDetailScrollFrame", "ScrollFrame", detail,
    ["OnLoad", "OnScrollRangeChanged", "OnVerticalScroll", "OnMouseWheel"]);
  const detailBar = makeFrame("QuestLogDetailScrollFrameScrollBar", "Slider", detailScroll,
    ["OnValueChanged"]);
  quest.registeredEvents = new Set([
    "QUEST_LOG_UPDATE", "QUEST_ACCEPTED", "QUEST_WATCH_UPDATE", "UPDATE_FACTION",
    "UNIT_QUEST_LOG_CHANGED", "PARTY_MEMBERS_CHANGED", "PARTY_MEMBER_ENABLE",
    "PARTY_MEMBER_DISABLE", "DISPLAY_SIZE_CHANGED",
  ]);
  watch.registeredEvents = new Set([
    "PLAYER_ENTERING_WORLD", "QUEST_LOG_UPDATE", "TRACKED_ACHIEVEMENT_UPDATE", "ITEM_PUSH",
    "DISPLAY_SIZE_CHANGED", "ZONE_CHANGED_NEW_AREA", "WORLD_MAP_UPDATE", "QUEST_POI_UPDATE",
    "PLAYER_MONEY", "VARIABLES_LOADED",
  ]);
  const title = makeFrame("QuestLogTitleText", "FontString", quest);
  const count = makeFrame("QuestLogCount", "Frame", quest);
  const questCount = makeFrame("QuestLogQuestCount", "FontString", count);
  const header = makeFrame("WatchFrameHeader", "Button", watch, ["OnLoad"]);
  const watchTitle = makeFrame("WatchFrameTitle", "FontString", header);
  const collapse = makeFrame("WatchFrameCollapseExpandButton", "Button", watch, ["OnClick"]);
  const lines = makeFrame("WatchFrameLines", "Frame", watch, ["OnLoad"]);
  const frames = [ui, quest, watch, detail, scroll, scrollChild, scrollBar, close, detailClose,
    detailScroll, detailBar, title, count, questCount, header, watchTitle, collapse, lines];
  for (let index = 1; index <= 22; index += 1) {
    const button = makeFrame(`QuestLogScrollFrameButton${index}`, "Button", scrollChild,
      ["OnLoad", "OnEvent", "OnClick", "OnEnter", "OnLeave"]);
    button.registeredEvents = new Set([
      "UNIT_QUEST_LOG_CHANGED", "PARTY_MEMBERS_CHANGED", "PARTY_MEMBER_ENABLE", "PARTY_MEMBER_DISABLE",
    ]);
    frames.push(button);
  }
  const elements = new Map();
  for (const frame of frames) {
    const parentElement = frame.parent ? elements.get(frame.parent) : undefined;
    elements.set(frame, makeElement(frame.name, frame.type, parentElement));
  }
  const byName = new Map(frames.map((frame) => [frame.name, frame]));
  const seam = {
    questLogEntryCount() { return [0, 0]; },
    questLogTitle() { return ["", ""]; },
    selectQuestLogEntry() {},
    questLogSelection() { return 0; },
    questLogQuestText() { return undefined; },
    questLogLeaderBoardCount() { return 0; },
    questLogLeaderBoard() { return undefined; },
    questLogRequiredMoney() { return 0; },
    questLogTimeLeft() { return undefined; },
    questLogCompletionText() { return undefined; },
    questLogGroupNum() { return 0; },
    questLogCurrentFailed() { return false; },
    questNumWatches() { return 0; },
    questIndexForWatch() { return undefined; },
    questIsWatched() { return false; },
  };
  const boot = {
    bridge: {
      getFrame(name) { return byName.get(name); },
      hasScript(frame, script) { return frame.scriptSources.has(script); },
      isVisible(frame) {
        for (let current = frame; current; current = current.parent) {
          if (!current.visible) return false;
        }
        return true;
      },
    },
  };
  const renderer = { elementFor(frame) { return elements.get(frame); } };
  return { boot, renderer, seam, frames, byName };
}

test("QuestLog gate requires stock ancestry, rendered widgets, scripts and seam reads", () => {
  const current = fixture();
  assert.equal(typeof frameXmlQuestGate, "function");
  assert.ok(frameXmlQuestGate(current.seam, current.boot, current.renderer));

  const missingRead = fixture();
  delete missingRead.seam.questLogLeaderBoard;
  assert.equal(frameXmlQuestGate(missingRead.seam, missingRead.boot, missingRead.renderer), undefined);

  const missingWidget = fixture();
  missingWidget.byName.delete("QuestLogScrollFrameButton2");
  assert.equal(frameXmlQuestGate(missingWidget.seam, missingWidget.boot, missingWidget.renderer), undefined);

  const wrongAncestry = fixture();
  const detail = wrongAncestry.byName.get("QuestLogDetailFrame");
  detail.parent = undefined;
  assert.equal(frameXmlQuestGate(wrongAncestry.seam, wrongAncestry.boot, wrongAncestry.renderer), undefined);
});

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

test("real MPQ + Canned bridge proves QuestLog owner open/list/close", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const elements = new Map();
    for (const frame of boot.bridge.frames) {
      elements.set(frame, {
        parentElement: frame.parent ? elements.get(frame.parent) : undefined,
        getAttribute(attribute) {
          if (attribute === "data-framexml-name") return frame.name;
          if (attribute === "data-framexml-type") return frame.type;
          return null;
        },
      });
    }
    const renderer = { elementFor(frame) { return elements.get(frame); } };
    const gate = frameXmlQuestGate(seam, boot, renderer);
    assert.ok(gate, "real MPQ tree passes the strict gate");
    assert.deepEqual(seam.questLogEntryCount(), [1, 1]);
    const watchVisible = boot.bridge.isVisible(gate.watch);
    boot.bridge.Show(gate.frame);
    assert.equal(boot.bridge.isVisible(gate.frame), true);
    boot.pump.fire("QUEST_LOG_UPDATE");
    assert.equal(boot.bridge.isVisible(gate.watch), watchVisible,
      "the native WatchFrame remains untouched while the log owner is open");
    boot.bridge.Hide(gate.frame);
    assert.equal(boot.bridge.isVisible(gate.frame), false);
    assert.equal(boot.bridge.isVisible(gate.watch), watchVisible,
      "closing the stock log does not mutate native tracker visibility");
  } finally {
    boot.close();
    chain.close();
  }
});
