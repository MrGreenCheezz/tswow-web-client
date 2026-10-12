// Plan item 3.24 (12.10), MPQ vertical: stock WorldStateScoreFrame as the scoreboard's owner over the canned seam —
// the gate (FrameXmlScoreboardOwner.ts), the controller the key, /score, the native menu and Escape ask
// (FrameXmlScoreboardController.ts), and stock ToggleWorldStateScoreFrame's own rule (WorldStateFrame.lua:926-934):
// nothing opens without a running battleground (MiniMapBattlefieldFrame.status, BattlefieldFrame.lua:204-309).
import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { frameXmlScoreboardGate, createFrameXmlScoreboardOwner } =
  await import("../dist/code/browser/framexml/FrameXmlScoreboardOwner.js");
const {
  publishFrameXmlScoreboard, toggleFrameXmlScoreboard, frameXmlScoreboardOpen, closeFrameXmlScoreboard,
  frameXmlScoreboardPublished,
} = await import("../dist/code/browser/framexml/FrameXmlScoreboardController.js");

const decoder = new TextDecoder("utf-8");

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "scoreboard-owner", []);
  assert.ok(fn, `the probe compiles: ${code}`);
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

/** The renderer's answer for a drawn frame: its element names the frame and its type. */
const renderer = {
  elementFor: (frame) => (frame ? {
    dataset: {},
    getAttribute: (name) => (name === "data-framexml-name" ? frame.name : name === "data-framexml-type" ? frame.type : null),
  } : undefined),
};

test("3.24: stock WorldStateScoreFrame owns the scoreboard key — the gate, Toggle's own rule, the close", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { openClientArchives } = await import("../tools/mpq.mjs");
  const chain = await openClientArchives(clientDirectory);
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  let cleanup;
  try {
    await boot.load();
    const errors = boot.errorCount;
    const gate = frameXmlScoreboardGate(seam, boot, renderer);
    assert.ok(gate, "the complete stock board passes");
    assert.equal(gate.frame.name, "WorldStateScoreFrame");
    assert.equal(boot.bridge.isVisible(gate.frame), false, "the probe leaves the board hidden");
    assert.equal(boot.errorCount, errors, `the probe raises nothing: ${JSON.stringify(boot.errors.slice(errors))}`);

    // Refusals: no scoreboard model; BattlefieldFrame no longer hearing the queue status (the world mount's
    // state without the complete battleground page), where the stock key could never open the board.
    // (Compared by name: a frame in a failed assertion's message would print the whole tree.)
    const gated = (host) => frameXmlScoreboardGate(host, boot, renderer)?.frame.name;
    assert.equal(gated({ scoreboard: undefined }), undefined);
    lua(boot, 'BattlefieldFrame:UnregisterEvent("UPDATE_BATTLEFIELD_STATUS")', 0);
    assert.equal(gated(seam), undefined, "no queue status, no stock key");
    lua(boot, 'BattlefieldFrame:RegisterEvent("UPDATE_BATTLEFIELD_STATUS")', 0);
    assert.equal(gated(seam), "WorldStateScoreFrame");

    assert.equal(toggleFrameXmlScoreboard(), false, "unpublished: the caller opens the native board");
    cleanup = publishFrameXmlScoreboard(createFrameXmlScoreboardOwner(boot, gate.frame));
    assert.equal(frameXmlScoreboardPublished(), true);

    // Outside a battleground Wow.exe's key opens nothing — and neither does the native board now.
    assert.equal(toggleFrameXmlScoreboard(), true);
    assert.equal(frameXmlScoreboardOpen(), false);

    // In a running battleground (the status BattlefieldFrame_UpdateStatus writes for it).
    seam.pvpWorld.setRunningBattlefield(489, false);
    lua(boot, 'MiniMapBattlefieldFrame.status = "active"', 0);
    assert.equal(toggleFrameXmlScoreboard(), true);
    assert.equal(frameXmlScoreboardOpen(), true, "the key opens the stock board");
    assert.equal(toggleFrameXmlScoreboard(), true);
    assert.equal(frameXmlScoreboardOpen(), false, "and closes it");
    toggleFrameXmlScoreboard();
    assert.equal(closeFrameXmlScoreboard(), true, "Escape closes an open board");
    assert.equal(frameXmlScoreboardOpen(), false);
    assert.equal(closeFrameXmlScoreboard(), false, "nothing open: Escape goes on down the chain");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(errors))}`);

    cleanup();
    cleanup = undefined;
    assert.equal(frameXmlScoreboardPublished(), false);
    assert.equal(toggleFrameXmlScoreboard(), false, "unmounted: the native board again");
  } finally {
    cleanup?.();
    boot.close();
    chain.close();
  }
});
