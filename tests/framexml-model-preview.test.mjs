import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { frameXmlPreviewSource } from "../dist/code/browser/framexml/FrameXmlModelPreview.js";

test("SetCreature resolves a template's display and retains display textures; ClearModel cancels it", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Model.lua",
      "interface/framexml/model.lua": 'Preview = CreateFrame("DressUpModel", "Preview"); Preview:SetCreature(12345); Preview:SetFacing(1.25)',
    }),
    exercise: false,
  });
  const requests = [];
  const metadata = { model: "Creature\\Wolf\\Wolf.m2", textures: "11:WolfSkinBlack", scale: 1.2 };
  let ready = false;
  const models = { get: id => ready && id === 678 ? metadata : undefined, request: id => requests.push(id) };
  const template = entry => { assert.equal(entry, 12345); return { found: true, displayIds: [0, 678, 0, 0] }; };
  try {
    await boot.load();
    const frame = boot.bridge.getFrame("Preview");
    assert.equal(frame.model.creatureEntry, 12345);
    assert.equal(frame.model.facing, 1.25);
    assert.equal(frameXmlPreviewSource(frame, template, models), undefined);
    assert.deepEqual(requests, [678], "SetCreature's template entry must never be sent as a display id");
    ready = true;
    assert.deepEqual(frameXmlPreviewSource(frame, template, models), {
      key: "display:678:Creature\\Wolf\\Wolf.m2:11:WolfSkinBlack",
      file: metadata.model, textures: metadata.textures, appearance: undefined, displayScale: 1.2, fitBody: true,
    });
    assert.equal(boot.vm.execute('Preview:ClearModel()', '@clear-preview').ok, true);
    assert.equal(frameXmlPreviewSource(frame, template, models), undefined);
    assert.equal(boot.vm.execute('Preview:SetDisplayInfo(678)', '@display-preview').ok, true);
    assert.equal(frameXmlPreviewSource(frame, () => { throw Error("display needs no template lookup"); }, models).file, metadata.model);
    assert.equal(boot.vm.execute('Preview:SetModel("Spells\\\\Test.m2")', '@file-preview').ok, true);
    assert.equal(frame.model.displayId, undefined);
    assert.equal(frameXmlPreviewSource(frame, template, models).file, "Spells\\Test.m2");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});
