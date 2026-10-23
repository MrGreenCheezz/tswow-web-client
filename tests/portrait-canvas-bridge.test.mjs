// 22.10 ARC-2 S3b: the portraits' canvases are the page's. The renderer takes plain inputs and queues plain
// canvas operations (PortraitTargetData.ts); PortraitCanvasBridge.ts applies them with the 2D calls and dataset
// writes PortraitRenderer.ts made itself before.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { PortraitRenderer, portraitCircleMask } from "../dist/code/browser/PortraitRenderer.js";
import {
  PORTRAIT_STOCK_GROUND, PortraitCanvasBridge, StockPortraitTargets,
} from "../dist/code/browser/PortraitCanvasBridge.js";

function canvas(width, height) {
  const value = { width, height, dataset: {}, image: undefined, contexts: 0, clears: 0 };
  const context = {
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(image) { value.image = image; },
    clearRect() { value.image = undefined; value.clears++; },
  };
  value.getContext = (kind) => { assert.equal(kind, "2d"); value.contexts++; return context; };
  return value;
}

/** A readback of every byte a different value, alpha included, so a flip, a conversion or a mask shows. */
function readbackByte(index) {
  return (index * 37 + 11) & 255;
}

function fakeRenderer() {
  const state = {
    target: null, viewport: new THREE.Vector4(), scissor: new THREE.Vector4(), scissorTest: false,
    clear: new THREE.Color(), alpha: 1, autoClear: true, pending: [],
  };
  const renderer = {
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
    clear() {},
    render() {},
    readRenderTargetPixelsAsync(_target, _x, _y, _width, _height, pixels) {
      return new Promise((resolve) => state.pending.push(() => {
        for (let index = 0; index < pixels.length; index++) pixels[index] = readbackByte(index);
        resolve(pixels);
      }));
    },
    get autoClear() { return state.autoClear; },
    set autoClear(value) { state.autoClear = value; },
  };
  return { renderer, state };
}

function source() {
  return {
    key: "bridge",
    model: {
      bounds: { min: [-1, -1, 0], max: [1, 1, 2], radius: 1 }, attachments: [],
      portraitCamera: { fov: Math.PI / 4, near: 0.1, far: 10, position: [2, 0, 1], target: [0, 0, 1] },
    },
    built: { geometry: new THREE.BufferGeometry(), materials: [new THREE.MeshBasicMaterial()], height: 2,
      texturePaths: [], ownedTextures: [] },
    scale: 1,
  };
}

/** The pre-S3b `#finishReadback` conversion, verbatim in effect: rows flipped, sRGB encoded, stock alpha masked. */
function oldDirectPixels(width, height, opaqueGround) {
  const srgb = (byte) => {
    const linear = byte / 255;
    const value = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, value)) * 255);
  };
  const out = new Uint8ClampedArray(width * height * 4);
  const circle = opaqueGround ? portraitCircleMask(width, height) : undefined;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((height - y - 1) * width + x) * 4;
      const to = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) out[to + channel] = srgb(readbackByte(from + channel));
      out[to + 3] = circle ? circle[y * width + x] : readbackByte(from + 3);
    }
  }
  return out;
}

async function settle(state) {
  for (const resolve of state.pending.splice(0)) resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/** Whether `value` holds a DOM-ish canvas anywhere (anything with a getContext). */
function holdsCanvas(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (typeof value.getContext === "function") return true;
  const children = value instanceof Map ? [...value.keys(), ...value.values()] : Object.values(value);
  return children.some((child) => holdsCanvas(child, seen));
}

test("the renderer gets and gives plain structured-clonable data and touches no canvas", async () => {
  const { renderer, state } = fakeRenderer();
  const stock = new StockPortraitTargets();
  const bridge = new PortraitCanvasBridge(stock);
  const outputs = [];
  const view = new PortraitRenderer(renderer, () => source(), { outputs });
  const hud = canvas(6, 4);
  const gossip = canvas(8, 8);
  stock.set("stock:GossipFramePortrait", 9n, gossip);
  const inputs = bridge.inputs(new Map([["target", { guid: 7n, canvas: hud }]]));
  assert.equal(holdsCanvas(inputs), false, "no canvas in what the renderer is given");
  assert.deepEqual(structuredClone(inputs).targets.get("target"),
    { guid: 7n, canvas: bridge.canvasId(hud), width: 6, height: 4, stockGround: false, ready: undefined });
  view.setTargets(structuredClone(inputs));
  assert.equal(view.render(0), 2);
  await settle(state);
  assert.deepEqual(outputs.map((output) => output.kind), ["clear", "clear", "paint", "paint"],
    "the HUD row's and the stock window's blanks, then both pictures, in order");
  const cloned = structuredClone(outputs);
  assert.equal(holdsCanvas(cloned), false);
  const paint = cloned.find((output) => output.kind === "paint" && output.slot === "target");
  assert.ok(paint.pixels instanceof Uint8ClampedArray);
  assert.deepEqual([paint.canvas, paint.guid, paint.width, paint.height], [bridge.canvasId(hud), 7n, 6, 4]);
  assert.equal(hud.contexts + gossip.contexts, 0, "the canvases are not touched until the page drains");
  assert.equal(hud.dataset.portraitReady, undefined);
  bridge.drain(cloned);
  assert.equal(hud.dataset.portraitReady, "true", "a cloned queue paints the same as the live one");
  assert.equal(gossip.dataset.portraitSlot, "stock:GossipFramePortrait");
  assert.equal(cloned.length, 0, "drained operations are taken");
  view.dispose();
});

for (const ground of ["hud", "stock-ground"]) {
  test(`the page paints the ${ground} picture exactly as the old direct readback path did`, async () => {
    const { renderer, state } = fakeRenderer();
    const bridge = new PortraitCanvasBridge(new StockPortraitTargets());
    const outputs = [];
    const view = new PortraitRenderer(renderer, () => source(), { outputs, onOutputs: () => bridge.drain(outputs) });
    const output = canvas(7, 5);
    if (ground === "stock-ground") output.dataset[PORTRAIT_STOCK_GROUND] = "true";
    view.setTargets(bridge.inputs(new Map([["target", { guid: 3n, canvas: output }]])));
    assert.equal(output.dataset.portraitReady, "false", "the new target's blank landed with the push");
    assert.equal(view.render(0), 1);
    await settle(state);
    assert.deepEqual([...output.image.data], [...oldDirectPixels(7, 5, ground === "stock-ground")]);
    assert.equal(output.dataset.portraitReady, "true");
    assert.equal(output.dataset.portraitSlot, "target");
    assert.equal(outputs.length, 0, "every operation was applied as it was queued");
    view.dispose();
  });
}

test("a paint the page refuses — its canvas measured again meanwhile — is painted again on the next frame", async () => {
  const { renderer, state } = fakeRenderer();
  const bridge = new PortraitCanvasBridge(new StockPortraitTargets());
  const outputs = [];
  const view = new PortraitRenderer(renderer, () => source(), { outputs, onOutputs: () => bridge.drain(outputs) });
  const output = canvas(4, 4);
  const targets = new Map([["player", { guid: 1n, canvas: output }]]);
  view.setTargets(bridge.inputs(targets));
  assert.equal(view.render(0), 1);
  // Between frames the host measures the canvas for a new size, and back, before the next push.
  output.width = 8;
  await settle(state);
  assert.equal(output.image, undefined, "the old size's picture is not put on the new backing store");
  assert.equal(output.dataset.portraitReady, "false");
  output.width = 4;
  view.setTargets(bridge.inputs(targets));
  assert.equal(view.render(1), 1, "the refused paint is retried, as the renderer's own failed paint was");
  await settle(state);
  assert.equal(output.dataset.portraitReady, "true");
  view.setTargets(bridge.inputs(targets));
  assert.equal(view.render(2), 0, "a refusal is handed over once");
  view.dispose();
});

test("clear blanks the page's canvases through the same operations", async () => {
  const { renderer, state } = fakeRenderer();
  const bridge = new PortraitCanvasBridge(new StockPortraitTargets());
  const outputs = [];
  const view = new PortraitRenderer(renderer, () => source(), { outputs, onOutputs: () => bridge.drain(outputs) });
  const player = canvas(4, 4);
  const target = canvas(4, 4);
  view.setTargets(bridge.inputs(new Map([["player", { guid: 1n, canvas: player }], ["target", { guid: 2n, canvas: target }]])));
  view.render(0);
  await settle(state);
  assert.ok(player.image && target.image);
  view.clear();
  for (const output of [player, target]) {
    assert.equal(output.image, undefined, "world exit clears the previous character image");
    assert.equal(output.dataset.portraitReady, "false");
  }
  view.dispose();
});

test("sources: the renderer side holds no DOM canvas, and the page drains where it used to be painted", async () => {
  const read = (path) => readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");
  const [portraitRenderer, world, portraits, main, loop, enterWorld, context, workerMount] = await Promise.all([
    read("PortraitRenderer.ts"), read("WorldRenderer3D.ts"), read("ui/Portraits.ts"), read("main.ts"),
    read("game/Loop.ts"), read("app/EnterWorld.ts"), read("game/Context.ts"), read("app/RenderWorkerMount.ts"),
  ]);
  for (const [name, source] of [["PortraitRenderer.ts", portraitRenderer], ["WorldRenderer3D.ts", world]]) {
    assert.doesNotMatch(source, /getContext\("2d"\)|ImageData|putImageData|\.dataset\b|dataset\[/, name);
  }
  assert.doesNotMatch(portraitRenderer, /HTMLCanvasElement/);
  // The world canvas itself (ARC-2 S1) is the only canvas type left in the world renderer.
  assert.equal((world.match(/HTMLCanvasElement/g) ?? []).length, 3);
  assert.match(world, /outputs: this\.#results\.portraits, onOutputs: \(\) => this\.#portraitOutputListener\?\.\(\)/);
  assert.match(portraits, /renderer\?\.setPortraitTargets\(canvasBridge\.inputs\(targets\)\)/);
  // 22.10 ARC-2 S6b: main.ts builds the in-page renderer only without the render worker; that branch,
  // and the worker's in-page fallback, attach the page's portrait outputs to the renderer they build.
  assert.match(main, /const renderer = new WorldRenderer3D\(world3dCanvas\);\r?\n\s*game\.renderer = renderer;\r?\n\s*attachPortraitOutputs\(renderer\);/);
  assert.match(workerMount, /const renderer = new WorldRenderer3D\(canvas\);\r?\n\s*attachPortraitOutputs\(renderer\);/);
  const drained = loop.indexOf("drainPortraitOutputs(renderer);");
  assert.ok(drained > loop.indexOf("renderer.renderPortraits(now);") && drained < loop.indexOf("applyPortraitVisibility();", drained),
    "after the portrait pass, before the fallback icons read the ready flags");
  for (const source of [enterWorld, context]) assert.match(source, /game\.renderer\?\.clearPortraits\(\);/);
});
