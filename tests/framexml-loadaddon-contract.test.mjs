import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.18: the synchronous LoadAddOn over an asynchronous file source. The client's
// (Wow.exe 0x00528920) loads and answers 1, or nil and a reason; here a known add-on that is not in
// yet starts the one idempotent load and answers false, "NOT_READY", the next call after it 1 (as
// Wow.exe answers); since 3.18 (owner, 12.10) a prefetched one runs inside the call (below);
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
    "interface/addons/lodone/lodone.toc": "## Interface: 30300\n## LoadOnDemand: 1\nLodOne.lua",
    "interface/addons/lodone/lodone.lua": "LOD_ONE_RAN = (LOD_ONE_RAN or 0) + 1",
  });
  const boot = new FrameXmlBoot({ provider, installedAddons: ["LodOne"], exercise: false });
  await boot.load();
  return { boot, provider };
}

test("a known LoD add-on: the first LoadAddOn starts the load and answers NOT_READY, the next one 1", async () => {
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
    assert.deepEqual(lua(boot, "return LoadAddOn('LodOne')", 2), [1, undefined], "1, as Wow.exe");
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

// 3.18 (owner, 12.10): a third-party LoD add-on prefetched in the mount's loading window (read, not
// run) is run by its LoadAddOn inside the call, as Wow.exe's synchronous LoadAddOn does — the MSBT
// pattern (MSBTProfiles.lua:1554-1566): a slash command loads the options add-on and uses it on the
// next line. Its LoD dependency runs first, its SavedVariables are restored before its ADDON_LOADED,
// ADDON_LOADED is raised before the call returns 1, and its XML roots reach the boot as the
// asynchronous load hands them over.
const OPTS_FILES = {
  "interface/framexml/framexml.toc": "Main.lua",
  "interface/framexml/main.lua": `
    LOADED = {}
    SlashCmdList = {}
    local frame = CreateFrame("Frame")
    frame:RegisterEvent("ADDON_LOADED")
    frame:SetScript("OnEvent", function(self, event, name) LOADED[#LOADED + 1] = name end)
  `,
  "interface/addons/parent/parent.toc": "## Interface: 30300\nParent.lua",
  "interface/addons/parent/parent.lua": `
    SLASH_PARENTOPTS1 = "/parentopts"
    SlashCmdList.PARENTOPTS = function()
      if not IsAddOnLoaded("Opts") then
        local loaded, reason = LoadAddOn("Opts")
        OPTS_ANSWER = { loaded = loaded, reason = reason }
      end
      if IsAddOnLoaded("Opts") then OptsMain.Show(); OPENED = true end
    end
  `,
  "interface/addons/optslib/optslib.toc": "## Interface: 30300\n## LoadOnDemand: 1\nOptsLib.lua",
  "interface/addons/optslib/optslib.lua": "OPTS_LIB = { before = OptsMain == nil }",
  "interface/addons/opts/opts.toc":
    "## Interface: 30300\n## LoadOnDemand: 1\n## Dependencies: OptsLib\n## SavedVariables: OptsDB\nOpts.xml\nOptsMain.lua",
  "interface/addons/opts/opts.xml": '<Ui><Script file="Localization.lua"/><Include file="Panels\\Panels.xml"/></Ui>',
  "interface/addons/opts/localization.lua": "OPTS_L = { title = 'Opts' }",
  "interface/addons/opts/panels/panels.xml": '<Ui><Frame name="OptsPanel" hidden="true"/><Script file="Panels.lua"/></Ui>',
  "interface/addons/opts/panels/panels.lua": "OPTS_PANELS = true",
  "interface/addons/opts/optsmain.lua": `
    local name = ...
    OptsDB = { visits = 0 }
    OptsMain = { name = name, Show = function() OptsPanel:Show() end }
    local frame = CreateFrame("Frame")
    frame:RegisterEvent("ADDON_LOADED")
    frame:SetScript("OnEvent", function(self, event, loaded)
      if loaded ~= "Opts" then return end
      SEEN_VISITS = OptsDB.visits
      OptsDB.visits = OptsDB.visits + 1
    end)
  `,
};
const OPTS_READS = [
  "interface/addons/opts/opts.toc", "interface/addons/opts/opts.xml", "interface/addons/opts/localization.lua",
  "interface/addons/opts/panels/panels.xml", "interface/addons/opts/panels/panels.lua",
  "interface/addons/opts/optsmain.lua", "interface/addons/optslib/optslib.toc", "interface/addons/optslib/optslib.lua",
];

function memoryStore() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}

async function optsBoot({ provider = countingProvider(OPTS_FILES), store } = {}) {
  const boot = new FrameXmlBoot({
    provider, installedAddons: ["Parent", "OptsLib", "Opts", "Ghost"], eagerAddons: ["Parent"], exercise: false,
    ...(store ? { savedVariables: { storage: store, scope: { account: "a", realm: "r", character: "c" } } } : {}),
  });
  await boot.load();
  return { boot, provider };
}

test("3.18: a prefetch reads the add-on and its LoD dependency, every file once, and runs nothing", async () => {
  const { boot, provider } = await optsBoot();
  try {
    const before = provider.reads.length;
    assert.deepEqual(await boot.prefetchAddon("Opts"), { ok: true });
    // Through the boot's cached corpus: the TOCs were read at boot for GetAddOnMetadata (primeMetadata).
    for (const path of OPTS_READS) {
      assert.equal(provider.reads.filter((entry) => entry === path).length, 1, `${path} read once`);
      if (!path.endsWith(".toc")) assert.ok(provider.reads.indexOf(path) >= before, `${path} read by the prefetch`);
    }
    assert.deepEqual(lua(boot, "return IsAddOnLoaded('Opts'), IsAddOnLoaded('OptsLib')", 2), [undefined, undefined]);
    assert.deepEqual(lua(boot, "return OPTS_L, OPTS_LIB, OptsMain, OPTS_PANELS", 4), [undefined, undefined, undefined, undefined]);
    assert.equal(boot.bridge.getFrame("OptsPanel"), undefined, "no frame was declared");
    assert.equal(lua(boot, "return table.concat(LOADED, ',')")[0], "Parent", "no ADDON_LOADED for either");
  } finally {
    boot.close();
  }
});

test("3.18: the slash command's LoadAddOn runs the prefetched add-on inside the call and its next line opens it", async () => {
  const { boot, provider } = await optsBoot();
  try {
    await boot.prefetchAddon("Opts");
    const before = provider.reads.length;
    lua(boot, "SlashCmdList.PARENTOPTS('')", 0);
    assert.deepEqual(lua(boot, "return OPTS_ANSWER.loaded, OPTS_ANSWER.reason, OPENED", 3), [1, undefined, true],
      "LoadAddOn answered 1 and IsAddOnLoaded on the next line saw it — on the first call");
    assert.deepEqual(provider.reads.slice(before), [], "run from memory: nothing was read in the call");
    assert.equal(boot.bridge.getFrame("OptsPanel")?.visible, true, "the add-on's XML frame, shown by its own code");
    assert.equal(lua(boot, "return table.concat(LOADED, ',')")[0], "Parent,OptsLib,Opts", "the dependency first");
    assert.deepEqual(lua(boot, "return OPTS_LIB.before, OptsMain.name, OPTS_L.title, OPTS_PANELS", 4), [true, "Opts", "Opts", true]);
    assert.equal(boot.isAddonLoaded("Opts"), true);
    assert.equal(boot.isAddonLoaded("OptsLib"), true);
    assert.equal(boot.addonRootNames.has("OptsPanel"), true, "its roots handed over as the asynchronous load does");
    assert.deepEqual(lua(boot, "return LoadAddOn('Opts')", 2), [1, undefined], "already loaded");
    assert.deepEqual(boot.errors, []);
  } finally {
    boot.close();
  }
});

test("3.18: inside the call, ADDON_LOADED follows the restored SavedVariables", async () => {
  const store = memoryStore();
  const first = await optsBoot({ store });
  await first.boot.prefetchAddon("Opts");
  assert.deepEqual(lua(first.boot, "return LoadAddOn('Opts'), SEEN_VISITS", 2), [1, 0], "a first session: nothing saved yet");
  first.boot.close();
  const second = await optsBoot({ store });
  try {
    await second.boot.prefetchAddon("Opts");
    // One chunk: SEEN_VISITS is the ADDON_LOADED handler's, set before LoadAddOn returned to it.
    assert.deepEqual(lua(second.boot, "return LoadAddOn('Opts'), SEEN_VISITS", 2), [1, 1],
      "ADDON_LOADED raised inside the call, after OptsDB was restored over the file's own default");
  } finally {
    second.boot.close();
  }
});

test("3.18: a prefetched add-on that is not installed answers MISSING inside the call", async () => {
  const { boot, provider } = await optsBoot();
  try {
    const prefetched = await boot.prefetchAddon("Ghost");
    assert.equal(prefetched.ok, false);
    const before = provider.reads.length;
    assert.deepEqual(lua(boot, "return LoadAddOn('Ghost')", 2), [false, "MISSING"]);
    assert.deepEqual(provider.reads.slice(before), [], "answered from the prefetch");
  } finally {
    boot.close();
  }
});

test("3.18: an incomplete prefetch falls back to the asynchronous NOT_READY path, nothing half-run", async () => {
  const inner = countingProvider(OPTS_FILES);
  let failOnce = true;
  const provider = {
    reads: inner.reads,
    async read(path) {
      if (failOnce && path.toLowerCase() === "interface/addons/opts/panels/panels.lua") {
        failOnce = false;
        throw new Error("GlueServerUnavailableError: test gateway down");
      }
      return await inner.read(path);
    },
  };
  const { boot } = await optsBoot({ provider });
  try {
    // The dependency complete on its own: only the add-on's own missing file can decide the path.
    assert.deepEqual(await boot.prefetchAddon("OptsLib"), { ok: true });
    const prefetched = await boot.prefetchAddon("Opts");
    assert.equal(prefetched.ok, false);
    assert.match(prefetched.message ?? "", /GlueServerUnavailableError/, "the preloader can stop at a gateway that is down");
    assert.deepEqual(lua(boot, "local loaded, reason = LoadAddOn('Opts'); return loaded, reason, OPTS_L, OptsMain", 4),
      [false, "NOT_READY", undefined, undefined],
      "NOT_READY, and none of its Lua ran inside the call");
    assert.equal(lua(boot, "return table.concat(LOADED, ',')")[0], "Parent", "nor its dependency's");
    assert.deepEqual(lua(boot, "return IsAddOnLoaded('Opts')", 1), [undefined]);
    await settle(() => boot.isAddonLoaded("Opts"));
    assert.equal(boot.isAddonLoaded("Opts"), true, "the asynchronous load finished it");
    assert.deepEqual(lua(boot, "return LoadAddOn('Opts')", 2), [1, undefined]);
    assert.equal(lua(boot, "return table.concat(LOADED, ',')")[0], "Parent,OptsLib,Opts");
  } finally {
    boot.close();
  }
});

test("3.18: a LoadAddOn before the prefetch finished takes the asynchronous path", async () => {
  const inner = countingProvider(OPTS_FILES);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let gated = false;
  const provider = {
    reads: inner.reads,
    async read(path) {
      if (gated && path.toLowerCase() === "interface/addons/opts/optsmain.lua") await gate;
      return await inner.read(path);
    },
  };
  const { boot } = await optsBoot({ provider });
  try {
    assert.deepEqual(await boot.prefetchAddon("OptsLib"), { ok: true }, "the dependency is ready; the add-on is not");
    gated = true;
    const prefetch = boot.prefetchAddon("Opts");
    await settle(() => false, 3);
    assert.deepEqual(lua(boot, "return LoadAddOn('Opts')", 2), [false, "NOT_READY"]);
    assert.equal(lua(boot, "return table.concat(LOADED, ',')")[0], "Parent", "nothing ran inside the call");
    release();
    await prefetch;
    await settle(() => boot.isAddonLoaded("Opts"));
    assert.equal(boot.isAddonLoaded("Opts"), true);
    assert.equal(lua(boot, "return OPTS_L.title")[0], "Opts", "loaded asynchronously");
    assert.equal(lua(boot, "return table.concat(LOADED, ',')")[0], "Parent,OptsLib,Opts");
  } finally {
    boot.close();
  }
});

test("3.18: an owner's add-on stays its owner's even when its files were read ahead", async () => {
  const { boot } = await optsBoot();
  try {
    await boot.prefetchAddon("Blizzard_AuctionUI");
    assert.deepEqual(lua(boot, "return LoadAddOn('Blizzard_AuctionUI')", 2), [false, "NOT_READY"]);
    assert.equal(boot.isAddonLoaded("Blizzard_AuctionUI"), false);
  } finally {
    boot.close();
  }
});
