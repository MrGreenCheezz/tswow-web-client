// 10.28 (26.10): full screen as in the game — Alt+Enter and the stock «Оконный режим» (gxWindow) switch the page's
// full screen; while in it the keyboard is locked (Esc reaches the game, holding it leaves), and let go after.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installFullscreen, isFullscreen, isFullscreenChord, setFullscreen } from "../dist/code/browser/app/Fullscreen.js";
import { createFrameXmlSettingsCVar } from "../dist/code/browser/framexml/FrameXmlSettingsCVar.js";
import { FRAMEXML_OPTIONS_UNAVAILABLE } from "../dist/code/browser/framexml/FrameXmlOptions.js";

function fakePage() {
  const calls = [];
  const listeners = new Map();
  const keyboard = { lock: async () => { calls.push("lock"); }, unlock: () => { calls.push("unlock"); } };
  const win = {
    navigator: { keyboard },
    addEventListener: (type, fn) => listeners.set(`win:${type}`, fn),
    removeEventListener: (type) => listeners.delete(`win:${type}`),
  };
  const doc = {
    fullscreenElement: null,
    defaultView: win,
    documentElement: {
      requestFullscreen: async (options) => { calls.push(["request", options?.navigationUI]); doc.fullscreenElement = doc.documentElement; },
    },
    exitFullscreen: async () => { calls.push("exit"); doc.fullscreenElement = null; },
    addEventListener: (type, fn) => listeners.set(`doc:${type}`, fn),
    removeEventListener: (type) => listeners.delete(`doc:${type}`),
  };
  return { doc, win, calls, listeners };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Alt+Enter is the chord; Ctrl, Shift or Meta with it is not", () => {
  const key = (fields) => ({ key: "Enter", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...fields });
  assert.equal(isFullscreenChord(key({})), true);
  assert.equal(isFullscreenChord(key({ altKey: false })), false);
  assert.equal(isFullscreenChord(key({ ctrlKey: true })), false);
  assert.equal(isFullscreenChord(key({ shiftKey: true })), false);
  assert.equal(isFullscreenChord(key({ key: "a" })), false);
});

test("entering locks the keyboard, leaving lets it go; a switch to the state it is in does nothing", async () => {
  const { doc, win, calls, listeners } = fakePage();
  const uninstall = installFullscreen(doc, win);
  setFullscreen(true, doc);
  await settle();
  assert.equal(isFullscreen(doc), true);
  assert.deepEqual(calls, [["request", "hide"], "lock"]);
  setFullscreen(true, doc);
  assert.equal(calls.length, 2, "already full screen");
  setFullscreen(false, doc);
  await settle();
  listeners.get("doc:fullscreenchange")();
  assert.deepEqual(calls.slice(2), ["exit", "unlock"]);
  uninstall();
  assert.equal(listeners.size, 0);
});

test("the key switches it and is kept from the game; a held key switches once", async () => {
  const { doc, win, listeners } = fakePage();
  installFullscreen(doc, win);
  let prevented = 0;
  let stopped = 0;
  const press = (repeat) => listeners.get("win:keydown")({
    key: "Enter", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, repeat,
    preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++,
  });
  press(false);
  await settle();
  assert.equal(isFullscreen(doc), true);
  press(true);
  await settle();
  assert.equal(isFullscreen(doc), true, "the auto-repeat does not switch back");
  assert.equal(prevented, 2);
  assert.equal(stopped, 2);
});

test("gxWindow is the window state, live: \"1\" in a window, \"0\" full screen; a write switches it", async () => {
  const { doc } = fakePage();
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    const cvars = createFrameXmlSettingsCVar({ getSettings: () => ({}), setSetting: () => assert.fail("not a setting") });
    assert.equal(cvars.get("gxWindow"), "1");
    assert.equal(cvars.getDefault("GXWINDOW"), "1");
    assert.equal(cvars.set("gxWindow", "0"), true);
    await settle();
    assert.equal(cvars.get("gxWindow"), "0");
    assert.equal(cvars.set("gxWindow", 1), true);
    await settle();
    assert.equal(cvars.get("gxWindow"), "1");
  } finally {
    globalThis.document = saved;
  }
  assert.equal(FRAMEXML_OPTIONS_UNAVAILABLE.has("VideoOptionsResolutionPanelWindowed"), false, "the check box is live");
  const main = await readFile(new URL("../src/browser/main.ts", import.meta.url), "utf8");
  assert.match(main, /installFullscreen\(\);/);
});
