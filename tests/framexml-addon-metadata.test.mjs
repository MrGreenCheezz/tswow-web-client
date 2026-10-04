import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.18 (L5c, 04.10): GetAddOnMetadata as Wow.exe 3.3.5a 12340 answers it. 0x00511430 takes
// an index or a name and a key, and pushes 0x005f74e0's answer: the add-on looked up in the list the
// client scanned from Interface/AddOns at start (loaded or not), the key in that add-on's TOC fields,
// the value or nil — never an error for an unknown name. A TSWoW module is glued into FrameXML.toc
// (`## tsaddon-begin:` blocks), is not in that list, and so answers nil in the client too.
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "addon-metadata-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

async function booted() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": [
        "## Interface: 30300",
        "Main.lua",
        "## tsaddon-begin: retail-talents",
        "TSAddons/retail-talents/addon/addon.lua",
        "## tsaddon-end: retail-talents",
      ].join("\n"),
      "interface/framexml/main.lua": "MAIN_RAN = true",
      "interface/framexml/tsaddons/retail-talents/addon/addon.lua": "MODULE_RAN = true",
      "interface/addons/eager/eager.toc": "## Title: Eager\n## Version: 1.2\nEager.lua",
      // Runs at boot, before the LoD one loads: the client answers from its start-up scan.
      "interface/addons/eager/eager.lua": "EAGER_SAW = GetAddOnMetadata('LodOne', 'Version')",
      "interface/addons/lodone/lodone.toc": "## LoadOnDemand: 1\n## Version: 7.0\n## X-Website: example.invalid\nLodOne.lua",
      "interface/addons/lodone/lodone.lua": "LOD_ONE_RAN = true",
    }),
    installedAddons: ["Eager", "LodOne", "NoToc"],
    eagerAddons: ["Eager"],
    exercise: false,
  });
  await boot.load();
  return boot;
}

test("an installed add-on answers from its TOC before it loads; keys are case-insensitive", async () => {
  const boot = await booted();
  try {
    assert.equal(boot.vm.getGlobal("EAGER_SAW"), "7.0", "an eager add-on's main chunk read the LoD add-on's TOC");
    assert.equal(boot.isAddonLoaded("LodOne"), false);
    assert.deepEqual(lua(boot, "return GetAddOnMetadata('LodOne', 'version')"), ["7.0"]);
    assert.deepEqual(lua(boot, "return GetAddOnMetadata('lodone', 'X-Website')"), ["example.invalid"]);
    assert.deepEqual(lua(boot, "return GetAddOnMetadata('Eager', 'Title')"), ["Eager"]);
    assert.deepEqual(lua(boot, "return GetAddOnMetadata('LodOne', 'Author')"), [undefined], "a key the TOC lacks: nil");
  } finally {
    boot.close();
  }
});

test("a TSWoW module, an unknown name and an installed add-on without a TOC answer nil", async () => {
  const boot = await booted();
  try {
    assert.equal(boot.vm.getGlobal("MODULE_RAN"), true, "the module's block ran");
    assert.deepEqual(lua(boot, "return GetAddOnMetadata('retail-talents', 'Title')"), [undefined]);
    assert.deepEqual(lua(boot, "return GetAddOnMetadata('XLoot', 'Version')"), [undefined]);
    assert.deepEqual(lua(boot, "return GetAddOnMetadata('NoToc', 'Version')"), [undefined]);
  } finally {
    boot.close();
  }
});
