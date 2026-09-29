import assert from "node:assert/strict";
import test from "node:test";

const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { frameXmlTexturePath, FrameXmlTextureCache } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlTextures.js");

function textureFixture() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(
    String(args[0] ?? "Frame"),
    args[1] === undefined ? undefined : String(args[1]),
    args[2],
    args[3] === undefined ? undefined : String(args[3]),
  )]);
  return { vm, bridge };
}

test("Texture:SetTexture keeps paths and colors, but rejects tables before gateway resolution", async () => {
  const { vm, bridge } = textureFixture();
  const requests = [];
  const cache = new FrameXmlTextureCache({
    resolve: (path) => `/texture?path=${encodeURIComponent(path)}`,
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: false, status: 400 };
    },
  });
  try {
    const frame = bridge.CreateFrame("Texture", "TextureProbe");
    assert.ok(frame);

    const pathResult = vm.execute(
      `TextureProbe:SetTexture("Interface\\\\Icons\\\\INV_Misc_QuestionMark")`,
      "@texture-path",
    );
    assert.equal(pathResult.ok, true, pathResult.error ?? "path script failed");
    assert.equal(frame.texture, "Interface\\Icons\\INV_Misc_QuestionMark");

    const colorResult = vm.execute(
      "TextureProbe:SetTexture(0.25, 0.5, 0.75, 0.9)",
      "@texture-color",
    );
    assert.equal(colorResult.ok, true, colorResult.error ?? "color script failed");
    assert.equal(frame.texture, "");
    assert.deepEqual(frame.vertexColor, { r: 0.25, g: 0.5, b: 0.75, a: 0.9 });

    const objectResult = vm.execute(
      "TextureProbe:SetTexture({ path = \"Interface\\\\Icons\\\\INV_Misc_QuestionMark\" })",
      "@texture-object",
    );
    assert.equal(objectResult.ok, true, objectResult.error ?? "object script failed");
    assert.equal(frame.texture, "");
    assert.notEqual(frame.texture, "[object Object]");

    // This is the renderer's exact gateway boundary: an empty reference must not enqueue /texture.
    const requestedPath = frame.texture ? frameXmlTexturePath(frame.texture) : "";
    if (requestedPath) cache.acquire(requestedPath);
    await Promise.resolve();
    assert.deepEqual(requests, []);

    assert.equal(bridge.SetTexture(frame, { path: "Interface\\Icons\\INV_Misc_QuestionMark" }), false);
    assert.equal(frame.texture, "");
  } finally {
    cache.dispose();
    vm.close();
  }
});

test("Button:SetNormalTexture accepts the MoneyFrame Texture handle overload", () => {
  const { vm, bridge } = textureFixture();
  try {
    const button = bridge.CreateFrame("Button", "MoneyButton");
    assert.ok(button);

    // MoneyFrame.lua's CreateMoneyButtonNormalTexture path: the texture is created on the button,
    // configured by path, and handed back as an object rather than as a second filename argument.
    const result = vm.execute(`
      local texture = MoneyButton:CreateTexture()
      texture:SetTexture("Interface\\\\MoneyFrame\\\\UI-MoneyIcons")
      MoneyButton:SetNormalTexture(texture)
      MoneyFrameTextureHandle = texture
    `, "@money-frame-normal-texture");
    assert.equal(result.ok, true, result.error ?? "MoneyFrame handle script failed");

    const handle = vm.getGlobal("MoneyFrameTextureHandle");
    const normal = button.stateTextures.get("NORMAL");
    assert.ok(handle);
    assert.strictEqual(normal, handle);
    assert.equal(normal?.texture, "Interface\\MoneyFrame\\UI-MoneyIcons");
    assert.equal(normal?.stateTexture, "NORMAL");
    assert.equal(normal?.drawLayer, "ARTWORK");
    assert.strictEqual(normal?.parent, button);
    assert.equal(button.children.filter((child) => child === normal).length, 1);
    assert.notEqual(normal?.texture, "[object Object]");
    assert.equal(
      normal ? frameXmlTexturePath(normal.texture) : "",
      "Interface\\MoneyFrame\\UI-MoneyIcons.blp",
    );
  } finally {
    vm.close();
  }
});
