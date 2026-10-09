import assert from "node:assert/strict";
import test from "node:test";

const { CannedWorldSeam, CANNED_TRAINER } = await import(
  "../dist/code/browser/framexml/CannedWorldSeam.js",
);
const { LiveWorldSeam } = await import(
  "../dist/code/browser/framexml/LiveWorldSeam.js",
);
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} binding exists`);
  return [...binding(seam, args)];
}

function pump() {
  const events = [];
  return { events, now: () => 100, fire(event, ...args) { events.push([event, ...args]); return 1; } };
}

test("Canned Trainer projects packet rows and routes one available purchase", () => {
  const seam = new CannedWorldSeam();
  const worldPump = pump();
  seam.attach(worldPump);
  worldPump.events.length = 0;
  assert.equal(seam.openTrainer(), 1);
  assert.deepEqual(worldPump.events, [[FRAMEXML_SEAM_EVENTS.trainerUpdate]]);
  assert.deepEqual(api(seam, "GetTrainerServiceTypeFilter", "used"), [false],
    "the original Blizzard_TrainerUI starts with TRAINER_FILTER_USED = 0");
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [2]);
  assert.deepEqual(api(seam, "GetTrainerServiceInfo", 2), ["Кровопускание", "", "unavailable", true]);
  api(seam, "SetTrainerServiceTypeFilter", "used", true);
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [3]);
  assert.deepEqual(api(seam, "GetTrainerServiceInfo", 1), ["Рывок", "", "available", true]);
  assert.deepEqual(api(seam, "GetTrainerServiceInfo", 2), ["Удар героя", "", "used", true]);
  assert.deepEqual(api(seam, "GetTrainerServiceInfo", 3), ["Кровопускание", "", "unavailable", true]);
  assert.deepEqual(api(seam, "GetTrainerServiceCost", 1), [1250, 0, 0]);
  assert.deepEqual(api(seam, "GetTrainerServiceLevelReq", 1), [4]);
  assert.deepEqual(api(seam, "GetTrainerServiceIcon", 1), [CANNED_TRAINER.services[0].iconPath]);
  assert.deepEqual(api(seam, "GetTrainerServiceDescription", 1), [CANNED_TRAINER.services[0].description]);
  worldPump.events.length = 0;
  api(seam, "SelectTrainerService", 2);
  assert.deepEqual(api(seam, "GetTrainerSelectionIndex"), [2]);
  assert.deepEqual(worldPump.events, [], "selection command does not recursively publish a description event");
  api(seam, "BuyTrainerService", 1);
  api(seam, "BuyTrainerService", 2);
  assert.deepEqual(seam.trainerBuyRequests, [100]);
  api(seam, "SetTrainerServiceTypeFilter", "available", false);
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [2]);
  assert.deepEqual(api(seam, "GetTrainerSelectionIndex"), [1], "filter selects the first visible service");
  seam.closeTrainer();
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [0]);
  seam.detach();
});

test("trainer type 2 stays native and exposes no stock rows", () => {
  const tradeskill = { ...CANNED_TRAINER, trainerType: 2 };
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, tradeskill);
  seam.attach(pump());
  seam.trainerChanged("show");
  assert.equal(seam.trainerType(), undefined);
  assert.equal(seam.isTradeskillTrainer(), false);
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [0]);
  seam.detach();
});

test("trainer ownership controller is identity-safe and closes the published owner", async () => {
  const ownerModule = await import("../dist/code/browser/framexml/FrameXmlTrainerController.js");
  let disposed = 0;
  const owner = {
    isOpen: () => false, show() {}, hide() {}, close: () => true, refresh() {},
    dispose() { disposed += 1; },
  };
  const cleanup = ownerModule.publishFrameXmlTrainer(owner);
  try {
    assert.equal(ownerModule.frameXmlTrainerOpen(), false);
    assert.equal(ownerModule.closeFrameXmlTrainer(), true);
    const replacement = { isOpen: () => false, show() {}, hide() {}, close: () => false, refresh() {} };
    const replacementCleanup = ownerModule.publishFrameXmlTrainer(replacement);
    assert.equal(disposed, 1, "replacing a pending owner disposes the old owner");
    replacementCleanup();
  } finally {
    cleanup();
  }
  // Controller semantics are intentionally tested separately from the DOM/VM owner above:
  // publish is identity-safe and close is a no-op once it is absent.
  assert.equal(ownerModule.frameXmlTrainerOpen(), false);
  assert.equal(ownerModule.closeFrameXmlTrainer(), false);
});

test("trainer controller demotes identity-safely when a published owner throws", async () => {
  const ownerModule = await import("../dist/code/browser/framexml/FrameXmlTrainerController.js");
  let demoted = 0;
  const owner = {
    isOpen: () => true, show() {}, hide() {}, close: () => { throw new Error("close failed"); },
    refresh() { throw new Error("refresh failed"); }, demote() { demoted += 1; },
  };
  const cleanup = ownerModule.publishFrameXmlTrainer(owner);
  try {
    assert.equal(ownerModule.closeFrameXmlTrainer(), false);
    assert.equal(ownerModule.notifyFrameXmlTrainer("update"), false);
    assert.equal(demoted, 2);
  } finally {
    cleanup();
  }
});

test("lazy trainer owner keeps native panel pending, then hands off only after the gate", async () => {
  const node = () => {
    const value = {
      hidden: false, value: "", textContent: "", style: { setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      dataset: {}, children: [],
      addEventListener() {}, removeEventListener() {}, append() {}, appendChild() {},
      replaceChildren() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
      querySelector() { return node(); }, querySelectorAll() { return []; },
      getContext() { return { setTransform() {}, clearRect() {} }; },
    };
    return value;
  };
  const shared = node();
  globalThis.document = {
    head: shared, body: shared, documentElement: shared,
    createElement: node, getElementById: () => shared, querySelector: () => shared,
    querySelectorAll: () => [],
  };
  globalThis.window = {
    innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
    location: { protocol: "http:", hostname: "localhost" },
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  globalThis.location = globalThis.window.location;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { createLazyFrameXmlTrainerOwner } = await import(
    "../dist/code/browser/framexml/FrameXmlWorldMount.js",
  );
  const seam = new CannedWorldSeam();
  seam.attach(pump());
  seam.openTrainer();
  const uiParent = { type: "Frame", name: "UIParent", children: [], visible: true };
  const root = {
    type: "Frame", name: "ClassTrainerFrame", named: true, parent: uiParent, children: [],
    attributes: {}, points: [], scriptSources: new Map(), registeredEvents: new Set([
      "TRAINER_UPDATE", "TRAINER_DESCRIPTION_UPDATE",
    ]), scripts: new Map([["OnLoad", () => {}], ["OnShow", () => {}], ["OnHide", () => {}], ["OnEvent", () => {}]]),
    visible: false,
  };
  const frames = new Map([["UIParent", uiParent], ["ClassTrainerFrame", root]]);
  for (let i = 1; i <= 11; i += 1) frames.set(`ClassTrainerSkill${i}`, {
    type: "Button", name: `ClassTrainerSkill${i}`, parent: root,
    scripts: new Map([["OnClick", () => {}]]),
  });
  for (const [name, type] of [
    ["ClassTrainerListScrollFrame", "ScrollFrame"], ["ClassTrainerDetailScrollFrame", "ScrollFrame"],
    ["ClassTrainerDetailScrollChildFrame", "Frame"], ["ClassTrainerSkillIcon", "Button"],
    ["ClassTrainerTrainButton", "Button"], ["ClassTrainerCancelButton", "Button"],
    ["ClassTrainerFrameCloseButton", "Button"], ["ClassTrainerNameText", "FontString"],
    ["ClassTrainerGreetingText", "FontString"],
  ]) frames.set(name, {
    type, name, parent: root,
    scripts: type === "Button" ? new Map([["OnClick", () => {}]]) : new Map(),
  });
  const wait = new Promise((resolve) => { globalThis.resolveTrainerLoad = resolve; });
  let loadCalls = 0;
  const boot = {
    bridge: {
      getFrame: (name) => frames.get(name),
      hasScript: (frame, name) => frame?.scripts?.has(name) === true,
      isVisible: (frame) => frame.visible === true,
      Show: (frame) => { frame.visible = true; return true; },
      Hide: (frame) => { frame.visible = false; return true; },
      dispatchEvent: () => 1,
    },
    vm: {
      globalFunction: () => ({}),
      call: () => [], release() {},
    },
    loadAddon: async () => { loadCalls += 1; return await wait; },
  };
  const renderer = {
    addRoots() {},
    sync() {},
    elementFor: (frame) => frame ? {
      getAttribute: (name) => name === "data-framexml-name" ? frame.name : name === "data-framexml-type" ? frame.type : null,
    } : undefined,
  };
  const owner = createLazyFrameXmlTrainerOwner(seam, boot, renderer);
  owner.show(); owner.show();
  assert.equal(loadCalls, 1);
  assert.equal(root.visible, false, "native fallback remains while LoD is pending");
  owner.hide();
  globalThis.resolveTrainerLoad({ ok: true, roots: [] });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(root.visible, false, "close before load prevents a late stock open");
  delete globalThis.resolveTrainerLoad;
  seam.detach();
});

async function trainerOwnerFixture({
  type = 0,
  loadResult = { ok: true, roots: [] },
  loadError = undefined,
  throwOnSync = false,
  throwOnCall = false,
  errorOnShow = false,
  errorOnCall = false,
  diagnosticOnShow = false,
  hideCloses = false,
} = {}) {
  const { createLazyFrameXmlTrainerOwner } = await import(
    "../dist/code/browser/framexml/FrameXmlWorldMount.js",
  );
  const { trainerWindow } = await import("../dist/code/browser/ui/Dom.js");
  trainerWindow.hidden = false;
  const seam = new CannedWorldSeam();
  seam.attach(pump());
  seam.openTrainer();
  let context = {};
  let listSignature = "trainer-1";
  seam.trainerType = () => type;
  seam.trainerContextSignature = () => listSignature;
  let closeCalls = 0;
  const close = seam.closeTrainer.bind(seam);
  seam.closeTrainer = () => { closeCalls += 1; close(); };
  const uiParent = { type: "Frame", name: "UIParent", children: [], visible: true };
  const root = {
    type: "Frame", name: "ClassTrainerFrame", named: true, parent: uiParent, children: [],
    attributes: {}, points: [], scriptSources: new Map(), registeredEvents: new Set([
      "TRAINER_UPDATE", "TRAINER_DESCRIPTION_UPDATE",
    ]), scripts: new Map([
      ["OnLoad", () => {}], ["OnShow", () => {}], ["OnHide", () => {}], ["OnEvent", () => {}],
    ]), visible: false,
  };
  const frames = new Map([["UIParent", uiParent], ["ClassTrainerFrame", root]]);
  for (let i = 1; i <= 11; i += 1) frames.set(`ClassTrainerSkill${i}`, {
    type: "Button", name: `ClassTrainerSkill${i}`, parent: root,
    scripts: new Map([["OnClick", () => {}]]),
  });
  for (const [name, frameType] of [
    ["ClassTrainerListScrollFrame", "ScrollFrame"], ["ClassTrainerDetailScrollFrame", "ScrollFrame"],
    ["ClassTrainerDetailScrollChildFrame", "Frame"], ["ClassTrainerSkillIcon", "Button"],
    ["ClassTrainerTrainButton", "Button"], ["ClassTrainerCancelButton", "Button"],
    ["ClassTrainerFrameCloseButton", "Button"],
  ]) frames.set(name, {
    type: frameType, name, parent: root,
    scripts: frameType === "Button" ? new Map([["OnClick", () => {}]]) : new Map(),
  });
  let resolveLoad;
  let rejectLoad;
  const loadPromise = new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
  let loadCalls = 0;
  let vmErrorCount = 0;
  const bridgeDiagnostics = [];
  const boot = {
    bridge: {
      diagnostics: bridgeDiagnostics,
      getFrame: (name) => frames.get(name),
      hasScript: (frame, name) => frame?.scripts?.has(name) === true,
      isVisible: (frame) => frame.visible === true,
      Show: (frame) => {
        if (errorOnShow) vmErrorCount += 1;
        if (diagnosticOnShow) bridgeDiagnostics.push({ scope: "script", message: "OnShow failed" });
        frame.visible = true;
        return true;
      },
      Hide: (frame) => {
        const changed = frame.visible === true;
        frame.visible = false;
        if (hideCloses && changed && frame === root) seam.closeTrainer();
        return true;
      },
      dispatchEvent: () => 1,
    },
    get errorCount() { return vmErrorCount; },
    vm: {
      globalFunction: () => ({}),
      call: () => {
        if (throwOnCall) throw new Error("stock call failed");
        if (errorOnCall) vmErrorCount += 1;
        return [];
      },
      release() {},
    },
    loadAddon: async () => {
      loadCalls += 1;
      if (loadError) throw loadError;
      return await loadPromise;
    },
  };
  let synced = false;
  let syncCalls = 0;
  const elements = new Map();
  const renderer = {
    addRoots() {},
    sync() {
      syncCalls += 1;
      if (throwOnSync) throw new Error("renderer sync failed");
      synced = true;
    },
    elementFor: (frame) => {
      if (!synced || !frame) return undefined;
      if (!elements.has(frame)) {
        const element = {
          parentElement: frame.parent ? renderer.elementFor(frame.parent) : undefined,
          getAttribute: (name) => name === "data-framexml-name" ? frame.name
            : name === "data-framexml-type" ? frame.type : null,
        };
        elements.set(frame, element);
      }
      return elements.get(frame);
    },
  };
  let nativeCalls = 0;
  let failureCalls = 0;
  let failureSawTrainer = false;
  const owner = createLazyFrameXmlTrainerOwner(
    seam, boot, renderer, () => {
      failureCalls += 1;
      failureSawTrainer = seam.trainerServiceCount() > 0;
    }, () => context,
    () => { nativeCalls += 1; trainerWindow.hidden = false; },
  );
  return {
    owner, seam, root, trainerWindow, boot, renderer,
    get loadCalls() { return loadCalls; }, get syncCalls() { return syncCalls; },
    get nativeCalls() { return nativeCalls; }, get failureCalls() { return failureCalls; },
    get failureSawTrainer() { return failureSawTrainer; },
    get closeCalls() { return closeCalls; },
    resolve: (value = loadResult) => resolveLoad(value), reject: (error) => rejectLoad(error),
    setContext: (value) => { context = value; }, setSignature: (value) => { listSignature = value; },
    setType: (value) => { type = value; },
    dispose: () => { owner.dispose?.(); seam.detach(); },
  };
}

const flushTrainerOwner = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test("trainer owner reconciles parented roots, coalesces pending load, and hands off once", async () => {
  const fixture = await trainerOwnerFixture();
  fixture.owner.show();
  fixture.owner.show();
  assert.equal(fixture.loadCalls, 1);
  assert.equal(fixture.nativeCalls, 1, "native fallback is shown before the async request");
  assert.equal(fixture.trainerWindow.hidden, false);
  assert.equal(fixture.root.visible, false);
  fixture.owner.refresh("update");
  assert.equal(fixture.nativeCalls, 2, "a pending update repaints the native current snapshot");
  fixture.resolve();
  await flushTrainerOwner();
  assert.equal(fixture.syncCalls, 1, "the parented root is reconciled before the gate");
  assert.equal(fixture.root.visible, true);
  assert.equal(fixture.trainerWindow.hidden, true);
  fixture.owner.close();
  fixture.dispose();
});

test("trainer owner pending close calls the seam once and closed refresh hides stock", async () => {
  const pending = await trainerOwnerFixture();
  pending.owner.show();
  assert.equal(pending.owner.close(), true);
  assert.equal(pending.closeCalls, 1);
  pending.resolve();
  await flushTrainerOwner();
  assert.equal(pending.root.visible, false);
  pending.owner.show();
  assert.equal(pending.nativeCalls, 2, "closed pending state permits a fresh native fallback");
  pending.owner.close();
  pending.dispose();

  const visible = await trainerOwnerFixture();
  visible.owner.show();
  visible.resolve();
  await flushTrainerOwner();
  assert.equal(visible.root.visible, true);
  visible.owner.refresh("closed");
  assert.equal(visible.root.visible, false);
  assert.equal(visible.closeCalls, 0, "event-driven close does not recurse through the seam");
  visible.dispose();
});

test("trainer owner demotes on failed/rejected/throwing load and leaves native visible", async () => {
  for (const options of [
    { loadResult: { ok: false, roots: [] } },
    { loadError: new Error("addon failed") },
    { throwOnSync: true },
    { throwOnCall: true, hideCloses: true },
    { errorOnShow: true },
    { errorOnCall: true },
    { diagnosticOnShow: true },
  ]) {
    const fixture = await trainerOwnerFixture(options);
    fixture.owner.show();
    fixture.resolve(options.loadResult);
    if (options.loadError) fixture.reject(options.loadError);
    await flushTrainerOwner();
    assert.equal(fixture.failureCalls, 1, `demotion option ${JSON.stringify(options)}`);
    assert.equal(fixture.failureSawTrainer, true,
      "demotion snapshots the trainer before a partially shown root can close it");
    assert.equal(fixture.nativeCalls, 1);
    assert.equal(fixture.trainerWindow.hidden, false);
    assert.equal(fixture.root.visible, false);
    fixture.dispose();
  }
});

test("trainer owner retargets stale world/list completions and never shows stale stock", async () => {
  const world = await trainerOwnerFixture();
  world.owner.show();
  world.setContext({ nextWorld: true });
  world.resolve();
  await flushTrainerOwner();
  assert.equal(world.root.visible, false);
  assert.equal(world.loadCalls, 2, "the current world gets a fresh coalesced attempt");
  world.owner.close();
  world.dispose();

  const list = await trainerOwnerFixture();
  list.owner.show();
  list.setSignature("trainer-2");
  list.owner.refresh("update");
  list.resolve();
  await flushTrainerOwner();
  assert.equal(list.root.visible, true, "update retargets the pending owner to the current list");
  assert.equal(list.loadCalls, 1);
  list.owner.refresh("closed");
  assert.equal(list.root.visible, false);
  list.dispose();
});

test("trainer type 2 remains native and supported-to-type2 transition does not close it", async () => {
  const inert = await trainerOwnerFixture({ type: 2 });
  inert.owner.show();
  assert.equal(inert.loadCalls, 0);
  assert.equal(inert.owner.close(), false);
  inert.dispose();

  const fixture = await trainerOwnerFixture();
  fixture.owner.show();
  fixture.resolve();
  await flushTrainerOwner();
  assert.equal(fixture.root.visible, true);
  fixture.setType(2);
  fixture.owner.refresh("update");
  assert.equal(fixture.root.visible, false);
  assert.equal(fixture.closeCalls, 0);
  assert.equal(fixture.nativeCalls, 2);
  assert.equal(fixture.trainerWindow.hidden, false);
  fixture.dispose();
});

test("trainer ability prerequisites remain neutral when only raw ids are present", () => {
  const trainer = {
    ...CANNED_TRAINER,
    services: [{ ...CANNED_TRAINER.services[0], requiredAbilities: [12345, 0, 0] }],
  };
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, trainer);
  seam.attach(pump());
  seam.openTrainer();
  assert.deepEqual(api(seam, "GetTrainerServiceNumAbilityReq", 1), [0]);
  assert.deepEqual(api(seam, "GetTrainerServiceAbilityReq", 1, 1), []);
  seam.detach();
});

test("live trainer keeps raw ability prerequisites neutral and never closes type 2", () => {
  let closeCalls = 0;
  const world = {
    trainer: {
      guid: 0x701n, trainerType: 2, greeting: "profession", spells: [{
        spellId: 100, usable: 0, moneyCost: 1, pointCost: [0, 0], requiredLevel: 1,
        requiredSkillLine: 171, requiredSkillRank: 75, requiredAbilities: [12345, 0, 0],
      }],
    },
    closeTrainer: () => { closeCalls += 1; },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => ({ name: "Truthful spell", hidden: false }),
    monotonic: () => 1,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  assert.equal(seam.trainerServiceNumAbilityReq(1), 0);
  assert.equal(seam.trainerServiceAbilityReq(1, 1), undefined);
  seam.closeTrainer();
  assert.equal(closeCalls, 0);
});
