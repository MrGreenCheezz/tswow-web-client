import assert from "node:assert/strict";
import test from "node:test";

// Plan item 9.09: TSTL's `_G:Name(…)` (from `(_G as any).Name(…)`) passes _G as the first argument,
// in Wow.exe too; the client reports it with the file and line and runs it unchanged.
const {
  frameXmlGlobalSelfCalls, frameXmlIsTsAddonChunk, frameXmlGlobalSelfCallHint,
} = await import("../dist/code/browser/framexml/FrameXmlTsAddonLint.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

test("method calls on _G in code are found with their lines; comments, strings and other forms are not", () => {
  const source = [
    "local a = _G:StaticPopup_Show(\"X\")",          // 1: found
    "-- _G:Commented(1)",                            // 2
    "local s = \"_G:InString(1)\"",                  // 3
    "--[[ _G:Block(1)",                              // 4
    "_G:StillBlock(1) ]]",                           // 5
    "_G.StaticPopup_Show(\"Y\")",                    // 6: a dot call is fine
    "local t = x._G:Method(1)",                      // 7: a field named _G
    "_G : Spaced (1)",                               // 8: found
    "_G:Str \"x\"",                                  // 9: found (string-call sugar)
    "_G:Tab { 1 }",                                  // 10: found (table-call sugar)
    "local f = _G:NotACall",                         // 11: not a call (and not valid Lua)
    "local l = [[ _G:Long(1) ]]",                    // 12
    "__G:Other(1)",                                  // 13: another identifier
  ].join("\n");
  assert.deepEqual(frameXmlGlobalSelfCalls(source, "f.lua").map((call) => [call.line, call.name]), [
    [1, "StaticPopup_Show"], [8, "Spaced"], [9, "Str"], [10, "Tab"],
  ]);
});

test("only TSWoW blocks are linted, and the hint names the file, line and cure", () => {
  assert.equal(frameXmlIsTsAddonChunk("interface/framexml/tsaddons/retail-talents/addon/talent-ui.lua"), true);
  assert.equal(frameXmlIsTsAddonChunk("interface/framexml/uiparent.lua"), false);
  assert.equal(frameXmlGlobalSelfCallHint({ file: "a.lua", line: 440, name: "StaticPopup_Show" }),
    "a.lua:440: _G:StaticPopup_Show(…) передаёт _G первым аргументом — в Wow.exe вызов тоже не работает. "
    + "Объявите функцию с this: void и вызывайте StaticPopup_Show(…) без _G.");
});

test("the boot reports a TSWoW block's _G call and still runs it as Wow.exe does (_G first)", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": [
        "Main.lua",
        "## tsaddon-begin: bad-module", "TSAddons/bad-module/addon.lua", "## tsaddon-end: bad-module",
      ].join("\n"),
      "interface/framexml/main.lua": "function Probe(first, second) PROBE_FIRST_IS_G = first == _G; PROBE_SECOND = second end\n_G:Probe('stock is not linted')",
      "interface/framexml/tsaddons/bad-module/addon.lua": "local x = 1\n\n_G:Probe(\"dialog\")\n",
    }),
    exercise: false,
  });
  try {
    await boot.load();
    assert.deepEqual(boot.tsAddonHints.map((call) => [call.file, call.line, call.name]), [
      ["interface/framexml/tsaddons/bad-module/addon.lua", 3, "Probe"],
    ]);
    assert.equal(boot.vm.getGlobal("PROBE_FIRST_IS_G"), true, "behaviour unchanged: _G went first");
    assert.equal(boot.vm.getGlobal("PROBE_SECOND"), "dialog");
  } finally {
    boot.close();
  }
});
