import assert from "node:assert/strict";
import test from "node:test";
import { lua } from "fengari";

// Plan item 3.27 (03.10, L5): script handlers as Wow.exe 3.3.5a keeps them. SetScript (0x0049ec80)
// unrefs the slot's old function before it stores the new one; HookScript (0x0049edb0) on an empty
// slot stores the hook as the handler, otherwise it replaces the slot's function with a closure
// (0x00817050) that runs the old one and then the hook — so a later SetScript, nil included,
// replaces the hooks too.
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
        CreateFrame("Frame", "ScriptsProbe", UIParent)
      `,
    }),
    exercise: false,
  });
  await instance.load();
  return instance;
}

function lua51(instance, source) {
  const result = instance.vm.execute(source, "@scripts-probe");
  assert.equal(result.ok, true, result.error);
}

function log(instance) {
  const fn = instance.vm.compileFunction("local out = table.concat(LOG, ',') LOG = {} return out", "scripts-log", []);
  try {
    return instance.vm.call(fn, [], 1)[0];
  } finally {
    instance.vm.release(fn);
  }
}

function registrySize(instance) {
  return lua.lua_rawlen(instance.vm.state, lua.LUA_REGISTRYINDEX);
}

test("replacing a script handler frees the Lua reference the old one held", async () => {
  const instance = await boot();
  try {
    lua51(instance, 'ScriptsProbe:SetScript("OnUpdate", function() end) ScriptsProbe:SetScript("OnEvent", function() end)');
    const before = registrySize(instance);
    // UIFrameFade and the chat frames set OnUpdate again on every hover: this used to pin a function each time.
    lua51(instance, `
      for i = 1, 1000 do
        ScriptsProbe:SetScript("OnUpdate", function() return i end)
        ScriptsProbe:SetScript("OnEvent", function() return i end)
      end
    `);
    assert.ok(registrySize(instance) - before < 20, `registry grew by ${registrySize(instance) - before}`);
    // Hooks are held while they are hooked (the client's closure chain holds them too)…
    lua51(instance, 'for i = 1, 300 do ScriptsProbe:HookScript("OnUpdate", function() return i end) end');
    const hooked = registrySize(instance);
    assert.ok(hooked - before >= 300);
    // …and a SetScript lets the whole chain go: 300 new references take the freed slots.
    lua51(instance, 'ScriptsProbe:SetScript("OnUpdate", nil)');
    lua51(instance, 'for i = 1, 300 do ScriptsProbe:HookScript("OnEvent", function() return i end) end');
    assert.ok(registrySize(instance) - hooked < 20, `registry grew by ${registrySize(instance) - hooked} after the release`);
  } finally {
    instance.close();
  }
});

test("SetScript replaces the hooks with the handler, as the client's single script slot does", async () => {
  const instance = await boot();
  const frame = instance.bridge.getFrame("ScriptsProbe");
  try {
    lua51(instance, 'ScriptsProbe:SetScript("OnShow", NOTE("a")) ScriptsProbe:HookScript("OnShow", NOTE("h"))');
    instance.bridge.fireScript(frame, "OnShow");
    assert.equal(log(instance), "a,h");
    lua51(instance, 'ScriptsProbe:SetScript("OnShow", NOTE("b"))');
    instance.bridge.fireScript(frame, "OnShow");
    assert.equal(log(instance), "b", "the hook went with the old handler");
    lua51(instance, 'ScriptsProbe:HookScript("OnShow", NOTE("h2")) ScriptsProbe:SetScript("OnShow", nil)');
    instance.bridge.fireScript(frame, "OnShow");
    assert.equal(log(instance), "", "SetScript(nil) clears the slot, hooks included");

    // HookScript on an empty slot stores the hook as the handler: GetScript answers it.
    lua51(instance, `
      local hook = NOTE("only")
      ScriptsProbe:HookScript("OnHide", hook)
      SAME = ScriptsProbe:GetScript("OnHide") == hook
    `);
    assert.equal(instance.vm.getGlobal("SAME"), true);
    instance.bridge.fireScript(frame, "OnHide");
    assert.equal(log(instance), "only");
  } finally {
    instance.close();
  }
});

test("a handler that clears its own script still lets its hook run in that call", async () => {
  const instance = await boot();
  const frame = instance.bridge.getFrame("ScriptsProbe");
  try {
    const errors = instance.vm.errors.length;
    lua51(instance, `
      ScriptsProbe:SetScript("OnShow", function(self) LOG[#LOG + 1] = "p" self:SetScript("OnShow", nil) end)
      ScriptsProbe:HookScript("OnShow", NOTE("h"))
    `);
    instance.bridge.fireScript(frame, "OnShow");
    assert.equal(log(instance), "p,h");
    instance.bridge.fireScript(frame, "OnShow");
    assert.equal(log(instance), "");
    assert.equal(instance.vm.errors.length, errors, instance.vm.errors.slice(errors).join("\n"));
  } finally {
    instance.close();
  }
});

test("SetScript(\"OnUpdate\", nil) keeps a host hook ticking and drops the Lua ones", async () => {
  const instance = await boot();
  const frame = instance.bridge.getFrame("ScriptsProbe");
  try {
    let hostTicks = 0;
    instance.bridge.HookScript(frame, "OnUpdate", () => { hostTicks += 1; });
    lua51(instance, 'ScriptsProbe:SetScript("OnUpdate", NOTE("u")) ScriptsProbe:HookScript("OnUpdate", NOTE("lua-hook"))');
    instance.bridge.tick(0.016);
    assert.equal(log(instance), "u,lua-hook");
    assert.equal(hostTicks, 1);
    lua51(instance, 'ScriptsProbe:SetScript("OnUpdate", nil)');
    instance.bridge.tick(0.016);
    assert.equal(log(instance), "");
    assert.equal(hostTicks, 2, "the host's hook still ticks the frame");
  } finally {
    instance.close();
  }
});
