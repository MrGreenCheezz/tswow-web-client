import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";

test("Lua SetPoint preserves offsets when an addon omits relativePoint", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Anchors.lua",
      "interface/framexml/anchors.lua": `
        Parent = CreateFrame("Frame", "Parent")
        Other = CreateFrame("Frame", "Other")
        function anchor(name, ...)
          local frame = CreateFrame("Frame", name, Parent)
          frame:SetPoint(...)
        end
        anchor("ParentOffset", "TOPLEFT", Parent, 8, -44)
        anchor("NamedOffset", "TOPLEFT", "Parent", 12, -88)
        anchor("ImplicitParent", "TOPLEFT", 4, -22)
        anchor("OtherOnly", "TOPLEFT", Other)
        anchor("OtherCorner", "TOPLEFT", Other, "BOTTOMRIGHT")
        anchor("Full", "TOPLEFT", Other, "BOTTOMRIGHT", 16, -32)
        anchor("Centered", "CENTER")
      `,
    }),
    exercise: false,
  });
  try {
    await boot.load();
    const point = (name) => {
      const frame = boot.bridge.getFrame(name);
      const [value] = frame.points;
      return [value.point, value.relativeTo?.name ?? frame.parent?.name, value.relativePoint, value.x, value.y];
    };
    assert.deepEqual(point("ParentOffset"), ["TOPLEFT", "Parent", "TOPLEFT", 8, -44]);
    assert.deepEqual(point("NamedOffset"), ["TOPLEFT", "Parent", "TOPLEFT", 12, -88]);
    assert.deepEqual(point("ImplicitParent"), ["TOPLEFT", "Parent", "TOPLEFT", 4, -22]);
    assert.deepEqual(point("OtherOnly"), ["TOPLEFT", "Other", "TOPLEFT", 0, 0]);
    assert.deepEqual(point("OtherCorner"), ["TOPLEFT", "Other", "BOTTOMRIGHT", 0, 0]);
    assert.deepEqual(point("Full"), ["TOPLEFT", "Other", "BOTTOMRIGHT", 16, -32]);
    assert.deepEqual(point("Centered"), ["CENTER", "Parent", "CENTER", 0, 0]);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});
