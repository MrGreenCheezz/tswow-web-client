import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.18: the synchronous LoadAddOn over an asynchronous file source. The client's
// (Wow.exe 0x00528920) loads and answers 1, or nil and a reason; here a known add-on that is not in
// yet starts the one idempotent load and answers false, "NOT_READY", the next call after it true;
// FRAMEXML_LOD_POLICY's disabled names answer "DISABLED" without IO; unknown names stay "MISSING".
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_LOD_POLICY } = await import("../dist/code/browser/framexml/FrameXmlAddonRuntime.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

function countingProvider(files) {
  const inner = createFixtureProvider(files);
  const reads = [];
  return {
    reads,
    async read(path) {
      reads.push(path.toLowerCase());
      return await inner.read(path);
    },
  };
}

async function settle(until, tries = 200) {
  for (let index = 0; index < tries && !until(); index++) await new Promise((resolve) => setTimeout(resolve, 2));
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "loadaddon-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

async function booted() {
  const provider = countingProvider({
    "interface/framexml/framexml.toc": "Main.lua",
    "interface/framexml/main.lua": `
      LOADED = {}
      local frame = CreateFrame("Frame")
      frame:RegisterEvent("ADDON_LOADED")
      frame:SetScript("OnEvent", function(self, event, name) LOADED[#LOADED + 1] = name end)
    `,
    "interface/addons/lodone/lodone.toc": "## LoadOnDemand: 1\nLodOne.lua",
    "interface/addons/lodone/lodone.lua": "LOD_ONE_RAN = (LOD_ONE_RAN or 0) + 1",
  });
  const boot = new FrameXmlBoot({ provider, installedAddons: ["LodOne"], exercise: false });
  await boot.load();
  return { boot, provider };
}

test("a known LoD add-on: the first LoadAddOn starts the load and answers NOT_READY, the next one true", async () => {
  const { boot, provider } = await booted();
  try {
    const before = provider.reads.length;
    assert.deepEqual(lua(boot, "return LoadAddOn('LodOne')", 2), [false, "NOT_READY"]);
    assert.deepEqual(lua(boot, "return LoadAddOn('LodOne')", 2), [false, "NOT_READY"], "still on its way: no second load");
    await settle(() => boot.isAddonLoaded("LodOne"));
    assert.equal(boot.isAddonLoaded("LodOne"), true, "the call started the load");
    // L5c 3.18: the TOC itself was read at boot for GetAddOnMetadata (primeMetadata); the load reads the files.
    assert.ok(provider.reads.slice(before).includes("interface/addons/lodone/lodone.lua"));
    assert.equal(boot.vm.getGlobal("LOD_ONE_RAN"), 1, "its files ran once");
    assert.deepEqual(lua(boot, "return LoadAddOn('LodOne')", 2), [true, undefined]);
    assert.deepEqual(lua(boot, "return table.concat(LOADED, ',')")[0], "LodOne", "one ADDON_LOADED");
  } finally {
    boot.close();
  }
});

test("disabled names answer DISABLED at once and read nothing; unknown ones stay MISSING", async () => {
  const { boot, provider } = await booted();
  try {
    assert.equal(FRAMEXML_LOD_POLICY.Blizzard_CombatText, "disabled");
    const before = provider.reads.length;
    assert.deepEqual(lua(boot, "return LoadAddOn('Blizzard_CombatText')", 2), [false, "DISABLED"]);
    // L17 3.14: Blizzard_BattlefieldMinimap has an owner now (FrameXmlBattlefieldMinimapLod.ts): NOT_READY, no read.
    assert.deepEqual(lua(boot, "return LoadAddOn('Blizzard_BattlefieldMinimap')", 2), [false, "NOT_READY"]);
    assert.deepEqual(lua(boot, "return LoadAddOn('NoSuchAddOn')", 2), [false, "MISSING"]);
    await settle(() => false, 5);
    assert.deepEqual(provider.reads.slice(before), [], "no file was read");
  } finally {
    boot.close();
  }
});

test("an owner-policy Blizzard add-on is known, answers NOT_READY and is left to its owner", async () => {
  const { boot, provider } = await booted();
  try {
    assert.equal(FRAMEXML_LOD_POLICY.Blizzard_AuctionUI, "owner");
    const before = provider.reads.length;
    assert.deepEqual(lua(boot, "return LoadAddOn('Blizzard_AuctionUI')", 2), [false, "NOT_READY"]);
    await settle(() => false, 5);
    assert.deepEqual(provider.reads.slice(before), [], "the owner loads it, not the call");
  } finally {
    boot.close();
  }
});

test("ADDON_NOT_READY lets the stock UIParentLoadAddOn format its message", async () => {
  const { boot } = await booted();
  try {
    assert.equal(lua(boot, "return type(ADDON_NOT_READY)")[0], "string");
    assert.equal(lua(boot, "return format('%s: %s', 'LodOne', _G['ADDON_' .. 'NOT_READY'])")[0], "LodOne: Ещё загружается — повторите");
  } finally {
    boot.close();
  }
});
