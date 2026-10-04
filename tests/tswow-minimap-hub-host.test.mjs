import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import test, { after } from "node:test";

// 9.07: the minimap-hub module is not built yet, so `npm run tswow-addons:check` cannot reach it.
// This compiles the module's own addon.ts and the consumers' MinimapHubClient.ts in memory (the way
// the module's test compiles them), lays them over the real client's FrameXML.toc as TSAddon blocks,
// and runs the scenario from TSWOW_ADDON_SCENARIOS through checkTswowAddons in the real FrameXML
// host — the module's own test runs on a Lua mock of the client. The consumer modules are fixtures
// that do what their PLAYER_ENTERING_WORLD bootstrap does (register, else the legacy button).

const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

let install;
let clientDirectory;
let tstl;
try {
  const paths = await import("../tools/paths.mjs");
  install = paths.tswowInstall();
  clientDirectory = paths.clientDirectory();
  tstl = createRequire(join(install, "package.json"))("typescript-to-lua");
} catch { tstl = undefined; }
const MODULES = install ? join(install, "modules") : "";
const HUB = MODULES ? join(MODULES, "minimap-hub", "addon", "addon.ts") : "";
const CLIENT = MODULES ? join(MODULES, "baja-echoes", "addon", "MinimapHubClient.ts") : "";
const ready = tstl && clientDirectory && existsSync(HUB) && existsSync(CLIENT);
const skip = ready ? false : "no TSWoW install with typescript-to-lua, minimap-hub sources or 3.3.5a client";

function compile(file) {
  const own = join(MODULES, "minimap-hub", "addon", "global.d.ts");
  const typings = [
    existsSync(own) ? own : join(install, "bin", "include-addon", "global.d.ts"),
    join(install, "node_modules", "typescript-to-lua", "language-extensions", "index.d.ts"),
  ];
  const output = {};
  const result = tstl.transpileFiles([file, ...typings], {
    luaTarget: tstl.LuaTarget.Lua51, noImplicitSelf: true, luaLibImport: tstl.LuaLibImportKind.Require,
    skipLibCheck: true, types: [],
  }, (name, text) => { output[basename(name)] = text; });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.category === 1);
  assert.deepEqual(errors.map((diagnostic) => diagnostic.messageText), [], `${file} compiles`);
  const lua = output[basename(file).replace(/\.ts$/, ".lua")];
  assert.ok(lua, `Lua for ${file}`);
  return lua;
}

const CONSUMERS = [
  { module: "baja-echoes", id: "baja-echoes.collection", legacy: "BajaEchoCollectionMinimapButton" },
  { module: "base-building", id: "base-building.menu", legacy: "BaseBuildingMinimapButton" },
  { module: "custom-companions", id: "custom-companions.collection", legacy: "CustomCompanionsMinimapButton" },
];

/** The real FrameXML.toc with its TSAddon blocks replaced by the hub and the three consumers. */
function overlay(toc, hubLua, clientLua, { legacyAlways = false } = {}) {
  const lines = toc.split(/\r?\n/);
  const first = lines.findIndex((line) => /^##\s*tsaddon-begin/i.test(line));
  const lib = ["## tsaddon-begin-lib", "RequireStub.lua", "lualib_bundle.lua", "ClientNetwork.lua", "Events.lua", "json.lua", "## tsaddon-end-lib"];
  const blocks = [...lib, "## tsaddon-begin: minimap-hub", "TSAddons\\minimap-hub\\addon\\addon.lua", "## tsaddon-end: minimap-hub"];
  const files = new Map([["interface/framexml/tsaddons/minimap-hub/addon/addon.lua", hubLua]]);
  for (const consumer of CONSUMERS) {
    const helper = `TSAddons\\${consumer.module}\\addon\\MinimapHubClient.lua`;
    const entry = `TSAddons\\${consumer.module}\\addon\\addon.lua`;
    blocks.push(`## tsaddon-begin: ${consumer.module}`, helper, entry, `## tsaddon-end: ${consumer.module}`);
    files.set(normalize(`interface/framexml/${helper}`),
      `tstl_register_module("TSAddons.${consumer.module}.addon.MinimapHubClient", function()\n${clientLua}\nend)\n`);
    files.set(normalize(`interface/framexml/${entry}`), `
      local Hub = require("TSAddons.${consumer.module}.addon.MinimapHubClient")
      local events = CreateFrame("Frame")
      events:RegisterEvent("PLAYER_ENTERING_WORLD")
      events:SetScript("OnEvent", function()
        local inHub = Hub.registerMinimapEntry({ id = "${consumer.id}", icon = "Interface/Icons/INV_Misc_QuestionMark",
          title = "${consumer.module}", order = 10, onClick = function() end })
        if ${legacyAlways ? "true" : "not inHub"} and not _G["${consumer.legacy}"] then
          CreateFrame("Button", "${consumer.legacy}", Minimap)
        end
      end)
    `);
  }
  const kept = first < 0 ? lines : lines.filter((line, index) => {
    if (index < first) return true;
    return !/^##\s*tsaddon-/i.test(line) && !/^TSAddons[\\/]/i.test(line) && !/^(RequireStub|lualib_bundle|ClientNetwork|Events|json)\.lua$/i.test(line.trim());
  });
  const at = first < 0 ? kept.length : first;
  files.set("interface/framexml/framexml.toc", [...kept.slice(0, at), ...blocks, ...kept.slice(at)].join("\n"));
  return files;
}

async function providerFor(options) {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const read = async (path) => { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; };
  const toc = await read("Interface\\FrameXML\\FrameXML.toc");
  assert.ok(toc, "the client chain has a FrameXML.toc");
  const files = overlay(toc, compile(HUB), compile(CLIENT), options);
  const include = join(install, "bin", "include-addon");
  return {
    chain,
    provider: {
      async read(path) {
        const key = normalize(path);
        if (files.has(key)) return files.get(key);
        const data = await read(path);
        if (data !== undefined) return data;
        // The TSAddon library files when this client was never given a TSWoW addon build.
        const name = key.slice("interface/framexml/".length);
        const local = readdirSync(include).find((file) => file.toLowerCase() === name);
        return local ? readFileSync(join(include, local), "utf8") : undefined;
      },
    },
  };
}

test("the minimap-hub scenario passes in the real FrameXML host with the consumers registered", { skip }, async () => {
  const { checkTswowAddons, TSWOW_ADDON_SCENARIOS } = await import("../tools/check-tswow-addons.mjs");
  const { provider, chain } = await providerFor();
  const negatives = [];
  try {
    const consumerScenario = () => "fixture consumer";
    const report = await checkTswowAddons({
      provider,
      scenarios: {
        "minimap-hub": (context) => {
          const message = TSWOW_ADDON_SCENARIOS["minimap-hub"](context);
          // The same scenario must fail on what it guards: a hub whose panel never shows…
          const { boot } = context;
          const lua = (code) => {
            const chunk = boot.vm.compileFunction(code, "@negative", []);
            try { boot.vm.call(chunk, [], 0); } finally { boot.vm.release(chunk); }
          };
          const original = "__hubSlash = SlashCmdList.TSWOWMINIMAPHUB";
          lua(`${original} TswowMinimapHubPanel:Hide() SlashCmdList.TSWOWMINIMAPHUB = function() end`);
          try { TSWOW_ADDON_SCENARIOS["minimap-hub"](context); negatives.push("panel: passed"); }
          catch (error) { negatives.push(`panel: ${/TswowMinimapHubPanel/.test(error.message)}`); }
          lua("SlashCmdList.TSWOWMINIMAPHUB = __hubSlash TswowMinimapHubPanel:Hide()");
          // …and a legacy button beside the hub.
          lua(`CreateFrame("Button", "BaseBuildingMinimapButton", Minimap)`);
          try { TSWOW_ADDON_SCENARIOS["minimap-hub"](context); negatives.push("legacy: passed"); }
          catch (error) { negatives.push(`legacy: ${/BaseBuildingMinimapButton/.test(error.message)}`); }
          return message;
        },
        "baja-echoes": consumerScenario,
        "base-building": consumerScenario,
        "custom-companions": consumerScenario,
      },
    });
    const hub = report.results.find((result) => result.module === "minimap-hub");
    assert.ok(hub, JSON.stringify(report.results));
    assert.equal(hub.ok, true, hub.message);
    assert.match(hub.message, /hub holds 3 entries/);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(negatives, ["panel: true", "legacy: true"]);
  } finally {
    void chain; // shared per process (tools/mpq.mjs); closed once below
  }
});

test("a consumer that keeps its legacy button next to the hub fails the scenario", { skip }, async () => {
  const { checkTswowAddons, TSWOW_ADDON_SCENARIOS } = await import("../tools/check-tswow-addons.mjs");
  const { provider, chain } = await providerFor({ legacyAlways: true });
  try {
    const consumerScenario = () => "fixture consumer";
    const report = await checkTswowAddons({
      provider,
      scenarios: { "minimap-hub": TSWOW_ADDON_SCENARIOS["minimap-hub"], "baja-echoes": consumerScenario,
        "base-building": consumerScenario, "custom-companions": consumerScenario },
    });
    const hub = report.results.find((result) => result.module === "minimap-hub");
    assert.equal(hub.ok, false);
    assert.match(hub.message, /MinimapButton exists next to the hub/);
  } finally {
    void chain; // shared per process (tools/mpq.mjs); closed once below
  }
});

test("every TSWOW_ADDON_SCENARIOS key names a module with an addon directory in this install", {
  skip: MODULES && existsSync(MODULES) ? false : "no TSWoW install",
}, async () => {
  const { TSWOW_ADDON_SCENARIOS } = await import("../tools/check-tswow-addons.mjs");
  const stale = Object.keys(TSWOW_ADDON_SCENARIOS).filter((module) => !existsSync(join(MODULES, module, "addon")));
  assert.deepEqual(stale, [], "a scenario for a module that no longer exists");
});

after(async () => {
  if (!ready) return;
  const { clientArchives } = await import("../tools/mpq.mjs");
  (await clientArchives(clientDirectory)).close();
});
