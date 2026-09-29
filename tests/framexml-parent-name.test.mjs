import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");

test("$parent names use the nearest named ancestor while relativeTo=$parent stays immediate", () => {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  const loaded = bridge.loadAddon(String.raw`<Ui>
    <Frame name="NamedParent">
      <Frame name="NamedChild">
        <Texture name="$parentDirectTexture"/>
      </Frame>
      <Frames>
        <Frame>
          <Scripts><OnLoad>
            AnonymousName = self:GetName()
            ImmediateParentName = self:GetParent():GetName()
          </OnLoad></Scripts>
          <Texture name="$parentFoo"/>
          <Frame name="$parentAnchored">
            <Anchors>
              <Anchor point="TOPLEFT" relativeTo="$parent"/>
              <Anchor point="TOPRIGHT" relativeTo="$parentFoo"/>
            </Anchors>
          </Frame>
        </Frame>
      </Frames>
    </Frame>
  </Ui>`);

  assert.equal(loaded.ok, true, loaded.diagnostics?.map((entry) => entry.message).join(" | "));

  const namedParent = bridge.getFrame("NamedParent");
  const namedChild = bridge.getFrame("NamedChild");
  const directTexture = bridge.getFrame("NamedChildDirectTexture");
  const nestedTexture = bridge.getFrame("NamedParentFoo");
  const anchored = bridge.getFrame("NamedParentAnchored");
  assert.ok(namedParent && namedChild && directTexture && nestedTexture && anchored);

  assert.equal(directTexture.parent, namedChild, "a direct named parent still expands $parent");
  assert.equal(nestedTexture.parent?.named, false, "the $parentFoo owner is an anonymous wrapper");
  assert.equal(nestedTexture.parent?.parent, namedParent);
  assert.equal(vm.getGlobal("AnonymousName"), undefined, "anonymous GetName() remains nil");
  assert.equal(vm.getGlobal("ImmediateParentName"), "NamedParent");

  assert.equal(anchored.parent?.named, false, "anchored child remains under anonymous wrapper");
  assert.equal(anchored.points.length, 2);
  assert.equal(anchored.points[0]?.relativeTo, anchored.parent,
    "relativeTo=$parent resolves the immediate layout parent");
  assert.notEqual(anchored.points[0]?.relativeTo, namedParent,
    "relativeTo=$parent must not use the nearest named ancestor");
  assert.equal(anchored.points[1]?.relativeTo, nestedTexture,
    "relativeTo=$parentFoo resolves through the nearest named ancestor");
  vm.close();
});
