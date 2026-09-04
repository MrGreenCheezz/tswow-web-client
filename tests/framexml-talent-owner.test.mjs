import test from "node:test";
import assert from "node:assert/strict";

// FrameXmlWorldMount also imports the normal UI module graph.  Give that graph a harmless DOM
// during module evaluation; the owner harness below supplies the only rendered element it uses.
const style = { setProperty() {}, removeProperty() {} };
const classList = { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } };
const domNode = () => new Proxy({
  style,
  classList,
  dataset: {},
  children: [],
  hidden: false,
  value: "",
  textContent: "",
  querySelector: () => domNode(),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  append() {},
  appendChild() {},
  replaceChildren() {},
  remove() {},
  setAttribute() {},
  getAttribute: () => null,
  removeAttribute() {},
  getContext: () => ({ setTransform() {}, clearRect() {} }),
}, { get(target, property) {
  if (property in target) return target[property];
  if (property === "ownerDocument") return globalThis.document;
  if (property === "parentNode" || property === "parentElement" || property === "nextSibling") return null;
  if (property === "clientWidth" || property === "clientHeight") return 1024;
  if (property === "getBoundingClientRect") return () => ({ left: 0, top: 0, width: 0, height: 0 });
  if (property === "focus" || property === "blur" || property === "click") return () => {};
  return undefined;
} });
const documentNode = domNode();
globalThis.document = {
  head: documentNode,
  body: documentNode,
  documentElement: documentNode,
  createElement: () => domNode(),
  getElementById: () => domNode(),
  querySelector: () => domNode(),
  querySelectorAll: () => [],
};
globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { createLazyFrameXmlTalentOwner, createPatchedFrameXmlTalentOwner } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldMount.js",
);
const {
  publishFrameXmlTalent,
  toggleFrameXmlTalent,
  closeFrameXmlTalent,
} = await import("../dist/code/browser/framexml/FrameXmlTalentController.js");

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}

function harness() {
  const root = {
    type: "Frame",
    name: "PlayerTalentFrame",
    named: true,
    parent: undefined,
    children: [],
    attributes: {},
    points: [],
    scriptSources: new Map(),
    registeredEvents: new Set(),
    scripts: new Map([["OnLoad", () => {}], ["OnShow", () => {}], ["OnHide", () => {}]]),
    visible: false,
  };
  let loadCalls = 0;
  let visible = false;
  const wait = deferred();
  const element = {
    getAttribute(name) {
      return name === "data-framexml-name" ? "PlayerTalentFrame"
        : name === "data-framexml-type" ? "Frame" : null;
    },
  };
  const boot = {
    bridge: {
      getFrame(name) { return name === "PlayerTalentFrame" ? root : undefined; },
      isVisible() { return visible; },
      Hide() { visible = false; root.visible = false; },
      Show() { visible = true; root.visible = true; return true; },
      hasScript(frame, name) { return frame === root && root.scripts.has(name); },
    },
    vm: {
      globalFunction() { return undefined; },
    },
    async loadAddon(name) {
      assert.equal(name, "Blizzard_TalentUI");
      loadCalls += 1;
      return await wait.promise;
    },
  };
  const renderer = {
    added: [],
    addRoots(roots) { this.added.push(...roots); },
    elementFor(frame) { return frame === root ? element : undefined; },
  };
  const seam = {
    talentSnapshot: () => ({ activeTalentGroup: 1 }),
    learnTalent() {},
  };
  return { boot, renderer, seam, root, wait, get loadCalls() { return loadCalls; } };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function patchedHarness({ rendered = true } = {}) {
  const root = {
    type: "Frame",
    name: "UniversalTalentFrame",
    named: true,
    parent: undefined,
    children: [],
    attributes: {},
    points: [],
    scriptSources: new Map(),
    registeredEvents: new Set(),
    scripts: new Map([["OnShow", () => {}], ["OnHide", () => {}]]),
    visible: false,
  };
  const toggleRef = { kind: "patched-toggle" };
  let created = false;
  let toggleCalls = 0;
  let releases = 0;
  const element = {
    getAttribute(name) {
      return name === "data-framexml-name" ? "UniversalTalentFrame"
        : name === "data-framexml-type" ? "Frame" : null;
    },
  };
  const boot = {
    isAddonLoaded(name) { return name === "retail-talents"; },
    bridge: {
      runInMutationBatch(callback) { return callback(); },
      getFrame(name) { return created && name === "UniversalTalentFrame" ? root : undefined; },
      isVisible(frame) { return frame.visible; },
      Hide(frame) { frame.visible = false; },
      hasScript(frame, name) { return frame === root && frame.scripts.has(name); },
    },
    vm: {
      globalFunction(name) { return name === "ToggleTalentFrame" ? toggleRef : undefined; },
      call(ref) {
        assert.equal(ref, toggleRef);
        toggleCalls += 1;
        created = true;
        root.visible = !root.visible;
        return [];
      },
      release(ref) { assert.equal(ref, toggleRef); releases += 1; },
    },
  };
  const renderer = {
    elementFor(frame) { return rendered && frame === root ? element : undefined; },
  };
  return {
    boot, renderer, root,
    get toggleCalls() { return toggleCalls; },
    get releases() { return releases; },
  };
}

test("patched talent owner captures ToggleTalentFrame and never opens the stock root", () => {
  const h = patchedHarness();
  let nativeOpen = true;
  const owner = createPatchedFrameXmlTalentOwner(
    h.boot, h.renderer, () => { nativeOpen = false; },
  );
  assert.ok(owner);
  const cleanup = publishFrameXmlTalent(owner);
  try {
    assert.equal(toggleFrameXmlTalent(), true);
    assert.equal(nativeOpen, false, "native fallback closes before the patched Show path");
    assert.equal(h.root.visible, true);
    assert.equal(h.boot.bridge.getFrame("PlayerTalentFrame"), undefined);
    assert.equal(h.toggleCalls, 1);

    assert.equal(toggleFrameXmlTalent(), true);
    assert.equal(h.root.visible, false, "second N closes the one patched owner directly");
    assert.equal(h.toggleCalls, 1, "closing does not invoke a competing stock/global toggle");

    assert.equal(toggleFrameXmlTalent(), true);
    assert.equal(h.root.visible, true);
    assert.equal(h.toggleCalls, 2);
  } finally {
    cleanup();
  }
  assert.equal(h.root.visible, false);
  assert.equal(h.releases, 1, "the captured Lua function is released with the mount owner");
});

test("a malformed patched talent root is hidden and demoted for native fallback", () => {
  const h = patchedHarness({ rendered: false });
  let failures = 0;
  const owner = createPatchedFrameXmlTalentOwner(
    h.boot, h.renderer, undefined, () => { failures += 1; },
  );
  assert.ok(owner);
  const cleanup = publishFrameXmlTalent(owner);
  try {
    assert.equal(toggleFrameXmlTalent(), false,
      "the caller may open native from the same key/button press after demotion");
    assert.equal(h.root.visible, false, "a partial custom root cannot overlap the native fallback");
    assert.equal(failures, 1);
  } finally {
    cleanup();
  }
  assert.equal(h.releases, 1);
});

test("pending talent toggle N then N coalesces one load and keeps late frame hidden", async () => {
  const h = harness();
  const owner = createLazyFrameXmlTalentOwner(h.seam, h.boot, h.renderer);
  const cleanup = publishFrameXmlTalent(owner);
  try {
    assert.equal(toggleFrameXmlTalent(), true);
    assert.equal(owner.isOpen(), true, "pending open intent is observable to the controller");
    assert.equal(toggleFrameXmlTalent(), true);
    assert.equal(owner.isOpen(), false, "second toggle cancels the pending open intent");
    assert.equal(h.loadCalls, 1);

    h.wait.resolve({ ok: true, roots: [h.root] });
    await settle();
    assert.equal(h.root.visible, false, "a canceled pending open never pops the late root");
    assert.equal(owner.isOpen(), false);
  } finally {
    cleanup();
  }
});

test("pending talent open then Escape cancels intent without opening the game menu", async () => {
  const h = harness();
  const owner = createLazyFrameXmlTalentOwner(h.seam, h.boot, h.renderer);
  const cleanup = publishFrameXmlTalent(owner);
  try {
    assert.equal(toggleFrameXmlTalent(), true);
    assert.equal(closeFrameXmlTalent(), true);
    assert.equal(owner.isOpen(), false);
    assert.equal(h.loadCalls, 1);

    h.wait.resolve({ ok: true, roots: [h.root] });
    await settle();
    assert.equal(h.root.visible, false, "Escape before load prevents a late stock window");
    assert.equal(owner.isOpen(), false);
  } finally {
    cleanup();
  }
});
