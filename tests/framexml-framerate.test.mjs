// GetFramerate: stock MainMenuBarPerformanceBarFrame_OnEnter formats it into the micro-menu
// tooltip (MAINMENUBAR_FPS_LABEL, MainMenuBar.lua:508). Unbound, it answered nil from the stub floor
// and hovering MainMenuMicroButton raised «bad argument #2 to 'format'» (w2 W-windows, rich route).

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

installFakeUiDocument();

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const decoder = new TextDecoder("utf-8");

function liveSeam(framerate) {
  return new LiveWorldSeam({
    world: () => undefined, store: () => undefined, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {}, ...(framerate ? { framerate } : {}),
  });
}

test("GetFramerate answers the live render loop's cadence and the canned HUD's own frames, never nil", () => {
  let fps = 59.7;
  assert.deepEqual(call(liveSeam(() => fps), "GetFramerate"), [59.7], "the renderer's RAF cadence, unrounded");
  fps = Number.NaN;
  assert.deepEqual(call(liveSeam(() => fps), "GetFramerate"), [0], "a non-number is 0, not NaN");
  assert.deepEqual(call(liveSeam(), "GetFramerate"), [0], "no measurement yet is 0");
  assert.deepEqual(call({}, "GetFramerate"), [0], "a seam without the method still answers a number");

  const canned = new CannedWorldSeam();
  assert.deepEqual(call(canned, "GetFramerate"), [0], "unattached: no frames yet");
  canned.attach({ fire: () => 1, now: () => 10 });
  canned.tick(10);
  assert.deepEqual(call(canned, "GetFramerate"), [0], "one frame is not a rate");
  for (let frame = 1; frame <= 90; frame++) canned.tick(10 + frame / 50);
  const [rate] = call(canned, "GetFramerate");
  assert.ok(Math.abs(rate - 50) < 1e-6, `50 frames a second of ticks → ${rate}`);
  canned.attach({ fire: () => 1, now: () => 20 });
  assert.deepEqual(call(canned, "GetFramerate"), [0], "a new load starts a new clock");
  canned.detach();
});

let chain;
after(() => chain?.close?.());

test("hovering MainMenuMicroButton prints the rate in the stock tooltip with no Lua error", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  chain = await clientArchives(clientDirectory);
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1024, height: 768 }),
  });
  await boot.load();
  try {
    for (let frame = 1; frame <= 60; frame++) seam.tick(1000 + frame / 40);
    const errors = boot.errorCount;
    const fn = boot.vm.compileFunction(`
      MainMenuBarPerformanceBarFrame_OnEnter(MainMenuMicroButton)
      local lines = {}
      for index = 1, GameTooltip:NumLines() do
        local text = _G["GameTooltipTextLeft" .. index]:GetText()
        if text then lines[#lines + 1] = text end
      end
      GameTooltip:Hide()
      return table.concat(lines, "\\n")`, "@framerate-test", []);
    const [text] = boot.vm.call(fn, [], 1);
    boot.vm.release(fn);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(errors).map((e) => e.message)));
    assert.match(text, /Частота смены кадров: 40 кадров в сек\./, text);
  } finally {
    boot.close();
  }
});
