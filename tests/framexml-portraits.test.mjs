import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

// Stock SetPortraitTexture beyond the HUD/quest slots: the renderer's stock target set
// (PortraitRenderer.ts), the host that claims a Texture and lays a canvas over it
// (framexml/FrameXmlPortraits.ts) and the unit-token resolution behind it.
const {
  PortraitRenderer, StockPortraitTargets, portraitCircleMask, portraitTextureOutput,
} = await import("../dist/code/browser/PortraitRenderer.js");
const {
  createFrameXmlStockPortraits, frameXmlPortraitUnitGuid, frameXmlInteractionNpcGuid,
  FRAMEXML_DEDICATED_PORTRAIT_TEXTURES,
} = await import("../dist/code/browser/framexml/FrameXmlPortraits.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function canvas(width = 4, height = 4) {
  const value = { width, height, dataset: {}, image: undefined, clears: 0 };
  const context = {
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(image) { value.image = image; },
    clearRect() { value.image = undefined; value.clears++; },
  };
  value.getContext = () => context;
  return value;
}

/** The WebGLRenderer surface PortraitRenderer touches, recording clears, draws and readbacks. */
function fakeRenderer() {
  const state = {
    target: { name: "world" }, viewport: new THREE.Vector4(3, 4, 5, 6), scissor: new THREE.Vector4(7, 8, 9, 10),
    scissorTest: true, clear: new THREE.Color(0x123456), alpha: 0.37, autoClear: false,
    reads: 0, renders: 0, clearAlphas: [], lightProfiles: [], bones: [], scenes: new Set(), targets: [],
  };
  const records = new Map();
  const renderer = {
    extensions: { has: () => true },
    properties: { get: (material) => records.get(material) },
    getRenderTarget: () => state.target,
    setRenderTarget(value) { state.target = value; },
    getViewport: (value) => value.copy(state.viewport),
    setViewport(value, y, width, height) {
      if (value?.isVector4) state.viewport.copy(value); else state.viewport.set(value, y, width, height);
    },
    getScissor: (value) => value.copy(state.scissor),
    setScissor(value, y, width, height) {
      if (value?.isVector4) state.scissor.copy(value); else state.scissor.set(value, y, width, height);
    },
    getScissorTest: () => state.scissorTest,
    setScissorTest(value) { state.scissorTest = value; },
    getClearColor: (value) => value.copy(state.clear),
    setClearColor(value, alpha) { state.clear.copy(value); state.alpha = alpha; },
    getClearAlpha: () => state.alpha,
    clear() { state.clearAlphas.push(state.alpha); },
    render(scene) {
      state.renders++;
      state.scenes.add(scene);
      state.lightProfiles.push(scene.children.filter((child) => child.isLight && child.visible)
        .map((child) => child.type).sort().join(","));
      const bones = [];
      for (const group of scene.children) {
        if (group.name?.startsWith("portrait-") && group.visible) group.traverse((child) => { if (child.isBone) bones.push(child.position.x); });
      }
      state.bones.push(bones);
    },
    compile(scene) {
      const materials = new Set();
      scene.traverseVisible((mesh) => {
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          materials.add(material);
          if (!records.has(material)) records.set(material, { programs: new Map(), currentProgram: { isReady: () => true } });
        }
      });
      return materials;
    },
    async readRenderTargetPixelsAsync(target, _x, _y, width, height, pixels) {
      state.reads++;
      state.targets.push(target);
      for (let index = 0; index < width * height * 4; index += 4) {
        pixels[index] = 200; pixels[index + 1] = 100; pixels[index + 2] = 50; pixels[index + 3] = 255;
      }
    },
    get autoClear() { return state.autoClear; },
    set autoClear(value) { state.autoClear = value; },
  };
  return { renderer, state };
}

function source(key = "npc") {
  return {
    key, buildKey: `${key}-build`,
    model: {
      bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 2], radius: 1 }, attachments: [],
      portraitCamera: { fov: Math.PI / 4, near: 0.1, far: 20, position: [2, 0, 1], target: [0, 0, 1] },
    },
    built: {
      geometry: new THREE.BoxGeometry(1, 1, 1), materials: [new THREE.MeshBasicMaterial()],
      height: 2, texturePaths: [], ownedTextures: [],
    },
    scale: 1,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const portraitGroups = (state) => [...state.scenes].flatMap((scene) => scene.children)
  .filter((child) => child.name?.startsWith("portrait-stock:")).map((child) => child.name);
/** RGBA of a fake canvas's last putImageData at (x, y); undefined when it holds none. */
const pixel = (output, x, y) => {
  if (!output.image) return undefined;
  const at = (y * output.width + x) * 4;
  return [...output.image.data.slice(at, at + 4)];
};

// ---- renderer --------------------------------------------------------------------------------

test("a stock SetPortraitTexture target paints once and then costs no draw or readback while unchanged", async () => {
  const { renderer, state } = fakeRenderer();
  const stock = new StockPortraitTargets();
  let lookups = 0;
  const npc = source();
  const view = new PortraitRenderer(renderer, () => { lookups++; return npc; }, { stockTargets: stock });
  const hud = new Map();
  const output = canvas(60, 60);
  stock.set("stock:GossipFramePortrait", 0x701n, output);
  view.setTargets(hud);
  assert.equal(view.targetGuids().has(0x701n), true, "the talking NPC is pinned like a HUD target");
  assert.equal(view.needsPose(0x701n), true);
  assert.equal(view.render(0), 1);
  await settle();
  assert.equal(output.dataset.portraitReady, "true");
  assert.equal(output.dataset.portraitSlot, "stock:GossipFramePortrait");
  const version = stock.version;
  for (let frame = 1; frame <= 120; frame++) {
    // MerchantFrame_UpdateMerchantInfo/TradeFrame_Update repeat the same claim on every update.
    stock.set("stock:GossipFramePortrait", 0x701n, output);
    view.setTargets(hud);
    assert.equal(view.render(frame), 0);
  }
  await settle();
  assert.equal(stock.version, version, "an unchanged claim does not bump the set");
  assert.equal(state.renders, 1, "one draw for the whole visit");
  assert.equal(state.reads, 1, "one readback for the whole visit");
  assert.equal(output.clears, 1, "the painted picture is never blanked while its unit stands");
  assert.equal(view.needsPose(0x701n), false, "no world pose work once the snapshot exists");
  assert.equal(view.needsPose(0x999n), false);
  assert.ok(lookups <= 1 + 120 * 1 + 2, `source lookups stay one per frame per shown portrait (${lookups})`);
  view.dispose();
});

test("the stock picture is opaque black inside the portrait circle and transparent outside it", async () => {
  const { renderer, state } = fakeRenderer();
  const stock = new StockPortraitTargets();
  const view = new PortraitRenderer(renderer, () => source(), { stockTargets: stock });
  const npc = canvas(60, 60);
  const quest = canvas(60, 60);
  const target = canvas(60, 60);
  const character = canvas(60, 60);
  stock.set("stock:MerchantFramePortrait", 5n, npc);
  view.setTargets(new Map([["questnpc", { guid: 6n, canvas: quest }], ["target", { guid: 7n, canvas: target }],
    ["character", { guid: 8n, canvas: character }]]));
  assert.equal(view.render(0), 4);
  await settle();
  // Paint order: fixed slots (target, character, questnpc) and then the stock one.
  assert.deepEqual(state.clearAlphas, [0, 1, 1, 1], "HUD target keeps its transparent ground; SetPortraitTexture outputs clear to black");
  const alpha = (image, x, y) => image.data[(y * 60 + x) * 4 + 3];
  for (const [name, output] of [["stock", npc], ["questnpc", quest], ["character", character]]) {
    assert.equal(alpha(output.image, 0, 0), 0, `${name}: a corner is outside the ring`);
    assert.equal(alpha(output.image, 59, 59), 0);
    assert.equal(alpha(output.image, 30, 30), 255, `${name}: the middle is the unit`);
    assert.equal(alpha(output.image, 30, 1), 255, `${name}: the circle reaches the edge`);
  }
  assert.equal(alpha(target.image, 0, 0), 255, "the HUD canvas keeps the rendered alpha");
  assert.equal(portraitTextureOutput("target"), false);
  const mask = portraitCircleMask(60, 60);
  const covered = mask.reduce((sum, value) => sum + value, 0) / 255;
  assert.ok(Math.abs(covered - Math.PI * 30 * 30) < 1, `mask coverage is the disc's area (${covered})`);
  view.dispose();
});

test("closing a stock window gives back the whole surface and leaves no per-frame work", async () => {
  const { renderer, state } = fakeRenderer();
  const stock = new StockPortraitTargets();
  let lookups = 0;
  const view = new PortraitRenderer(renderer, () => { lookups++; return source(); }, { stockTargets: stock });
  const output = canvas(58, 58);
  const hud = new Map();
  stock.set("stock:BankPortraitTexture", 9n, output);
  view.setTargets(hud);
  assert.equal(view.render(0), 1);
  await settle();
  assert.equal(view.retainedBuilds().size, 1);
  assert.deepEqual(portraitGroups(state), ["portrait-stock:BankPortraitTexture"]);
  let disposed = 0;
  state.targets[0].addEventListener("dispose", () => disposed++);
  stock.delete("stock:BankPortraitTexture");
  view.setTargets(hud);
  assert.equal(disposed, 1, "the render target is disposed with the slot");
  assert.equal(view.retainedBuilds().size, 0, "no model or material shell is retained");
  assert.deepEqual(portraitGroups(state), [], "the slot's group leaves the portrait scene");
  assert.equal(view.targetGuids().has(9n), false, "the banker is no longer pinned");
  const image = output.image;
  assert.ok(image, "the hidden canvas keeps its 2D picture; the GPU side is gone");
  const clears = output.clears;
  lookups = 0;
  for (let frame = 1; frame <= 60; frame++) assert.equal(view.render(frame), 0);
  assert.equal(lookups, 0, "a closed window asks for no source");
  assert.equal(output.clears, clears, "and clears nothing");
  // The next BANKFRAME_OPENED on the same banker shows the kept picture at once and repaints once.
  stock.set("stock:BankPortraitTexture", 9n, output);
  view.setTargets(hud);
  assert.equal(output.image, image, "no blank frames while the fresh surface paints");
  assert.equal(output.dataset.portraitReady, "true");
  assert.equal(view.render(61), 1);
  await settle();
  assert.equal(output.clears, clears);
  // Another banker through the same Texture never shows the previous face.
  stock.delete("stock:BankPortraitTexture");
  view.setTargets(hud);
  stock.set("stock:BankPortraitTexture", 10n, output);
  view.setTargets(hud);
  assert.notEqual(output.image, image, "a different unit blanks the canvas first");
  assert.deepEqual(pixel(output, 29, 29), [0, 0, 0, 255], "to the pending black disc");
  assert.equal(output.dataset.portraitReady, "false");
  assert.equal(view.render(62), 1);
  await settle();
  view.clear();
  assert.deepEqual(portraitGroups(state), [], "a world clear drops stock groups");
  view.setTargets(hud);
  assert.equal(view.render(62), 1, "the set is the host's: after a world clear the open window repaints");
  view.dispose();
});

test("a stock portrait not painted yet is the black disc, not a hole onto the «?» under it", async () => {
  const { renderer } = fakeRenderer();
  const stock = new StockPortraitTargets();
  let npc; // the model is still loading
  const view = new PortraitRenderer(renderer, (guid) => (guid === 0x701n ? npc : undefined), { stockTargets: stock });
  const output = canvas(60, 60);
  const quest = canvas(60, 60);
  const target = canvas(60, 60);
  stock.set("stock:GossipFramePortrait", 0x701n, output);
  view.setTargets(new Map([["questnpc", { guid: 6n, canvas: quest }], ["target", { guid: 7n, canvas: target }]]));
  assert.deepEqual(pixel(output, 30, 30), [0, 0, 0, 255], "opaque black in the middle");
  assert.deepEqual(pixel(output, 30, 1), [0, 0, 0, 255], "out to the circle's edge");
  assert.equal(pixel(output, 0, 0)[3], 0, "the corners stay the ring's");
  assert.equal(output.dataset.portraitReady, "false");
  assert.equal(quest.image, undefined, "the quest page's book shows until its giver is painted");
  assert.equal(target.image, undefined, "a HUD canvas keeps its transparent blank");
  const clears = output.clears;
  for (let frame = 0; frame < 60; frame++) assert.equal(view.render(frame), 0);
  assert.equal(output.clears, clears, "put in once, not on every frame the model is missing");
  assert.deepEqual(pixel(output, 30, 30), [0, 0, 0, 255]);
  npc = source();
  assert.equal(view.render(60), 1);
  await settle();
  assert.equal(output.dataset.portraitReady, "true");
  assert.notDeepEqual(pixel(output, 30, 30), [0, 0, 0, 255], "then the face");
  // The host measured the canvas again for a new stage scale: a new backing store is transparent.
  output.width = 90;
  output.height = 90;
  output.image = undefined;
  assert.equal(view.render(61), 1);
  assert.deepEqual(pixel(output, 45, 45), [0, 0, 0, 255], "the resized canvas is black until the repaint lands");
  assert.equal(output.dataset.portraitReady, "false");
  await settle();
  assert.equal(output.dataset.portraitReady, "true");
  assert.equal(output.image.data.length, 90 * 90 * 4);
  view.dispose();
});

test("a slot with a canvas and no unit is blanked once, not on every frame", () => {
  const { renderer } = fakeRenderer();
  const view = new PortraitRenderer(renderer, () => source(), { stockTargets: new StockPortraitTargets() });
  const quest = canvas(60, 60);
  // A closed quest page: setQuestGiverPortrait(undefined) keeps QuestFramePortrait's canvas.
  view.setTargets(new Map([["questnpc", { guid: undefined, canvas: quest }]]));
  for (let frame = 0; frame < 60; frame++) view.render(frame);
  assert.equal(quest.clears, 1, "measured before: 60 clearRect calls for 60 idle frames");
  quest.dataset.portraitReady = "true"; // an adoption cleanup restoring an older flag
  view.render(60);
  assert.equal(quest.clears, 2, "a flag that says painted is put right once");
  view.render(61);
  assert.equal(quest.clears, 2);
  view.dispose();
});

test("a stock portrait of the player uses the player's light rig and Stand; anybody else the target's", async () => {
  const previous = game.world;
  game.world = { state: { selfGuid: 21n, objects: new Map() } };
  try {
    const { renderer, state } = fakeRenderer();
    const stock = new StockPortraitTargets();
    const liveBone = new THREE.Bone();
    liveBone.position.x = 9;
    const rigged = {
      ...source("rigged"),
      template: {
        geometry: new THREE.BufferGeometry(), clips: new Map([[0, new THREE.AnimationClip("Stand", 1, [
          new THREE.NumberKeyframeTrack("bone0.position[x]", [0, 1], [2, 2]),
        ])]]), animations: new Set([0, 1]), boneInverses: [new THREE.Matrix4()], parents: new Int16Array([-1]),
        pivots: new Float32Array([0, 0, 0]), flags: new Uint16Array([0]), billboards: [], height: 2,
      },
      liveBones: [liveBone],
    };
    const view = new PortraitRenderer(renderer, () => rigged, { stockTargets: stock });
    stock.set("stock:TradeFramePlayerPortrait", 21n, canvas());
    view.setTargets(new Map([["player", { guid: 21n, canvas: canvas() }], ["target", { guid: 22n, canvas: canvas() }]]));
    stock.set("stock:TradeFrameRecipientPortrait", 22n, canvas());
    view.setTargets(new Map([["player", { guid: 21n, canvas: canvas() }], ["target", { guid: 22n, canvas: canvas() }]]));
    assert.equal(view.render(0), 4);
    await settle();
    const [player, target, tradePlayer, tradeRecipient] = state.lightProfiles;
    assert.notEqual(player, target, "the two HUD rigs differ");
    assert.equal(tradePlayer, player, "TradeFramePlayerPortrait is lit as the player portrait");
    assert.equal(tradeRecipient, target, "TradeFrameRecipientPortrait is lit as the target portrait");
    assert.deepEqual(state.bones, [[2], [9], [2], [9]],
      "the player's own head samples Stand; another unit keeps the live world pose");
    view.dispose();
  } finally {
    game.world = previous;
  }
});

// ---- host --------------------------------------------------------------------------------------

function node(tag = "div") {
  const self = {
    tagName: tag.toUpperCase(), children: [], parentElement: null, dataset: {}, className: "",
    style: {}, width: 0, height: 0, offsetWidth: 0, offsetHeight: 0,
    get nextSibling() {
      const siblings = self.parentElement?.children ?? [];
      return siblings[siblings.indexOf(self) + 1] ?? null;
    },
    insertBefore(child, sibling) {
      child.remove();
      const index = sibling ? self.children.indexOf(sibling) : -1;
      self.children.splice(index < 0 ? self.children.length : index, 0, child);
      child.parentElement = self;
      return child;
    },
    append(child) { self.insertBefore(child, null); },
    remove() {
      const parent = self.parentElement;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(self), 1);
      self.parentElement = null;
    },
  };
  return self;
}

/** A texture the host sees: the bridge's frame fields it reads, and a DOM element for it. */
function world() {
  const listeners = new Set();
  const scaleListeners = new Set();
  const frames = new Map();
  const elements = new Map();
  let subscriptions = 0;
  let elementReads = 0;
  let rectReads = 0;
  // The stage is drawn at a UI scale of 1.2, as at 1920x919.
  let scale = 1.2;
  const hooks = new Map();
  const bridge = {
    layoutVersion: 0,
    isVisible(frame) { for (let at = frame; at; at = at.parent) if (!at.visible) return false; return true; },
    subscribe(listener) {
      subscriptions++;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    HookScript(frame, script, handler) {
      const key = `${frame.name}.${script}`;
      hooks.set(key, [...(hooks.get(key) ?? []), handler]);
      return true;
    },
    // FrameXmlUiBridge.SetTexture: the same path again is no change and notifies nobody.
    SetTexture(frame, value) {
      if (typeof value !== "string") return false;
      if (frame.texture === value) return true;
      frame.texture = value;
      mutate();
      return true;
    },
    update(frame, change, kind = "layout") {
      change(frame);
      mutate(kind);
      return true;
    },
  };
  const window = { name: "GossipFrame", type: "Frame", visible: true };
  const layer = node();
  const texture = (name, picture = "") => {
    const frame = { name, type: "Texture", visible: true, parent: window, texture: picture };
    const element = node("img");
    element.style = { position: "absolute", left: "8px", top: "-7px", width: "60px", height: "60px", zIndex: "100" };
    element.getBoundingClientRect = () => {
      rectReads++;
      return { width: parseFloat(element.style.width) * scale, height: parseFloat(element.style.height) * scale };
    };
    layer.append(element);
    frames.set(name, frame);
    elements.set(frame, element);
    return frame;
  };
  const mutate = (kind = "layout") => {
    if (kind === "layout") bridge.layoutVersion++;
    for (const listener of [...listeners]) listener();
  };
  // The bridge's Show/Hide: the flag, the show tree's OnShow/OnHide, then the layout notification.
  const setShown = (shown) => {
    window.visible = shown;
    for (const hook of hooks.get(`GossipFrame.${shown ? "OnShow" : "OnHide"}`) ?? []) hook(window);
    mutate();
  };
  const tasks = [];
  const document = { createElement: (tag) => node(tag) };
  return {
    bridge, window, layer, texture, mutate, setShown, tasks, document, elements, hooks,
    get listeners() { return listeners.size; },
    get scaleWatchers() { return scaleListeners.size; },
    get subscriptions() { return subscriptions; },
    get elementReads() { return elementReads; },
    get rectReads() { return rectReads; },
    elementFor: (frame) => { elementReads++; return elements.get(frame); },
    // The mount's window resize and settings route: the stage's scale changes, no frame does.
    watchScale(listener) {
      scaleListeners.add(listener);
      return () => scaleListeners.delete(listener);
    },
    rescale(next) {
      scale = next;
      for (const listener of [...scaleListeners]) listener();
    },
    run() { while (tasks.length) tasks.shift()(); },
  };
}

function host(fixture, resolve, targets = new StockPortraitTargets()) {
  const portraits = createFrameXmlStockPortraits({
    bridge: fixture.bridge, elementFor: fixture.elementFor, resolve, targets,
    document: fixture.document, schedule: (task) => fixture.tasks.push(task), watchScale: fixture.watchScale,
  });
  return { portraits, targets };
}

const STAND_IN = "Interface\\CharacterFrame\\TempPortrait";
const BOOK = "Interface\\QuestFrame\\UI-QuestLog-BookIcon";

test("SetPortraitTexture claims a shown stock Texture once: a canvas over it, one renderer target", () => {
  const fixture = world();
  // MerchantFramePortrait-like: the XML gives the Texture no file.
  const gossip = fixture.texture("GossipFramePortrait");
  let resolves = 0;
  const { portraits, targets } = host(fixture, (unit) => { resolves++; return unit === "npc" ? 0x701n : undefined; });
  assert.equal(fixture.subscriptions, 0, "no claim, no subscription");
  portraits.setPortraitTexture(gossip, "npc");
  fixture.run();
  const target = targets.get("stock:GossipFramePortrait");
  assert.equal(target?.guid, 0x701n);
  const canvas = target.canvas;
  const element = fixture.elements.get(gossip);
  assert.equal(element.nextSibling, canvas, "directly above the stock picture, in its layer");
  assert.equal(canvas.className, "portrait-canvas portrait-canvas-stock");
  assert.deepEqual([canvas.style.left, canvas.style.top, canvas.style.width, canvas.style.height, canvas.style.zIndex],
    ["8px", "-7px", "60px", "60px", "100"]);
  assert.equal(canvas.style.pointerEvents, "none");
  assert.equal(canvas.style.display, "block");
  assert.deepEqual([canvas.width, canvas.height], [72, 72], "backing store follows the 60px Texture as drawn at 1.2");
  assert.equal(fixture.rectReads, 1, "one layout read, when the window opens");
  assert.equal(gossip.texture, STAND_IN, "the client's call replaces the picture: its «?» art lies under the canvas");
  assert.equal(portraits.active, 1);
  const version = targets.version;
  const layout = fixture.bridge.layoutVersion;
  for (let call = 0; call < 200; call++) portraits.setPortraitTexture(gossip, "npc");
  assert.equal(fixture.tasks.length, 0, "a repeated call schedules nothing");
  assert.equal(targets.version, version, "and changes nothing the renderer reads");
  assert.equal(fixture.bridge.layoutVersion, layout, "nor anything the DOM renderer syncs");
  assert.equal(resolves, 201);
  fixture.mutate();
  fixture.run();
  assert.equal(fixture.rectReads, 1, "a later layout change does not read the layout again");
  portraits.dispose();
});

test("the claim follows its window: hidden gives the surface back, shown takes it again, a closed window costs nothing", () => {
  const fixture = world();
  const bank = fixture.texture("BankPortraitTexture");
  const { portraits, targets } = host(fixture, () => 9n);
  // BankFrame_OnEvent calls SetPortraitTexture before ShowUIPanel.
  fixture.window.visible = false;
  portraits.setPortraitTexture(bank, "npc");
  fixture.run();
  assert.equal(targets.size, 0, "a hidden Texture has no renderer target");
  assert.equal(portraits.claims, 1);
  assert.equal(fixture.listeners, 0, "a closed window's claim does not watch the bridge");
  assert.equal(fixture.scaleWatchers, 0, "nor the stage's scale");
  fixture.setShown(true);
  fixture.run();
  const canvas = targets.get("stock:BankPortraitTexture")?.canvas;
  assert.ok(canvas, "ShowUIPanel's OnShow activates it");
  assert.equal(fixture.listeners, 1, "a shown portrait watches for Lua's own picture and a hide");
  assert.equal(fixture.scaleWatchers, 1, "and for a new stage scale");
  const reads = fixture.elementReads;
  for (let frame = 0; frame < 100; frame++) fixture.mutate("paint");
  assert.equal(fixture.tasks.length, 0, "cooldown sweeps and bar fills do not reconcile");
  assert.equal(fixture.elementReads, reads);
  fixture.setShown(false);
  fixture.run();
  assert.equal(targets.size, 0, "closing the bank releases the renderer surface");
  assert.equal(canvas.style.display, "none");
  assert.equal(portraits.claims, 1, "the claim waits for the next show");
  assert.equal(fixture.listeners, 0, "with the window closed the host stops listening");
  assert.equal(fixture.scaleWatchers, 0);
  for (let frame = 0; frame < 100; frame++) fixture.mutate("layout");
  fixture.rescale(1.5);
  fixture.rescale(1.2);
  assert.equal(fixture.tasks.length, 0, "an idle HUD's layout changes (timers, text) and resizes cost the host nothing");
  // Shown again by its own OnShow (UIParent returning from the full-screen map, say) with no new
  // SetPortraitTexture: the same canvas comes back.
  fixture.setShown(true);
  fixture.run();
  assert.equal(targets.get("stock:BankPortraitTexture")?.canvas, canvas, "the same canvas returns");
  portraits.dispose();
  assert.equal(targets.size, 0);
  assert.equal(canvas.parentElement, null, "dispose removes the canvas");
  assert.equal(fixture.listeners, 0, "and unsubscribes");
  assert.equal(fixture.scaleWatchers, 0);
  fixture.setShown(false);
  fixture.setShown(true);
  assert.equal(fixture.tasks.length, 0, "a disposed host's window hooks do nothing");
});

test("Lua's own picture, a unit without a model and a HUD portrait leave the stock Texture alone", () => {
  const fixture = world();
  const gossip = fixture.texture("GossipFramePortrait", "Interface\\CharacterFrame\\TempPortrait");
  const player = fixture.texture("PlayerPortrait");
  let npc = 0x701n;
  const asked = [];
  const { portraits, targets } = host(fixture, (unit) => { asked.push(unit); return unit === "npc" ? npc : undefined; });
  portraits.setPortraitTexture(gossip, "npc");
  fixture.run();
  const canvas = targets.get("stock:GossipFramePortrait").canvas;
  // GossipFrameUpdate for a game object: UnitExists("npc") is false and the book goes in.
  gossip.texture = "Interface\\QuestFrame\\UI-QuestLog-BookIcon";
  fixture.mutate();
  fixture.run();
  assert.equal(targets.size, 0, "the book wins over an earlier creature's face");
  assert.equal(canvas.parentElement, null);
  assert.equal(portraits.claims, 0);
  assert.equal(fixture.listeners, 0, "the last claim gone, the host stops listening");
  portraits.setPortraitTexture(gossip, "npc");
  fixture.run();
  assert.equal(targets.size, 1);
  npc = undefined; // the next NPC is a mailbox/chest, or streamed out
  portraits.setPortraitTexture(gossip, "npc");
  assert.equal(targets.size, 0, "a unit with no model releases the face at once");
  asked.length = 0;
  for (const name of FRAMEXML_DEDICATED_PORTRAIT_TEXTURES) {
    portraits.setPortraitTexture({ name, type: "Texture", visible: true, texture: "" }, "player");
  }
  portraits.setPortraitTexture(player, "player");
  portraits.setPortraitTexture({ name: "GossipFrame", type: "Frame", visible: true, texture: "" }, "npc");
  assert.deepEqual(asked, [], "dedicated HUD textures and non-Textures are not even resolved");
  assert.equal(portraits.claims, 0);
  portraits.dispose();
});

test("a chest's gossip after an NPC's shows the book, even when it is the picture the NPC's claim found", () => {
  // No «?» wrapper of the NPC lane here: GossipFrameUpdate alone, which SetTextures the book for a
  // game object and calls SetPortraitTexture(GossipFramePortrait, "npc") for a creature.
  const fixture = world();
  const gossip = fixture.texture("GossipFramePortrait");
  const { portraits, targets } = host(fixture, () => 0x701n);
  const gossipUpdate = (creature) => {
    if (creature) portraits.setPortraitTexture(gossip, "npc");
    else fixture.bridge.SetTexture(gossip, BOOK);
  };
  for (let visit = 1; visit <= 2; visit++) {
    fixture.setShown(true);
    gossipUpdate(false); // a lectern or a chest
    fixture.run();
    assert.equal(targets.size, 0, `visit ${visit}: the game object shows the book`);
    fixture.setShown(false);
    fixture.run();
    fixture.setShown(true);
    gossipUpdate(true); // the next conversation is a creature's
    fixture.run();
    assert.equal(targets.get("stock:GossipFramePortrait")?.guid, 0x701n, `visit ${visit}: the creature's face`);
    assert.equal(gossip.texture, STAND_IN, "the claim replaced the book");
    fixture.setShown(false);
    fixture.run();
  }
  // Put back while the window is closed, then shown by GossipFrame's own OnShow.
  gossipUpdate(false);
  fixture.setShown(true);
  fixture.run();
  assert.deepEqual([...targets.entries().keys()], [], "the book the NPC's claim found is still Lua's own picture");
  assert.equal(portraits.claims, 0);
  portraits.dispose();
});

test("a new stage scale measures a shown portrait's backing store again, once", () => {
  const fixture = world();
  const merchant = fixture.texture("MerchantFramePortrait");
  const { portraits, targets } = host(fixture, () => 5n);
  portraits.setPortraitTexture(merchant, "npc");
  fixture.run();
  const canvas = targets.get("stock:MerchantFramePortrait").canvas;
  assert.deepEqual([canvas.width, canvas.height], [72, 72]);
  const reads = fixture.rectReads;
  // The UI-scale setting or a window resize: `fit` rescales the stage; no frame changes, so the
  // bridge raises nothing.
  fixture.rescale(1.5);
  assert.equal(fixture.tasks.length, 1, "one reconcile for the change");
  fixture.run();
  assert.deepEqual([canvas.width, canvas.height], [90, 90], "the backing store follows the drawn size");
  assert.equal(fixture.rectReads, reads + 1, "one layout read");
  assert.equal(targets.get("stock:MerchantFramePortrait").canvas, canvas, "the same canvas");
  fixture.mutate();
  fixture.run();
  assert.equal(fixture.rectReads, reads + 1, "an ordinary reconcile after it reads no layout");
  portraits.dispose();
});

test("a canvas waits for the renderer's element and follows the Texture's geometry", () => {
  const fixture = world();
  const trainer = fixture.texture("ClassTrainerFramePortrait");
  const element = fixture.elements.get(trainer);
  fixture.elements.delete(trainer); // LoadAddOn ran the call before renderer.addRoots
  const { portraits, targets } = host(fixture, () => 4n);
  portraits.setPortraitTexture(trainer, "npc");
  fixture.run();
  assert.equal(targets.size, 0);
  assert.equal(fixture.listeners, 1, "waiting for its element on the bridge");
  // A claim made while the corpus loads, before the DOM renderer and the mount's cleanup exist,
  // holds no window-level listener a failed mount could leave behind.
  assert.equal(fixture.scaleWatchers, 0, "no canvas on screen, no scale watch");
  fixture.elements.set(trainer, element);
  fixture.mutate();
  fixture.run();
  const canvas = targets.get("stock:ClassTrainerFramePortrait").canvas;
  assert.equal(element.nextSibling, canvas);
  assert.equal(fixture.scaleWatchers, 1);
  element.style.left = "12px";
  element.style.width = "64px";
  element.style.height = "64px";
  fixture.mutate();
  fixture.run();
  assert.deepEqual([canvas.style.left, canvas.width], ["12px", 77], "a new authored size is measured again");
  portraits.dispose();
});

// ---- unit tokens -------------------------------------------------------------------------------

function unitObject(guid, typeId, displayId) {
  const fields = new Map();
  if (displayId !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayId);
  return { guid, typeId, fields };
}

test("unit tokens resolve to a drawable unit: the interaction NPC in the client's order, game objects never", () => {
  const objects = new Map([
    [0x10n, unitObject(0x10n, 3, 1234)], [0x11n, unitObject(0x11n, 3, 1235)],
    [0x12n, unitObject(0x12n, 4, 49)], [0x13n, unitObject(0x13n, 3, 0)],
    // A game object's fields overlap the unit block: its word at UNIT_FIELD_DISPLAYID is not 0.
    [0x14n, unitObject(0x14n, 5, 1234)], [0x15n, unitObject(0x15n, 3, 77)],
  ]);
  const world = {
    state: { objects }, tradeOpen: false, tradePartnerGuid: 0n, vendor: undefined, trainer: undefined,
    auctioneerGuid: 0n, gossip: undefined, taxiMenu: undefined, bankerGuid: undefined,
  };
  const seam = {
    questNpcPortraitGuid: () => 0x15n,
    unitGuid: (unit) => ({ player: "0x0000000000000012", party2: "0x0000000000000011", pet: "0x0000000000000013" })[unit],
  };
  const resolve = (unit) => frameXmlPortraitUnitGuid(world, seam, unit);
  assert.equal(resolve("npc"), undefined, "no interaction open");
  world.gossip = { guid: 0x10n };
  assert.equal(resolve("NPC"), 0x10n, "GossipFrame's talker; the token is case-insensitive");
  world.auctioneerGuid = 0x11n;
  assert.equal(frameXmlInteractionNpcGuid(world), 0x11n, "the auctioneer before a stale gossip");
  world.trainer = { guid: 0x10n };
  assert.equal(resolve("npc"), 0x10n, "the trainer before the auctioneer");
  world.vendor = { guid: 0x11n };
  assert.equal(resolve("npc"), 0x11n, "the vendor before the trainer");
  world.tradeOpen = true;
  world.tradePartnerGuid = 0x12n;
  assert.equal(resolve("npc"), 0x12n, "TradeFrame's recipient first, as UnitName(\"NPC\") answers");
  world.tradeOpen = false;
  world.vendor = undefined; world.trainer = undefined; world.auctioneerGuid = 0n; world.gossip = { guid: 0x14n };
  assert.equal(resolve("npc"), undefined, "a game object's gossip keeps the book");
  world.gossip = { guid: 0x13n };
  assert.equal(resolve("npc"), undefined, "a unit with no display yet has nothing to draw");
  world.gossip = { guid: 0x99n };
  assert.equal(resolve("npc"), undefined, "an NPC out of view has no model here");
  assert.equal(resolve("player"), 0x12n);
  assert.equal(resolve("party2"), 0x11n);
  assert.equal(resolve("pet"), undefined, "displayId 0");
  assert.equal(resolve("focus"), undefined);
  assert.equal(resolve("questnpc"), 0x15n);
  assert.equal(frameXmlPortraitUnitGuid(undefined, seam, "player"), undefined, "no world, no portrait");
});

test("the micro-button's face is a stock claim whose canvas carries the Texture's crop and half alpha", () => {
  const fixture = world();
  // MainMenuBarMicroButtons.xml: an 18x25 Texture showing 0.2..0.8 x 0.0666..0.9 of the picture.
  const face = fixture.texture("MicroButtonPortrait");
  face.texCoords = { left: 0.2, right: 0.8, top: 0.0666, bottom: 0.9 };
  face.alpha = 1;
  const element = fixture.elements.get(face);
  element.style.width = "18px";
  element.style.height = "25px";
  const gossip = fixture.texture("GossipFramePortrait");
  gossip.alpha = 1;
  const { portraits, targets } = host(fixture, (unit) => (unit === "player" ? 0x12n : unit === "npc" ? 0x701n : undefined));
  assert.equal(FRAMEXML_DEDICATED_PORTRAIT_TEXTURES.has("MicroButtonPortrait"), false,
    "no dedicated slot paints it, so the stock call must");
  portraits.setPortraitTexture(face, "player");
  portraits.setPortraitTexture(gossip, "npc");
  fixture.run();
  const target = targets.get("stock:MicroButtonPortrait");
  assert.equal(target?.guid, 0x12n, "the player's head, as PlayerFrame's");
  const canvas = target.canvas;
  assert.equal(element.nextSibling, canvas);
  assert.deepEqual([canvas.style.width, canvas.style.height], ["18px", "25px"], "the Texture's box");
  assert.equal(canvas.dataset.framexmlTexcoords, "0.2:0.8:0.0666:0.9",
    "the stage stylesheet crops the canvas by the same attribute as the picture");
  assert.equal(canvas.style["--framexml-texcoord-inset"],
    `${0.0666 * 100}% ${(1 - 0.8) * 100}% ${(1 - 0.9) * 100}% ${0.2 * 100}%`, "spelled as FrameXmlDomRenderer spells it");
  // 25px drawn at 1.2 is 30px on screen; the box shows 60% of the picture, so the picture is 50px.
  assert.deepEqual([canvas.width, canvas.height], [50, 50], "the backing store keeps the face at the box's density");
  assert.equal(canvas.style.opacity ?? "", "");
  const uncropped = targets.get("stock:GossipFramePortrait").canvas;
  assert.equal(uncropped.dataset.framexmlTexcoords, undefined, "an uncropped picture's canvas carries no crop");
  assert.equal(uncropped.style["--framexml-texcoord-inset"], undefined);
  const claimed = targets.version;

  // CharacterFrame opens: CharacterMicroButton_SetPushed's SetTexCoord and SetAlpha(0.5) are
  // paint-only mutations, which bump no layout revision.
  face.texCoords = { left: 0.2666, right: 0.8666, top: 0, bottom: 0.8333 };
  face.alpha = 0.5;
  element.style.opacity = "0.5";
  const reads = fixture.rectReads;
  fixture.mutate("paint");
  assert.equal(fixture.tasks.length, 1, "a claimed Texture's own paint change reconciles");
  fixture.run();
  assert.equal(canvas.dataset.framexmlTexcoords, "0.2666:0.8666:0:0.8333", "the pushed crop");
  assert.equal(canvas.style["--framexml-texcoord-inset"],
    `${0 * 100}% ${(1 - 0.8666) * 100}% ${(1 - 0.8333) * 100}% ${0.2666 * 100}%`);
  assert.equal(canvas.style.opacity, "0.5", "and the half alpha");
  assert.equal(fixture.rectReads, reads + 1, "a new crop measures the backing store once");
  assert.deepEqual([canvas.width, canvas.height], [50, 50]);
  for (let sweep = 0; sweep < 100; sweep++) fixture.mutate("paint");
  assert.equal(fixture.tasks.length, 0, "everyone else's paint changes still cost nothing");
  assert.equal(fixture.rectReads, reads + 1);

  // CharacterFrame closes: CharacterMicroButton_SetNormal.
  face.texCoords = { left: 0.2, right: 0.8, top: 0.0666, bottom: 0.9 };
  face.alpha = 1;
  element.style.opacity = "";
  fixture.mutate("paint");
  fixture.run();
  assert.equal(canvas.dataset.framexmlTexcoords, "0.2:0.8:0.0666:0.9");
  assert.equal(canvas.style.opacity ?? "", "");
  assert.equal(targets.get("stock:MicroButtonPortrait").canvas, canvas, "the same canvas throughout");
  assert.equal(targets.version, claimed, "a crop or alpha change is nothing the renderer reads: no repaint");

  // UNIT_PORTRAIT_UPDATE("player") repeats the claim: nothing to do.
  const version = targets.version;
  portraits.setPortraitTexture(face, "player");
  assert.equal(fixture.tasks.length, 0);
  assert.equal(targets.version, version);
  portraits.dispose();
  assert.equal(canvas.parentElement, null, "unmount removes the canvas");
  assert.equal(targets.size, 0);
});

// ---- mount -------------------------------------------------------------------------------------

test("both teardowns of a published mount release the stock portrait host, the add-on overlay's too", async () => {
  // Source-level: a mount needs the lifecycle suite's whole fake page. The host exists in both
  // modes (an add-on's own SetPortraitTexture claims a Texture over the native HUD), and the
  // add-on overlay's teardown is an early-returning branch of its own.
  const source = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  const body = /\nfunction cleanupPublishedMount\([^)]*\): void \{\n([\s\S]*?)\n\}\n/.exec(source)?.[1];
  assert.ok(body, "cleanupPublishedMount");
  const branch = /\n {2}if \(record\.addonsOnly\) \{\n([\s\S]*?)\n {4}return;\n {2}\}\n/.exec(body);
  assert.ok(branch, "the add-on overlay's branch");
  const release = /record\.stockPortraitsCleanup\?\.\(\)/;
  assert.match(branch[1], release, "the add-on overlay's teardown disposes the host");
  assert.match(body.slice(branch.index + branch[0].length), release, "and so does the full UI's");
  assert.match(source, /resources\.stockPortraitsCleanup = /, "for the host every mount creates");
});
