import assert from "node:assert/strict";
import test from "node:test";

function fakeNode(tag) {
  const classes = new Set();
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
    get firstChild() { return node.children[0] ?? null; },
    get nextSibling() {
      if (!node.parentNode) return null;
      const index = node.parentNode.children.indexOf(node);
      return index >= 0 ? node.parentNode.children[index + 1] ?? null : null;
    },
    style: { display: "", setProperty() {}, removeProperty() {} },
    clientWidth: 1024,
    clientHeight: 768,
    textContent: "",
    value: "",
    hidden: false,
    width: 0,
    height: 0,
    dataset: {},
    className: "",
    id: "",
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
      const index = reference == null ? -1 : node.children.indexOf(reference);
      if (index < 0) node.children.push(child);
      else node.children.splice(index, 0, child);
    },
    replaceChildren(...children) {
      for (const old of node.children) old.parentNode = undefined;
      for (const child of children) child.parentNode = node;
      node.children = [...children];
    },
    remove() {
      if (!node.parentNode) return;
      node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      node.parentNode = undefined;
    },
    setAttribute(name, value) { node[name] = String(value); },
    getAttribute(name) { return node[name] ?? null; },
    removeAttribute(name) { delete node[name]; },
    addEventListener() {},
    removeEventListener() {},
    getContext() { return context; },
    querySelector(selector) {
      const match = node.children.find((child) =>
        selector === `canvas[data-portrait-slot="${child.dataset?.portraitSlot}"]`);
      return selector.startsWith("canvas[") ? match ?? null : match ?? fakeNode("button");
    },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}

const viewport = fakeNode("div");
const nativePlayerAuras = fakeNode("div");
nativePlayerAuras.hidden = true;
nativePlayerAuras.style.display = "inline-flex";
const targetAuras = fakeNode("div");
const targetCast = fakeNode("div");
const targetActions = fakeNode("div");
const nativeLanes = new Map([
  ["player-auras", nativePlayerAuras],
  ["target-auras", targetAuras],
  ["target-cast", targetCast],
  ["target-actions", targetActions],
]);
const originalNativeState = new Map([...nativeLanes].map(([id, lane]) => [id, {
  hidden: lane.hidden,
  display: lane.style.display,
}]));
let playerAuraRebuilds = 0;
const originalPlayerAuraReplaceChildren = nativePlayerAuras.replaceChildren;
nativePlayerAuras.replaceChildren = function replacePlayerAuras(...children) {
  playerAuraRebuilds += 1;
  return originalPlayerAuraReplaceChildren.call(this, ...children);
};
let targetAuraRebuilds = 0;
const originalTargetAuraReplaceChildren = targetAuras.replaceChildren;
targetAuras.replaceChildren = function replaceTargetAuras(...children) {
  targetAuraRebuilds += 1;
  return originalTargetAuraReplaceChildren.call(this, ...children);
};
const stalePlayerAura = fakeNode("div");
nativePlayerAuras.append(stalePlayerAura);

const rightRail = fakeNode("div");
const targetIcon = fakeNode("img");
const targetIconParent = fakeNode("div");
targetIconParent.append(targetIcon);
const nativeElements = new Map([
  ["right-rail", rightRail],
  ["target-icon", targetIcon],
]);
const renderedBuffFrame = fakeNode("div");
const renderedTargetFrame = fakeNode("div");
renderedTargetFrame.style.width = "232px";
renderedTargetFrame.style.height = "100px";
const renderedTargetPortrait = fakeNode("div");
renderedTargetPortrait.style.width = "64px";
renderedTargetPortrait.style.height = "64px";
renderedTargetFrame.append(renderedTargetPortrait);
const renderedMinimapCluster = fakeNode("div");
renderedMinimapCluster.style.width = "192px";
renderedMinimapCluster.style.height = "192px";
const renderedMinimap = fakeNode("div");
renderedMinimap.style.width = "140px";
renderedMinimap.style.height = "140px";
renderedMinimapCluster.append(renderedMinimap);
const body = fakeNode("body");
globalThis.document = {
  head: fakeNode("head"),
  body,
  createElement: fakeNode,
  getElementById(id) {
    return nativeLanes.get(id) ?? nativeElements.get(id) ?? fakeNode("div");
  },
  querySelectorAll() { return []; },
};

let nextAnimationFrame = 1;
globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 2,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame() { return nextAnimationFrame++; },
  cancelAnimationFrame() {},
};
globalThis.location = globalThis.window.location;

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { updateMinimap } = await import("../dist/code/browser/ui/Minimap.js");
const { showAuras, updateAuraDurations } = await import("../dist/code/browser/ui/Auras.js");
const { mountFrameXmlVertical, unmountFrameXmlVertical } =
  await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");

const playerAura = {
  slot: 0,
  spellId: 1,
  flags: 0x10,
  casterLevel: 1,
  applications: 1,
};
const targetAura = {
  slot: 0,
  spellId: 2,
  flags: 0x80,
  casterLevel: 1,
  applications: 1,
  duration: 5000,
  maxDuration: 5000,
  expiresAt: 5000,
};
game.world = {
  mapId: 0,
  state: {
    selfGuid: 1n,
    objects: new Map([
      [1n, {
        position: { x: 0, y: 0, orientation: 0 },
        fields: new Map(),
        typeId: 4,
      }],
    ]),
  },
  targetGuid: 2n,
  group: { members: [] },
  knownSpells: [],
  auras: new Map([[1n, new Map([[0, playerAura]])], [2n, new Map([[0, targetAura]])]]),
  aurasFor(guid) {
    return guid === 1n ? [playerAura] : guid === 2n ? [targetAura] : [];
  },
  questPoi: new Map(),
  currentGameTime() { return undefined; },
};
let appearanceUpdates = 0;
game.renderer = { setUnitAuraAppearance() { appearanceUpdates += 1; } };
updateMinimap(1000);

const inventory = {
  files: { total: 0, bytes: 0 },
  widgets: { total: 0 },
  lua: { errorsRaised: 0 },
  errors: [],
  timings: { scanMs: 0, planMs: 0, loadMs: 0, totalMs: 0 },
};
let includeBuffFrame = true;
let pendingLoad;
const seams = [];
FrameXmlBoot.prototype.load = async function loadStub() {
  const seam = this.seam;
  seams.push(seam);
  if (includeBuffFrame) this.bridge.CreateFrame("Frame", "BuffFrame");
  const targetFrame = this.bridge.CreateFrame("Button", "TargetFrame");
  this.bridge.createChild(targetFrame, "Texture", "TargetFramePortrait");
  const minimapCluster = this.bridge.CreateFrame("Frame", "MinimapCluster");
  this.bridge.CreateFrame("Minimap", "Minimap", minimapCluster);
  if (pendingLoad) await pendingLoad;
  seam?.attach(this.pump);
  return inventory;
};
FrameXmlDomRenderer.prototype.mount = function mountStub() {};
FrameXmlDomRenderer.prototype.elementFor = function elementForStub(frame) {
  if (frame.name === "BuffFrame") return renderedBuffFrame;
  if (frame.name === "TargetFrame") return renderedTargetFrame;
  if (frame.name === "TargetFramePortrait") return renderedTargetPortrait;
  if (frame.name === "MinimapCluster") return renderedMinimapCluster;
  if (frame.name === "Minimap") return renderedMinimap;
  return undefined;
};
FrameXmlDomRenderer.prototype.registerFonts = function registerFontsStub() {};
FrameXmlDomRenderer.prototype.tickCooldowns = function tickCooldownsStub() {};
FrameXmlDomRenderer.prototype.destroy = function destroyStub() {};

function seam(name) {
  return {
    name,
    attached: false,
    attach() { this.attached = true; },
    detach() { this.attached = false; },
    tick() {},
  };
}

function assertNativeLanesIntact(label) {
  for (const [id, lane] of nativeLanes) {
    const original = originalNativeState.get(id);
    assert.equal(lane.hidden, original.hidden, `${label}: #${id}.hidden`);
    assert.equal(lane.style.display, original.display, `${label}: #${id} inline display`);
  }
}

test("BuffFrame gate owns only player auras after a successful mount", async () => {
  includeBuffFrame = true;
  const result = await mountFrameXmlVertical({ viewport, seam: seam("success") });
  assert.equal(result.ok, true);
  assert.equal(body.classList.contains("framexml-world-replaces-native"), true,
    "replacement class activates only after BuffFrame, target and minimap gates");
  const style = document.head.children.find((node) => node.textContent.includes("#player-auras"));
  assert.ok(style, "mount stylesheet must contain the exact player aura lane selector");
  assert.ok(style.textContent.includes("body.framexml-world-replaces-native #player-auras"),
    "player aura ownership is class/CSS scoped");
  for (const id of ["target-auras", "target-cast", "target-actions"]) {
    assert.doesNotMatch(style.textContent, new RegExp(`#${id}[^\\{]*\\{[^}]*display:\\s*none`, "i"),
      `target contextual #${id} must remain native`);
  }
  assertNativeLanesIntact("successful mount");

  const playerChildrenBeforeRefresh = [...nativePlayerAuras.children];
  const targetRebuildsBeforeRefresh = targetAuraRebuilds;
  showAuras();
  assert.deepEqual(nativePlayerAuras.children, playerChildrenBeforeRefresh,
    "active FrameXML ownership suppresses native player aura DOM rebuilds");
  assert.equal(targetAuraRebuilds, targetRebuildsBeforeRefresh + 1,
    "active ownership still refreshes native target auras");
  assert.ok(appearanceUpdates > 0, "active ownership still refreshes renderer aura appearance");

  const rebuildsBeforeUnmount = playerAuraRebuilds;
  const targetRebuildsBeforeUnmount = targetAuraRebuilds;
  unmountFrameXmlVertical();
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false);
  assert.equal(document.head.children.length, 0, "unmount removes the ownership stylesheet");
  assertNativeLanesIntact("unmount");
  assert.equal(playerAuraRebuilds, rebuildsBeforeUnmount + 1,
    "unmount repaints the native player aura strip exactly once after class removal");
  assert.equal(nativePlayerAuras.children.length, 1, "native player aura strip reflects current state");
  assert.notEqual(nativePlayerAuras.children[0], stalePlayerAura,
    "unmount removes stale native player aura contents");
  // The target strip's auras did not change across the mount, so its icons stay; the refresh the
  // unmount makes is its timers, which `showAuras` registers again with the player strip's.
  assert.equal(targetAuraRebuilds, targetRebuildsBeforeUnmount,
    "an unchanged target strip keeps its icons through the unmount refresh");
  updateAuraDurations(2000);
  assert.equal(targetAuras.children[0]?.children.at(-1)?.textContent, "3.0",
    "target timed aura remains registered after the unmount rebuild");
});

test("missing BuffFrame fails before publishing ownership and leaves native auras alone", async () => {
  includeBuffFrame = false;
  const result = await mountFrameXmlVertical({ viewport, seam: seam("missing-buff") });
  assert.equal(result.ok, false);
  assert.match(result.message, /BuffFrame gate/);
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false);
  assert.equal(viewport.children.length, 0, "failed gate removes the temporary host");
  assert.equal(document.head.children.length, 0, "failed gate removes the temporary stylesheet");
  assertNativeLanesIntact("missing BuffFrame");
  assert.equal(playerAuraRebuilds, 1, "prepublish failure must not rebuild native player auras");
});

test("a stale async mount cannot publish the player aura ownership class", async () => {
  includeBuffFrame = true;
  let release;
  pendingLoad = new Promise((resolve) => { release = resolve; });
  const loading = mountFrameXmlVertical({ viewport, seam: seam("stale") });
  await Promise.resolve();
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false);
  unmountFrameXmlVertical();
  assertNativeLanesIntact("stale cleanup");
  release();
  const result = await loading;
  pendingLoad = undefined;
  assert.equal(result.ok, false, "stale completion must not publish a mount");
  assert.equal(body.classList.contains("framexml-world-replaces-native"), false);
  assert.equal(viewport.children.length, 0);
  assert.equal(document.head.children.length, 0);
  assertNativeLanesIntact("stale completion");
  assert.equal(playerAuraRebuilds, 1, "stale cleanup must not rebuild native player auras");
});
