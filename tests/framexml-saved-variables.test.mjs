import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { SAVED_VARIABLE_LIMITS } from "../dist/code/browser/framexml/FrameXmlSavedVariables.js";

function storage() {
  const data = new Map();
  return {
    data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
const scope = { account: "account-a", realm: "realm-a", character: "guid-a" };
async function boot(store, identity = scope, module = "Example", extra = "") {
  const path = `interface/addons/${module.toLowerCase()}`;
  const host = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/globalstrings.lua": "",
      [`${path}/${module.toLowerCase()}.toc`]: "## SavedVariables: Shared\n## SavedVariablesPerCharacter: Personal\nMain.lua",
      [`${path}/main.lua`]: `
        Shared = { visits = 0 }; Personal = { visits = 0 }; Legacy = 0
        RegisterForSave("Legacy")
        local frame = CreateFrame("Frame")
        frame:RegisterEvent("ADDON_LOADED")
        frame:SetScript("OnEvent", function(self, event, name)
          if name ~= "${module}" then return end
          SeenShared = Shared.visits; SeenPersonal = Personal and Personal.visits; SeenLegacy = Legacy
          Shared.visits = Shared.visits + 1; if Personal then Personal.visits = Personal.visits + 1 end; Legacy = Legacy + 1
        end)
        ${extra}
      `,
    }), subset: ["GlobalStrings.lua"], exercise: false,
    savedVariables: { storage: store, scope: identity },
  });
  await host.load();
  const result = await host.loadAddon(module);
  assert.equal(result.ok, true, result.message);
  return host;
}

test("SavedVariables and RegisterForSave survive close and restore before ADDON_LOADED", async () => {
  const store = storage();
  const first = await boot(store);
  first.close();
  const second = await boot(store);
  try {
    assert.equal(second.vm.getGlobal("SeenShared"), 1);
    assert.equal(second.vm.getGlobal("SeenPersonal"), 1);
    assert.equal(second.vm.getGlobal("SeenLegacy"), 1);
  } finally { second.close(); }
});

test("SavedVariables isolate account, realm, module and per-character data", async () => {
  const store = storage();
  (await boot(store)).close();
  const alternate = await boot(store, { ...scope, character: "guid-b" });
  assert.equal(alternate.vm.getGlobal("SeenShared"), 1);
  assert.equal(alternate.vm.getGlobal("SeenPersonal"), 0);
  alternate.close();
  for (const [identity, module] of [
    [{ ...scope, account: "account-b" }, "Example"],
    [{ ...scope, realm: "realm-b" }, "Example"],
    [scope, "Another"],
  ]) {
    const isolated = await boot(store, identity, module);
    assert.equal(isolated.vm.getGlobal("SeenShared"), 0);
    assert.equal(isolated.vm.getGlobal("SeenPersonal"), 0);
    assert.equal(isolated.vm.getGlobal("SeenLegacy"), 0);
    isolated.close();
  }
});

test("unsafe Lua values preserve the previous checkpoint and report the variable", async () => {
  const store = storage();
  (await boot(store)).close();
  const second = await boot(store);
  second.vm.execute("Shared.loop = Shared; Personal.bad = function() end", "@test");
  second.flushSavedVariables();
  assert.ok(second.savedVariableDiagnostics.some((entry) => entry.variable === "Shared"));
  assert.ok(second.savedVariableDiagnostics.some((entry) => entry.variable === "Personal"));
  second.close();
  const third = await boot(store);
  assert.equal(third.vm.getGlobal("SeenShared"), 1);
  assert.equal(third.vm.getGlobal("SeenPersonal"), 1);
  third.close();
});

test("saved tables preserve sparse numeric keys, string keys, booleans and nil without evaluating text", async () => {
  const store = storage();
  const first = await boot(store);
  first.vm.execute(`Shared = { visits = 8, [4] = "four", ["4"] = false, nested = { text = "return os.execute('oops')" } }; Personal = nil`, "@test");
  first.close();
  const second = await boot(store, scope, "Example", "");
  assert.equal(second.vm.getGlobal("SeenShared"), 8);
  assert.equal(second.vm.execute(`assert(Shared[4] == "four" and Shared["4"] == false and Shared.nested.text == "return os.execute('oops')")`, "@test").ok, true);
  assert.equal(second.vm.getGlobal("Personal"), undefined);
  second.close();
});

test("widget no-op diagnostics count repeated calls by module, widget type and method", async () => {
  const host = await boot(storage(), scope, "Example", `
    local label = frame:CreateFontString()
    label:SetSpacing(3); label:SetSpacing(4)
    assert(label:GetSpacing() == 4) -- real FontString method, not a diagnostic stub
    label:SetShadowOffset(1, 2); label:SetShadowOffset(3, 4)
    local sx, sy = label:GetShadowOffset()
    assert(sx == 3 and sy == 4) -- real FontString method now, not a diagnostic stub
    label:GetFieldSize(); label:GetFieldSize()
    frame:SetHitRectInsets(1, 2, 3, 4)
    local l, r, t, b = frame:GetHitRectInsets()
    assert(l == 1 and r == 2 and t == 3 and b == 4) -- real Frame method now, not a diagnostic stub
    frame:SetClampRectInsets(1, 2, 3, 4)
    local cl, cr, ct, cb = frame:GetClampRectInsets()
    assert(cl == 1 and cr == 2 and ct == 3 and cb == 4) -- real Frame method now, not a diagnostic stub
    frame:SetBorderScalar(1)
  `);
  try {
    assert.deepEqual(host.binder.stubDiagnostics.filter((item) => item.module === "example"), [
      { module: "example", widgetType: "FontString", method: "GetFieldSize", calls: 2 },
      { module: "example", widgetType: "Frame", method: "SetBorderScalar", calls: 1 },
    ]);
  } finally { host.close(); }
});

test("XML load handlers attribute legacy saved globals and widget stubs to their add-on", async () => {
  const store = storage();
  async function create() {
    const host = new FrameXmlBoot({
      provider: createFixtureProvider({
        "interface/framexml/globalstrings.lua": "",
        "interface/addons/xml-addon/xml-addon.toc": "Main.xml",
        "interface/addons/xml-addon/main.xml": `<Ui><Frame name="XmlSaved"><Scripts><OnLoad>
          XmlLegacy = XmlLegacy or 0; RegisterForSave("XmlLegacy")
          self:SetBorderScalar(0); self:UnknownXmlMethod()
          self:RegisterEvent("ADDON_LOADED")
        </OnLoad><OnEvent>
          XmlSeen = XmlLegacy; XmlLegacy = XmlLegacy + 1
          self:SetBorderScalar(0)
        </OnEvent></Scripts></Frame></Ui>`,
      }), subset: ["GlobalStrings.lua"], exercise: false, savedVariables: { storage: store, scope },
    });
    await host.load();
    assert.equal((await host.loadAddon("xml-addon")).ok, true);
    return host;
  }
  (await create()).close();
  const second = await create();
  assert.equal(second.vm.getGlobal("XmlSeen"), 1);
  assert.ok([...store.data.keys()].some((key) => key.includes('"xml-addon","XmlLegacy"')));
  assert.deepEqual(second.binder.stubDiagnostics.filter((item) => item.module === "xml-addon"), [
    { module: "xml-addon", widgetType: "Frame", method: "SetBorderScalar", calls: 2 },
    { module: "xml-addon", widgetType: "Frame", method: "UnknownXmlMethod", calls: 1 },
  ]);
  second.close();
});

test("TSWoW TOC declarations restore before module load and session events", async () => {
  const store = storage();
  async function create() {
    const host = new FrameXmlBoot({
      provider: createFixtureProvider({
        "interface/framexml/framexml.toc": [
          "## tsaddon-begin: saved-example", "## SavedVariables: ModuleState", "TSAddons/saved-example/addon.lua", "## tsaddon-end: saved-example",
        ].join("\n"),
        "interface/framexml/tsaddons/saved-example/addon.lua": `
          ModuleState = 0
          local frame = CreateFrame("Frame")
          frame:RegisterEvent("ADDON_LOADED"); frame:RegisterEvent("VARIABLES_LOADED")
          frame:SetScript("OnEvent", function(self, event, name)
            if event == "ADDON_LOADED" and name == "saved-example" then SeenModule = ModuleState end
            if event == "VARIABLES_LOADED" then SeenSession = ModuleState; ModuleState = ModuleState + 1 end
          end)
        `,
      }), savedVariables: { storage: store, scope },
      exerciseEvents: ["VARIABLES_LOADED"],
    });
    await host.load();
    return host;
  }
  (await create()).close();
  const second = await create();
  assert.equal(second.vm.getGlobal("SeenModule"), 1);
  assert.equal(second.vm.getGlobal("SeenSession"), 1);
  second.close();
});

test("pagehide, hidden and periodic checkpoints save while mounted and stop on close", async () => {
  const store = storage();
  const host = await boot(store);
  const target = new EventTarget();
  const document = new EventTarget();
  let periodic;
  target.setInterval = (callback) => { periodic = callback; return 123; };
  target.clearInterval = (id) => { assert.equal(id, 123); periodic = undefined; };
  host.startSavedVariablesPersistence(target, document);
  target.dispatchEvent(new Event("pagehide"));
  assert.ok([...store.data.values()].some((value) => value.includes('"value":1')));
  host.vm.execute("Legacy = 2", "@test");
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.ok([...store.data.values()].some((value) => value.includes('"value":2')));
  host.vm.execute("Legacy = 3", "@test");
  periodic();
  assert.ok([...store.data.values()].some((value) => value.includes('"value":3')));
  host.close();
  assert.equal(periodic, undefined);
  assert.doesNotThrow(() => target.dispatchEvent(new Event("pagehide")));
});

test("malformed storage and storage failures preserve Lua defaults with actionable diagnostics", async () => {
  const store = storage();
  (await boot(store)).close();
  for (const key of store.data.keys()) store.data.set(key, 'return require("evil")');
  const corrupt = await boot(store);
  assert.equal(corrupt.vm.getGlobal("SeenShared"), 0);
  assert.ok(corrupt.savedVariableDiagnostics.some((item) => item.operation === "restore" && item.module === "example"));
  corrupt.close();
  const quota = await boot({ getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } });
  quota.flushSavedVariables();
  assert.ok(quota.savedVariableDiagnostics.some((item) => item.operation === "save" && /quota exceeded/.test(item.message)));
  quota.close();
});

test("deep tables fit the Lua stack and oversized, cyclic or executable values never replace checkpoints", async () => {
  const store = storage();
  const host = await boot(store);
  host.vm.execute("Shared.deep = {}; local t = Shared.deep; for i = 1, 25 do t.child = {}; t = t.child end; t.value = 7", "@test");
  host.flushSavedVariables();
  assert.deepEqual(host.savedVariableDiagnostics, []);
  host.close();
  const second = await boot(store);
  assert.equal(second.vm.execute("local t = Shared.deep; for i = 1, 25 do t = t.child end; assert(t.value == 7)", "@test").ok, true);
  const before = [...store.data].find(([key]) => key.includes('"Shared"'))[1];
  for (const expression of ["0/0", "function() end", `string.rep('x', ${SAVED_VARIABLE_LIMITS.bytes + 1})`]) {
    second.vm.execute(`Shared = ${expression}`, "@test");
    second.flushSavedVariables();
    assert.equal([...store.data].find(([key]) => key.includes('"Shared"'))[1], before);
  }
  second.close();
});

test("account casing shares the same saved state", async () => {
  const store = storage();
  (await boot(store)).close();
  const second = await boot(store, { ...scope, account: "ACCOUNT-A" });
  assert.equal(second.vm.getGlobal("SeenShared"), 1);
  second.close();
});

test("failed startup modules cannot restore or overwrite a successful previous checkpoint", async () => {
  const store = storage();
  async function create(fail) {
    const host = new FrameXmlBoot({
      provider: createFixtureProvider({
        "interface/framexml/framexml.toc": "## tsaddon-begin: safe-addon\n## SavedVariables: Saved\nTSAddons/safe-addon/main.lua\n## tsaddon-end: safe-addon",
        "interface/framexml/tsaddons/safe-addon/main.lua": fail ? "Saved = 999; error('failed startup')" : "Saved = 45",
      }), exercise: false, savedVariables: { storage: store, scope },
    });
    await host.load();
    return host;
  }
  (await create(false)).close();
  const previous = [...store.data];
  const failed = await create(true);
  assert.equal(failed.tsAddonResults[0].ok, false);
  assert.equal(failed.vm.getGlobal("Saved"), 999, "failed module never receives saved state");
  failed.close();
  assert.deepEqual([...store.data], previous);
});

// ------------------------------------------------------------------------------------------ 9.06

/** The pre-9.06 key, built by the old formula: the realm part carried the gateway origin. */
const v1Key = (legacyRealm, character, module, name) =>
  JSON.stringify(["webclient-addon-v1", "ACCOUNT-A", legacyRealm, character, module, name]);
const v2Key = (realm, character, module, name) =>
  JSON.stringify(["webclient-addon-v2", "ACCOUNT-A", realm, character, module, name]);
const value = (visits) => JSON.stringify({ version: 1, value: { entries: [["visits", visits]] } });

test("the v2 key has no gateway address; a v1 entry under the old address migrates once and is removed", async () => {
  const store = storage();
  const oldRealm = JSON.stringify(["http://127.0.0.1:8090", "realm-a"]);
  store.data.set(v1Key(oldRealm, null, "example", "Shared"), value(4));
  store.data.set(v1Key(oldRealm, "guid-a", "example", "Personal"), value(9));
  const first = await boot(store, { ...scope, legacyRealm: oldRealm });
  assert.equal(first.vm.getGlobal("SeenShared"), 4, "restored from the v1 key");
  assert.equal(first.vm.getGlobal("SeenPersonal"), 9);
  first.flushSavedVariables();
  assert.ok(store.data.has(v2Key("realm-a", null, "example", "Shared")));
  assert.ok(store.data.has(v2Key("realm-a", "guid-a", "example", "Personal")));
  assert.equal(store.data.has(v1Key(oldRealm, null, "example", "Shared")), false, "v1 removed after the v2 write");
  assert.equal(store.data.has(v1Key(oldRealm, "guid-a", "example", "Personal")), false);
  first.close();
  // Reached through another address (localhost instead of 127.0.0.1): the v2 copy wins.
  const otherRealm = JSON.stringify(["http://localhost:8090", "realm-a"]);
  store.data.set(v1Key(otherRealm, null, "example", "Shared"), value(100));
  const second = await boot(store, { ...scope, legacyRealm: otherRealm });
  assert.equal(second.vm.getGlobal("SeenShared"), 5);
  second.flushSavedVariables();
  assert.equal(store.data.has(v1Key(otherRealm, null, "example", "Shared")), false, "a stale v1 copy goes too");
  second.close();
  assert.ok([...store.data.keys()].every((key) => !key.includes("8090")), "no gateway address in any key");
});

test("a table with a metatable saves its raw contents: no __index defaults, no phantom subtables, no diagnostic", async () => {
  const store = storage();
  const host = await boot(store, scope, "Example", `
    Shared = setmetatable({ visits = 0 }, { __index = function() return 1 end })
    Shared.profile = setmetatable({ kept = true }, { __index = function(t, k) local sub = {} rawset(t, k, sub) return sub end })
    local touched = Shared.missing -- __index answers 1, nothing stored
  `);
  try {
    host.flushSavedVariables();
    assert.deepEqual(host.savedVariableDiagnostics, []);
    const saved = JSON.parse(store.data.get(v2Key("realm-a", null, "example", "Shared")));
    const entries = Object.fromEntries(saved.value.entries.map(([key, item]) => [key, item]));
    assert.equal(entries.visits, 1);
    assert.equal("missing" in entries, false);
    assert.deepEqual(entries.profile, { entries: [["kept", true]] }, "the raw walk never calls the creating __index");
  } finally { host.close(); }
});

/** An add-on that strips AceDB-style defaults in its PLAYER_LOGOUT handler and counts the runs. */
const LOGOUT_ADDON = `
  LogoutRuns = 0
  Shared.profile = setmetatable({ default = "d" }, { __index = function() return "d" end })
  local logout = CreateFrame("Frame")
  logout:RegisterEvent("PLAYER_LOGOUT")
  logout:SetScript("OnEvent", function()
    LogoutRuns = LogoutRuns + 1
    if __logoutTap then __logoutTap() end
    setmetatable(Shared.profile, nil)
    Shared.profile.default = nil
  end)
`;

function persistence(host) {
  const target = new EventTarget();
  const document = new EventTarget();
  const timer = {};
  target.setInterval = (callback) => { timer.periodic = callback; return 7; };
  target.clearInterval = () => { timer.periodic = undefined; };
  host.startSavedVariablesPersistence(target, document);
  return { target, document, timer };
}
const pagehide = (persisted) => Object.assign(new Event("pagehide"), { persisted });
const savedProfile = (store) => JSON.parse(store.data.get(v2Key("realm-a", null, "example", "Shared")))
  .value.entries.find(([key]) => key === "profile")?.[1];

test("closing the page (pagehide, not persisted) runs PLAYER_LOGOUT once, then saves what the handler left", async () => {
  const store = storage();
  const host = await boot(store, scope, "Example", LOGOUT_ADDON);
  const { target } = persistence(host);
  target.dispatchEvent(pagehide(false));
  assert.equal(host.vm.getGlobal("LogoutRuns"), 1);
  assert.deepEqual(savedProfile(store), { entries: [] }, "saved after the handler removed the default");
  let taps = 0;
  host.vm.registerGlobal("__logoutTap", () => { taps++; return []; });
  target.dispatchEvent(pagehide(false));
  assert.equal(host.vm.getGlobal("LogoutRuns"), 1, "the second pagehide does not log out again");
  host.close();
  assert.equal(taps, 0, "nor does close()");
});

test("the latch holds across a second pagehide and close; other checkpoints never send PLAYER_LOGOUT", async () => {
  const store = storage();
  const host = await boot(store, scope, "Example", LOGOUT_ADDON);
  const runs = () => host.vm.getGlobal("LogoutRuns");
  const { target, document, timer } = persistence(host);
  // Saving checkpoints that are not a logout: bfcache pagehide, beforeunload, hidden tab, the timer.
  target.dispatchEvent(pagehide(true));
  assert.equal(runs(), 0, "a page kept in the back/forward cache is not logging out");
  assert.deepEqual(savedProfile(store), { entries: [["default", "d"]] }, "but it saved");
  host.vm.execute("Shared.profile.extra = 1", "@test");
  target.dispatchEvent(new Event("beforeunload"));
  assert.equal(runs(), 0, "beforeunload can be cancelled: no logout");
  assert.ok(savedProfile(store).entries.some(([key]) => key === "extra"));
  host.vm.execute("Shared.profile.extra = 2", "@test");
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(runs(), 0);
  host.vm.execute("Shared.profile.extra = 3", "@test");
  timer.periodic();
  assert.equal(runs(), 0);
  assert.ok(savedProfile(store).entries.some(([key, item]) => key === "extra" && item === 3));
  target.dispatchEvent(pagehide(false));
  target.dispatchEvent(pagehide(false));
  assert.equal(runs(), 1);
  host.close();
});

test("limits: 12,000 nodes save, past the node limit is refused once with both numbers and the copy kept", async () => {
  const store = storage();
  const problems = [];
  const path = "interface/addons/example";
  const host = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/globalstrings.lua": "",
      [`${path}/example.toc`]: "## SavedVariables: Shared\nMain.lua",
      [`${path}/main.lua`]: "Shared = {}; for i = 1, 6000 do Shared[i] = i end",
    }), subset: ["GlobalStrings.lua"], exercise: false,
    savedVariables: { storage: store, scope, onProblem: (problem) => problems.push(problem) },
  });
  await host.load();
  assert.equal((await host.loadAddon("Example")).ok, true);
  try {
    host.flushSavedVariables();
    assert.deepEqual(host.savedVariableDiagnostics, [], "12,001 nodes (6,000 pairs) fit");
    const kept = store.data.get(v2Key("realm-a", null, "example", "Shared"));
    assert.ok(kept);
    host.vm.execute(`for i = 1, ${SAVED_VARIABLE_LIMITS.nodes} do Shared[i] = i end`, "@test");
    host.flushSavedVariables();
    host.flushSavedVariables();
    assert.equal(store.data.get(v2Key("realm-a", null, "example", "Shared")), kept, "the previous copy is intact");
    assert.equal(problems.length, 1, "reported once, not on every checkpoint");
    assert.equal(problems[0].variable, "Shared");
    assert.match(problems[0].message, new RegExp(`${SAVED_VARIABLE_LIMITS.nodes}`));
  } finally { host.close(); }
});

// 9.06 review, lens C: a full walk is ≈0.33 µs a node in fengari (20,000 nodes 6.7 ms, 49,000 nodes
// 16 ms, Node on a P-core) and cannot be sliced — Lua runs between frames and `lua_next` over a table
// changed mid-walk is undefined — so the 30 s checkpoint is budgeted per tick and a heavy variable is
// checkpointed rarely; pagehide, a hidden tab and close keep the full flush.
async function checkpointHost(costs) {
  const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
  const { FrameXmlSavedVariables } = await import("../dist/code/browser/framexml/FrameXmlSavedVariables.js");
  const clock = { now: 0 };
  const saves = [];
  const data = new Map();
  const store = {
    // The walk's cost is simulated where every save passes: the copy compared before writing.
    getItem: (key) => {
      const name = JSON.parse(key).at(-1);
      clock.now += costs[name] ?? 0;
      saves.push(name);
      return data.get(key) ?? null;
    },
    setItem: (key, value) => data.set(key, value),
  };
  const vm = new GlueLuaVm();
  const saved = new FrameXmlSavedVariables(vm, { scope, storage: store, now: () => clock.now });
  saved.registerToc(`## SavedVariables: ${Object.keys(costs).join(", ")}\n`);
  saved.finishModule("blizzard_framexml");
  saves.length = 0;
  return { vm, saved, clock, saves };
}

test("checkpoint: a heavy variable is saved every 5 min, light ones every tick; flush always saves all", async () => {
  const { SAVED_VARIABLE_CHECKPOINT } = await import("../dist/code/browser/framexml/FrameXmlSavedVariables.js");
  assert.deepEqual({ ...SAVED_VARIABLE_CHECKPOINT }, { budgetMs: 4, heavyMs: 4, heavyIntervalMs: 300_000 });
  const { vm, saved, clock, saves } = await checkpointHost({ Light: 0.5, Heavy: 16 });
  try {
    saved.checkpoint();
    assert.deepEqual(saves, ["Light", "Heavy"], "the first checkpoint measures both");
    for (let tick = 1; tick <= 9; tick += 1) {
      saves.length = 0;
      clock.now += 30_000;
      saved.checkpoint();
      assert.deepEqual(saves, ["Light"], `tick ${tick}: the 16 ms walk waits for its own interval`);
    }
    saves.length = 0;
    clock.now += 30_000;
    saved.checkpoint();
    assert.deepEqual(saves, ["Light", "Heavy"], "300 s after its last save the heavy one is due again");
    saves.length = 0;
    saved.flush();
    assert.deepEqual(saves, ["Light", "Heavy"], "pagehide/hidden/close: everything, whatever it costs");
  } finally { vm.close(); }
});

test("checkpoint: one tick stops at its budget and the next tick resumes after the last one saved", async () => {
  const { vm, saved, clock, saves } = await checkpointHost({ A: 3, B: 3, C: 3 });
  try {
    saved.checkpoint();
    assert.deepEqual(saves, ["A", "B"], "3 + 3 ms reaches the 4 ms budget");
    saves.length = 0;
    clock.now += 30_000;
    saved.checkpoint();
    assert.deepEqual(saves, ["C", "A"], "round robin: the one left out goes first");
    saves.length = 0;
    clock.now += 30_000;
    saved.checkpoint();
    assert.deepEqual(saves, ["B", "C"]);
  } finally { vm.close(); }
});

test("checkpoint: a variable over the node limit stops costing a full abort every 30 s", async () => {
  const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
  const { FrameXmlSavedVariables } = await import("../dist/code/browser/framexml/FrameXmlSavedVariables.js");
  // Real time here: the walk that aborts at the node limit is what is measured, offset by the ticks.
  let offset = 0;
  const saves = [];
  const problems = [];
  const store = { getItem: (key) => { saves.push(JSON.parse(key).at(-1)); return null; }, setItem() {} };
  const vm = new GlueLuaVm();
  const saved = new FrameXmlSavedVariables(vm, {
    scope, storage: store, now: () => performance.now() + offset, onProblem: (problem) => problems.push(problem),
  });
  saved.registerToc("## SavedVariables: Small, Huge\n");
  saved.finishModule("blizzard_framexml");
  saves.length = 0;
  try {
    assert.equal(vm.execute(`Small = 1; Huge = {}; for i = 1, ${SAVED_VARIABLE_LIMITS.nodes} do Huge[i] = i end`, "@t").ok, true);
    saved.checkpoint();
    assert.deepEqual(saves, ["Small"], "Huge never reaches storage: its walk aborts");
    assert.equal(problems.length, 1);
    for (let tick = 1; tick <= 3; tick += 1) {
      offset += 30_000;
      const before = performance.now();
      saved.checkpoint();
      assert.ok(performance.now() - before < 4, `tick ${tick}: no second abort inside the heavy interval`);
    }
    assert.deepEqual(saves, ["Small", "Small", "Small", "Small"]);
  } finally { vm.close(); }
});

test("the mounted 30 s timer checkpoints (heavy variables rarely); pagehide still saves everything", async () => {
  const clock = { now: 0 };
  const reads = [];
  const data = new Map();
  const store = {
    getItem: (key) => {
      const name = JSON.parse(key).at(-1);
      if (name === "Heavy") clock.now += 16;
      reads.push(name);
      return data.get(key) ?? null;
    },
    setItem: (key, value) => data.set(key, value),
  };
  const path = "interface/addons/example";
  const host = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/globalstrings.lua": "",
      [`${path}/example.toc`]: "## SavedVariables: Light, Heavy\nMain.lua",
      [`${path}/main.lua`]: "Light = 1; Heavy = 2",
    }), subset: ["GlobalStrings.lua"], exercise: false,
    savedVariables: { storage: store, scope, now: () => clock.now },
  });
  await host.load();
  assert.equal((await host.loadAddon("Example")).ok, true);
  const target = new EventTarget();
  const document = new EventTarget();
  let periodic;
  target.setInterval = (callback) => { periodic = callback; return 7; };
  target.clearInterval = () => { periodic = undefined; };
  try {
    host.startSavedVariablesPersistence(target, document);
    periodic();
    reads.length = 0;
    clock.now += 30_000;
    periodic();
    assert.deepEqual(reads, ["Light"], "the timer skips the 16 ms variable inside its interval");
    reads.length = 0;
    target.dispatchEvent(new Event("pagehide"));
    assert.deepEqual(reads, ["Light", "Heavy"], "closing the page saves all of them");
  } finally { host.close(); }
});

test("9.06 review: v1 data saved through another gateway address is found and migrated, not orphaned", async () => {
  const store = storage();
  // localStorage's enumeration, which the migration scans when the exact old key is absent.
  Object.defineProperty(store, "length", { get: () => store.data.size });
  store.key = (index) => [...store.data.keys()][index] ?? null;
  store.data.set("unrelated", "x");
  const savedVia = JSON.stringify(["http://localhost:8090", "realm-a"]);
  store.data.set(v1Key(savedVia, null, "example", "Shared"), value(6));
  store.data.set(v1Key(savedVia, "guid-a", "example", "Personal"), value(2));
  // Another realm and another character under that address are not this one's data (sorted first).
  store.data.set(v1Key(JSON.stringify(["http://localhost:8090", "realm-0"]), null, "example", "Shared"), value(50));
  store.data.set(v1Key(savedVia, "guid-0", "example", "Personal"), value(60));
  const usedNow = JSON.stringify(["http://127.0.0.1:8090", "realm-a"]);
  const host = await boot(store, { ...scope, legacyRealm: usedNow });
  try {
    assert.equal(host.vm.getGlobal("SeenShared"), 6, "the account-wide variable saved via localhost");
    assert.equal(host.vm.getGlobal("SeenPersonal"), 2, "the character's own");
    host.flushSavedVariables();
    assert.equal(store.data.has(v1Key(savedVia, null, "example", "Shared")), false, "migrated, then removed");
    assert.equal(store.data.has(v1Key(savedVia, "guid-a", "example", "Personal")), false);
    assert.ok(store.data.has(v1Key(JSON.stringify(["http://localhost:8090", "realm-0"]), null, "example", "Shared")));
    assert.ok(store.data.has(v1Key(savedVia, "guid-0", "example", "Personal")));
  } finally { host.close(); }
});
