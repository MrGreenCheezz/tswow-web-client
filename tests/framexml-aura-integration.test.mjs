import assert from "node:assert/strict";
import test from "node:test";

// This test deliberately runs the stock BuffFrame.xml/Lua pair.  The seam tests prove the C-side
// tuple on its own; this test proves that the real Blizzard Lua creates, updates, anchors and clicks
// the dynamic aura buttons through the bridge.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const {
  CannedWorldSeam,
  CANNED_AURA_FIXTURES,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const decoder = new TextDecoder("utf-8");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

function installClock(seconds) {
  const original = Date.now;
  let now = seconds;
  Date.now = () => Math.round(now * 1000);
  return {
    get now() { return now; },
    set now(value) { now = value; },
    restore() { Date.now = original; },
  };
}

async function loadCandidate(chain, clock) {
  const requests = [];
  const provider = {
    async read(path) {
      requests.push(normalized(path));
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider,
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory, requests: new Set(requests), clock };
}

function frame(boot, name) {
  const result = boot.bridge.getFrame(name);
  assert.ok(result, `${name} exists`);
  return result;
}

function point(frameValue, index = 0) {
  const result = frameValue.points[index];
  assert.ok(result, `${frameValue.name} has anchor ${index + 1}`);
  return result;
}

/**
 * Keep the CannedWorldSeam's real initial fixture, while making later UNIT_AURA edges explicit and
 * deterministic for this integration test.  The production seam owns the live mutation path; this
 * small test-only overlay lets the stock Lua update/remove path be checked without adding a second
 * production fixture API merely for a test.
 */
function installAuraTimeline(seam) {
  const canned = seam.unitAura.bind(seam);
  let state = "both";
  seam.unitAura = (unit, index, filter) => {
    if (state === "none") return undefined;
    const value = canned(unit, index, filter);
    if (!value) return value;
    if (state === "updated" && filter === "HELPFUL") {
      return [value[0], value[1], value[2], 5, value[4], value[5], value[6], value[7], value[8], value[9], value[10]];
    }
    if (state === "helpful-only" && filter === "HARMFUL") return undefined;
    return value;
  };
  return {
    update() { state = "updated"; },
    remove() { state = "none"; },
    helpfulOnly() { state = "helpful-only"; },
  };
}

test("MPQ BuffFrame drives filtered aura buttons, duration, updates, removal and right-click cancel", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const clock = installClock(1000);
  let candidate;
  try {
    candidate = await loadCandidate(chain, clock);

    assert.ok(candidate.requests.has("interface/framexml/buffframe.xml"),
      "BuffFrame.xml was read from MPQ");
    assert.ok(candidate.requests.has("interface/framexml/buffframe.lua"),
      "BuffFrame.lua was read through the XML Script relation");
    assert.equal(candidate.inventory.files.missing.length, 0,
      "the promoted vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "BuffFrame.xml parses successfully");
    assert.equal(candidate.inventory.lua.failed, 0,
      "BuffFrame.lua executes successfully");
    assert.ok(candidate.inventory.api.some((entry) => entry.name === "UnitAura" && entry.calls > 0),
      "stock aura code reaches UnitAura");

    const buffFrame = frame(candidate.boot, "BuffFrame");
    const consolidated = frame(candidate.boot, "ConsolidatedBuffs");
    const buff = frame(candidate.boot, "BuffButton1");
    const debuff = frame(candidate.boot, "DebuffButton1");
    const buffIcon = frame(candidate.boot, "BuffButton1Icon");
    const debuffIcon = frame(candidate.boot, "DebuffButton1Icon");
    const buffCount = frame(candidate.boot, "BuffButton1Count");
    const buffDuration = frame(candidate.boot, "BuffButton1Duration");
    const debuffCount = frame(candidate.boot, "DebuffButton1Count");

    assert.equal(buffFrame.visible, true, "BuffFrame is live");
    assert.equal(buffFrame.parent?.name, "UIParent", "player auras remain owned by the screen root");
    assert.notEqual(buffFrame.parent?.name, "TargetFrame", "player auras never follow the target frame");
    assert.equal(point(buffFrame).point, "TOPRIGHT");
    assert.equal(point(buffFrame).relativeTo?.name, "ConsolidatedBuffs");
    assert.equal(point(buffFrame).x, 0);
    assert.equal(point(buffFrame).y, 0);
    assert.equal(consolidated.parent?.name, "UIParent", "the anchor sentinel stays in the upper-right root");
    assert.equal(buff.visible, true, "HELPFUL index 1 creates BuffButton1");
    assert.equal(debuff.visible, true, "HARMFUL index 1 creates DebuffButton1");
    assert.equal(buffIcon.texture, CANNED_AURA_FIXTURES.helpful.texture);
    assert.equal(debuffIcon.texture, CANNED_AURA_FIXTURES.harmful.texture);
    assert.equal(buffCount.text, String(CANNED_AURA_FIXTURES.helpful.count),
      "helpful applications are rendered by the stock count child");
    assert.equal(debuffCount.visible, false,
      "a single harmful application is hidden by AuraButton_Update");
    assert.equal(buff.points.length, 1, "stock anchor pass leaves one effective helpful anchor");
    assert.equal(point(buff).point, "TOPRIGHT");
    assert.equal(point(buff).relativeTo?.name, "BuffFrame");
    assert.equal(point(buff).x, 0);
    assert.equal(point(buff).y, 0);
    assert.equal(point(debuff).point, "TOPRIGHT",
      "the first harmful aura uses the stock debuff anchor branch");
    assert.equal(point(debuff).relativeTo?.name, "ConsolidatedBuffs");

    // The real AuraButton_OnUpdate path consumes elapsed seconds.  With SHOW_BUFF_DURATIONS set,
    // its child is visible and receives the absolute GetTime-based deadline from UnitAura.
    candidate.boot.vm.setGlobal("SHOW_BUFF_DURATIONS", "1");
    candidate.boot.bridge.dispatchEvent(FRAMEXML_SEAM_EVENTS.aura, "player");
    candidate.boot.bridge.tick(0.5);
    assert.equal(buffDuration.visible, true, "duration child is shown when durations are enabled");
    assert.notEqual(buffDuration.text, "", "duration child is formatted by stock Lua");

    // RightButtonUp is the template's only registration.  The helpful button invokes exactly one
    // CancelUnitBuff with filtered index 1; the harmful button reaches the same Lua click handler,
    // but the seam deliberately refuses to cancel harmful auras.
    assert.equal(candidate.boot.bridge.Click(buff, "RightButton"), true);
    assert.deepEqual(candidate.seam.cancelledAuraSpellIds, [CANNED_AURA_FIXTURES.helpful.spellId]);
    assert.equal(candidate.boot.bridge.Click(debuff, "RightButton"), true);
    assert.deepEqual(candidate.seam.cancelledAuraSpellIds, [CANNED_AURA_FIXTURES.helpful.spellId],
      "right-clicking a harmful aura never cancels it");

    const overlay = installAuraTimeline(candidate.seam);
    const errorsBeforeTransitions = candidate.boot.vm.errors.length;
    overlay.update();
    assert.ok(candidate.boot.bridge.dispatchEvent(FRAMEXML_SEAM_EVENTS.aura, "player") >= 1,
      "UNIT_AURA reaches the registered stock frames");
    assert.equal(buffCount.text, "5", "UNIT_AURA update refreshes applications");
    assert.equal(buff.visible, true);
    assert.equal(debuff.visible, true);

    // Repeating the same event is allowed by stock UNIT_AURA semantics, but it must not produce
    // errors or duplicate dynamic buttons.  The bridge keeps the same named frames.
    const sameBuff = frame(candidate.boot, "BuffButton1");
    candidate.boot.bridge.dispatchEvent(FRAMEXML_SEAM_EVENTS.aura, "player");
    assert.equal(frame(candidate.boot, "BuffButton1"), sameBuff);

    overlay.remove();
    assert.ok(candidate.boot.bridge.dispatchEvent(FRAMEXML_SEAM_EVENTS.aura, "player") >= 1);
    assert.equal(buff.visible, false, "stock AuraButton_Update hides a removed helpful aura");
    assert.equal(debuff.visible, false, "stock AuraButton_Update hides a removed harmful aura");
    assert.equal(candidate.boot.vm.errors.length, errorsBeforeTransitions,
      "UNIT_AURA updates/removal and right-click path add no Lua errors");

    // A seam tick with no new aura state does not invent another C-side event; the existing bridge
    // OnUpdate still runs safely over the hidden buttons.
    candidate.boot.tickSeam(clock.now);
    candidate.boot.bridge.tick(0.1);
    assert.equal(candidate.boot.vm.errors.length, errorsBeforeTransitions,
      "unchanged tick remains error-free");
  } finally {
    candidate?.boot.close();
    clock.restore();
    chain.close();
  }
});
