import assert from "node:assert/strict";
import test, { after } from "node:test";
import { TswowAddonTestTransport } from "../tools/check-tswow-addons.mjs";

// Plan item 3.18 (review A2-3, lens B): every loading screen is now one PLAYER_LEAVING_WORLD and one
// PLAYER_ENTERING_WORLD (FrameXmlWorldEntry.ts). The owner's rule is that TSWoW modules work as
// written, so the real module blocks of the active FrameXML.toc — retail-talents among them — are
// booted as the live mount boots them and taken through two loading screens: no Lua error, no frame
// created twice, no ADDON_LOADED again, and each screen sends the modules' state requests once (the
// same number both times, so no handler was registered twice).
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH, frameXmlAddonModules } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");

let chain;
after(() => chain?.close());

test("the real TSWoW modules take two loading screens without an error or a second initialisation", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const provider = { read: async (path) => { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } };
  const declared = frameXmlAddonModules(await provider.read(FRAMEXML_TOC_PATH) ?? "");
  if (declared.length === 0) return;
  const packets = new TswowAddonTestTransport();
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, includeActiveTsAddons: true,
    seam: new CannedWorldSeam(), clientNetwork: packets, exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS,
    savedVariables: { scope: { account: "a", realm: "r", character: "c" }, storage: { getItem: () => null, setItem() {} } },
    screen: () => ({ width: 1024, height: 768 }),
  });
  const addonLoaded = [];
  const dispatch = boot.bridge.dispatchEvent.bind(boot.bridge);
  boot.bridge.dispatchEvent = (event, ...args) => {
    if (event === "ADDON_LOADED") addonLoaded.push(String(args[0]));
    return dispatch(event, ...args);
  };
  const frames = (count) => {
    for (let index = 0; index < count; index++) {
      boot.bridge.runInMutationBatch(() => { boot.tickSeam(boot.pump.now()); boot.bridge.tick(1 / 60); });
    }
  };
  try {
    await boot.load();
    assert.deepEqual(boot.tsAddonResults.filter((result) => !result.ok).map((result) => result.module), []);
    frames(30);
    const screens = [];
    for (let round = 0; round < 2; round++) {
      const errors = boot.errorCount;
      const widgets = boot.bridge.frames.length;
      const sent = packets.sent.length;
      const loaded = addonLoaded.length;
      boot.pump.fire("PLAYER_LEAVING_WORLD");
      frames(5);
      boot.pump.fire("PLAYER_ENTERING_WORLD");
      frames(30);
      screens.push({
        errors: boot.errors.slice(boot.errors.length - (boot.errorCount - errors)).map((error) => `${error.file}:${error.line} ${error.message}`),
        widgets: boot.bridge.frames.length - widgets,
        addonLoaded: addonLoaded.length - loaded,
        packets: packets.sent.slice(sent).map((packet) => packet.opcode),
      });
    }
    for (const screen of screens) {
      assert.deepEqual(screen.errors, [], "no Lua error on a loading screen");
      assert.equal(screen.widgets, 0, "no frame created again");
      assert.equal(screen.addonLoaded, 0, "no ADDON_LOADED again");
    }
    assert.deepEqual(screens[1].packets, screens[0].packets, "each loading screen sends the same requests, once");
  } finally {
    boot.close();
  }
});
