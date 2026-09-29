import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tswowInstall } from "../tools/paths.mjs";
import { doublePacket, TswowAddonTestTransport } from "../tools/check-tswow-addons.mjs";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { discoverFrameXmlAddonEntrypoints } from "../dist/code/browser/framexml/FrameXmlAddonEntrypoints.js";

let libraries;
try {
  const include = join(tswowInstall(), "bin", "include-addon");
  libraries = await Promise.all(["RequireStub.lua", "ClientNetwork.lua"].map((name) => readFile(join(include, name), "utf8")));
} catch { libraries = undefined; }

test("a new module uses the real TSWoW require/network libraries for lifecycle, commands, buttons and replies", {
  skip: libraries ? false : "TSWoW include-addon libraries are not installed",
}, async () => {
  class ReplyTransport extends TswowAddonTestTransport {
    sendRaw(opcode, body) {
      super.sendRaw(opcode, body);
      if (opcode === 65000) this.receive(65001, body);
    }
  }
  const packets = new ReplyTransport();
  const prefix = "interface/framexml/";
  // TSTL's registration/import shape, with a previously unknown module name and no host changes.
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      [prefix + "framexml.toc"]: [
        "GlobalStrings.lua", "## tsaddon-begin-lib", "RequireStub.lua", "ClientNetwork.lua",
        "## tsaddon-end-lib", "## tsaddon-begin: author-future-panel",
        "TSAddons/author-future-panel/shared/Messages.lua",
        "TSAddons/author-future-panel/addon/addon.lua", "## tsaddon-end: author-future-panel",
      ].join("\n"),
      [prefix + "globalstrings.lua"]: "SlashCmdList = {}; UIParent = CreateFrame('Frame', 'UIParent')",
      [prefix + "requirestub.lua"]: libraries[0],
      [prefix + "clientnetwork.lua"]: libraries[1],
      [prefix + "tsaddons/author-future-panel/shared/messages.lua"]: `
        tstl_register_module("TSAddons.author-future-panel.shared.Messages", function()
          FutureImports = (FutureImports or 0) + 1
          local exports = {}
          exports.send = function(value) CreateCustomPacket(65000, 0):WriteDouble(value):Send() end
          return exports
        end)
      `,
      [prefix + "tsaddons/author-future-panel/addon/addon.lua"]: `
        local Messages = require("TSAddons.author-future-panel.shared.Messages")
        assert(Messages == require("TSAddons.author-future-panel.shared.Messages"))
        local frame = CreateFrame("Button", "FutureAddonButton", UIParent)
        frame:SetSize(160, 28)
        frame:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
        OnCustomPacket(65001, function(packet) frame:SetText("ack:" .. packet:ReadDouble()) end)
        frame:RegisterEvent("PLAYER_ENTERING_WORLD")
        frame:SetScript("OnEvent", function() Messages.send(7) end)
        frame:SetScript("OnClick", function() Messages.send(8) end)
        SLASH_FUTUREPANEL1 = "/futurepanel"
        SlashCmdList.FUTUREPANEL = function() frame:Click() end
      `,
    }),
    subset: ["GlobalStrings.lua"], includeActiveTsAddons: true, clientNetwork: packets,
  });
  let entrypoints;
  try {
    await boot.load();
    assert.equal(boot.vm.getGlobal("FutureImports"), 1);
    assert.equal(boot.tsAddonResults[0].ok, true);
    assert.equal(boot.bridge.getFrame("FutureAddonButton").text, "ack:7");
    assert.deepEqual(packets.sent, [{ opcode: 65000, body: doublePacket(7) }]);
    entrypoints = discoverFrameXmlAddonEntrypoints(boot);
    assert.equal(entrypoints.commands[0].name, "futurepanel");
    entrypoints.commands[0].run("");
    assert.equal(boot.bridge.getFrame("FutureAddonButton").text, "ack:8");
    assert.deepEqual(packets.sent[1], { opcode: 65000, body: doublePacket(8) });
    assert.deepEqual(boot.errors, []);
  } finally { entrypoints?.close(); boot.close(); }
  assert.equal(packets.handlers.size, 0);
});
