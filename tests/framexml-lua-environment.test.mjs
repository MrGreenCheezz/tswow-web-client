import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.27 (03.10, L5): Lua 5.1's newproxy, setfenv and getfenv in the FrameXML state, which
// the stock secure layer runs on — RestrictedFrames.lua's frame handles are `newproxy(prototype)`
// userdata checked with `type(handle) == "userdata"`, and RestrictedExecution.lua builds every
// secure snippet with `setfenv(def, {})` / `setfenv(def, env)` (:96, :103).
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

async function boot(source) {
  const instance = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "A.lua",
      "interface/framexml/a.lua": `CreateFrame("Frame", "EnvProbe", UIParent)\n${source}`,
    }),
    exercise: false,
  });
  await instance.load();
  return instance;
}

function global(instance, name) {
  return instance.vm.getGlobal(name);
}

test("newproxy makes userdata whose metatable a proxy can share, as 5.1's base library does", async () => {
  const instance = await boot(`
    local p = newproxy(true)
    TYPE = type(p)
    getmetatable(p).__index = { hello = "world" }
    local q = newproxy(p)
    SHARED = getmetatable(q) == getmetatable(p)
    HELLO = q.hello
    BARE = getmetatable(newproxy()) == nil and getmetatable(newproxy(false)) == nil and type(newproxy()) == "userdata"
    BAD = select(2, pcall(newproxy, {}))
    -- Only a metatable newproxy(true) made marks a proxy (lbaselib's weak table).
    FOREIGN = select(2, pcall(newproxy, setmetatable({}, {})))
    -- RestrictedFrames.lua:67-73, 103: the prototype's metatable hides itself and is still shared.
    local proto = newproxy(true)
    local meta = getmetatable(proto)
    meta.__index = { kind = "handle" }
    meta.__metatable = false
    local handle = newproxy(proto)
    HIDDEN = getmetatable(handle) == false
    KIND = handle.kind
    local set = {}
    set[q] = 1
    KEYED = set[q] == 1 and set[p] == nil and q ~= p
    EnvProbe:SetAttribute("frameref-x", handle)
    ATTRIBUTE = EnvProbe:GetAttribute("frameref-x") == handle
  `);
  try {
    assert.equal(global(instance, "TYPE"), "userdata");
    assert.equal(global(instance, "SHARED"), true);
    assert.equal(global(instance, "HELLO"), "world");
    assert.equal(global(instance, "BARE"), true);
    assert.match(String(global(instance, "BAD")), /bad argument #1 to 'newproxy' \(boolean or proxy expected\)/);
    assert.match(String(global(instance, "FOREIGN")), /boolean or proxy expected/);
    assert.equal(global(instance, "HIDDEN"), true);
    assert.equal(global(instance, "KIND"), "handle");
    assert.equal(global(instance, "KEYED"), true);
    assert.equal(global(instance, "ATTRIBUTE"), true, "a handle kept as an attribute comes back");
  } finally {
    instance.close();
  }
});

test("setfenv and getfenv give one function its own globals, as RestrictedExecution's closures need", async () => {
  const instance = await boot(`
    x, y = 1, 2
    local function f() return x end
    local env = { x = 42 }
    RETURNS_F = setfenv(f, env) == f
    FX = f()
    ENV_OF_F = getfenv(f) == env
    G0 = getfenv(0) == _G and getfenv() == _G
    OTHERS = (function() return x end)() == 1

    -- BuildRestrictedClosure (RestrictedExecution.lua:87-106), verbatim in shape.
    local def = loadstring("return function (self, a) return a + y end", "body")
    setfenv(def, {})
    def = def()
    setfenv(def, { y = 5 })
    BUILT = def(nil, 1)
    STILL_Y = y

    -- A stack level: 1 is the function calling setfenv.
    local function g() setfenv(1, { z = 7, tostring = tostring }) return tostring(z) end
    LEVEL1 = g()
    C_FUNCTION = select(2, pcall(setfenv, print, {}))
    NOT_TABLE = select(2, pcall(setfenv, f, 1))
  `);
  try {
    assert.equal(global(instance, "RETURNS_F"), true);
    assert.equal(global(instance, "FX"), 42);
    assert.equal(global(instance, "ENV_OF_F"), true);
    assert.equal(global(instance, "G0"), true);
    assert.equal(global(instance, "OTHERS"), true, "only the one function sees the new environment");
    assert.equal(global(instance, "BUILT"), 6);
    assert.equal(global(instance, "STILL_Y"), 2);
    assert.equal(global(instance, "LEVEL1"), "7");
    assert.match(String(global(instance, "C_FUNCTION")), /'setfenv' cannot change environment of given object/);
    assert.match(String(global(instance, "NOT_TABLE")), /bad argument #2 to 'setfenv' \(table expected/);
  } finally {
    instance.close();
  }
});
