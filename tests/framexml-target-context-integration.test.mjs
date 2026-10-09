import assert from "node:assert/strict";
import test from "node:test";

// This is intentionally MPQ-backed.  TargetFrame.lua owns both the selected-unit refresh and the
// TargetSpellBar event path; a test-only frame with the same names would not prove either one.
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
  CANNED_TARGET_AURA_FIXTURES,
  CANNED_CAST,
  CANNED_CHANNEL,
  CANNED_PLAYER,
  CANNED_TARGET,
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
    // suite-fix: since L5 3.27 GetTime and pump.now read FrameXmlClock (the page's monotonic clock),
    // not Date.now, so the test's clock goes in through the boot's `clock` option.
    clock: () => Math.round(clock.now * 1000),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory, requests: new Set(requests) };
}

function frame(boot, name) {
  const result = boot.bridge.getFrame(name);
  assert.ok(result, `${name} exists`);
  return result;
}

function apiCallCount(boot, name) {
  // `__fxCalls` is intentionally a Lua table.  Ask Lua to copy one scalar out instead of relying
  // on the VM's opaque table reference representation.
  boot.vm.execute(`__fxTargetContextCallCount = __fxCalls[${JSON.stringify(name)}] or 0`,
    "@target-context-call-count");
  return Number(boot.vm.getGlobal("__fxTargetContextCallCount") ?? 0);
}

/**
 * Supply only the selected target's changing C-side state.  The bridge bindings remain the
 * production bindings: the stock TargetFrame asks UnitBuff/UnitDebuff and UnitCastingInfo/
 * UnitChannelInfo while the test changes this small deterministic state machine.
 */
function installTargetContext(seam, clock) {
  // The seam's C-side compatibility surface is UnitAura.  FrameXmlWorldSeam registers the stock
  // UnitBuff/UnitDebuff names as fixed HELPFUL/HARMFUL aliases, which is exactly what TargetFrame
  // reaches; monkey-patching this one method keeps the test on those real bindings.
  const originalAura = seam.unitAura.bind(seam);
  const originalCastingInfo = seam.unitCastingInfo.bind(seam);
  const originalChannelInfo = seam.unitChannelInfo.bind(seam);
  let auraState = "both";
  let castState = "canned";
  let castStartedAt;
  let castEnd;
  let channelStartedAt;
  let channelEnd;

  // TargetFrame.lua calls UnitBuff/UnitDebuff, not the modern UnitAura spelling.  Keep the tuple
  // widths exactly as the 3.3.5 C APIs return them; FrameXmlWorldSeam's fixed aliases select the
  // filter before this method is reached.  The initial target tuples come from CannedWorldSeam;
  // this wrapper only adds deterministic removal edges for the integration assertions below.
  seam.unitAura = (unit, index, filter) => {
    if (unit !== "target" || index !== 1) return originalAura(unit, index, filter);
    if (auraState === "none"
      || (filter === "HELPFUL" && auraState === "debuff-only")
      || (filter === "HARMFUL" && auraState === "buff-only")) return undefined;
    const value = originalAura(unit, index, filter);
    if (unit === "target" && filter === "HELPFUL" && value) {
      // The canned target fixture's real tuple has one application.  Raise only that field in
      // this test seam so stock TargetFrame's count-visible branch is exercised as well.
      return [value[0], value[1], value[2], CANNED_AURA_FIXTURES.helpful.count, ...value.slice(4)];
    }
    return value;
  };

  seam.unitCastingInfo = (unit) => {
    if (unit !== "target") return originalCastingInfo(unit);
    if (castState === "none" || castState === "channeling") return undefined;
    const value = originalCastingInfo(unit);
    if (castState === "canned" || !value || castStartedAt === undefined || castEnd === undefined) {
      return value;
    }
    return [value[0], value[1], value[2], value[3], castStartedAt * 1000, castEnd * 1000,
      ...value.slice(6)];
  };
  seam.unitChannelInfo = (unit) => {
    if (unit !== "target" || castState !== "channeling" || channelStartedAt === undefined
      || channelEnd === undefined) return originalChannelInfo(unit);
    return [
      CANNED_CHANNEL.name,
      CANNED_CHANNEL.rank,
      CANNED_CHANNEL.displayName,
      CANNED_CHANNEL.texture,
      channelStartedAt * 1000,
      channelEnd * 1000,
      CANNED_CHANNEL.isTradeSkill,
      CANNED_CHANNEL.notInterruptible,
    ];
  };

  return {
    setAuras(next) { auraState = next; },
    delayCast(seconds) {
      const value = originalCastingInfo("target");
      assert.ok(value, "canned target cast is available for delayed event");
      castState = "override";
      castStartedAt = Number(value[4]) / 1000;
      castEnd = seconds;
    },
    startChannel() {
      castState = "channeling";
      channelStartedAt = castEnd;
      channelEnd = channelStartedAt + 5;
    },
    extendChannel(seconds) { channelEnd = seconds; },
    stopCast() { castState = "none"; },
  };
}

test("MPQ TargetFrame keeps target cast/aura context on the real stock Lua path", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const clock = installClock(1000);
  let candidate;
  try {
    candidate = await loadCandidate(chain, clock); // suite-fix: L5 3.27 clock option
    const { boot, seam, inventory, requests } = candidate;

    assert.ok(requests.has("interface/framexml/targetframe.xml"));
    assert.ok(requests.has("interface/framexml/targetframe.lua"));
    assert.ok(requests.has("interface/framexml/unitframe.lua"));
    assert.equal(inventory.files.missing.length, 0);
    assert.equal(inventory.xml.failed.length, 0);
    assert.equal(inventory.lua.failed, 0);

    const target = frame(boot, "TargetFrame");
    const spellbar = frame(boot, "TargetFrameSpellBar");
    const status = spellbar.statusBar;
    const spellText = frame(boot, "TargetFrameSpellBarText");
    const spellIcon = frame(boot, "TargetFrameSpellBarIcon");
    const playerCastbar = frame(boot, "CastingBarFrame");
    const playerBuff = frame(boot, "BuffButton1");

    assert.equal(target.visible, false, "target starts absent");
    assert.equal(spellbar.visible, false, "target spellbar starts hidden");
    assert.equal(playerCastbar.visible, false, "player castbar starts idle");
    assert.equal(playerBuff.visible, true, "player aura fixture is independently mounted");

    const context = installTargetContext(seam, clock);
    const errorsBeforeTarget = boot.vm.errors.length;
    // The stock target loop hides enemy debuffs not cast by player/vehicle unless this measured
    // client CVar is disabled.  Keep the target fixture's caster honest (`target`) and exercise
    // the real alternate branch explicitly.
    boot.vm.setGlobal("SHOW_CASTABLE_DEBUFFS", "0");
    assert.ok(seam.setTarget(CANNED_TARGET) > 0, "selection publishes PLAYER_TARGET_CHANGED");
    assert.ok(apiCallCount(boot, "UnitBuff") > 0, "stock TargetFrame reached UnitBuff");
    assert.ok(apiCallCount(boot, "UnitDebuff") > 0, "stock TargetFrame reached UnitDebuff");
    assert.ok(apiCallCount(boot, "UnitCastingInfo") > 0, "stock TargetSpellBar reached UnitCastingInfo");

    // Target auras are dynamic frames: stock TargetFrame.lua creates them only after the selected
    // unit's first PLAYER_TARGET_CHANGED/UNIT_AURA pass has returned an icon.
    const targetBuff = frame(boot, "TargetFrameBuff1");
    const targetDebuff = frame(boot, "TargetFrameDebuff1");
    const targetBuffIcon = frame(boot, "TargetFrameBuff1Icon");
    const targetDebuffIcon = frame(boot, "TargetFrameDebuff1Icon");
    const targetBuffCount = frame(boot, "TargetFrameBuff1Count");
    const targetDebuffCount = frame(boot, "TargetFrameDebuff1Count");
    const targetBuffCooldown = frame(boot, "TargetFrameBuff1Cooldown");
    const targetDebuffCooldown = frame(boot, "TargetFrameDebuff1Cooldown");
    const targetCastInfo = seam.unitCastingInfo("target");
    assert.ok(targetCastInfo, "CannedWorldSeam supplies the selected target cast tuple");
    const targetCastDuration = (Number(targetCastInfo[5]) - Number(targetCastInfo[4])) / 1000;

    // TargetFrame.lua itself creates the dynamic target aura buttons and asks the target spellbar
    // to inspect UnitChannelInfo/UnitCastingInfo.  No direct widget mutation is used here.
    assert.equal(target.visible, true);
    assert.equal(spellbar.visible, true);
    assert.equal(spellText.text, CANNED_CAST.displayName);
    assert.equal(spellIcon.texture, CANNED_CAST.texture);
    assert.equal(status.min, 0);
    assert.equal(status.max, targetCastDuration);
    assert.equal(status.value, 0);
    assert.equal(targetBuff.visible, true);
    assert.equal(targetDebuff.visible, true);
    assert.equal(targetBuffIcon.texture, CANNED_TARGET_AURA_FIXTURES.helpful.texture);
    assert.equal(targetDebuffIcon.texture, CANNED_TARGET_AURA_FIXTURES.harmful.texture);
    assert.equal(targetBuffCount.text, String(CANNED_AURA_FIXTURES.helpful.count));
    assert.equal(targetDebuffCount.visible, false, "one harmful application hides its count");
    assert.equal(targetBuffCooldown.visible, true);
    assert.equal(targetDebuffCooldown.visible, true);
    assert.equal(targetBuffCooldown.cooldown.duration, CANNED_TARGET_AURA_FIXTURES.helpful.duration);
    assert.equal(targetDebuffCooldown.cooldown.duration, CANNED_TARGET_AURA_FIXTURES.harmful.duration);
    assert.equal(playerCastbar.visible, false, "target selection does not start player castbar");
    assert.equal(playerBuff.visible, true, "target aura creation does not hide player aura");
    assert.equal(frame(boot, "BuffButton1Count").text, String(CANNED_AURA_FIXTURES.helpful.count));

    // Delay and stop are target-specific spell events.  The real TargetSpellBar forwards them into
    // CastingBarFrame.lua, which re-reads the target C API and updates/fades the status bar.
    const delayedCastEnd = Number(targetCastInfo[5]) / 1000 + 0.25;
    context.delayCast(delayedCastEnd);
    clock.now = 1000.5;
    assert.ok(boot.pump.fire(FRAMEXML_SEAM_EVENTS.castDelayed, "target", CANNED_CAST.name,
      CANNED_CAST.rank, CANNED_CAST.castID) >= 1);
    assert.equal(status.max, targetCastDuration + 0.25);
    context.stopCast();
    assert.ok(boot.pump.fire(FRAMEXML_SEAM_EVENTS.castStop, "target", CANNED_CAST.name,
      CANNED_CAST.rank, CANNED_CAST.castID) >= 1);
    assert.equal(status.value, targetCastDuration + 0.25);

    // The same target spellbar now enters the channel branch.  This also proves its state is not
    // accidentally reading the player's CannedWorldSeam cast fixture.
    context.startChannel();
    clock.now = delayedCastEnd;
    assert.ok(boot.pump.fire(FRAMEXML_SEAM_EVENTS.channelStart, "target") >= 1);
    assert.ok(apiCallCount(boot, "UnitChannelInfo") > 0,
      "stock TargetSpellBar reached UnitChannelInfo");
    assert.equal(spellText.text, CANNED_CHANNEL.displayName);
    assert.equal(spellIcon.texture, CANNED_CHANNEL.texture);
    assert.equal(status.max, 5);
    assert.equal(status.value, 5);
    const updatedChannelEnd = delayedCastEnd + 5.25;
    context.extendChannel(updatedChannelEnd);
    clock.now = delayedCastEnd + 0.5;
    assert.ok(boot.pump.fire(FRAMEXML_SEAM_EVENTS.channelUpdate, "target") >= 1);
    assert.equal(status.max, 5.25);
    assert.equal(status.value, 4.75);
    context.stopCast();
    clock.now = updatedChannelEnd;
    assert.ok(boot.pump.fire(FRAMEXML_SEAM_EVENTS.channelStop, "target") >= 1);
    assert.equal(status.value, 5.25);
    assert.equal(playerCastbar.visible, false, "target channel state stays off player castbar");

    // UNIT_AURA reaches TargetFrame's measured UnitBuff/UnitDebuff loops.  A changed tuple updates
    // only target state, and removal hides its target buttons while the player aura remains live.
    context.setAuras("buff-only");
    assert.ok(boot.pump.fire(FRAMEXML_SEAM_EVENTS.aura, "target") >= 1);
    assert.equal(targetBuff.visible, true);
    assert.equal(targetDebuff.visible, false);
    context.setAuras("none");
    assert.ok(boot.pump.fire(FRAMEXML_SEAM_EVENTS.aura, "target") >= 1);
    assert.equal(targetBuff.visible, false);
    assert.equal(targetDebuff.visible, false);
    assert.equal(playerBuff.visible, true);
    assert.equal(playerCastbar.visible, false);

    // Losing the selected unit drives the real TargetFrame and TargetSpellBar clear path.
    assert.ok(seam.setTarget(undefined) > 0);
    assert.equal(target.visible, false);
    assert.equal(spellbar.visible, false);
    assert.equal(boot.vm.errors.length, errorsBeforeTarget,
      "target cast/channel/aura transitions add no Lua errors");
    assert.equal(seam.unitHealth("player"), CANNED_PLAYER.healthMax,
      "target updates do not alias the player health fixture");
  } finally {
    candidate?.boot.close();
    clock.restore();
    chain.close();
  }
});
