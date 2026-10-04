import assert from "node:assert/strict";
import test from "node:test";
import { lua } from "fengari";

// Plan item 3.27, review of L5 (04.10): script slots and hooks as Wow.exe 3.3.5a (12340) keeps them
// (notes .runtime/re-2026-10-03/l5-runtime/g1.c, g4.c). HookScript (0x0049edb0) on a slot with a
// function puts a closure (0x00817050: the old function, then the hook under pcall) in the slot, so
// GetScript (0x0049eb70) answers that closure and an add-on that wraps it — the stock
// Blizzard_CombatLog.lua:3337 and SecureHandlers.lua:264 do — keeps the hooks running; a hook made
// while the script runs is in the slot only from the next call on.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

async function boot() {
  const instance = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "A.lua",
      "interface/framexml/a.lua": `
        LOG = {}
        local function note(text) return function() LOG[#LOG + 1] = text end end
        NOTE = note
        CreateFrame("Frame", "HooksProbe", UIParent)
        CreateFrame("Frame", "HooksOther", UIParent)
      `,
    }),
    exercise: false,
  });
  await instance.load();
  return instance;
}

function lua51(instance, source) {
  const result = instance.vm.execute(source, "@hooks-probe");
  assert.equal(result.ok, true, result.error);
}

function log(instance) {
  const fn = instance.vm.compileFunction("local out = table.concat(LOG, ',') LOG = {} return out", "hooks-log", []);
  try {
    return instance.vm.call(fn, [], 1)[0];
  } finally {
    instance.vm.release(fn);
  }
}

test("wrapping GetScript's answer keeps the hooks, as wrapping the client's hook closure does", async () => {
  const instance = await boot();
  const frame = instance.bridge.getFrame("HooksProbe");
  try {
    const errors = instance.vm.errors.length;
    lua51(instance, `
      HooksProbe:SetScript("OnShow", NOTE("a"))
      HooksProbe:HookScript("OnShow", NOTE("h"))
      SAME = HooksProbe:GetScript("OnShow") == HooksProbe:GetScript("OnShow")
      local original = HooksProbe:GetScript("OnShow")
      HooksProbe:SetScript("OnShow", function(self, ...) original(self, ...) LOG[#LOG + 1] = "w" end)
    `);
    assert.equal(instance.vm.getGlobal("SAME"), true, "the same closure each time, as the slot's");
    instance.bridge.fireScript(frame, "OnShow");
    assert.equal(log(instance), "a,h,w");
    // SecureHandlers' restore: the saved answer set back runs the old function and the hook once each.
    lua51(instance, `
      HooksProbe:SetScript("OnHide", NOTE("b"))
      HooksProbe:HookScript("OnHide", NOTE("k"))
      local saved = HooksProbe:GetScript("OnHide")
      HooksProbe:SetScript("OnHide", NOTE("wrapped"))
      HooksProbe:SetScript("OnHide", saved)
    `);
    instance.bridge.fireScript(frame, "OnHide");
    assert.equal(log(instance), "b,k");
    // A hook added after GetScript answered: the next answer has it too.
    lua51(instance, `
      HooksProbe:SetScript("OnLeave", NOTE("c"))
      HooksProbe:HookScript("OnLeave", NOTE("1"))
      local first = HooksProbe:GetScript("OnLeave")
      HooksProbe:HookScript("OnLeave", NOTE("2"))
      HooksProbe:GetScript("OnLeave")(HooksProbe)
      first(HooksProbe)
    `);
    assert.equal(log(instance), "c,1,2,c,1");
    // An add-on's function reading the legacy globals still finds them when the closure is the handler.
    const addon = instance.vm.execute(`
      HooksProbe:SetScript("OnMouseDown", function() LOG[#LOG + 1] = "this=" .. tostring(this and this:GetName()) .. " arg1=" .. tostring(arg1) end)
    `, "@interface/addons/hooksprobe/hooksprobe.lua");
    assert.equal(addon.ok, true, addon.error);
    lua51(instance, `
      HooksProbe:HookScript("OnMouseDown", NOTE("hooked"))
      HooksProbe:SetScript("OnMouseDown", HooksProbe:GetScript("OnMouseDown"))
    `);
    instance.bridge.fireScript(frame, "OnMouseDown", "LeftButton");
    assert.equal(log(instance), "this=HooksProbe arg1=LeftButton,hooked");
    // A hook's error goes to the error handler and the rest still run; the old function's answer is the closure's.
    lua51(instance, `
      HooksProbe:SetScript("OnEnter", function() LOG[#LOG + 1] = "e" return 7, nil, 9 end)
      HooksProbe:HookScript("OnEnter", function() error("hook failed") end)
      HooksProbe:HookScript("OnEnter", NOTE("after"))
      local a, b, c = HooksProbe:GetScript("OnEnter")(HooksProbe)
      ANSWER = tostring(a) .. "," .. tostring(b) .. "," .. tostring(c)
    `);
    assert.equal(log(instance), "e,after");
    assert.equal(instance.vm.getGlobal("ANSWER"), "7,nil,9");
    const raised = instance.vm.errors.slice(errors);
    assert.equal(raised.length, 1, raised.join("\n"));
    assert.match(raised[0], /hook failed/);
  } finally {
    instance.close();
  }
});

test("a hook made while its script runs is called from the next call on", async () => {
  const instance = await boot();
  const frame = instance.bridge.getFrame("HooksProbe");
  try {
    lua51(instance, `
      HooksProbe:SetScript("OnShow", function(self)
        LOG[#LOG + 1] = "a"
        if not HOOKED then HOOKED = true self:HookScript("OnShow", NOTE("late")) end
      end)
      HooksProbe:HookScript("OnShow", NOTE("h"))
    `);
    instance.bridge.fireScript(frame, "OnShow");
    assert.equal(log(instance), "a,h");
    instance.bridge.fireScript(frame, "OnShow");
    assert.equal(log(instance), "a,h,late");
  } finally {
    instance.close();
  }
});

test("one Lua function in several slots and hook lists: each keeps working until its own slot lets go", async () => {
  const instance = await boot();
  const probe = instance.bridge.getFrame("HooksProbe");
  const other = instance.bridge.getFrame("HooksOther");
  try {
    const errors = instance.vm.errors.length;
    lua51(instance, `
      SHARED = NOTE("s")
      KEPT = { SHARED }
      HooksProbe:SetScript("OnShow", SHARED)
      HooksOther:SetScript("OnShow", SHARED)
      HooksOther:SetScript("OnShow", SHARED)
      HooksProbe:SetScript("OnShow", NOTE("p"))
    `);
    instance.bridge.fireScript(probe, "OnShow");
    instance.bridge.fireScript(other, "OnShow");
    assert.equal(log(instance), "p,s", "the other frame's slot still holds it, once");
    lua51(instance, "KEPT[1]() HooksOther:HookScript('OnShow', SHARED) HooksOther:SetScript('OnShow', SHARED)");
    instance.bridge.fireScript(other, "OnShow");
    assert.equal(log(instance), "s,s", "the table's copy, then the slot alone: the hook went with SetScript");
    assert.equal(instance.vm.errors.length, errors, instance.vm.errors.slice(errors).join("\n"));
  } finally {
    instance.close();
  }
});

test("a handler that lets go of its slot mid-call: its hooks run with their own functions, freed only after", async () => {
  const instance = await boot();
  const probe = instance.bridge.getFrame("HooksProbe");
  try {
    const errors = instance.vm.errors.length;
    lua51(instance, `
      HooksProbe:SetScript("OnShow", function(self)
        LOG[#LOG + 1] = "a"
        self:SetScript("OnShow", NOTE("b"))
        -- Registry churn while the call runs: a freed slot handed out again would make the
        -- snapshot's hook call someone else's function.
        for i = 1, 60 do HooksOther:SetScript("OnUpdate", function() LOG[#LOG + 1] = "churn" end) end
        HooksOther:SetScript("OnUpdate", nil)
        self:Hide() self:Show()
      end)
      HooksProbe:HookScript("OnShow", NOTE("h"))
      HooksProbe:Hide()
    `);
    instance.bridge.fireScript(probe, "OnShow");
    assert.equal(log(instance), "a,b,h", "the nested Show runs the new handler; the old call's hook still runs once");
    instance.bridge.fireScript(probe, "OnShow");
    assert.equal(log(instance), "b");
    assert.equal(instance.vm.errors.length, errors, instance.vm.errors.slice(errors).join("\n"));
    const before = lua.lua_rawlen(instance.vm.state, lua.LUA_REGISTRYINDEX);
    lua51(instance, "for i = 1, 200 do HooksProbe:SetScript('OnShow', NOTE('x')) end");
    assert.ok(lua.lua_rawlen(instance.vm.state, lua.LUA_REGISTRYINDEX) - before < 20);
  } finally {
    instance.close();
  }
});
