import assert from "node:assert/strict";
import test from "node:test";

// Wow.exe's embedded compat chunk (0x00a44b1c): degree trigonometry and the other global aliases
// this VM lacked (FrameXmlLuaCompat.ts).
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

test("the corpus sees Wow.exe's global math, table and string aliases", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "A.lua",
      "interface/framexml/a.lua": `
        local function r(x) return string.format("%g", math.floor(x * 1000 + 0.5) / 1000) end
        local seen = {}
        foreach({ a = 1 }, function(k, v) seen[#seen + 1] = k .. v end)
        local firstOdd = foreachi({ 2, 4, 5, 6 }, function(i, v) if v % 2 == 1 then return i end end)
        RESULT = table.concat({
          r(sin(90)), r(cos(180)), r(tan(45)), r(asin(1)), r(acos(0)), r(atan(1)), r(atan2(1, 1)),
          r(deg(math.pi)), r(rad(180)), r(log10(1000)), r(log(exp(2))), select(2, frexp(8)), r(ldexp(0.5, 4)),
          strrev("abc"), ("  x  "):trim(), -- s:split(x) is strsplit(s, x): the delimiter is the receiver, as in the client
          table.concat({ (","):split("a,b") }, "|"), seen[1], firstOdd,
        }, " ")
      `,
    }),
    exercise: false,
  });
  try {
    await boot.load();
    assert.equal(boot.vm.getGlobal("RESULT"), "1 -1 1 90 90 45 45 180 3.142 3 2 4 8 cba x a|b a1 3");
  } finally {
    boot.close();
  }
});

test("the glue state has the same compat globals: Wow.exe runs compat.lua in every Lua state", async () => {
  // FrameScript_Initialize (0x00819bb0) ends by running the embedded «compat.lua» (text at 0x00a44980,
  // pointer 0x00af57f0); it is called at client start (0x00404130, the glue state) and again when the
  // game UI starts (0x0052a980). So GlueXML sees `sin` in degrees, `foreach`, `strrev`, `PI` too.
  const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
  const vm = new GlueLuaVm();
  try {
    const result = vm.execute(`
      local function r(x) return string.format("%g", math.floor(x * 1000 + 0.5) / 1000) end
      local seen = {}
      foreach({ a = 1 }, function(k, v) seen[#seen + 1] = k .. v end)
      local t = { 1 }
      table.wipe(t)
      GLUE_RESULT = table.concat({
        r(sin(90)), r(cos(180)), r(atan2(1, 1)), r(log10(100)), r(PI), strrev("ab"), ("  y "):trim(), seen[1],
        tostring(#t), tostring(foreachi({ 3 }, function(i, v) return v end)),
      }, " ")
    `, "@glue-compat-probe");
    assert.equal(result.ok, true, result.error);
    assert.equal(vm.getGlobal("GLUE_RESULT"), "1 -1 45 2 3.142 ba y a1 0 3");
  } finally {
    vm.close();
  }
});
