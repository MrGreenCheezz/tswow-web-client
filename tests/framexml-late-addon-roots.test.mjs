import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 3.18 (owner, 12.10): a third-party LoD add-on now runs when Lua asks for it, after the HUD is up, so the
// boot tells its listeners of the XML roots each load makes, with the add-on's name, and the world mount
// draws the parentless ones of add-ons it does not own — as it draws those of add-ons loaded before it.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { frameXmlOwnerAddon } = await import("../dist/code/browser/framexml/FrameXmlAddonRuntime.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "late-roots-test", []);
  assert.ok(fn);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

async function booted() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Main.lua",
      "interface/framexml/main.lua": "UIParent = CreateFrame('Frame', 'UIParent')",
      "interface/addons/lateui/lateui.toc": "## Interface: 30300\n## LoadOnDemand: 1\nLateUI.xml",
      "interface/addons/lateui/lateui.xml":
        '<Ui><Frame name="LateUIWindow" hidden="true"/><Frame name="LateUIChild" parent="UIParent"/></Ui>',
    }),
    installedAddons: ["LateUI"],
    exercise: false,
  });
  await boot.load();
  return boot;
}

test("3.18 a LoD add-on Lua loads late tells the listeners its roots and its name", async () => {
  const boot = await booted();
  const told = [];
  const unsubscribe = boot.onAddonRoots((roots, addon) => told.push([addon, roots.map((root) => root.name).sort()]));
  try {
    assert.ok(await boot.prefetchAddon("LateUI"), "the files are in memory");
    assert.deepEqual(lua(boot, "return LoadAddOn('LateUI')", 2), [1, undefined], "run inside the call");
    assert.deepEqual(told, [["LateUI", ["LateUIWindow"]]], "its top-level frame; one with a parent is no root");
    assert.equal(boot.bridge.getFrame("LateUIWindow")?.parent, undefined, "the window is a parentless root the mount has to draw");
    assert.ok(boot.bridge.getFrame("LateUIChild")?.parent, "the child draws through its parent");
  } finally {
    unsubscribe();
    boot.close();
  }
});

test("3.18 an unsubscribed listener hears nothing more", async () => {
  const boot = await booted();
  const told = [];
  const unsubscribe = boot.onAddonRoots((roots, addon) => told.push(addon));
  unsubscribe();
  try {
    await boot.prefetchAddon("LateUI");
    lua(boot, "return LoadAddOn('LateUI')", 2);
    assert.deepEqual(told, []);
  } finally {
    boot.close();
  }
});

test("3.18 the mount draws a late third-party add-on's parentless roots and leaves owner add-ons to their owners", async () => {
  assert.equal(frameXmlOwnerAddon("Blizzard_TalentUI"), true);
  assert.equal(frameXmlOwnerAddon("blizzard_trainerui"), true, "case-blind, as the policy");
  assert.equal(frameXmlOwnerAddon("MSBTOptions"), false);
  const source = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  assert.match(source,
    /resources\.addonRootsCleanup = boot\.onAddonRoots\(\(roots, addon\) => \{\s*if \(resources\.renderer !== renderer \|\| frameXmlOwnerAddon\(addon\)\) return;\s*renderer\.addRoots\(roots\.filter\(\(root\) => !root\.parent\)\);/,
    "subscribed right after the mount, owners and parented roots left out");
  assert.match(source, /function cleanupPublishedMount\(record: FrameXmlMountResources\): void \{[\s\S]{0,200}record\.addonRootsCleanup\?\.\(\)/,
    "and unsubscribed with the mount");
});
