import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("a latched add-on list fails the mount", async () => {
  const source = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  // The list fetch used to swallow every failure into []: the patch latch must end the mount with
  // its own message instead of booting with no add-ons.
  // 3.46 (13.10): the list call is fetchFrameXmlClientAddonList (the whole installed list beside the enabled one).
  assert.match(source, /fetchFrameXmlClientAddonList\(origin\)\.catch\(\(error\) => \{\s*if \(isPatchChainChangedError\(error\)\) patchChainChanged = error;\s*else console\.warn/);
  const bail = source.indexOf("if (patchChainChanged) return { ok: false, message: patchChainChanged.message };");
  assert.ok(bail > source.indexOf("fetchFrameXmlClientAddonList(origin)"), "checked right after the list");
  assert.ok(bail < source.indexOf("waitForFrameXmlLoginClock({"), "before the mount waits for the world");
});
