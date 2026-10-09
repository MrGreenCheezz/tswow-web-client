import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

/**
 * 10.19 — the glue video queries answer what the browser can do rather than constants, when the
 * host passes `video`; without it the old constant answers stand.
 */

const FIXTURE = { "Interface/GlueXML/GlueXML.toc": "## Interface: 30300\n" };

async function runtimeWith(api) {
  const runtime = new GlueRuntime({ provider: createFixtureProvider(FIXTURE), api: { locale: "ruRU", ...api } });
  await runtime.load();
  const evaluate = (expression) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${expression} end)()`, "@glue-video-probe");
    assert.equal(outcome.ok, true, `${expression}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  return { runtime, evaluate };
}

test("the video queries answer the browser's refresh rate and sample limit", async () => {
  const { runtime, evaluate } = await runtimeWith({ video: { refreshRate: () => 143.9, maxSamples: () => 4 } });
  try {
    assert.equal(evaluate("return GetRefreshRates()"), 144);
    assert.equal(evaluate("return select('#', GetMultisampleFormats())"), 9, "three triples: 1, 2 and 4 samples");
    assert.equal(evaluate("return table.concat({GetMultisampleFormats()}, ',')"), "24,24,1,24,24,2,24,24,4");
    assert.equal(evaluate("return GetCurrentMultisampleFormat()"), 1, "gxMultisample defaults to 1");
    assert.equal(evaluate("SetCVar('gxMultisample', '4'); return GetCurrentMultisampleFormat()"), 3);
    assert.equal(evaluate("SetCVar('gxMultisample', '16'); return GetCurrentMultisampleFormat()"), 1);
  } finally {
    runtime.close();
  }
});

test("without a video source the constant answers stand", async () => {
  const { runtime, evaluate } = await runtimeWith({});
  try {
    assert.equal(evaluate("return GetRefreshRates()"), 60);
    assert.equal(evaluate("return select('#', GetMultisampleFormats())"), 0);
    assert.equal(evaluate("return GetCurrentMultisampleFormat()"), 1);
  } finally {
    runtime.close();
  }
});

test("a browser without multisampling offers the one plain format", async () => {
  const { runtime, evaluate } = await runtimeWith({ video: { refreshRate: () => 60, maxSamples: () => 0 } });
  try {
    assert.equal(evaluate("return table.concat({GetMultisampleFormats()}, ',')"), "24,24,1");
  } finally {
    runtime.close();
  }
});