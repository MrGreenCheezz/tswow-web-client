import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tswowInstall } from "../tools/paths.mjs";
import { doublePacket } from "../tools/check-tswow-addons.mjs";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { CustomPacketRegistry } from "../dist/code/world/CustomPacketRegistry.js";

// 9.03 end to end on the Lua side: a module message that arrives while the TSWoW Lua is still
// loading is held by the world's real CustomPacketRegistry, reaches the add-on's OnCustomPacket
// only after `consumerReady("lua")` (never inside the subscription made during the TOC load), and
// arrives with the bytes it was sent with. The real TSWoW RequireStub/ClientNetwork libraries.

let libraries;
try {
  const include = join(tswowInstall(), "bin", "include-addon");
  libraries = await Promise.all(["RequireStub.lua", "ClientNetwork.lua"].map((name) => readFile(join(include, name), "utf8")));
} catch { libraries = undefined; }

const prefix = "interface/framexml/";

function boot(registry) {
  return new FrameXmlBoot({
    provider: createFixtureProvider({
      [prefix + "framexml.toc"]: [
        "GlobalStrings.lua", "## tsaddon-begin-lib", "RequireStub.lua", "ClientNetwork.lua", "## tsaddon-end-lib",
        "## tsaddon-begin: entry-probe", "TSAddons/entry-probe/addon/addon.lua", "## tsaddon-end: entry-probe",
      ].join("\n"),
      [prefix + "globalstrings.lua"]: "SlashCmdList = {}; UIParent = CreateFrame('Frame', 'UIParent')",
      [prefix + "requirestub.lua"]: libraries[0],
      [prefix + "clientnetwork.lua"]: libraries[1],
      [prefix + "tsaddons/entry-probe/addon/addon.lua"]: `
        EntryProbeSeen = 0
        EntryProbeValues = ""
        OnCustomPacket(41, function(packet)
          EntryProbeSeen = EntryProbeSeen + 1
          EntryProbeValues = EntryProbeValues .. packet:ReadDouble() .. ";"
        end)
      `,
    }),
    subset: ["GlobalStrings.lua"], includeActiveTsAddons: true, clientNetwork: registry,
  });
}

test("a message held before the Lua loads reaches OnCustomPacket only after consumerReady, in order", {
  skip: libraries ? false : "TSWoW include-addon libraries are not installed",
}, async () => {
  const registry = new CustomPacketRegistry({ send() {}, schedule: () => () => {} });
  registry.beginBacklog({ expect: ["lua"] });
  assert.equal(registry.offer(41, doublePacket(7)), "held");
  assert.equal(registry.offer(41, doublePacket(8)), "held");
  const vm = boot(registry);
  try {
    await vm.load();
    assert.equal(vm.tsAddonResults[0]?.ok, true, JSON.stringify(vm.tsAddonResults));
    assert.equal(vm.vm.getGlobal("EntryProbeSeen"), 0, "nothing delivered during the TOC load or its subscription");
    registry.consumerReady("lua");
    assert.equal(vm.vm.getGlobal("EntryProbeSeen"), 0, "released on a microtask");
    await Promise.resolve();
    assert.equal(vm.vm.getGlobal("EntryProbeSeen"), 2);
    assert.equal(vm.vm.getGlobal("EntryProbeValues"), "7;8;");
    assert.equal(registry.offer(41, doublePacket(9)), "delivered");
    assert.equal(vm.vm.getGlobal("EntryProbeValues"), "7;8;9;");
    assert.deepEqual(vm.errors, []);
  } finally {
    vm.close();
  }
  assert.equal(registry.listenerCount, 0, "the bridge's subscriptions came off at close");
});

test("9.08: the bridge reports the Lua's subscribed opcodes as they appear, and the empty set at close", {
  skip: libraries ? false : "TSWoW include-addon libraries are not installed",
}, async () => {
  const registry = new CustomPacketRegistry({ send() {} });
  const seen = [];
  const host = new FrameXmlBoot({
    provider: createFixtureProvider({
      [prefix + "framexml.toc"]: [
        "GlobalStrings.lua", "## tsaddon-begin-lib", "RequireStub.lua", "ClientNetwork.lua", "## tsaddon-end-lib",
        "## tsaddon-begin: twin-probe", "TSAddons/twin-probe/addon/addon.lua", "## tsaddon-end: twin-probe",
      ].join("\n"),
      [prefix + "globalstrings.lua"]: "SlashCmdList = {}; UIParent = CreateFrame('Frame', 'UIParent')",
      [prefix + "requirestub.lua"]: libraries[0],
      [prefix + "clientnetwork.lua"]: libraries[1],
      [prefix + "tsaddons/twin-probe/addon/addon.lua"]: `
        OnCustomPacket(4001, function() end)
        OnCustomPacket(4003, function() end)
      `,
    }),
    subset: ["GlobalStrings.lua"], includeActiveTsAddons: true, clientNetwork: registry,
    clientNetworkChanged: (opcodes) => seen.push([...opcodes].sort((a, b) => a - b)),
  });
  try {
    await host.load();
    assert.deepEqual([...host.clientNetworkOpcodes()].sort((a, b) => a - b), [4001, 4003]);
    assert.deepEqual(seen.at(-1), [4001, 4003]);
  } finally {
    host.close();
  }
  assert.deepEqual(seen.at(-1), [], "close() hands the empty set, so the JSON windows come back");
  assert.deepEqual([...host.clientNetworkOpcodes()], []);
});
