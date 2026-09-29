import assert from "node:assert/strict";
import test from "node:test";

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
        add(...names) { for (const name of names) classes.add(name); node.className = [...classes].join(" "); },
        remove(...names) { for (const name of names) classes.delete(name); node.className = [...classes].join(" "); },
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
        return selector === 'button[type="submit"]' ? makeNode("button") : undefined;
      },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange() {},
      getContext() { return undefined; },
    };
    return node;
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
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
};
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FrameXmlDomRenderer } = await import(
  "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js",
);
const { createLazyFrameXmlTrainerOwner } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldMount.js",
);

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_trainerui/";

function frame(boot, name, type, parent) {
  const value = boot.bridge.getFrame(name);
  assert.ok(value, `${name} exists`);
  assert.equal(value.type, type, `${name} is a stock ${type}`);
  assert.equal(value.parent?.name, parent, `${name} is owned by ${parent}`);
  return value;
}

function api(boot, name, args = [], count = 10) {
  const ref = boot.vm.globalFunction(name);
  assert.ok(ref, `${name} binding exists`);
  try {
    return boot.vm.call(ref, args, count);
  } finally {
    boot.vm.release(ref);
  }
}

function rendered(boot, renderer, name, type, parent) {
  const value = frame(boot, name, type, parent);
  const element = renderer.elementFor(value);
  assert.ok(element, `${name} has a rendered DOM element`);
  const parentFrame = boot.bridge.getFrame(parent);
  assert.ok(parentFrame, `${parent} exists for ${name}`);
  const expectedParent = renderer.elementFor(parentFrame);
  const throughScrollViewport = parentFrame.scroll.child === value
    && element.parentElement?.getAttribute("data-framexml-scroll-viewport") === "true"
    && element.parentElement.parentElement === expectedParent;
  assert.equal(element.parentElement === expectedParent || throughScrollViewport, true,
    `${name} keeps its rendered parent ${parent}`);
  assert.equal(element.getAttribute("data-framexml-name"), name);
  assert.equal(element.getAttribute("data-framexml-type"), type);
  return { value, element };
}

function pump() {
  const events = [];
  return {
    events,
    now: () => 100,
    fire(event, ...args) { events.push([event, ...args]); return 1; },
  };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test("real Blizzard_TrainerUI loads asynchronously with exact stock closure", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const requests = [];
  const bytes = new Map();
  let addonReleased = false;
  let releaseAddon;
  const addonBarrier = new Promise((resolve) => { releaseAddon = resolve; });
  let addonReadStarted = false;
  const seam = new CannedWorldSeam();
  const worldPump = pump();
  // Transparently record every seam event while preserving the real synchronous Boot pump.
  // SelectTrainerService itself must remain a command: the stock description handler calls it
  // from ClassTrainer_SetSelection and would recurse if the command emitted the same event.
  const seamAttach = seam.attach.bind(seam);
  seam.attach = (targetPump) => seamAttach({
    now: targetPump.now,
    fire(event, ...args) {
      worldPump.events.push([event, ...args]);
      return targetPump.fire(event, ...args);
    },
  });
  const trainerWindow = document.getElementById("trainer-window");
  trainerWindow.hidden = false;
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalize(path);
        requests.push(key);
        if (key.startsWith(ADDON_PREFIX) && !addonReleased) {
          addonReadStarted = true;
          await addonBarrier;
        }
        const data = await chain.read(path);
        if (key.startsWith(ADDON_PREFIX) && data) bytes.set(key, data.byteLength);
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
  let trainerAddonResult;
  const loadAddon = boot.loadAddon.bind(boot);
  boot.loadAddon = async (name) => {
    trainerAddonResult = await loadAddon(name);
    return trainerAddonResult;
  };
  let owner;
  try {
    await boot.load();
    renderer.mount(boot.roots);
    seam.openTrainer();
    worldPump.events.length = 0;

    const loadOnDemand = boot.vm.globalFunction("LoadAddOn");
    assert.ok(loadOnDemand);
    assert.deepEqual(boot.vm.call(loadOnDemand, ["Blizzard_TrainerUI"], 2), [false, "NOT_READY"]);
    assert.deepEqual(boot.vm.call(loadOnDemand, ["Blizzard_TalentUI"], 2), [false, "NOT_READY"]);
    boot.vm.release(loadOnDemand);

    assert.equal(boot.bridge.getFrame("ClassTrainerFrame")?.name, undefined,
      "LoD root is absent before the owner asks for it");
    const errorsBeforeOwner = boot.errorCount;
    const diagnosticsBeforeOwner = boot.bridge.diagnostics.length;
    let failureCount = 0;
    const context = {};
    owner = createLazyFrameXmlTrainerOwner(
      seam,
      boot,
      renderer,
      () => { failureCount += 1; trainerWindow.hidden = false; },
      () => context,
      () => { trainerWindow.hidden = false; },
    );
    owner.show();
    await settle();
    assert.equal(addonReadStarted, true, "owner started the asynchronous Trainer LoD read");
    assert.equal(owner.isOpen(), true, "pending open intent is observable");
    assert.equal(trainerWindow.hidden, false, "native trainer remains visible while pending");
    assert.equal(boot.bridge.getFrame("ClassTrainerFrame")?.name, undefined,
      "partial LoD load does not expose a root");

    addonReleased = true;
    releaseAddon();
    for (let i = 0; i < 40 && !boot.bridge.getFrame("ClassTrainerFrame")?.visible; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(trainerAddonResult?.ok, true, trainerAddonResult?.message);
    assert.deepEqual(trainerAddonResult?.roots, [],
      "UIParent-owned root is rendered through the already-mounted registry");
    assert.equal(failureCount, 0);
    assert.equal(owner.isOpen(), true, "real gate passes and the owner opens the stock root");
    assert.equal(trainerWindow.hidden, true, "native trainer is hidden only after the gate");
    assert.equal(boot.errorCount, errorsBeforeOwner,
      `Trainer open adds no Lua errors: ${boot.vm.errors.join(" | ")}`);
    assert.equal(boot.bridge.diagnostics.length, diagnosticsBeforeOwner,
      "Trainer open adds no bridge diagnostics");

    const result = trainerAddonResult;
    assert.equal(result.ok, true, result.message);
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.dependencies, []);
    assert.deepEqual(result.loaded, [
      `${ADDON_PREFIX}blizzard_trainerui.toc`,
      `${ADDON_PREFIX}blizzard_trainerui.xml`,
      `${ADDON_PREFIX}blizzard_trainerui.lua`,
      `${ADDON_PREFIX}localization.lua`,
    ]);
    assert.deepEqual(result.roots, [], "UIParent-owned stock root is not returned as a top-level root");
    assert.deepEqual([...bytes.entries()].sort(), [
      [`${ADDON_PREFIX}blizzard_trainerui.lua`, 17225],
      [`${ADDON_PREFIX}blizzard_trainerui.toc`, 128],
      [`${ADDON_PREFIX}blizzard_trainerui.xml`, 16729],
      [`${ADDON_PREFIX}localization.lua`, 51],
    ]);
    assert.equal([...bytes.values()].reduce((sum, value) => sum + value, 0), 34133);
    const tocSignature = await chain.read(`${ADDON_PREFIX}blizzard_trainerui.toc.sig`);
    assert.ok(tocSignature, "stock MPQ contains the Trainer .toc.sig sidecar");
    assert.equal(requests.some((path) => path.endsWith("/blizzard_trainerui.toc.sig")), false,
      "Trainer loader never requests the optional .toc.sig sidecar");

    const root = frame(boot, "ClassTrainerFrame", "Frame", "UIParent");
    const rootElement = renderer.elementFor(root);
    assert.ok(rootElement, "stock root was rendered by the real DOM renderer");
    assert.equal(rootElement.parentElement, renderer.elementFor(boot.bridge.getFrame("UIParent")));
    assert.equal(root.visible, true, "owner showed stock root after the gate");
    assert.equal(root.scriptFunctions.get("OnLoad"), "ClassTrainerFrame_OnLoad");
    assert.equal(root.scriptFunctions.get("OnEvent"), "ClassTrainerFrame_OnEvent");
    assert.equal(root.scriptSources.has("OnShow"), true);
    assert.equal(root.scriptSources.has("OnHide"), true);
    assert.deepEqual([...root.registeredEvents].sort(), [
      "TRAINER_DESCRIPTION_UPDATE", "TRAINER_UPDATE",
    ]);

    const expand = rendered(boot, renderer, "ClassTrainerExpandButtonFrame", "Frame", "ClassTrainerFrame").value;
    const collapse = frame(boot, "ClassTrainerCollapseAllButton", "Button", expand.name);
    assert.equal(renderer.elementFor(collapse).parentElement, renderer.elementFor(expand));
    assert.equal(collapse.scriptFunctions.get("OnClick"), "ClassTrainerCollapseAllButton_OnClick");
    rendered(boot, renderer, "ClassTrainerFrameFilterDropDown", "Frame", "ClassTrainerFrame");
    rendered(boot, renderer, "ClassTrainerSkillHighlightFrame", "Frame", "ClassTrainerFrame");
    const list = rendered(boot, renderer, "ClassTrainerListScrollFrame", "ScrollFrame", "ClassTrainerFrame").value;
    assert.equal(list.scriptSources.has("OnVerticalScroll"), true);
    rendered(boot, renderer, "ClassTrainerMoneyFrame", "Frame", "ClassTrainerFrame");
    const detail = rendered(boot, renderer, "ClassTrainerDetailScrollFrame", "ScrollFrame", "ClassTrainerFrame").value;
    const detailChild = rendered(boot, renderer, "ClassTrainerDetailScrollChildFrame", "Frame", detail.name).value;
    for (const name of [
      "ClassTrainerSkillName", "ClassTrainerSubSkillName", "ClassTrainerSkillRequirements",
      "ClassTrainerCostLabel", "ClassTrainerSkillDescription",
    ]) rendered(boot, renderer, name, "FontString", detailChild.name);
    const icon = rendered(boot, renderer, "ClassTrainerSkillIcon", "Button", detailChild.name).value;
    assert.equal(icon.scriptFunctions.get("OnLeave"), "GameTooltip_Hide");
    assert.equal(icon.scriptSources.has("OnEnter"), true);
    assert.equal(icon.scriptSources.has("OnClick"), true);
    rendered(boot, renderer, "ClassTrainerDetailMoneyFrame", "Frame", detailChild.name);
    const train = rendered(boot, renderer, "ClassTrainerTrainButton", "Button", "ClassTrainerFrame").value;
    assert.equal(train.scriptFunctions.get("OnClick"), "ClassTrainerTrainButton_OnClick");
    const cancel = rendered(boot, renderer, "ClassTrainerCancelButton", "Button", "ClassTrainerFrame").value;
    assert.equal(cancel.scriptFunctions.get("OnClick"), "HideParentPanel");
    rendered(boot, renderer, "ClassTrainerFrameCloseButton", "Button", "ClassTrainerFrame");
    for (let index = 1; index <= 11; index += 1) {
      const skill = rendered(boot, renderer, `ClassTrainerSkill${index}`, "Button", "ClassTrainerFrame").value;
      assert.equal(skill.scriptFunctions.get("OnClick"), "ClassTrainerSkillButton_OnClick");
    }
    const descriptionErrorsBefore = boot.errorCount;
    const descriptionDiagnosticsBefore = boot.bridge.diagnostics.length;
    assert.ok(boot.bridge.dispatchEvent("TRAINER_DESCRIPTION_UPDATE") > 0,
      "stock Trainer description event reaches the rendered root");
    assert.equal(boot.errorCount, descriptionErrorsBefore,
      "stock description event adds no Lua errors");
    assert.equal(boot.bridge.diagnostics.length, descriptionDiagnosticsBefore,
      "stock description event adds no bridge diagnostics");
    assert.equal(worldPump.events.some(([event]) => event === "TRAINER_DESCRIPTION_UPDATE"), false,
      "SelectTrainerService does not recursively republish the stock description event");

    assert.deepEqual(api(boot, "GetTrainerServiceTypeFilter", ["used"], 1), [false]);
    assert.deepEqual(api(boot, "GetNumTrainerServices", [], 1), [2]);
    api(boot, "SetTrainerServiceTypeFilter", ["used", true], 0);
    assert.deepEqual(api(boot, "GetNumTrainerServices", [], 1), [3]);
    assert.deepEqual(api(boot, "GetTrainerServiceInfo", [1], 4), ["Рывок", "", "available", false]);
    assert.deepEqual(api(boot, "GetTrainerServiceCost", [1], 3), [1250, 0, 0]);
    assert.deepEqual(api(boot, "GetTrainerServiceLevelReq", [1], 1), [4]);
    assert.deepEqual(api(boot, "GetTrainerServiceSkillReq", [1], 3), [undefined, 0, false]);
    assert.deepEqual(api(boot, "GetTrainerServiceNumAbilityReq", [1], 1), [0]);
    assert.deepEqual(api(boot, "GetTrainerServiceAbilityReq", [1, 1], 2), [undefined, undefined]);
    assert.deepEqual(api(boot, "GetTrainerServiceStepReq", [1], 2), [undefined, false]);
    assert.deepEqual(api(boot, "GetTrainerServiceIcon", [1], 1), [
      "Interface\\Icons\\Ability_Warrior_Charge",
    ]);
    assert.deepEqual(api(boot, "GetTrainerServiceDescription", [1], 1), ["Мчится к противнику."]);
    assert.deepEqual(api(boot, "GetTrainerServiceSkillLine", [1], 1), [undefined]);
    assert.deepEqual(api(boot, "GetTrainerServiceItemLink", [1], 1), [undefined]);
    assert.deepEqual(api(boot, "GetTrainerGreetingText", [], 1), ["Чему я могу тебя научить?"]);
    assert.deepEqual(api(boot, "GetTrainerSelectionIndex", [], 1), [1]);
    assert.deepEqual(api(boot, "IsTradeskillTrainer", [], 1), [false]);
    assert.deepEqual(api(boot, "GetTrainerServiceTypeFilter", ["available"], 1), [true]);
    api(boot, "SetTrainerServiceTypeFilter", ["available", false], 0);
    assert.deepEqual(api(boot, "GetNumTrainerServices", [], 1), [2]);
    api(boot, "SetTrainerServiceTypeFilter", ["available", true], 0);
    api(boot, "SelectTrainerService", [1], 0);
    assert.deepEqual(api(boot, "GetTrainerSelectionIndex", [], 1), [1]);
    api(boot, "CollapseTrainerSkillLine", [0], 0);
    api(boot, "ExpandTrainerSkillLine", [0], 0);
    assert.deepEqual(api(boot, "UnitCharacterPoints", ["player"], 2), [0, 0]);
    assert.deepEqual(api(boot, "UnitLevel", ["player"], 1), [60]);
    assert.deepEqual(api(boot, "UnitName", ["npc"], 1), ["Наставник из Штормграда"]);
    assert.deepEqual(api(boot, "GetMoney", [], 1), [123456]);

    assert.equal(boot.bridge.Click(train, "LeftButton", false), true);
    assert.deepEqual(seam.trainerBuyRequests, [100],
      "one stock Train click buys exactly one available service");
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("ClassTrainerSkill2"), "LeftButton", false), true);
    assert.equal(boot.bridge.Click(train, "LeftButton", false), false);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("ClassTrainerSkill3"), "LeftButton", false), true);
    assert.equal(boot.bridge.Click(train, "LeftButton", false), false);
    assert.deepEqual(seam.trainerBuyRequests, [100], "known/unavailable services are not bought");
    assert.equal(boot.bridge.diagnostics.length, diagnosticsBeforeOwner,
      "stock Trainer interactions add no bridge diagnostics");

    const trainerUpdatesBeforeHide = worldPump.events.filter(
      ([event]) => event === "TRAINER_UPDATE",
    ).length;
    assert.equal(boot.bridge.Hide(root), true, "stock Hide reaches ClassTrainerFrame OnHide");
    assert.equal(root.visible, false);
    assert.equal(trainerWindow.hidden, true, "native fallback is not resurrected by stock OnHide");
    assert.equal(seam.trainerBuyRequests.length, 1);
    assert.equal(boot.bridge.Hide(root), true, "a second Hide is idempotent");
    const trainerUpdatesAfterHide = worldPump.events.filter(
      ([event]) => event === "TRAINER_UPDATE",
    ).length;
    assert.equal(trainerUpdatesAfterHide - trainerUpdatesBeforeHide, 1,
      "stock OnHide closes the Canned trainer exactly once");
  } finally {
    owner?.dispose();
    seam.detach();
    boot.close();
    chain.close();
  }
});
