import assert from "node:assert/strict";
import test from "node:test";

// Plan items 2.05/3.22 (lane L1, 03.10) through the stock Lua (MPQ): UIParent shows END_BOUND_TRADEABLE
// with its kind as the dialog's data (UIParent.lua:769-771), the accept is EndBoundTradeable(data)
// (StaticPopup.lua:2396-2402) — "itemenchant" is BindEnchant's answered re-run, "gem" AcceptSockets
// (Wow.exe 0x005233d0) — and CURRENT_SPELL_CAST_CHANGED hides it (UIParent.lua:773-779). The new C
// functions of 1.10 and 3.23 are bound globals.
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

test("MPQ UIParent/StaticPopup: END_BOUND_TRADEABLE, its accept by kind, and the pending spell hiding it", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  let boot;
  try {
    const seam = new CannedWorldSeam();
    const log = [];
    seam.bindEnchant = () => { log.push("itemenchant"); };
    assert.ok(seam.socket, "the canned seam has a socket model");
    seam.socket.accept = () => { log.push("gem"); };
    boot = new FrameXmlBoot({
      provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
      locale: "ruRU",
      subset: FRAMEXML_VERTICAL_TOC,
      seam,
      screen: () => ({ width: 1024, height: 768 }),
    });
    await boot.load();
    const run = (code, name) => {
      const result = boot.vm.execute(code, name);
      assert.equal(result.ok, true, result.error);
    };
    run(`__kinds = type(EndBoundTradeable) .. type(DropItemOnUnit) .. type(PickupMerchantItem)`, "@bound:globals");
    assert.equal(boot.vm.getGlobal("__kinds"), "functionfunctionfunction");

    const show = (kind) => {
      boot.bridge.dispatchEvent("END_BOUND_TRADEABLE", kind);
      run(`__dialog = StaticPopup_Visible("END_BOUND_TRADEABLE")`, "@bound:show");
      const dialog = boot.vm.getGlobal("__dialog");
      assert.ok(typeof dialog === "string" && dialog.startsWith("StaticPopup"), `END_BOUND_TRADEABLE shown: ${dialog}`);
      return dialog;
    };
    run(`_G["${show("itemenchant")}Button1"]:Click()`, "@bound:accept");
    assert.deepEqual(log, ["itemenchant"], "EndBoundTradeable(\"itemenchant\")");
    run(`_G["${show("gem")}Button1"]:Click()`, "@bound:gem");
    assert.deepEqual(log, ["itemenchant", "gem"], "EndBoundTradeable(\"gem\") → AcceptSockets");
    run(`_G["${show("itemenchant")}Button2"]:Click()`, "@bound:cancel");
    assert.deepEqual(log, ["itemenchant", "gem"], "Cancel answers nothing");
    show("itemenchant");
    boot.bridge.dispatchEvent("CURRENT_SPELL_CAST_CHANGED");
    run(`__still = StaticPopup_Visible("END_BOUND_TRADEABLE")`, "@bound:hidden");
    assert.equal(boot.vm.getGlobal("__still"), undefined, "the pending spell changed: the question goes");
  } finally {
    boot?.close();
    chain.close();
  }
});
