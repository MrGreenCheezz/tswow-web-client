import assert from "node:assert/strict";
import test from "node:test";

const { FRAMEXML_INVENTORY_SLOTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { frameXmlTexturePath } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlTextures.js");
const { clientDirectory } = await import("../tools/paths.mjs");
const { openClientArchives } = await import("../tools/mpq.mjs");

let clientDir;
try {
  clientDir = clientDirectory();
} catch {
  clientDir = undefined;
}

test("published PaperDoll slot textures resolve in the real MPQ chain", {
  skip: clientDir ? false : "no 3.3.5a client on this machine",
}, async () => {
  const chain = await openClientArchives(clientDir);
  try {
    const paths = new Map();
    for (const [slotName, [, reference]] of Object.entries(FRAMEXML_INVENTORY_SLOTS)) {
      const path = frameXmlTexturePath(reference);
      paths.set(path, [...(paths.get(path) ?? []), slotName]);
    }
    for (const [path, slots] of paths) {
      const bytes = await chain.read(path);
      assert.ok(bytes?.length > 0, `${slots.join(", ")} resolves ${path}`);
    }
    assert.equal(paths.get("Interface\\Paperdoll\\UI-PaperDoll-Slot-Rear.blp")?.length, 1);
    assert.equal(paths.get("Interface\\Paperdoll\\UI-PaperDoll-Slot-Wrists.blp")?.length, 1);
    assert.equal(paths.get("Interface\\Paperdoll\\UI-PaperDoll-Slot-Bag.blp")?.length, 4);
  } finally {
    await chain.close();
  }
});
