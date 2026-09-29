import assert from "node:assert/strict";
import test from "node:test";

// `issecure()` for Blizzard's own entry points (FrameXmlSecureCalls.ts), over a bare Lua VM: the
// glue shims answer `issecure()` false (GlueLua.ts); once wrappers are installed a wrapped function
// runs with the client's 1 on its own coroutine's stack and nil everywhere else — after an error,
// inside another wrapped function, and while a coroutine that entered one is suspended.
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { installFrameXmlSecureWrappers, FRAMEXML_SECURE_ENTRY_POINTS } =
  await import("../dist/code/browser/framexml/FrameXmlSecureCalls.js");

const FIXTURE = `
function Probe() return issecure() end
function Raiser() __seenInside = issecure() error("boom") end
function Inner() return issecure() end
function Outer()
  local inner = Inner()
  return inner, issecure()
end
function Returns() return 1, nil, 3 end
function Yielder()
  local before = issecure()
  local resumedWith = coroutine.yield(before)
  return resumedWith, issecure()
end
NotAFunction = 7
`;

function vm() {
  const lua = new GlueLuaVm();
  const ran = lua.execute(FIXTURE, "@secure-calls-fixture");
  assert.equal(ran.ok, true, ran.error);
  return lua;
}

function run(lua, code, results = 1) {
  const fn = lua.compileFunction(code, "secure-calls-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return lua.call(fn, [], results); } finally { lua.release(fn); }
}

test("outside every wrapper the VM is not secure; inside a wrapped function issecure() is the client's 1", () => {
  const lua = vm();
  try {
    assert.deepEqual(run(lua, "return issecure()"), [false], "the glue shim's answer before any wrapper");
    assert.deepEqual(run(lua, "return Probe()"), [false], "an unwrapped function sees the same");
    const wrapped = installFrameXmlSecureWrappers(lua, ["Probe", "Raiser", "Inner", "Outer", "Returns"]);
    assert.deepEqual([...wrapped], ["Probe", "Raiser", "Inner", "Outer", "Returns"]);
    assert.deepEqual(run(lua, "return Probe()"), [1], "the wrapped entry runs as Blizzard's code");
    assert.deepEqual(run(lua, "return issecure() == nil"), [true], "and the answer outside is the client's nil");
  } finally {
    lua.close();
  }
});

test("an error inside a wrapped function leaves nothing secure and reaches the caller with its own traceback", () => {
  const lua = vm();
  try {
    installFrameXmlSecureWrappers(lua, ["Raiser"]);
    const [ok, message, inside, after] = run(lua,
      "local ok, message = pcall(Raiser) return ok, message, __seenInside, issecure() == nil", 4);
    assert.deepEqual([ok, inside, after], [false, 1, true]);
    assert.match(String(message), /^secure-calls-fixture:3: boom\n/, "the first line — the census' position — is unchanged");
    assert.match(String(message), /stack traceback:[\s\S]*secure-calls-fixture:3:/, "the frames inside the wrapped call are kept");
  } finally {
    lua.close();
  }
});

test("a wrapped call inside another leaves the outer one secure until it returns", () => {
  const lua = vm();
  try {
    installFrameXmlSecureWrappers(lua, ["Inner", "Outer"]);
    assert.deepEqual(run(lua, "local inner, after = Outer() return inner, after, issecure() == nil", 3), [1, 1, true]);
    // The same inside somebody else's secure window (FrameXmlOptionsOwner's transaction swaps the global).
    assert.deepEqual(run(lua, `
      local own = issecure
      issecure = function() return true end
      local inner = Inner()
      local still = issecure()
      issecure = own
      return inner, still, issecure() == nil`, 3), [true, true, true]);
  } finally {
    lua.close();
  }
});

test("a coroutine suspended inside a wrapped call does not leave its resumer secure", () => {
  const lua = vm();
  try {
    installFrameXmlSecureWrappers(lua, ["Yielder"]);
    assert.deepEqual(run(lua, `
      local co = coroutine.create(Yielder)
      local ok, before = coroutine.resume(co)
      local outside = issecure() == nil
      local ok2, resumedWith, after = coroutine.resume(co, "again")
      return ok, before, outside, ok2, resumedWith, after, issecure() == nil`, 7),
    [true, 1, true, true, "again", 1, true]);
  } finally {
    lua.close();
  }
});

test("every return value comes back, a nil in the middle included; absent names are left alone", () => {
  const lua = vm();
  try {
    const wrapped = installFrameXmlSecureWrappers(lua, ["Returns", "Missing", "NotAFunction", "bad name"]);
    assert.deepEqual([...wrapped], ["Returns"]);
    assert.deepEqual(run(lua, "return select('#', Returns()), Returns()", 4), [3, 1, undefined, 3]);
    assert.deepEqual(run(lua, "return rawget(_G, 'Missing') == nil, NotAFunction", 2), [true, 7]);
    // Installing again wraps nothing twice: the same function stays in place.
    run(lua, "__first = Returns", 0);
    assert.deepEqual([...installFrameXmlSecureWrappers(lua, ["Returns"])], []);
    assert.deepEqual(run(lua, "return __first == Returns"), [true]);
  } finally {
    lua.close();
  }
});

test("the stock entry points are the action bars' grid and the unit menus' entry", () => {
  assert.deepEqual([...FRAMEXML_SECURE_ENTRY_POINTS].sort(),
    ["ActionButton_HideGrid", "ActionButton_ShowGrid", "UnitPopup_ShowMenu"]);
});
