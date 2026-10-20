import assert from "node:assert/strict";
import test from "node:test";
import { GLUE_MEASURED_SHIMS, GLUE_UNUSED_SHIMS, GlueLuaRef, GlueLuaVm } from "../dist/code/browser/glue/GlueLua.js";
import { lua, to_jsstring, to_luastring } from "../dist/code/browser/lua/LuaVm.js";

// Merged 2026-10-20 from 4 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── glue-lua.test.mjs
{
test("host calls collect variable Lua results and preserve the caller stack", () => {
  const vm = new GlueLuaVm();
  const fn = vm.compileFunction('return "first", nil, "third"', "@multi-results", []);
  const empty = vm.compileFunction('return', "@empty-results", []);
  try {
    const top = lua.lua_gettop(vm.state);
    assert.deepEqual(vm.call(fn, [], lua.LUA_MULTRET), ["first", undefined, "third"]);
    assert.equal(lua.lua_gettop(vm.state), top);
    assert.deepEqual(vm.call(empty, [], lua.LUA_MULTRET), []);
    assert.equal(lua.lua_gettop(vm.state), top);
    assert.deepEqual(vm.call(fn, [], 1), ["first"]);
    assert.equal(lua.lua_gettop(vm.state), top);
  } finally { vm.release(fn); vm.release(empty); vm.close(); }
});

// The shim layer is load-bearing in a very specific way: the corpus is 5.1 with
// Blizzard's flattened globals, so every name below is one a real GlueXML file
// calls. The counts come from the corpus itself.
test("the measured Lua 5.1 shims answer the way the corpus expects", () => {
  const vm = new GlueLuaVm();
  const evaluate = (expression) => {
    vm.setGlobal("__result", undefined);
    const outcome = vm.execute(`__result = (function() ${expression} end)()`, "@shim-probe");
    assert.equal(outcome.ok, true, `${expression}: ${outcome.error ?? ""}`);
    return vm.getGlobal("__result");
  };

  // Every global the shim preamble claims to install must exist.
  for (const name of Object.keys(GLUE_MEASURED_SHIMS)) {
    const expression = name.includes(".") ? `return type(${name})` : `return type(${name})`;
    assert.equal(evaluate(expression), "function", `${name} is missing`);
  }

  assert.equal(evaluate('return strupper("abc")'), "ABC");
  assert.equal(evaluate('return strlen("hello")'), 5);
  assert.equal(evaluate('return strsub("hello", 2, 3)'), "el");
  assert.equal(evaluate("return floor(2.9)"), 2);
  assert.equal(evaluate("return max(1, 9)"), 9);
  assert.equal(evaluate("return mod(7, 3)"), 1);
  assert.equal(evaluate("return unpack({7})"), 7);
  assert.equal(evaluate("return getn({1, 2, 3})"), 3);
  assert.equal(evaluate('FOO = 42; return getglobal("FOO")'), 42);
  assert.equal(evaluate('setglobal("BAR", 7); return BAR'), 7);
  assert.equal(evaluate("local m, e = math.frexp(8); return m .. \",\" .. e"), "0.5,4");

  // The client's format truncates a float for an integer conversion (5.3 raised).
  // The corpus divides and then formats, so this has to truncate rather than error.
  assert.equal(evaluate('return string.format("%d", 3.7)'), "3");
  assert.equal(evaluate('return string.format("%d items, 100%% done", 12 / 4)'), "3 items, 100% done");
  // 5.1 renders a whole float as "3" (5.3 said "3.0"); the corpus builds text out of these.
  assert.equal(evaluate("return tostring(6 / 2)"), "3");

  // Absence is a measurement too: nothing in the glue corpus calls setfenv/getfenv,
  // so the glue state runs without them (FrameXML's gets 5.1's back).
  for (const name of GLUE_UNUSED_SHIMS) {
    if (name === "setfenv" || name === "getfenv") {
      assert.equal(evaluate(`return type(${name})`), "nil", `${name} should not exist`);
    }
  }

  // The corpus runs behind the same capability boundary as the rest of the
  // compatibility layer: no filesystem, no loader, no package table.
  assert.equal(evaluate("return type(io)"), "nil");
  assert.equal(evaluate("return type(package)"), "nil");
  assert.equal(evaluate("return type(require)"), "nil");
  assert.equal(evaluate("return type(os.remove)"), "nil");
  assert.equal(evaluate("return type(os.date)"), "function");
  vm.close();
});

test("seterrorhandler receives script errors and securecall never escapes", () => {
  const host = [];
  const vm = new GlueLuaVm({ onError: (message) => host.push(message) });
  // This is GlueBasicControls.xml's own shape, verbatim in structure.
  assert.equal(vm.execute(`
    function _ERRORMESSAGE(message) LAST_ERROR = message end
    seterrorhandler(_ERRORMESSAGE)
  `, "@handler").ok, true);
  vm.execute('securecall(function() error("boom") end)', "@secure");
  assert.match(String(vm.getGlobal("LAST_ERROR")), /boom/);
  assert.equal(host.length, 0, "an installed handler keeps the error out of the host sink");

  // Without a handler the host sink is the fallback, and geterrorhandler still
  // has to answer with something callable — securecall calls it unconditionally.
  const bare = new GlueLuaVm({ onError: (message) => host.push(message) });
  bare.execute('securecall(function() error("bare") end)', "@bare");
  assert.equal(host.length, 1);
  assert.match(host[0], /bare/);
  vm.close();
  bare.close();
});

test("a compiled handler carries the measured parameter names and a vararg", () => {
  const vm = new GlueLuaVm();
  // GlueParent.xml's OnEvent body is literally `GlueParent_OnEvent(event, ...)`
  // with no function header, so the body must compile against those names.
  const handler = vm.compileFunction(
    "return event .. \":\" .. tostring(select('#', ...))",
    "GlueParent:OnEvent",
    ["self", "event"],
  );
  assert.ok(handler instanceof GlueLuaRef);
  assert.deepEqual(vm.call(handler, [undefined, "SET_GLUE_SCREEN", 1, 2], 1), ["SET_GLUE_SCREEN:2"]);

  // A syntax error is reported, not thrown, so one bad body cannot take the
  // screen down with it.
  const broken = vm.compileFunction("this is not lua", "Broken:OnLoad", ["self"]);
  assert.equal(broken, undefined);
  assert.equal(vm.errors.length, 1);
  vm.close();
});

test("an unknown escape lexes as Lua 5.1 lexed it: the backslash dropped, the character kept", () => {
  // The real case: `Interface\SharedXML\SharedGlueStrings.lua` from the
  // server's own patch archive contains `"… пароль? \Небезопасно …"`, which
  // 5.1 lexed by dropping the backslash and 5.2+ rejects outright.
  const vm = new GlueLuaVm({ onError: (message) => assert.fail(message) });
  assert.equal(vm.execute('BAD = "a? \\Не b"', "@relaxed.lua").ok, true);
  assert.equal(vm.getGlobal("BAD"), "a? Не b");
  // A chunk that is simply broken still fails.
  assert.equal(vm.execute("function (", "@broken.lua").ok, false);
  vm.close();
});

test("a JS binding marshals scalars and keeps a Lua function alive on request", () => {
  const vm = new GlueLuaVm();
  const seen = [];
  vm.registerGlobal("HostRecord", (args) => {
    seen.push(args);
    return ["ok", 7, true];
  });
  vm.execute('A, B, C = HostRecord("text", 5, false, nil)', "@binding");
  assert.deepEqual(seen[0].slice(0, 3), ["text", 5, false]);
  assert.equal(vm.getGlobal("A"), "ok");
  assert.equal(vm.getGlobal("B"), 7);
  assert.equal(vm.getGlobal("C"), true);

  let retained;
  vm.registerGlobal("HostKeep", (args) => {
    retained = vm.retain(args[0]);
    return [];
  });
  vm.execute("HostKeep(function(value) KEPT = value end)", "@retain");
  vm.call(retained, ["late"], 0);
  assert.equal(vm.getGlobal("KEPT"), "late");
  vm.close();
});

// --- The three divergences G3 found by running the corpus, not by reading it ----------------
//
// Each of these took a real login screen down under fengari (Lua 5.3, the VM before ARC-4), a *valid*
// Lua that PUC-Lua 5.1 — the one the corpus was written against, and the wasm VM's — differs from.

test("pairs and next walk the array part first, ascending, the way PUC-Lua does", () => {
  const vm = new GlueLuaVm();
  // The exact shape lgzg.lua's ModelList has: named fields first, then positional entries.
  vm.execute(`
    local t = { loaded = false, blend = 1, sceneData = { 1 }, "a", "b", "c" }
    local order = {}
    for key in pairs(t) do order[#order + 1] = tostring(key) end
    __order = table.concat(order, ",")
    local first, value = next(t)
    __first = tostring(first) .. "=" .. tostring(value)
  `, "@order");
  // The array run leads, in order; the named fields follow in whatever order the table holds them.
  const order = vm.getGlobal("__order").split(",");
  assert.deepEqual(order.slice(0, 3), ["1", "2", "3"], `traversal was ${order.join(",")}`);
  assert.equal(order.length, 6);
  assert.equal(vm.getGlobal("__first"), "1=a");
  vm.close();
});

test("table.insert keeps 5.1's unchecked position, which the corpus depends on", () => {
  const vm = new GlueLuaVm();
  vm.execute(`
    local t = {}
    local ok, err = pcall(table.insert, t, 7, "far")
    __ok = ok
    __err = tostring(err)
    __at7 = tostring(t[7])
    __len = #t
    local shift = { "a", "b" }
    table.insert(shift, 1, "z")
    __shift = table.concat(shift, ",")
  `, "@insert");
  // lgzg.lua's GetModelData rebuilds sparse lists this way; 5.2+ made it a hard error.
  assert.equal(vm.getGlobal("__ok"), true, vm.getGlobal("__err"));
  assert.equal(vm.getGlobal("__at7"), "far");
  // The two-argument form and the in-range shift must both keep working.
  assert.equal(vm.getGlobal("__shift"), "z,a,b");
  vm.close();
});

test("securecall returns every result, not the first", () => {
  const vm = new GlueLuaVm();
  vm.execute(`
    local function SecureNext(elements, key) return securecall(next, elements, key) end
    local seen = {}
    for index, value in SecureNext, { "a", "b" } do seen[#seen + 1] = index .. "=" .. tostring(value) end
    __seen = table.concat(seen, ",")
    __nils = select("#", securecall(function() return 1, nil, 3 end))
  `, "@securecall");
  // OptionsFrameTemplates.lua wraps `next` in exactly this shape; one result made every options
  // list index a nil value on its first iteration.
  assert.equal(vm.getGlobal("__seen"), "1=a,2=b");
  assert.equal(vm.getGlobal("__nils"), 3, "a nil in the middle of the result list must survive");
  vm.close();
});

// P1-14c: every host call stages the same traceback handler — it captures nothing, so a closure
// per call was garbage — and a call that asks for no results hands back no new array.
test("host calls share one traceback handler and keep the traceback on errors", () => {
  const errors = [];
  const vm = new GlueLuaVm({ onError: (message) => errors.push(message) });
  const fn = vm.compileFunction("return", "@one-handler", []);
  const fail = vm.compileFunction('error("deep")', "@fails-here", []);
  const pushed = [];
  const original = lua.lua_pushjsfunction;
  lua.lua_pushjsfunction = (state, callback) => { pushed.push(callback); return original(state, callback); };
  let empty;
  try {
    vm.call(fn);
    vm.call(fn);
    empty = vm.call(fn, [], 0);
    vm.call(fail);
  } finally {
    lua.lua_pushjsfunction = original;
  }
  assert.equal(pushed.length, 4, "one handler pushed per call");
  assert.equal(new Set(pushed).size, 1, "the same handler every time");
  assert.equal(empty.length, 0);
  assert.ok(Object.isFrozen(empty), "no-result calls answer the shared frozen empty list");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /fails-here:2: deep/);
  assert.match(errors[0], /stack traceback:/, "the handler still appends the traceback");
  vm.release(fn);
  vm.release(fail);
  vm.close();
});
}

// ── glue-lua-large-number.test.mjs
{
const CAST_START_MS = 1788097991493;
const CAST_END_MS = 1788097992993;

test("a UnitCastingInfo-shaped binding preserves epoch milliseconds and all tuple slots", () => {
  const vm = new GlueLuaVm();
  vm.registerGlobal("UnitCastingInfo", () => [
    "Огненный шар",
    "Уровень 1",
    "Огненный шар",
    "Interface\\Icons\\Spell_Fire_FlameBolt",
    CAST_START_MS,
    CAST_END_MS,
    false,
    42,
    true,
  ]);

  const outcome = vm.execute(`
    local name, rank, displayName, texture, startTime, endTime, isTradeSkill, castID, notInterruptible = UnitCastingInfo("player")
    captureName = name
    captureRank = rank
    captureDisplayName = displayName
    captureTexture = texture
    captureStart = startTime
    captureEnd = endTime
    captureTradeSkill = isTradeSkill
    captureCastID = castID
    captureNotInterruptible = notInterruptible
    captureStartExact = (startTime == 1788097991493)
    captureEndExact = (endTime == 1788097992993)
    captureSmallText = tostring(castID - 41)
  `, "@large-number-probe");

  assert.equal(outcome.ok, true, outcome.error ?? "UnitCastingInfo binding failed");
  assert.equal(vm.getGlobal("captureName"), "Огненный шар");
  assert.equal(vm.getGlobal("captureRank"), "Уровень 1");
  assert.equal(vm.getGlobal("captureDisplayName"), "Огненный шар");
  assert.equal(vm.getGlobal("captureTexture"), "Interface\\Icons\\Spell_Fire_FlameBolt");
  assert.equal(vm.getGlobal("captureStart"), CAST_START_MS);
  assert.equal(vm.getGlobal("captureEnd"), CAST_END_MS);
  assert.equal(vm.getGlobal("captureTradeSkill"), false);
  assert.equal(vm.getGlobal("captureCastID"), 42);
  assert.equal(vm.getGlobal("captureNotInterruptible"), true);
  assert.equal(vm.getGlobal("captureStartExact"), true);
  assert.equal(vm.getGlobal("captureEndExact"), true);
  assert.equal(vm.getGlobal("captureSmallText"), "1");
  assert.deepEqual(vm.errors, []);
  vm.close();
});

// ARC-4 A6 (12.10): named for fengari's 5.3, where only int32-range whole numbers crossed as Lua integers;
// on 5.1 every number is a double, and the answers below are the same.
test("a small whole number prints as \"1\" and an epoch millisecond stays exact", () => {
  const vm = new GlueLuaVm();
  vm.registerGlobal("Numbers", () => [1, CAST_START_MS]);
  const outcome = vm.execute("small, large = Numbers(); smallText = tostring(small); largeExact = (large == 1788097991493)", "@number-format-probe");

  assert.equal(outcome.ok, true, outcome.error ?? "number binding failed");
  assert.equal(vm.getGlobal("small"), 1);
  assert.equal(vm.getGlobal("smallText"), "1");
  assert.equal(vm.getGlobal("large"), CAST_START_MS);
  assert.equal(vm.getGlobal("largeExact"), true);
  assert.deepEqual(vm.errors, []);
  vm.close();
});
}

// ── glue-lua-stack.test.mjs
{
// A host call starts with LUA_MINSTACK (20) free slots. A 3.3.5 COMBAT_LOG_EVENT_UNFILTERED carries
// the event name and nineteen payload values, and `__glueInvoke` adds fn/self/isEvent in front.
test("a host call with more arguments than LUA_MINSTACK reaches Lua instead of throwing", () => {
  const args = Array.from({ length: 25 }, (_, index) => index + 1);
  // Each path on a fresh state: a successful grow on one would leave room for the other.
  const errors = [];
  const vm = new GlueLuaVm({ onError: (message) => errors.push(message) });
  const count = vm.compileFunction("return select('#', ...), (select(25, ...))", "@many-args", []);
  try {
    const top = lua.lua_gettop(vm.state);
    assert.deepEqual(vm.call(count, args, 2), [25, 25]);
    assert.equal(lua.lua_gettop(vm.state), top, "the caller's stack is left as it was");
    assert.deepEqual(errors, []);
  } finally { vm.release(count); vm.close(); }
  const chunkVm = new GlueLuaVm();
  try {
    const result = chunkVm.execute("ManyArgs = select('#', ...)", "@many-args-chunk", args);
    assert.equal(result.ok, true, result.error);
    assert.equal(chunkVm.getGlobal("ManyArgs"), 25);
  } finally { chunkVm.close(); }
});

test("collectgarbage answers every 5.1 option without raising, and still rejects an unknown one", () => {
  const vm = new GlueLuaVm();
  try {
    const run = (source) => {
      const result = vm.execute(`Out = { pcall(function() ${source} end) }`, "@gc");
      assert.equal(result.ok, true, result.error);
      const out = vm.execute("OutOk, OutValue = Out[1], Out[2]", "@gc-read");
      assert.equal(out.ok, true);
      return [vm.getGlobal("OutOk"), vm.getGlobal("OutValue")];
    };
    // MSBTProfiles.lua:2097, measured raising «lua_gc not implemented» at boot.
    assert.deepEqual(run(`return collectgarbage("collect")`), [true, 0]);
    assert.deepEqual(run(`return collectgarbage()`), [true, 0]);
    assert.deepEqual(run(`return type(collectgarbage("count"))`), [true, "number"]);
    assert.deepEqual(run(`return collectgarbage("step")`), [true, true]);
    assert.deepEqual(run(`return type(gcinfo())`), [true, "number"]);
    const [ok, message] = run(`return collectgarbage("nonsense")`);
    assert.equal(ok, false);
    assert.match(String(message), /invalid option 'nonsense'/);
  } finally { vm.close(); }
});
}

// ── glue-lua-strings.test.mjs
{
// P1-14b: Lua strings reach a binding through luaStringToJs (LuaStrings.ts), which must give the
// exact text the API's lossy decoder gives — `to_jsstring(bytes, 0, n, true)`, fengari's decoder
// kept in LuaApi.ts — for any bytes.
const { luaStringToJs } = await import("../dist/code/browser/glue/LuaStrings.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  [0x61], [0x7a, 0x30, 0x20], [0x00], [0x7f],
  [...to_luastring("Восстановление")], [...to_luastring("€")], [...to_luastring("😀")],
  [0xef, 0xbb, 0xbf], // BOM
  [0xd0], [0xe2, 0x82], [0xf0, 0x9f, 0x98], // cut sequences
  [0xc0, 0x80], [0xc1, 0xbf], [0xe0, 0x80, 0x80], [0xf0, 0x80, 0x80, 0x80], // overlongs
  [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], // surrogates
  [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xff], [0x80], [0xbf, 0x61],
];

test("luaStringToJs equals the API's lossy decoder on generated bytes", () => {
  const next = random(1405);
  for (let index = 0; index < 50000; index += 1) {
    const bytes = [];
    const count = Math.floor(next() * 8);
    for (let piece = 0; piece < count; piece += 1) {
      if (next() < 0.15) bytes.push(Math.floor(next() * 256));
      else bytes.push(...PIECES[Math.floor(next() * PIECES.length)]);
    }
    const u8 = Uint8Array.from(bytes);
    assert.equal(luaStringToJs(u8), to_jsstring(u8, 0, u8.length, true), `bytes ${bytes.join(",")}`);
  }
  // The short ASCII path, the long path and the boundary between them.
  for (const length of [0, 1, 15, 16, 17, 30, 200]) {
    const u8 = Uint8Array.from({ length }, (_, at) => 0x41 + (at % 26));
    assert.equal(luaStringToJs(u8), to_jsstring(u8, 0, length, true));
  }
  // A leading BOM survives, as the lossy decoder keeps it.
  assert.equal(luaStringToJs(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])), "﻿a");
});

test("a 30-byte ASCII argument crosses into a binding without a String.fromCharCode per byte", () => {
  const vm = new GlueLuaVm();
  const seen = [];
  vm.registerGlobal("StringProbe", (args) => { seen.push(args[0], args[1]); return []; });
  const fn = vm.compileFunction('StringProbe("abcdefghijklmnopqrstuvwxyz0123", "Восстановление сил")', "string-probe", []);
  const original = String.fromCharCode;
  let calls = 0;
  String.fromCharCode = function (...codes) { calls += 1; return original.apply(this, codes); };
  try { vm.call(fn); } finally { String.fromCharCode = original; }
  assert.deepEqual(seen, ["abcdefghijklmnopqrstuvwxyz0123", "Восстановление сил"]);
  assert.ok(calls <= 1, `String.fromCharCode called ${calls} times`);
  vm.release(fn);
  vm.close();
});
}
