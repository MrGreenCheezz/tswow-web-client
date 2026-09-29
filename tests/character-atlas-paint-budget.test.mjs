import assert from "node:assert/strict";
import test from "node:test";

import { CHARACTER_ATLAS_PAINTS_PER_FRAME, CharacterAtlasClient } from "../dist/code/browser/CharacterAtlas.js";

function installPage() {
  const previous = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const callbacks = new Map();
  const canvases = [];
  let nextFrameId = 0;
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => ({}) });
  globalThis.createImageBitmap = async () => ({ width: 256, height: 128, close() {} });
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = {
        width: 0, height: 0, drawn: 0,
        getContext: () => ({ drawImage: () => { canvas.drawn++; } }),
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextFrameId;
    callbacks.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => { callbacks.delete(id); };
  return {
    callbacks,
    canvases,
    async frame() {
      assert.equal(callbacks.size, 1, "one shared paint callback is scheduled");
      const callback = callbacks.values().next().value;
      callback(0);
      await new Promise((resolve) => setImmediate(resolve));
    },
    restore() {
      Object.assign(globalThis, previous);
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const layer = (index) => [{ path: `Body${index}.blp` }];

test("completed character looks paint at most two atlases per animation frame", async () => {
  const page = installPage();
  const atlas = new CharacterAtlasClient("http://atlas.test");
  try {
    const pending = Array.from({ length: 5 }, (_, index) => atlas.compose(`look-${index}`, layer(index)));
    await settle();
    assert.equal(page.canvases.length, 0, "download completion does not paint a whole crowd at once");
    assert.equal(page.callbacks.size, 1);

    await page.frame();
    assert.equal(page.canvases.length, CHARACTER_ATLAS_PAINTS_PER_FRAME);
    await page.frame();
    assert.equal(page.canvases.length, CHARACTER_ATLAS_PAINTS_PER_FRAME * 2);
    await page.frame();
    assert.equal(page.canvases.length, 5);
    assert.equal((await Promise.all(pending)).filter(Boolean).length, 5);
    assert.equal(atlas.size, 5);
  } finally {
    atlas.dispose();
    page.restore();
  }
});

test("release and dispose settle paint waiters without publishing stale canvases", async () => {
  const page = installPage();
  const atlas = new CharacterAtlasClient("http://atlas.test");
  try {
    const released = atlas.compose("released", layer(1));
    await settle();
    atlas.release("released");
    assert.equal(await released, undefined);
    assert.equal(page.callbacks.size, 0);
    assert.equal(page.canvases.length, 0);

    const disposed = atlas.compose("disposed", layer(2));
    await settle();
    atlas.dispose();
    assert.equal(await disposed, undefined);
    assert.equal(page.callbacks.size, 0);
    assert.equal(page.canvases.length, 0);
  } finally {
    atlas.dispose();
    page.restore();
  }
});

test("a hidden tab finishes a queued atlas without waiting for a paused animation frame", async () => {
  const page = installPage();
  globalThis.document.hidden = true;
  const atlas = new CharacterAtlasClient("http://atlas.test");
  try {
    const painted = atlas.compose("hidden", layer(3));
    await settle();
    assert.equal(page.callbacks.size, 1);
    let timeout;
    const completed = await Promise.race([
      painted.then((texture) => texture !== undefined),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 1_000); }),
    ]);
    clearTimeout(timeout);
    assert.equal(completed, true);
    assert.equal(page.canvases.length, 1);
    assert.equal(page.callbacks.size, 0);
  } finally {
    atlas.dispose();
    page.restore();
  }
});
