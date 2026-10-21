// 21.10 ARC-2 S1 — the world renderer reads its environment from a RenderHost, not from the page.
//
// The renderer is to move into a DedicatedWorker drawing into an OffscreenCanvas, where `window`,
// `document`, `location`, `ResizeObserver` and `<img>` do not exist. This slice changes nothing on
// the page: `pageRenderHost` answers exactly as the renderer's own reads did, and these tests hold
// both halves — the page answers, and the renderer's source and import closure staying page-free.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRenderCanvas, pageRenderHost } from "../dist/code/browser/RenderHost.js";
import { loadImageTexture } from "../dist/code/browser/TextureLoad.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function withGlobals(values, run) {
  const previous = new Map(Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    return run();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("the page host answers as the renderer's own reads did", () => {
  const observers = [];
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  }
  withGlobals({
    window: { devicePixelRatio: 1.25 },
    location: { search: "?poseworker=0&poseworkers=3" },
    ResizeObserver: FakeResizeObserver,
  }, () => {
    const canvas = { clientWidth: 1280, clientHeight: 720 };
    const host = pageRenderHost(canvas);
    assert.equal(host.devicePixelRatio(), 1.25, "unclamped: the renderer keeps its own `|| 1` and `min(…, 2)`");
    assert.deepEqual(host.canvasCssSize(), { width: 1280, height: 720 });
    canvas.clientWidth = 1000;
    assert.deepEqual(host.canvasCssSize(), { width: 1000, height: 720 }, "a layout read every time it is asked");
    assert.equal(host.queryFlags().get("poseworker"), "0");
    assert.equal(host.queryFlags().get("poseworkers"), "3");
    assert.equal(host.loadTexture, loadImageTexture, "the one bitmap path, not a second loader");

    const sizes = [];
    const unsubscribe = host.observeCanvasCssSize((size) => sizes.push(size));
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].targets, [canvas]);
    observers[0].callback([
      { contentRect: { width: 10, height: 10 } },
      { contentRect: { width: 1599.5, height: 899.4 } },
    ]);
    assert.deepEqual(sizes, [{ width: 1600, height: 899 }], "the last entry, rounded as clientWidth rounds");
    observers[0].callback([]);
    assert.equal(sizes.length, 1, "an empty batch says nothing");
    unsubscribe();
    assert.equal(observers[0].disconnected, true);
  });
  withGlobals({ ResizeObserver: undefined }, () => {
    const host = pageRenderHost({ clientWidth: 1, clientHeight: 1 });
    assert.equal(host.observeCanvasCssSize(() => {}), undefined, "no observer: the renderer keeps reading");
  });
});

test("a scratch canvas is an OffscreenCanvas where there is one, else a DOM canvas", () => {
  class FakeOffscreenCanvas { constructor(width, height) { this.width = width; this.height = height; } }
  withGlobals({ OffscreenCanvas: FakeOffscreenCanvas, document: undefined }, () => {
    const canvas = createRenderCanvas(64, 32);
    assert.ok(canvas instanceof FakeOffscreenCanvas);
    assert.deepEqual([canvas.width, canvas.height], [64, 32]);
  });
  withGlobals({
    OffscreenCanvas: undefined,
    document: { createElement: (tag) => ({ tag, width: 300, height: 150 }) },
  }, () => {
    assert.deepEqual(createRenderCanvas(64, 32), { tag: "canvas", width: 64, height: 32 });
  });
});

/** Relative value imports of one source file (type-only imports vanish from the bundle). */
function relativeImports(source) {
  const found = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) if (!match[1]) found.push(match[2]);
  for (const match of source.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) found.push(match[1]);
  return found;
}

test("WorldRenderer3D's import closure no longer reaches the DOM overlay", async () => {
  const start = path.join(SRC, "browser", "WorldRenderer3D.ts");
  const parent = new Map([[start, undefined]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const specifier of relativeImports(await readFile(file, "utf8"))) {
      const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (!existsSync(resolved) || parent.has(resolved)) continue;
      parent.set(resolved, file);
      queue.push(resolved);
    }
  }
  assert.ok(parent.size > 100, `the walk followed the renderer's imports (${parent.size} files)`);
  assert.ok(parent.has(path.join(SRC, "browser", "SceneCamera.ts")));
  for (const banned of ["browser/SimpleScene.ts", "browser/NamePlate.ts", "browser/ui/IconImage.ts", "browser/ui/Dom.ts"]) {
    const file = path.join(SRC, ...banned.split("/"));
    const chain = [];
    for (let at = file; at !== undefined && parent.has(at); at = parent.get(at)) chain.push(path.relative(SRC, at));
    assert.equal(parent.has(file), false, `${banned} is imported: ${chain.join(" <- ")}`);
  }
});

test("the renderer and its two diagnostics callers read no page globals directly", async () => {
  const code = (text) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
  const renderer = code(await readFile(path.join(SRC, "browser", "WorldRenderer3D.ts"), "utf8"));
  for (const pattern of [/\bwindow\./, /\.clientWidth\b/, /\.clientHeight\b/, /new ResizeObserver\b/, /THREE\.TextureLoader\b/, /(?<![.\w])location\./, /\bdocument\./]) {
    assert.doesNotMatch(renderer, pattern);
  }
  for (const file of [["browser", "main.ts"], ["browser", "game", "PerformanceCapture.ts"]]) {
    assert.doesNotMatch(code(await readFile(path.join(SRC, ...file), "utf8")), /world3dCanvas\.getContext\(/, file.join("/"));
  }
  const water = code(await readFile(path.join(SRC, "browser", "Water.ts"), "utf8"));
  assert.doesNotMatch(water, /THREE\.TextureLoader\b/);
});
