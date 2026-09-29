import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

// A closed window's portrait (the paper doll, the CharacterFrame bust) is neither rebuilt nor drawn:
// every look change used to rebuild both with the character window shut. The renderer half is driven
// over a recording renderer; the host half (ui/Portraits.ts) over the same DOM stand-in the adoption
// tests use, with `closest` for the native window's `hidden` attribute.

function fakeStyle() {
  return {
    setProperty(name, value) { this[name] = String(value); },
    removeProperty(name) { delete this[name]; },
  };
}

function fakeNode(tag) {
  const node = {
    tagName: tag.toUpperCase(), children: [], parentElement: undefined, parentNode: undefined,
    style: fakeStyle(), hidden: false, className: "", dataset: {}, width: 0, height: 0,
    get nextSibling() {
      const siblings = node.parentElement?.children ?? [];
      const index = siblings.indexOf(node);
      return index >= 0 ? siblings[index + 1] ?? null : null;
    },
    append(...children) {
      for (const child of children) {
        child.parentElement = node;
        child.parentNode = node;
        node.children.push(child);
      }
    },
    insertBefore(child, before) {
      child.parentElement?.removeChild(child);
      const index = node.children.indexOf(before);
      child.parentElement = node;
      child.parentNode = node;
      if (index < 0) node.children.push(child);
      else node.children.splice(index, 0, child);
    },
    removeChild(child) {
      const index = node.children.indexOf(child);
      if (index >= 0) node.children.splice(index, 1);
      if (child.parentElement === node) child.parentElement = undefined;
      if (child.parentNode === node) child.parentNode = undefined;
    },
    remove() { node.parentElement?.removeChild(node); },
    querySelector(selector) {
      // Dom.ts looks up the login form's submit button when it loads.
      if (selector === 'button[type="submit"]') return fakeNode("button");
      if (!selector.startsWith("canvas[data-portrait-slot=\"")) return null;
      const slot = selector.slice('canvas[data-portrait-slot="'.length, -2);
      return node.children.find((child) => child.tagName === "CANVAS" && child.dataset.portraitSlot === slot);
    },
    querySelectorAll() { return []; },
    closest(selector) {
      assert.equal(selector, "[hidden]", "the native probe asks only for the hidden attribute");
      for (let at = node; at; at = at.parentElement) if (at.hidden) return at;
      return null;
    },
    isConnected: true,
    addEventListener() {},
    removeEventListener() {},
    setAttribute(name, value) { node[name] = String(value); },
    getAttribute(name) { return node[name] ?? null; },
    getContext() { return { clearRect() {} }; },
  };
  return node;
}

const elements = new Map();
const document = {
  createElement: (tag) => fakeNode(tag),
  querySelectorAll: () => [],
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, fakeNode("div"));
    return elements.get(id);
  },
};
document.head = fakeNode("head");
for (const id of ["player-icon", "target-icon"]) {
  const host = fakeNode("div");
  const icon = fakeNode("img");
  host.append(icon);
  elements.set(id, icon);
}
globalThis.document = document;
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.window = { devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768, addEventListener() {},
  removeEventListener() {}, localStorage: undefined };

const { PortraitRenderer } = await import("../dist/code/browser/PortraitRenderer.js");
const {
  adoptCharacterFramePortraitCanvas, adoptCharacterPortraitCanvas, mountNativeCharacterPortrait,
  syncPortraitTargets,
} = await import("../dist/code/browser/ui/Portraits.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { frameXmlCharacterModelGate } = await import("../dist/code/browser/framexml/FrameXmlCharacterController.js");

function canvas(width = 4, height = 4) {
  const value = { width, height, dataset: {}, image: undefined };
  const context = {
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(image) { value.image = image; },
    clearRect() { value.image = undefined; },
  };
  value.getContext = () => context;
  return value;
}

/** Counts what a portrait costs: skinned instances built, scene renders and readbacks. */
function recordingRenderer() {
  const state = { renders: 0, reads: 0, target: null };
  const renderer = {
    extensions: { has: () => true },
    properties: { get: () => undefined },
    getRenderTarget: () => state.target,
    setRenderTarget(value) { state.target = value; },
    getViewport: (value) => value,
    setViewport() {},
    getScissor: (value) => value,
    setScissor() {},
    getScissorTest: () => false,
    setScissorTest() {},
    getClearColor: (value) => value,
    setClearColor() {},
    getClearAlpha: () => 0,
    clear() {},
    autoClear: true,
    render() { state.renders++; },
    compile: () => new Set(),
    async readRenderTargetPixelsAsync() { state.reads++; },
  };
  return { renderer, state };
}

function rigged(key) {
  return {
    key, buildKey: key,
    model: {
      bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 2], radius: 1 }, attachments: [],
      portraitCamera: { fov: Math.PI / 4, near: 0.1, far: 20, position: [2, 0, 1], target: [0, 0, 1] },
    },
    built: { geometry: new THREE.BoxGeometry(1, 1, 1), materials: [new THREE.MeshBasicMaterial()],
      height: 2, texturePaths: [], ownedTextures: [] },
    template: {
      geometry: new THREE.BufferGeometry(), clips: new Map(), animations: new Set([1]),
      boneInverses: [new THREE.Matrix4()], parents: new Int16Array([-1]), pivots: new Float32Array([0, 0, 0]),
      flags: new Uint16Array([0]), billboards: [], height: 2,
    },
    scale: 1,
  };
}

test("a hidden paper doll is neither rebuilt nor drawn; shown again it paints once, with the new look", async () => {
  const { renderer, state } = recordingRenderer();
  let source = rigged("look-a");
  let built = 0;
  const view = new PortraitRenderer(renderer, () => { built++; return source; });
  const output = canvas(4, 4);
  const guid = 1n;
  view.setTargets(new Map([["paperdoll", { guid, canvas: output, visible: false }]]));
  assert.equal(view.render(0), 0);
  assert.equal(state.renders, 0, "nothing drawn for a closed window");
  assert.equal(built, 0, "not even the source is resolved");
  assert.equal(view.needsPose(guid), false, "the world unit keeps its flat pose");
  assert.equal(view.targetGuids().has(guid), false, "and a closed window pins no unit into admission");

  source = rigged("look-b"); // an equip while the window is closed
  for (let frame = 1; frame < 20; frame++) assert.equal(view.render(frame), 0);
  assert.equal(state.renders, 0);

  view.setTargets(new Map([["paperdoll", { guid, canvas: output, visible: true }]]));
  assert.equal(view.targetGuids().has(guid), true);
  assert.equal(view.needsPose(guid), true, "shown with a stale surface: one pose step for the snapshot");
  assert.equal(view.render(20), 1, "painted once on the first frame it shows");
  assert.equal(state.renders, 1);
  await Promise.resolve();
  assert.equal(view.needsPose(guid), false);
  for (let frame = 21; frame < 30; frame++) assert.equal(view.render(frame), 0, "and not again");
  view.dispose();
});

test("hiding keeps the painted surface; it repaints on show only when its look moved meanwhile", async () => {
  const { renderer, state } = recordingRenderer();
  let source = rigged("look-a");
  const view = new PortraitRenderer(renderer, () => source);
  const output = canvas(4, 4);
  const targets = (visible) => new Map([["character", { guid: 7n, canvas: output, visible }]]);
  view.setTargets(targets(true));
  assert.equal(view.render(0), 1);
  await Promise.resolve();
  assert.equal(output.dataset.portraitReady, "true");

  view.setTargets(targets(false));
  assert.equal(view.render(1), 0);
  assert.equal(output.dataset.portraitReady, "true", "hiding does not blank the last picture");
  view.setTargets(targets(true));
  assert.equal(view.render(2), 0, "the same look shown again costs nothing");

  view.setTargets(targets(false));
  source = rigged("look-b");
  assert.equal(view.render(3), 0);
  view.setTargets(targets(true));
  assert.equal(view.render(4), 1, "the look that moved while hidden is painted on show");
  assert.equal(state.renders, 2);
  view.dispose();
});

test("the player's own HUD row painted, a stale hidden paper doll does not keep the world pose busy", async () => {
  // The live shape: one GUID in the always-shown PlayerFrame slot and in the closed paper doll.
  const { renderer } = recordingRenderer();
  const source = rigged("look-a");
  const view = new PortraitRenderer(renderer, () => source);
  const guid = 1n;
  view.setTargets(new Map([
    ["player", { guid, canvas: canvas() }],
    ["paperdoll", { guid, canvas: canvas(), visible: false }],
  ]));
  assert.equal(view.render(0), 1, "only the HUD row paints");
  await Promise.resolve();
  assert.equal(view.needsPose(guid), false,
    "a painted HUD row and a hidden, never-painted paper doll ask the world for no pose step");
  view.dispose();
});

test("targets without a visibility say keep painting: the HUD's player and target rows", () => {
  const { renderer, state } = recordingRenderer();
  const view = new PortraitRenderer(renderer, () => rigged("look-a"));
  view.setTargets(new Map([["player", { guid: 1n, canvas: canvas() }], ["target", { guid: 2n, canvas: canvas() }]]));
  assert.equal(view.render(0), 2);
  assert.equal(state.renders, 2);
  assert.equal(view.targetGuids().size, 2);
  view.dispose();
});

test("the host samples each closable window's probe into its target once a frame", () => {
  const previousWorld = game.world;
  game.world = { state: { selfGuid: 0x10n, objects: new Map() } };
  const snapshots = [];
  const sync = () => {
    syncPortraitTargets({ setPortraitTargets(targets) { snapshots.push(new Map(targets)); } });
    return snapshots.at(-1);
  };
  const model = fakeNode("div");
  model.setAttribute("data-framexml-model-placeholder", "true");
  const headerFrame = fakeNode("div");
  const header = fakeNode("img");
  headerFrame.append(header);
  let characterShown = false;
  let paperDollCleanup;
  let headerCleanup;
  try {
    paperDollCleanup = adoptCharacterPortraitCanvas(model, 233, 215, () => characterShown);
    headerCleanup = adoptCharacterFramePortraitCanvas(header, () => characterShown);
    let targets = sync();
    assert.equal(targets.get("paperdoll").guid, 0x10n);
    assert.equal(targets.get("paperdoll").visible, false, "CharacterFrame closed: the paper doll is hidden");
    assert.equal(targets.get("character").visible, false, "and so is the bust");
    const hidden = targets.get("paperdoll");
    assert.equal(sync().get("paperdoll"), hidden, "an unchanged answer keeps the same target object");
    characterShown = true;
    targets = sync();
    assert.notEqual(targets.get("paperdoll").visible, false, "opened: shown");
    assert.notEqual(targets.get("character").visible, false);
    assert.equal(targets.get("player")?.visible, undefined, "the HUD rows carry no probe");
  } finally {
    headerCleanup?.();
    paperDollCleanup?.();
    game.world = previousWorld;
  }
  characterShown = false;
  const after = sync();
  assert.equal(after.get("paperdoll").guid, undefined, "cleanup releases the slot");
  assert.equal(after.get("paperdoll").visible, undefined, "and its probe: nothing samples a released window");
  assert.equal(after.get("character").visible, undefined);
});

test("the native character window is shown exactly while no ancestor carries `hidden`", () => {
  const previousWorld = game.world;
  game.world = { state: { selfGuid: 0x10n, objects: new Map() } };
  const windowElement = fakeNode("section");
  const model = fakeNode("div");
  model.setAttribute("data-portrait-model-placeholder", "true");
  windowElement.append(model);
  windowElement.hidden = true;
  const snapshots = [];
  const sync = () => {
    syncPortraitTargets({ setPortraitTargets(targets) { snapshots.push(new Map(targets)); } });
    return snapshots.at(-1).get("paperdoll");
  };
  let cleanup;
  try {
    cleanup = mountNativeCharacterPortrait(model);
    assert.equal(typeof cleanup, "function");
    assert.equal(sync().visible, false, "the closed native window's model is not drawn");
    windowElement.hidden = false;
    assert.notEqual(sync().visible, false);
    model.isConnected = false;
    assert.equal(sync().visible, false, "a detached model is not on screen either");
  } finally {
    cleanup?.();
    game.world = previousWorld;
  }
});

test("the CharacterFrame gate hands stock IsVisible of its model and bust to the two outputs", () => {
  const frames = new Map();
  const frame = (name, type, parent, scripts = []) => {
    const value = { name, type, parent, children: [], visible: false, scripts: new Set(scripts), model: { calls: [] } };
    parent?.children.push(value);
    frames.set(name, value);
    return value;
  };
  const character = frame("CharacterFrame", "Frame");
  const portrait = frame("CharacterFramePortrait", "Texture", character);
  const paper = frame("PaperDollFrame", "Frame", character, ["OnLoad", "OnEvent", "OnShow", "OnHide"]);
  const model = frame("CharacterModelFrame", "PlayerModel", paper);
  const attributes = frame("CharacterAttributesFrame", "Frame", paper);
  const slots = ["Head", "Neck", "Shoulder", "Back", "Chest", "Shirt", "Tabard", "Wrist", "Hands", "Waist",
    "Legs", "Feet", "Finger0", "Finger1", "Trinket0", "Trinket1", "MainHand", "SecondaryHand", "Ranged"]
    .map((slot) => frame(`Character${slot}Slot`, "Button", paper, ["OnLoad", "OnClick"]));
  const stats = ["Left", "Right"].flatMap((side) => [1, 2, 3, 4, 5, 6]
    .map((row) => frame(`PlayerStatFrame${side}${row}`, "Frame", attributes, ["OnEnter", "OnLeave"])));
  const elements = new Map();
  const element = (value, parentElement, placeholder = false) => {
    const node = fakeNode("div");
    node.setAttribute("data-framexml-name", value.name);
    node.setAttribute("data-framexml-type", value.type);
    if (placeholder) node.setAttribute("data-framexml-model-placeholder", "true");
    parentElement?.append(node);
    elements.set(value, node);
    return node;
  };
  const characterElement = element(character);
  element(portrait, characterElement);
  const paperElement = element(paper, characterElement);
  element(model, paperElement, true);
  const attributesElement = element(attributes, paperElement);
  for (const slot of slots) element(slot, paperElement);
  for (const stat of stats) element(stat, attributesElement);
  const bridge = {
    getFrame: (name) => frames.get(name),
    hasScript: (value, script) => value.scripts.has(script),
    // FrameXmlUiBridge.isVisible: shown, and every ancestor shown.
    isVisible(value) {
      for (let at = value; at; at = at.parent) if (!at.visible) return false;
      return true;
    },
  };
  const previousWorld = game.world;
  game.world = { state: { selfGuid: 0x10n, objects: new Map() } };
  const gate = frameXmlCharacterModelGate({ bridge }, { elementFor: (value) => elements.get(value) });
  assert.ok(gate, "the stock tree passes the gate");
  let targets;
  const sync = () => syncPortraitTargets({ setPortraitTargets(value) { targets = new Map(value); } });
  try {
    for (const value of frames.values()) value.visible = true;
    character.visible = false;
    sync();
    assert.equal(targets.get("paperdoll").visible, false, "CharacterFrame closed: its model is hidden");
    assert.equal(targets.get("character").visible, false, "and its bust");
    character.visible = true;
    sync();
    assert.notEqual(targets.get("paperdoll").visible, false);
    assert.notEqual(targets.get("character").visible, false);
    paper.visible = false; // the reputation tab: the bust stays, the paper doll goes
    sync();
    assert.equal(targets.get("paperdoll").visible, false);
    assert.notEqual(targets.get("character").visible, false);
  } finally {
    gate.portraitCleanup();
    game.world = previousWorld;
  }
});

test("a probe that throws leaves its target shown, the behaviour before probes", () => {
  const previousWorld = game.world;
  game.world = { state: { selfGuid: 0x10n, objects: new Map() } };
  const model = fakeNode("div");
  model.setAttribute("data-framexml-model-placeholder", "true");
  let cleanup;
  try {
    cleanup = adoptCharacterPortraitCanvas(model, 233, 215, () => { throw new Error("no bridge"); });
    let target;
    syncPortraitTargets({ setPortraitTargets(targets) { target = targets.get("paperdoll"); } });
    assert.notEqual(target.visible, false);
  } finally {
    cleanup?.();
    game.world = previousWorld;
  }
});
