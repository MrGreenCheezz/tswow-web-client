import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the production vertical over the canned seam, rendered by the real FrameXmlDomRenderer
// on a stand-in document, then the real load-on-demand Blizzard_MacroUI and Blizzard_BindingUI loaded
// through this lane's owners (FrameXmlMacroBindingMount.ts) and driven through their own Lua.
function fakeDocument() {
  const ids = new Map();
  const doc = {
    activeElement: undefined,
    head: undefined,
    body: undefined,
    createElement(tag) { return makeNode(tag); },
    createElementNS(_namespace, tag) { return makeNode(tag); },
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, makeNode("div"));
      return ids.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  function style() {
    return { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; } };
  }
  function makeNode(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: undefined, parentNode: undefined,
      style: style(), hidden: false, className: "", dataset: {}, textContent: "", value: "", disabled: false,
      width: 0, height: 0, offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
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
          if (!child || typeof child !== "object") continue;
          child.parentElement?.removeChild(child);
          child.parentElement = node;
          child.parentNode = node;
          node.children.push(child);
        }
      },
      appendChild(child) { node.append(child); return child; },
      insertBefore(child, before) {
        child.parentElement?.removeChild(child);
        child.parentElement = node;
        child.parentNode = node;
        const index = node.children.indexOf(before);
        if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        if (child.parentElement === node) child.parentElement = undefined;
        if (child.parentNode === node) child.parentNode = undefined;
      },
      replaceChildren(...children) {
        for (const child of node.children) { child.parentElement = undefined; child.parentNode = undefined; }
        node.children = [];
        node.append(...children);
      },
      contains(other) {
        for (let current = other; current; current = current.parentElement) if (current === node) return true;
        return false;
      },
      remove() { node.parentElement?.removeChild(node); },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      removeAttribute(name) { attributes.delete(String(name)); },
      hasAttribute(name) { return attributes.has(String(name)); },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      removeEventListener(name, listener) { listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== listener)); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      querySelector(selector) { return selector === 'button[type="submit"]' ? makeNode("button") : undefined; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange() {},
      getContext() { return undefined; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    };
    return node;
  }
  doc.head = makeNode("head");
  doc.body = makeNode("body");
  return doc;
}

/** The window's own listeners, so a test can press a key the way the page does. */
const windowListeners = [];
globalThis.document = fakeDocument();
globalThis.window = {
  devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener(type, listener, capture) { windowListeners.push({ type, listener, capture: capture === true }); },
  removeEventListener(type, listener) {
    const index = windowListeners.findIndex((entry) => entry.type === type && entry.listener === listener);
    if (index >= 0) windowListeners.splice(index, 1);
  },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;

const bindings = await import("../dist/code/browser/input/Bindings.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { mountFrameXmlMacroBindingWindows } = await import("../dist/code/browser/framexml/FrameXmlMacroBindingMount.js");
const macroRoute = await import("../dist/code/browser/framexml/FrameXmlMacroController.js");
const bindingRoute = await import("../dist/code/browser/framexml/FrameXmlBindingController.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
/** Measured closures of the two add-ons (see the tests that assert them). */
const MACRO_UI_BYTES = 36_797;
const MACRO_UI_WIDGETS = 472;
const BINDING_UI_BYTES = 29_666;
const BINDING_UI_WIDGETS = 312;
const storage = new Map();
bindings.useBindingStorage({ getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } });

const requests = [];
const addonBytes = new Map();
let boot;
let renderer;
let seam;
let loadMs = 0;
let cleanup;
const native = { macros: 0, keyBindings: 0 };

async function ready() {
  if (boot) return;
  seam = new CannedWorldSeam();
  boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalize(path);
        requests.push(key);
        const data = await chain.read(path);
        if (data && /^interface\/addons\/blizzard_(?:macroui|bindingui)\//.test(key)) addonBytes.set(key, data.byteLength);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false,
    screen: () => ({ width: 1365, height: 768 }),
  });
  const started = performance.now();
  await boot.load();
  loadMs = performance.now() - started;
  renderer = new FrameXmlDomRenderer(document.createElement("section"), { bridge: boot.bridge });
  renderer.mount(boot.roots);
  cleanup = mountFrameXmlMacroBindingWindows(seam, boot, renderer, {
    openMacros: () => { if (!macroRoute.openFrameXmlMacro()) native.macros += 1; },
    openNativeMacros: () => { native.macros += 1; },
    openNativeKeyBindings: () => { native.keyBindings += 1; },
  }).publish();
}

after(() => {
  cleanup?.();
  seam?.detach();
  boot?.close();
  chain?.close();
});

function lua(code, results = 1) {
  const fn = boot.vm.compileFunction(code, "macro-binding-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const frame = (name) => boot.bridge.getFrame(name);
const shown = (name) => boot.bridge.isVisible(frame(name));
const text = (name) => lua(`return ${name}:GetText()`)[0];
const click = (name, button = "LeftButton") => boot.bridge.Click(frame(name), button, false);
const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
/** The renderer's implicit label span of a Button (the text of a template without <ButtonText>). */
const labelOf = (name) => renderer.elementFor(frame(name)).children.find((child) => child.getAttribute("data-framexml-label") === "true");

async function until(predicate, label) {
  for (let index = 0; index < 400 && !predicate(); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), label);
}

/** One keydown through the window's capture listeners, in registration order (or reversed). */
function press(code, modifiers = {}, { reversed = false } = {}) {
  const event = {
    type: "keydown", code, repeat: false, shiftKey: !!modifiers.shift, ctrlKey: !!modifiers.ctrl, altKey: !!modifiers.alt,
    target: globalThis.window, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
  };
  const listeners = windowListeners.filter((listener) => listener.type === "keydown" && listener.capture);
  for (const entry of reversed ? listeners.reverse() : listeners) entry.listener(event);
  return event;
}

test("boot loads neither add-on; the stock bars and micro buttons read the key table", withClient, async () => {
  await ready();
  assert.equal(frame("MacroFrame"), undefined, "Blizzard_MacroUI is not loaded at boot");
  assert.equal(frame("KeyBindingFrame"), undefined, "Blizzard_BindingUI is not loaded at boot");
  assert.equal(requests.some((path) => /blizzard_(?:macroui|bindingui)/.test(path)), false, "nothing of either is read");
  assert.equal(boot.vm.errors.length, 0, boot.vm.errors.join(" | "));
  // ActionButton_UpdateHotkeys: GetBindingKey("ACTIONBUTTON1") → "1", GetBindingText(key, "KEY_", 1).
  assert.equal(text("ActionButton1HotKey"), "1");
  assert.equal(shown("ActionButton1HotKey"), true);
  assert.equal(text("ActionButton11HotKey"), "-");
  assert.equal(shown("MultiBarBottomLeftButton1HotKey"), false, "an unbound extra-bar slot hides its hotkey");
  // GetBindingText and GetBindingFromClick are UIParent.lua's own; they read the keys through the C API.
  assert.deepEqual(lua('return GetBindingText(GetBindingKey("ACTIONPAGE1"), "KEY_", 1), GetBindingText("CTRL-SHIFT-F", "KEY_")', 2),
    ["s-1", "CTRL-SHIFT-F"]);
  assert.deepEqual(lua('return GetBindingText("NUMPADDIVIDE", "KEY_"), GetBindingText(GetBindingKey("TOGGLERUN"), "KEY_"), GetBindingText(nil, "KEY_", 1)', 3),
    ["/ (цифр. кл.)", "/ (цифр. кл.)", ""]);
  assert.deepEqual(lua('return GetBindingFromClick("ESCAPE"), GetBindingFromClick("1"), GetBindingFromClick("F11")', 3),
    ["TOGGLEGAMEMENU", "ACTIONBUTTON1", undefined]);
  // A WebClient row's label is defined the first time GetBinding lists it.
  assert.deepEqual(lua(`
    for index = 1, GetNumBindings() do GetBinding(index) end
    return GetBindingText("MOVEFORWARD", "BINDING_NAME_"), GetBindingText("WEBCLIENT_TOGGLEDIAGNOSTICS", "BINDING_NAME_"),
      BINDING_HEADER_WEBCLIENT, BINDING_NAME_MOVEFORWARD`, 4),
  ["Движение вперед", "Диагностика", "WebClient", "Движение вперед"], "a GlobalStrings label is never replaced");
  // A rebinding reaches the bar through UPDATE_BINDINGS.
  bindings.bindKey("action1", 0, "Shift+KeyQ");
  seam.keyBindings.tick(1000);
  assert.equal(text("ActionButton1HotKey"), "s-Q");
  bindings.bindKey("action1", 0, "Digit1");
  bindings.bindKey("strafeLeft", 0, "KeyQ");
  seam.keyBindings.tick(2000);
  assert.equal(text("ActionButton1HotKey"), "1");
  console.log(`[macro/binding] vertical boot ${Math.round(loadMs)} ms`);
});

const addonBytesOf = (folder) => [...addonBytes].filter(([path]) => path.includes(folder)).reduce((sum, [, size]) => sum + size, 0);

test("the first open loads Blizzard_MacroUI, passes its gate and shows the canned macros over their slot gap", withClient, async () => {
  await ready();
  const errors = boot.errorCount;
  const diagnostics = boot.bridge.diagnostics.length;
  const widgets = boot.bridge.frames.length;
  const started = performance.now();
  // The first open is the client's own ShowMacroFrame (`/macro`, the chat menu, the game menu), which
  // alone would answer «not loaded»: Lua's LoadAddOn is a status view here.
  lua("ShowMacroFrame()", 0);
  assert.equal(macroRoute.frameXmlMacroOpen(), true, "the pending open is observable");
  await until(() => frame("MacroFrame") && shown("MacroFrame"), "MacroFrame shows once loaded and gated");
  const openMs = performance.now() - started;
  assert.equal(native.macros, 0, "the native window never opened");
  assert.equal(boot.errorCount, errors, boot.vm.errors.slice(errors).join(" | "));
  assert.equal(boot.bridge.diagnostics.length, diagnostics, JSON.stringify(boot.bridge.diagnostics.slice(diagnostics)));
  assert.deepEqual([...addonBytes.keys()].filter((path) => path.includes("macroui")).sort(), [
    "interface/addons/blizzard_macroui/blizzard_macroui.lua", "interface/addons/blizzard_macroui/blizzard_macroui.toc",
    "interface/addons/blizzard_macroui/blizzard_macroui.xml", "interface/addons/blizzard_macroui/localization.lua",
  ]);
  // The closure, measured on this client's MPQ chain (2026-09-25): four files, their bytes, the
  // widgets the add-on built (36 MacroButtons from Lua among them), and no Lua error.
  const closure = { files: 4, bytes: addonBytesOf("macroui"), widgets: boot.bridge.frames.length - widgets };
  console.log(`[macro/binding] Blizzard_MacroUI closure ${JSON.stringify(closure)}`);
  assert.deepEqual(closure, { files: 4, bytes: MACRO_UI_BYTES, widgets: MACRO_UI_WIDGETS });
  // The account tab: slot 1 «Рывок», slot 3 «Привет» at positions 1 and 2; the rest disabled.
  assert.equal(text("MacroButton1Name"), "Рывок");
  assert.equal(text("MacroButton2Name"), "Привет");
  assert.equal(lua("return MacroButton3:IsEnabled()")[0], 0);
  assert.equal(lua("return MacroButton1Icon:GetTexture()")[0].toLowerCase(), "interface\\icons\\ability_warrior_charge");
  assert.equal(text("MacroFrameSelectedMacroName"), "Рывок");
  assert.equal(text("MacroFrameText"), "#showtooltip\n/cast Рывок");
  assert.equal(text("MacroFrameCharLimitText"), "Символы: 24/255", "the counter counts characters, not bytes");
  assert.equal(frame("MacroButton37"), undefined, "36 buttons, the larger of the two sets");
  // «Удалить» (UIPanelButtonGrayTemplate, no ButtonText) is drawn over its grey plate, as a ButtonText is.
  assert.equal(labelOf("MacroDeleteButton").style.zIndex, "400");
  // The character tab.
  click("MacroFrameTab2");
  assert.equal(text("MacroButton1Name"), "Щит");
  assert.equal(shown("MacroButton19"), false, "18 character slots");
  click("MacroFrameTab1");
  console.log(`[macro/binding] Blizzard_MacroUI first open ${Math.round(openMs)} ms`);
});

test("MacroFrame writes through the C API: new, rename with an icon, body, delete, pickup onto the bar", withClient, async () => {
  await ready();
  if (!shown("MacroFrame")) {
    macroRoute.openFrameXmlMacro();
    await until(() => shown("MacroFrame"), "MacroFrame open");
  }
  const errors = boot.errorCount;
  const store = seam.macroWorld.store;
  // New: the popup opens on icon 1; a name and icon 3 then Okay.
  click("MacroNewButton");
  assert.equal(shown("MacroPopupFrame"), true);
  lua('MacroPopupEditBox:SetText("Тест")', 0);
  click("MacroPopupButton3");
  assert.equal(lua("return MacroPopupOkayButton:IsEnabled()")[0], 1);
  click("MacroPopupOkayButton");
  assert.equal(shown("MacroPopupFrame"), false);
  assert.deepEqual(store.list().map((macro) => [macro.index, macro.name, macro.icon ?? "?"]), [
    [1, "Рывок", "Interface\\Icons\\Ability_Warrior_Charge"], [2, "Тест", "Interface\\Icons\\Ability_Defend"],
    [3, "Привет", "?"], [37, "Щит", "Interface\\Icons\\Ability_Defend"],
  ], "the lowest free account slot, the icon the popup chose");
  assert.equal(text("MacroButton2Name"), "Тест", "position 2 is slot 2 now");
  assert.equal(text("MacroFrameSelectedMacroName"), "Тест");
  // The body: typing (the renderer fires OnTextChanged for typed input) sets textChanged; selecting
  // another macro saves it (MacroFrame_SaveMacro → EditMacro(selected, nil, nil, text)).
  lua('MacroFrameText:SetText("/dance")', 0);
  boot.bridge.fireScript(frame("MacroFrameText"), "OnTextChanged", true);
  assert.equal(text("MacroFrameCharLimitText"), "Символы: 6/255");
  click("MacroButton1");
  assert.equal(store.list().find((macro) => macro.index === 2).body, "/dance");
  // Rename through the edit popup.
  click("MacroButton2");
  click("MacroEditButton");
  lua('MacroPopupEditBox:SetText("Танец")', 0);
  click("MacroPopupOkayButton");
  assert.equal(store.list().find((macro) => macro.index === 2).name, "Танец");
  assert.equal(store.list().find((macro) => macro.index === 2).icon, "Interface\\Icons\\Ability_Defend", "the icon stays");
  // Delete: the selection steps back and the positions close up.
  click("MacroDeleteButton");
  assert.deepEqual(store.list().map((macro) => macro.index), [1, 3, 37]);
  assert.equal(text("MacroButton2Name"), "Привет");
  // Pickup (the selected macro's big button) and a press on an action button places it.
  click("MacroButton1");
  click("MacroFrameSelectedMacroButton");
  assert.deepEqual(lua("return GetCursorInfo()", 2), ["macro", 1]);
  click("ActionButton5");
  assert.deepEqual(seam.macroWorld.placed, [[5, 1]], "ActionButton5 → UseAction(5) → the macro's slot on it");
  assert.deepEqual(lua("return GetCursorInfo()", 1), [undefined]);
  await settle();
  assert.equal(boot.errorCount, errors, boot.vm.errors.slice(errors).join(" | "));
  // The route closes it; Escape's CloseAllWindows knows it as a UIPanel.
  assert.equal(macroRoute.toggleFrameXmlMacro(), true);
  assert.equal(shown("MacroFrame"), false);
  assert.equal(lua('return UIPanelWindows["MacroFrame"].area')[0], "left");
});

test("the first open loads Blizzard_BindingUI; keys pressed while it is shown bind, Cancel and Escape take them back", withClient, async () => {
  await ready();
  const errors = boot.errorCount;
  const diagnostics = boot.bridge.diagnostics.length;
  const widgets = boot.bridge.frames.length;
  const started = performance.now();
  assert.equal(bindingRoute.openFrameXmlKeyBindings(), true);
  await until(() => frame("KeyBindingFrame") && shown("KeyBindingFrame"), "KeyBindingFrame shows once loaded and gated");
  const openMs = performance.now() - started;
  assert.equal(native.keyBindings, 0);
  assert.deepEqual([...addonBytes.keys()].filter((path) => path.includes("bindingui")).sort(), [
    "interface/addons/blizzard_bindingui/blizzard_bindingui.lua", "interface/addons/blizzard_bindingui/blizzard_bindingui.toc",
    "interface/addons/blizzard_bindingui/blizzard_bindingui.xml", "interface/addons/blizzard_bindingui/localization.lua",
  ]);
  const closure = { files: 4, bytes: addonBytesOf("bindingui"), widgets: boot.bridge.frames.length - widgets };
  console.log(`[macro/binding] Blizzard_BindingUI closure ${JSON.stringify(closure)}`);
  assert.deepEqual(closure, { files: 4, bytes: BINDING_UI_BYTES, widgets: BINDING_UI_WIDGETS });
  assert.equal(boot.errorCount, errors, boot.vm.errors.slice(errors).join(" | "));
  assert.equal(boot.bridge.diagnostics.length, diagnostics, JSON.stringify(boot.bridge.diagnostics.slice(diagnostics)));
  assert.equal(shown("KeyBindingFrameCharacterButton"), false, "one binding set: the character box is hidden");
  assert.equal(lua('return GetBindingText("NUMPADENTER", "KEY_")')[0], "Enter (цифр. кл.)", "the keypad Enter is named like its neighbours");
  assert.deepEqual(lua('return GetBindingText("NUMPADEQUAL", "KEY_"), GetBindingText("INTLBACKSLASH", "KEY_")', 2),
    ["= (цифр. кл.)", "\\ (ISO)"]);
  // «По умолчанию» is drawn over its grey plate (the renderer's implicit label, OVERLAY). The frame,
  // focused as the modal's first control, draws no browser focus ring: style.css's FrameXML
  // `:focus-visible` rule, not an inline style on this one window.
  assert.equal(labelOf("KeyBindingFrameDefaultButton").style.zIndex, "400");
  assert.equal(renderer.elementFor(frame("KeyBindingFrame")).style.outline ?? "", "");
  // The rows are Bindings.xml's: a header, then MOVEFORWARD with W and ↑.
  assert.equal(text("KeyBindingFrameBinding1Header"), "Перемещение");
  assert.equal(text("KeyBindingFrameBinding2Description"), "Движение вперед");
  assert.equal(text("KeyBindingFrameBinding2Key1Button"), "W");
  assert.equal(text("KeyBindingFrameBinding2Key2Button"), "Стрелка вверх");
  // A key press while the frame is up never reaches the world.
  const idle = press("KeyW");
  assert.equal(idle.prevented && idle.stopped, true);
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", "ArrowUp"], "nothing selected: nothing bound");
  // Select MOVEFORWARD's key 1, press Shift+Z.
  click("KeyBindingFrameBinding2Key1Button");
  assert.equal(lua("return KeyBindingFrame.selected")[0], "MOVEFORWARD");
  press("ShiftLeft", { shift: true });
  assert.equal(lua("return KeyBindingFrame.selected")[0], "MOVEFORWARD", "a bare modifier does not end the capture");
  press("KeyZ", { shift: true });
  assert.deepEqual(bindings.keysOf("moveForward"), ["Shift+KeyZ", "ArrowUp"]);
  assert.equal(text("KeyBindingFrameBinding2Key1Button"), "SHIFT-Z");
  assert.equal(text("KeyBindingFrameOutputText"), lua("return KEY_BOUND")[0]);
  // Cancel takes it back and returns to the game menu, as in the client.
  click("KeyBindingFrameCancelButton");
  assert.equal(shown("KeyBindingFrame"), false);
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", "ArrowUp"]);
  assert.equal(shown("GameMenuFrame"), true);
  lua("HideUIPanel(GameMenuFrame)", 0);
  console.log(`[macro/binding] Blizzard_BindingUI first open ${Math.round(openMs)} ms`);

  // Okay keeps it, in the saved blob the native window reads.
  bindingRoute.openFrameXmlKeyBindings();
  await until(() => shown("KeyBindingFrame"), "reopened");
  click("KeyBindingFrameBinding2Key2Button");
  press("F8");
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", "F8"]);
  click("KeyBindingFrameOkayButton");
  assert.deepEqual(JSON.parse(storage.get("webclient.keybindings.v1")).moveForward, ["KeyW", "F8"]);
  lua("HideUIPanel(GameMenuFrame)", 0);

  // Unbind, then Escape: with a slot selected Escape only deselects; without, it cancels and closes.
  bindingRoute.openFrameXmlKeyBindings();
  await until(() => shown("KeyBindingFrame"), "reopened");
  click("KeyBindingFrameBinding2Key2Button");
  click("KeyBindingFrameUnbindButton");
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", ""]);
  click("KeyBindingFrameBinding2Key1Button");
  press("Escape");
  assert.equal(lua("return KeyBindingFrame.selected")[0], undefined);
  assert.equal(shown("KeyBindingFrame"), true);
  assert.equal(text("KeyBindingFrameOutputText"), "", "a deselect, not a refused ESCAPE binding's wheel error");
  press("Escape");
  assert.equal(shown("KeyBindingFrame"), false);
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", "F8"], "Escape dropped the unsaved unbind");
  assert.equal(shown("GameMenuFrame"), true);
  lua("HideUIPanel(GameMenuFrame)", 0);

  // The host's own close (K again, a reset) cancels without bringing the menu back.
  bindingRoute.openFrameXmlKeyBindings();
  await until(() => shown("KeyBindingFrame"), "reopened");
  click("KeyBindingFrameBinding2Key2Button");
  press("F9");
  assert.equal(bindingRoute.toggleFrameXmlKeyBindings(), true);
  assert.equal(shown("KeyBindingFrame"), false);
  assert.equal(shown("GameMenuFrame"), false);
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", "F8"]);
  // A press is read with its own modifiers even when the page's modifier tracker has not seen it
  // yet (its window listener can run after this one): a Shift from the previous press must not leak.
  bindingRoute.openFrameXmlKeyBindings();
  await until(() => shown("KeyBindingFrame"), "reopened");
  click("KeyBindingFrameBinding2Key2Button");
  press("ShiftLeft", { shift: true });
  press("KeyU", {}, { reversed: true });
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", "KeyU"]);
  click("KeyBindingFrameCancelButton");
  lua("HideUIPanel(GameMenuFrame)", 0);
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", "F8"]);
  // A key the client has no KEY_ name for — the ISO key beside the left Shift — binds and shows.
  bindingRoute.openFrameXmlKeyBindings();
  await until(() => shown("KeyBindingFrame"), "reopened");
  click("KeyBindingFrameBinding2Key2Button");
  press("IntlBackslash", { shift: true });
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", "Shift+IntlBackslash"]);
  assert.equal(text("KeyBindingFrameBinding2Key2Button"), "SHIFT-\\ (ISO)");
  click("KeyBindingFrameCancelButton");
  lua("HideUIPanel(GameMenuFrame)", 0);
  assert.deepEqual(bindings.keysOf("moveForward"), ["KeyW", "F8"]);
  assert.equal(boot.errorCount, errors, boot.vm.errors.slice(errors).join(" | "));
  // A key after the frame closed is the world's again.
  assert.equal(press("KeyW").prevented, false);
});

test("stock entry points reach the owners: ShowMacroFrame, the game menu's two buttons", withClient, async () => {
  await ready();
  // `/macro` and the chat menu's «Макрос» are stock ShowMacroFrame, re-pointed at the host.
  lua("ShowMacroFrame()", 0);
  await until(() => shown("MacroFrame"), "ShowMacroFrame opens the stock window");
  lua("HideUIPanel(MacroFrame)", 0);
  // GameMenuFrame's two buttons keep the menu's host adapters; the mount's actions are the native
  // modules' entry points, which ask the stock routes first — the routes themselves here.
  const { installFrameXmlGameMenuButtons } = await import("../dist/code/browser/framexml/FrameXmlGameMenuOwner.js");
  const opened = [];
  assert.equal(installFrameXmlGameMenuButtons(boot, {
    video() {}, sound() {}, interface() {}, diagnostics() {}, resetLayout() {}, toggle() {},
    keybindings: () => { opened.push("keybindings"); bindingRoute.openFrameXmlKeyBindings(); },
    macros: () => { opened.push("macros"); macroRoute.openFrameXmlMacro(); },
  }), true);
  lua("ShowUIPanel(GameMenuFrame)", 0);
  click("GameMenuButtonMacros");
  assert.equal(shown("MacroFrame"), true);
  assert.equal(shown("GameMenuFrame"), false);
  lua("HideUIPanel(MacroFrame) ShowUIPanel(GameMenuFrame)", 0);
  click("GameMenuButtonKeybindings");
  assert.equal(shown("KeyBindingFrame"), true);
  assert.deepEqual(opened, ["macros", "keybindings"]);
  lua("KeyBindingFrameCancelButton:Click() HideUIPanel(GameMenuFrame)", 0);
  assert.equal(native.macros + native.keyBindings, 0, "no native window opened");
  // What a key change costs the loaded vertical: one UPDATE_BINDINGS repaints every stock hotkey.
  const started = performance.now();
  const handlers = boot.bridge.dispatchEvent("UPDATE_BINDINGS");
  console.log(`[macro/binding] one UPDATE_BINDINGS: ${handlers} handlers, ${(performance.now() - started).toFixed(2)} ms`);
  const tickStarted = performance.now();
  for (let index = 0; index < 1000; index += 1) seam.keyBindings.tick();
  console.log(`[macro/binding] outside-change check: ${((performance.now() - tickStarted) / 1000 * 1000).toFixed(1)} us each`);
});
