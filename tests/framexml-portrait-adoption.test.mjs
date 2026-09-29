import assert from "node:assert/strict";
import test from "node:test";

function fakeStyle() {
  const values = { cssText: "" };
  return {
    setProperty(name, value) { values[name] = String(value); this[name] = String(value); },
    removeProperty(name) { delete values[name]; delete this[name]; },
    get cssText() { return values.cssText; },
    set cssText(value) { values.cssText = String(value); },
  };
}

function fakeNode(tag, document) {
  const classes = new Set();
  const node = {
    ownerDocument: document,
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: undefined,
    parentNode: undefined,
    style: fakeStyle(),
    hidden: false,
    className: "",
    dataset: {},
    value: "",
    disabled: false,
    width: 0,
    height: 0,
    get nextSibling() {
      const siblings = node.parentElement?.children ?? [];
      const index = siblings.indexOf(node);
      return index >= 0 ? siblings[index + 1] ?? null : null;
    },
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    append(...children) {
      for (const child of children) {
        child.parentElement = node;
        child.parentNode = node;
        node.children.push(child);
      }
    },
    insertBefore(child, before) {
      if (child.parentElement) child.parentElement.removeChild(child);
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
    remove() {
      node.parentElement?.removeChild(node);
    },
    querySelector(selector) {
      if (selector.startsWith("canvas[data-portrait-slot=\"")) {
        const slot = selector.slice('canvas[data-portrait-slot="'.length, -2);
        const direct = node.children.find((child) => child.tagName === "CANVAS"
          && child.dataset.portraitSlot === slot);
        if (direct) return direct;
        for (const child of node.children) {
          const nested = child.querySelector?.(selector);
          if (nested) return nested;
        }
        return undefined;
      }
      if (selector === 'button[type="submit"]') return fakeNode("button", document);
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(name, value) { node[name] = String(value); },
    getAttribute(name) { return node[name] ?? null; },
    removeAttribute(name) { delete node[name]; },
    getContext() { return { clearRect() {} }; },
  };
  return node;
}

const elements = new Map();
let document;
document = {
  createElement(tag) { return fakeNode(tag, document); },
  querySelectorAll() { return []; },
  head: undefined,
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, fakeNode("div", document));
    return elements.get(id);
  },
};
document.head = fakeNode("head", document);

const nativeHost = fakeNode("div", document);
const playerIcon = fakeNode("img", document);
playerIcon.id = "player-icon";
nativeHost.append(playerIcon);
elements.set("player-icon", playerIcon);
const targetIcon = fakeNode("img", document);
const targetHost = fakeNode("div", document);
targetHost.append(targetIcon);
elements.set("target-icon", targetIcon);
elements.set("target-panel", fakeNode("div", document));
const nativePetHost = fakeNode("div", document);
const nativePetFrame = fakeNode("button", document);
const nativePetCanvas = fakeNode("canvas", document);
nativePetCanvas.className = "native-pet-portrait";
nativePetCanvas.dataset.portraitSlot = "pet";
nativePetCanvas.dataset.portraitReady = "native-state";
nativePetCanvas.hidden = true;
nativePetFrame.append(nativePetCanvas);
nativePetHost.append(nativePetFrame);
elements.set("pet-frame", nativePetHost);
const nativeFocusHost = fakeNode("div", document);
const nativeFocusCanvas = fakeNode("canvas", document);
nativeFocusCanvas.className = "native-focus-portrait";
nativeFocusCanvas.dataset.portraitSlot = "focus";
nativeFocusCanvas.dataset.portraitReady = "native-state";
nativeFocusHost.append(nativeFocusCanvas);
elements.set("focus-frame", nativeFocusHost);
const nativeTotHost = fakeNode("div", document);
const nativeTotCanvas = fakeNode("canvas", document);
nativeTotCanvas.className = "native-tot-portrait";
nativeTotCanvas.dataset.portraitSlot = "tot";
nativeTotCanvas.dataset.portraitReady = "native-state";
nativeTotHost.append(nativeTotCanvas);
elements.set("tot-frame", nativeTotHost);
const nativePartyHost = fakeNode("div", document);
const nativePartyRows = [];
for (let index = 1; index <= 4; index += 1) {
  const row = fakeNode("button", document);
  const canvas = fakeNode("canvas", document);
  canvas.className = `native-party-${index}-portrait`;
  canvas.dataset.portraitSlot = `party${index}`;
  canvas.dataset.portraitReady = "native-state";
  canvas.hidden = true;
  row.append(canvas);
  nativePartyHost.append(row);
  nativePartyRows.push({ row, canvas });
}
elements.set("party-frames", nativePartyHost);

globalThis.document = document;
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.window = {
  devicePixelRatio: 2,
  innerWidth: 1024,
  innerHeight: 768,
  addEventListener() {},
  removeEventListener() {},
  localStorage: undefined,
};

const {
  adoptFocusPortraitCanvas, adoptPartyPortraitCanvas, adoptPetPortraitCanvas,
  adoptPlayerPortraitCanvas, adoptTargetOfTargetPortraitCanvas, adoptTargetPortraitCanvas,
  adoptCharacterPortraitCanvas, characterPortraitCanvas,
  adoptQuestGiverPortraitCanvas, setQuestGiverPortrait, adoptFocusTargetPortraitCanvas,
  clearPortraitTargets, portraitCanvases, setPartyPortrait, syncPortraitTargets,
} =
  await import("../dist/code/browser/ui/Portraits.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function styleSnapshot(canvas) {
  return Object.fromEntries(["display", "position", "left", "right", "top", "bottom", "width",
    "height", "transform", "transformOrigin", "zIndex", "opacity", "pointerEvents"]
    .map((name) => [name, canvas.style[name] ?? ""]));
}

test("returning the player portrait to an equally sized native slot preserves its painted pixels", () => {
  const canvas = portraitCanvases().get("player");
  const previous = { width: canvas.width, height: canvas.height, ready: canvas.dataset.portraitReady };
  let pixels = true;
  let width = canvas.width;
  let height = canvas.height;
  Object.defineProperties(canvas, {
    width: { configurable: true, get: () => width, set: (value) => { width = value; pixels = false; } },
    height: { configurable: true, get: () => height, set: (value) => { height = value; pixels = false; } },
  });
  const frame = fakeNode("div", document);
  const target = fakeNode("img", document);
  target.style.width = `${width / window.devicePixelRatio}px`;
  target.style.height = `${height / window.devicePixelRatio}px`;
  frame.append(target);
  let cleanup;
  try {
    canvas.dataset.portraitReady = "true";
    cleanup = adoptPlayerPortraitCanvas(target);
    assert.equal(pixels, true, "moving the canvas at the same dimensions does not reset it");
    cleanup();
    assert.equal(pixels, true, "assigning canvas.width to its existing value still erases the image in a browser");
    assert.equal(canvas.dataset.portraitReady, "true", "a restored ready portrait must actually contain its pixels");
  } finally {
    cleanup?.();
    Object.defineProperties(canvas, {
      width: { configurable: true, writable: true, value: previous.width },
      height: { configurable: true, writable: true, value: previous.height },
    });
    canvas.dataset.portraitReady = previous.ready;
  }
});

test("adoption moves the renderer-owned canvas over PlayerPortrait and restores it exactly once", () => {
  const canvas = portraitCanvases().get("player");
  assert.ok(canvas, "the native portrait canvas exists");
  assert.equal(canvas.parentElement, nativeHost);
  const originalClass = canvas.className;
  const originalHidden = canvas.hidden;
  const originalDataset = { ...canvas.dataset };
  canvas.className = "native-portrait";
  canvas.hidden = true;
  canvas.style.position = "relative";
  canvas.style.left = "1px";
  canvas.style.top = "2px";
  canvas.style.width = "58px";
  canvas.style.height = "58px";
  canvas.style.transform = "rotate(3deg)";
  canvas.style.zIndex = "4";
  canvas.style.pointerEvents = "auto";
  canvas.dataset.portraitReady = "native-state";
  const originalStyle = styleSnapshot(canvas);
  const originalNext = playerIcon;

  const target = fakeNode("img", document);
  target.style.position = "absolute";
  target.style.left = "12px";
  target.style.right = "auto";
  target.style.top = "24px";
  target.style.bottom = "auto";
  target.style.width = "64px";
  target.style.height = "64px";
  target.style.transform = "translateX(-50%) rotate(-0.2rad)";
  target.style.transformOrigin = "center";
  target.style.zIndex = "307";
  target.style.opacity = "0.8";
  const frameHost = fakeNode("div", document);
  frameHost.append(target);

  const cleanup = adoptPlayerPortraitCanvas(target);
  assert.equal(typeof cleanup, "function", "a live FrameXML target returns cleanup");
  assert.equal(canvas.parentElement, frameHost, "the same canvas is reparented into the FrameXML slot");
  assert.equal(frameHost.children.filter((child) => child === canvas).length, 1);
  assert.equal(frameHost.children.indexOf(canvas) > frameHost.children.indexOf(target), true,
    "the canvas is painted after the authored blank texture");
  assert.equal(canvas.style.position, "absolute");
  assert.equal(canvas.style.left, "12px");
  assert.equal(canvas.style.top, "24px");
  assert.equal(canvas.style.width, "64px");
  assert.equal(canvas.style.height, "64px");
  assert.equal(canvas.style.transform, target.style.transform);
  assert.equal(canvas.style.zIndex, "307");
  assert.equal(canvas.style.pointerEvents, "none");
  assert.equal(canvas.width, 128, "the square backing store stays DPR-safe at the FrameXML size");
  assert.equal(canvas.height, 128);

  assert.equal(adoptPlayerPortraitCanvas(target), cleanup,
    "repeated adoption of one target is idempotent and does not duplicate the canvas");
  cleanup();
  cleanup();
  assert.equal(canvas.parentElement, nativeHost, "cleanup restores the native host");
  assert.deepEqual(nativeHost.children, [canvas, originalNext], "cleanup restores original sibling order");
  assert.equal(canvas.className, "native-portrait");
  assert.equal(canvas.hidden, true);
  assert.deepEqual(canvas.dataset, { ...originalDataset, portraitReady: "native-state" });
  assert.deepEqual(styleSnapshot(canvas), originalStyle, "cleanup restores every prior inline style");

  canvas.className = originalClass;
  canvas.hidden = originalHidden;
});

test("adoption gracefully skips a missing target or detached native canvas", () => {
  const canvas = portraitCanvases().get("player");
  assert.equal(adoptPlayerPortraitCanvas(undefined), undefined);
  const target = fakeNode("img", document);
  assert.equal(adoptPlayerPortraitCanvas(target), undefined);
  assert.equal(canvas.parentElement, nativeHost);
});

test("character model adoption creates one persistent paperdoll canvas and restores it idempotently", () => {
  const model = fakeNode("div");
  model.setAttribute("data-framexml-model-placeholder", "true");
  model.style.width = "233px";
  model.style.height = "215px";
  const cleanup = adoptCharacterPortraitCanvas(model);
  assert.equal(typeof cleanup, "function");
  const canvas = characterPortraitCanvas();
  assert.ok(canvas);
  assert.equal(canvas.parentElement, model);
  assert.equal(canvas.dataset.portraitSlot, "paperdoll");
  assert.equal(canvas.width, 466, "full-body backing store preserves stock authored width at DPR 2");
  assert.equal(canvas.height, 430, "full-body backing store preserves stock authored height at DPR 2");
  assert.equal(adoptCharacterPortraitCanvas(model), cleanup, "repeat adoption is identity-safe");
  cleanup();
  cleanup();
  assert.equal(characterPortraitCanvas(), undefined);
  assert.deepEqual(model.children, [], "a newly created canvas is removed on teardown");
});

test("QuestFrame portrait uses its own 60px canvas and the active giver GUID", () => {
  const frame = fakeNode("div", document);
  const texture = fakeNode("img", document);
  texture.style.position = "absolute";
  texture.style.left = "7px";
  texture.style.top = "6px";
  texture.style.width = "60px";
  texture.style.height = "60px";
  frame.append(texture);
  const guid = 0x712n;
  setQuestGiverPortrait(guid);
  const cleanup = adoptQuestGiverPortraitCanvas(texture);
  try {
    assert.equal(typeof cleanup, "function");
    const canvas = portraitCanvases().get("questnpc");
    assert.ok(canvas);
    assert.equal(canvas.parentElement, frame);
    assert.equal(frame.children.indexOf(canvas), frame.children.indexOf(texture) + 1,
      "rendered model paints over the stock book fallback");
    assert.equal(canvas.width, 120);
    assert.equal(canvas.height, 120);
    const snapshots = [];
    syncPortraitTargets({ setPortraitTargets(targets) { snapshots.push(new Map(targets)); } });
    assert.deepEqual(snapshots.at(-1).get("questnpc"), { guid, canvas });
    assert.notEqual(canvas, portraitCanvases().get("target"),
      "changing selection cannot move the quest giver portrait");
    setQuestGiverPortrait(undefined);
    syncPortraitTargets({ setPortraitTargets(targets) { snapshots.push(new Map(targets)); } });
    assert.equal(snapshots.at(-1).get("questnpc").guid, undefined);
    assert.equal(adoptQuestGiverPortraitCanvas(texture), cleanup);
  } finally {
    cleanup?.();
    setQuestGiverPortrait(undefined);
  }
  assert.deepEqual(frame.children, [texture]);
  assert.equal(portraitCanvases().has("questnpc"), false);
});

test("pet adoption reuses the UnitFrame canvas and restores the native slot exactly", () => {
  const originalStyles = styleSnapshot(nativePetCanvas);
  const originalDataset = { ...nativePetCanvas.dataset };
  const originalClass = nativePetCanvas.className;
  const originalHidden = nativePetCanvas.hidden;
  const originalParent = nativePetCanvas.parentElement;
  const target = fakeNode("img", document);
  target.style.position = "absolute";
  target.style.left = "17px";
  target.style.top = "23px";
  target.style.width = "37px";
  target.style.height = "37px";
  const frameHost = fakeNode("div", document);
  frameHost.append(target);

  const cleanup = adoptPetPortraitCanvas(target);
  assert.equal(typeof cleanup, "function", "the existing pet portrait canvas returns cleanup");
  assert.equal(nativePetCanvas.parentElement, frameHost, "the existing canvas is adopted");
  assert.equal(frameHost.children.filter((child) => child === nativePetCanvas).length, 1,
    "adoption does not create a second canvas");
  assert.equal(frameHost.children.indexOf(nativePetCanvas) > frameHost.children.indexOf(target), true,
    "the canvas is painted after the authored blank texture");
  assert.equal(nativePetCanvas.style.width, "37px");
  assert.equal(nativePetCanvas.style.height, "37px");
  assert.equal(nativePetCanvas.hidden, false, "a hidden native canvas is shown in its authored slot");
  assert.equal(adoptPetPortraitCanvas(target), cleanup,
    "repeated adoption of one pet target is idempotent");

  cleanup();
  cleanup();
  assert.equal(nativePetCanvas.parentElement, originalParent, "cleanup restores the UnitFrame canvas parent");
  assert.deepEqual(nativePetHost.children, [nativePetFrame], "cleanup restores the native pet frame");
  assert.deepEqual(nativePetFrame.children, [nativePetCanvas], "cleanup restores the native pet child order");
  assert.equal(nativePetCanvas.className, originalClass);
  assert.equal(nativePetCanvas.hidden, originalHidden);
  assert.deepEqual(nativePetCanvas.dataset, originalDataset);
  assert.deepEqual(styleSnapshot(nativePetCanvas), originalStyles,
    "cleanup restores every prior pet canvas inline style");
});

test("party adoption borrows four independent native canvases and restores each slot exactly", () => {
  const original = nativePartyRows.map(({ row, canvas }) => ({
    row,
    canvas,
    parent: canvas.parentElement,
    order: [...row.children],
    styles: styleSnapshot(canvas),
    className: canvas.className,
    hidden: canvas.hidden,
    dataset: { ...canvas.dataset },
    width: canvas.width,
    height: canvas.height,
  }));
  const targets = original.map(({ row }, index) => {
    const target = fakeNode("img", document);
    target.style.position = "absolute";
    target.style.left = `${index * 9}px`;
    target.style.top = `${index * 3}px`;
    target.style.width = "37px";
    target.style.height = "37px";
    const host = fakeNode("div", document);
    host.append(target);
    return { target, host, row };
  });

  const cleanups = targets.map(({ target }, index) => adoptPartyPortraitCanvas(index, target));
  assert.ok(cleanups.every((cleanup) => typeof cleanup === "function"),
    "all four party slots must return an adoption cleanup");
  assert.equal(new Set(original.map(({ canvas }) => canvas)).size, 4,
    "the native party rows own four distinct canvases");
  for (const [{ canvas }, { target, host }, index] of targets.map((target, index) => [original[index], target, index])) {
    assert.equal(canvas.parentElement, host, `party${index + 1} canvas is adopted into its stock target`);
    assert.equal(host.children.filter((child) => child === canvas).length, 1,
      `party${index + 1} adoption does not create a second canvas`);
    assert.equal(canvas.hidden, false, `party${index + 1} canvas is visible in its authored slot`);
    assert.equal(adoptPartyPortraitCanvas(index, target), cleanups[index],
      `party${index + 1} adoption is idempotent`);
  }

  cleanups.forEach((cleanup) => cleanup());
  cleanups.forEach((cleanup) => cleanup());
  for (const entry of original) {
    assert.equal(entry.canvas.parentElement, entry.parent, `${entry.canvas.className} parent restored`);
    assert.deepEqual(entry.row.children, entry.order, `${entry.canvas.className} order restored`);
    assert.equal(entry.canvas.className, entry.className);
    assert.equal(entry.canvas.hidden, entry.hidden);
    assert.deepEqual(entry.canvas.dataset, entry.dataset);
    assert.deepEqual(styleSnapshot(entry.canvas), entry.styles);
    assert.equal(entry.canvas.width, entry.width);
    assert.equal(entry.canvas.height, entry.height);
  }
});

test("party portrait slots retarget GUIDs on reorder without replacing canvases", () => {
  const frames = nativePartyRows.map(({ canvas }, index) => ({
    guid: BigInt(index + 1), portraitCanvas: canvas,
  }));
  const snapshots = [];
  const renderer = {
    setPortraitTargets(targets) {
      snapshots.push(new Map(targets));
    },
  };
  frames.forEach((frame, index) => setPartyPortrait(index, frame));
  syncPortraitTargets(renderer);
  const first = snapshots.at(-1);
  assert.equal(first.get("party1").guid, 1n);
  assert.equal(first.get("party4").guid, 4n);
  assert.equal(first.get("party1").canvas, nativePartyRows[0].canvas);

  const reordered = frames.map((frame, index) => ({
    guid: BigInt(4 - index), portraitCanvas: frame.portraitCanvas,
  }));
  reordered.forEach((frame, index) => setPartyPortrait(index, frame));
  syncPortraitTargets(renderer);
  const second = snapshots.at(-1);
  assert.equal(second.get("party1").guid, 4n, "party1 follows the reordered unit GUID");
  assert.equal(second.get("party4").guid, 1n, "party4 follows the reordered unit GUID");
  assert.equal(second.get("party1").canvas, nativePartyRows[0].canvas,
    "reorder retargets the slot without replacing its canvas");
  assert.equal(second.get("party4").canvas, nativePartyRows[3].canvas,
    "every stable slot keeps its original canvas");
  clearPortraitTargets();
});

test("player and target adoption use independent canvases and cleanup order", () => {
  const canvases = portraitCanvases();
  const playerCanvas = canvases.get("player");
  const targetCanvas = canvases.get("target");
  assert.ok(playerCanvas && targetCanvas);
  assert.notEqual(playerCanvas, targetCanvas, "each PortraitRenderer slot keeps its own canvas");
  assert.equal(playerCanvas.parentElement, nativeHost);
  assert.equal(targetCanvas.parentElement, targetHost);

  const playerFrame = fakeNode("div", document);
  const playerTarget = fakeNode("img", document);
  playerTarget.style.left = "10px";
  playerTarget.style.top = "20px";
  playerTarget.style.width = "64px";
  playerTarget.style.height = "64px";
  playerFrame.append(playerTarget);
  const targetFrame = fakeNode("div", document);
  const targetTarget = fakeNode("img", document);
  targetTarget.style.left = "30px";
  targetTarget.style.top = "40px";
  targetTarget.style.width = "48px";
  targetTarget.style.height = "48px";
  targetTarget.style.transform = "translateY(-50%)";
  targetTarget.hidden = true;
  targetFrame.append(targetTarget);

  const targetOriginalHidden = targetCanvas.hidden;
  const targetOriginalRoundness = {
    borderRadius: targetCanvas.style.borderRadius,
    backgroundColor: targetCanvas.style.backgroundColor,
    overflow: targetCanvas.style.overflow,
  };
  const playerCleanup = adoptPlayerPortraitCanvas(playerTarget);
  const targetCleanup = adoptTargetPortraitCanvas(targetTarget);
  assert.equal(typeof playerCleanup, "function");
  assert.equal(typeof targetCleanup, "function");
  assert.equal(playerCanvas.parentElement, playerFrame);
  assert.equal(targetCanvas.parentElement, targetFrame);
  assert.equal(playerCanvas.width, 128, "player keeps DPR-safe 64px backing");
  assert.equal(targetCanvas.width, 96, "target keeps DPR-safe 48px backing");
  assert.equal(playerCanvas.style.left, "10px");
  assert.equal(targetCanvas.style.left, "30px");
  assert.equal(targetCanvas.style.transform, "translateY(-50%)");
  assert.equal(targetCanvas.hidden, false,
    "a hidden authored Texture must not hide the live target canvas");
  assert.equal(targetCanvas.style.borderRadius, "50%",
    "the adopted target portrait is clipped to the stock circular portrait shape");
  assert.equal(targetCanvas.style.backgroundColor, "transparent",
    "the live target portrait keeps transparent pixels outside the model");
  assert.equal(targetCanvas.style.overflow, "hidden",
    "the target canvas clips model pixels to its circular border");

  targetCleanup();
  assert.equal(targetCanvas.parentElement, targetHost, "target cleanup restores its native host first");
  assert.equal(targetCanvas.hidden, targetOriginalHidden, "target cleanup restores native hidden state");
  assert.equal(targetCanvas.style.borderRadius, targetOriginalRoundness.borderRadius,
    "target cleanup restores native border radius");
  assert.equal(targetCanvas.style.backgroundColor, targetOriginalRoundness.backgroundColor,
    "target cleanup restores native background");
  assert.equal(targetCanvas.style.overflow, targetOriginalRoundness.overflow,
    "target cleanup restores native overflow");
  assert.equal(playerCanvas.parentElement, playerFrame, "target cleanup does not affect player adoption");
  playerCleanup();
  assert.equal(playerCanvas.parentElement, nativeHost, "player cleanup restores its native host second");
  assert.deepEqual(nativeHost.children, [playerCanvas, playerIcon]);
  assert.deepEqual(targetHost.children, [targetCanvas, targetIcon]);
  assert.equal(playerCanvas.width, 116, "player cleanup restores native DPR dimensions");
  assert.equal(targetCanvas.width, 116, "target cleanup restores native DPR dimensions");
  playerCleanup();
  targetCleanup();
  assert.deepEqual(nativeHost.children, [playerCanvas, playerIcon], "repeated cleanup remains idempotent");
  assert.deepEqual(targetHost.children, [targetCanvas, targetIcon]);

  targetHost.removeChild(targetCanvas);
  assert.equal(adoptTargetPortraitCanvas(targetTarget), undefined,
    "a detached native target canvas is a safe no-op");
  targetHost.insertBefore(targetCanvas, targetIcon);
});

test("focus and target-of-target adoption reuse independent unit canvases", () => {
  const focusTargetHost = fakeNode("div", document);
  const focusTarget = fakeNode("div", document);
  focusTarget.style.width = "42px";
  focusTarget.style.height = "42px";
  focusTargetHost.append(focusTarget);
  const totTargetHost = fakeNode("div", document);
  const totTarget = fakeNode("div", document);
  totTarget.style.width = "37px";
  totTarget.style.height = "37px";
  totTargetHost.append(totTarget);
  const focusCleanup = adoptFocusPortraitCanvas(focusTarget);
  const totCleanup = adoptTargetOfTargetPortraitCanvas(totTarget);
  assert.equal(typeof focusCleanup, "function");
  assert.equal(typeof totCleanup, "function");
  assert.notEqual(nativeFocusCanvas, nativeTotCanvas);
  assert.equal(nativeFocusCanvas.parentElement, focusTargetHost);
  assert.equal(nativeTotCanvas.parentElement, totTargetHost);
  assert.equal(nativeFocusCanvas.width, 84, "focus uses DPR-safe authored geometry");
  assert.equal(nativeTotCanvas.width, 74, "ToT uses DPR-safe authored geometry");
  assert.equal(adoptFocusPortraitCanvas(focusTarget), focusCleanup,
    "repeated focus adoption is idempotent");
  assert.equal(adoptTargetOfTargetPortraitCanvas(totTarget), totCleanup,
    "repeated ToT adoption is idempotent");
  focusCleanup();
  totCleanup();
  assert.equal(nativeFocusCanvas.parentElement, nativeFocusHost);
  assert.equal(nativeTotCanvas.parentElement, nativeTotHost);
  focusCleanup();
  totCleanup();
});

test("FocusFrameToT adoption creates its own canvas and follows the focus's target every sync", () => {
  const frame = fakeNode("div", document);
  const texture = fakeNode("img", document);
  texture.style.position = "absolute";
  texture.style.left = "5px";
  texture.style.top = "5px";
  texture.style.width = "35px";
  texture.style.height = "35px";
  frame.append(texture);
  const selfGuid = 0x10n;
  const focusGuid = 0x40n;
  const focusTargetGuid = 0x77n;
  const focus = { guid: focusGuid, typeId: 3, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, focusTargetGuid]]) };
  const previousWorld = game.world;
  const previousFocus = game.focusGuid;
  game.world = { state: { selfGuid, objects: new Map([[focusGuid, focus]]) } };
  game.focusGuid = focusGuid;
  const snapshots = [];
  const sync = () => {
    syncPortraitTargets({ setPortraitTargets(targets) { snapshots.push(new Map(targets)); } });
    return snapshots.at(-1).get("focustot");
  };
  let cleanup;
  try {
    cleanup = adoptFocusTargetPortraitCanvas(texture);
    assert.equal(typeof cleanup, "function");
    const canvas = portraitCanvases().get("focustot");
    assert.ok(canvas, "a canvas of its own: the native HUD has no focus-ToT row to borrow from");
    assert.equal(canvas.parentElement, frame);
    assert.equal(frame.children.indexOf(canvas), frame.children.indexOf(texture) + 1, "directly over the stock Texture");
    assert.equal(canvas.className, "portrait-canvas portrait-canvas-focustot");
    assert.deepEqual([canvas.style.left, canvas.style.top, canvas.style.width, canvas.style.height],
      ["5px", "5px", "35px", "35px"], "the ToT template's 35px box");
    assert.deepEqual([canvas.width, canvas.height], [70, 70], "DPR-safe backing store");
    assert.deepEqual(sync(), { guid: focusTargetGuid, canvas }, "the focus's UNIT_FIELD_TARGET is the unit");
    assert.equal(adoptFocusTargetPortraitCanvas(texture), cleanup, "repeat adoption is idempotent");

    // The focus turns to somebody else: the world rewrites its target field, nothing else fires.
    focus.fields.set(UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, 0x78n);
    assert.deepEqual(sync(), { guid: 0x78n, canvas });
    focus.fields.set(UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, 0n);
    assert.deepEqual(sync(), { guid: undefined, canvas }, "a zero target is no unit");
    focus.fields.set(UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, focusTargetGuid);
    game.focusGuid = undefined;
    assert.deepEqual(sync(), { guid: undefined, canvas }, "no focus, no focus target");
    game.focusGuid = focusGuid;
    assert.deepEqual(sync(), { guid: focusTargetGuid, canvas });
    assert.equal(portraitCanvases().get("tot"), undefined, "the target's ToT slot is untouched");
  } finally {
    cleanup?.();
    game.world = previousWorld;
    game.focusGuid = previousFocus;
  }
  assert.deepEqual(frame.children, [texture], "cleanup removes the created canvas");
  assert.equal(portraitCanvases().has("focustot"), false);
  assert.equal(sync()?.guid, undefined, "and the slot is released");
});
