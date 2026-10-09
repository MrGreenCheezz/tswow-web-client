import assert from "node:assert/strict";
import test from "node:test";
import {
  GLUE_MEASURED_SHIMS,
  GLUE_UNUSED_SHIMS,
  GlueLuaRef,
  GlueLuaVm,
  relaxLua51Escapes,
} from "../dist/code/browser/glue/GlueLua.js";
import { lua } from "fengari";

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

// The shim layer is load-bearing in a very specific way: fengari is Lua 5.3 and
// the corpus is 5.1 with Blizzard's flattened globals, so every name below is
// one a real GlueXML file calls. The counts come from the corpus itself.
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

  // 5.3 raises on an integer conversion of a float; 5.1 truncated. The corpus
  // divides and then formats, so this has to truncate rather than error.
  assert.equal(evaluate('return string.format("%d", 3.7)'), "3");
  assert.equal(evaluate('return string.format("%d items, 100%% done", 12 / 4)'), "3 items, 100% done");
  // 5.3 renders a whole float as "3.0"; the corpus builds text out of these.
  assert.equal(evaluate("return tostring(6 / 2)"), "3");

  // Absence is a measurement too: nothing in the corpus calls setfenv/getfenv,
  // so the _ENV upvalue surgery 5.3 would need is deliberately not implemented.
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

test("Lua 5.1's unknown-escape rule rescues a chunk 5.3 refuses to lex", () => {
  // The real case: `Interface\SharedXML\SharedGlueStrings.lua` from the
  // server's own patch archive contains `"… пароль? \Небезопасно …"`, which
  // 5.1 lexed by dropping the backslash and 5.2+ rejects outright.
  assert.deepEqual(relaxLua51Escapes('x = "a? \\Не b"'), { source: 'x = "a? Не b"', rewrites: 1 });
  // Escapes 5.3 already understands are untouched, in either quote style.
  assert.deepEqual(relaxLua51Escapes('x = "a\\nb\\\\c\\"d"'), { source: 'x = "a\\nb\\\\c\\"d"', rewrites: 0 });
  assert.deepEqual(relaxLua51Escapes("x = 'a\\065\\x41\\z b'"), { source: "x = 'a\\065\\x41\\z b'", rewrites: 0 });
  // Comments and long-bracket strings are copied through verbatim: a backslash
  // there is already literal and rewriting it would change the program.
  assert.deepEqual(relaxLua51Escapes("-- a \\Q comment\nx = 1"), { source: "-- a \\Q comment\nx = 1", rewrites: 0 });
  assert.deepEqual(relaxLua51Escapes("x = [[a \\Q b]]"), { source: "x = [[a \\Q b]]", rewrites: 0 });
  assert.deepEqual(relaxLua51Escapes("--[==[ \\Q ]==] y = 2"), { source: "--[==[ \\Q ]==] y = 2", rewrites: 0 });

  const vm = new GlueLuaVm({ onError: (message) => assert.fail(message) });
  assert.equal(vm.execute('BAD = "a? \\Не b"', "@relaxed.lua").ok, true);
  assert.equal(vm.getGlobal("BAD"), "a? Не b");
  assert.deepEqual(vm.relaxedChunks, ["@relaxed.lua"]);
  // A chunk that is simply broken still fails; the retry is not a catch-all.
  assert.equal(vm.execute("function (", "@broken.lua").ok, false);
  assert.deepEqual(vm.relaxedChunks, ["@relaxed.lua"]);
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
// Each of these took a real login screen down, and each is a place where fengari is a *valid* Lua
// and PUC-Lua 5.1 — the one the corpus was written against — is a different one.

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
