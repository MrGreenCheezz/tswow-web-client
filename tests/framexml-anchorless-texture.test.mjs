import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

// 3.51: Wow.exe's XML texture factory (0x00815f40 — layer, button state and status-bar textures)
// ends in 0x004830e0: a texture with none of its nine points set gets SetAllPoints(parent), whatever
// <Size> it declares. CreateTexture with a template does the same (0x004a2010); a bare one does not.
// The stock case is CoinPickupFrame's background — `<Size x="256" y="32"/>`, no anchors, TexCoords
// cropping 172x96 of UI-MoneyFrame — which drew squashed into a 256x32 strip.

async function boot() {
  const loaded = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml\nFrames.lua",
    "interface/framexml/frames.xml": `<Ui>
      <Texture name="TemplateLess" virtual="true"><Size x="10" y="10"/></Texture>
      <Frame name="Coin" width="172" height="96">
        <Layers>
          <Layer level="BACKGROUND">
            <Texture name="CoinBackground" file="Interface\\MoneyFrame\\UI-MoneyFrame">
              <Size><AbsDimension x="256" y="32"/></Size>
              <TexCoords left="0" right="0.671875" top="0" bottom="0.75"/>
            </Texture>
            <Texture name="CoinAnchored"><Size x="16" y="16"/><Anchors><Anchor point="RIGHT"/></Anchors></Texture>
            <FontString name="CoinLabel"><Size x="14" y="14"/></FontString>
          </Layer>
        </Layers>
        <Frames>
          <Button name="CoinButton" width="20" height="20">
            <NormalTexture file="Interface\\Buttons\\UI-Panel-Button-Up"><Size x="64" y="64"/></NormalTexture>
          </Button>
        </Frames>
      </Frame></Ui>`,
    "interface/framexml/frames.lua": `
      FromTemplate = Coin:CreateTexture("CoinFromTemplate", "ARTWORK", "TemplateLess")
      Bare = Coin:CreateTexture("CoinBare", "ARTWORK")
    `,
  }) });
  await loaded.load();
  return loaded;
}

const filled = (frame, parent) => frame.points.length === 2
  && frame.points.every((point) => point.relativeTo === parent && point.point === point.relativePoint)
  && frame.points.map((point) => point.point).join() === "TOPLEFT,BOTTOMRIGHT";

test("an anchorless XML texture fills its parent whatever size it declares; a FontString does not", async () => {
  const loaded = await boot();
  try {
    const coin = loaded.bridge.getFrame("Coin");
    assert.ok(filled(loaded.bridge.getFrame("CoinBackground"), coin), "the 256x32 background fills the 172x96 frame");
    assert.equal(loaded.bridge.getFrame("CoinAnchored").points.length, 1, "an anchored texture keeps its anchor");
    assert.equal(loaded.bridge.getFrame("CoinLabel").points.length, 0, "a sized FontString is not the texture factory's");
    const button = loaded.bridge.getFrame("CoinButton");
    assert.ok(filled(button.stateTextures.get("NORMAL"), button), "a sized state texture fills its button too");
  } finally { loaded.close(); }
});

test("CreateTexture fills its parent only when a template left it without points", async () => {
  const loaded = await boot();
  try {
    const coin = loaded.bridge.getFrame("Coin");
    assert.ok(filled(loaded.bridge.getFrame("CoinFromTemplate"), coin));
    assert.equal(loaded.bridge.getFrame("CoinBare").points.length, 0);
  } finally { loaded.close(); }
});
