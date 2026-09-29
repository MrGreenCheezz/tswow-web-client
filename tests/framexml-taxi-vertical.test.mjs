import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: stock TaxiFrame as the flight map over the canned Stormwind flight master — the real
// TaxiFrame.lua builds its node buttons, places them on TAXIMAP0 and lays out the route lines from
// FrameXmlTaxi.ts's answers (the DOM draws them once it takes the 8-argument SetTexCoord that
// rotates UI-Taxi-Line — not yet: shown and placed, but painted nothing); TakeTaxiNode sends the
// planned hops.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { frameXmlTaxiGate, installFrameXmlTaxiMap } = await import("../dist/code/browser/framexml/FrameXmlTaxiOwner.js");
const { createFrameXmlNpcWindows } = await import("../dist/code/browser/framexml/FrameXmlGossipNpcWindows.js");
const { FRAMEXML_CANNED_TAXI_MASTER } = await import("../dist/code/browser/framexml/FrameXmlTaxiCanned.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlTaxiController.js");
const decoder = new TextDecoder("utf-8");

async function load(seam = new CannedWorldSeam()) {
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "taxi-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
  };
}

const newErrors = (boot, from) => JSON.stringify(boot.errors.slice(from).map((e) => `${e.file}:${e.line} ${e.message}`));

test("the gate needs SetTaxiMap: without the host's widget binding the map has no picture", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const errors = boot.errorCount;
    assert.equal(frameXmlTaxiGate(seam, boot, renderer()), undefined, "the stub-plan SetTaxiMap leaves TaxiMap blank");
    installFrameXmlTaxiMap(boot, seam.taxi);
    const result = frameXmlTaxiGate(seam, boot, renderer());
    assert.deepEqual([result?.nodes, result?.lines], [7, 2], "seven discovered nodes; Thelsamar's two hops drawn");
    assert.equal(boot.bridge.getFrame("TaxiFrame").visible, false);
    assert.deepEqual(seam.npc.taxi.world.calls, []);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    boot.close();
  }
});

test("the flight map: TAXIMAP0, the buttons where the nodes are, the route laid out on hover, the flight on click", withClient, async () => {
  const { boot, seam } = await load();
  const windows = createFrameXmlNpcWindows(seam, boot, renderer(), {});
  const release = windows.publish();
  try {
    assert.equal(windows.gates.taxi, true);
    const world = seam.npc.taxi.world;
    const errors = boot.errorCount;
    world.open();
    assert.deepEqual(lua(boot, "return TaxiFrame:IsShown() and 1 or 0, TaxiMerchant:GetText(), TaxiMap:GetTexture()", 3),
      [1, "Распорядитель полетов", "Interface\\TaxiFrame\\TAXIMAP0"]);
    assert.deepEqual(lua(boot, "return UnitExists('npc') and 1 or 0, TaxiPortrait:GetTexture()", 2),
      [1, "Interface\\CharacterFrame\\TempPortrait"], "the portrait ring holds the client's unknown-portrait art, not nothing");
    const buttons = lua(boot, `local r = {}
      for index = 1, NumTaxiNodes() do
        local b = _G["TaxiButton" .. index]
        if b:IsShown() then
          local point, relative, relativePoint, x, y = b:GetPoint(1)
          r[#r + 1] = TaxiNodeName(index) .. "|" .. TaxiNodeGetType(index) .. "|" .. relativePoint .. "|" .. math.floor(x + 0.5) .. "," .. math.floor(y + 0.5)
        end
      end
      return table.concat(r, "\\n")`)[0].split("\n");
    // u*316, v*352 up from TaxiMap's bottom-left, through EK's flight-map square (WorldMapContinent
    // TaxiMin -16530, TaxiMax 12270 on both axes); Stormwind: u = (12270 - 489.70) / 28800 = 0.4090
    // → 129.3, v = (-8840.56 + 16530) / 28800 = 0.2670 → 94.0 (measured values; TaxiFrame_OnEvent
    // nudges nodes closer than 8 px apart, e.g. Sentinel Hill/Darkshire). The 1.5:1 WorldMapArea the
    // first version used put Stormwind at 137,92 and Ironforge at 150,145.
    assert.deepEqual(buttons, [
      "Штормград, Элвин|CURRENT|BOTTOMLEFT|129,94",
      "Сторожевой холм, Западный Край|REACHABLE|BOTTOMLEFT|123,72",
      "Приозерье, Красногорье|REACHABLE|BOTTOMLEFT|159,87",
      "Стальгорн, Дун Морог|REACHABLE|BOTTOMLEFT|147,143",
      "Гавань Менетилов, Болотина|REACHABLE|BOTTOMLEFT|143,156",
      "Телcамар, озеро Лок Модан|REACHABLE|BOTTOMLEFT|167,136",
      "Темнолесье, Сумеречный лес|REACHABLE|BOTTOMLEFT|148,74",
    ]);
    // The two hop lines are shown and placed by DrawRouteLine; they are *drawn* only once the DOM
    // renderer takes its 8-argument SetTexCoord (rotated UI-Taxi-Line), which is the renderer's.
    lua(boot, "TaxiNodeOnButtonEnter(TaxiButton6)", 0);
    assert.deepEqual(lua(boot, `local shown = 0 for i = 1, NUM_TAXI_ROUTES do if _G["TaxiRoute" .. i]:IsShown() then shown = shown + 1 end end
      return shown, GameTooltipTextLeft1:GetText()`, 2), [2, "Телcамар, озеро Лок Модан"]);
    lua(boot, "GameTooltip:Hide()", 0);
    boot.bridge.Click(boot.bridge.getFrame("TaxiButton6"));
    assert.deepEqual(world.calls, [{ kind: "take", guid: FRAMEXML_CANNED_TAXI_MASTER, nodes: [2, 6, 8] }]);
    world.reply(0);
    assert.deepEqual(lua(boot, "return TaxiFrame:IsShown() and 1 or 0"), [0], "the flight left: TAXIMAP_CLOSED");
    world.open();
    assert.equal(controller.frameXmlTaxiOpen(), true);
    boot.bridge.Click(boot.bridge.getFrame("TaxiCloseButton"));
    assert.deepEqual(world.calls.at(-1), { kind: "close" }, "OnHide's CloseTaxiMap forgets the menu");
    // Another NPC clicked: WorldClient.closeNpcServices forgets the map without an event.
    world.open();
    world.taxiMenu = undefined;
    assert.equal(controller.notifyFrameXmlTaxi(), true);
    assert.deepEqual(lua(boot, "return TaxiFrame:IsShown() and 1 or 0"), [0]);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
  assert.equal(controller.frameXmlTaxiPublished(), false);
});
