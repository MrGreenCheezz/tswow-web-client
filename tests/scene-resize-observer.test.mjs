import assert from "node:assert/strict";
import test from "node:test";
import { SimpleScene } from "../dist/code/browser/SimpleScene.js";

// The 2D overlay read `getBoundingClientRect` once a frame, after the frame had already written to
// the page, which forced a layout in the middle of every frame. It is told its size by a
// ResizeObserver instead, and measures only until the first observation.

test("the overlay is measured once, then sized by its ResizeObserver", () => {
  const observers = [];
  const previous = globalThis.ResizeObserver;
  const previousWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() {}
  };
  try {
    const context = new Proxy({
      createLinearGradient: () => ({ addColorStop() {} }),
      measureText: (text) => ({ width: text.length * 6 }),
    }, { get: (target, property) => target[property] ?? (() => {}) });
    let measured = 0;
    const canvas = {
      width: 0, height: 0,
      getContext: () => context,
      getBoundingClientRect: () => { measured += 1; return { width: 800, height: 450 }; },
    };
    const scene = new SimpleScene(canvas, false);
    const state = { selfGuid: undefined, objects: new Map() };
    scene.draw(state);
    assert.equal(measured, 1, "the first frame measures");
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].targets, [canvas]);
    assert.equal(canvas.width, 800);
    scene.draw(state);
    assert.equal(measured, 2, "and so does every frame until the observer has spoken");

    observers[0].callback([{ contentRect: { width: 1024, height: 600 } }]);
    for (let frame = 0; frame < 5; frame += 1) scene.draw(state);
    assert.equal(measured, 2, "no layout read once the size is known");
    assert.equal(canvas.width, 1024);
    assert.equal(canvas.height, 600);
    assert.equal(observers.length, 1, "one observer for the life of the scene");
  } finally {
    globalThis.ResizeObserver = previous;
    globalThis.window = previousWindow;
  }
});
