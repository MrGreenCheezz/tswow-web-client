import assert from "node:assert/strict";
import test from "node:test";

// This is an MPQ-backed integration test: the gate and the behaviour below must be supplied by
// the stock QuestLog/WatchFrame Lua and XML, with CannedWorldSeam providing only world data.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

function fakeDocument() {
  const ids = new Map();
  const doc = {
    activeElement: undefined,
    head: undefined,
    createElement(tag) { return makeNode(tag); },
    createElementNS(_namespace, tag) { return makeNode(tag); },
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, makeNode("div"));
      return ids.get(id);
    },
    querySelectorAll() { return []; },
  };

  function style() {
    return {
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    };
  }

  function makeNode(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const node = {
      ownerDocument: doc,
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: undefined,
      parentNode: undefined,
      style: style(),
      hidden: false,
      className: "",
      dataset: {},
      textContent: "",
      value: "",
      disabled: false,
      width: 0,
      height: 0,
      offsetLeft: 0,
      offsetTop: 0,
      offsetWidth: 0,
      offsetHeight: 0,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
          node.className = [...classes].join(" ");
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
          node.className = [...classes].join(" ");
        },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : force;
          if (enabled) classes.add(name); else classes.delete(name);
          node.className = [...classes].join(" ");
          return enabled;
        },
        contains(name) { return classes.has(name); },
      },
      get nextSibling() {
        const siblings = node.parentElement?.children ?? [];
        const index = siblings.indexOf(node);
        return index < 0 ? null : siblings[index + 1] ?? null;
      },
      append(...children) {
        for (const child of children) {
          if (!child) continue;
          child.parentElement?.removeChild(child);
          child.parentElement = node;
          child.parentNode = node;
          node.children.push(child);
        }
      },
      insertBefore(child, before) {
        child.parentElement?.removeChild(child);
        child.parentElement = node;
        child.parentNode = node;
        const index = node.children.indexOf(before);
        if (index < 0) node.children.push(child);
        else node.children.splice(index, 0, child);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        if (child.parentElement === node) child.parentElement = undefined;
        if (child.parentNode === node) child.parentNode = undefined;
      },
      replaceChildren(...children) {
        for (const child of node.children) {
          child.parentElement = undefined;
          child.parentNode = undefined;
        }
        node.children = [];
        node.append(...children);
      },
      remove() { node.parentElement?.removeChild(node); },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      removeAttribute(name) { attributes.delete(String(name)); },
      addEventListener(name, listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      removeEventListener(name, listener) {
        listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== listener));
      },
      dispatchEvent(event) {
        for (const listener of listeners.get(event.type) ?? []) listener(event);
      },
      querySelector(selector) {
        if (selector === 'button[type="submit"]') return makeNode("button");
        return findSelector(node, selector);
      },
      querySelectorAll(selector) {
        const result = [];
        walk(node, (child) => { if (matches(child, selector)) result.push(child); });
        return result;
      },
      closest(selector) {
        for (let current = node; current; current = current.parentElement) {
          if (matches(current, selector)) return current;
        }
        return null;
      },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange() {},
      getContext() { return undefined; },
    };
    return node;
  }

  function walk(node, visit) {
    for (const child of node.children ?? []) {
      visit(child);
      walk(child, visit);
    }
  }

  function matches(node, selector) {
    if (selector === "[data-framexml-type]") return node.getAttribute("data-framexml-type") !== null;
    return false;
  }

  function findSelector(root, selector) {
    let result;
    walk(root, (child) => { if (!result && matches(child, selector)) result = child; });
    return result;
  }

  doc.head = makeNode("head");
  return doc;
}

globalThis.document = fakeDocument();
globalThis.window = {
  devicePixelRatio: 1,
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FrameXmlDomRenderer } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { CannedWorldSeam, CANNED_QUESTS } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const {
  closeFrameXmlQuest,
  frameXmlQuestGate,
  frameXmlQuestOpen,
  publishFrameXmlQuest,
  toggleFrameXmlQuest,
} = await import("../dist/code/browser/framexml/FrameXmlQuestController.js");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

function frame(boot, name) {
  const result = boot.bridge.getFrame(name);
  assert.ok(result, `${name} exists in the stock MPQ load`);
  return result;
}

function walk(node, visit) {
  for (const child of node.children ?? []) {
    visit(child);
    walk(child, visit);
  }
}

function renderedDescendants(node) {
  const result = [];
  walk(node, (child) => result.push(child));
  return result;
}

function effectivelyVisible(node) {
  for (let current = node; current; current = current.parentElement) {
    if (current.hidden) return false;
  }
  return true;
}

test("MPQ stock QuestLog/WatchFrame mounts, lists, details and cleans up through CannedWorldSeam",
  withClient, async () => {
    const { clientArchives } = await import("../tools/mpq.mjs");
    const chain = await clientArchives(clientDirectory);
    const decoder = new TextDecoder("utf-8");
    const requests = new Set();
    const seam = new CannedWorldSeam();
    const boot = new FrameXmlBoot({
      provider: {
        async read(path) {
          requests.add(normalized(path));
          const data = await chain.read(path);
          return data ? decoder.decode(data) : undefined;
        },
      },
      locale: "ruRU",
      subset: FRAMEXML_VERTICAL_TOC,
      seam,
      exercise: false,
      screen: () => ({ width: 1024, height: 768 }),
    });
    const host = document.createElement("section");
    const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
    let releaseOwner;
    try {
      const inventory = await boot.load();
      const expectedQuestFiles = [
        "interface/framexml/questframe.xml",
        "interface/framexml/questframe.lua",
        "interface/framexml/questframetemplates.xml",
        "interface/framexml/questpoi.xml",
        "interface/framexml/questpoi.lua",
        "interface/framexml/watchframe.xml",
        "interface/framexml/watchframe.lua",
        "interface/framexml/questlogframe.xml",
        "interface/framexml/questlogframe.lua",
        "interface/framexml/questinfo.xml",
        "interface/framexml/questinfo.lua",
      ];
      for (const path of expectedQuestFiles) {
        assert.ok(requests.has(path), `real MPQ provider requested ${path}`);
      }
      assert.equal(inventory.xml.failed.length, 0, "stock Quest XML parses");
      assert.equal(inventory.lua.failed, 0, "stock Quest Lua executes");

      renderer.mount(boot.roots);
      const quest = frame(boot, "QuestLogFrame");
      const watch = frame(boot, "WatchFrame");
      const detail = frame(boot, "QuestLogDetailFrame");
      const detailScroll = frame(boot, "QuestLogDetailScrollFrame");
      const questElement = renderer.elementFor(quest);
      const watchElement = renderer.elementFor(watch);
      const detailElement = renderer.elementFor(detail);
      const detailScrollElement = renderer.elementFor(detailScroll);
      assert.ok(questElement && watchElement && detailElement && detailScrollElement);
      assert.equal(quest.visible, false, "QuestLogFrame starts hidden");
      assert.equal(detail.visible, false, "QuestLogDetailFrame starts hidden");
      assert.equal(questElement.hidden, true, "hidden stock QuestLogFrame is hidden in DOM");
      assert.equal(detailElement.hidden, true, "hidden stock detail frame is hidden in DOM");

      const gate = frameXmlQuestGate(seam, boot, renderer);
      assert.ok(gate, "real 22-row stock QuestLog tree passes the strict gate");
      assert.equal(seam.questLogEntryCount()[0], CANNED_QUESTS.length);
      assert.equal(seam.questNumWatches(), 1, "CannedWorldSeam starts with the quest watched");
      assert.equal(seam.questIndexForWatch(1), 1);
      assert.equal(seam.questIsWatched(1), true);

      let questShows = 0;
      let questHides = 0;
      assert.equal(boot.bridge.HookScript(quest, "OnShow", () => { questShows += 1; }), true);
      assert.equal(boot.bridge.HookScript(quest, "OnHide", () => { questHides += 1; }), true);
      const errorsBeforeShow = boot.vm.errors.length;
      const owner = {
        isOpen: () => quest.visible,
        show: () => { assert.equal(boot.bridge.Show(quest), true); },
        hide: () => { assert.equal(boot.bridge.Hide(quest), true); },
      };
      releaseOwner = publishFrameXmlQuest(owner);
      assert.equal(frameXmlQuestOpen(), false, "published stock owner starts closed");
      assert.equal(toggleFrameXmlQuest(), true, "toggle reaches stock QuestLogFrame Show");
      assert.equal(questShows, 1, "stock QuestLogFrame OnShow runs once");
      assert.equal(quest.visible, true);
      assert.equal(questElement.hidden, false);
      assert.equal(frameXmlQuestOpen(), true);
      assert.equal(boot.vm.errors.length, errorsBeforeShow,
        `Show adds no quest-specific Lua failures: ${boot.vm.errors.join(" | ")}`);

      const firstButton = frame(boot, "QuestLogScrollFrameButton1");
      const title = frame(boot, "QuestLogTitleText");
      const count = frame(boot, "QuestLogQuestCount");
      const firstLabel = frame(boot, "QuestLogScrollFrameButton1NormalText");
      assert.equal(firstButton.text, `  ${CANNED_QUESTS[0].title}`,
        "first stock quest row displays the CannedWorldSeam title");
      assert.equal(firstLabel.text, `  ${CANNED_QUESTS[0].title}`,
        "first stock quest row label is rendered");
      assert.match(count.text, /1\/25/, "stock quest count shows the canned entry count");
      assert.notEqual(title.text, "", "stock quest title label is populated");
      assert.ok(firstButton.visible, "first stock quest row is visible");

      assert.equal(boot.bridge.Click(firstButton, "LeftButton", false), true,
        "first stock quest row click is dispatched through the bridge");
      assert.equal(seam.questLogSelection(), 1, "stock click selects the first canned quest");
      // Plan 1.12: the canned quest is sharable and the canned party is there — «Поделиться» is
      // enabled by QuestLogFrame.lua:871 and its click reaches QuestLogPushQuest.
      const pushButton = frame(boot, "QuestLogFramePushQuestButton");
      assert.equal(pushButton.enabled, true, "the stock share button is enabled");
      assert.equal(boot.bridge.Click(pushButton, "LeftButton", false), true);
      assert.deepEqual(seam.sharedQuests, [CANNED_QUESTS[0].questId], "the click shares the selected quest");
      const detailTitle = frame(boot, "QuestInfoTitleHeader");
      const detailDescription = frame(boot, "QuestInfoDescriptionText");
      const detailObjectives = frame(boot, "QuestInfoObjectivesText");
      assert.equal(detail.visible, false,
        "stock selection keeps the separate QuestLogDetailFrame hidden");
      assert.equal(detailElement.hidden, true,
        "separate QuestLogDetailFrame stays hidden while the log owns the detail");
      assert.equal(detailScroll.parent, quest,
        `stock OnShow attaches QuestLogDetailScrollFrame to QuestLogFrame (actual parent: ${detailScroll.parent?.name ?? "none"})`);
      assert.equal(detailScroll.visible, true,
        "attached stock detail scroll is shown for the selected quest");
      assert.equal(detailScrollElement.hidden, false,
        "attached stock detail scroll is visible in the DOM");
      assert.equal(effectivelyVisible(detailScrollElement), true,
        "attached stock detail scroll is effectively visible under QuestLogFrame");
      assert.equal(detailTitle.text, CANNED_QUESTS[0].title,
        "detail title is populated through the stock quest API");
      assert.match(detailDescription.text, /Описание задания/,
        "detail description is populated through the stock quest API");
      assert.match(detailObjectives.text, /Проверить цели/,
        "detail objective text is populated through the stock quest API");
      assert.match(renderedDescendants(host).map((node) => node.textContent).join(" "),
        /Проверка журнала заданий/,
        "renderer contains the canned quest title on the stock display path");

      const watchTitle = frame(boot, "WatchFrameTitle");
      const watchLines = frame(boot, "WatchFrameLines");
      assert.equal(watch.visible, true, "stock WatchFrame remains visible under its native owner");
      assert.notEqual(watchTitle.text, "",
        "stock WatchFrame renders the canned watched quest title");
      assert.match(watchTitle.text, /\(\s*1\s*\)/,
        "stock WatchFrame title includes the canned watch count");
      assert.ok(watchLines.visible, "stock WatchFrame objective lines are visible");
      const watchText = renderedDescendants(renderer.elementFor(watchLines))
        .map((node) => node.textContent).join(" ");
      assert.match(watchText, /2\/5\s+Проверить цель/,
        "stock WatchFrame reverses the objective into its authored progress-first format");
      const difficulty = boot.vm.execute(`
        assert(GetQuestDifficultyColor(48) == QuestDifficultyColors.standard)
        assert(GetQuestDifficultyColor(47) == QuestDifficultyColors.trivial)
      `, "@quest-green-range");
      assert.equal(difficulty.ok, true, difficulty.error);
      seam.setQuestTemplate(CANNED_QUESTS[0].questId, { level: 48 });
      assert.equal(boot.bridge.Click(firstButton, "LeftButton", false), true,
        "a low-level quest remains selectable after the stock colour update");
      assert.equal(boot.vm.errors.length, errorsBeforeShow);
      assert.equal(seam.removeQuestWatch(1), undefined);
      assert.equal(seam.questNumWatches(), 0, "seam supports removing the canned watch");
      assert.equal(seam.addQuestWatch(1), undefined);
      assert.equal(seam.questNumWatches(), 1, "seam supports restoring the canned watch");

      assert.equal(closeFrameXmlQuest(), true, "close reaches the stock QuestLogFrame Hide path");
      assert.equal(questHides, 1, "stock QuestLogFrame OnHide runs once");
      assert.equal(quest.visible, false);
      assert.equal(questElement.hidden, true);
      assert.equal(effectivelyVisible(questElement), false);
      assert.equal(effectivelyVisible(detailElement), false,
        "closing the stock log effectively hides its detail child");
      assert.equal(frameXmlQuestOpen(), false);
      releaseOwner();
      releaseOwner = undefined;
      assert.equal(frameXmlQuestOpen(), false, "unpublishing removes the stock owner");
      assert.equal(renderedDescendants(host).some((node) => effectivelyVisible(node)
        && ["QuestLogFrame", "QuestLogDetailFrame"].includes(
          node.getAttribute("data-framexml-name"))), false,
      "cleanup leaves no visible stock quest-log panel");
      assert.equal(boot.vm.errors.length, errorsBeforeShow);
    } finally {
      releaseOwner?.();
      renderer.destroy();
      boot.close();
      chain.close();
    }
  });
