import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

// P1-14f: census "touch" binds an answered C-API name to its answer after the first read (no Lua
// wrapper per call); "calls", the default, keeps the wrapper and counts every call. Unanswered
// names count every call in both modes.
const prefix = "interface/framexml/";

async function boot(census) {
  const instance = new FrameXmlBoot({ exercise: false, census, provider: createFixtureProvider({
    [prefix + "framexml.toc"]: "Probe.lua",
    [prefix + "probe.lua"]: [
      'GetCVar("buffDurations")',
      "BoundAfterTouch = rawequal(GetCVar, __fxNeutralImpl.GetCVar)",
      'GetCVar("buffDurations")',
      'GetCVar("buffDurations")',
      "UnknownTouchProbe()",
      "UnknownTouchProbe()",
      'hooksecurefunc("GetCVar", function() HookRuns = (HookRuns or 0) + 1 end)',
      'GetCVar("buffDurations")',
    ].join("\n"),
  }) });
  const inventory = await instance.load();
  return { instance, inventory };
}

for (const census of [undefined, "calls", "touch"]) {
  test(`census ${census ?? "(default)"}: answered and unanswered names, hooksecurefunc after the touch`, async () => {
    const { instance, inventory } = await boot(census);
    try {
      assert.equal(instance.errorCount, 0);
      const touch = census === "touch";
      assert.equal(instance.vm.getGlobal("BoundAfterTouch"), touch, "the global is the answer itself only in touch");
      const calls = (name) => inventory.api.find((entry) => entry.name === name)?.calls;
      assert.equal(calls("GetCVar"), touch ? 1 : 4, "touches in touch, calls otherwise");
      assert.equal(calls("UnknownTouchProbe"), 2, "an unanswered name counts every call in both modes");
      assert.equal(instance.vm.getGlobal("HookRuns"), 1, "hooksecurefunc wraps the bound answer");
    } finally { instance.close(); }
  });
}
