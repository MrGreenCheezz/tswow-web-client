import assert from "node:assert/strict";
import test from "node:test";

const { frameXmlQuestGiverStructureGate, hideIdleQuestRequiredMoneyFrame } = await import(
  "../src/browser/framexml/FrameXmlQuestGiverGate.ts"
);

function fixture() {
  const byName = new Map();
  const elements = new Map();
  const add = (name, type, parentName, scripts = [], visible = true) => {
    const parent = parentName ? byName.get(parentName) : undefined;
    const frame = {
      name, type, parent, visible,
      registeredEvents: new Set(),
      scripts: new Set(scripts),
    };
    byName.set(name, frame);
    const element = {
      parentElement: parent ? elements.get(parent) : undefined,
      getAttribute(key) {
        if (key === "data-framexml-name") return name;
        if (key === "data-framexml-type") return type;
        return null;
      },
    };
    elements.set(frame, element);
    return frame;
  };

  add("UIParent", "Frame");
  const quest = add("QuestFrame", "Frame", "UIParent",
    ["OnLoad", "OnEvent", "OnShow", "OnHide"], false);
  quest.registeredEvents = new Set([
    "QUEST_GREETING", "QUEST_DETAIL", "QUEST_PROGRESS", "QUEST_COMPLETE",
    "QUEST_FINISHED", "QUEST_ITEM_UPDATE",
  ]);
  add("QuestFramePortrait", "Texture", "QuestFrame");
  add("QuestNpcNameFrame", "Frame", "QuestFrame", ["OnLoad"]);
  add("QuestFrameNpcNameText", "FontString", "QuestNpcNameFrame");
  add("QuestFrameCloseButton", "Button", "QuestFrame", ["OnClick"]);
  const panels = [
    ["Greeting", "QuestGreeting", "QuestFrameGreetingGoodbyeButton"],
    ["Detail", "QuestDetail", "QuestFrameAcceptButton"],
    ["Progress", "QuestProgress", "QuestFrameCompleteButton"],
    ["Reward", "QuestReward", "QuestFrameCompleteQuestButton"],
  ];
  for (const [panel, prefix, action] of panels) {
    const panelName = `QuestFrame${panel}Panel`;
    const scrollName = `${prefix}ScrollFrame`;
    add(panelName, "Frame", "QuestFrame", ["OnShow"], false);
    add(action, "Button", panelName, ["OnClick"]);
    add(scrollName, "ScrollFrame", panelName,
      ["OnLoad", "OnScrollRangeChanged", "OnVerticalScroll", "OnMouseWheel"]);
    add(`${prefix}ScrollChildFrame`, "Frame", scrollName);
    add(`${scrollName}ScrollBar`, "Slider", scrollName, ["OnValueChanged"]);
  }
  add("QuestFrameDeclineButton", "Button", "QuestFrameDetailPanel", ["OnClick"]);
  add("QuestFrameGoodbyeButton", "Button", "QuestFrameProgressPanel", ["OnClick"]);
  add("QuestFrameCancelButton", "Button", "QuestFrameRewardPanel", ["OnClick"]);
  for (let index = 1; index <= 32; index += 1) {
    add(`QuestTitleButton${index}`, "Button", "QuestGreetingScrollChildFrame", ["OnClick"]);
  }
  for (let index = 1; index <= 6; index += 1) {
    add(`QuestProgressItem${index}`, "Button", "QuestProgressScrollChildFrame",
      ["OnLoad", "OnClick", "OnEnter", "OnLeave"]);
  }
  add("QuestInfoFrame", "Frame", undefined, ["OnLoad"], false);
  add("QuestInfoRewardsFrame", "Frame", undefined, [], false);
  add("QuestInfoObjectivesFrame", "Frame", undefined, [], false);
  add("QuestInfoRequiredMoneyFrame", "Frame");
  add("QuestInfoTitleHeader", "FontString", "QuestInfoFrame");
  add("QuestInfoDescriptionText", "FontString", "QuestInfoFrame");
  add("QuestInfoRewardText", "FontString", "QuestInfoFrame");
  for (let index = 1; index <= 10; index += 1) {
    add(`QuestInfoItem${index}`, "Button", "QuestInfoRewardsFrame",
      ["OnClick", "OnEnter", "OnLeave"]);
  }
  const boot = {
    bridge: {
      getFrame(name) { return byName.get(name); },
      hasScript(frame, name) { return frame.scripts.has(name); },
      isVisible(frame) {
        for (let current = frame; current; current = current.parent) {
          if (!current.visible) return false;
        }
        return true;
      },
    },
  };
  const renderer = { elementFor(frame) { return elements.get(frame); } };
  return { boot, renderer, byName, elements };
}

test("stock QuestFrame structure requires complete panels, scrolls, rows, scripts and events", () => {
  const good = fixture();
  assert.deepEqual(Object.keys(frameXmlQuestGiverStructureGate(good.boot, good.renderer)),
    ["frame", "greeting", "detail", "progress", "reward", "info", "infoRewards"]);

  for (const missing of [
    "QuestFramePortrait", "QuestFrameAcceptButton", "QuestRewardScrollFrameScrollBar",
    "QuestTitleButton32", "QuestProgressItem6", "QuestInfoItem10",
  ]) {
    const current = fixture();
    current.byName.delete(missing);
    assert.equal(frameXmlQuestGiverStructureGate(current.boot, current.renderer), undefined, missing);
  }
  const missingEvent = fixture();
  missingEvent.byName.get("QuestFrame").registeredEvents.delete("QUEST_ITEM_UPDATE");
  assert.equal(frameXmlQuestGiverStructureGate(missingEvent.boot, missingEvent.renderer), undefined);

  const missingScript = fixture();
  missingScript.byName.get("QuestFrameRewardPanel").scripts.delete("OnShow");
  assert.equal(frameXmlQuestGiverStructureGate(missingScript.boot, missingScript.renderer), undefined);
});

test("stock QuestFrame structure rejects detached, misrendered or prematurely visible owners", () => {
  const wrongParent = fixture();
  wrongParent.byName.get("QuestFrameDeclineButton").parent = wrongParent.byName.get("QuestFrame");
  assert.equal(frameXmlQuestGiverStructureGate(wrongParent.boot, wrongParent.renderer), undefined);

  const wrongDom = fixture();
  wrongDom.elements.get(wrongDom.byName.get("QuestTitleButton7")).parentElement = undefined;
  assert.equal(frameXmlQuestGiverStructureGate(wrongDom.boot, wrongDom.renderer), undefined);

  const visible = fixture();
  visible.byName.get("QuestFrame").visible = true;
  assert.equal(frameXmlQuestGiverStructureGate(visible.boot, visible.renderer), undefined);
});

// Match the DOM operations exercised by the renderer while keeping the MPQ probe independent of
// a browser process. This is a real FrameXmlDomRenderer, not the element map above.
function fakeDocument() {
  const doc = {
    createElement: (tag) => make(tag),
    createElementNS: (_namespace, tag) => make(tag),
  };
  function make(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const style = {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
    const node = {
      ownerDocument: doc,
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: undefined,
      style,
      dataset: {},
      hidden: false,
      className: "",
      textContent: "",
      value: "",
      disabled: false,
      classList: { add() {}, remove() {} },
      addEventListener(name, listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      removeEventListener(name, listener) {
        listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener));
      },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      removeAttribute(name) { attributes.delete(String(name)); },
      append(...children) {
        for (const child of children) {
          child.parentElement?.removeChild(child);
          child.parentElement = node;
          node.children.push(child);
        }
      },
      insertBefore(child, reference) {
        child.parentElement?.removeChild(child);
        child.parentElement = node;
        const index = node.children.indexOf(reference);
        if (index < 0) node.children.push(child);
        else node.children.splice(index, 0, child);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        if (child.parentElement === node) child.parentElement = undefined;
      },
      remove() { node.parentElement?.removeChild(node); },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

let clientDirectory;
try {
  ({ clientDirectory } = await import("../tools/paths.mjs"));
  clientDirectory = clientDirectory();
} catch {
  clientDirectory = undefined;
}

test("selected client MPQ mounts the authored QuestFrame structure", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam: new CannedWorldSeam(),
    screen: () => ({ width: 1024, height: 768 }),
  });
  let renderer;
  const priorDocument = globalThis.document;
  try {
    await boot.load();
    const requiredMoney = boot.bridge.getFrame("QuestInfoRequiredMoneyFrame");
    assert.ok(requiredMoney);
    assert.equal(requiredMoney.visible, true, "selected XML starts the standalone helper visible");
    assert.equal(hideIdleQuestRequiredMoneyFrame(boot), true);
    assert.equal(requiredMoney.visible, false, "production selector can now keep the helper hidden");
    globalThis.document = fakeDocument();
    const { FrameXmlDomRenderer } = await import(
      "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js"
    );
    const quest = boot.bridge.getFrame("QuestFrame");
    const infoRoots = new Set([
      "QuestInfoFrame", "QuestInfoRewardsFrame", "QuestInfoObjectivesFrame",
      "QuestInfoRequiredMoneyFrame",
    ].map((name) => boot.bridge.getFrame(name)));
    const ui = boot.bridge.getFrame("UIParent");
    const includes = (frame) => {
      if (frame === ui) return true;
      for (let current = frame; current; current = current.parent) {
        if (current === quest || infoRoots.has(current)) return true;
      }
      return false;
    };
    renderer = new FrameXmlDomRenderer(document.createElement("section"), {
      bridge: boot.bridge, frameFilter: includes, includeCreatedRoots: false,
    });
    renderer.mount(boot.roots.filter((frame) => !frame.parent));
    const gate = frameXmlQuestGiverStructureGate(boot, renderer);
    const missing = [
      "UIParent", "QuestFrame", "QuestFrameGreetingPanel", "QuestFrameDetailPanel",
      "QuestFrameProgressPanel", "QuestFrameRewardPanel", "QuestTitleButton32",
      "QuestProgressItem6", "QuestInfoFrame", "QuestInfoRewardsFrame", "QuestInfoItem10",
    ].filter((name) => !renderer.elementFor(boot.bridge.getFrame(name)));
    assert.ok(gate, `selected 3.3.5a renderer gate failed; missing DOM: ${missing.join(", ")}`);
    assert.equal(boot.bridge.isVisible(gate.frame), false);
  } finally {
    renderer?.destroy();
    globalThis.document = priorDocument;
    boot.close();
    chain.close();
  }
});
