import assert from "node:assert/strict";
import test, { after } from "node:test";

// The real Blizzard_TradeSkillUI from the client's MPQs, loaded on demand through the lazy owner the
// world mount publishes (FrameXmlTradeSkillOwner.ts), over the vertical corpus and the canned
// professions: the native window while it loads, the gate, UIParent's TRADE_SKILL_SHOW, and the stock
// window's own flows — headings, filters, search, Create/Create All, the enchant cursor and close.

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
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: undefined,
      parentNode: undefined, style: style(), hidden: false, className: "", dataset: {}, textContent: "",
      value: "", disabled: false, width: 0, height: 0, offsetLeft: 0, offsetTop: 0, offsetWidth: 0,
      offsetHeight: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
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
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      removeEventListener(name, listener) {
        listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== listener));
      },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      querySelector(selector) { return selector === 'button[type="submit"]' ? makeNode("button") : undefined; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange() {},
      getContext() { return undefined; },
      // The whole stage: a wheel "inside" any rendered box (the owner's wheel hand-off reads it).
      getBoundingClientRect() { return { left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768 }; },
    };
    return node;
  }
  doc.head = makeNode("head");
  return doc;
}

globalThis.document = fakeDocument();
globalThis.window = {
  devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
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
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { createLazyFrameXmlTradeSkillOwner, frameXmlTradeSkillGate, FRAMEXML_TRADESKILL_ADDON } = await import(
  "../dist/code/browser/framexml/FrameXmlTradeSkillOwner.js",
);
const { FRAMEXML_CANNED_BRACERS_GUID } = await import("../dist/code/browser/framexml/FrameXmlTradeSkillCanned.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_tradeskillui/";
const skip = clientDirectory ? false : "no 3.3.5a client on this machine";

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "tradeskill-test", []);
  assert.ok(fn, "the probe compiles");
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

async function settle(condition, rounds = 200) {
  for (let round = 0; round < rounds && !condition(); round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// tools/mpq.mjs shares one chain per client directory across the process: close it once, at the end.
let sharedChain;
after(() => sharedChain?.close());

async function stage({ barrier = false, nativeShows = true } = {}) {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = sharedChain ??= await clientArchives(clientDirectory);
  const requests = [];
  const bytes = new Map();
  let release;
  const gate = barrier ? new Promise((resolve) => { release = resolve; }) : undefined;
  const seam = new CannedWorldSeam();
  const events = [];
  const attach = seam.attach.bind(seam);
  seam.attach = (target) => attach({
    now: target.now,
    fire(event, ...args) {
      if (/TRADE_SKILL|TRADESKILL/.test(event)) events.push(event);
      return target.fire(event, ...args);
    },
  });
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalize(path);
        requests.push(key);
        if (gate && key.startsWith(ADDON_PREFIX)) await gate;
        const data = await chain.read(path);
        if (key.startsWith(ADDON_PREFIX) && data) bytes.set(key, data.byteLength);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  let addonResult;
  const loadAddon = boot.loadAddon.bind(boot);
  boot.loadAddon = async (name) => (addonResult = await loadAddon(name));
  await boot.load();
  renderer.mount(boot.roots);
  const native = [];
  // Which lines' native craft windows show: the player can close one with its own controls.
  const nativeShown = new Set();
  const failures = [];
  const owner = createLazyFrameXmlTradeSkillOwner({
    seam, boot, renderer,
    native: {
      open: (skillId) => {
        native.push(["open", skillId]);
        if (nativeShows) nativeShown.add(skillId);
        return nativeShows;
      },
      stepAside: () => { native.push(["aside"]); nativeShown.clear(); },
      isOpen: (skillId) => nativeShown.has(skillId),
    },
    onFailure: () => failures.push("failed"),
  });
  const close = () => { owner.dispose(); seam.detach(); boot.close(); };
  return {
    chain, seam, boot, renderer, owner, native, nativeShown, failures, events, requests, bytes,
    release: () => release?.(), addon: () => addonResult, close,
    tick: () => seam.tick(boot.pump.now() + 1),
  };
}

test("Blizzard_TradeSkillUI loads on the first profession, behind the native window, and opens through UIParent", {
  skip,
}, async () => {
  const run = await stage({ barrier: true });
  const { seam, boot, renderer, owner, native, failures, events, requests, bytes } = run;
  try {
    assert.equal(FRAMEXML_VERTICAL_TOC.some((entry) => /tradeskill/i.test(entry)), false,
      "the add-on is not in the boot corpus");
    assert.equal(boot.bridge.getFrame("TradeSkillFrame")?.name, undefined, "nothing of it exists before the first open");
    assert.equal(requests.some((path) => path.startsWith(ADDON_PREFIX)), false);
    const widgets = boot.bridge.frames.length;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;

    assert.equal(owner.open(164), true);
    assert.deepEqual(native, [["open", 164]], "the native craft window answers at once");
    assert.equal(owner.isOpen(), true, "the pending open is observable (Escape reaches it)");
    await settle(() => requests.some((path) => path.startsWith(ADDON_PREFIX)));
    assert.equal(boot.bridge.getFrame("TradeSkillFrame")?.name, undefined, "a partial load exposes no root");
    assert.deepEqual(events, []);
    run.release();
    await settle(() => boot.bridge.getFrame("TradeSkillFrame")?.visible === true);

    assert.deepEqual(failures, []);
    assert.deepEqual(native, [["open", 164], ["aside"]], "the native window steps aside only after the gate");
    assert.deepEqual(events, ["TRADE_SKILL_SHOW"]);
    assert.equal(boot.errorCount, errors, `no Lua error: ${boot.vm.errors.slice(-3).join(" | ")}`);
    assert.equal(boot.bridge.diagnostics.length, diagnostics, "no bridge diagnostic");
    const result = run.addon();
    assert.equal(result.ok, true, result.message);
    assert.equal(result.addon, FRAMEXML_TRADESKILL_ADDON);
    assert.deepEqual(result.loaded, [
      `${ADDON_PREFIX}blizzard_tradeskillui.toc`,
      `${ADDON_PREFIX}blizzard_tradeskillui.xml`,
      `${ADDON_PREFIX}blizzard_tradeskillui.lua`,
      `${ADDON_PREFIX}localization.lua`,
    ]);
    assert.deepEqual(result.roots, [], "TradeSkillFrame is parented into the already-rendered UIParent");
    assert.deepEqual([...bytes.entries()].sort(), [
      [`${ADDON_PREFIX}blizzard_tradeskillui.lua`, 22716],
      [`${ADDON_PREFIX}blizzard_tradeskillui.toc`, 135],
      [`${ADDON_PREFIX}blizzard_tradeskillui.xml`, 32139],
      [`${ADDON_PREFIX}localization.lua`, 51],
    ]);
    assert.equal(boot.bridge.frames.length - widgets, 237, "the add-on's widget tree, measured");

    const root = boot.bridge.getFrame("TradeSkillFrame");
    const uiParent = boot.bridge.getFrame("UIParent");
    assert.equal(root.parent, uiParent);
    assert.equal(renderer.elementFor(root).parentElement, renderer.elementFor(uiParent));
    assert.equal(renderer.elementFor(root).getAttribute("data-framexml-name"), "TradeSkillFrame");
    assert.deepEqual([...root.registeredEvents].sort(), [
      "TRADE_SKILL_FILTER_UPDATE", "TRADE_SKILL_UPDATE", "UNIT_PORTRAIT_UPDATE", "UPDATE_TRADESKILL_RECAST",
    ]);
    assert.ok(frameXmlTradeSkillGate(seam, boot, renderer) === undefined,
      "the gate refuses a root that is already showing");

    // What stock painted for the canned Blacksmithing at 110/150.
    assert.equal(lua(boot, `
      local out = {
        TradeSkillFrameTitleText:GetText(), TradeSkillRankFrameSkillRank:GetText(),
        GetTradeSkillSelectionIndex(), TradeSkillSkillName:GetText(),
        TradeSkillCreateButton:IsEnabled() and "create" or "-", TradeSkillCreateButton:GetText(),
        TradeSkillCreateAllButton:IsShown() and "all" or "-", TradeSkillInputBox:GetNumber(),
        TradeSkillFrameEditBox:IsShown() and "search" or "-",
        TradeSkillLinkButton:IsShown() and "link" or "-",
        TradeSkillReagent1Name:GetText(), TradeSkillReagent1Count:GetText(),
        TradeSkillReagent3Name:GetText(), TradeSkillReagent4:IsShown() and "r4" or "-",
        TradeSkillSkill1:GetText(), TradeSkillSkill3Count:GetText(), TradeSkillSkill5:GetText(),
        TradeSkillHighlightFrame:IsShown() and "highlight" or "-",
      }
      for i = 1, #out do out[i] = tostring(out[i]) end
      return table.concat(out, "|")
    `)[0], [
      "Кузнечное дело", "110/150", "2", "Тяжелая медная кувалда", "create", "Создать", "all", "1", "search", "-",
      "Медный слиток", "14 /12", "Тонкая кожа", "-", "Дробящее", "[2]", " Зернистое грузило", "highlight",
    ].join("|"));

    // The list takes the wheel and never the click (the owner's installListPointer): a wheel over the
    // rows reaches the FauxScrollFrame from the window, one step of TRADE_SKILL_HEIGHT rows at a time.
    const list = boot.bridge.getFrame("TradeSkillListScrollFrame");
    assert.equal(list.attributes.enableMouse, "false");
    const wheel = (deltaY) => {
      const event = { type: "wheel", deltaY, clientX: 100, clientY: 300, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
      renderer.elementFor(root).dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(wheel(120), true, "the window hands the wheel to the list");
    const offset = lua(boot, `return FauxScrollFrame_GetOffset(TradeSkillListScrollFrame)`)[0];
    assert.ok(offset > 0, `the list scrolled down (offset ${offset})`);
    assert.equal(lua(boot, `return TradeSkillSkill1:GetText() or TradeSkillSkill1Text:GetText()`)[0] !== "Дробящее", true);
    wheel(-120);
    wheel(-120);
    assert.equal(lua(boot, `return FauxScrollFrame_GetOffset(TradeSkillListScrollFrame)`)[0], 0, "and back to the top");

    // A heading click collapses it on the stock stack; the deferred TRADE_SKILL_UPDATE re-selects.
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("TradeSkillSkill1"), "LeftButton", false), true);
    assert.equal(lua(boot, `return GetNumTradeSkills() .. "|" .. tostring(TradeSkillSkill2:GetText())`)[0],
      "19|Другое");
    run.tick();
    assert.deepEqual(events.slice(1), ["TRADE_SKILL_UPDATE"]);
    assert.equal(lua(boot, `return TradeSkillSkillName:GetText() .. "|" .. GetTradeSkillSelectionIndex()`)[0],
      "Зернистое грузило|3", "the hidden selection falls back to the first recipe (TradeSkillFrame_OnEvent)");
    lua(boot, `ExpandTradeSkillSubClass(0) TradeSkillFrame_Update()`, 0);

    // Row 8 «Грубое точило»: select, three in the box, Create; then Create All for the nine it can.
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("TradeSkillSkill8"), "LeftButton", false), true);
    assert.equal(lua(boot, `return TradeSkillSkillName:GetText() .. "|" .. GetTradeSkillSelectionIndex()`)[0], "Грубое точило|8");
    // The first paint's StopTradeSkillRepeat (CURRENT_TRADESKILL "" -> the line) is stock's own.
    assert.deepEqual(seam.tradeSkillWorld.calls, [{ kind: "stop" }]);
    lua(boot, `TradeSkillInputBox:SetNumber(3)`, 0);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("TradeSkillCreateButton"), "LeftButton", false), true);
    assert.deepEqual(seam.tradeSkillWorld.calls.slice(1), [{ kind: "craft", spellId: 2660, count: 3 }]);
    run.tick();
    assert.equal(events.at(-1), "UPDATE_TRADESKILL_RECAST");
    assert.equal(lua(boot, `return TradeSkillInputBox:GetNumber()`)[0], 3, "the box shows the casts to go");
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("TradeSkillCreateAllButton"), "LeftButton", false), true);
    assert.deepEqual(seam.tradeSkillWorld.calls.at(-1), { kind: "craft", spellId: 2660, count: 9 });
    run.tick();
    assert.equal(events.at(-1), "UPDATE_TRADESKILL_RECAST", "3 to go became 9");
    const mark = events.length;

    // «Есть материалы» and the subclass menu (TradeSkillSubClassDropDownButton_OnClick) filter the list.
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("TradeSkillFrameAvailableFilterCheckButton"), "LeftButton", false), true);
    assert.equal(lua(boot, `return GetNumTradeSkills()`)[0], 16);
    run.tick();
    assert.deepEqual(events.slice(mark), ["TRADE_SKILL_FILTER_UPDATE"]);
    boot.bridge.Click(boot.bridge.getFrame("TradeSkillFrameAvailableFilterCheckButton"), "LeftButton", false);
    lua(boot, `TradeSkillSubClassDropDownButton_OnClick({ GetID = function() return 7 end })`, 0);
    assert.equal(lua(boot, `return GetNumTradeSkills() .. "|" .. TradeSkillSkill1:GetText() .. "|" .. tostring(TradeSkillSkill4:IsShown())`)[0],
      "3|Топор|false");
    lua(boot, `TradeSkillSubClassDropDownButton_OnClick({ GetID = function() return 1 end })`, 0);
    assert.deepEqual(lua(boot, `return table.concat({ GetTradeSkillInvSlots() }, ",")`),
      ["Ноги,Запястья,Двуручное,Правая рука"], "the prelude resolves the slot names in the client's words");

    // The search box as the renderer's input path types into it (OnTextChanged, isUserInput):
    // TradeSkillFilter_OnTextChanged sets the name filter.
    const search = boot.bridge.getFrame("TradeSkillFrameEditBox");
    lua(boot, `TradeSkillFrameEditBox:SetText("точило")`, 0);
    boot.bridge.fireScript(search, "OnTextChanged", true);
    run.tick();
    assert.equal(lua(boot, `return GetNumTradeSkills() .. "|" .. TradeSkillSkillName:GetText()`)[0], "3|Зернистое точило");
    lua(boot, `TradeSkillFrameEditBox:SetText(SEARCH)`, 0);
    boot.bridge.fireScript(search, "OnTextChanged", true);
    run.tick();
    assert.equal(lua(boot, `return GetNumTradeSkills()`)[0], 21);

    // Enchanting while Blacksmithing shows: the same window switches lines (TRADE_SKILL_SHOW again).
    assert.equal(owner.open(333), true);
    assert.equal(lua(boot, `
      return table.concat({ TradeSkillFrameTitleText:GetText(), TradeSkillSkillName:GetText(),
        TradeSkillCreateButton:GetText(), tostring(TradeSkillCreateAllButton:IsShown()),
        tostring(TradeSkillInputBox:IsShown()), tostring(TradeSkillDescription:GetText()) }, "|")
    `)[0], "Наложение чар|Чары для наручей - отражение I|Зачаровать|false|false|Наложение на наручи чар, повышающих рейтинг защиты на 2.");
    lua(boot, `TradeSkillFrame_SetSelection(3) TradeSkillFrame_Update()`, 0);
    boot.bridge.Click(boot.bridge.getFrame("TradeSkillCreateButton"), "LeftButton", false);
    assert.deepEqual(lua(boot, `return SpellCanTargetItem()`), [true], "the enchant waits for its item");
    assert.equal(seam.tradeSkill.targetItem(FRAMEXML_CANNED_BRACERS_GUID), true);
    assert.deepEqual(seam.tradeSkillWorld.calls.at(-1), { kind: "item", spellId: 7418, guid: FRAMEXML_CANNED_BRACERS_GUID });

    // Escape: HideUIPanel, whose OnHide is CloseTradeSkill (the queue stops, TRADE_SKILL_CLOSE).
    const callsBefore = seam.tradeSkillWorld.calls.length;
    assert.equal(owner.close(), true);
    assert.equal(root.visible, false);
    assert.equal(owner.isOpen(), false);
    assert.equal(events.at(-1), "TRADE_SKILL_CLOSE");
    assert.deepEqual(seam.tradeSkillWorld.calls.slice(callsBefore), [{ kind: "stop" }]);
    assert.deepEqual(lua(boot, `return GetTradeSkillLine()`, 3), ["UNKNOWN", 0, 0]);
    assert.equal(owner.close(), false, "nothing further to close");
    // Reopened: no second load, the gate is not rerun, and the line comes back.
    const reads = requests.length;
    assert.equal(owner.open(164), true);
    assert.equal(root.visible, true);
    assert.equal(requests.length, reads);
    assert.deepEqual(native.filter(([kind]) => kind === "open"), [["open", 164]],
      "the native window showed only while the first load ran");
    // The same profession's opener again closes it; another profession's switches lines (above).
    assert.equal(owner.open(164), true);
    assert.equal(root.visible, false, "a second press of the same profession closes its window");
    assert.equal(events.at(-1), "TRADE_SKILL_CLOSE");
    assert.equal(owner.open(164), true);
    assert.equal(root.visible, true);
    assert.equal(boot.errorCount, errors, `no Lua error across the flows: ${boot.vm.errors.slice(-3).join(" | ")}`);
    assert.equal(boot.bridge.diagnostics.length, diagnostics, "no bridge diagnostic across the flows");
  } finally {
    run.close();
  }
});

test("the native window closed by its own controls while the add-on loads is a close", { skip }, async () => {
  const run = await stage({ barrier: true });
  const { boot, owner, native, nativeShown, failures, events, requests } = run;
  try {
    assert.equal(owner.open(164), true);
    await settle(() => requests.some((path) => path.startsWith(ADDON_PREFIX)));
    assert.equal(owner.isOpen(), true);
    // Its close button, or Escape in its search box (ui/Professions.ts), only hides that panel.
    nativeShown.delete(164);
    assert.equal(owner.isOpen(), false, "Escape has nothing of the trade skill window left to close");
    run.release();
    await settle(() => run.addon() !== undefined && boot.bridge.getFrame("TradeSkillFrame") !== undefined);
    await settle(() => false, 5);
    assert.deepEqual(failures, [], boot.vm.errors.slice(-3).join(" | "));
    assert.equal(boot.bridge.getFrame("TradeSkillFrame").visible, false, "the stock window does not appear by itself");
    assert.deepEqual(events, [], "no TRADE_SKILL_SHOW for a line the player closed");
    assert.deepEqual(native, [["open", 164]], "nothing stepped aside, nothing reopened");
    assert.equal(owner.open(164), true, "the next open is the stock window's");
    assert.equal(boot.bridge.getFrame("TradeSkillFrame").visible, true);
    assert.deepEqual(events, ["TRADE_SKILL_SHOW"]);
  } finally {
    run.close();
  }

  // A native side that showed nothing (no world behind the canned seam, a refused line) had no
  // window to close: the wanted line still opens in the stock window once it is proven.
  const bare = await stage({ barrier: true, nativeShows: false });
  try {
    assert.equal(bare.owner.open(164), true);
    assert.equal(bare.owner.isOpen(), true, "the pending open still answers Escape");
    bare.release();
    await settle(() => bare.boot.bridge.getFrame("TradeSkillFrame")?.visible === true);
    assert.equal(bare.boot.bridge.getFrame("TradeSkillFrame")?.visible, true);
    assert.deepEqual(bare.events, ["TRADE_SKILL_SHOW"]);
  } finally {
    bare.close();
  }
});

test("a failed load keeps the native window, demotes the owner and never fires TRADE_SKILL_SHOW", { skip }, async () => {
  const run = await stage();
  const { boot, owner, native, failures, events } = run;
  try {
    boot.loadAddon = async () => ({ ok: false, addon: FRAMEXML_TRADESKILL_ADDON, status: "failed", message: "test",
      dependencies: [], loaded: [], roots: [] });
    assert.equal(owner.open(164), true);
    await settle(() => failures.length > 0);
    assert.deepEqual(failures, ["failed"]);
    assert.deepEqual(native, [["open", 164], ["open", 164]], "the native window, then its reopening on demotion");
    assert.deepEqual(events, [], "UIParent never saw TRADE_SKILL_SHOW for an add-on that is not there");
    assert.equal(owner.open(164), false, "a demoted owner declines; openProfession then opens natively");
    assert.equal(owner.isOpen(), false);
  } finally {
    run.close();
  }
});

test("a stock refusal (a fullscreen panel is up) is CloseTradeSkill, not a demotion", { skip }, async () => {
  const run = await stage();
  const { boot, owner, native, failures, events } = run;
  try {
    assert.equal(owner.open(164), true);
    await settle(() => boot.bridge.getFrame("TradeSkillFrame")?.visible === true);
    assert.deepEqual(failures, [], boot.vm.errors.slice(-3).join(" | "));
    owner.close();
    // A fullscreen panel (the world map's area) makes ShowUIPanel refuse a "left" panel
    // (FramePositionDelegate:ShowUIPanel, UIParent.lua:1341-1349): TradeSkillFrame_ShowFailed.
    lua(boot, `
      local full = CreateFrame("Frame", "TradeSkillTestFullscreen", UIParent)
      full:Hide()
      UIPanelWindows["TradeSkillTestFullscreen"] = { area = "full", pushable = 0 }
      ShowUIPanel(full)
    `, 0);
    assert.equal(boot.bridge.getFrame("TradeSkillTestFullscreen").visible, true);
    events.length = 0;
    const errors = boot.errorCount;
    assert.equal(owner.open(164), true);
    assert.equal(boot.errorCount, errors, boot.vm.errors.slice(-3).join(" | "));
    assert.deepEqual(failures, []);
    assert.equal(boot.bridge.getFrame("TradeSkillFrame").visible, false);
    assert.deepEqual(events, ["TRADE_SKILL_SHOW", "TRADE_SKILL_CLOSE"], "stock closed the line itself");
    assert.equal(native.filter(([kind]) => kind === "open").length, 1, "no native window for a stock refusal");
    lua(boot, `HideUIPanel(TradeSkillTestFullscreen)`, 0);
    assert.equal(owner.open(164), true, "the next open works");
    assert.equal(boot.bridge.getFrame("TradeSkillFrame").visible, true);
    assert.equal(boot.errorCount, errors, boot.vm.errors.slice(-3).join(" | "));
  } finally {
    run.close();
  }
});
