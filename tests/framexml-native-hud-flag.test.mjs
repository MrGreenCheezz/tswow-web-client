import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import {
  FRAMEXML_NATIVE_HUD_GLOBAL, markFrameXmlNativeHud,
} from "../dist/code/browser/framexml/FrameXmlTsAddonPresentation.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

async function bootWith(mark) {
  const provider = createFixtureProvider({
    "interface/framexml/framexml.toc": "GlobalStrings.lua\nHub.lua\n",
    "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
    // What minimap-hub's `(_G as any).__fxNativeHud == true` compiles to, read at file load.
    "interface/framexml/hub.lua": "HubSawNativeHud = _G.__fxNativeHud == true\nHubFlagType = type(_G.__fxNativeHud)",
  });
  const boot = new FrameXmlBoot({ provider, exercise: false });
  if (mark) markFrameXmlNativeHud(boot);
  await boot.load();
  return boot;
}

test("the native-HUD flag set before boot.load() survives the preludes and is seen at file load", async () => {
  assert.equal(FRAMEXML_NATIVE_HUD_GLOBAL, "__fxNativeHud", "the name minimap-hub reads");
  const marked = await bootWith(true);
  try {
    assert.equal(marked.vm.getGlobal("HubSawNativeHud"), true);
    assert.equal(marked.vm.getGlobal(FRAMEXML_NATIVE_HUD_GLOBAL), true);
  } finally {
    marked.close();
  }
  // The full FrameXML mount and the stock client: nil, not a stub a module would read as truthy.
  const stock = await bootWith(false);
  try {
    assert.equal(stock.vm.getGlobal("HubSawNativeHud"), false);
    assert.equal(stock.vm.getGlobal("HubFlagType"), "nil");
  } finally {
    stock.close();
  }
});

test("the world mount marks only the addonsOnly boot, and a latched add-on list fails the mount", async () => {
  const source = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  const construct = source.indexOf("const boot = new FrameXmlBoot({");
  const mark = source.indexOf("if (options.addonsOnly) markFrameXmlNativeHud(boot);");
  const load = source.indexOf("inventory = await boot.load();");
  assert.ok(construct > 0 && mark > construct && load > mark, "marked after construction, before the corpus runs");

  // The list fetch used to swallow every failure into []: the patch latch must end the mount with
  // its own message instead of booting with no add-ons.
  assert.match(source, /fetchFrameXmlClientAddons\(origin\)\.catch\(\(error\) => \{\s*if \(isPatchChainChangedError\(error\)\) patchChainChanged = error;\s*else console\.warn/);
  const bail = source.indexOf("if (patchChainChanged) return { ok: false, message: patchChainChanged.message };");
  assert.ok(bail > source.indexOf("fetchFrameXmlClientAddons(origin)"), "checked right after the list");
  assert.ok(bail < source.indexOf("waitForFrameXmlLoginClock({"), "before the mount waits for the world");
});
