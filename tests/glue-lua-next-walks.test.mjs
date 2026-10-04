import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.27, review of L5 (04.10): the native `next` (GlueLuaNatives.ts) against Lua 5.1's
// traversal contract — every key present when a walk starts and not cleared before its turn comes
// exactly once, clearing any existing field during the walk allowed — with the walk interleaved
// with other walks of the same table (`if next(t) then`, a nested `for k in next, t`), and against
// the preamble's Lua `next` (the order oracle) on tables nothing changes.
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { lua: luaApi, to_luastring } = await import("fengari");

// L5b 3.27: `pairs({})` answers the native next now (5.1's pairs, GlueLuaBase51.ts), so the raw
// walk these tests take their key sets from is a host function over lua_next.
const RawGlueLuaVm = class extends GlueLuaVm {
  constructor() {
    super();
    luaApi.lua_pushjsfunction(this.state, (L) => {
      luaApi.lua_settop(L, 2);
      if (luaApi.lua_next(L, 1)) return 2;
      luaApi.lua_pushnil(L);
      return 1;
    });
    luaApi.lua_setglobal(this.state, to_luastring("RAWNEXT"));
  }
};

function run(vm, source) {
  const result = vm.execute(source, "@next-walks");
  assert.equal(result.ok, true, result.error);
}

/** `walk(build, body)`: the keys one `for k in next, t` hands out, "!dup"/"!missed …" appended. */
const WALK = String.raw`
local rawnext = RAWNEXT -- L5b 3.27 (was (pairs({})))
function constructorList() return { x = 1, y = 2, "a", "b", "c", "d", "e" } end
function appendedList() local t = { x = 1 } for i = 1, 5 do t[i] = i end t.y = 2 return t end
function walk(t, body)
  local present, seen, order, cleared, dup = {}, {}, {}, {}, false
  for k in rawnext, t do present[k] = true end
  for k in next, t do
    if seen[k] then dup = true end
    seen[k] = true
    order[#order + 1] = tostring(k)
    if body then body(t, k, cleared) end
    if #order > 100 then error("runaway walk") end
  end
  local missed = {}
  for k in rawnext, present do if not seen[k] and not cleared[k] then missed[#missed + 1] = tostring(k) end end
  table.sort(missed)
  return table.concat(order, " ") .. (dup and " !dup" or "") .. (#missed > 0 and (" !missed " .. table.concat(missed, ",")) or "")
end
`;

test("a wipe that asks next(t) whether the table is empty yet still clears every key", () => {
  const vm = new RawGlueLuaVm(); // L5b 3.27
  try {
    run(vm, WALK + String.raw`
      local function wipeAndCheck(t, k, cleared) t[k] = nil cleared[k] = true EMPTY = next(t) == nil end
      __ctor = walk(constructorList(), wipeAndCheck)
      __append = walk(appendedList(), wipeAndCheck)
      __empty = EMPTY
    `);
    // The constructor's raw order is x y 5 4 3 2 1: the old walk stopped after `1`.
    assert.equal(vm.getGlobal("__ctor"), "1 2 3 4 5 x y");
    assert.equal(vm.getGlobal("__append"), "1 2 3 4 5 x y");
    assert.equal(vm.getGlobal("__empty"), true);
  } finally {
    vm.close();
  }
});

test("a nested walk of the same table after a hole was cleared does not move the outer walk", () => {
  const vm = new RawGlueLuaVm(); // L5b 3.27
  try {
    run(vm, WALK + String.raw`
      -- In the hash part: t[2] cleared, then a whole nested walk.
      local function holeThenNested(t, k, cleared)
        if (k == "x" or k == "y") and t[2] ~= nil then t[2] = nil cleared[2] = true for _ in next, t do end end
      end
      -- In the array part, past the hole.
      local function holeAt4(t, k, cleared)
        if k == 4 then t[2] = nil cleared[2] = true for _ in next, t do end end
      end
      __a1, __a2 = walk(constructorList(), holeThenNested), walk(appendedList(), holeThenNested)
      __b1, __b2 = walk(constructorList(), holeAt4), walk(appendedList(), holeAt4)
    `);
    for (const name of ["__a1", "__a2", "__b1", "__b2"]) {
      assert.equal(vm.getGlobal(name), "1 2 3 4 5 x y", name);
    }
  } finally {
    vm.close();
  }
});

test("the walk's key may come back as a float: next(t, 1.0) after t[1] was cleared goes on to 2", () => {
  const vm = new RawGlueLuaVm(); // L5b 3.27
  try {
    run(vm, String.raw`
      local t = { x = 1, "a", "b", "c" }
      local k = next(t)
      t[k] = nil
      __after = next(t, k + 0.0)
      local ok, message = pcall(next, t, "no such key")
      __invalid = message
      -- Resumed at a key of a table no walk has seen, without t[1]: the raw order goes on from it.
      local resumed = {}
      resumed.x = 1 resumed[2] = 2 resumed[3] = 3
      __resumed = next(resumed, "x")
    `);
    assert.equal(vm.getGlobal("__after"), 2);
    assert.match(String(vm.getGlobal("__invalid")), /invalid key to 'next'/);
    assert.equal(vm.getGlobal("__resumed"), 2);
  } finally {
    vm.close();
  }
});

test("a run the table has lost stays its array part: index order, and no scan of the empty slots", async () => {
  const { lua } = await import("fengari");
  const vm = new RawGlueLuaVm(); // L5b 3.27
  try {
    run(vm, String.raw`
      LOST = {}
      for i = 1, 3000 do LOST[i] = i end
      for k in next, LOST do end
      for i = 1, 3000 do LOST[i] = nil end
      LOST.a = 1 LOST[50] = 50 LOST.b = 2 LOST[3001] = 3001 LOST[3] = 3
      local order = {}
      for k in next, LOST do order[#order + 1] = tostring(k) end
      __order = table.concat(order, " ")
      -- L5b 3.27: pairs is 5.1's, over this next — the same walk (it measured its own run: the raw order).
      local raw = {}
      for k in pairs(LOST) do raw[#raw + 1] = tostring(k) end
      __pairs = table.concat(raw, " ")
    `);
    // As PUC's array part, which clearing never shrinks: 3 and 50 by index, then the rest.
    assert.equal(vm.getGlobal("__order"), "3 50 a b 3001");
    assert.equal(vm.getGlobal("__pairs"), "3 50 a b 3001"); // L5b 3.27 (was "a 50 b 3001 3")
    const rawgeti = lua.lua_rawgeti;
    let reads = 0;
    lua.lua_rawgeti = (...args) => { reads += 1; return rawgeti(...args); };
    try {
      run(vm, "__first = next(LOST) for _ in next, LOST do end");
    } finally {
      lua.lua_rawgeti = rawgeti;
    }
    assert.equal(vm.getGlobal("__first"), 3);
    assert.ok(reads < 100, `index reads for a check and a walk of five keys: ${reads}`);
    // The raw walk is the longer one: the index scan stops at the run's end, not at a key past it.
    run(vm, String.raw`
      local t = {}
      for i = 1, 20 do t[i] = i end
      for k in next, t do end
      for i = 1, 20 do t[i] = nil end
      for i = 1, 60 do t["h" .. i] = i end
      t[21] = 21
      local seen, count, dup = {}, 0, false
      for k in next, t do if seen[k] then dup = true end seen[k] = true count = count + 1 end
      __count, __dup = count, dup
    `);
    assert.equal(vm.getGlobal("__count"), 61);
    assert.equal(vm.getGlobal("__dup"), false);
  } finally {
    vm.close();
  }
});

test("random tables: the oracle's order when nothing changes, and 5.1's contract while fields are cleared", () => {
  const vm = new RawGlueLuaVm(); // L5b 3.27
  try {
    run(vm, String.raw`
      local rawnext = RAWNEXT -- L5b 3.27 (was (pairs({})))
      -- The preamble's Lua next (GlueLua.ts), rebuilt over the raw next: the order oracle.
      local function isArrayKey(key, n) return type(key) == "number" and key >= 1 and key <= n and key % 1 == 0 end
      local function arrayLength(t) local n = 0 while rawget(t, n + 1) ~= nil do n = n + 1 end return n end
      local function afterArray(t, n, from)
        local key = rawnext(t, from)
        while key ~= nil and isArrayKey(key, n) do key = rawnext(t, key) end
        return key
      end
      local function oracle(t, key)
        local n = arrayLength(t)
        if key == nil then
          if n > 0 then return 1 end
          return afterArray(t, n, nil)
        end
        if isArrayKey(key, n) then
          if key < n then return key + 1 end
          return afterArray(t, n, nil)
        end
        return afterArray(t, n, key)
      end
      local seed = 20261004
      local function rnd(n) seed = (seed * 1103515245 + 12345) % 2147483648 return math.floor(seed % n) end
      local shared = {}
      local function makeTable()
        local keys, n = {}, rnd(12)
        for i = rnd(4) == 0 and 2 or 1, n do keys[#keys + 1] = i end
        for _ = 1, rnd(4) do keys[#keys + 1] = n + 2 + rnd(10) end
        for _ = 1, rnd(3) do keys[#keys + 1] = -rnd(5) end
        for _ = 1, rnd(5) do keys[#keys + 1] = "k" .. rnd(20) end
        if rnd(3) == 0 then keys[#keys + 1] = 0 end
        if rnd(4) == 0 then keys[#keys + 1] = true end
        if rnd(4) == 0 then keys[#keys + 1] = 1.5 end
        if rnd(4) == 0 then keys[#keys + 1] = shared end
        local order = rnd(3)
        if order == 0 then
          for i = #keys, 2, -1 do local j = rnd(i) + 1 keys[i], keys[j] = keys[j], keys[i] end
        elseif order == 1 then
          for i = 1, math.floor(#keys / 2) do keys[i], keys[#keys + 1 - i] = keys[#keys + 1 - i], keys[i] end
        end
        local t = {}
        for i, k in ipairs(keys) do t[k] = i end
        return t
      end
      local function name(k) return type(k) == "table" and "<t>" or (type(k) .. ":" .. tostring(k)) end
      local function sequence(iter, t, body)
        local out = {}
        local k = iter(t, nil)
        while k ~= nil do
          out[#out + 1] = name(k)
          if body then body(t, k) end
          if #out > 1000 then error("runaway walk") end
          k = iter(t, k)
        end
        return table.concat(out, " ")
      end
      local failures = {}
      local function fail(text) if #failures < 5 then failures[#failures + 1] = text end end
      for trial = 1, 150 do
        local t = makeTable()
        local expected = sequence(oracle, t)
        if sequence(next, t) ~= expected then fail("order " .. trial) end
        if sequence(next, t, function(tt) local _ = next(tt) end) ~= expected then fail("order+check " .. trial) end
        if sequence(next, t, function(tt) for _ in next, tt do end end) ~= expected then fail("order+nested " .. trial) end
        -- A walk resumed at any key of a table no walk has seen: the oracle's next key.
        for k in rawnext, t do
          local copy = {}
          for kk, v in rawnext, t do copy[kk] = v end
          if next(copy, k) ~= oracle(copy, k) then fail("resumed " .. trial .. " " .. name(k)) break end
        end
      end
      -- Clearing: the current key, another existing key, a value changed; next(t) and nested walks
      -- in between; and tables walked and changed before (the run a walk remembers).
      for trial = 1, 300 do
        local t = makeTable()
        if trial % 2 == 0 then
          for _ = 1, 1 + rnd(3) do
            for _ in next, t do if rnd(5) == 0 then break end end
            for _ = 1, rnd(6) do
              local keys = {}
              for kk in rawnext, t do keys[#keys + 1] = kk end
              if #keys > 0 and rnd(2) == 0 then t[keys[rnd(#keys) + 1]] = nil end
              if rnd(2) == 0 then t[rnd(16) + 1] = "h" else t["h" .. rnd(9)] = "h" end
            end
          end
        end
        local present, seen, cleared, dup = {}, {}, {}, false
        for k in rawnext, t do present[k] = true end
        local ok, err = pcall(sequence, next, t, function(tt, k)
          if seen[k] then dup = true end
          seen[k] = true
          if rnd(2) == 0 then tt[k] = nil cleared[k] = true end
          if rnd(3) == 0 then
            local keys = {}
            for kk in rawnext, tt do keys[#keys + 1] = kk end
            if #keys > 0 then local kk = keys[rnd(#keys) + 1] tt[kk] = nil cleared[kk] = true end
          end
          if rnd(3) == 0 then local kk = rawnext(tt) if kk ~= nil then tt[kk] = "changed" end end
          local mode = rnd(4)
          if mode == 0 then local _ = next(tt) elseif mode == 1 then for _ in next, tt do end end
        end)
        if not ok then fail("error " .. trial .. ": " .. tostring(err)) end
        if dup then fail("dup " .. trial) end
        for k in rawnext, present do
          if not seen[k] and not cleared[k] then fail("missed " .. trial .. " " .. name(k)) break end
        end
      end
      __failures = table.concat(failures, "; ")
    `);
    assert.equal(vm.getGlobal("__failures"), "");
  } finally {
    vm.close();
  }
});
