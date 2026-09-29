import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

function storage() {
  const data = new Map();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
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
  for (const expression of ["0/0", "function() end", "setmetatable({}, {})", "string.rep('x', 1048577)"]) {
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
