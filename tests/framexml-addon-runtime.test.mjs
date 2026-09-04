import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";

function files(overrides = {}) {
  return {
    "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing';",
    "interface/addons/blizzard_talentui/blizzard_talentui.toc": [
      "## Interface: 30300",
      "## Title: Blizzard Talent UI",
      "## LoadOnDemand: 1",
      "Blizzard_TalentUI.xml",
      "Localization.lua",
    ].join("\n"),
    "interface/addons/blizzard_talentui/blizzard_talentui.xml": [
      "<Ui>",
      "  <Button name=\"TalentButtonTemplate\" virtual=\"true\"/>",
      "  <Frame name=\"TalentFrame\" hidden=\"true\"/>",
      "</Ui>",
    ].join("\n"),
    "interface/addons/blizzard_talentui/localization.lua":
      "TalentAddonLoadCount = (TalentAddonLoadCount or 0) + 1\n"
      + "TalentAddonNeutralWasNil = UnknownTalentApi() == nil",
    ...overrides,
  };
}

async function bootWith(sourceFiles) {
  const boot = new FrameXmlBoot({
    provider: typeof sourceFiles?.read === "function"
      ? sourceFiles
      : createFixtureProvider(sourceFiles),
    subset: ["GlobalStrings.lua"],
    exercise: false,
  });
  await boot.load();
  return boot;
}

test("hyphenated TSWoW marker names are reported as already-loaded modules", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": [
        "## Interface: 30300",
        "GlobalStrings.lua",
        "## tsaddon-begin: retail-talents",
        "TSAddons/retail-talents/addon/addon.lua",
        "## tsaddon-end: retail-talents",
      ].join("\n"),
      "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing';",
      "interface/framexml/tsaddons/retail-talents/addon/addon.lua":
        "RetailTalentsMarkerExecuted = true",
    }),
    subset: ["GlobalStrings.lua"],
    includeActiveTsAddons: true,
    exercise: false,
  });
  try {
    await boot.load();
    assert.equal(boot.isAddonLoaded("retail-talents"), true);
    assert.equal(boot.isAddonLoaded("RETAIL-TALENTS"), true);
    assert.equal(boot.vm.getGlobal("RetailTalentsMarkerExecuted"), true);
  } finally {
    boot.close();
  }
});

test("load-on-demand add-on shares the boot VM and registry, and is idempotent", async () => {
  const boot = await bootWith(files());
  try {
    assert.equal(boot.bridge.getFrame("TalentFrame"), undefined);
    assert.equal(boot.isAddonLoaded("Blizzard_TalentUI"), false);

    const first = await boot.loadAddon("blizzard_talentui");
    assert.equal(first.ok, true, first.message);
    assert.equal(first.status, "loaded");
    assert.equal(boot.isAddonLoaded("BLIZZARD_TALENTUI"), true);
    assert.equal(boot.bridge.getFrame("TalentFrame")?.visible, false);
    assert.ok(boot.bridge.registry.get("TalentButtonTemplate"),
      "addon templates use the boot's existing registry");
    assert.equal(boot.vm.getGlobal("TalentAddonLoadCount"), 1);
    assert.equal(boot.vm.getGlobal("TalentAddonNeutralWasNil"), true,
      "addon-only globals are added to the shared neutral floor before Lua runs");

    const loaded = boot.vm.globalFunction("LoadAddOn");
    const status = boot.vm.call(loaded, ["Blizzard_TalentUI"], 1);
    boot.vm.release(loaded);
    assert.deepEqual(status, [true]);

    const second = await boot.loadAddon("BLIZZARD_TALENTUI");
    assert.equal(second.ok, true);
    assert.equal(second.status, "already-loaded");
    assert.equal(boot.vm.getGlobal("TalentAddonLoadCount"), 1);
  } finally {
    boot.close();
  }
});

test("a close during lazy add-on IO does not publish a partial module", async () => {
  let releaseXml;
  const xmlReady = new Promise((resolve) => { releaseXml = resolve; });
  const sourceFiles = files();
  const provider = {
    async read(path) {
      const key = path.toLowerCase();
      if (key.endsWith("/blizzard_talentui.xml")) await xmlReady;
      return sourceFiles[key];
    },
  };
  const boot = await bootWith(provider);
  const pending = boot.loadAddon("Blizzard_TalentUI");
  await new Promise((resolve) => setTimeout(resolve, 0));
  boot.close();
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 100)),
  ]);
  assert.notEqual(result.status, "timeout", "close settles a pending host load");
  assert.equal(result.ok, false);
  assert.equal(result.status, "closed");
  assert.equal(boot.isAddonLoaded("Blizzard_TalentUI"), false);
  releaseXml();
  await pending;
  assert.equal(boot.bridge.getFrame("TalentFrame"), undefined,
    "late completion cannot publish a frame after VM teardown");
});

test("load-on-demand dependencies follow TOC order and are loaded once", async () => {
  const sourceFiles = files({
    "interface/addons/blizzard_talentui/blizzard_talentui.toc": [
      "## Interface: 30300",
      "## LoadOnDemand: 1",
      "## Dependencies: Blizzard_TalentPrerequisite",
      "Blizzard_TalentUI.xml",
      "Localization.lua",
    ].join("\n"),
    "interface/addons/blizzard_talentprerequisite/blizzard_talentprerequisite.toc": [
      "## Interface: 30300",
      "## LoadOnDemand: 1",
      "Dependency.lua",
    ].join("\n"),
    "interface/addons/blizzard_talentprerequisite/dependency.lua":
      "TalentDependencyLoaded = (TalentDependencyLoaded or 0) + 1",
  });
  const boot = await bootWith(sourceFiles);
  try {
    const result = await boot.loadAddon("Blizzard_TalentUI");
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.dependencies, ["Blizzard_TalentPrerequisite"]);
    assert.equal(boot.vm.getGlobal("TalentDependencyLoaded"), 1);
    assert.equal((await boot.loadAddon("Blizzard_TalentPrerequisite")).status, "already-loaded");
    assert.equal(boot.vm.getGlobal("TalentDependencyLoaded"), 1);
  } finally {
    boot.close();
  }
});

test("MPQ Blizzard_TalentUI loads its exact LoD files into the boot registry", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const requests = [];
  const provider = {
    async read(path) {
      requests.push(path.replaceAll("\\", "/").toLowerCase());
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const boot = new FrameXmlBoot({
    provider,
    locale: "ruRU",
    exercise: false,
  });
  try {
    const inventory = await boot.load();
    assert.equal(boot.bridge.getFrame("PlayerTalentFrame"), undefined,
      "the base FrameXML TOC does not eagerly materialize the LoD talent window");
    const before = requests.length;
    const result = await boot.loadAddon("Blizzard_TalentUI");
    assert.equal(result.ok, true, result.message);
    assert.equal(result.status, "loaded");
    assert.deepEqual(result.loaded, [
      "interface/addons/blizzard_talentui/blizzard_talentui.toc",
      "interface/addons/blizzard_talentui/blizzard_talentui.xml",
      "interface/addons/blizzard_talentui/blizzard_talentui.lua",
      "interface/addons/blizzard_talentui/localization.lua",
    ], "TOC/XML Script order is retained");
    assert.ok(boot.bridge.getFrame("PlayerTalentFrame"),
      "the real stock root is created in the shared bridge");
    assert.ok(boot.bridge.registry.get("PlayerTalentButtonTemplate"),
      "the real stock template is registered in the shared registry");
    assert.equal(boot.isAddonLoaded("blizzard_talentui"), true);
    assert.equal(requests.length > before, true, "LoadAddOn performs lazy MPQ reads");
    assert.equal(inventory.files.missing.length, 0, "base MPQ corpus remains complete");
    const after = requests.length;
    const again = await boot.loadAddon("BLIZZARD_TALENTUI");
    assert.equal(again.status, "already-loaded");
    assert.equal(requests.length, after, "the second call is idempotent");
  } finally {
    boot.close();
    chain.close();
  }
});

test("construction does not read the LoD TOC, and missing/unsupported loads stay honest", async () => {
  const reads = [];
  const provider = {
    async read(path) {
      reads.push(path.toLowerCase());
      return files()[path.toLowerCase()];
    },
  };
  const boot = new FrameXmlBoot({ provider, subset: ["GlobalStrings.lua"], exercise: false });
  assert.deepEqual(reads, []);
  await boot.load();
  const beforeAddonReads = reads.length;
  try {
    assert.equal(reads.some((path) => path.includes("blizzard_talentui")), false);
    const missing = await boot.loadAddon("NoSuchAddon");
    assert.equal(missing.ok, false);
    assert.equal(missing.status, "missing");
    assert.match(missing.message, /not installed/i);
    const luaLoad = boot.vm.globalFunction("LoadAddOn");
    assert.deepEqual(boot.vm.call(luaLoad, ["NoSuchAddon"], 2), [false, "MISSING"]);
    boot.vm.release(luaLoad);
    assert.ok(reads.length > beforeAddonReads);
    assert.equal(boot.isAddonLoaded("NoSuchAddon"), false);
  } finally {
    boot.close();
  }

  const bad = await bootWith(files({
    "interface/addons/blizzard_talentui/blizzard_talentui.xml": "<Bad><Frame name=\"Poison\"/></Bad>",
  }));
  try {
    const result = await bad.loadAddon("Blizzard_TalentUI");
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(bad.isAddonLoaded("Blizzard_TalentUI"), false);
    assert.equal(bad.bridge.getFrame("Poison"), undefined);
    const loadStatus = bad.vm.globalFunction("LoadAddOn");
    assert.deepEqual(bad.vm.call(loadStatus, ["Blizzard_TalentUI"], 2), [false, "FAILED"]);
    bad.vm.release(loadStatus);
  } finally {
    bad.close();
  }
});
