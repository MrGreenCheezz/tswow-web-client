import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Plan item 3.46 (13.10): GetAddOnInfo's «enabled», loadable and reason and LoadAddOn's refusal as Wow.exe 3.3.5a
// 12340 has them (0x00511240 → 0x005f7d70, 0x005f7650, 0x005f7e90; reasons 0x00ad17b4): the profile's switched-off
// add-ons listed as DISABLED, `## Interface` below 20000 INCOMPATIBLE, not 30300 with checkAddonVersion on
// INTERFACE_VERSION, a dependency that cannot load DEP_<its reason>; such add-ons do not load. The gateway lists the
// whole Interface/AddOns folder with the profile's states and Config.wtf's checkAddonVersion.
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import {
  frameXmlAddonDependencies, frameXmlAddonInterface, frameXmlAddonLoadReason,
} from "../dist/code/browser/framexml/FrameXmlAddonStates.js";
import { fetchFrameXmlClientAddonList } from "../dist/code/browser/framexml/FrameXmlClientAddons.js";
import { clientAddonVersionCheck, listClientAddons } from "../dist/code/gateway/ClientAddons.js";

function source(tocs, { disabled = [], loaded = [], check = true } = {}) {
  const lower = new Map(Object.entries(tocs).map(([name, toc]) => [name.toLowerCase(), toc]));
  return {
    installed: (name) => lower.has(name),
    disabled: (name) => disabled.includes(name),
    loaded: (name) => loaded.includes(name),
    toc: (name) => lower.get(name) ?? undefined,
    checkAddonVersion: check,
  };
}

test("0x005f7e90's reasons in its order; the out-of-date switch; dependencies; a cycle loads", () => {
  const tocs = {
    Good: "## Interface: 30300\nGood.lua",
    Old: "## Interface: 30000\nOld.lua",
    Ancient: "## Interface: 11200\nAncient.lua",
    Bare: "Bare.lua",
    Off: "## Interface: 11200\nOff.lua",
    NeedsGone: "## Interface: 30300\n## Dependencies: Gone\n",
    NeedsOff: "## Interface: 30300\n## RequiredDeps: Middle\n",
    Middle: "## Interface: 30300\n## DepsHere: Off\n",
    Loop1: "## Interface: 30300\n## Dependencies: Loop2\n",
    Loop2: "## Interface: 30300\n## Dependencies: Loop1\n",
    Unread: undefined,
  };
  const states = source(tocs, { disabled: ["off"] });
  const reason = (name, from = states) => frameXmlAddonLoadReason(from, name);
  assert.equal(reason("Good"), undefined);
  assert.equal(reason("Nowhere"), "MISSING");
  assert.equal(reason("Off"), "DISABLED", "disabled before the version is looked at");
  assert.equal(reason("Ancient"), "INCOMPATIBLE");
  assert.equal(reason("Bare"), "INCOMPATIBLE", "no `## Interface`: 0");
  assert.equal(reason("Old"), "INTERFACE_VERSION");
  assert.equal(reason("Old", source(tocs, { check: false })), undefined, "«Load out of date AddOns»");
  assert.equal(reason("Ancient", source(tocs, { check: false })), "INCOMPATIBLE", "the switch does not save it");
  assert.equal(reason("NeedsGone"), "DEP_MISSING");
  assert.equal(reason("NeedsOff"), "DEP_DISABLED", "the innermost dependency's reason");
  assert.equal(reason("NeedsOff", source(tocs, { disabled: ["off"], loaded: ["middle"] })), undefined, "a loaded dependency passes");
  assert.equal(reason("Loop1"), undefined, "a dependency being checked counts as loadable (+0x2d)");
  assert.equal(reason("Unread"), undefined, "a TOC not read yet is not judged");
  assert.equal(frameXmlAddonInterface("## Interface: 30300 beta\n"), 30300, "atoi");
  assert.equal(frameXmlAddonInterface("## Interface: x\n"), 0);
  assert.equal(frameXmlAddonInterface("## Interface: v30300\n"), 0, "atoi stops at the first non-digit");
  assert.deepEqual(frameXmlAddonDependencies("## Dependencies: A, B\n## RequiredDeps: b C\n## Dep: D\n## OptionalDeps: E\n"),
    ["A", "B", "C", "D"], "Dependencies, RequiredDeps and Dep… — not OptionalDeps");
});

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "addon-states-test", []);
  assert.ok(fn, code);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("GetAddOnInfo lists the switched-off and out-of-date add-ons with their reasons; they do not load", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "## Interface: 30300\nMain.lua",
      "interface/framexml/main.lua": "MAIN_RAN = true",
      "interface/addons/alpha/alpha.toc": "## Interface: 30300\n## Title: Alpha\nAlpha.lua",
      "interface/addons/alpha/alpha.lua": "ALPHA_RAN = true",
      "interface/addons/beta/beta.toc": "## Interface: 30300\nBeta.lua",
      "interface/addons/beta/beta.lua": "BETA_RAN = true",
      "interface/addons/old/old.toc": "## Interface: 30000\nOld.lua",
      "interface/addons/old/old.lua": "OLD_RAN = true",
      "interface/addons/kid/kid.toc": "## Interface: 30300\n## Dependencies: Beta\nKid.lua",
      "interface/addons/kid/kid.lua": "KID_RAN = true",
    }),
    installedAddons: ["Alpha", "Beta", "Kid", "Old"],
    eagerAddons: ["Alpha", "Kid", "Old"],
    addonStates: { disabled: ["Beta"], checkAddonVersion: true },
    exercise: false,
  });
  try {
    await boot.load();
    assert.deepEqual(lua(boot, "return GetNumAddOns()"), [4], "the switched-off one is listed");
    const info = (key) => lua(boot, `return select(4, GetAddOnInfo(${JSON.stringify(key)}))`, 4);
    assert.deepEqual(info("Alpha"), [1, 1, undefined, "INSECURE"], "loaded: loadable, no reason");
    assert.deepEqual(info("Beta"), [undefined, undefined, "DISABLED", "INSECURE"]);
    assert.deepEqual(info("Old"), [1, undefined, "INTERFACE_VERSION", "INSECURE"]);
    assert.deepEqual(info("Kid"), [1, undefined, "DEP_DISABLED", "INSECURE"]);
    assert.deepEqual(lua(boot, "return ALPHA_RAN, OLD_RAN, KID_RAN, BETA_RAN", 4), [true, undefined, undefined, undefined],
      "only Alpha loads at login");
    assert.deepEqual(lua(boot, "return LoadAddOn('Beta')", 2), [false, "DISABLED"]);
    assert.deepEqual(lua(boot, "return LoadAddOn('Old')", 2), [false, "INTERFACE_VERSION"]);
  } finally {
    boot.close();
  }
});

test("the gateway lists every installed add-on with the profile's state and reads checkAddonVersion", async () => {
  const root = await mkdtemp(join(tmpdir(), "webclient-addon-states-"));
  try {
    for (const name of ["Alpha", "Beta"]) {
      await mkdir(join(root, "Interface", "AddOns", name), { recursive: true });
      await writeFile(join(root, "Interface", "AddOns", name, `${name}.toc`), "## Interface: 30300\nMain.lua\n");
    }
    const profile = join(root, "WTF", "Account", "A", "R", "C");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "AddOns.txt"), "Beta: disabled\n");
    assert.deepEqual(await listClientAddons(root), [
      { name: "Alpha", loadOnDemand: false, enabled: true },
      { name: "Beta", loadOnDemand: false, enabled: false },
    ]);
    assert.equal(await clientAddonVersionCheck(root), true, "no Config.wtf: the CVar's default");
    await writeFile(join(root, "WTF", "Config.wtf"), 'SET locale "ruRU"\n');
    assert.equal(await clientAddonVersionCheck(root), true, "no line for it: the default");
    await writeFile(join(root, "WTF", "Config.wtf"), 'SET locale "ruRU"\r\nSET checkAddonVersion "0"\r\n');
    assert.equal(await clientAddonVersionCheck(root), false);
    await writeFile(join(root, "WTF", "Config.wtf"), 'SET checkAddonVersion "1"\n');
    assert.equal(await clientAddonVersionCheck(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the browser reads the whole list, and an older gateway's enabled list stands for it", async () => {
  const answer = (body) => async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  const newer = await fetchFrameXmlClientAddonList("http://127.0.0.1:1", answer({
    addons: [{ name: "Alpha", loadOnDemand: false }],
    installed: [{ name: "Alpha", loadOnDemand: false, enabled: true }, { name: "Beta", loadOnDemand: true, enabled: false }],
    checkAddonVersion: false,
  }));
  assert.deepEqual(newer.installed.map((addon) => [addon.name, addon.enabled]), [["Alpha", true], ["Beta", false]]);
  assert.equal(newer.checkAddonVersion, false);
  assert.deepEqual(newer.addons, [{ name: "Alpha", loadOnDemand: false }]);
  const older = await fetchFrameXmlClientAddonList("http://127.0.0.1:1", answer({ addons: [{ name: "Alpha", loadOnDemand: false }] }));
  assert.deepEqual(older.installed.map((addon) => [addon.name, addon.enabled]), [["Alpha", true]]);
  assert.equal(older.checkAddonVersion, true);
});
