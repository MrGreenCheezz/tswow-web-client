import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// The `bit` library FrameXmlBoot gives the stock UI (LuaBitOp, which 3.3.5 links into its Lua 5.1),
// run in fengari exactly as the boot runs it, against LuaBitOp's semantics: arguments floored and
// taken modulo 2^32, results signed 32-bit. fengari's integers are 32-bit, so an argument at or past
// 2^31 used to raise "number has no integer representation" and `arshift(x, 31)` came out with the
// wrong sign (found by the P2-12 prototype, 09.10).

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require("fengari");

function bitBlock() {
  const source = readFileSync(new URL("../src/browser/framexml/FrameXmlBoot.ts", import.meta.url), "utf8");
  const start = source.indexOf("-- LuaBitOp, which 3.3.5 links");
  const end = source.indexOf("-- The error census.", start);
  assert.ok(start > 0 && end > start, "the bit block is in FrameXmlBoot.ts");
  // Inside a TS template literal: undo its escapes.
  return source.slice(start, end).replaceAll("\\`", "`").replaceAll("\\\\", "\\");
}

const TWO32 = 2 ** 32;
function tobit(x) {
  if (!Number.isFinite(x)) return 0;
  let v = Math.floor(x) % TWO32;
  if (v < 0) v += TWO32;
  return v >= 2 ** 31 ? v - TWO32 : v;
}
const reference = {
  tobit: (a) => tobit(a),
  bnot: (a) => ~tobit(a),
  band: (...xs) => xs.map(tobit).reduce((a, b) => a & b),
  bor: (...xs) => xs.map(tobit).reduce((a, b) => a | b),
  bxor: (...xs) => xs.map(tobit).reduce((a, b) => a ^ b),
  lshift: (a, n) => tobit(a) << (tobit(n) & 31),
  rshift: (a, n) => (tobit(a) >>> (tobit(n) & 31)) | 0,
  arshift: (a, n) => tobit(a) >> (tobit(n) & 31),
  tohex: (a) => (tobit(a) >>> 0).toString(16).padStart(8, "0"),
};

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function value(next) {
  const roll = next();
  if (roll < 0.25) return Math.floor((next() - 0.5) * 2 ** 33); // around and past ±2^31
  if (roll < 0.4) return [0, -1, 1, 2 ** 31, 2 ** 31 - 1, -(2 ** 31), 2 ** 32 - 1, 2 ** 32, 3e9][Math.floor(next() * 9)];
  if (roll < 0.55) return (next() - 0.5) * 2 ** 34; // fractional
  if (roll < 0.65) return Math.floor((next() - 0.5) * 2 ** 53);
  return Math.floor((next() - 0.5) * 2 ** 16);
}

/** Lua source for a number, exact: integers as decimal digits, others as %.17g. */
function literal(x) {
  if (Number.isInteger(x) && Math.abs(x) < 2 ** 53) return x < 0 ? `(${x})` : String(x);
  return `(${x.toPrecision(17)})`;
}

test("bit in fengari equals LuaBitOp on 20 000 random calls, past 2^31 and with fractions", () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  assert.equal(lauxlib.luaL_dostring(L, to_luastring(bitBlock())), lua.LUA_OK, "the block runs");
  const next = random(20251009);
  const names = Object.keys(reference);
  const lines = [], expected = [];
  for (let index = 0; index < 20_000; index++) {
    const name = names[index % names.length];
    const arity = name === "tobit" || name === "bnot" || name === "tohex" ? 1
      : name.endsWith("shift") ? 2 : 2 + Math.floor(next() * 2);
    const args = Array.from({ length: arity }, (_, at) => (name.endsWith("shift") && at === 1 ? Math.floor(next() * 40) : value(next)));
    lines.push(`bit.${name}(${args.map(literal).join(", ")})`);
    expected.push(String(reference[name](...args)));
  }
  // Batched: one chunk returns a table of results as strings.
  const results = [];
  for (let at = 0; at < lines.length; at += 500) {
    const chunk = `local r = {}\n${lines.slice(at, at + 500).map((line, k) => `r[${k + 1}] = tostring(${line})`).join("\n")}\nreturn table.concat(r, "\\n")`;
    const rc = lauxlib.luaL_dostring(L, to_luastring(chunk));
    assert.equal(rc, lua.LUA_OK, rc === lua.LUA_OK ? "" : to_jsstring(lua.lua_tolstring(L, -1)));
    results.push(...to_jsstring(lua.lua_tolstring(L, -1)).split("\n"));
    lua.lua_settop(L, 0);
  }
  let mismatches = 0;
  const examples = [];
  results.forEach((got, index) => {
    if (got !== expected[index]) {
      mismatches++;
      if (examples.length < 5) examples.push(`${lines[index]} → ${got}, LuaBitOp ${expected[index]}`);
    }
  });
  assert.equal(mismatches, 0, examples.join("\n"));
});

test("the corpus' own uses: flag words at 2^31 and the sign of arshift", () => {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  lauxlib.luaL_dostring(L, to_luastring(bitBlock()));
  const run = (code) => {
    assert.equal(lauxlib.luaL_dostring(L, to_luastring(`return tostring(${code})`)), lua.LUA_OK, code);
    const out = to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_settop(L, 0);
    return out;
  };
  assert.equal(run("bit.band(0x80000000, 0xFFFFFFFF)"), "-2147483648", "COMBATLOG_OBJECT_NONE as a mask");
  assert.equal(run("bit.bor(2147483648 + 5, 1)"), "-2147483643", "a flag sum past 2^31 is not an error");
  assert.equal(run("bit.arshift(0x80000000, 31)"), "-1");
  assert.equal(run("bit.rshift(-1, 28)"), "15");
  assert.equal(run("bit.tohex(-1)"), "ffffffff");
  assert.equal(run("math.type(bit.band(7, 3))"), "integer", "results stay integers (string.format %d, table keys)");
});
