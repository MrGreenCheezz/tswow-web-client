import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";

// `IsObjectType(kind)` (glue/GlueWidgets.ts): the widget's own kind or any kind it inherits from —
// a CheckButton is a Button, a Frame, a Region — compared without regard to case, as the client
// compares it: stock UIParent.lua:1301 asks `frame:IsObjectType("frame")` before `IsUserPlaced`,
// the one lower-case caller among the 718 Interface files of the ruRU client.
test("IsObjectType answers the kind and the kinds it inherits from, in any case", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Kinds.lua",
      "interface/framexml/kinds.lua": `
        local frame = CreateFrame("Frame", "KindFrame")
        local check = CreateFrame("CheckButton", "KindCheck")
        local texture = frame:CreateTexture("KindTexture")
        local function answers(object, ...)
          local out = {}
          for i = 1, select("#", ...) do out[i] = tostring(object:IsObjectType((select(i, ...)))) end
          return table.concat(out, " ")
        end
        KindFrameAnswers = answers(frame, "frame", "FRAME", "Frame", "fRaMe", "region", "UIOBJECT", "button", "Frames", "")
        KindCheckAnswers = answers(check, "button", "BUTTON", "CheckButton", "checkbutton", "frame", "editbox")
        KindTextureAnswers = answers(texture, "texture", "LAYEREDREGION", "frame")
      `,
    }),
    exercise: false,
  });
  try {
    await boot.load();
    assert.deepEqual(boot.errors, []);
    assert.equal(boot.vm.getGlobal("KindFrameAnswers"), "true true true true true true false false false",
      "a Frame is a frame, a region and a UI object in any case; not a button, and no partial names");
    assert.equal(boot.vm.getGlobal("KindCheckAnswers"), "true true true true true false",
      "a CheckButton is a button (stock /click of an action button) and a frame");
    assert.equal(boot.vm.getGlobal("KindTextureAnswers"), "true true false");
  } finally {
    boot.close();
  }
});
