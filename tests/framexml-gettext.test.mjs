// Plan item 1.13: the global GetText(token, gender, ordinal) as Wow.exe 0x81b720/0x819d40 answers it —
// four names tried in order, "_FEMALE" for gender 3, "_P<form>" by the locale's plural rule, "" when none.
import assert from "node:assert/strict";
import test from "node:test";

const { FRAMEXML_NEUTRAL_API, FRAMEXML_NEUTRAL_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

function withVm(locale, body) {
  const vm = new GlueLuaVm();
  try {
    vm.setGlobal("__fxNeutralImpl", {});
    vm.setGlobal("__fxAddonModules", []);
    if (locale !== undefined) vm.setGlobal("__fxLocale", locale);
    const loaded = vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@gettext:neutral");
    assert.equal(loaded.ok, true, loaded.error);
    const define = vm.execute(`
      GetText = __fxNeutralImpl.GetText
      function __probe(...) local value = GetText(...) return type(value) .. ":" .. tostring(value) end
      T_LABEL, T_LABEL_FEMALE = "a", "b"
      ONLY = "base"
      NUM = 12
      _G["12"] = "twelve"
      NOUN, NOUN_P1, NOUN_P2, NOUN_P2_FEMALE = "p0", "p1", "p2", "p2f"
    `, "@gettext:setup");
    assert.equal(define.ok, true, define.error);
    body((source) => {
      const run = vm.execute(`__out = ${source}`, "@gettext:probe");
      assert.equal(run.ok, true, run.error);
      return vm.getGlobal("__out");
    }, vm);
  } finally {
    vm.close();
  }
}

test("GetText is a neutral name answered by the Lua half", () => {
  const entry = FRAMEXML_NEUTRAL_API.find((candidate) => candidate.name === "GetText");
  assert.ok(entry, "GetText is in the census");
  assert.equal(entry.values, undefined);
});

test("gender 3 prefers the _FEMALE entry; other genders read the token", () => {
  withVm("enUS", (lua) => {
    assert.equal(lua(`__probe("T_LABEL", 3)`), "string:b");
    assert.equal(lua(`__probe("T_LABEL", 2)`), "string:a");
    assert.equal(lua(`__probe("T_LABEL")`), "string:a");
    assert.equal(lua(`__probe("T_LABEL", "3")`), "string:b", "a numeric string is a number");
    assert.equal(lua(`__probe("T_LABEL", 3.2)`), "string:b", "the gender is read as an integer");
    assert.equal(lua(`__probe("ONLY", 3)`), "string:base", "no _FEMALE entry: the token");
    assert.equal(lua(`__probe("NUM")`), "string:12", "a number global is converted");
  });
});

test("an unknown token answers the empty string, not nil; a non-string token is a usage error", () => {
  withVm("enUS", (lua, vm) => {
    assert.equal(lua(`__probe("NO_SUCH_TOKEN", 3)`), "string:");
    assert.equal(lua(`__probe(12)`), "string:twelve", "the number token 12 names the global \"12\"");
    const failed = vm.execute("GetText(nil)", "@gettext:usage");
    assert.equal(failed.ok, false);
    assert.match(String(failed.error), /Usage: GetText/);
  });
});

test("the ordinal picks a _P form by the locale's rule", () => {
  withVm("ruRU", (lua) => {
    assert.equal(lua(`__probe("NOUN", 2, 1)`), "string:p0", "ruRU: 1 is form 0, no suffix");
    assert.equal(lua(`__probe("NOUN", 2, 21)`), "string:p0");
    assert.equal(lua(`__probe("NOUN", 2, 3)`), "string:p1", "2..4 are form 1");
    assert.equal(lua(`__probe("NOUN", 2, 5)`), "string:p2");
    assert.equal(lua(`__probe("NOUN", 2, 12)`), "string:p2", "11..14 are form 2");
    assert.equal(lua(`__probe("NOUN", 3, 5)`), "string:p2f", "form and gender together");
    assert.equal(lua(`__probe("NOUN", 3, 3)`), "string:p1", "no _P1_FEMALE: _P1");
    assert.equal(lua(`__probe("NOUN")`), "string:p2", "no ordinal is -1, form 2 in ruRU");
  });
  withVm("enUS", (lua) => {
    assert.equal(lua(`__probe("NOUN", 2, 1)`), "string:p0");
    assert.equal(lua(`__probe("NOUN", 2, 2)`), "string:p1");
    assert.equal(lua(`__probe("NOUN")`), "string:p1", "enUS: -1 ~= 1 is form 1");
  });
  withVm("frFR", (lua) => {
    assert.equal(lua(`__probe("NOUN", 2, 0)`), "string:p0", "frFR: 0 is singular");
    assert.equal(lua(`__probe("NOUN")`), "string:p0");
    assert.equal(lua(`__probe("NOUN", 2, 2)`), "string:p1");
  });
});
