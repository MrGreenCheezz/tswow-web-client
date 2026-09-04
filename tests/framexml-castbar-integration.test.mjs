import assert from "node:assert/strict";
import test from "node:test";

// This test deliberately goes through the real client files. A hand-written frame with these
// names would miss the important part of this slice: CastingBarFrame.lua owns the event state
// machine and CastingBarFrame.xml owns the StatusBar/template wiring.
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

const CASTING_BAR_XML = "interface/framexml/castingbarframe.xml";
const CASTING_BAR_LUA = "interface/framexml/castingbarframe.lua";

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

/**
 * FrameXmlBoot's public pump uses Date.now for GetTime and for the seam attach anchor. Keep that
 * clock under this test's control so all Lua calculations are exact and no wall-clock sleep is
 * needed. The seam itself is advanced through its public `boot.tickSeam(now)` entry point.
 */
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
      return data ? new TextDecoder("utf-8").decode(data) : undefined;
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

test("MPQ CastingBarFrame runs the real cast/channel timeline", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const clock = installClock(1000);
  let candidate;
  try {
    candidate = await loadCandidate(chain, clock);

    assert.ok(candidate.requests.has(CASTING_BAR_XML), "CastingBarFrame.xml was read from MPQ");
    assert.ok(candidate.requests.has(CASTING_BAR_LUA), "CastingBarFrame.lua was read from MPQ");
    assert.equal(candidate.inventory.files.missing.length, 0, "vertical subset has no missing files");
    assert.equal(candidate.inventory.lua.failed, 0, "CastingBarFrame.lua executes successfully");
    const luaErrorsBeforeTimeline = candidate.boot.vm.errors.length;

    const castbar = frame(candidate.boot, "CastingBarFrame");
    assert.equal(castbar.type, "StatusBar");
    const status = castbar.statusBar;
    const text = () => frame(candidate.boot, "CastingBarFrameText");
    const icon = () => frame(candidate.boot, "CastingBarFrameIcon");
    const flash = () => frame(candidate.boot, "CastingBarFrameFlash");

    // The first rendered tick is the canned timeline origin. It reaches the real START handler,
    // not a test double, and therefore proves the localized text/icon plus the StatusBar methods.
    candidate.boot.tickSeam(candidate.boot.pump.now());
    assert.equal(castbar.visible, true, "START shows the cast bar");
    assert.equal(text().text, "Огненный шар");
    assert.equal(icon().texture, "Interface\\Icons\\Spell_Fire_FlameBolt");
    assert.deepEqual(status.color, { r: 1, g: 0.7, b: 0, a: 1 }, "ordinary cast is orange");
    assert.equal(status.min, 0);
    assert.equal(status.max, 1.5);
    assert.equal(status.value, 0);

    // The canned delayed event extends the real UnitCastingInfo end time by 250 ms. The Blizzard
    // handler intentionally updates maxValue here; SetValue is only done by its OnUpdate path.
    clock.now = 1000.5;
    candidate.boot.tickSeam(clock.now);
    assert.equal(status.max, 1.75, "DELAYED applies the pushback to max");

    // Stop the ordinary cast before the canned timeline enters its channel phase. The fourth
    // argument is castID, matching select(4, ...) in the real Lua handler. This isolates the
    // ordinary STOP assertion while leaving the same seam instance ready for channel START.
    clock.now = 1000.75;
    candidate.boot.pump.fire(
      "UNIT_SPELLCAST_STOP", "player", "Огненный шар", "Уровень 1", 42,
    );
    assert.deepEqual(status.color, { r: 0, g: 1, b: 0, a: 1 }, "ordinary STOP turns the bar green");
    assert.equal(status.value, 1.75, "ordinary STOP fills the bar before fade");
    assert.equal(flash().visible, true, "ordinary STOP starts the flash/fade sequence");
    assert.equal(castbar.visible, true, "ordinary STOP fades after the event, not before it");

    // At the exact delayed cast end the canned seam publishes STOP followed by CHANNEL_START.
    // The former is ignored by Lua because the manual STOP already cleared `self.casting`; the
    // latter enters the real channel branch with the second spell's text/icon and a green bar.
    clock.now = 1001.75;
    candidate.boot.tickSeam(clock.now);
    assert.equal(castbar.visible, true, "CHANNEL_START keeps the bar visible");
    assert.equal(text().text, "Похищение жизни");
    assert.equal(icon().texture, "Interface\\Icons\\Spell_Shadow_LifeDrain02");
    assert.deepEqual(status.color, { r: 0, g: 1, b: 0, a: 1 }, "channel is green");
    assert.equal(status.min, 0);
    assert.equal(status.max, 5);
    assert.equal(status.value, 5);

    // Channel pushback extends the end by 250 ms. CHANNEL_UPDATE also writes the decreasing
    // remaining value through SetValue, so this is a behavioral range/value assertion, not merely
    // an event-delivery check.
    clock.now = 1002.25;
    candidate.boot.tickSeam(clock.now);
    assert.equal(status.max, 5.25);
    assert.equal(status.value, 4.75);
    assert.ok(status.value < 5, "channel value decreases as time advances");

    // The final channel stop fills the bar and starts the flash/fade state. Drive the existing
    // bridge OnUpdate synchronously until Lua hides it; no timers or sleeps are involved.
    clock.now = 1007;
    candidate.boot.tickSeam(clock.now);
    assert.equal(status.value, 5.25, "CHANNEL_STOP fills the updated channel range");
    assert.equal(flash().visible, true, "CHANNEL_STOP starts the flash/fade sequence");
    assert.equal(castbar.visible, true, "CHANNEL_STOP starts fading while still visible");
    for (let tick = 0; tick < 35 && castbar.visible; tick += 1) candidate.boot.bridge.tick(0.1);
    assert.equal(castbar.visible, false, "the real OnUpdate fade eventually hides the bar");
    assert.equal(candidate.boot.vm.errors.length, luaErrorsBeforeTimeline,
      "cast/channel events do not add runtime Lua errors");
  } finally {
    candidate?.boot.close();
    clock.restore();
    chain.close();
  }
});
