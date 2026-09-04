import assert from "node:assert/strict";
import test from "node:test";

function node(tag = "div") {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(),
    id: "",
    hidden: true,
    value: "",
    style: {},
    dataset: {},
    children: [],
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
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      return selector === 'button[type="submit"]' ? node("button") : null;
    },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
  };
}

globalThis.document = {
  head: node("head"),
  body: node("body"),
  createElement(tag) { return node(tag); },
  getElementById() { return node(); },
  querySelectorAll() { return []; },
};
globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

const controller = await import("../dist/code/browser/framexml/FrameXmlPvpController.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const windows = await import("../dist/code/browser/ui/Windows.js");

test("Escape closes an ArenaFrame owned by the stock PVP controller", () => {
  const current = {
    pvp: false,
    arena: true,
    isOpen() { return this.pvp; },
    show() { this.pvp = true; },
    hide() { this.pvp = false; this.hideArena(); },
    isArenaOpen() { return this.arena; },
    showArena() { this.arena = true; },
    hideArena() { this.arena = false; },
  };
  const release = controller.publishFrameXmlPvp(current);
  try {
    assert.equal(controller.frameXmlPvpOpen(), true);
    assert.equal(windows.anyGameWindowOpen(), true);
    windows.closeGameWindows();
    assert.equal(current.arena, false, "Escape closes ArenaFrame before menu fallback");
    assert.equal(controller.frameXmlPvpOpen(), false);
    assert.equal(windows.anyGameWindowOpen(), false);
  } finally {
    release();
    game.world = undefined;
  }
});
