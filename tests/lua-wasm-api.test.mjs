import assert from "node:assert/strict";
import test from "node:test";

import { lua51NumberText } from "../dist/code/browser/glue/GlueLuaBase51.js";
import {
  LUA_RAISE, lauxlib, lua, lualib, luaWasmFootprint, luaWasmRestoreEnvironment, push, releaseLuaPointer,
  to_jsstring, to_luastring, tojs,
} from "../dist/code/browser/lua/LuaApi.js";

// ARC-4 (A2): the fengari-shaped API over PUC Lua 5.1.5 in WebAssembly, checked on its own — states,
// chunks, pcall and errors (Lua's and a JS host function's), coroutines through host functions, Wow.exe
// number text, `bit`, the function registry and pointer tokens. The runtimes on top of it (GlueLua,
// FrameXML) are checked by their own tests once they run on this VM (line-ARC4 A3/A4).

function state() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  return L;
}

/** Runs `source`, answers its results as JS scalars, or throws the Lua error text. */
function run(L, source, ...args) {
  const top = lua.lua_gettop(L);
  assert.equal(lauxlib.luaL_loadbuffer(L, to_luastring(source), null, to_luastring("=test")), lua.LUA_OK,
    () => to_jsstring(lua.lua_tolstring(L, -1)));
  for (const arg of args) push(L, arg);
  const status = lua.lua_pcall(L, args.length, lua.LUA_MULTRET, 0);
  if (status !== lua.LUA_OK) {
    const message = lua.lua_tojsstring(L, -1);
    lua.lua_settop(L, top);
    throw new Error(message);
  }
  const results = [];
  for (let index = top + 1; index <= lua.lua_gettop(L); index++) results.push(tojs(L, index));
  lua.lua_settop(L, top);
  return results;
}

test("a state runs Lua 5.1: version, arithmetic, strings, tables, string library", () => {
  const L = state();
  assert.deepEqual(run(L, "return _VERSION"), ["Lua 5.1"]);
  assert.deepEqual(run(L, "local t = {} for i = 1, 10 do t[i] = i * i end return #t, t[10], table.concat({1, 2, 3}, ',')"), [10, 100, "1,2,3"]);
  assert.deepEqual(run(L, "return string.format('%d:%s:%5.2f', 7, 'abc', 3.14159), ('x'):rep(3)"), ["7:abc: 3.14", "xxx"]);
  assert.deepEqual(run(L, "return select('#', ...), ...", 1, "two", true), [3, 1, "two", true]);
  assert.deepEqual(run(L, "return getn ~= nil, unpack ~= nil, loadstring ~= nil, table.unpack"), [false, true, true, undefined],
    "5.1's own globals: unpack and loadstring exist, table.unpack does not");
  // 5.3 semantics the runtimes rely on: a getter answers the type of what it pushed.
  run(L, "answer = { 42, name = 'x' }");
  assert.equal(lua.lua_getglobal(L, to_luastring("answer")), lua.LUA_TTABLE);
  assert.equal(lua.lua_getfield(L, -1, to_luastring("name")), lua.LUA_TSTRING);
  assert.equal(lua.lua_rawgeti(L, -2, 1), lua.LUA_TNUMBER);
  assert.equal(lua.lua_getglobal(L, to_luastring("missing")), lua.LUA_TNIL);
  lua.lua_settop(L, 0);
  lua.lua_close(L);
});

test("errors: Lua's own, luaL_error from a host function, and a JS exception become Lua errors", () => {
  const L = state();
  assert.deepEqual(run(L, "local ok, err = pcall(error, 'boom') return ok, err"), [false, "boom"]);
  assert.throws(() => run(L, "local t = nil return t.x"), /attempt to index local 't' \(a nil value\)/, "5.1's wording");
  lua.lua_pushjsfunction(L, (state) => lauxlib.luaL_error(state, to_luastring("host refused")));
  lua.lua_setglobal(L, to_luastring("refuse"));
  assert.deepEqual(run(L, "local ok, err = pcall(refuse) return ok, err"), [false, "host refused"]);
  lua.lua_pushjsfunction(L, () => { throw new Error("js broke"); });
  lua.lua_setglobal(L, to_luastring("explode"));
  assert.deepEqual(run(L, "local ok, err = pcall(explode) return ok, err"), [false, "js broke"]);
  lua.lua_pushjsfunction(L, (state) => lauxlib.luaL_checkinteger(state, 1));
  lua.lua_setglobal(L, to_luastring("needsNumber"));
  assert.throws(() => run(L, "needsNumber('x')"), /bad argument #1 to 'needsNumber' \(number expected, got string\)/);
  assert.equal(typeof LUA_RAISE, "object");
  lua.lua_close(L);
});

test("coroutines through host functions, and a nested pcall from inside a host function", () => {
  const L = state();
  lua.lua_pushjsfunction(L, (state) => {
    lua.lua_pushnumber(state, lua.lua_tonumber(state, 1) * 2);
    return 1;
  });
  lua.lua_setglobal(L, to_luastring("double"));
  assert.deepEqual(run(L, "local co = coroutine.wrap(function() coroutine.yield(double(1)) coroutine.yield(double(2)) return double(3) end) return co() + co() + co()"), [12]);
  lua.lua_pushjsfunction(L, (state) => {
    lua.lua_getglobal(state, to_luastring("inner"));
    const status = lua.lua_pcall(state, 0, 1, 0);
    lua.lua_pushboolean(state, status === lua.LUA_OK);
    lua.lua_insert(state, -2);
    return 2;
  });
  lua.lua_setglobal(L, to_luastring("callInner"));
  run(L, "function inner() error('inner failed') end");
  assert.deepEqual(run(L, "return callInner()"), [false, "test:1: inner failed"]);
  lua.lua_close(L);
});

test("numbers read as Wow.exe writes them: 10^5 random doubles equal lua51NumberText", () => {
  const L = state();
  let seed = 777;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const values = [123456789012345, 0.1, 1e14, 99999999999999.5, 1e-5, 0.0001, -1e300, 5e-324, 1e15, -0, Infinity, -Infinity, NaN];
  for (let index = 0; index < 100_000; index++) {
    const kind = index % 4;
    values.push(kind === 0 ? (random() - 0.5) * 10 ** Math.floor(random() * 40 - 20)
      : kind === 1 ? Math.floor(random() * 1e15) : kind === 2 ? Math.round((random() - 0.5) * 1e6) / 100
        : (random() - 0.5) * 2 ** (random() * 2000 - 1000));
  }
  // Pushed as numbers from JS, written by Lua's own tostring.
  lua.lua_getglobal(L, to_luastring("tostring"));
  const tostring = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
  const mismatches = [];
  for (const value of values) {
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, tostring);
    lua.lua_pushnumber(L, value);
    lua.lua_call(L, 1, 1);
    const text = lua.lua_tojsstring(L, -1);
    lua.lua_settop(L, 0);
    if (text !== lua51NumberText(value) && mismatches.length < 5) mismatches.push([value, text, lua51NumberText(value)]);
  }
  assert.deepEqual(mismatches, []);
  lua.lua_close(L);
});

test("bit is LuaBitOp's (floor, modulo 2^32, signed results) and number → int rounds like fistp", () => {
  const L = state();
  assert.deepEqual(run(L, "return bit.band(0x80000000, 0xFFFFFFFF), bit.bor(2147483648 + 5, 1), bit.arshift(0x80000000, 31), bit.rshift(-1, 28), bit.tohex(-1), bit.tobit(2^40 + 3), bit.lshift(1, 31)"),
    [-2147483648, -2147483643, -1, 15, "ffffffff", 3, -2147483648]);
  // lua_tointeger (luaL_checkint) is Wow.exe's fld/fistp: ties to even, so 3.5 → 4 and 2.5 → 2.
  assert.deepEqual(run(L, "return #string.rep('x', 3.5), #string.rep('x', 2.5), #string.rep('x', 2.6)"), [4, 2, 3]);
  lua.lua_close(L);
});

test("the function registry does not grow with calls; pointer tokens are interned and can be released", () => {
  const L = state();
  const handler = () => 0;
  const before = luaWasmFootprint().functions;
  for (let index = 0; index < 1000; index++) {
    lua.lua_pushjsfunction(L, handler);
    lua.lua_settop(L, 0);
  }
  assert.equal(luaWasmFootprint().functions - before, 1, "one registration for one function, however often it is pushed");
  run(L, "frame = {}");
  lua.lua_getglobal(L, to_luastring("frame"));
  const first = lua.lua_topointer(L, -1);
  const again = lua.lua_topointer(L, -1);
  assert.equal(first, again, "the same table, the same token");
  releaseLuaPointer(first);
  const fresh = lua.lua_topointer(L, -1);
  assert.notEqual(fresh, first, "a released token is not handed out again for the address");
  lua.lua_close(L);
});

test("5.1's setfenv/getfenv/newproxy are kept aside by openlibs and come back on request", () => {
  const L = state();
  assert.deepEqual(run(L, "return setfenv, getfenv, newproxy"), [undefined, undefined, undefined]);
  luaWasmRestoreEnvironment(L);
  assert.deepEqual(run(L, "local f = function() return x end setfenv(f, { x = 5 }) return f(), type(newproxy(true))"), [5, "userdata"]);
  lua.lua_close(L);
});

test("a runaway recursion is a Lua error and the state keeps working", () => {
  const L = state();
  assert.throws(() => run(L, "local function f() return 1 + f() end return f()"), /stack overflow/);
  assert.deepEqual(run(L, "return 1 + 1"), [2]);
  lua.lua_close(L);
});
