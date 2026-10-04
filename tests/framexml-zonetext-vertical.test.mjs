import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock FadingFrame.xml and ZoneText.xml (stock TOC lines 50-51) in the production
// vertical over the canned seam — the real 3.3.5 zone and sub-zone banners (ZoneTextFrame,
// SubZoneTextFrame) driven by ZONE_CHANGED/ZONE_CHANGED_NEW_AREA and GetZoneText/GetSubZoneText/
// GetZonePVPInfo, fading by FadingFrame_OnUpdate over GetTime. AutoFollowStatus, the third root of
// ZoneText.xml, loads too; its AUTOFOLLOW_BEGIN/END producer is plan item 5.18 (FollowUnit), not here.
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

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam, CANNED_MINIMAP_ZONE } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ZONE_TEXT_TOC = new Set(["fadingframe.xml", "zonetext.xml"]);

async function load(subset) {
  const seam = new CannedWorldSeam();
  const requests = new Set();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.add(normalize(path));
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset, seam, exercise: true,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => ({ width: 1365, height: 768 }),
    // suite-fix: since L5 3.27 GetTime reads FrameXmlClock (the page's monotonic clock), not Date.now;
    // this hands it Date.now again so withClock below drives it.
    clock: () => Date.now(),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory, requests };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "zonetext-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** A string's colour, rounded to two places: the stock values are two-place literals. */
function color(boot, fontString) {
  return lua(boot, `return ${fontString}:GetTextColor()`, 3).map((channel) => Math.round(channel * 100) / 100);
}

/** GetTime is `Date.now() / 1000` (the boot's `clock` option above, suite-fix); the banner's fade is driven by moving that clock. */
function withClock(run) {
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  try {
    return run((ms) => { clock += ms; });
  } finally {
    Date.now = realNow;
  }
}

test("FadingFrame.xml and ZoneText.xml sit at their stock slots; the closure adds four files and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  assert.deepEqual(toc.slice(toc.indexOf("stacksplitframe.xml"), toc.indexOf("stacksplitframe.xml") + 4),
    ["stacksplitframe.xml", "fadingframe.xml", "zonetext.xml", "battlefieldframe.xml"], "stock TOC lines 49-52");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.deepEqual(vertical.slice(vertical.indexOf("stacksplitframe.xml"), vertical.indexOf("stacksplitframe.xml") + 4),
    ["stacksplitframe.xml", "fadingframe.xml", "zonetext.xml", "battlefieldframe.xml"], "the vertical keeps them in that order");
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => !ZONE_TEXT_TOC.has(normalize(entry))));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    assert.equal(baseline.boot.bridge.getFrame("ZoneTextFrame")?.name, undefined);
    for (const file of ["fadingframe.lua", "zonetext.lua"]) {
      assert.ok(candidate.requests.has(`interface/framexml/${file}`), `${file} is reached through its XML`);
    }
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    // 9,663 bytes of XML and Lua plus the synthetic TOC's two lines; three roots and five font strings.
    assert.deepEqual(delta, { files: 4, bytes: 9_692, widgets: 8, errors: 0, distinct: 0, luaFailed: 0 },
      `zone text closure delta ${JSON.stringify(delta)}`);
    const errorKey = (error) => `${error.file}:${error.line}:${error.message}`;
    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    assert.deepEqual(candidate.inventory.errors.filter((error) => !baselineErrors.has(errorKey(error))).map(errorKey), [],
      "no candidate-specific Lua error");
    const { boot } = candidate;
    for (const name of ["ZoneTextFrame", "SubZoneTextFrame", "AutoFollowStatus"]) {
      assert.equal(boot.bridge.getFrame(name)?.type, "Frame", `${name} is a stock root`);
    }
    assert.deepEqual(lua(boot, "return ZoneTextFrame:GetParent():GetName(), ZoneTextFrame:GetFrameStrata(), AutoFollowStatus:IsShown()", 3),
      ["UIParent", "LOW", false]);
    assert.deepEqual(lua(boot, "return ZoneTextFrame.fadeInTime, ZoneTextFrame.holdTime, ZoneTextFrame.fadeOutTime", 3), [0.5, 1, 2],
      "ZoneText_OnLoad reached FadingFrame.lua's setters");
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("ZONE_CHANGED_NEW_AREA shows the zone and sub-zone banners in the zone's PvP colour, and they fade over 0.5 + 1 + 2 s", withClient, async () => {
  const { boot } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const errors = boot.errorCount;
    withClock((advance) => {
      boot.pump.fire("ZONE_CHANGED_NEW_AREA");
      assert.deepEqual(lua(boot, "return ZoneTextString:GetText(), SubZoneTextString:GetText(), ZoneTextFrame:IsShown(), SubZoneTextFrame:IsShown()", 4),
        [CANNED_MINIMAP_ZONE.zoneText, CANNED_MINIMAP_ZONE.subZoneText, true, true]);
      // The canned zone is friendly territory: green, and «(Под контролем …)» under the name.
      assert.deepEqual(color(boot, "ZoneTextString"), [0.1, 1, 0.1]);
      assert.deepEqual(color(boot, "SubZoneTextString"), [0.1, 1, 0.1]);
      assert.equal(lua(boot, "return PVPInfoTextString:GetText()")[0],
        lua(boot, `return format(FACTION_CONTROLLED_TERRITORY, "${CANNED_MINIMAP_ZONE.factionName}")`)[0]);

      advance(250);
      boot.bridge.tick(0.25);
      assert.ok(Math.abs(lua(boot, "return ZoneTextFrame:GetAlpha()")[0] - 0.5) < 0.01, "halfway through the 0.5 s fade-in");
      advance(750);
      boot.bridge.tick(0.75);
      assert.equal(lua(boot, "return ZoneTextFrame:GetAlpha()")[0], 1, "held");
      advance(1500);
      boot.bridge.tick(1.5);
      assert.ok(Math.abs(lua(boot, "return ZoneTextFrame:GetAlpha()")[0] - 0.5) < 0.01, "halfway through the 2 s fade-out");
      advance(1100);
      boot.bridge.tick(1.1);
      assert.deepEqual(lua(boot, "return ZoneTextFrame:IsShown(), SubZoneTextFrame:IsShown()", 2), [false, false],
        "gone after 3.5 s");
    });
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});

test("sanctuary and hostile territory colour the banner; a new sub-zone of the same zone shows only the sub-zone banner", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const errors = boot.errorCount;
    // The canned zone's tuple is a constant; these instance overrides stand in for another area.
    seam.zoneText = () => "Даларан";
    seam.subZoneText = () => "Площадь Руннинг";
    seam.zonePvpInfo = () => ["sanctuary", false, undefined];
    boot.pump.fire("ZONE_CHANGED_NEW_AREA");
    assert.deepEqual(lua(boot, "return ZoneTextString:GetText(), PVPInfoTextString:GetText() == SANCTUARY_TERRITORY", 2), ["Даларан", true]);
    assert.deepEqual(color(boot, "ZoneTextString"), [0.41, 0.8, 0.94]);
    assert.deepEqual(color(boot, "PVPInfoTextString"), [0.41, 0.8, 0.94]);

    seam.zoneText = () => "Дуротар";
    seam.subZoneText = () => "Оргриммар";
    seam.zonePvpInfo = () => ["hostile", false, "Орда"];
    boot.pump.fire("ZONE_CHANGED");
    assert.equal(lua(boot, "return ZoneTextString:GetText()")[0], "Дуротар", "a new zone name is a banner even on plain ZONE_CHANGED");
    assert.deepEqual(color(boot, "ZoneTextString"), [1, 0.1, 0.1]);
    assert.equal(lua(boot, "return PVPInfoTextString:GetText()")[0], lua(boot, 'return format(FACTION_CONTROLLED_TERRITORY, "Орда")')[0]);

    // Let both banners run out, then cross into another sub-zone of the same zone.
    lua(boot, "ZoneTextFrame:Hide() SubZoneTextFrame:Hide()", 0);
    seam.subZoneText = () => "Долина Испытаний";
    boot.pump.fire("ZONE_CHANGED");
    assert.deepEqual(lua(boot, "return ZoneTextFrame:IsShown(), SubZoneTextFrame:IsShown(), SubZoneTextString:GetText(), PVPInfoTextString:GetText()", 4),
      [false, true, "Долина Испытаний", ""], "the zone name stays down; the sub-zone rises alone, with no PvP line");
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});
