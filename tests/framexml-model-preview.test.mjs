import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { FrameXmlModelPreview, frameXmlPreviewSource } from "../dist/code/browser/framexml/FrameXmlModelPreview.js";

test("3.61: SetCreature resolves a template's display and retains display textures; ClearModel cancels it", async () => {
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
    assert.equal(boot.vm.execute("Preview:ClearModel()", "@clear-preview").ok, true);
    assert.equal(frameXmlPreviewSource(frame, template, models), undefined);
    assert.equal(boot.vm.execute("Preview:SetDisplayInfo(678)", "@display-preview").ok, true);
    assert.equal(frameXmlPreviewSource(frame, () => { throw Error("display needs no template lookup"); }, models).file, metadata.model);
    assert.equal(boot.vm.execute('Preview:SetModel("Spells\\\\Test.m2")', "@file-preview").ok, true);
    assert.equal(frame.model.displayId, undefined);
    assert.equal(frameXmlPreviewSource(frame, template, models), undefined, "a file alone is not this stage's");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("3.61: with nothing shown by id the step touches no stage, so a world without these windows pays nothing", () => {
  const frame = { model: {} };
  const preview = new FrameXmlModelPreview({
    gatewayOrigin: "http://127.0.0.1:8090",
    bridge: { modelFrames: new Set([frame]), isVisible: () => true },
    elementFor: () => { throw new Error("no stage reads a frame's element yet"); },
    creatureTemplate: () => undefined,
    creatureModels: { get: () => undefined, request() {} },
  });
  preview.frame(0.016, 16);
  preview.frame(0.016, 32);
  preview.dispose();
  preview.frame(0.016, 48);
});

test("3.61: the page frame draws it: the world mount's step runs the stage and the teardown ends it", async () => {
  const { readFile } = await import("node:fs/promises");
  const mount = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  assert.match(mount, /resources\.models = new FrameXmlModelPreview\(\{/);
  assert.match(mount, /renderer\.tickMessageFades\(\);\s*resources\.models\?\.frame\(elapsed, performance\.now\(\)\);/);
  assert.match(mount, /bestEffortCleanup\(\(\) => record\.models\?\.dispose\(\)\);/);
});
