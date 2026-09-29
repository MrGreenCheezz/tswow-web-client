import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { fetchFrameXmlClientAddons } from "../dist/code/browser/framexml/FrameXmlClientAddons.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";

function requestJson(port, path) {
  return new Promise((resolve, reject) => {
    const call = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: { origin: "http://localhost:5173" },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    call.once("error", reject);
    call.end();
  });
}

test("gateway publishes the immutable root-level client add-on list", async () => {
  const addons = [
    { name: "!Loader", loadOnDemand: false },
    { name: "OptionalPanel", loadOnDemand: true },
  ];
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    clientAddons: addons,
  });
  try {
    const response = await requestJson(gateway.port, "/client/addons");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { addons });
  } finally {
    await gateway.close();
  }
});

test("browser add-on discovery validates names, flags, and duplicates", async () => {
  const fetcher = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ addons: [
      { name: "!Loader", loadOnDemand: false },
      { name: "!LOADER", loadOnDemand: true },
      { name: "OptionalPanel", loadOnDemand: true },
      { name: "../escape", loadOnDemand: false },
      { name: "NoFlag" },
    ] }),
  });
  const addons = await fetchFrameXmlClientAddons("http://127.0.0.1:8090", fetcher);
  assert.deepEqual(addons, [
    { name: "!Loader", loadOnDemand: false },
    { name: "OptionalPanel", loadOnDemand: true },
  ]);
});

test("enabled loose add-ons execute in the boot VM before the world exercise", async () => {
  const provider = createFixtureProvider({
    "interface/framexml/framexml.toc": "GlobalStrings.lua\n",
    "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
    "interface/addons/!loader/!loader.toc": "Loader.xml\nLoader.lua\n",
    "interface/addons/!loader/loader.xml": "<Ui><Frame name=\"LooseAddonRoot\"/></Ui>",
    "interface/addons/!loader/loader.lua": "LooseAddonLoaded = true",
  });
  const boot = new FrameXmlBoot({
    provider,
    installedAddons: ["!Loader"],
    eagerAddons: ["!Loader"],
    exercise: false,
  });
  try {
    await boot.load();
    assert.equal(boot.isAddonLoaded("!loader"), true);
    assert.equal(boot.vm.getGlobal("LooseAddonLoaded"), true);
    assert.equal(boot.addonResults.length, 1);
    assert.equal(boot.addonResults[0].ok, true, boot.addonResults[0].message);
    assert.equal(boot.addonRootNames.has("LooseAddonRoot"), true);
  } finally {
    boot.close();
  }
});

test("metadata-only loader add-ons load their dependency and then report success", async () => {
  const provider = createFixtureProvider({
    "interface/framexml/framexml.toc": "GlobalStrings.lua\n",
    "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
    "interface/addons/library/library.toc": "Library.lua\n",
    "interface/addons/library/library.lua": "LibraryLoaded = true",
    "interface/addons/!loader/!loader.toc": "## Dependencies: Library\n",
  });
  const boot = new FrameXmlBoot({ provider, installedAddons: ["Library", "!Loader"], exercise: false });
  try {
    await boot.load();
    const result = await boot.loadAddon("!Loader");
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.dependencies, ["Library"]);
    assert.equal(boot.isAddonLoaded("Library"), true);
    assert.equal(boot.vm.getGlobal("LibraryLoaded"), true);
  } finally {
    boot.close();
  }
});

test("an add-on exported through a string-keyed _G assignment is not preempted by a neutral stub", async () => {
  const provider = createFixtureProvider({
    "interface/framexml/framexml.toc": "GlobalStrings.lua\n",
    "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
    "interface/addons/library/library.toc": "LibStub.lua\nConsumer.lua\n",
    "interface/addons/library/libstub.lua": [
      "local LIBRARY_MAJOR = 'LibraryEntry'",
      "local library = _G[LIBRARY_MAJOR]",
      "if not library then",
      "  library = {}",
      "  _G[LIBRARY_MAJOR] = library",
      "  setmetatable(library, { __call = function() return 'owned-by-addon' end })",
      "end",
    ].join("\n"),
    "interface/addons/library/consumer.lua": "LibraryResult = LibraryEntry()",
  });
  const boot = new FrameXmlBoot({ provider, installedAddons: ["Library"], exercise: false });
  try {
    await boot.load();
    const result = await boot.loadAddon("Library");
    assert.equal(result.ok, true, result.message);
    assert.equal(boot.vm.getGlobal("LibraryResult"), "owned-by-addon");
  } finally {
    boot.close();
  }
});

test("legacy add-ons can capture the Lua 5.1 level-zero global environment", async () => {
  const provider = createFixtureProvider({
    "interface/framexml/framexml.toc": "GlobalStrings.lua\n",
    "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
    "interface/addons/media/media.toc": "## Version: wowi:revision 5.4.1\nMedia.lua\n",
    "interface/addons/media/media.lua": [
      "local environment = getfenv(0)",
      "CapturedPairs = environment.pairs == pairs",
      "CapturedVersion = GetAddOnMetadata('Media', 'Version')",
    ].join("\n"),
  });
  const boot = new FrameXmlBoot({ provider, installedAddons: ["Media"], exercise: false });
  try {
    await boot.load();
    const result = await boot.loadAddon("Media");
    assert.equal(result.ok, true, result.message);
    assert.equal(boot.vm.getGlobal("CapturedPairs"), true);
    assert.equal(boot.vm.getGlobal("CapturedVersion"), "wowi:revision 5.4.1");
  } finally {
    boot.close();
  }
});

test("every add-on Lua chunk receives its native name and stable private namespace", async () => {
  const provider = createFixtureProvider({
    "interface/framexml/framexml.toc": "GlobalStrings.lua\n",
    "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
    "interface/addons/namespaced/namespaced.toc": "First.lua\nSecond.lua\n",
    "interface/addons/namespaced/first.lua": "local name, private = ...; private.owner = name",
    "interface/addons/namespaced/second.lua": "local name, private = ...; NamespaceResult = name .. ':' .. private.owner",
  });
  const boot = new FrameXmlBoot({ provider, installedAddons: ["Namespaced"], exercise: false });
  try {
    await boot.load();
    const result = await boot.loadAddon("Namespaced");
    assert.equal(result.ok, true, result.message);
    assert.equal(boot.vm.getGlobal("NamespaceResult"), "Namespaced:Namespaced");
  } finally {
    boot.close();
  }
});

test("a failed add-on is not executed a second time against its partially mutated VM", async () => {
  const provider = createFixtureProvider({
    "interface/framexml/framexml.toc": "GlobalStrings.lua\n",
    "interface/framexml/globalstrings.lua": "ADDON_MISSING = 'missing'",
    "interface/addons/broken/broken.toc": "Broken.lua\n",
    "interface/addons/broken/broken.lua": "BrokenRuns = (BrokenRuns or 0) + 1; error('broken')",
  });
  const boot = new FrameXmlBoot({ provider, installedAddons: ["Broken"], exercise: false });
  try {
    await boot.load();
    const first = await boot.loadAddon("Broken");
    const second = await boot.loadAddon("Broken");
    assert.equal(first.ok, false);
    assert.equal(second, first);
    assert.equal(boot.vm.getGlobal("BrokenRuns"), 1);
  } finally {
    boot.close();
  }
});
