import assert from "node:assert/strict";
import test from "node:test";

// The controller itself is DOM-free; Portraits is only imported for its optional structural gate.
// Keep the bootstrap fixture intentionally tiny so ownership tests do not need a browser.
const elements = new Map();
const makeElement = () => ({
  value: "",
  hidden: true,
  parentElement: undefined,
  parentNode: undefined,
  dataset: {},
  className: "",
  style: {},
  width: 0,
  height: 0,
  children: [],
  remove() {},
  append(child) { child.parentElement = this; child.parentNode = this; this.children.push(child); },
  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    child.parentElement = this;
    child.parentNode = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
  },
  querySelector(selector) {
    return selector === 'button[type="submit"]' ? makeElement() : undefined;
  },
});
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  },
  createElement() { return makeElement(); },
  querySelectorAll() { return []; },
};
globalThis.window = {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
};

const {
  closeFrameXmlCharacter,
  frameXmlCharacterModelGate,
  frameXmlCharacterOpen,
  publishFrameXmlCharacter,
  toggleFrameXmlCharacter,
} = await import("../dist/code/browser/framexml/FrameXmlCharacterController.js");

function frame(name, type, parent, scripts = [], calls = [{ method: "SetRotation", args: [] }]) {
  const value = {
    name, type, parent, children: [], visible: false,
    scripts: new Map(scripts.map((script) => [script, () => {}])),
    model: { file: "", scale: 1, calls },
  };
  parent?.children.push(value);
  return value;
}

function rendered(elementParent, name, type, placeholder = false) {
  const attributes = new Map([
    ["data-framexml-name", name], ["data-framexml-type", type],
  ]);
  if (placeholder) attributes.set("data-framexml-model-placeholder", "true");
  const value = {
    parentElement: elementParent,
    children: [],
    dataset: {},
    style: {},
    className: "",
    hidden: false,
    width: 0,
    height: 0,
    getAttribute(attribute) { return attributes.get(attribute) ?? null; },
    querySelector(selector) {
      if (selector.startsWith('canvas[data-portrait-slot="')) {
        const slot = selector.slice('canvas[data-portrait-slot="'.length, -2);
        return value.children.find((child) => child.tagName === "CANVAS"
          && child.dataset?.portraitSlot === slot);
      }
      return undefined;
    },
    append(child) { child.parentElement = value; value.children.push(child); },
    insertBefore(child, before) {
      const index = value.children.indexOf(before);
      child.parentElement = value;
      if (index < 0) value.children.push(child);
      else value.children.splice(index, 0, child);
    },
    remove() {},
  };
  return value;
}

test("character model gate accepts the stock blank model state but fails closed without its placeholder", () => {
  const character = frame("CharacterFrame", "Frame");
  const characterPortrait = frame("CharacterFramePortrait", "Texture", character);
  const paper = frame("PaperDollFrame", "Frame", character, ["OnLoad", "OnEvent", "OnShow", "OnHide"]);
  const model = frame("CharacterModelFrame", "PlayerModel", paper);
  const attributes = frame("CharacterAttributesFrame", "Frame", paper);
  const equipment = [
    "CharacterHeadSlot", "CharacterNeckSlot", "CharacterShoulderSlot", "CharacterBackSlot",
    "CharacterChestSlot", "CharacterShirtSlot", "CharacterTabardSlot", "CharacterWristSlot",
    "CharacterHandsSlot", "CharacterWaistSlot", "CharacterLegsSlot", "CharacterFeetSlot",
    "CharacterFinger0Slot", "CharacterFinger1Slot", "CharacterTrinket0Slot",
    "CharacterTrinket1Slot", "CharacterMainHandSlot", "CharacterSecondaryHandSlot",
    "CharacterRangedSlot",
  ].map((name) => frame(name, "Button", paper, ["OnLoad", "OnClick"]));
  const stats = [
    "PlayerStatFrameLeft1", "PlayerStatFrameLeft2", "PlayerStatFrameLeft3",
    "PlayerStatFrameLeft4", "PlayerStatFrameLeft5", "PlayerStatFrameLeft6",
    "PlayerStatFrameRight1", "PlayerStatFrameRight2", "PlayerStatFrameRight3",
    "PlayerStatFrameRight4", "PlayerStatFrameRight5", "PlayerStatFrameRight6",
  ].map((name) => frame(name, "Frame", attributes, ["OnEnter", "OnLeave"]));
  const frames = new Map([character, characterPortrait, paper, model, attributes, ...equipment, ...stats]
    .map((value) => [value.name, value]));
  const characterElement = rendered(undefined, character.name, character.type);
  const characterPortraitElement = rendered(characterElement, characterPortrait.name, characterPortrait.type);
  const paperElement = rendered(characterElement, paper.name, paper.type);
  const modelElement = rendered(paperElement, model.name, model.type, true);
  const attributesElement = rendered(paperElement, attributes.name, attributes.type);
  const elements = new Map([
    [character, characterElement], [characterPortrait, characterPortraitElement],
    [paper, paperElement], [model, modelElement],
    [attributes, attributesElement],
    ...equipment.map((value) => [value, rendered(paperElement, value.name, value.type)]),
    ...stats.map((value) => [value, rendered(attributesElement, value.name, value.type)]),
  ]);
  const boot = {
    bridge: {
      getFrame(name) { return frames.get(name); },
      hasScript(value, script) { return value.scripts.has(script); },
    },
  };
  const renderer = { elementFor(value) { return elements.get(value); } };
  // The real MPQ bridge leaves PlayerModel.model.file and model.calls empty. That state is
  // expected: this path paints the shared world model into the adopted placeholder canvas.
  model.model.calls = [];
  const gate = frameXmlCharacterModelGate(boot, renderer);
  assert.ok(gate, "a complete stock tree is adoptable even with blank model source state");
  gate.portraitCleanup();
  elements.set(model, rendered(paperElement, model.name, model.type, false));
  assert.equal(frameXmlCharacterModelGate(boot, renderer), undefined,
    "a model DOM without the adopted placeholder must not publish over the native sheet");
});

test("character owner routes toggle/close and stale cleanup cannot clear a replacement", () => {
  let open = false;
  let shows = 0;
  let hides = 0;
  const first = {
    isOpen: () => open,
    show: () => { open = true; shows += 1; },
    hide: () => { open = false; hides += 1; },
  };
  const cleanupFirst = publishFrameXmlCharacter(first);
  assert.equal(frameXmlCharacterOpen(), false);
  assert.equal(toggleFrameXmlCharacter(), true);
  assert.equal(open, true);
  assert.equal(shows, 1);
  assert.equal(closeFrameXmlCharacter(), true);
  assert.equal(open, false);
  assert.equal(hides, 1);

  const second = {
    isOpen: () => true,
    show() {},
    hide() { hides += 1; },
  };
  const cleanupSecond = publishFrameXmlCharacter(second);
  cleanupFirst();
  assert.equal(frameXmlCharacterOpen(), true, "an old mount cleanup must not clear a newer owner");
  cleanupSecond();
  cleanupSecond();
  assert.equal(frameXmlCharacterOpen(), false);
});

test("bridge failure demotes character ownership and invokes the fail-closed callback", () => {
  let failures = 0;
  let disposed = 0;
  const owner = {
    isOpen: () => false,
    show: () => { throw new Error("bridge diagnostic"); },
    hide() {},
    dispose: () => { disposed += 1; },
    onFailure: () => { failures += 1; },
  };
  publishFrameXmlCharacter(owner);
  assert.equal(toggleFrameXmlCharacter(), false);
  assert.equal(frameXmlCharacterOpen(), false);
  assert.equal(failures, 1);
  assert.equal(disposed, 1);
});
