import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";

test("SetHighlightTexture defaults to ADD for paths and handles and honours an explicit blend mode", async () => {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Highlight.lua",
    "interface/framexml/highlight.lua": `
      Button = CreateFrame("Button", "Button")
      Button:SetNormalTexture("Interface\\\\Buttons\\\\Normal")
      Button:SetHighlightTexture("Interface\\\\Buttons\\\\Highlight")
      HandleButton = CreateFrame("Button", "HandleButton")
      Highlight = HandleButton:CreateTexture("Highlight", "ARTWORK")
      Highlight:SetTexture("Interface\\\\Store\\\\Button")
      Highlight:SetTexCoord(0.1, 0.9, 0.2, 0.4)
      Highlight:SetSize(120, 20)
      HandleButton:SetHighlightTexture(Highlight)
    `,
  }) });
  try {
    await boot.load();
    const button = boot.bridge.getFrame("Button");
    const pathHighlight = button.stateTextures.get("HIGHLIGHT");
    const highlight = boot.bridge.getFrame("Highlight");
    assert.equal(pathHighlight.alphaMode, "ADD");
    assert.equal(highlight.alphaMode, "ADD");
    assert.equal(button.stateTextures.get("NORMAL").alphaMode, "BLEND");
    assert.equal(boot.bridge.getFrame("HandleButton").stateTextures.get("HIGHLIGHT"), highlight);
    assert.deepEqual(highlight.texCoords, { left: 0.1, right: 0.9, top: 0.2, bottom: 0.4 });
    const execute = (source) => assert.equal(boot.vm.execute(source, "@highlight-mode").ok, true);
    execute('Button:SetHighlightTexture("Interface\\\\Buttons\\\\Replacement", "BLEND"); HandleButton:SetHighlightTexture(Highlight, "BLEND")');
    assert.equal(button.stateTextures.get("HIGHLIGHT"), pathHighlight, "replacement retains the existing texture widget");
    assert.equal(pathHighlight.alphaMode, "BLEND");
    assert.equal(highlight.alphaMode, "BLEND");
    execute('Button:SetHighlightTexture("Interface\\\\Buttons\\\\Highlight"); HandleButton:SetHighlightTexture(Highlight)');
    assert.equal(pathHighlight.alphaMode, "ADD", "omitting the mode restores the default on an existing texture");
    assert.equal(highlight.alphaMode, "ADD");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});
