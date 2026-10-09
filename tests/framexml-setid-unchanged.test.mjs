import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

// 07.10 (P1-15 census): `TemporaryEnchantFrame_Update` (BuffFrame.lua) sets the same id on
// `TempEnchant1` every frame while a weapon enchant is up, and each call announced a layout pass:
// 600 layout passes in 600 census frames, 145 once an unchanged id stopped announcing. An unchanged
// `SetID` now announces nothing; a changed one still does, and `GetID` answers either way.

const FIXTURE = {
  "interface/framexml/framexml.toc": "Ids.lua",
  "interface/framexml/ids.lua": `
    UIParent = CreateFrame("Frame", "UIParent")
    Enchant = CreateFrame("Button", "Enchant", UIParent)
  `,
};

async function booted() {
  const boot = new FrameXmlBoot({ provider: createFixtureProvider(FIXTURE), subset: ["Ids.lua"], exercise: false });
  await boot.load();
  const bridge = boot.bridge;
  const kinds = [];
  const notify = bridge.notifyMutation;
  bridge.notifyMutation = function (frame, kind = "layout") {
    if (frame?.name === "Enchant") kinds.push(kind);
    return notify.call(this, frame, kind);
  };
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@setid", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  return { kinds, run };
}

test("an unchanged SetID announces nothing; a changed one still does", async () => {
  const { kinds, run } = await booted();
  run("Enchant:SetID(16)");
  assert.equal(kinds.length, 1, "the first id is a change");
  kinds.length = 0;
  for (let i = 0; i < 100; i++) run("Enchant:SetID(16)");
  assert.deepEqual(kinds, [], "100 frames of the same id");
  run("Enchant:SetID(17)");
  assert.equal(kinds.length, 1, "a new id is announced");
  assert.deepEqual(run("return Enchant:GetID()", 1), [17]);
});
