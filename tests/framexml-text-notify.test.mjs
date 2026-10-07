import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlDomRenderer } from "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js";
import { layoutDocument, layoutHost, snapshot } from "./fixtures/framexml-layout-document.mjs";

// P1-15a: a FontString's `SetText` is announced as paint, under `setTextLayoutPolicy("auto")`, only
// when nothing reads the string's box (`FrameXmlUiBridge.textOnlyPaints`); everything else stays
// layout, and `"always"` (the default) keeps every text a layout change.

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const FRAMES = `<Ui>
  <Frame name="Root" width="1000" height="800">
    <Anchors><Anchor point="TOPLEFT"/></Anchors>
    <Frames>
      <Button name="Buff" width="30" height="30">
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-10"/></Offset></Anchor></Anchors>
        <Layers><Layer level="OVERLAY">
          <FontString name="$parentDuration" text="6 s">
            <Anchors><Anchor point="TOP" relativePoint="BOTTOM"/></Anchors>
          </FontString>
        </Layer></Layers>
      </Button>
      <Frame name="Row" width="300" height="20">
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-100"/></Offset></Anchor></Anchors>
        <Layers><Layer level="ARTWORK">
          <FontString name="$parentLead" text="Lead">
            <Anchors><Anchor point="LEFT"/></Anchors>
          </FontString>
          <FontString name="$parentFixed" text="Fixed" width="80" height="14">
            <Anchors><Anchor point="RIGHT"/></Anchors>
          </FontString>
          <FontString name="$parentSibling" text="Sib">
            <Anchors><Anchor point="RIGHT" relativeTo="$parentBox" relativePoint="LEFT"/></Anchors>
          </FontString>
          <FontString name="$parentWrap" text="Wrap" width="120">
            <Anchors><Anchor point="BOTTOMLEFT"/></Anchors>
          </FontString>
        </Layer></Layers>
        <Frames>
          <Frame name="$parentTail" width="20" height="20">
            <Anchors><Anchor point="TOPRIGHT"/></Anchors>
          </Frame>
          <Frame name="$parentBox" width="20" height="20">
            <Anchors><Anchor point="CENTER"/></Anchors>
          </Frame>
          <Frame name="$parentAfterFixed" width="20" height="20">
            <Anchors><Anchor point="LEFT" relativeTo="$parentFixed" relativePoint="RIGHT"/></Anchors>
          </Frame>
        </Frames>
      </Frame>
      <ScrollFrame name="Scroll" width="200" height="100">
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-200"/></Offset></Anchor></Anchors>
        <ScrollChild>
          <Frame name="ScrollContent" width="200" height="300">
            <Layers><Layer level="ARTWORK">
              <FontString name="$parentText" text="Scrolled">
                <Anchors><Anchor point="TOPLEFT"/></Anchors>
              </FontString>
            </Layer></Layers>
          </Frame>
        </ScrollChild>
      </ScrollFrame>
      <GameTooltip name="Tip" hidden="false">
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="400" y="-10"/></Offset></Anchor></Anchors>
        <Layers><Layer level="ARTWORK">
          <FontString name="$parentLine" text="Tooltip line">
            <Anchors><Anchor point="TOPLEFT"/></Anchors>
          </FontString>
        </Layer></Layers>
      </GameTooltip>
      <Button name="Loose">
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-350"/></Offset></Anchor></Anchors>
        <Layers><Layer level="OVERLAY">
          <FontString name="$parentLabel" text="Loose">
            <Anchors><Anchor point="CENTER"/></Anchors>
          </FontString>
        </Layer></Layers>
      </Button>
      <Slider name="Volume" width="100" height="16">
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-400"/></Offset></Anchor></Anchors>
        <Layers><Layer level="ARTWORK">
          <FontString name="$parentLow" text="Low">
            <Anchors><Anchor point="TOPLEFT"/></Anchors>
          </FontString>
        </Layer></Layers>
      </Slider>
      <Frame name="Holder" width="200" height="40">
        <Anchors><Anchor point="TOPLEFT"><Offset><AbsDimension x="10" y="-450"/></Offset></Anchor></Anchors>
        <Layers><Layer level="ARTWORK">
          <FontString name="OptText" text="Option">
            <Anchors><Anchor point="TOPLEFT"/></Anchors>
          </FontString>
        </Layer></Layers>
        <Frames>
          <CheckButton name="Opt" width="20" height="20">
            <Anchors><Anchor point="BOTTOMLEFT"/></Anchors>
          </CheckButton>
        </Frames>
      </Frame>
    </Frames>
  </Frame></Ui>`;

async function setup(policy = "auto") {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Frames.xml",
    "interface/framexml/frames.xml": FRAMES,
  }) });
  await boot.load();
  const doc = layoutDocument();
  const host = layoutHost(doc, 1000, 800);
  const renderer = new FrameXmlDomRenderer(host, { bridge: boot.bridge });
  renderer.mount(boot.roots);
  if (policy) boot.bridge.setTextLayoutPolicy(policy);
  const kinds = [];
  boot.bridge.observeFrameMutations((frame, kind) => kinds.push([frame.name, kind]));
  const run = (source) => assert.equal(boot.vm.execute(source, "@notify").ok, true, source);
  /** The kind `SetText` announced for `name` when `source` runs. */
  const kindOf = (name, source) => {
    kinds.length = 0;
    run(source);
    const own = kinds.filter(([frame]) => frame === name).map(([, kind]) => kind);
    assert.equal(own.length, 1, `${source}: one notification for ${name} (${JSON.stringify(kinds)})`);
    return own[0];
  };
  const element = (name) => renderer.elementFor(boot.bridge.getFrame(name));
  return { boot, renderer, doc, host, run, kindOf, element, close() { renderer.destroy(); boot.close(); } };
}

test("a buff duration under a sized button is paint while its text stays non-empty, and is drawn", async () => {
  const fixture = await setup();
  try {
    const { kindOf, element } = fixture;
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("5 s")`), "paint");
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetFormattedText("%d s", 4)`), "paint");
    assert.equal(element("BuffDuration").textContent, "4 s", "a paint pass writes the string's text");
    // Empty <-> non-empty shows or hides what reads the text (a button's native name).
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("")`), "layout");
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("3 s")`), "layout");
    // A line break: the string's height is read from the page.
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("3|ns")`), "layout");
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("2 s")`), "layout", "the old text had the break");
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("1 s")`), "paint");
    // Empty as drawn (review): colour codes alone, blanks and back are a change of emptiness.
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("|cffff0000|r")`), "layout");
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("   ")`), "paint", "blank to blank");
    assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("0 s")`), "layout");
  } finally { fixture.close(); }
});

test("a string that an anchor names is layout from then on, unless its box is fixed", async () => {
  const fixture = await setup();
  try {
    const { kindOf, run } = fixture;
    assert.equal(kindOf("RowLead", `RowLead:SetText("Lead 2")`), "paint");
    // A neighbour measured against the string's RIGHT edge moves with its text.
    run(`RowTail:ClearAllPoints(); RowTail:SetPoint("LEFT", RowLead, "RIGHT", 4, 0)`);
    assert.equal(kindOf("RowLead", `RowLead:SetText("Lead 3")`), "layout");
    // Monotonic: moving the neighbour away does not clear the flag.
    run(`RowTail:ClearAllPoints(); RowTail:SetPoint("TOPRIGHT")`);
    assert.equal(kindOf("RowLead", `RowLead:SetText("Lead 4")`), "layout");
    // A declared size on both axes: the text does not move the box the neighbour is measured from.
    assert.equal(kindOf("RowFixed", `RowFixed:SetText("Fixed 2")`), "paint");
  } finally { fixture.close(); }
});

test("a sizeless string placed on a sibling and a wrapping string stay layout", async () => {
  const fixture = await setup();
  try {
    const { kindOf } = fixture;
    // RIGHT on a sibling's LEFT is «edge − own width», measured.
    assert.equal(kindOf("RowSibling", `RowSibling:SetText("Sibling")`), "layout");
    // A declared width with no height wraps: `GetHeight` is the page's.
    assert.equal(kindOf("RowWrap", `RowWrap:SetText("Wrapped")`), "layout");
  } finally { fixture.close(); }
});

test("a string in a ScrollFrame, a tooltip, a sizeless button, a slider or beside its control stays layout", async () => {
  const fixture = await setup();
  try {
    const { kindOf } = fixture;
    assert.equal(kindOf("ScrollContentText", `ScrollContentText:SetText("Scrolled 2")`), "layout");
    assert.equal(kindOf("TipLine", `TipLine:SetText("Tooltip line 2")`), "layout");
    assert.equal(kindOf("LooseLabel", `LooseLabel:SetText("Loose 2")`), "layout");
    assert.equal(kindOf("VolumeLow", `VolumeLow:SetText("Quiet")`), "layout");
    assert.equal(kindOf("OptText", `OptText:SetText("Option 2")`), "layout");
  } finally { fixture.close(); }
});

test("with the policy at always (the default) every text is layout", async () => {
  for (const policy of ["always", null]) {
    const fixture = await setup(policy);
    try {
      const { kindOf, boot } = fixture;
      assert.equal(boot.bridge.textLayoutPolicy, "always");
      assert.equal(kindOf("BuffDuration", `BuffDuration:SetText("5 s")`), "layout");
      assert.equal(kindOf("RowLead", `RowLead:SetText("Lead 2")`), "layout");
      assert.equal(kindOf("RowFixed", `RowFixed:SetText("Fixed 2")`), "layout");
    } finally { fixture.close(); }
  }
});

test("buttons and other widget types keep their text a layout change", async () => {
  const fixture = await setup();
  try {
    const { kindOf } = fixture;
    assert.equal(kindOf("Buff", `Buff:SetText("Buff")`), "layout");
  } finally { fixture.close(); }
});

test("the fixture draws the same page, aria-labels included, with the policy at auto as at always", async () => {
  // Every case above, as a page: what `"auto"` leaves to a paint pass must come out where a layout
  // pass would have put it — the neighbour measured from a string's edge, a control's caption.
  const script = [
    `BuffDuration:SetText("5 s")`, `BuffDuration:SetText("")`, `BuffDuration:SetText("45 s")`,
    `RowTail:ClearAllPoints(); RowTail:SetPoint("LEFT", RowLead, "RIGHT", 4, 0)`,
    `RowLead:SetText("A much longer lead")`, `RowFixed:SetText("Fixed, longer")`,
    `RowSibling:SetText("A longer sibling")`, `RowWrap:SetText("A wrapped string that is far wider than its box")`,
    `ScrollContentText:SetText("Scrolled further")`, `TipLine:SetText("A longer tooltip line")`,
    `LooseLabel:SetText("A longer loose label")`, `VolumeLow:SetText("Very quiet")`,
    `OptText:SetText("Another option")`,
  ];
  const pages = {};
  for (const policy of ["always", "auto"]) {
    const fixture = await setup(policy);
    try {
      for (const source of script) fixture.run(source);
      pages[policy] = snapshot(fixture.host).map(instanceFree);
      assert.ok(fixture.element("Opt").getAttribute("aria-label")?.includes("Another option"),
        `${policy}: the checkbox is named after its caption`);
    } finally { fixture.close(); }
  }
  assert.deepEqual(pages.auto, pages.always);
});

/** A renderer numbers the SVG filters it defines per instance (`#framexml-tint-7-ffd100`). */
function instanceFree(line) {
  return line.replace(/(#framexml-[a-z]+)-\d+-/g, "$1-N-");
}

async function verticalBoot(chain, clock, seam) {
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const decoder = new TextDecoder("utf-8");
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, exercise: false,
    ...(seam ? { seam } : {}),
    ...(clock ? { clock } : {}),
    screen: () => ({ width: 1365, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, inventory };
}

function fontStringTargets(bridge) {
  const missing = [];
  let checked = 0;
  for (const frame of bridge.frames) {
    for (const point of frame.points) {
      const target = point.relativeTo;
      if (!target || target.type !== "FontString") continue;
      checked += 1;
      if (!target.anchorTarget) missing.push(`${frame.name} -> ${target.name}`);
    }
  }
  return { checked, missing };
}

test("every FontString an anchor of the MPQ vertical names is flagged anchorTarget", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let boot;
  try {
    ({ boot } = await verticalBoot(chain));
    const { checked, missing } = fontStringTargets(boot.bridge);
    assert.ok(checked > 0, "the vertical anchors frames on strings");
    assert.deepEqual(missing, []);
    console.log(`anchors on FontStrings in the vertical: ${checked}`);
  } finally {
    boot?.close();
  }
});

/**
 * The census scene of P1-15 step 0 on a manual clock, so two runs see the same `GetTime`: the stock
 * vertical over `CannedWorldSeam`, buffs with their durations shown, 40 health/power/aura events of
 * five units over 600 frame steps. Answers the DOM snapshots taken every 60 steps.
 */
async function censusScene(chain, policy) {
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_POWER_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  class PulsingSeam extends CannedWorldSeam {
    pulse = 0;
    unitHealth(unit) { const base = super.unitHealth(unit); return base > 0 ? Math.max(1, base - (this.pulse % 97)) : base; }
    unitPower(unit) { const base = super.unitPower(unit); return base > 0 ? Math.max(0, base - (this.pulse % 13)) : base; }
  }
  let milliseconds = 5_000_000;
  const seam = new PulsingSeam();
  const { boot, inventory } = await verticalBoot(chain, () => milliseconds, seam);
  const doc = layoutDocument();
  const host = layoutHost(doc, 1365, 768);
  const passes = { layout: 0, paint: 0 };
  let counting = false;
  const renderer = new FrameXmlDomRenderer(host, {
    bridge: boot.bridge, textureResolver: (path) => `tex:${path}`,
    perf: { sync: (kind) => { if (counting) passes[kind] = (passes[kind] ?? 0) + 1; } },
  });
  try {
    renderer.mount(boot.roots);
    boot.bridge.setPaintDeferral(true);
    boot.bridge.setLayoutDeferral(true);
    boot.bridge.setTextLayoutPolicy(policy);
    boot.vm.execute(`SHOW_BUFF_DURATIONS = "1"`, "@durations");
    const units = ["player", "pet", "party1", "party2", "party3"];
    const powerEvent = (unit) => FRAMEXML_POWER_EVENTS[seam.unitPowerType(unit)?.[0] ?? 0] ?? "UNIT_MANA";
    const step = () => {
      milliseconds += 17;
      const now = boot.pump.now();
      boot.bridge.runInMutationBatch(() => { seam.tick(now); boot.bridge.tick(0.017); });
      boot.bridge.flushDeferredPaint();
      renderer.tickCooldowns?.(now);
      renderer.tickMessageFades?.();
    };
    for (let i = 0; i < 30; i++) step();
    counting = true;
    const snapshots = [];
    let events = 0;
    for (let tick = 0; tick < 600; tick++) {
      if (tick % 15 === 0) {
        seam.pulse += 1;
        const unit = units[events % units.length];
        const which = events % 3;
        if (which === 0) boot.pump.fire("UNIT_HEALTH", unit);
        else if (which === 1) boot.pump.fire(powerEvent(unit), unit);
        else boot.pump.fire("UNIT_AURA", unit);
        events += 1;
      }
      step();
      if (tick % 60 === 59) snapshots.push(snapshot(host).map(instanceFree));
    }
    counting = false;
    const targets = fontStringTargets(boot.bridge);
    return { snapshots, passes, errors: boot.errors.length, failed: inventory.lua.failed, targets,
      durationText: boot.bridge.getFrame("BuffButton1Duration")?.text ?? "" };
  } finally {
    renderer.destroy();
    boot.close();
  }
}

test("the census scene draws the same page with the policy at auto as at always", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  // The process-wide chain (`clientArchives`): it is not closed here, the other tests share it.
  const chain = await clientArchives(clientDirectory);
  const always = await censusScene(chain, "always");
  const auto = await censusScene(chain, "auto");
  assert.equal(always.failed, 0);
  assert.equal(auto.errors, always.errors, "no new Lua errors");
  assert.ok(always.durationText, "the scene shows a buff duration");
  assert.equal(auto.durationText, always.durationText);
  assert.deepEqual(auto.targets.missing, [], "anchors written while the scene ran are flagged too");
  assert.equal(auto.snapshots.length, always.snapshots.length);
  for (let index = 0; index < always.snapshots.length; index++) {
    const left = always.snapshots[index];
    const right = auto.snapshots[index];
    const differing = [];
    for (let line = 0; line < Math.max(left.length, right.length) && differing.length < 8; line++) {
      if (left[line] !== right[line]) differing.push(`always ${left[line]}\nauto   ${right[line]}`);
    }
    assert.deepEqual(differing, [], `snapshot ${index}: ${left.length} vs ${right.length} elements`);
  }
  // The point of it: the buff timers and the unit texts no longer cost a layout pass each.
  assert.ok(auto.passes.layout < always.passes.layout,
    `layout passes: auto ${auto.passes.layout}, always ${always.passes.layout}`);
  console.log(`layout passes always ${always.passes.layout} -> auto ${auto.passes.layout}; `
    + `paint ${always.passes.paint} -> ${auto.passes.paint}`);
});
