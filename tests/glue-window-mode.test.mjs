import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

/**
 * 10.28 (11.11): the login screen's «Оконный режим» (GlueXML VideoOptionsResolutionPanelWindowed, cvar gxWindow)
 * is the page's full screen, as the world's check box is: GetCVar answers the live state, and the stock panel's
 * SetCVar switches it.
 */

function fakeDocument() {
  const calls = [];
  const doc = {
    fullscreenElement: null,
    defaultView: { navigator: {} },
    documentElement: {
      requestFullscreen: async () => { calls.push("request"); doc.fullscreenElement = doc.documentElement; },
    },
    exitFullscreen: async () => { calls.push("exit"); doc.fullscreenElement = null; },
  };
  return { doc, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the glue's gxWindow is the page's full screen, read live and switched by SetCVar", async () => {
  const runtime = new GlueRuntime({
    provider: createFixtureProvider({ "Interface/GlueXML/GlueXML.toc": "## Interface: 30300\n" }),
    api: { locale: "ruRU" },
  });
  await runtime.load();
  const evaluate = (expression) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${expression} end)()`, "@glue-window-probe");
    assert.equal(outcome.ok, true, `${expression}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  const { doc, calls } = fakeDocument();
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    assert.equal(evaluate("return GetCVar('gxWindow')"), "1", "a window");
    assert.equal(evaluate("return GetCVarDefault('gxWindow')"), "1");
    // BlizzardOptionsPanel_SetCVarSafe writes the unticked box as "0": the page fills the screen.
    evaluate("SetCVar('gxWindow', '0'); return 1");
    await settle();
    assert.deepEqual(calls, ["request"]);
    assert.equal(evaluate("return GetCVar('gxWindow')"), "0");
    assert.equal(evaluate("return GetCVarBool('gxWindow')"), false);
    evaluate("SetCVar('gxWindow', '0'); return 1");
    assert.deepEqual(calls, ["request"], "the value it has changes nothing");
    evaluate("SetCVar('gxWindow', 1); return 1");
    await settle();
    assert.deepEqual(calls, ["request", "exit"]);
    assert.equal(evaluate("return GetCVar('gxWindow')"), "1");
  } finally {
    globalThis.document = saved;
    runtime.close();
  }
});
