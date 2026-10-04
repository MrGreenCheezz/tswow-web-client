import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function fakeNode(tag) {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  const style = {
    display: "",
    setProperty(name, value) {
      const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      style[key] = String(value);
    },
    removeProperty(name) {
      const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      delete style[key];
    },
  };
  const context = {
    setTransform() {},
    clearRect() {},
    save() {},
    beginPath() {},
    arc() {},
    clip() {},
    fillRect() {},
    restore() {},
    translate() {},
    rotate() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    drawImage() {},
    stroke() {},
    fill() {},
  };
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: undefined,
    get parentElement() { return node.parentNode; },
    get nextSibling() {
      if (!node.parentNode) return null;
      const index = node.parentNode.children.indexOf(node);
      return index >= 0 ? node.parentNode.children[index + 1] ?? null : null;
    },
    style,
    clientWidth: 1024,
    clientHeight: 768,
    textContent: "",
    value: "",
    hidden: false,
    width: 0,
    height: 0,
    dataset: {},
    className: "",
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      toggle(name, force) {
        const active = force === undefined ? !classes.has(name) : force;
        if (active) classes.add(name); else classes.delete(name);
        return active;
      },
      contains(name) { return classes.has(name); },
    },
    append(...children) {
      for (const child of children) {
        child.remove?.();
        child.parentNode = node;
        node.children.push(child);
      }
    },
    insertBefore(child, reference) {
      child.remove?.();
      child.parentNode = node;
      const index = reference === undefined ? -1 : node.children.indexOf(reference);
      if (index < 0) node.children.push(child);
      else node.children.splice(index, 0, child);
    },
    replaceChildren(...children) {
      for (const child of children) child.parentNode = node;
      node.children = [...children];
    },
    remove() {
      if (!node.parentNode) return;
      node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      node.parentNode = undefined;
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === "id") node.id = String(value);
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(type, listener) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    focus() {},
    contains(candidate) { return candidate === node || node.children.some((child) => child.contains?.(candidate)); },
    getContext() { return context; },
    querySelector(selector) {
      if (selector.startsWith("canvas[data-portrait-slot=\"")) {
        const slot = selector.slice('canvas[data-portrait-slot="'.length, -2);
        const direct = node.children.find((child) => child.tagName === "CANVAS"
          && child.dataset?.portraitSlot === slot);
        if (direct) return direct;
        for (const child of node.children) {
          const nested = child.querySelector?.(selector);
          if (nested) return nested;
        }
        return undefined;
      }
      return selector === 'button[type="submit"]' ? fakeNode("button") : null;
    },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}

const viewport = fakeNode("div");
const replacedNativeLanes = new Map([
  ["player-hud", [true, "grid"]],
  ["player-cast", [false, "flex"]],
  ["action-bar", [true, "block"]],
  ["action-bar-extras", [false, "inline-flex"]],
  ["action-bar-side", [true, "contents"]],
].map(([id, [hidden, display]]) => {
  const lane = fakeNode("div");
  lane.hidden = hidden;
  lane.style.display = display;
  return [id, lane];
}));
const originalReplacedNativeState = new Map([...replacedNativeLanes].map(([id, lane]) => [id, {
  hidden: lane.hidden,
  display: lane.style.display,
}]));
const untouchedNativeLanes = new Map([
  "target-panel",
  "target-cast",
  "focus-frame",
  "tot-frame",
  "party-frames",
  "player-auras",
  "target-auras",
  "pet-frame",
  "pet-bar",
  "minimap",
  "character-window",
].map((id) => [id, fakeNode("div")]));
const originalUntouchedNativeState = new Map([...untouchedNativeLanes].map(([id, lane]) => [id, {
  hidden: lane.hidden,
  display: lane.style.display,
}]));
const rightRail = fakeNode("div");
const nativeTargetIcon = fakeNode("img");
const nativeTargetPortraitParent = fakeNode("div");
nativeTargetPortraitParent.append(nativeTargetIcon);
const nativeFocusFrame = untouchedNativeLanes.get("focus-frame");
const nativeFocusCanvas = fakeNode("canvas");
nativeFocusCanvas.className = "native-focus-portrait";
nativeFocusCanvas.dataset.portraitSlot = "focus";
nativeFocusCanvas.dataset.portraitReady = "native-state";
nativeFocusCanvas.hidden = true;
nativeFocusFrame.append(nativeFocusCanvas);
const nativeTotFrame = untouchedNativeLanes.get("tot-frame");
const nativeTotCanvas = fakeNode("canvas");
nativeTotCanvas.className = "native-tot-portrait";
nativeTotCanvas.dataset.portraitSlot = "tot";
nativeTotCanvas.dataset.portraitReady = "native-state";
nativeTotCanvas.hidden = true;
nativeTotFrame.append(nativeTotCanvas);
const nativePetFrame = untouchedNativeLanes.get("pet-frame");
const nativePetUnitButton = fakeNode("button");
const nativePetCanvas = fakeNode("canvas");
nativePetCanvas.className = "native-pet-portrait";
nativePetCanvas.dataset.portraitSlot = "pet";
nativePetCanvas.dataset.portraitReady = "native-state";
nativePetCanvas.hidden = true;
nativePetUnitButton.append(nativePetCanvas);
nativePetFrame.append(nativePetUnitButton);
const nativePartyFrame = untouchedNativeLanes.get("party-frames");
const nativePartyRows = [];
for (let index = 1; index <= 4; index += 1) {
  const row = fakeNode("button");
  const canvas = fakeNode("canvas");
  canvas.className = `native-party-${index}-portrait`;
  canvas.dataset.portraitSlot = `party${index}`;
  canvas.dataset.portraitReady = "native-state";
  canvas.hidden = true;
  row.append(canvas);
  nativePartyFrame.append(row);
  nativePartyRows.push({ row, canvas });
}
const nativeElements = new Map([
  ...untouchedNativeLanes,
  ["right-rail", rightRail],
  ["target-icon", nativeTargetIcon],
]);
const renderedTargetFrame = fakeNode("div");
renderedTargetFrame.style.width = "232px";
renderedTargetFrame.style.height = "100px";
renderedTargetFrame.setAttribute("data-framexml-name", "TargetFrame");
renderedTargetFrame.setAttribute("data-framexml-type", "Button");
const renderedTargetPortrait = fakeNode("div");
renderedTargetPortrait.style.width = "64px";
renderedTargetPortrait.style.height = "64px";
renderedTargetPortrait.setAttribute("data-framexml-name", "TargetFramePortrait");
renderedTargetPortrait.setAttribute("data-framexml-type", "Texture");
const renderedTargetSpellBar = fakeNode("div");
renderedTargetSpellBar.setAttribute("data-framexml-name", "TargetFrameSpellBar");
renderedTargetSpellBar.setAttribute("data-framexml-type", "StatusBar");
const renderedTargetBuffs = fakeNode("div");
renderedTargetBuffs.setAttribute("data-framexml-name", "TargetFrameBuffs");
renderedTargetBuffs.setAttribute("data-framexml-type", "Frame");
const renderedTargetDebuffs = fakeNode("div");
renderedTargetDebuffs.setAttribute("data-framexml-name", "TargetFrameDebuffs");
renderedTargetDebuffs.setAttribute("data-framexml-type", "Frame");
renderedTargetFrame.append(
  renderedTargetPortrait,
  renderedTargetSpellBar,
  renderedTargetBuffs,
  renderedTargetDebuffs,
);
const renderedTargetToT = fakeNode("div");
renderedTargetToT.setAttribute("data-framexml-name", "TargetFrameToT");
renderedTargetToT.setAttribute("data-framexml-type", "Button");
const renderedTargetToTPortrait = fakeNode("div");
renderedTargetToTPortrait.style.width = "42px";
renderedTargetToTPortrait.style.height = "42px";
renderedTargetToTPortrait.setAttribute("data-framexml-name", "TargetFrameToTPortrait");
renderedTargetToTPortrait.setAttribute("data-framexml-type", "Texture");
const renderedTargetToTHealthBar = fakeNode("div");
renderedTargetToTHealthBar.setAttribute("data-framexml-name", "TargetFrameToTHealthBar");
renderedTargetToTHealthBar.setAttribute("data-framexml-type", "StatusBar");
const renderedTargetToTManaBar = fakeNode("div");
renderedTargetToTManaBar.setAttribute("data-framexml-name", "TargetFrameToTManaBar");
renderedTargetToTManaBar.setAttribute("data-framexml-type", "StatusBar");
renderedTargetToT.append(renderedTargetToTPortrait, renderedTargetToTHealthBar, renderedTargetToTManaBar);
renderedTargetFrame.append(renderedTargetToT);
const renderedFocusFrame = fakeNode("div");
renderedFocusFrame.setAttribute("data-framexml-name", "FocusFrame");
renderedFocusFrame.setAttribute("data-framexml-type", "Button");
const renderedFocusPortrait = fakeNode("div");
renderedFocusPortrait.style.width = "42px";
renderedFocusPortrait.style.height = "42px";
renderedFocusPortrait.setAttribute("data-framexml-name", "FocusFramePortrait");
renderedFocusPortrait.setAttribute("data-framexml-type", "Texture");
const renderedFocusHealthBar = fakeNode("div");
renderedFocusHealthBar.setAttribute("data-framexml-name", "FocusFrameHealthBar");
renderedFocusHealthBar.setAttribute("data-framexml-type", "StatusBar");
const renderedFocusManaBar = fakeNode("div");
renderedFocusManaBar.setAttribute("data-framexml-name", "FocusFrameManaBar");
renderedFocusManaBar.setAttribute("data-framexml-type", "StatusBar");
renderedFocusFrame.append(renderedFocusPortrait, renderedFocusHealthBar, renderedFocusManaBar);
const renderedPetFrame = fakeNode("div");
renderedPetFrame.setAttribute("data-framexml-name", "PetFrame");
renderedPetFrame.setAttribute("data-framexml-type", "Button");
const renderedPetPortrait = fakeNode("div");
renderedPetPortrait.style.width = "64px";
renderedPetPortrait.style.height = "64px";
renderedPetPortrait.setAttribute("data-framexml-name", "PetPortrait");
renderedPetPortrait.setAttribute("data-framexml-type", "Texture");
const renderedPetHealthBar = fakeNode("div");
renderedPetHealthBar.setAttribute("data-framexml-name", "PetFrameHealthBar");
renderedPetHealthBar.setAttribute("data-framexml-type", "StatusBar");
const renderedPetManaBar = fakeNode("div");
renderedPetManaBar.setAttribute("data-framexml-name", "PetFrameManaBar");
renderedPetManaBar.setAttribute("data-framexml-type", "StatusBar");
const renderedPetDebuffs = [];
for (let index = 1; index <= 4; index += 1) {
  const debuff = fakeNode("div");
  debuff.setAttribute("data-framexml-name", `PetFrameDebuff${index}`);
  debuff.setAttribute("data-framexml-type", "Button");
  const icon = fakeNode("div");
  icon.setAttribute("data-framexml-name", `PetFrameDebuff${index}Icon`);
  icon.setAttribute("data-framexml-type", "Texture");
  const border = fakeNode("div");
  border.setAttribute("data-framexml-name", `PetFrameDebuff${index}Border`);
  border.setAttribute("data-framexml-type", "Texture");
  debuff.append(icon, border);
  renderedPetDebuffs.push({ debuff, icon, border });
}
renderedPetFrame.append(
  renderedPetPortrait,
  renderedPetHealthBar,
  renderedPetManaBar,
  ...renderedPetDebuffs.map(({ debuff }) => debuff),
);
const renderedPartyFrames = [];
for (let index = 1; index <= 4; index += 1) {
  const frame = fakeNode("div");
  frame.setAttribute("data-framexml-name", `PartyMemberFrame${index}`);
  frame.setAttribute("data-framexml-type", "Button");
  const container = fakeNode("div");
  const portrait = fakeNode("div");
  portrait.style.width = "37px";
  portrait.style.height = "37px";
  portrait.setAttribute("data-framexml-name", `PartyMemberFrame${index}Portrait`);
  portrait.setAttribute("data-framexml-type", "Texture");
  const name = fakeNode("div");
  name.setAttribute("data-framexml-name", `PartyMemberFrame${index}Name`);
  name.setAttribute("data-framexml-type", "FontString");
  const health = fakeNode("div");
  health.setAttribute("data-framexml-name", `PartyMemberFrame${index}HealthBar`);
  health.setAttribute("data-framexml-type", "StatusBar");
  const mana = fakeNode("div");
  mana.setAttribute("data-framexml-name", `PartyMemberFrame${index}ManaBar`);
  mana.setAttribute("data-framexml-type", "StatusBar");
  const debuffs = [];
  for (let debuffIndex = 1; debuffIndex <= 4; debuffIndex += 1) {
    const debuff = fakeNode("div");
    debuff.setAttribute("data-framexml-name", `PartyMemberFrame${index}Debuff${debuffIndex}`);
    debuff.setAttribute("data-framexml-type", "Button");
    const icon = fakeNode("div");
    icon.setAttribute("data-framexml-name", `PartyMemberFrame${index}Debuff${debuffIndex}Icon`);
    icon.setAttribute("data-framexml-type", "Texture");
    const border = fakeNode("div");
    border.setAttribute("data-framexml-name", `PartyMemberFrame${index}Debuff${debuffIndex}Border`);
    border.setAttribute("data-framexml-type", "Texture");
    debuff.append(icon, border);
    container.append(debuff);
    debuffs.push({ debuff, icon, border });
  }
  container.append(portrait, name, health, mana);
  frame.append(container);
  renderedPartyFrames.push({ frame, container, portrait, name, health, mana, debuffs });
}
const renderedMinimapCluster = fakeNode("div");
renderedMinimapCluster.style.width = "192px";
renderedMinimapCluster.style.height = "192px";
const renderedMinimap = fakeNode("div");
renderedMinimap.style.width = "140px";
renderedMinimap.style.height = "140px";
renderedMinimapCluster.append(renderedMinimap);
const renderedBuffFrame = fakeNode("div");
renderedBuffFrame.style.width = "50px";
renderedBuffFrame.style.height = "50px";
const body = fakeNode("body");
globalThis.document = {
  head: fakeNode("head"),
  body,
  createElement: fakeNode,
  getElementById(id) {
    return replacedNativeLanes.get(id) ?? nativeElements.get(id) ?? fakeNode("div");
  },
  querySelectorAll() { return []; },
};

const raf = { next: 1, scheduled: new Set(), cancelled: new Set() };
const resizeListeners = new Set();
const resizeOperations = [];
let rafFailure;
globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 2,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener(type, listener) {
    if (type === "resize") {
      resizeOperations.push(["add", listener]);
      resizeListeners.add(listener);
    }
  },
  removeEventListener(type, listener) {
    if (type === "resize") {
      resizeOperations.push(["remove", listener]);
      resizeListeners.delete(listener);
    }
  },
  requestAnimationFrame(callback) {
    if (rafFailure) throw new Error(rafFailure);
    const id = raf.next++;
    raf.scheduled.add({ id, callback });
    return id;
  },
  cancelAnimationFrame(id) {
    raf.cancelled.add(id);
  },
};
globalThis.location = globalThis.window.location;

const {
  FrameXmlBoot,
  installFrameXmlMicroButtonExerciseCompat,
} = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { clearWorldContext } = await import("../dist/code/browser/game/Context.js");
const {
  frameXmlWorldVisibleRootAllowed,
  frameXmlFlagEnabled,
  FRAMEXML_MICROBUTTON_NAMES,
  frameXmlMicroButtonOwnerGate,
  installFrameXmlMicroButtonAdapters,
  mountFrameXmlVertical,
  selectFrameXmlWorldRoots,
  unmountFrameXmlVertical,
} = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const {
  frameXmlBagsOpen,
  toggleFrameXmlBackpack,
} = await import("../dist/code/browser/framexml/FrameXmlBagController.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { updateMinimap } = await import("../dist/code/browser/ui/Minimap.js");
const { inventoryWindow } = await import("../dist/code/browser/ui/Dom.js");

test("FrameXML flag defaults off and accepts only the explicit diagnostic opt-in", () => {
  assert.equal(frameXmlFlagEnabled("?framexml=1"), true);
  assert.equal(frameXmlFlagEnabled("?framexml=true"), false);
  assert.equal(frameXmlFlagEnabled("?framexml="), false);
  assert.equal(frameXmlFlagEnabled(""), false);
  assert.equal(frameXmlFlagEnabled("?framexml=0"), false);
});

test("EnterWorld watches the saved UI preference and scopes runtime switching to its session", async () => {
  const source = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(source, /uiMode\.select\(frameXmlFlagEnabled\(window\.location\.search, settingOn\("originalFrameXml"\)\)\)/);
  assert.match(source, /installNativeWowUiSkin\(game\.gatewayOrigin\);\s*mountNativeCharacterPortrait/,
    "both modes retain a complete custom fallback");
  assert.match(source, /const tswowAddonsEnabled = settingOn\("tswowAddons"\);/,
    "both loaders use the preference captured for this world entry");
  assert.match(source, /if \(tswowAddonsEnabled\) \{\s*const modules = createModuleLoader/,
    "disabled modules cannot start their requests and reload polling");
  assert.match(source, /new FrameXmlModeController\(tswowAddonsEnabled, async \(\) => \{\s*const module = await import/);
  assert.match(source, /entryLifecycle\.track\(\(\) => uiMode\.dispose\(\)\)/);
  assert.match(source, /entryLifecycle\.track\(watchSettingsApplied\(syncUiMode\)\)/);
  assert.match(source, /mountFrameXmlVertical\(\{\s*addonsOnly: !frameXmlEnabled\s*[,}]/,
    "the same policy selects an addon overlay for ordinary entry and the full HUD only for diagnostics");
  assert.match(source, /includeActiveTsAddons: tswowAddonsEnabled/,
    "opting into stock FrameXML does not implicitly opt back into TSWoW addons");
  assert.doesNotMatch(source, /new URLSearchParams\(window\.location\.search\)\.get\("framexml"\) === "1"/,
    "the old query opt-in must not remain on the ordinary route");
});

test("EnterWorld holds module messages from login until the JSON windows and the Lua are subscribed (9.03)", async () => {
  const source = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  const begin = source.search(/if \(tswowAddonsEnabled\) world\.customPackets\.beginBacklog\(\{ expect: \["modules", "lua"\] \}\);/);
  const login = source.indexOf("await world.loginCharacter(");
  assert.ok(begin > 0 && begin < login, "the backlog starts before the login packets can arrive");
  assert.match(source, /void modules\.load\(\)\.finally\(\(\) => world\.customPackets\.consumerReady\("modules"\)\);/,
    "the windows report ready whether or not their load succeeded");
  assert.match(source, /finally \{ finishModuleCommandLoad\(\); world\.customPackets\.consumerReady\("lua"\); \}/,
    "the Lua reports ready in the mount's finally, after the TOC's subscriptions");
});

test("EnterWorld keys saved variables by realm name, migrates the address key and reports problems (9.06)", async () => {
  const source = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  const scope = source.slice(source.indexOf("const savedVariablesScope = "), source.indexOf("} : undefined;", source.indexOf("const savedVariablesScope = ")));
  assert.match(scope, /\brealm: world\.realmName,/, "no gateway address in the realm part");
  assert.match(scope, /legacyRealm: JSON\.stringify\(\[new URL\(gatewayInput\.value\.replace\(\/\^ws\/, "http"\)\)\.origin, world\.realmName\]\)/);
  assert.match(source, /onSavedVariableProblem: \(problem\) => \{/);
  const mount = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  assert.match(mount, /removeItem: \(key: string\) => window\.localStorage\.removeItem\(key\)/);
  assert.match(mount, /onProblem: options\.onSavedVariableProblem/);
});

test("the world mount tells the module loader which opcodes the TSWoW Lua holds (9.08)", async () => {
  const mount = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  assert.match(mount, /clientNetworkChanged: \(opcodes\) => game\.modules\?\.noteLuaOpcodes\(opcodes\),/);
});

test("chat explains pending addon commands and retires only the matching world load", async () => {
  const chat = await import("../dist/code/browser/ui/Chat.js");
  const previousWorld = game.world;
  const messages = [];
  const sent = [];
  const world = {
    emotes: { emotes: [] },
    pushLocalMessage: (message) => messages.push(message.text),
    sendChat: (...args) => sent.push(args),
  };
  const finishers = [];
  let opened = 0;
  try {
    game.world = world;
    const first = chat.beginModuleCommandLoad?.(world);
    if (first) finishers.push(first);
    chat.submitChat("/loadingfixture");
    assert.match(messages.at(-1), /Аддоны ещё загружаются/);
    chat.submitChat("/say Привет");
    assert.equal(sent.at(-1)[1], "Привет", "normal chat remains available during addon startup");
    assert.equal(chat.addModuleCommand({ module: "loading-fixture", name: "loadingfixture",
      help: "fixture", run: () => opened++ }), undefined);
    chat.submitChat("/loadingfixture");
    assert.equal(opened, 1, "already registered commands are usable while other modules load");
    const second = chat.beginModuleCommandLoad(world);
    finishers.push(second);
    first();
    chat.submitChat("/stillloading");
    assert.match(messages.at(-1), /Аддоны ещё загружаются/, "stale completion cannot retire the new load");
    game.world = { ...world };
    chat.submitChat("/differentworld");
    assert.match(messages.at(-1), /Неизвестная команда/, "pending state belongs to its world");
    game.world = world;
    second();
    chat.submitChat("/stillloading");
    assert.match(messages.at(-1), /Неизвестная команда/, "finished loads restore the normal unknown-command reply");
  } finally {
    for (const finish of finishers) finish();
    chat.removeModuleCommands("loading-fixture");
    game.world = previousWorld;
  }
});

test("world root selection rejects visible orphan helpers while retaining hidden lifecycle roots", () => {
  const root = (name, visible) => ({ name, visible });
  const generalDock = root("GeneralDockManager", true);
  const dockedTab = root("ChatFrame1Tab", true);
  dockedTab.parent = generalDock;
  const nestedDockChild = root("ChatFrame1EditBox", true);
  nestedDockChild.parent = dockedTab;
  const rejectedOwner = root("ChatChannelDropDown", true);
  const rejectedOwnerChild = root("ChatFrame2Tab", true);
  rejectedOwnerChild.parent = rejectedOwner;
  const roots = [
    root("UIParent", true),
    root("ChatFrame1", true),
    generalDock,
    root("FloatingChatFrameManager", true),
    dockedTab,
    nestedDockChild,
    rejectedOwner,
    rejectedOwnerChild,
    root("MirrorTimer1", true),
    root("TimerTracker", true),
    root("QuestInfoRequiredMoneyFrame", true),
    root("ChatChannelDropDown", true),
    root("ChatBNPlayerDropDown", true),
    root("UnknownVisibleHelper", true),
    // Hidden roots are kept so the stock event/lifecycle can show them later.
    root("TargetFrame", false),
    root("FocusFrame", false),
    root("Boss1TargetFrame", false),
    root("ChatChannelDropDown", false),
    root("QuestInfoRequiredMoneyFrame", false),
    root("QuestLogFrame", false),
  ];

  assert.deepEqual(
    selectFrameXmlWorldRoots(roots).map((frame) => frame.name),
    [
      "UIParent",
      "ChatFrame1",
      "GeneralDockManager",
      "FloatingChatFrameManager",
      "MirrorTimer1",
      // L14 (04.10): TimerTracker is no 3.3.5a frame (no FrameXML file declares it), so it is no owner.
      "TargetFrame",
      "FocusFrame",
      "Boss1TargetFrame",
      "ChatChannelDropDown",
      "QuestInfoRequiredMoneyFrame",
      "QuestLogFrame",
    ],
  );
  for (const name of [
    "UIParent", "ChatFrame1", "ChatFrame1EditBox", "GeneralDockManager", "FloatingChatFrameManager",
    "MirrorTimer1", "MirrorTimerFrame",
    "PlayerFrame", "TargetFrame", "Boss1TargetFrame",
  ]) assert.equal(frameXmlWorldVisibleRootAllowed(name), true, `${name} should be an owner`);
  for (const name of [
    "QuestInfoRequiredMoneyFrame", "ChatChannelDropDown", "ChatBNPlayerDropDown", "UnknownVisibleHelper",
    "TimerTracker", // L14 (04.10): the dead entry is gone
  ]) assert.equal(frameXmlWorldVisibleRootAllowed(name), false, `${name} must stay lifecycle-owned`);
});

test("microbutton owner gate is all-or-nothing and never admits a partial native replacement", () => {
  const parent = { name: "MainMenuBarArtFrame" };
  const scriptNames = new Map([
    ["CharacterMicroButton", ["OnLoad", "OnEvent", "OnMouseDown", "OnMouseUp"]],
    ["SpellbookMicroButton", ["OnLoad", "OnClick"]],
    ["TalentMicroButton", ["OnLoad", "OnClick", "OnEvent"]],
    ["AchievementMicroButton", ["OnLoad", "OnClick", "OnEvent", "OnEnter", "OnLeave"]],
    ["QuestLogMicroButton", ["OnLoad", "OnClick"]],
    ["SocialsMicroButton", ["OnLoad", "OnClick"]],
    ["PVPMicroButton", ["OnLoad", "OnMouseDown", "OnMouseUp"]],
    ["LFDMicroButton", ["OnLoad", "OnClick"]],
    ["MainMenuMicroButton", ["OnLoad", "OnMouseDown", "OnMouseUp"]],
    ["HelpMicroButton", ["OnLoad", "OnClick"]],
  ]);
  const frames = new Map(FRAMEXML_MICROBUTTON_NAMES.map((name) => {
    const frame = {
      name,
      type: "Button",
      named: true,
      loaded: true,
      enabled: name !== "AchievementMicroButton",
      parent,
      scripts: new Map(scriptNames.get(name).map((script) => [script, () => {}])),
    };
    return [name, frame];
  }));
  const boot = {
    bridge: {
      getFrame(name) { return frames.get(name); },
      hasScript(frame, script) { return frame.scripts.has(script); },
    },
  };
  const renderer = {
    elementFor(frame) {
      return {
        getAttribute(name) {
          if (name === "data-framexml-name") return frame.name;
          if (name === "data-framexml-type") return frame.type;
          return null;
        },
      };
    },
  };
  const proof = {
    owners: {
      character: true, spellbook: true, talent: true, achievement: "disabled", quest: true,
      socials: true, pvp: true, lfd: true, gameMenu: true, help: true,
    },
    nativeReplacement: {
      character: true, bags: true, spellbook: true, talents: true,
      professions: true, diagnostics: true,
    },
    adaptersInstalled: true,
  };
  assert.equal(frameXmlMicroButtonOwnerGate(boot, renderer, proof)?.length,
    FRAMEXML_MICROBUTTON_NAMES.length,
    "only a complete ten-button structural and owner proof can pass");
  proof.owners.help = false;
  assert.equal(frameXmlMicroButtonOwnerGate(boot, renderer, proof), undefined,
    "one missing LoD owner fails closed");
  proof.owners.help = true;
  proof.nativeReplacement.professions = false;
  assert.equal(frameXmlMicroButtonOwnerGate(boot, renderer, proof), undefined,
    "one missing native replacement surface fails closed");
});

test("microbutton exercise compat suppresses optional-panel updates when InterfaceOptionsFrame is absent", () => {
  const rowNames = [
    "CharacterMicroButton", "SpellbookMicroButton", "TalentMicroButton", "AchievementMicroButton",
    "QuestLogMicroButton", "SocialsMicroButton", "PVPMicroButton", "LFDMicroButton",
    "MainMenuMicroButton", "HelpMicroButton",
  ];
  const coreNames = [
    "UIParent", "MainMenuBarArtFrame", "CharacterFrame", "SpellBookFrame", "QuestLogFrame",
    "GameMenuFrame", "PVPParentFrame",
  ];
  const frames = new Map([...rowNames, ...coreNames].map((name) => [name, {
    name,
    scripts: new Map(),
    enabled: true,
  }]));
  const calls = [];
  const bridge = {
    getFrame(name) { return frames.get(name); },
    SetScript(frame, script, handler) {
      calls.push([frame.name, script]);
      frame.scripts.set(script, handler);
      return true;
    },
    update(frame, mutate) { mutate(frame); return true; },
  };

  // The production vertical omits InterfaceOptionsFrame. Its absence must not leave stock
  // UpdateMicroButtons() active on a lifecycle event: it would dereference the missing global.
  installFrameXmlMicroButtonExerciseCompat(bridge);
  assert.deepEqual(calls.map(([name, script]) => [name, script]), [
    ["TalentMicroButton", "OnEvent"],
    ["AchievementMicroButton", "OnEvent"],
    ["AchievementMicroButton", "OnEnter"],
    ["AchievementMicroButton", "OnLeave"],
  ], "missing InterfaceOptionsFrame selects the safe suppression path");

  frames.set("InterfaceOptionsFrame", { name: "InterfaceOptionsFrame", scripts: new Map(), enabled: true });
  for (const name of ["FriendsFrame", "LFDParentFrame", "HelpFrame", "AchievementFrame"])
    frames.set(name, { name, scripts: new Map(), enabled: true });
  calls.length = 0;
  installFrameXmlMicroButtonExerciseCompat(bridge);
  assert.deepEqual(calls, [], "complete stock update owners leave handlers untouched");
  assert.equal(calls.some(([name]) => name === "CharacterMicroButton"), false,
    "CharacterMicroButton keeps its stock portrait event");
  assert.equal(frames.get("AchievementMicroButton").enabled, false,
    "unsupported Achievement remains explicitly disabled");
});

test("microbutton adapters own real clicks and keep Achievement explicitly disabled", () => {
  const parent = { name: "MainMenuBarArtFrame" };
  const frames = new Map(FRAMEXML_MICROBUTTON_NAMES.map((name) => [name, {
    name,
    type: "Button",
    named: true,
    loaded: true,
    enabled: true,
    parent,
    scripts: new Map(),
  }]));
  const handlers = new Map();
  const bridge = {
    getFrame(name) { return frames.get(name); },
    SetScript(frame, script, handler) {
      handlers.set(`${frame.name}:${script}`, handler);
      if (handler) frame.scripts.set(script, handler);
      else frame.scripts.delete(script);
      return true;
    },
    update(frame, mutate) { mutate(frame); return true; },
    Hide(frame) { frame.visible = false; return true; },
  };
  const boot = { bridge };
  const calls = new Map();
  const action = (name) => () => calls.set(name, (calls.get(name) ?? 0) + 1);
  const buttons = installFrameXmlMicroButtonAdapters(boot, {
    character: action("character"),
    spellbook: action("spellbook"),
    talent: action("talent"),
    quest: action("quest"),
    socials: action("socials"),
    pvp: action("pvp"),
    lfd: action("lfd"),
    gameMenu: action("gameMenu"),
    help: action("help"),
  });
  assert.equal(buttons?.length, FRAMEXML_MICROBUTTON_NAMES.length);
  assert.equal(frames.get("AchievementMicroButton").enabled, false,
    "Achievement has a visible disabled contract instead of a fake destination");

  const fire = (name, script) => handlers.get(`${name}:${script}`)(frames.get(name));
  fire("SpellbookMicroButton", "OnClick");
  fire("TalentMicroButton", "OnClick");
  fire("QuestLogMicroButton", "OnClick");
  fire("SocialsMicroButton", "OnClick");
  fire("LFDMicroButton", "OnClick");
  fire("HelpMicroButton", "OnClick");
  fire("AchievementMicroButton", "OnClick");
  fire("CharacterMicroButton", "OnMouseDown");
  fire("CharacterMicroButton", "OnMouseUp");
  fire("CharacterMicroButton", "OnMouseUp");
  fire("PVPMicroButton", "OnMouseDown");
  fire("PVPMicroButton", "OnMouseUp");
  fire("MainMenuMicroButton", "OnMouseDown");
  fire("MainMenuMicroButton", "OnMouseUp");

  for (const name of ["spellbook", "talent", "quest", "socials", "lfd", "help", "character", "pvp", "gameMenu"])
    assert.equal(calls.get(name), 1, `${name} callback should run exactly once`);
  assert.equal(calls.get("achievement") ?? 0, 0, "disabled Achievement must never call a destination");
});

game.world = {
  mapId: 0,
  state: {
    selfGuid: 1n,
    objects: new Map([[1n, {
      position: { x: 0, y: 0, orientation: 0 },
      fields: new Map(),
      typeId: 4,
    }]]),
  },
  targetGuid: undefined,
  group: { members: [] },
  knownSpells: [],
  questPoi: new Map(),
  currentGameTime() { return undefined; },
};
updateMinimap(1000);
const nativeMinimap = rightRail.children.find((child) => child.id === "minimap");
assert.ok(nativeMinimap, "native minimap must exist before the FrameXML mount");
const baselineResizeListenerCount = resizeListeners.size;
const targetCanvas = nativeTargetPortraitParent.children.find((child) => child.tagName === "CANVAS");
assert.ok(targetCanvas, "Portraits must create the native target canvas before mount");
const petCanvas = nativePetFrame.children[0]?.children.find((child) => child.tagName === "CANVAS");
assert.ok(petCanvas, "the existing UnitFrame pet canvas must exist before mount");
const minimapCanvas = nativeMinimap.children.find((child) => child.tagName === "CANVAS");
assert.ok(minimapCanvas, "Minimap must create its native canvas before mount");
const targetCanvasStyleKeys = [
  "display", "position", "left", "right", "top", "bottom", "width", "height", "transform",
  "transformOrigin", "zIndex", "opacity", "visibility", "pointerEvents",
];
const originalTargetCanvas = {
  parent: targetCanvas.parentNode,
  order: [...nativeTargetPortraitParent.children],
  className: targetCanvas.className,
  hidden: targetCanvas.hidden,
  dataset: { ...targetCanvas.dataset },
  styles: Object.fromEntries(targetCanvasStyleKeys.map((key) => [key, targetCanvas.style[key] ?? ""])),
  width: targetCanvas.width,
  height: targetCanvas.height,
};

function assertTargetCanvasRestored(label) {
  assert.equal(targetCanvas.parentNode, originalTargetCanvas.parent, `${label}: target canvas parent`);
  assert.deepEqual(nativeTargetPortraitParent.children, originalTargetCanvas.order,
    `${label}: target canvas sibling order`);
  assert.equal(targetCanvas.className, originalTargetCanvas.className, `${label}: target canvas class`);
  assert.equal(targetCanvas.hidden, originalTargetCanvas.hidden, `${label}: target canvas hidden`);
  assert.deepEqual(targetCanvas.dataset, originalTargetCanvas.dataset, `${label}: target canvas dataset`);
  assert.deepEqual(Object.fromEntries(targetCanvasStyleKeys.map((key) => [key, targetCanvas.style[key] ?? ""])),
    originalTargetCanvas.styles, `${label}: target canvas inline styles`);
  assert.equal(targetCanvas.width, originalTargetCanvas.width, `${label}: target canvas width`);
  assert.equal(targetCanvas.height, originalTargetCanvas.height, `${label}: target canvas height`);
}

const originalFocusCanvas = { parent: nativeFocusCanvas.parentNode, order: [...nativeFocusFrame.children] };
const originalTotCanvas = { parent: nativeTotCanvas.parentNode, order: [...nativeTotFrame.children] };
function assertSecondaryPortraitsRestored(label) {
  assert.equal(nativeFocusCanvas.parentNode, originalFocusCanvas.parent,
    `${label}: focus canvas parent`);
  assert.deepEqual(nativeFocusFrame.children, originalFocusCanvas.order,
    `${label}: focus canvas sibling order`);
  assert.equal(nativeTotCanvas.parentNode, originalTotCanvas.parent,
    `${label}: target-of-target canvas parent`);
  assert.deepEqual(nativeTotFrame.children, originalTotCanvas.order,
    `${label}: target-of-target canvas sibling order`);
}

const originalPetCanvas = {
  parent: petCanvas.parentNode,
  order: [...nativePetUnitButton.children],
  className: petCanvas.className,
  hidden: petCanvas.hidden,
  dataset: { ...petCanvas.dataset },
  styles: Object.fromEntries(targetCanvasStyleKeys.map((key) => [key, petCanvas.style[key] ?? ""])),
  width: petCanvas.width,
  height: petCanvas.height,
};

function assertPetCanvasRestored(label) {
  assert.equal(petCanvas.parentNode, originalPetCanvas.parent, `${label}: pet canvas parent`);
  assert.deepEqual(nativePetUnitButton.children, originalPetCanvas.order,
    `${label}: pet canvas sibling order`);
  assert.equal(petCanvas.className, originalPetCanvas.className, `${label}: pet canvas class`);
  assert.equal(petCanvas.hidden, originalPetCanvas.hidden, `${label}: pet canvas hidden`);
  assert.deepEqual(petCanvas.dataset, originalPetCanvas.dataset, `${label}: pet canvas dataset`);
  assert.deepEqual(Object.fromEntries(targetCanvasStyleKeys.map((key) => [key, petCanvas.style[key] ?? ""])),
    originalPetCanvas.styles, `${label}: pet canvas inline styles`);
  assert.equal(petCanvas.width, originalPetCanvas.width, `${label}: pet canvas width`);
  assert.equal(petCanvas.height, originalPetCanvas.height, `${label}: pet canvas height`);
}

const originalPartyCanvases = nativePartyRows.map(({ row, canvas }) => ({
  row,
  canvas,
  parent: canvas.parentNode,
  order: [...row.children],
  className: canvas.className,
  hidden: canvas.hidden,
  dataset: { ...canvas.dataset },
  styles: Object.fromEntries(targetCanvasStyleKeys.map((key) => [key, canvas.style[key] ?? ""])),
  width: canvas.width,
  height: canvas.height,
}));

function assertPartyCanvasesRestored(label) {
  for (const entry of originalPartyCanvases) {
    assert.equal(entry.canvas.parentNode, entry.parent, `${label}: ${entry.canvas.className} parent`);
    assert.deepEqual(entry.row.children, entry.order, `${label}: ${entry.canvas.className} order`);
    assert.equal(entry.canvas.className, entry.className, `${label}: ${entry.canvas.className} class`);
    assert.equal(entry.canvas.hidden, entry.hidden, `${label}: ${entry.canvas.className} hidden`);
    assert.deepEqual(entry.canvas.dataset, entry.dataset,
      `${label}: ${entry.canvas.className} dataset`);
    assert.deepEqual(
      Object.fromEntries(targetCanvasStyleKeys.map((key) => [key, entry.canvas.style[key] ?? ""])),
      entry.styles, `${label}: ${entry.canvas.className} inline styles`,
    );
    assert.equal(entry.canvas.width, entry.width, `${label}: ${entry.canvas.className} width`);
    assert.equal(entry.canvas.height, entry.height, `${label}: ${entry.canvas.className} height`);
  }
}

const originalMinimapCanvas = {
  parent: minimapCanvas.parentNode,
  order: [...nativeMinimap.children],
  className: minimapCanvas.className,
  hidden: minimapCanvas.hidden,
  dataset: { ...minimapCanvas.dataset },
  styles: Object.fromEntries(targetCanvasStyleKeys.map((key) => [key, minimapCanvas.style[key] ?? ""])),
  width: minimapCanvas.width,
  height: minimapCanvas.height,
};

function assertMinimapCanvasRestored(label) {
  assert.equal(minimapCanvas.parentNode, originalMinimapCanvas.parent, `${label}: minimap canvas parent`);
  assert.deepEqual(nativeMinimap.children, originalMinimapCanvas.order,
    `${label}: minimap canvas sibling order`);
  assert.equal(minimapCanvas.className, originalMinimapCanvas.className, `${label}: minimap canvas class`);
  assert.equal(minimapCanvas.hidden, originalMinimapCanvas.hidden, `${label}: minimap canvas hidden`);
  assert.deepEqual(minimapCanvas.dataset, originalMinimapCanvas.dataset, `${label}: minimap canvas dataset`);
  assert.deepEqual(Object.fromEntries(targetCanvasStyleKeys.map((key) => [key, minimapCanvas.style[key] ?? ""])),
    originalMinimapCanvas.styles, `${label}: minimap canvas inline styles`);
  assert.equal(minimapCanvas.width, originalMinimapCanvas.width, `${label}: minimap canvas width`);
  assert.equal(minimapCanvas.height, originalMinimapCanvas.height, `${label}: minimap canvas height`);
}

const inventory = {
  files: { total: 0, bytes: 0 },
  widgets: { total: 0 },
  lua: { errorsRaised: 0 },
  errors: [],
  timings: { scanMs: 0, planMs: 0, loadMs: 0, totalMs: 0 },
};
const seamEvents = [];
const seams = [];
let pendingLoad;
let mountFailure;
let targetGateFailure;
let targetContextGateFailure;
let minimapGateFailure;
let petGateFailure;
let lastPetFrame;
let partyGateFailure;
let lastPartyFrames = [];
let bagGateEnabled = false;
let bagClickFailure = false;
const publicationSnapshots = [];

FrameXmlBoot.prototype.load = async function loadStub() {
  const seam = this.seam;
  const record = {
    seam,
    closed: false,
  };
  seams.push(record);
  this.bridge.CreateFrame("Frame", "BuffFrame");
  if (bagGateEnabled) {
    const gameMenu = this.bridge.CreateFrame("Frame", "GameMenuFrame");
    const backpack = this.bridge.CreateFrame("CheckButton", "MainMenuBarBackpackButton");
    const bagButtons = [];
    for (let index = 0; index < 4; index += 1) {
      const button = this.bridge.CreateFrame("CheckButton", `CharacterBag${index}Slot`);
      // MainMenuBarBagButtons.lua fills these PaperDoll slot IDs during OnLoad.  The lifecycle
      // fixture has no PaperDoll vertical, so provide that exact structural fact explicitly.
      if (button) button.id = 20 + index;
      bagButtons.push(button);
    }
    const keyring = this.bridge.CreateFrame("CheckButton", "KeyRingButton");
    const containers = [];
    for (let index = 1; index <= 13; index += 1) {
      containers.push(this.bridge.CreateFrame("Frame", `ContainerFrame${index}`));
    }
    const noop = () => {};
    for (const frame of [gameMenu]) {
      this.bridge.SetScript(frame, "OnShow", noop);
      this.bridge.SetScript(frame, "OnHide", noop);
    }
    for (const frame of [backpack, ...bagButtons, keyring]) {
      this.bridge.SetScript(frame, "OnClick", () => {});
    }
    for (const frame of containers) {
      this.bridge.SetScript(frame, "OnLoad", noop);
      this.bridge.SetScript(frame, "OnShow", noop);
      this.bridge.SetScript(frame, "OnHide", noop);
      this.bridge.SetScript(frame, "OnEvent", noop);
    }
    // CreateFrame defaults to shown in the bridge; stock GameMenuFrame and ContainerFrame roots
    // are hidden until their click path opens them.
    this.bridge.Hide(gameMenu);
    for (const frame of containers) this.bridge.Hide(frame);
    this.bridge.SetScript(backpack, "OnClick", () => {
      if (bagClickFailure) this.vm.errors.push("stock bag click failed");
      this.bridge.Show(containers[0]);
    });
  }
  if (targetGateFailure !== "frame") {
    const targetFrame = this.bridge.CreateFrame("Button", "TargetFrame");
    if (targetGateFailure !== "tot") {
      const targetOfTarget = this.bridge.createChild(targetFrame, "Button", "TargetFrameToT");
      targetOfTarget.secureAttributes.set("unit", "targettarget");
      targetOfTarget.secureAttributes.set("*type1", "target");
      this.bridge.createChild(targetOfTarget, "Texture", "TargetFrameToTPortrait");
      this.bridge.createChild(targetOfTarget, "StatusBar", "TargetFrameToTHealthBar");
      this.bridge.createChild(targetOfTarget, "StatusBar", "TargetFrameToTManaBar");
    }
    if (targetGateFailure !== "portrait") {
      this.bridge.createChild(targetFrame, "Texture", "TargetFramePortrait");
      if (targetContextGateFailure !== "spellbar") {
        this.bridge.createChild(targetFrame, "StatusBar", "TargetFrameSpellBar");
      }
      if (targetContextGateFailure !== "auras") {
        this.bridge.createChild(targetFrame, "Frame", "TargetFrameBuffs");
        this.bridge.createChild(targetFrame, "Frame", "TargetFrameDebuffs");
      }
    }
    if (minimapGateFailure !== "cluster") {
      const minimapCluster = this.bridge.CreateFrame("Frame", "MinimapCluster");
      if (minimapGateFailure !== "minimap") {
        this.bridge.CreateFrame("Minimap", "Minimap", minimapCluster);
      }
    }
  }
  if (targetGateFailure !== "frame" && targetGateFailure !== "focus") {
    const focusFrame = this.bridge.CreateFrame("Button", "FocusFrame");
    focusFrame.secureAttributes.set("unit", "focus");
    focusFrame.secureAttributes.set("*type1", "target");
    this.bridge.createChild(focusFrame, "Texture", "FocusFramePortrait");
    this.bridge.createChild(focusFrame, "StatusBar", "FocusFrameHealthBar");
    this.bridge.createChild(focusFrame, "StatusBar", "FocusFrameManaBar");
  }
  if (petGateFailure !== "frame") {
    const petFrame = this.bridge.CreateFrame("Button", "PetFrame");
    lastPetFrame = petFrame;
    if (petGateFailure !== "click") {
      petFrame.secureAttributes.set("unit", "pet");
      petFrame.secureAttributes.set("*type1", "target");
    }
    if (petGateFailure !== "portrait") {
      this.bridge.createChild(petFrame, "Texture", "PetPortrait");
      this.bridge.createChild(petFrame, "StatusBar", "PetFrameHealthBar");
      this.bridge.createChild(petFrame, "StatusBar", "PetFrameManaBar");
      if (petGateFailure !== "debuffs") {
        for (let index = 1; index <= 4; index += 1) {
          const debuff = this.bridge.createChild(petFrame, "Button", `PetFrameDebuff${index}`);
          this.bridge.createChild(debuff, "Texture", `PetFrameDebuff${index}Icon`);
          this.bridge.createChild(debuff, "Texture", `PetFrameDebuff${index}Border`);
        }
      }
    }
  }
  lastPartyFrames = [];
  if (partyGateFailure !== "frame") {
    for (let index = 1; index <= 4; index += 1) {
      if (partyGateFailure === "row" && index === 4) continue;
      const partyFrame = this.bridge.CreateFrame("Button", `PartyMemberFrame${index}`);
      lastPartyFrames.push(partyFrame);
      if (partyGateFailure !== "click") {
        partyFrame.secureAttributes.set("unit", `party${index}`);
        partyFrame.secureAttributes.set("*type1", "target");
      }
      const container = this.bridge.createChild(
        partyFrame, "Frame", `PartyMemberFrame${index}Container`,
      );
      if (partyGateFailure !== "portrait" || index !== 1) {
        this.bridge.createChild(container, "Texture", `PartyMemberFrame${index}Portrait`);
      }
      if (partyGateFailure !== "name" || index !== 1) {
        this.bridge.createChild(container, "FontString", `PartyMemberFrame${index}Name`);
      }
      if (partyGateFailure !== "health" || index !== 1) {
        this.bridge.createChild(container, "StatusBar", `PartyMemberFrame${index}HealthBar`);
      }
      if (partyGateFailure !== "mana" || index !== 1) {
        this.bridge.createChild(container, "StatusBar", `PartyMemberFrame${index}ManaBar`);
      }
      if (partyGateFailure !== "debuffs" || index !== 1) {
        for (let debuffIndex = 1; debuffIndex <= 4; debuffIndex += 1) {
          const debuff = this.bridge.createChild(
            container, "Button", `PartyMemberFrame${index}Debuff${debuffIndex}`,
          );
          this.bridge.createChild(
            debuff, "Texture", `PartyMemberFrame${index}Debuff${debuffIndex}Icon`,
          );
          this.bridge.createChild(
            debuff, "Texture", `PartyMemberFrame${index}Debuff${debuffIndex}Border`,
          );
        }
      }
    }
  }
  if (pendingLoad) await pendingLoad;
  // FrameXmlBoot attaches only after the asynchronous corpus work. Keep this ordering so reset
  // before attach exercises the real late-attach boundary rather than an already-attached seam.
  seam?.attach(this.pump);
  return inventory;
};

const originalClose = FrameXmlBoot.prototype.close;
FrameXmlBoot.prototype.close = function closeTracked() {
  const record = seams.find((entry) => entry.seam === this.seam && !entry.closed);
  if (record) record.closed = true;
  return originalClose.call(this);
};

const originalDestroy = FrameXmlDomRenderer.prototype.destroy;
FrameXmlDomRenderer.prototype.mount = function mountStub() {
  const host = this.container.parentElement;
  publicationSnapshots.push({
    visibility: host?.style.visibility ?? "",
    inert: host?.inert ?? false,
    ariaHidden: host?.getAttribute?.("aria-hidden") ?? null,
  });
  if (mountFailure) throw new Error(mountFailure);
};
FrameXmlDomRenderer.prototype.elementFor = function elementForStub(frame) {
  if (frame.name === "BuffFrame") return renderedBuffFrame;
  if (frame.name === "TargetFrame") return renderedTargetFrame;
  if (frame.name === "TargetFramePortrait") return renderedTargetPortrait;
  if (frame.name === "TargetFrameSpellBar") return renderedTargetSpellBar;
  if (frame.name === "TargetFrameBuffs") return renderedTargetBuffs;
  if (frame.name === "TargetFrameDebuffs") return renderedTargetDebuffs;
  if (frame.name === "TargetFrameToT") return renderedTargetToT;
  if (frame.name === "TargetFrameToTPortrait") return renderedTargetToTPortrait;
  if (frame.name === "TargetFrameToTHealthBar") return renderedTargetToTHealthBar;
  if (frame.name === "TargetFrameToTManaBar") return renderedTargetToTManaBar;
  if (frame.name === "FocusFrame") return renderedFocusFrame;
  if (frame.name === "FocusFramePortrait") return renderedFocusPortrait;
  if (frame.name === "FocusFrameHealthBar") return renderedFocusHealthBar;
  if (frame.name === "FocusFrameManaBar") return renderedFocusManaBar;
  if (frame.name === "PetFrame") return renderedPetFrame;
  if (frame.name === "PetPortrait") return renderedPetPortrait;
  if (frame.name === "PetFrameHealthBar") return renderedPetHealthBar;
  if (frame.name === "PetFrameManaBar") return renderedPetManaBar;
  const petDebuff = /^PetFrameDebuff([1-4])(?:Icon|Border)?$/.exec(frame.name);
  if (petDebuff) {
    const entry = renderedPetDebuffs[Number(petDebuff[1]) - 1];
    if (frame.name.endsWith("Icon")) return entry.icon;
    if (frame.name.endsWith("Border")) return entry.border;
    return entry.debuff;
  }
  const partyMatch = /^PartyMemberFrame([1-4])(?:Portrait|Name|HealthBar|ManaBar|Debuff([1-4])(?:Icon|Border)?)?$/.exec(frame.name);
  if (partyMatch) {
    const entry = renderedPartyFrames[Number(partyMatch[1]) - 1];
    if (frame.name.endsWith("Portrait")) return entry.portrait;
    if (frame.name.endsWith("Name")) return entry.name;
    if (frame.name.endsWith("HealthBar")) return entry.health;
    if (frame.name.endsWith("ManaBar")) return entry.mana;
    const debuffMatch = /Debuff([1-4])(Icon|Border)?$/.exec(frame.name);
    if (debuffMatch) {
      const debuff = entry.debuffs[Number(debuffMatch[1]) - 1];
      if (debuffMatch[2] === "Icon") return debuff.icon;
      if (debuffMatch[2] === "Border") return debuff.border;
      return debuff.debuff;
    }
    return entry.frame;
  }
  if (frame.name === "MinimapCluster") return renderedMinimapCluster;
  if (frame.name === "Minimap") return renderedMinimap;
  if (bagGateEnabled && (
    frame.name === "GameMenuFrame"
    || frame.name === "MainMenuBarBackpackButton"
    || frame.name === "KeyRingButton"
    || /^CharacterBag[0-3]Slot$/.test(frame.name)
    || /^ContainerFrame(?:[1-9]|1[0-3])$/.test(frame.name)
  )) {
    const element = fakeNode("div");
    element.setAttribute("data-framexml-name", frame.name);
    element.setAttribute("data-framexml-type", frame.type);
    return element;
  }
  return undefined;
};
FrameXmlDomRenderer.prototype.registerFonts = function registerFontsStub() { return 0; };
FrameXmlDomRenderer.prototype.tickCooldowns = function tickCooldownsStub() { return 0; };
FrameXmlDomRenderer.prototype.destroy = function destroyTracked() {
  seamEvents.push("renderer-destroy");
  return originalDestroy.call(this);
};

function seam(name) {
  return {
    name,
    attach(pump) {
      seamEvents.push(`${name}:attach`);
      this.pump = pump;
      this.attached = true;
    },
    detach() {
      if (!this.attached) return;
      seamEvents.push(`${name}:detach`);
      this.attached = false;
      this.detached = true;
    },
    attached: false,
    tick() {},
  };
}

test("world reset closes the old mount, reattaches the next world, and cancels an async mount", async () => {
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
    "replacement class must start absent");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "party class must start absent");
  const first = seam("first");
  const mounted = await mountFrameXmlVertical({ viewport, seam: first });
  assert.equal(mounted.ok, true);
  assert.ok(seamEvents.includes("first:attach"));
  assert.deepEqual(publicationSnapshots[0], {
    visibility: "hidden",
    inert: true,
    ariaHidden: "true",
  }, "the renderer must mount while the host is hidden and inert");
  const publishedHost = viewport.children.find((child) => child.id === "framexml-world-host");
  assert.equal(publishedHost?.style.visibility, "visible",
    "the host must become visible only after owner/class publication");
  assert.equal(publishedHost?.inert, false,
    "the host must leave inert mode only after owner/class publication");
  assert.equal(publishedHost?.getAttribute("aria-hidden"), "false",
    "the published host must be exposed to assistive technology");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), true,
    "replacement class must appear only after renderer mount succeeds");
  assert.equal(resizeListeners.size, baselineResizeListenerCount + 1,
    `first mount must install one resize listener (operations=${resizeOperations.map(([op]) => op).join(",")})`);
  const worldStyle = document.head.children.find((node) =>
    node.textContent.includes("body.framexml-world-replaces-native #player-hud"));
  assert.ok(worldStyle, "world style must scope the native replacement to exact lane IDs");
  assert.match(worldStyle.textContent, /display:\s*none\s*!important/,
    "native replacement must be CSS-owned rather than an inline DOM mutation");
  // The page's reduced-motion rule gives every element a 0.001 ms transition of every property; in
  // the HUD each Lua alpha/colour write then started a CSS transition, and style recalcs slowed with
  // every one until the next major GC. The HUD opts out of CSS transitions altogether.
  assert.match(worldStyle.textContent,
    /#framexml-world-host, #framexml-world-host \* \{ transition-property: none !important; \}/,
    "the stock HUD takes no CSS transitions");
  // The stock MinimapCluster owns the whole corner (tracking, world-map button, stock clock): the
  // native root is retired as one element, never piecemeal, and nothing below it stays in the rail
  // as scroll overflow (measured 389 > 260 with the old hybrid at 1920x919).
  assert.match(worldStyle.textContent,
    /body\.framexml-world-replaces-native #right-rail > #minimap \{ display: none !important; \}/,
    "the stock cluster retires the whole native #minimap root");
  assert.doesNotMatch(worldStyle.textContent, /#right-rail > #minimap > /,
    "no piecemeal native minimap child rules remain");
  assert.doesNotMatch(worldStyle.textContent, /margin-top: calc\(25vh/,
    "the native fallback is no longer laid out below the cluster");
  assert.match(worldStyle.textContent,
    /body\.framexml-world-replaces-native #right-rail \{\s*top: calc\(25vh \* var\(--ui-scale, 1\) \+ 10px\);/,
    "the remaining native rail (boss/arena frames) starts below the 192-unit stock cluster");
  for (const name of ["MiniMapTracking", "MiniMapWorldMapButton"]) {
    assert.ok(!worldStyle.textContent.includes(`[data-framexml-name="${name}"]`),
      `stock ${name} is a live control and must not be hidden`);
  }
  for (const selector of [
    "body.framexml-world-replaces-native #target-icon",
    "body.framexml-world-replaces-native #target-name",
    "body.framexml-world-replaces-native #target-details",
    "body.framexml-world-replaces-native #target-panel .target-health",
    "body.framexml-world-replaces-native #target-health-text",
    "body.framexml-world-replaces-native #target-power",
    "body.framexml-world-replaces-native #clear-target-button",
  ]) {
    assert.ok(worldStyle.textContent.includes(selector), `target replacement owns ${selector}`);
  }
  assert.match(worldStyle.textContent,
    /body\.framexml-world-replaces-native #target-panel \{[\s\S]*?width: 0 !important;[\s\S]*?height: 0 !important;[\s\S]*?background: transparent !important;/,
    "target panel is a transparent zero-size shell");
  assert.doesNotMatch(worldStyle.textContent, /#target-rail\s*\{[\s\S]*?display:\s*none/i,
    "target rail must not be hidden as one lane");
  for (const id of ["target-actions"]) {
    assert.doesNotMatch(worldStyle.textContent,
      new RegExp(`body\\.framexml-world-replaces-native #${id}[^\\{]*\\{[^}]*display:\\s*none`, "i"),
      `target action #${id} must not receive a core hide rule`);
  }
  assert.equal(body.classList.contains("framexml-world-replaces-target-context"), true,
    "target context class must appear only after static stock spellbar/aura gates");
  for (const id of ["target-cast", "target-auras"]) {
    assert.ok(worldStyle.textContent.includes(
      `body.framexml-world-replaces-target-context #${id}`,
    ), `target context ownership must scope the exact #${id} lane`);
  }
  assert.match(worldStyle.textContent,
    /body\.framexml-world-replaces-target-context #target-(?:cast|auras)[^\{]*\{[^}]*display:\s*none/i,
    "target context lanes must be CSS-owned without inline hidden/style mutations");
  assert.doesNotMatch(worldStyle.textContent,
    /body\.framexml-world-replaces-target-context #target-actions[^\{]*\{[^}]*display:\s*none/i,
    "target actions must remain native outside target context ownership");
  assert.equal(body.classList.contains("framexml-world-replaces-focus"), true,
    "focus owner class must appear only after the exact FocusFrame gate and portrait adoption");
  assert.equal(body.classList.contains("framexml-world-replaces-tot"), true,
    "ToT owner class must appear only after the exact TargetFrameToT gate and portrait adoption");
  assert.ok(worldStyle.textContent.includes("body.framexml-world-replaces-focus #focus-frame"));
  assert.ok(worldStyle.textContent.includes("body.framexml-world-replaces-tot #tot-frame"));
  assert.equal(body.classList.contains("framexml-world-replaces-pet"), true,
    "pet owner class must appear only after the complete stock PetFrame/adoption gate");
  assert.ok(worldStyle.textContent.includes("body.framexml-world-replaces-pet #pet-frame"),
    "pet ownership must hide the exact native #pet-frame lane");
  assert.doesNotMatch(worldStyle.textContent,
    /body\.framexml-world-replaces-pet #pet-bar[^\{]*\{[^}]*display:\s*none/i,
    "pet ownership must never hide the native #pet-bar lane");
  assert.doesNotMatch(worldStyle.textContent,
    /PetCastingBarFrame[^\n]*display:\s*none/i,
    "pet ownership must not claim the unsupported PetCastingBarFrame lane");
  assert.equal(lastPetFrame?.secureAttributes.get("unit"), "pet",
    "stock PetFrame must retain the pet unit binding structurally");
  assert.equal(lastPetFrame?.secureAttributes.get("*type1"), "target",
    "stock PetFrame must retain the secure target click contract structurally");
  assert.equal(renderedPetPortrait.parentNode, renderedPetFrame,
    "PetPortrait must be a direct stock PetFrame child");
  for (const { debuff, icon, border } of renderedPetDebuffs) {
    assert.equal(debuff.parentNode, renderedPetFrame,
      "each stock pet debuff button must be a direct PetFrame child");
    assert.equal(icon.parentNode, debuff, "each pet debuff must have its static Icon child");
    assert.equal(border.parentNode, debuff, "each pet debuff must have its static Border child");
  }
  assert.equal(body.classList.contains("framexml-world-replaces-party"), true,
    "party owner class must appear only after all four stock rows and canvas adoptions pass");
  assert.ok(worldStyle.textContent.includes("body.framexml-world-replaces-party #party-frames"),
    "party ownership must hide only the exact native #party-frames lane");
  assert.doesNotMatch(worldStyle.textContent,
    /body\.framexml-world-replaces-party #raid-frames[^\{]*\{[^}]*display:\s*none/i,
    "party ownership must never hide the raid lane");
  for (let index = 1; index <= 4; index += 1) {
    const frame = lastPartyFrames[index - 1];
    assert.equal(frame?.secureAttributes.get("unit"), `party${index}`,
      `PartyMemberFrame${index} must retain its party unit binding structurally`);
    assert.equal(frame?.secureAttributes.get("*type1"), "target",
      `PartyMemberFrame${index} must retain its secure target click contract structurally`);
    const entry = renderedPartyFrames[index - 1];
    assert.equal(entry.portrait.parentNode, entry.container,
      `PartyMemberFrame${index} portrait must be under its stock frame tree`);
    for (const { debuff, icon, border } of entry.debuffs) {
      assert.equal(debuff.parentNode, entry.container,
        `PartyMemberFrame${index} debuff button must be under its stock frame tree`);
      assert.equal(icon.parentNode, debuff, "party debuff Icon must remain under its button");
      assert.equal(border.parentNode, debuff, "party debuff Border must remain under its button");
    }
    assert.equal(nativePartyRows[index - 1].canvas.parentNode, entry.container,
      `party${index} canvas must be adopted into its stock portrait slot`);
  }
  assert.equal(targetCanvas.parentNode, renderedTargetFrame,
    "target portrait canvas must be adopted only after TargetFrame gates");
  assert.equal(nativeFocusCanvas.parentNode, renderedFocusFrame,
    "focus portrait canvas must be adopted only after FocusFrame gates");
  assert.equal(nativeTotCanvas.parentNode, renderedTargetToT,
    "target-of-target portrait canvas must be adopted only after TargetFrameToT gates");
  assert.equal(petCanvas.parentNode, renderedPetFrame,
    "pet portrait canvas must be adopted only after PetFrame gates");
  assert.equal(minimapCanvas.parentNode, renderedMinimap,
    "native minimap canvas must be adopted only after Minimap gates");
  assert.equal(targetCanvas.width, 128, "target portrait backing store follows 64px stock slot at DPR2");
  for (const [id, lane] of replacedNativeLanes) {
    const original = originalReplacedNativeState.get(id);
    assert.equal(lane.hidden, original.hidden, `mount must preserve #${id}.hidden`);
    assert.equal(lane.style.display, original.display, `mount must preserve #${id} inline display`);
  }
  for (const [id, lane] of untouchedNativeLanes) {
    const original = originalUntouchedNativeState.get(id);
    assert.equal(lane.hidden, original.hidden, `FrameXML mount must preserve native #${id}.hidden`);
    assert.equal(lane.style.display, original.display, `FrameXML mount must preserve native #${id} inline display`);
  }
  const duplicate = await mountFrameXmlVertical({ viewport, seam: seam("duplicate") });
  assert.equal(duplicate.ok, true, "a duplicate mount must be idempotent");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), true,
    "a duplicate mount must not remove the active replacement class");
  assert.ok(!seamEvents.includes("duplicate:attach"),
    "a duplicate mount must not create a pending cleanup owner");

  clearWorldContext();
  assert.ok(seamEvents.includes("first:detach"), "reset must detach the old world seam synchronously");
  assert.ok(seamEvents.includes("renderer-destroy"), "reset must destroy the old renderer");
  assert.ok(raf.cancelled.size > 0, "reset must cancel the old frame callback");
  assert.equal(viewport.children.length, 0, "reset must remove the old host");
  assertTargetCanvasRestored("reset");
  assertSecondaryPortraitsRestored("reset");
  assertMinimapCanvasRestored("reset");
  assert.equal(nativeMinimap.hidden, true, "reset must clear native minimap transient state");
  assert.equal(seams.find((entry) => entry.seam === first)?.closed, true,
    "reset must close the old boot");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
    "reset must remove the replacement class");
  assert.equal(body.classList.contains("framexml-world-replaces-target-context"), false,
    "reset must remove the optional target context class");
  assert.equal(body.classList.contains("framexml-world-replaces-focus"), false);
  assert.equal(body.classList.contains("framexml-world-replaces-tot"), false);
  assert.equal(body.classList.contains("framexml-world-replaces-pet"), false,
    "reset must remove the optional pet class");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "reset must remove the optional party class");
  assertPetCanvasRestored("reset");
  assertPartyCanvasesRestored("reset");
  for (const [id, lane] of replacedNativeLanes) {
    const original = originalReplacedNativeState.get(id);
    assert.equal(lane.hidden, original.hidden, `reset must preserve #${id}.hidden`);
    assert.equal(lane.style.display, original.display, `reset must preserve #${id} inline display`);
  }
  assert.equal(resizeListeners.size, baselineResizeListenerCount,
    `reset must remove the resize listener (operations=${resizeOperations.map(([op]) => op).join(",")})`);
  clearWorldContext();
  assert.equal(seamEvents.filter((event) => event === "first:detach").length, 1,
    "repeated reset must not detach the old seam twice");

  const second = seam("second");
  const remounted = await mountFrameXmlVertical({ viewport, seam: second });
  assert.equal(remounted.ok, true);
  assert.ok(seamEvents.includes("second:attach"), "the next world must attach its own seam");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), true,
    "remount must activate the replacement class");
  assert.equal(resizeListeners.size, baselineResizeListenerCount + 1,
    "remount must install one resize listener");
  unmountFrameXmlVertical();
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
    "unmount must remove the replacement class");
  assert.equal(body.classList.contains("framexml-world-replaces-target-context"), false,
    "unmount must remove the optional target context class");
  assert.equal(body.classList.contains("framexml-world-replaces-pet"), false,
    "unmount must remove the optional pet class");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "unmount must remove the optional party class");
  for (const [id, lane] of replacedNativeLanes) {
    const original = originalReplacedNativeState.get(id);
    assert.equal(lane.hidden, original.hidden, `unmount must preserve #${id}.hidden`);
    assert.equal(lane.style.display, original.display, `unmount must preserve #${id} inline display`);
  }
  assert.equal(resizeListeners.size, baselineResizeListenerCount,
    "unmount must remove the resize listener");
  assertTargetCanvasRestored("unmount");
  assertSecondaryPortraitsRestored("unmount");
  assertMinimapCanvasRestored("unmount");
  assertPetCanvasRestored("unmount");
  assertPartyCanvasesRestored("unmount");
  assert.equal(nativeMinimap.hidden, true, "unmount must clear native minimap transient state");

  mountFailure = "expected renderer mount failure";
  const failedRendererMount = await mountFrameXmlVertical({
    viewport,
    seam: seam("renderer-failed"),
  });
  mountFailure = undefined;
  assert.equal(failedRendererMount.ok, false, "renderer failure must return an error result");
  assert.match(failedRendererMount.message, /expected renderer mount failure/,
    "renderer failure must not be reported as cancellation");
  assert.ok(seamEvents.includes("renderer-failed:attach"));
  assert.ok(seamEvents.includes("renderer-failed:detach"),
    "renderer failure must detach the attached world seam");
  assert.equal(seams.find((entry) => entry.seam.name === "renderer-failed")?.closed, true,
    "renderer failure must close the boot");
  assert.equal(viewport.children.length, 0, "renderer failure must remove the host");
  assert.equal(document.head.children.length, 0, "renderer failure must remove the style");
  assert.equal(resizeListeners.size, baselineResizeListenerCount,
    "renderer failure must remove the resize listener");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
    "renderer failure must not leave the replacement class");
  assert.equal(body.classList.contains("framexml-world-replaces-target-context"), false,
    "renderer failure must not leave the optional target context class");
  assert.equal(body.classList.contains("framexml-world-replaces-pet"), false,
    "renderer failure must not leave the optional pet class");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "renderer failure must not leave the optional party class");
  assertTargetCanvasRestored("renderer failure");
  assertPetCanvasRestored("renderer failure");
  assertPartyCanvasesRestored("renderer failure");
  assertMinimapCanvasRestored("renderer failure");

  minimapGateFailure = "minimap";
  const failedMinimapGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("minimap-gate-failed"),
  });
  minimapGateFailure = undefined;
  assert.equal(failedMinimapGate.ok, false, "missing Minimap must fail the mount gate");
  assert.match(failedMinimapGate.message, /Minimap gate/,
    "minimap gate failure must be reported explicitly");
  assert.ok(seamEvents.includes("minimap-gate-failed:detach"),
    "minimap gate failure must detach the attached world seam");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
    "minimap gate failure must not claim native replacement");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "minimap gate failure must not leave the optional party class");
  assertMinimapCanvasRestored("minimap gate failure");

  targetGateFailure = "portrait";
  const failedTargetGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("target-gate-failed"),
  });
  targetGateFailure = undefined;
  assert.equal(failedTargetGate.ok, false, "missing TargetFrame portrait must fail the mount gate");
  assert.match(failedTargetGate.message, /TargetFrame gate/,
    "target gate failure must be reported explicitly");
  assert.ok(seamEvents.includes("target-gate-failed:detach"),
    "target gate failure must detach the attached world seam");
  assert.equal(seams.find((entry) => entry.seam.name === "target-gate-failed")?.closed, true,
    "target gate failure must close the boot");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
    "target gate failure must not claim native replacement");
  assert.equal(body.classList.contains("framexml-world-replaces-target-context"), false,
    "target gate failure must not claim target context replacement");
  assert.equal(body.classList.contains("framexml-world-replaces-pet"), false,
    "target gate failure must not leave the optional pet class");
  assertTargetCanvasRestored("target gate failure");
  assertPetCanvasRestored("target gate failure");
  assertPartyCanvasesRestored("target gate failure");
  assertMinimapCanvasRestored("target gate failure");

  targetGateFailure = "focus";
  const failedFocusGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("focus-gate-failed"),
  });
  targetGateFailure = undefined;
  assert.equal(failedFocusGate.ok, true,
    "a missing FocusFrame must not fail the complete HUD mount");
  assert.equal(body.classList.contains("framexml-world-replaces-focus"), false,
    "missing FocusFrame must retain the native focus lane");
  assert.equal(body.classList.contains("framexml-world-replaces-tot"), true,
    "a focus gate failure must not disable target-of-target ownership");
  assert.equal(nativeFocusCanvas.parentNode, nativeFocusFrame,
    "focus gate failure must not move the native focus canvas");
  assert.equal(nativeTotCanvas.parentNode, renderedTargetToT,
    "focus gate failure must leave independent ToT adoption active");
  unmountFrameXmlVertical();
  assertSecondaryPortraitsRestored("focus gate failure cleanup");

  targetGateFailure = "tot";
  const failedTotGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("tot-gate-failed"),
  });
  targetGateFailure = undefined;
  assert.equal(failedTotGate.ok, true,
    "a missing TargetFrameToT must not fail the complete HUD mount");
  assert.equal(body.classList.contains("framexml-world-replaces-focus"), true,
    "a ToT gate failure must not disable focus ownership");
  assert.equal(body.classList.contains("framexml-world-replaces-tot"), false,
    "missing TargetFrameToT must retain the native ToT lane");
  assert.equal(nativeFocusCanvas.parentNode, renderedFocusFrame,
    "ToT gate failure must leave independent focus adoption active");
  assert.equal(nativeTotCanvas.parentNode, nativeTotFrame,
    "ToT gate failure must not move the native ToT canvas");
  unmountFrameXmlVertical();
  assertSecondaryPortraitsRestored("ToT gate failure cleanup");

  targetContextGateFailure = "spellbar";
  const nativeTargetContextStateBeforeSpellbarFailure = new Map(
    ["target-cast", "target-auras"].map((id) => {
      const lane = untouchedNativeLanes.get(id);
      return [id, { hidden: lane.hidden, display: lane.style.display }];
    }),
  );
  const failedTargetContextGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("target-context-gate-failed"),
  });
  targetContextGateFailure = undefined;
  assert.equal(failedTargetContextGate.ok, true,
    "missing optional target context must not fail the complete HUD mount");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), true,
    "optional target context failure must retain the core HUD owner");
  assert.equal(body.classList.contains("framexml-world-replaces-target-context"), false,
    "missing static TargetFrameSpellBar must keep native target lanes");
  for (const id of ["target-cast", "target-auras"]) {
    const lane = untouchedNativeLanes.get(id);
    const original = nativeTargetContextStateBeforeSpellbarFailure.get(id);
    assert.equal(lane.hidden, original.hidden, `optional gate failure must preserve #${id}.hidden`);
    assert.equal(lane.style.display, original.display,
      `optional gate failure must preserve #${id} inline display`);
  }
  unmountFrameXmlVertical();

  targetContextGateFailure = "auras";
  const nativeTargetContextStateBeforeAurasFailure = new Map(
    ["target-cast", "target-auras"].map((id) => {
      const lane = untouchedNativeLanes.get(id);
      return [id, { hidden: lane.hidden, display: lane.style.display }];
    }),
  );
  const failedTargetAurasGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("target-auras-gate-failed"),
  });
  targetContextGateFailure = undefined;
  assert.equal(failedTargetAurasGate.ok, true,
    "missing optional target aura containers must not fail the complete HUD mount");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), true,
    "optional target aura failure must retain the core HUD owner");
  assert.equal(body.classList.contains("framexml-world-replaces-target-context"), false,
    "missing static TargetFrameBuffs/Debuffs must keep native target lanes");
  for (const id of ["target-cast", "target-auras"]) {
    const lane = untouchedNativeLanes.get(id);
    const original = nativeTargetContextStateBeforeAurasFailure.get(id);
    assert.equal(lane.hidden, original.hidden, `aura gate failure must preserve #${id}.hidden`);
    assert.equal(lane.style.display, original.display,
      `aura gate failure must preserve #${id} inline display`);
  }
  unmountFrameXmlVertical();

  petGateFailure = "debuffs";
  const nativePetStateBeforeDebuffFailure = {
    hidden: nativePetFrame.hidden,
    display: nativePetFrame.style.display,
  };
  const failedPetDebuffGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("pet-debuff-gate-failed"),
  });
  petGateFailure = undefined;
  assert.equal(failedPetDebuffGate.ok, true,
    "missing optional pet debuff children must not fail the complete HUD mount");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), true,
    "optional pet failure must retain the core HUD owner");
  assert.equal(body.classList.contains("framexml-world-replaces-pet"), false,
    "missing PetFrameDebuff1..4 Icon/Border gates must keep native pet-frame lane");
  assert.equal(nativePetFrame.hidden, nativePetStateBeforeDebuffFailure.hidden,
    "pet gate failure must preserve #pet-frame.hidden");
  assert.equal(nativePetFrame.style.display, nativePetStateBeforeDebuffFailure.display,
    "pet gate failure must preserve #pet-frame inline display");
  assertPetCanvasRestored("pet debuff gate failure");
  unmountFrameXmlVertical();

  petGateFailure = "click";
  const failedPetClickGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("pet-click-gate-failed"),
  });
  petGateFailure = undefined;
  assert.equal(failedPetClickGate.ok, true,
    "missing pet secure binding must not fail the complete HUD mount");
  assert.equal(body.classList.contains("framexml-world-replaces-pet"), false,
    "missing pet click binding must keep native pet-frame lane");
  assertPetCanvasRestored("pet click gate failure");
  unmountFrameXmlVertical();

  partyGateFailure = "debuffs";
  const failedPartyDebuffGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("party-debuff-gate-failed"),
  });
  partyGateFailure = undefined;
  assert.equal(failedPartyDebuffGate.ok, true,
    "missing optional party debuff children must not fail the complete HUD mount");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), true,
    "optional party failure must retain the core HUD owner");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "missing PartyMemberFrame debuff Icon/Border gates must keep native party UI");
  assertPartyCanvasesRestored("party debuff gate failure");
  unmountFrameXmlVertical();

  partyGateFailure = "name";
  const failedPartyNameGate = await mountFrameXmlVertical({
    viewport,
    seam: seam("party-name-gate-failed"),
  });
  partyGateFailure = undefined;
  assert.equal(failedPartyNameGate.ok, true,
    "missing optional party name widget must not fail the complete HUD mount");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "missing PartyMemberFrame Name must keep native party UI");
  assertPartyCanvasesRestored("party name gate failure");
  unmountFrameXmlVertical();

  const missingPartyCanvas = nativePartyRows[3].canvas;
  const originalMissingPartySlot = missingPartyCanvas.dataset.portraitSlot;
  // The imported UnitFrames module also owns the real browser party list in this fixture. Hide its
  // fourth slot marker for this negative path too, so the test removes the one logical native slot
  // rather than accidentally leaving a duplicate test-only canvas available to adoption.
  const browserPartyList = nativePartyFrame.children.find((child) =>
    child.className === "ui-unit-list ui-unit-list-party");
  const browserPartyCanvas = browserPartyList?.children[3]?.querySelector(
    'canvas[data-portrait-slot="party4"]',
  );
  const originalBrowserPartySlot = browserPartyCanvas?.dataset.portraitSlot;
  missingPartyCanvas.dataset.portraitSlot = "party4-missing";
  if (browserPartyCanvas) browserPartyCanvas.dataset.portraitSlot = "party4-missing";
  const failedPartyAdoption = await mountFrameXmlVertical({
    viewport,
    seam: seam("party-adoption-failed"),
  });
  missingPartyCanvas.dataset.portraitSlot = originalMissingPartySlot;
  if (browserPartyCanvas && originalBrowserPartySlot !== undefined) {
    browserPartyCanvas.dataset.portraitSlot = originalBrowserPartySlot;
  }
  assert.equal(failedPartyAdoption.ok, true,
    "a missing native party canvas must not fail the complete HUD mount");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "party ownership must be all-or-nothing when one canvas cannot be adopted");
  assertPartyCanvasesRestored("party adoption failure");
  unmountFrameXmlVertical();

  rafFailure = "expected animation frame failure";
  let failedRafMount;
  try {
    failedRafMount = await mountFrameXmlVertical({ viewport, seam: seam("raf-failed") });
  } finally {
    rafFailure = undefined;
  }
  assert.equal(failedRafMount.ok, false, "rAF failure must return an error result");
  assert.match(failedRafMount.message, /expected animation frame failure/,
    "rAF failure must not be reported as cancellation");
  assert.ok(seamEvents.includes("raf-failed:detach"),
    "rAF failure must detach the attached world seam");
  assert.equal(seams.find((entry) => entry.seam.name === "raf-failed")?.closed, true,
    "rAF failure must close the boot");
  assert.equal(viewport.children.length, 0, "rAF failure must remove the host");
  assert.equal(document.head.children.length, 0, "rAF failure must remove the style");
  assert.equal(resizeListeners.size, baselineResizeListenerCount,
    "rAF failure must remove the resize listener");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
    "rAF failure must not leave the replacement class");
  assert.equal(body.classList.contains("framexml-world-replaces-target-context"), false,
    "rAF failure must not leave the optional target context class");
  assert.equal(body.classList.contains("framexml-world-replaces-pet"), false,
    "rAF failure must not leave the optional pet class");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "rAF failure must not leave the optional party class");
  assertTargetCanvasRestored("rAF failure");
  assertPetCanvasRestored("rAF failure");
  assertPartyCanvasesRestored("rAF failure");
  assertMinimapCanvasRestored("rAF failure");

  let release;
  pendingLoad = new Promise((resolve) => { release = resolve; });
  const late = seam("late");
  const lateMount = mountFrameXmlVertical({ viewport, seam: late });
  await Promise.resolve();
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
    "pending mount must not activate the replacement class");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "pending mount must not activate the optional party class");
  clearWorldContext();
  assert.ok(!seamEvents.includes("late:attach"), "reset should precede the late boot attach");
  assert.equal(seams.find((entry) => entry.seam === late)?.closed, true,
    "reset must close a pending boot before it attaches");
  assert.equal(viewport.children.length, 0, "reset must remove a pending mount host immediately");
  assert.equal(seamEvents.filter((event) => event === "late:detach").length, 0,
    "pending cleanup has no seam to detach before the late attach");
  release();
  const lateResult = await lateMount;
  pendingLoad = undefined;

  assert.equal(lateResult.ok, false, "a reset during load must invalidate the pending mount");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
    "stale mount must not leave the replacement class");
  assert.equal(body.classList.contains("framexml-world-replaces-target-context"), false,
    "stale mount must not leave the optional target context class");
  assert.equal(body.classList.contains("framexml-world-replaces-pet"), false,
    "stale mount must not leave the optional pet class");
  assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
    "stale mount must not leave the optional party class");
  assert.ok(seamEvents.includes("late:attach"), "late boot must be able to cross the attach boundary");
  assert.equal(seamEvents.filter((event) => event === "late:detach").length, 1,
    "late attach must be detached exactly once after stale resolution");
  assert.equal(viewport.children.length, 0, "a stale mount must not publish a host");
  for (const [id, lane] of replacedNativeLanes) {
    const original = originalReplacedNativeState.get(id);
    assert.equal(lane.hidden, original.hidden, `stale mount must preserve #${id}.hidden`);
    assert.equal(lane.style.display, original.display, `stale mount must preserve #${id} inline display`);
  }
  assertTargetCanvasRestored("stale mount");
  assertPetCanvasRestored("stale mount");
  assertPartyCanvasesRestored("stale mount");
  assertMinimapCanvasRestored("stale mount");
  assert.equal(raf.scheduled.size, 11,
    "only successful mounts, including optional target-context failures, may schedule a frame");
});

test("stock bag ownership restores native inventory state after unmount and late failure", async () => {
  const originalHidden = inventoryWindow.hidden;
  bagGateEnabled = true;
  bagClickFailure = false;
  inventoryWindow.hidden = false;
  try {
    const mounted = await mountFrameXmlVertical({ viewport, seam: seam("bags-restore") });
    assert.equal(mounted.ok, true,
      `the test stock bag gate publishes with the complete mount: ${mounted.message}`);
    assert.equal(body.classList.contains("framexml-world-replaces-bags"), true,
      "native bags are hidden only after the stock owner publishes");
    assert.equal(inventoryWindow.hidden, true,
      "the native inventory is normalized while stock bags own the route");
    unmountFrameXmlVertical();
    assert.equal(body.classList.contains("framexml-world-replaces-bags"), false,
      "unmount removes the stock bag replacement class");
    assert.equal(inventoryWindow.hidden, false,
      "unmount restores the exact native inventory hidden state");

    inventoryWindow.hidden = false;
    rafFailure = "expected bag late failure";
    const lateFailure = await mountFrameXmlVertical({ viewport, seam: seam("bags-late-failure") });
    rafFailure = undefined;
    assert.equal(lateFailure.ok, false, "a failure after bag publication returns an error");
    assert.equal(body.classList.contains("framexml-world-replaces-bags"), false,
      "late failure removes the stock bag replacement class");
    assert.equal(inventoryWindow.hidden, false,
      "late failure restores native inventory state without resurrection");
  } finally {
    rafFailure = undefined;
    bagClickFailure = false;
    unmountFrameXmlVertical();
    bagGateEnabled = false;
    inventoryWindow.hidden = originalHidden;
  }
});

test("a published stock bag error demotes to the native inventory owner", async () => {
  const originalHidden = inventoryWindow.hidden;
  bagGateEnabled = true;
  bagClickFailure = false;
  inventoryWindow.hidden = false;
  try {
    const mounted = await mountFrameXmlVertical({ viewport, seam: seam("bags-demote") });
    assert.equal(mounted.ok, true, `bag mount succeeds: ${mounted.message}`);
    assert.equal(inventoryWindow.hidden, true);
    bagClickFailure = true;
    assert.equal(toggleFrameXmlBackpack(), false,
      "a post-publish stock error permits the native fallback route");
    assert.equal(frameXmlBagsOpen(), false, "the failed stock owner is no longer authoritative");
    assert.equal(body.classList.contains("framexml-world-replaces-bags"), false,
      "self-demotion removes the stock bag replacement class");
    assert.equal(inventoryWindow.hidden, false,
      "self-demotion restores the native inventory state");
  } finally {
    bagClickFailure = false;
    unmountFrameXmlVertical();
    bagGateEnabled = false;
    inventoryWindow.hidden = originalHidden;
  }
});

test("a failed FrameXML load never claims the native replacement class", async () => {
  const previousLoad = FrameXmlBoot.prototype.load;
  FrameXmlBoot.prototype.load = async function failedLoad() {
    throw new Error("expected boot failure");
  };
  try {
    const result = await mountFrameXmlVertical({ viewport, seam: seam("failed") });
    assert.equal(result.ok, false);
    assert.equal(body.classList.contains("framexml-world-replaces-native"), false,
      "failed mount must not leave the replacement class");
    assert.equal(body.classList.contains("framexml-world-replaces-target-context"), false,
      "failed mount must not leave the optional target context class");
    assert.equal(body.classList.contains("framexml-world-replaces-pet"), false,
      "failed mount must not leave the optional pet class");
    assert.equal(body.classList.contains("framexml-world-replaces-party"), false,
      "failed mount must not leave the optional party class");
    assertPetCanvasRestored("failed load");
    assertPartyCanvasesRestored("failed load");
  } finally {
    FrameXmlBoot.prototype.load = previousLoad;
    unmountFrameXmlVertical();
  }
});

test("addon overlay preserves native HUD and releases commands, menu actions and subscriptions across logout and cancelled login", async () => {
  const { moduleCommandList } = await import("../dist/code/browser/ui/Chat.js");
  const { toggleGameMenu } = await import("../dist/code/browser/ui/GameMenu.js");
  const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
  const previousLoad = FrameXmlBoot.prototype.load;
  const previousObserver = globalThis.MutationObserver;
  const menuHost = fakeNode("div");
  usePanelHost({ viewport: menuHost, attach() {} });
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const hits = [];
  const records = [];
  let defer;
  FrameXmlBoot.prototype.load = async function addonLoad() {
    const record = { boot: this, seam: this.seam, renderSubscriptions: 0 };
    records.push(record);
    seams.push({ seam: this.seam, closed: false });
    const subscribe = this.bridge.subscribe.bind(this.bridge);
    this.bridge.subscribe = (callback) => {
      record.renderSubscriptions += 1;
      const unsubscribe = subscribe(callback);
      return () => { record.renderSubscriptions -= 1; unsubscribe(); };
    };
    this.isAddonLoaded = (name) => name === "lifecycle-addon";
    this.bridge.CreateFrame("Frame", "UIParent");
    const menu = this.bridge.CreateFrame("Frame", "GameMenuFrame");
    this.bridge.CreateFrame("Button", "LifecycleMenuButton", menu);
    this.vm.registerGlobal("LifecycleHit", ([value]) => { hits.push(value); return []; });
    const result = this.vm.execute(`
      assert(UIParent:GetWidth() > 1000 and UIParent:GetHeight() == 768,
        "TSWoW addon boot must see the logical viewport before DOM mounting")
      SlashCmdList = { LIFECYCLE = function(rest) LifecycleHit(rest) end }
      SLASH_LIFECYCLE1 = "/lifecycle-addon"
      LifecycleMenuButton:SetText("Lifecycle addon action")
      LifecycleMenuButton:SetScript("OnClick", function() LifecycleHit("menu") end)
    `, "@interface/framexml/tsaddons/lifecycle-addon/addon/addon.lua");
    assert.equal(result.ok, true, result.error);
    if (defer) await defer;
    this.seam.attach(this.pump);
    return inventory;
  };
  const command = () => moduleCommandList().find((entry) => entry.name === "lifecycle-addon");
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  const menuActions = () => descendants(menuHost).filter((node) => node.textContent === "Lifecycle addon action");
  const nativeState = new Map([...replacedNativeLanes, ...untouchedNativeLanes].map(([id, node]) =>
    [id, { hidden: node.hidden, display: node.style.display, parent: node.parentNode }]));
  const assertNative = () => {
    for (const [id, node] of [...replacedNativeLanes, ...untouchedNativeLanes]) {
      assert.deepEqual({ hidden: node.hidden, display: node.style.display, parent: node.parentNode }, nativeState.get(id),
        `Addon overlay cannot replace or reparent native ${id}`);
    }
    assert.equal(body.classList.contains("framexml-world-replaces-native"), false);
  };
  try {
    const first = seam("addons-first");
    const result = await mountFrameXmlVertical({ viewport, seam: first, addonsOnly: true });
    assert.equal(result.ok, true, result.message);
    assert.equal(first.attached, true);
    assert.equal(records[0].renderSubscriptions, 1);
    assertNative();
    const host = viewport.children.find((node) => node.id === "framexml-world-host");
    assert.equal(host.dataset.tswowAddons, "true");
    assert.equal(host.style.visibility, "visible");
    const retainedCommand = command();
    assert.ok(retainedCommand, "Own Lua command must be available through native chat");
    retainedCommand.run("first");
    toggleGameMenu();
    assert.equal(menuActions().length, 1, "The native menu exposes one original addon action");
    const retainedMenu = menuActions()[0];
    retainedMenu.dispatchEvent({ type: "click" });
    assert.deepEqual(hits, ["first", "menu"]);
    const scheduled = [...raf.scheduled].at(-1);
    assert.equal(typeof window.frameXmlWorld, "function");
    clearWorldContext();
    assert.equal(first.attached, false);
    assert.equal(records[0].renderSubscriptions, 0, "Logout releases the renderer mutation subscription");
    assert.equal(command(), undefined, "Logout unregisters native slash commands");
    assert.equal(menuActions().length, 0, "Logout removes native addon menu entries");
    assert.equal(typeof window.frameXmlWorld, "undefined", "Logout releases the diagnostic closure over the old VM");
    retainedCommand.run("stale command");
    retainedMenu.dispatchEvent({ type: "click" });
    scheduled.callback();
    assert.deepEqual(hits, ["first", "menu"], "Retained old callbacks never enter the closed VM");
    assert.equal(raf.cancelled.has(scheduled.id), true);
    assert.equal(resizeListeners.size, baselineResizeListenerCount);
    assert.equal(viewport.children.length, 0);
    assertNative();

    let release;
    defer = new Promise((resolve) => { release = resolve; });
    const stale = seam("addons-cancelled");
    const pending = mountFrameXmlVertical({ viewport, seam: stale, addonsOnly: true });
    assert.equal(command(), undefined, "A loading addon cannot publish its command prematurely");
    clearWorldContext();
    release();
    assert.equal((await pending).ok, false);
    assert.equal(stale.attached, false, "Late boot completion detaches the old-world subscription");
    assert.equal(command(), undefined);
    assert.equal(menuActions().length, 0);
    assert.equal(viewport.children.length, 0);
    assert.equal(resizeListeners.size, baselineResizeListenerCount);

    defer = undefined;
    const next = seam("addons-next");
    assert.equal((await mountFrameXmlVertical({ viewport, seam: next, addonsOnly: true })).ok, true);
    assert.equal(menuActions().length, 1, "Next login publishes one fresh menu action");
    assert.ok(command());
    command().run("next");
    retainedCommand.run("old callback after login");
    retainedMenu.dispatchEvent({ type: "click" });
    assert.deepEqual(hits, ["first", "menu", "next"]);
    assertNative();
    unmountFrameXmlVertical();
    assert.equal(command(), undefined);
    assert.equal(menuActions().length, 0);
    assert.equal(next.attached, false);
    assert.equal(resizeListeners.size, baselineResizeListenerCount);
    assert.ok(records.every((record) => seams.some((entry) => entry.seam === record.seam && entry.closed)),
      "Each published and cancelled generation closes its boot");
    assert.ok(records.every((record) => record.renderSubscriptions === 0), "No prior renderer subscription survives");
  } finally {
    defer = undefined;
    FrameXmlBoot.prototype.load = previousLoad;
    unmountFrameXmlVertical();
    if (previousObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = previousObserver;
  }
});

/**
 * The add-on overlay's stock dialog and error line over a stubbed load: a shown `StaticPopup`-like
 * frame Escape may dismiss, a stock `StaticPopup_EscapePressed` that records the press (and leaves
 * the dialog up unless `hideOnPress`), a `UIErrorsFrame` and the boot's `hooksecurefunc` shim.
 * Each generation's presses land in `escapes` under its index.
 */
function installAddonDialogsLoad({ hideOnPress = false } = {}) {
  const previousLoad = FrameXmlBoot.prototype.load;
  const boots = [];
  const escapes = [];
  FrameXmlBoot.prototype.load = async function addonDialogsLoad() {
    const generation = boots.length;
    boots.push(this);
    seams.push({ seam: this.seam, closed: false });
    this.isAddonLoaded = () => false;
    this.bridge.CreateFrame("Frame", "UIParent");
    this.bridge.CreateFrame("Frame", "GameMenuFrame");
    this.bridge.CreateFrame("Frame", "LifecycleStaticPopup");
    this.bridge.CreateFrame("MessageFrame", "UIErrorsFrame");
    this.vm.registerGlobal("LifecycleEscape", () => { escapes.push(generation); return []; });
    const result = this.vm.execute(`
      function hooksecurefunc(target, name, hook)
        if hook == nil then target, name, hook = _G, target, name end
        local original = target[name]
        target[name] = function(...) local results = { original(...) } hook(...) return table.unpack(results) end
      end
      assert(LifecycleStaticPopup:IsShown())
      LifecycleStaticPopup.hideOnEscape = 1
      StaticPopupDialogs = {}
      StaticPopup_DisplayedFrames = { LifecycleStaticPopup }
      function StaticPopup_EscapePressed()
        LifecycleEscape()
        ${hideOnPress ? "LifecycleStaticPopup:Hide()" : ""}
        return 1
      end
    `, "@interface/framexml/staticpopup.lua");
    assert.equal(result.ok, true, result.error);
    this.seam.attach(this.pump);
    return inventory;
  };
  return { boots, escapes, restore: () => { FrameXmlBoot.prototype.load = previousLoad; } };
}

const dialogSeam = (name) => Object.assign(seam(name), { popups: { popupsOwned: false } });

test("world mounts draw their dialogs modeless in both modes: the world, the native HUD and other windows keep their input", async () => {
  const previousMount = FrameXmlDomRenderer.prototype.mount;
  const previousObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const renderers = [];
  FrameXmlDomRenderer.prototype.mount = function captureRenderer(...args) {
    renderers.push(this);
    return previousMount.apply(this, args);
  };
  const load = installAddonDialogsLoad();
  try {
    assert.equal((await mountFrameXmlVertical({ viewport, seam: dialogSeam("modeless-addons"), addonsOnly: true })).ok, true);
    unmountFrameXmlVertical();
    load.restore();
    assert.equal((await mountFrameXmlVertical({ viewport, seam: seam("modeless-full") })).ok, true);
    unmountFrameXmlVertical();
    assert.deepEqual(renderers.map((renderer) => renderer.dialogs), ["modeless", "modeless"],
      "a StaticPopup never makes #world-canvas or the native HUD inert, nor holds the keyboard");
  } finally {
    load.restore();
    FrameXmlDomRenderer.prototype.mount = previousMount;
    unmountFrameXmlVertical();
    if (previousObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = previousObserver;
  }
});

let escapeKeydown;
/**
 * Controls' real keydown Escape over the fake DOM: the key is wired once (wireControls), and what the
 * press asks for is set for one run — `instanceof HTMLInputElement`, a document listener slot, the
 * markup windows closed, a module window open under whatever the test shows, and a world with a
 * target whose native closers (closeMailbox, closeGuildBank …) answer as no-ops.
 */
async function withEscapeKey(run) {
  const windows = await import("../dist/code/browser/ui/Windows.js");
  const dom = await import("../dist/code/browser/ui/Dom.js");
  const controls = await import("../dist/code/browser/input/Controls.js");
  const previousObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const addedGlobals = ["HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement"]
    .filter((name) => globalThis[name] === undefined);
  for (const name of addedGlobals) globalThis[name] = class {};
  const addedDocumentListener = document.addEventListener === undefined;
  if (addedDocumentListener) document.addEventListener = () => {};
  const markup = ["characterWindow", "inventoryWindow", "spellbookWindow", "gossipWindow", "questWindow",
    "lootWindow", "auctionWindow", "tradeWindow", "vendorWindow", "trainerWindow", "diagnosticsWindow"]
    .map((name) => dom[name]).filter(Boolean);
  const markupHidden = markup.map((node) => node.hidden);
  for (const node of markup) node.hidden = true;
  const previousWorld = game.world;
  const calls = [];
  const world = new Proxy({
    state: { selfGuid: 1n, objects: new Map() }, targetGuid: 7n, chatLog: [], casts: new Map(),
    logout: undefined, loggedOut: false, aurasFor: () => [], displayName: () => "",
    selectTarget(guid) { this.targetGuid = guid; calls.push("selectTarget"); },
  }, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      return typeof property === "string" && /^(?:close|cancel|leave|decline|stop|end)/.test(property) ? () => {} : undefined;
    },
  });
  const moduleWindow = { open: true, closes: 0, isOpen() { return this.open; }, close() { this.closes += 1; this.open = false; } };
  const releaseModuleWindow = windows.registerEscapable(moduleWindow);
  try {
    if (!escapeKeydown) {
      const windowListen = window.addEventListener;
      window.addEventListener = (type, listener) => { if (type === "keydown") escapeKeydown = listener; else windowListen(type, listener); };
      try { controls.wireControls(); } finally { window.addEventListener = windowListen; }
    }
    assert.equal(typeof escapeKeydown, "function");
    const escape = () => escapeKeydown({ code: "Escape", key: "Escape", target: document.body, defaultPrevented: false,
      repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {} });
    await run({ escape, world, calls, moduleWindow, enterWorld: () => { game.world = world; } });
  } finally {
    releaseModuleWindow();
    game.world = previousWorld;
    unmountFrameXmlVertical();
    markup.forEach((node, index) => { node.hidden = markupHidden[index]; });
    for (const name of addedGlobals) delete globalThis[name];
    if (addedDocumentListener) delete document.addEventListener;
    if (previousObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = previousObserver;
  }
}

test("one Escape closes only an add-on dialog: the module window beneath and the target wait for the next press", async () => {
  const load = installAddonDialogsLoad({ hideOnPress: true });
  try {
    await withEscapeKey(async ({ escape, world, calls, moduleWindow, enterWorld }) => {
      assert.equal((await mountFrameXmlVertical({ viewport, seam: dialogSeam("escape-dialog"), addonsOnly: true })).ok, true);
      enterWorld();
      escape();
      assert.deepEqual(load.escapes, [0], "the press reached stock StaticPopup_EscapePressed");
      assert.equal(moduleWindow.closes, 0, "and stopped there: the module window under the dialog stays open");
      assert.equal(world.targetGuid, 7n, "the target stays");
      assert.deepEqual(calls, []);
      escape();
      assert.deepEqual(load.escapes, [0], "no dialog is up now: the next press is the native chain's");
      assert.equal(moduleWindow.closes, 1);
      // 4.04: the native chain is one step per press too — the window went, the target is the next press's.
      assert.equal(world.targetGuid, 7n);
    });
  } finally {
    load.restore();
  }
});

test("full HUD without the stock game menu: one Escape answers the published stock popups alone, as stock ToggleGameMenu", async () => {
  const controller = await import("../dist/code/browser/framexml/FrameXmlPopupsController.js");
  await withEscapeKey(async ({ escape, world, calls, moduleWindow, enterWorld }) => {
    // The server's confirmations are stock's (the popups owner published), the game menu native.
    const popups = { open: true, closes: 0, isOpen() { return this.open; }, close() { this.closes += 1; this.open = false; } };
    const release = controller.publishFrameXmlPopups(popups);
    try {
      enterWorld();
      escape();
      assert.equal(popups.closes, 1, "StaticPopup_EscapePressed answered the dialog");
      assert.equal(moduleWindow.closes, 0, "and the press stopped there: the window under it stays open");
      assert.equal(world.targetGuid, 7n, "the target stays");
      assert.deepEqual(calls, []);
      escape();
      assert.equal(popups.closes, 1, "no dialog is up now: the next press is the native chain's");
      assert.equal(moduleWindow.closes, 1);
      // 4.04: one step per press — the window went, the target is the next press's.
      assert.equal(world.targetGuid, 7n);
    } finally {
      release();
    }
  });
});

test("full HUD: a shown stock dialog stands over the native windows, and the overlay falls back when the last one hides", async () => {
  const previousLoad = FrameXmlBoot.prototype.load;
  const previousObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const boots = [];
  FrameXmlBoot.prototype.load = async function dialogLayerLoad(...args) {
    const result = await previousLoad.apply(this, args);
    boots.push(this);
    for (const name of ["StaticPopup1", "ReadyCheckFrame"]) this.bridge.Hide(this.bridge.CreateFrame("Frame", name));
    assert.equal(this.vm.execute("STATICPOPUP_NUMDIALOGS = 1", "@interface/framexml/staticpopup.lua").ok, true);
    return result;
  };
  try {
    const mounted = await mountFrameXmlVertical({ viewport, seam: seam("dialog-layer") });
    assert.equal(mounted.ok, true, mounted.message);
    const host = viewport.children.find((node) => node.id === "framexml-world-host");
    const layer = () => Number(host.style.zIndex || 0);
    assert.equal(layer(), 0, "the stock HUD sits at its stylesheet's z-index 3, under the native windows");
    const { bridge } = boots[0];
    bridge.Show(bridge.getFrame("StaticPopup1"));
    assert.equal(layer() > 30, true, "a PARTY_INVITE-like popup lifts the overlay over the native windows (31 and up)");
    bridge.Show(bridge.getFrame("ReadyCheckFrame"));
    bridge.Hide(bridge.getFrame("StaticPopup1"));
    assert.equal(layer() > 30, true, "still over them while the ready check is up");
    bridge.Hide(bridge.getFrame("ReadyCheckFrame"));
    assert.equal(layer(), 0, "the last one hidden: back under the native windows");
    bridge.Show(bridge.getFrame("StaticPopup1"));
    assert.equal(layer() > 30, true, "and up again with the next dialog");
  } finally {
    FrameXmlBoot.prototype.load = previousLoad;
    unmountFrameXmlVertical();
    if (previousObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = previousObserver;
  }
});

test("addon overlay dialogs: the Escape step is published per mount and withdrawn by the entry-point cleanup; a module line raises the overlay", async () => {
  const {
    escapeFrameXmlAddonDialogs, frameXmlAddonDialogsEscapePublished,
  } = await import("../dist/code/browser/framexml/FrameXmlTsAddonPresentation.js");
  const previousClose = FrameXmlBoot.prototype.close;
  const previousObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const load = installAddonDialogsLoad();
  const deferred = [];
  // Each VM stays open past its unmount: a step the cleanup left behind would still answer.
  FrameXmlBoot.prototype.close = function deferredClose() { deferred.push(this); };
  try {
    const first = dialogSeam("dialogs-first");
    const mounted = await mountFrameXmlVertical({ viewport, seam: first, addonsOnly: true });
    assert.equal(mounted.ok, true, mounted.message);
    assert.deepEqual(window.frameXmlWorld().surfaces, { popups: 0, errors: 0, serverQuestions: "native" });
    assert.equal(first.popups.popupsOwned, false, "the server's confirmations are not handed to stock");
    const host = viewport.children.find((node) => node.id === "framexml-world-host");
    const layer = Number(host.style.zIndex);
    assert.equal(load.boots[0].vm.execute('UIErrorsFrame:AddMessage("Голод начинает ослаблять вас!", 1, 0.25, 0.15, 1)',
      "@interface/framexml/tsaddons/lifecycle/addon/addon.lua").ok, true);
    assert.equal(Number(host.style.zIndex) > layer, true, "the overlay rose over the native windows with the line");
    assert.equal(window.frameXmlWorld().surfaces.errors, 1);
    assert.equal(escapeFrameXmlAddonDialogs(), true);
    assert.deepEqual(load.escapes, [0], "one press reaches stock StaticPopup_EscapePressed once");
    unmountFrameXmlVertical();
    assert.equal(deferred.includes(load.boots[0]), true, "the unmount reached boot.close");
    assert.equal(frameXmlAddonDialogsEscapePublished(), false, "the entry-point cleanup withdrew the step");
    assert.equal(escapeFrameXmlAddonDialogs(), false, "nothing answers it (its VM is still open)");
    assert.deepEqual(load.escapes, [0]);

    const next = dialogSeam("dialogs-next");
    assert.equal((await mountFrameXmlVertical({ viewport, seam: next, addonsOnly: true })).ok, true);
    assert.equal(escapeFrameXmlAddonDialogs(), true);
    assert.deepEqual(load.escapes, [0, 1], "one handler after the remount: the new mount's, once");
    assert.equal(next.popups.popupsOwned, false);
    unmountFrameXmlVertical();
    assert.equal(frameXmlAddonDialogsEscapePublished(), false);
    assert.equal(escapeFrameXmlAddonDialogs(), false);
    assert.deepEqual(load.escapes, [0, 1]);
  } finally {
    load.restore();
    FrameXmlBoot.prototype.close = previousClose;
    unmountFrameXmlVertical();
    for (const boot of deferred) previousClose.call(boot);
    if (previousObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = previousObserver;
  }
});

/** Run the newest scheduled HUD frame callback once (the fake rAF only records them). */
function runNewestFrame() {
  const newest = [...raf.scheduled].reduce((best, entry) => (!best || entry.id > best.id ? entry : best), undefined);
  assert.ok(newest, "a HUD frame is scheduled");
  raf.scheduled.delete(newest);
  newest.callback(0);
  return newest.id;
}

/** Capture the boot of the next mount without changing the harness' stubbed load. */
async function mountCapturingBoot(options) {
  const previousLoad = FrameXmlBoot.prototype.load;
  let boot;
  FrameXmlBoot.prototype.load = function captureBoot(...args) {
    boot = this;
    return previousLoad.apply(this, args);
  };
  try {
    const result = await mountFrameXmlVertical(options);
    return { result, boot };
  } finally {
    FrameXmlBoot.prototype.load = previousLoad;
  }
}

test("one thrown HUD frame is reported once and the next frame is still scheduled", async () => {
  const throwing = seam("step-throws");
  let ticks = 0;
  throwing.tick = () => {
    ticks += 1;
    if (ticks <= 2) throw new Error("seam tick failed");
  };
  const reported = [];
  const previousError = console.error;
  console.error = (...args) => { reported.push(String(args[0])); };
  try {
    const { result } = await mountCapturingBoot({ viewport, seam: throwing });
    assert.equal(result.ok, true, result.message);
    const first = runNewestFrame();
    assert.equal(ticks, 1, "the first frame ran and threw");
    const second = runNewestFrame();
    assert.ok(second > first, "a thrown frame still re-armed requestAnimationFrame");
    assert.equal(ticks, 2);
    runNewestFrame();
    assert.equal(ticks, 3, "the HUD keeps ticking after the failures");
    assert.equal(reported.filter((line) => line.includes("seam tick failed")).length, 1,
      "the same failure is reported once, not every frame");
  } finally {
    console.error = previousError;
    unmountFrameXmlVertical();
  }
  const before = raf.next;
  assert.equal([...raf.scheduled].some((entry) => entry.id >= before), false,
    "no frame is scheduled after unmount");
});

test("ReloadUI remounts the HUD after the Lua caller unwinds; DisableAllAddOns is session-only", async () => {
  const {
    frameXmlClientAddonEnabled,
    frameXmlSessionDisabledClientAddons,
    installFrameXmlReloadUi,
  } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
  const chat = await import("../dist/code/browser/ui/Chat.js");
  const reloading = seam("reload");
  const { result, boot } = await mountCapturingBoot({ viewport, seam: reloading });
  const previousWorld = game.world;
  const messages = [];
  let duringReload;
  try {
    assert.equal(result.ok, true, result.message);
    const attachesBefore = seamEvents.filter((event) => event === "reload:attach").length;
    // A TSWoW module command typed while the fresh VM loads: the unmount has dropped it, and EnterWorld
    // brackets its own mounts with beginModuleCommandLoad so chat says «still loading», not «unknown».
    game.world = { emotes: { emotes: [] }, pushLocalMessage: (message) => messages.push(message.text), sendChat() {} };
    const attach = reloading.attach;
    reloading.attach = function (...args) {
      chat.submitChat("/reloadprobe");
      duringReload = messages.at(-1);
      return attach.apply(this, args);
    };
    // The stock TOO_MANY_LUA_ERRORS accept button: `DisableAllAddOns(); ReloadUI();`
    const ran = boot.vm.execute("DisableAllAddOns(); ReloadUI(); ReloadUI()", "@lifecycle:reload");
    assert.equal(ran.ok, true, ran.error);
    assert.equal(seams.find((entry) => entry.seam === reloading && entry.closed), undefined,
      "the VM running the popup handler is not closed under it");
    const hostPublished = () => viewport.children.some((child) => child.id === "framexml-world-host"
      && child.style.visibility === "visible");
    assert.equal(hostPublished(), true, "the first mount is still published while Lua unwinds");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Wait for the complete remount (attach happens inside load; publication comes after it). Bounded
    // by time, not by a handful of polls: the 3.18 LoD preload runs between attach and publication,
    // and without a gateway its reads wait out a refused connection (≈1-2 s on Windows).
    for (let attempt = 0; attempt < 4000
      && !(seamEvents.filter((event) => event === "reload:attach").length > attachesBefore && hostPublished());
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(seamEvents.includes("reload:detach"), "the old mount was torn down");
    assert.equal(seamEvents.filter((event) => event === "reload:attach").length, attachesBefore + 1,
      "exactly one fresh mount attached, although ReloadUI ran twice");
    assert.equal(seams.filter((entry) => entry.seam === reloading).length, 2, "a second boot was created");
    assert.equal(seams.find((entry) => entry.seam === reloading)?.closed, true, "the first boot closed");
    assert.equal(body.classList.contains("framexml-world-replaces-native"), true,
      "the remounted HUD owns the native lanes again");
    assert.equal(viewport.children.filter((child) => child.id === "framexml-world-host").length, 1,
      "one host after the reload");
    assert.match(duringReload ?? "", /Аддоны ещё загружаются/,
      "a module command typed during the remount is reported as still loading");
    for (let attempt = 0; attempt < 100 && !messages.includes("Интерфейс перезагружен."); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(messages.includes("Интерфейс перезагружен."), messages.join(" | "));
    await new Promise((resolve) => setTimeout(resolve, 0));
    chat.submitChat("/reloadprobe");
    assert.match(messages.at(-1), /Неизвестная команда \/reloadprobe/, "the finished remount retires the bracket");
  } finally {
    game.world = previousWorld;
    unmountFrameXmlVertical();
  }
  // DisableAllAddOns covers the client add-on list of the mount that installed it.
  const vm = new (await import("../dist/code/browser/glue/GlueLua.js")).GlueLuaVm();
  let reloads = 0;
  try {
    installFrameXmlReloadUi(vm, ["AnyIDTooltip", "MikScrollingBattleText", "MSBTOptions"], () => { reloads += 1; });
    assert.equal(frameXmlClientAddonEnabled("MikScrollingBattleText"), true);
    assert.equal(vm.execute("DisableAllAddOns()", "@t").ok, true);
    assert.deepEqual([...frameXmlSessionDisabledClientAddons()].sort(),
      ["anyidtooltip", "mikscrollingbattletext", "msbtoptions"]);
    assert.equal(frameXmlClientAddonEnabled("mikScrollingBattleText"), false, "case-insensitive");
    assert.equal(frameXmlClientAddonEnabled("Blizzard_TimeManager"), true, "Blizzard add-ons are untouched");
    assert.equal(vm.execute("ReloadUI()", "@t").ok, true);
    assert.equal(reloads, 1);
  } finally {
    vm.close();
  }
});

test("a hovered world unit drives the stock GameTooltip through the engine calls", async () => {
  const { setHoveredTarget } = await import("../dist/code/browser/game/HoverTarget.js");
  const { result, boot } = await mountCapturingBoot({ viewport, seam: seam("mouseover") });
  const unitObject = { guid: 42n, typeId: 3 };
  const world = { state: { objects: new Map([[42n, unitObject]]) } };
  try {
    assert.equal(result.ok, true, result.message);
    assert.ok(boot, `the mount booted a VM: ${result.message}`);
    const setup = boot.vm.execute(`
      __calls = {}
      local function note(text) __calls[#__calls + 1] = text end
      UIParent = UIParent or { name = "UIParent" }
      GameTooltip = { shown = false }
      function GameTooltip:IsShown() return self.shown end
      function GameTooltip:IsOwned(frame) return self.owner == frame end
      function GameTooltip:SetUnit(unit) note("SetUnit:" .. unit); self.shown = true end
      function GameTooltip:FadeOut() note("FadeOut"); self.shown = false; self.owner = nil end
      function GameTooltip_SetDefaultAnchor(tooltip, parent) note("SetDefaultAnchor"); tooltip.owner = parent end
      function UnitExists(unit) if unit == "mouseover" then return 1 end end
    `, "@lifecycle:mouseover");
    assert.equal(setup.ok, true, setup.error);
    const calls = () => {
      boot.vm.execute("__joined = table.concat(__calls, ',')", "@t");
      return boot.vm.getGlobal("__joined");
    };
    game.world = world;
    setHoveredTarget(world, unitObject);
    runNewestFrame();
    assert.equal(calls(), "SetDefaultAnchor,SetUnit:mouseover", "hover-in anchors and fills the stock tooltip");
    runNewestFrame();
    assert.equal(calls(), "SetDefaultAnchor,SetUnit:mouseover", "a steady hover does not repeat SetUnit");
    setHoveredTarget(undefined, undefined);
    runNewestFrame();
    assert.equal(calls(), "SetDefaultAnchor,SetUnit:mouseover", "a throttle-length clear does not fade");
    await new Promise((resolve) => setTimeout(resolve, 120));
    runNewestFrame();
    assert.equal(calls(), "SetDefaultAnchor,SetUnit:mouseover,FadeOut", "a settled leave fades the world tooltip");
  } finally {
    setHoveredTarget(undefined, undefined);
    game.world = undefined;
    unmountFrameXmlVertical();
  }
});

test("full HUD (3.24): a pointerdown on a stock control lifts the overlay over the native windows; unmount drops the listener", async () => {
  const mounted = await mountFrameXmlVertical({ viewport, seam: seam("pointer-layer") });
  let host;
  try {
    assert.equal(mounted.ok, true, mounted.message);
    host = viewport.children.find((node) => node.id === "framexml-world-host");
    const layer = () => Number(host.style.zIndex || 0);
    assert.equal(layer(), 0, "at its stylesheet's z-index 3 until touched");
    host.dispatchEvent({ type: "pointerdown" });
    assert.equal(layer() > 30, true, "the stock window touched last is over the native ones (31 and up)");
  } finally {
    unmountFrameXmlVertical();
  }
  host.style.zIndex = "";
  host.dispatchEvent({ type: "pointerdown" });
  assert.equal(Number(host.style.zIndex || 0), 0, "no listener after unmount");
});

test("3.18/3.24 review: the LoD preload runs in the mount's own loading window, never after the HUD is shown", async () => {
  // Measured (review A2-3, Node, real corpus): Blizzard_TrainerUI.lua executes as one 11-18 ms block
  // and MSBTOptionsPopups.lua as one 24 ms block. No idle slice at 144 Hz (13.9 ms frame) fits an
  // indivisible file, so an idle preload after the reveal hitched live play; the mount's pending
  // phase is already a sliced loading window (2.6 s in Node), like the stock clock's add-on.
  const previousLoadAddon = FrameXmlBoot.prototype.loadAddon;
  const calls = [];
  FrameXmlBoot.prototype.loadAddon = async function recordLoad(name) {
    const host = viewport.children.find((node) => node.id === "framexml-world-host");
    calls.push({ name, visibility: host?.style.visibility ?? "absent" });
    return { ok: true, addon: name, status: "loaded", dependencies: [], loaded: [], roots: [] };
  };
  try {
    const mounted = await mountFrameXmlVertical({ viewport, seam: seam("lod-preload") });
    assert.equal(mounted.ok, true, mounted.message);
    const preloaded = calls.filter((call) => call.name === "Blizzard_TrainerUI");
    assert.equal(preloaded.length, 1, "the trainer is in before the mount resolves");
    assert.deepEqual(calls.filter((call) => call.visibility === "visible").map((call) => call.name), [],
      "no add-on is loaded while the published HUD is on screen");
  } finally {
    FrameXmlBoot.prototype.loadAddon = previousLoadAddon;
    unmountFrameXmlVertical();
  }
});
