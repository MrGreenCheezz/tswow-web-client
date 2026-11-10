import assert from "node:assert/strict";
import test from "node:test";

/*
 * 7.57 (11.11): the stock MinimapPing frame from the client's own Minimap.xml/Minimap.lua, driven by MINIMAP_PING as
 * Wow.exe 0x0057eb80 raises it ("%s%f%f": unit token, x and y in widths of the circle). The engine draws no ping of its
 * own, so this frame is the whole picture: placed once at the event, 5.5 s (MINIMAPPING_TIMER), the last 0.5 s fading.
 */
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const decoder = new TextDecoder("utf-8");

function lua(boot, source, count) {
  const names = Array.from({ length: count }, (_, index) => `__ping${index}`);
  const executed = boot.vm.execute(`${names.join(", ")} = ${source}`, "@minimap-ping-probe");
  assert.equal(executed.ok, true, executed.error ?? source);
  return names.map((name) => boot.vm.getGlobal(name));
}

test("MINIMAP_PING places the stock MinimapPing at the offset, keeps it 5.5 s and fades the last half second", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let boot;
  try {
    boot = new FrameXmlBoot({
      provider: {
        async read(path) {
          const data = await chain.read(path);
          return data ? decoder.decode(data) : undefined;
        },
      },
      locale: "ruRU",
      subset: FRAMEXML_VERTICAL_TOC,
      seam: new CannedWorldSeam(),
      minimapAdapter: {
        getZoom: () => 0, getZoomLevels: () => 6, setZoom: () => {}, pingLocation: () => {},
      },
      screen: () => ({ width: 1024, height: 768 }),
    });
    await boot.load();
    const errorsBefore = boot.vm.errors.length;
    const ping = boot.bridge.getFrame("MinimapPing");
    assert.ok(ping, "MinimapPing comes from the stock Minimap.xml");
    assert.ok(ping.registeredEvents.has("MINIMAP_PING"));
    assert.deepEqual(lua(boot, "MinimapPing:IsShown() and 1 or 0, Minimap:GetWidth()", 2), [0, 140]);

    // A quarter of the width right, a tenth down: Minimap_SetPing multiplies by the Minimap's size.
    assert.equal(boot.pump.fire("MINIMAP_PING", "party1", 0.25, -0.1), 1);
    const [shown, point, relative, relativePoint, x, y, alpha] =
      lua(boot, "MinimapPing:IsShown() and 1 or 0, MinimapPing:GetPoint()", 7).slice(0, 6)
        .concat(lua(boot, "MinimapPing:GetAlpha()", 1));
    assert.equal(shown, 1);
    assert.equal(point, "CENTER");
    assert.equal(relativePoint, "CENTER");
    assert.ok(relative, "anchored to Minimap");
    assert.ok(Math.abs(x - 35) < 1e-6 && Math.abs(y - -14) < 1e-6, `${x}, ${y}`);
    assert.equal(alpha, 1);

    // OnUpdate runs the stock animation; at 4.9 s it is whole, at 5.1 s fading, past 5.5 s gone.
    for (let step = 0; step < 49; step++) boot.bridge.tick(0.1);
    assert.deepEqual(lua(boot, "MinimapPing:IsShown() and 1 or 0, MinimapPing:GetAlpha()", 2), [1, 1]);
    boot.bridge.tick(0.1);
    boot.bridge.tick(0.1);
    const [fadingShown, fadingAlpha] = lua(boot, "MinimapPing:IsShown() and 1 or 0, MinimapPing:GetAlpha()", 2);
    assert.equal(fadingShown, 1);
    assert.ok(fadingAlpha > 0 && fadingAlpha < 1, `fading at ${fadingAlpha}`);
    for (let step = 0; step < 6; step++) boot.bridge.tick(0.1);
    assert.deepEqual(lua(boot, "MinimapPing:IsShown() and 1 or 0", 1), [0]);

    // Outside the circle Minimap_SetPing hides the frame instead.
    boot.pump.fire("MINIMAP_PING", "player", 0.5, 0.5);
    assert.deepEqual(lua(boot, "MinimapPing:IsShown() and 1 or 0", 1), [0]);
    assert.deepEqual(boot.vm.errors.slice(errorsBefore), [], "the stock ping code raised no Lua error");
  } finally {
    boot?.close();
    chain.close();
  }
});
