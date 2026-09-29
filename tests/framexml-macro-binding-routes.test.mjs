import assert from "node:assert/strict";
import test from "node:test";

// The ownership routes of the two load-on-demand windows (FrameXmlMacroBindingLod.ts and the two
// controllers) and the native modules' entry points that ask them first (Macros.ts, KeyBindings.ts).
const nodes = new Map();
function node(tag = "div") {
  const attrs = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], dataset: {}, hidden: false, disabled: false,
    checked: false, textContent: "", value: "", className: "", title: "",
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append(...children) { this.children.push(...children); for (const child of children) child.parentNode = this; },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    addEventListener() {}, removeEventListener() {},
    setAttribute(name, value) { attrs.set(name, String(value)); }, getAttribute(name) { return attrs.get(name) ?? null; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? node("button") : undefined; },
    querySelectorAll() { return []; }, focus() {}, remove() {},
  };
}
globalThis.document = {
  body: node("body"), documentElement: node("html"), activeElement: undefined, createElement: node,
  getElementById(id) { if (!nodes.has(id)) { const element = node(); element.id = id; nodes.set(id, element); } return nodes.get(id); },
  querySelectorAll() { return []; },
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900, location: { search: "" },
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
};
globalThis.location = { origin: "http://localhost:5173", protocol: "http:", hostname: "localhost" };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const { createFrameXmlLodWindowOwner, FrameXmlLodWindowRoute } = await import("../dist/code/browser/framexml/FrameXmlMacroBindingLod.js");
const macroRoute = await import("../dist/code/browser/framexml/FrameXmlMacroController.js");
const bindingRoute = await import("../dist/code/browser/framexml/FrameXmlBindingController.js");
const keyBindings = await import("../dist/code/browser/ui/KeyBindings.js");
const macros = await import("../dist/code/browser/ui/Macros.js");
const { GLOBAL_MACROS_CACHE } = await import("../dist/code/world/SessionProtocol.js");
usePanelHost({ viewport: document.body, attach() {} });

/** A published owner the tests can watch: open state, calls, and a failure switch. */
function fakeOwner() {
  const calls = [];
  const owner = {
    open: false, failed: false, calls,
    isOpen: () => owner.open,
    show: () => { calls.push("show"); if (owner.failed) return false; owner.open = true; return true; },
    hide: () => { calls.push("hide"); owner.open = false; },
    dispose: () => { calls.push("dispose"); owner.open = false; },
  };
  return owner;
}

test("KeyBindings.ts asks the stock route first, and opens its Panel only without a usable one", () => {
  const owner = fakeOwner();
  const cleanup = bindingRoute.publishFrameXmlKeyBindings(owner);
  try {
    keyBindings.toggleKeyBindingsWindow();
    assert.deepEqual(owner.calls, ["show"]);
    assert.equal(keyBindings.keyBindingsOpen(), true, "the stock window is the open one");
    keyBindings.toggleKeyBindingsWindow();
    assert.deepEqual(owner.calls, ["show", "hide"]);
    assert.equal(keyBindings.keyBindingsOpen(), false);
    // A failed load or gate leaves the route to the native Panel.
    owner.failed = true;
    keyBindings.toggleKeyBindingsWindow();
    assert.deepEqual(owner.calls, ["show", "hide"], "a failed owner is not asked");
    assert.equal(keyBindings.keyBindingsOpen(), true, "the native Panel opened");
    keyBindings.closeKeyBindingsWindow();
    assert.equal(keyBindings.keyBindingsOpen(), false);
  } finally {
    cleanup();
  }
  assert.deepEqual(owner.calls.at(-1), "dispose", "unpublishing disposes the owner");
  assert.equal(bindingRoute.frameXmlKeyBindingsPublished(), false);
  keyBindings.toggleKeyBindingsWindow();
  assert.equal(keyBindings.keyBindingsOpen(), true, "nothing published: the native Panel");
  keyBindings.toggleKeyBindingsWindow();
});

test("Macros.ts: toggle, open and close ask the stock route first; the store is the account-data pair", () => {
  const owner = fakeOwner();
  const cleanup = macroRoute.publishFrameXmlMacro(owner);
  try {
    macros.openMacroWindow();
    macros.openMacroWindow();
    assert.deepEqual(owner.calls, ["show", "show"], "open never closes");
    assert.equal(macros.macroWindowOpen(), true);
    macros.toggleMacroWindow();
    assert.equal(macros.macroWindowOpen(), false);
    macros.toggleMacroWindow();
    macros.closeMacroWindow();
    assert.equal(owner.open, false);
    assert.deepEqual(owner.calls, ["show", "show", "hide", "show", "hide"]);
  } finally {
    cleanup();
  }
  macros.openMacroWindow();
  assert.equal(macros.macroWindowOpen(), true, "nothing published: the native Panel");
  macros.resetMacroWindow();
  assert.equal(macros.macroWindowOpen(), false);

  // The stock API's store is the two stores the native window writes, with their listeners.
  const store = macros.frameXmlMacroStore;
  let heard = 0;
  const unsubscribe = store.subscribe(() => { heard += 1; });
  store.put({ index: 2, name: "A", body: "/a", icon: "Interface\\Icons\\Ability_Defend" });
  store.put({ index: 40, name: "B", body: "/b" });
  assert.deepEqual(store.list().map((macro) => macro.index), [2, 40]);
  assert.equal(macros.macroAt(2).icon, "Interface\\Icons\\Ability_Defend");
  assert.equal(heard, 0, "the API's own writes are not echoed back as outside changes");
  // The server's copy landing is an outside change.
  const world = {
    requestAccountData() {}, saveAccountData: async () => {},
    accountData: new Map([[GLOBAL_MACROS_CACHE, { text: '[{"index":1,"name":"S","body":"/s"}]' }]]),
  };
  macros.macroStores[0].attach(world);
  assert.equal(macros.macroStores[0].accept(GLOBAL_MACROS_CACHE), true);
  assert.equal(heard, 1);
  assert.deepEqual(store.list().map((macro) => macro.index), [1, 40]);
  unsubscribe();
  store.remove(1);
  store.remove(40);
  macros.macroStores[0].detach();
});

function fakeBoot({ ok = true } = {}) {
  const frame = { name: "Root" };
  const state = { visible: false, sources: [], loads: [] };
  const boot = {
    errorCount: 0,
    loadAddon: async (name) => { state.loads.push(name); return { ok, roots: [], message: ok ? undefined : "missing" }; },
    vm: {
      errors: [],
      executeReported: (source) => {
        state.sources.push(source);
        if (source === "SHOW") state.visible = true;
        if (source === "HIDE") state.visible = false;
        return true;
      },
    },
    bridge: {
      diagnostics: [],
      isVisible: () => state.visible,
      Hide: () => { state.visible = false; return true; },
      runInMutationBatch: (fn) => fn(),
    },
  };
  const renderer = { addRoots() {}, sync() {} };
  return { boot, renderer, frame, state };
}

const settle = async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };

test("the lazy owner loads on the first show only, gates, shows the stock window, and can be taken back while loading", async () => {
  const { boot, renderer, frame, state } = fakeBoot();
  let gated = 0;
  const failures = [];
  const owner = createFrameXmlLodWindowOwner(boot, renderer, {
    addon: "Blizzard_Test",
    gate: () => { gated += 1; return frame; },
    showSource: "SHOW", hideSource: "HIDE",
    onFailure: (wanted) => failures.push(wanted),
  });
  assert.deepEqual(state.loads, [], "nothing at construction");
  assert.equal(owner.show(), true);
  assert.equal(owner.isOpen(), true, "the pending request is the open state");
  await settle();
  assert.deepEqual(state.loads, ["Blizzard_Test"]);
  assert.equal(gated, 1);
  assert.equal(state.visible, true);
  owner.hide();
  assert.equal(state.visible, false);
  assert.equal(owner.show(), true);
  await settle();
  assert.deepEqual(state.loads, ["Blizzard_Test"], "one load per VM");
  assert.deepEqual(state.sources, ["SHOW", "HIDE", "SHOW"]);
  // Taken back while loading: the second owner opens nothing when its load lands.
  const second = fakeBoot();
  const quiet = createFrameXmlLodWindowOwner(second.boot, second.renderer, {
    addon: "Blizzard_Test", gate: () => second.frame, showSource: "SHOW", hideSource: "HIDE", onFailure() {},
  });
  quiet.show();
  quiet.hide();
  await settle();
  assert.equal(second.state.visible, false);
  assert.deepEqual(failures, []);
  owner.dispose();
  assert.equal(owner.isOpen(), false);
  assert.equal(owner.show(), false, "a disposed owner opens nothing");
});

test("a show the stock panel manager declines is not a failure; a Lua error during the show is", async () => {
  const { boot, renderer, frame, state } = fakeBoot();
  const failures = [];
  let decline = true;
  boot.vm.executeReported = (source) => {
    state.sources.push(source);
    if (source === "SHOW" && !decline) state.visible = true;
    if (source === "SHOW" && !decline && state.raise) boot.errorCount += 1;
    return true;
  };
  const owner = createFrameXmlLodWindowOwner(boot, renderer, {
    addon: "Blizzard_Test", gate: () => frame, showSource: "SHOW", hideSource: "HIDE",
    onFailure: (wanted) => failures.push(wanted),
  });
  owner.show();
  await settle();
  assert.equal(state.visible, false, "another UIPanel held the place");
  assert.equal(owner.failed, false);
  assert.equal(owner.isOpen(), false);
  decline = false;
  owner.show();
  assert.equal(state.visible, true, "the next press opens it");
  owner.hide();
  state.raise = true;
  owner.show();
  assert.equal(owner.failed, true, "an error while showing demotes");
  assert.deepEqual(failures, [true]);
});

test("a failed load or gate demotes the owner once and opens the native window for a waiting player", async () => {
  for (const failing of ["load", "gate"]) {
    const { boot, renderer, frame } = fakeBoot({ ok: failing !== "load" });
    const failures = [];
    const route = new FrameXmlLodWindowRoute();
    const owner = createFrameXmlLodWindowOwner(boot, renderer, {
      addon: "Blizzard_Test", gate: () => (failing === "gate" ? undefined : frame),
      showSource: "SHOW", hideSource: "HIDE", onFailure: (wanted) => failures.push(wanted),
    });
    const cleanup = route.publish(owner);
    assert.equal(route.open(), true, `${failing}: the route takes the first open`);
    await settle();
    assert.deepEqual(failures, [true], `${failing}: native opens for the waiting player`);
    assert.equal(owner.failed, true);
    assert.equal(route.published(), false, `${failing}: the route stops answering`);
    assert.equal(route.open(), false, `${failing}: the next open is the native window's`);
    assert.equal(route.toggle(), false);
    cleanup();
  }
});
