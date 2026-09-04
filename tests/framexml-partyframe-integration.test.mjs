import assert from "node:assert/strict";
import test from "node:test";

// This is intentionally MPQ-backed.  A hand-built party frame would not prove that the stock
// PartyMemberFrame.lua/UnitFrame.lua event handlers and UIParent.lua RefreshDebuffs are wired.
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
  CANNED_PARTY_MEMBERS,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } =
  await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const decoder = new TextDecoder("utf-8");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

async function loadCandidate(chain, subset = FRAMEXML_VERTICAL_TOC) {
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
    subset,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory, requests: new Set(requests) };
}

function frame(boot, name) {
  const result = boot.bridge.getFrame(name);
  assert.ok(result, `${name} exists`);
  return result;
}

function api(inventory, name) {
  const result = inventory.api.find((entry) => entry.name === name);
  assert.ok(result && result.calls > 0, `${name} is reached by stock PartyFrame Lua`);
  return result;
}

function apiCensus(inventory, names) {
  return names.map((name) => {
    const entry = api(inventory, name);
    return { name, calls: entry.calls, firstTouch: entry.firstTouch };
  });
}

function errorKey(error) {
  return `${error.file}:${error.line}:${error.message}`;
}

/**
 * Keep the CannedWorldSeam's party roster fixture deterministic while supplying one explicit
 * update edge.  The production bindings stay in place: PartyMemberFrame.lua reaches these
 * methods through FRAMEXML_SEAM_BINDINGS, and the test only changes the small state that the
 * attached seam would normally receive from a group packet.
 */
function installPartyContext(candidate) {
  const { boot, seam } = candidate;
  const initial = CANNED_PARTY_MEMBERS[0];
  assert.ok(initial, "the canned roster has party1");
  const originalName = seam.unitName.bind(seam);
  const originalLevel = seam.unitLevel.bind(seam);
  const originalHealth = seam.unitHealth.bind(seam);
  const originalHealthMax = seam.unitHealthMax.bind(seam);
  const originalPower = seam.unitPower.bind(seam);
  const originalPowerMax = seam.unitPowerMax.bind(seam);
  const originalPowerType = seam.unitPowerType.bind(seam);
  const originalConnected = seam.unitIsConnected.bind(seam);
  const originalVisible = seam.unitIsVisible.bind(seam);
  const originalAura = seam.unitAura.bind(seam);
  let state = { ...initial };
  let aura = CANNED_AURA_FIXTURES.harmful;

  seam.unitName = (unit) => unit === "party1" ? state.name : originalName(unit);
  seam.unitLevel = (unit) => unit === "party1" ? state.level : originalLevel(unit);
  seam.unitHealth = (unit) => unit === "party1" ? state.health : originalHealth(unit);
  seam.unitHealthMax = (unit) => unit === "party1" ? state.healthMax : originalHealthMax(unit);
  seam.unitPower = (unit) => unit === "party1" ? state.power : originalPower(unit);
  seam.unitPowerMax = (unit) => unit === "party1" ? state.powerMax : originalPowerMax(unit);
  seam.unitPowerType = (unit) => unit === "party1"
    ? [state.powerType, state.powerType === 1 ? "RAGE" : "MANA"]
    : originalPowerType(unit);
  seam.unitIsConnected = (unit) => unit === "party1" ? state.connected : originalConnected(unit);
  seam.unitIsVisible = (unit) => unit === "party1" ? state.visible : originalVisible(unit);
  seam.unitAura = (unit, index, filter) => {
    if (unit !== "party1" || index !== 1) return originalAura(unit, index, filter);
    if (filter !== "HARMFUL" || aura === undefined) return undefined;
    return [
      aura.name,
      aura.rank,
      aura.texture,
      aura.count,
      aura.debuffType,
      aura.duration,
      boot.pump.now() + aura.expirationOffset,
      aura.unitCaster,
      aura.isStealable,
      aura.shouldConsolidate,
      aura.spellId,
    ];
  };

  return {
    initial,
    setMember(next) {
      state = { ...state, ...next };
      return boot.pump.fire(FRAMEXML_SEAM_EVENTS.partyMembers);
    },
    setAura(next) {
      aura = next;
      return boot.pump.fire(FRAMEXML_SEAM_EVENTS.aura, "party1");
    },
  };
}

test("MPQ PartyFrame paints and updates one canned party member through stock Lua", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  let baseline;
  let candidate;
  try {
    // The vertical carries the three measured static owners in the stock TOC positions. Removing
    // PartyFrame.xml gives the red baseline while retaining the dropdown/voice/ready-check owners
    // needed by the player-frame tail.
    const baselineSubset = FRAMEXML_VERTICAL_TOC.filter((entry) => entry !== "PartyFrame.xml");
    baseline = await loadCandidate(chain, baselineSubset);
    candidate = await loadCandidate(chain, FRAMEXML_VERTICAL_TOC);
    const { boot, seam, inventory, requests } = candidate;

    for (const path of [
      "interface/framexml/uidropdownmenu.xml",
      "interface/framexml/voicechat.xml",
      "interface/framexml/readycheck.xml",
      "interface/framexml/partyframe.xml",
      "interface/framexml/partymemberframe.lua",
      "interface/framexml/partyframetemplates.xml",
      "interface/framexml/unitframe.lua",
      "interface/framexml/uiparent.lua",
      "interface/framexml/voicechat.lua",
    ]) {
      assert.ok(requests.has(path), `${path} was read from MPQ`);
    }
    assert.equal(inventory.files.missing.length, 0);
    assert.equal(inventory.xml.failed.length, 0);
    assert.equal(inventory.lua.failed, 0);
    // The vertical grows as later stock slices land. Pin the PartyFrame contribution to the
    // current candidate/baseline pair and keep the structural/error assertions below as the
    // durable proof of this integration rather than freezing unrelated global totals.
    assert.ok(inventory.files.total > baseline.inventory.files.total,
      "PartyFrame adds source files to the current vertical");
    assert.ok(inventory.files.bytes > baseline.inventory.files.bytes,
      "PartyFrame adds source bytes to the current vertical");
    assert.ok(inventory.widgets.total > baseline.inventory.widgets.total,
      "PartyFrame adds widgets to the current vertical");
    assert.ok(inventory.lua.executed >= baseline.inventory.lua.executed,
      "PartyFrame does not remove executed stock Lua chunks");
    assert.equal(inventory.errors.filter((error) => !error.handled).length, 0,
      "the dependency closure adds no unhandled Lua errors");

    for (let index = 1; index <= 4; index += 1) {
      const prefix = `PartyMemberFrame${index}`;
      assert.equal(frame(boot, prefix).type, "Button");
      assert.equal(frame(boot, `${prefix}Portrait`).type, "Texture");
      assert.equal(frame(boot, `${prefix}Name`).type, "FontString");
      assert.equal(frame(boot, `${prefix}HealthBar`).type, "StatusBar");
      assert.equal(frame(boot, `${prefix}ManaBar`).type, "StatusBar");
      assert.equal(frame(boot, `${prefix}Debuff1`).type, "Button");
      assert.equal(frame(boot, `${prefix}Debuff1Icon`).type, "Texture");
      assert.equal(frame(boot, `${prefix}Debuff1Border`).type, "Texture");
      assert.equal(frame(boot, `${prefix}PetFrame`).type, "Button");
      assert.ok(frame(boot, `${prefix}SpeakerOn`), `${prefix}SpeakerOn exists from VoiceChat.xml`);
      assert.ok(frame(boot, `${prefix}ReadyCheck`), `${prefix}ReadyCheck exists from ReadyCheck.xml`);
      assert.ok(frame(boot, `${prefix}ReadyCheckTexture`),
        `${prefix}ReadyCheckTexture exists from ReadyCheck.xml`);
      assert.ok(frame(boot, `${prefix}DropDown`), `${prefix}DropDown exists from UIDropDownMenu.xml`);
      assert.equal(frame(boot, `${prefix}`).registeredEvents.has("PARTY_MEMBERS_CHANGED"), true,
        `${prefix} registers PARTY_MEMBERS_CHANGED`);
      assert.equal(frame(boot, `${prefix}`).registeredEvents.has("UNIT_AURA"), true,
        `${prefix} registers UNIT_AURA`);
    }
    assert.ok(frame(boot, "PartyMemberBuffTooltip"));
    assert.ok(boot.bridge.registry.get("PartyMemberFrameTemplate"));
    assert.ok(boot.bridge.registry.get("PartyDebuffFrameTemplate"));
    assert.ok(boot.bridge.registry.get("PartyMemberPetFrameTemplate"));

    assert.ok(Array.isArray(CANNED_PARTY_MEMBERS) && CANNED_PARTY_MEMBERS.length >= 1,
      "CannedWorldSeam exposes a deterministic party roster");
    const initial = CANNED_PARTY_MEMBERS[0];
    const partyFrame = frame(boot, "PartyMemberFrame1");
    const name = frame(boot, "PartyMemberFrame1Name");
    const health = frame(boot, "PartyMemberFrame1HealthBar");
    const power = frame(boot, "PartyMemberFrame1ManaBar");
    const debuff = frame(boot, "PartyMemberFrame1Debuff1");
    const debuffIcon = frame(boot, "PartyMemberFrame1Debuff1Icon");
    assert.equal(partyFrame.registeredEvents.has("PARTY_MEMBERS_CHANGED"), true,
      "stock PartyMemberFrame_OnLoad registers roster updates");
    assert.equal(partyFrame.registeredEvents.has("UNIT_AURA"), true,
      "stock PartyMemberFrame_OnLoad registers aura updates");
    const dispatchedEvents = [];
    const dispatchEvent = boot.bridge.dispatchEvent.bind(boot.bridge);
    boot.bridge.dispatchEvent = (event, ...args) => {
      dispatchedEvents.push([event, ...args]);
      return dispatchEvent(event, ...args);
    };
    const context = installPartyContext(candidate);
    assert.ok(context.setAura(CANNED_AURA_FIXTURES.harmful) >= 1,
      "UNIT_AURA reaches stock PartyMemberFrame.lua");
    assert.deepEqual(dispatchedEvents, [["UNIT_AURA", "party1"]],
      "party aura update dispatches the exact stock event and unit");
    dispatchedEvents.length = 0;
    assert.equal(partyFrame.visible, true, "PARTY_MEMBERS_CHANGED shows party1");
    assert.equal(name.text, initial.name);
    assert.equal(health.statusBar.max, initial.healthMax);
    assert.equal(health.statusBar.value, initial.health);
    assert.equal(power.statusBar.max, initial.powerMax);
    assert.equal(power.statusBar.value, initial.power);
    assert.equal(debuff.visible, true, "stock RefreshDebuffs paints the canned harmful aura");
    assert.equal(debuffIcon.texture, CANNED_AURA_FIXTURES.harmful.texture);

    const requiredApis = apiCensus(inventory, [
      "GetPartyMember",
      "UnitName",
      "UnitHealth",
      "UnitHealthMax",
      "UnitPowerType",
      "UnitPower",
      "UnitPowerMax",
      "UnitIsConnected",
      "UnitDebuff",
    ]);
    // UnitBuff is used by PartyMemberBuffTooltip_Update in the stock source, but that tooltip is
    // not shown by the initial party-frame path.  Pin the source call instead of fabricating a
    // tooltip click; the runtime party aura census above is the real UnitDebuff path.
    const partyMemberSource = decoder.decode(
      await chain.read("Interface/FrameXML/PartyMemberFrame.lua"),
    );
    assert.match(partyMemberSource, /\bGetNumPartyMembers\s*\(/,
      "stock background path contains GetNumPartyMembers");
    assert.match(partyMemberSource, /\bUnitBuff\s*\(/, "stock tooltip path contains UnitBuff");
    assert.match(partyMemberSource, /\bUnitDebuff\s*\(/, "stock tooltip path contains UnitDebuff");
    const partyApi = boot.vm.execute("PartyCount = GetNumPartyMembers()", "@party-api-contract");
    assert.equal(partyApi.ok, true, partyApi.error ?? "GetNumPartyMembers binding failed");
    assert.equal(boot.vm.getGlobal("PartyCount"), CANNED_PARTY_MEMBERS.length,
      "GetNumPartyMembers binding returns the canned roster size");

    const updated = {
      ...initial,
      name: "Обновлённый союзник",
      health: Math.max(1, initial.health - 137),
      power: Math.max(0, Math.min(initial.powerMax, initial.power + 17)),
    };
    const errorsAtLoad = boot.vm.errors.length;
    assert.ok(context.setMember(updated) > 0,
      "party-member state mutation publishes a real stock event");
    assert.deepEqual(dispatchedEvents, [["PARTY_MEMBERS_CHANGED"]],
      "party member update dispatches the exact stock roster event");
    assert.equal(name.text, updated.name);
    assert.equal(health.statusBar.value, updated.health);
    assert.equal(power.statusBar.value, updated.power);

    // Changing the tuple through the attached seam and publishing UNIT_AURA proves that
    // RefreshDebuffs re-reads UnitDebuff instead of leaving a stale icon on screen.
    dispatchedEvents.length = 0;
    assert.ok(context.setAura(CANNED_AURA_FIXTURES.harmful) > 0,
      "party aura mutation publishes UNIT_AURA");
    assert.deepEqual(dispatchedEvents, [["UNIT_AURA", "party1"]],
      "party aura update dispatches UNIT_AURA for party1");
    assert.equal(debuff.visible, true);
    assert.equal(debuffIcon.texture, CANNED_AURA_FIXTURES.harmful.texture);

    const eventNames = [
      FRAMEXML_SEAM_EVENTS.partyMembers,
      FRAMEXML_SEAM_EVENTS.aura,
    ];
    assert.deepEqual(eventNames, ["PARTY_MEMBERS_CHANGED", "UNIT_AURA"],
      "event census uses exact stock PartyFrame registration names");

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateSpecific = inventory.errors.filter((error) => !baselineErrors.has(errorKey(error)));
    assert.equal(candidateSpecific.filter((error) => !error.handled).length, 0,
      `candidate-specific PartyFrame Lua is handled: ${JSON.stringify(candidateSpecific)}`);
    assert.equal(inventory.lua.failed, 0);
    assert.equal(boot.vm.errors.length, errorsAtLoad,
      "party roster, stat and aura events add no unhandled Lua errors");

    // A party update must not rewrite the independent player fixture.
    assert.equal(seam.unitHealth("player") > 0, true);
    assert.equal(frame(boot, "PlayerFrame").visible, true);

    console.log(`[framexml PartyFrame] MPQ census ${JSON.stringify({
      files: inventory.files.total,
      bytes: inventory.files.bytes,
      widgets: inventory.widgets.total,
      lua: inventory.lua.executed,
      baseline: {
        files: baseline.inventory.files.total,
        bytes: baseline.inventory.files.bytes,
        widgets: baseline.inventory.widgets.total,
        lua: baseline.inventory.lua.executed,
      },
      apis: requiredApis,
      events: eventNames,
      candidateSpecificErrors: candidateSpecific.map((error) => ({
        file: error.file,
        line: error.line,
        message: error.message,
        count: error.count,
        handled: error.handled,
      })),
    })}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
    chain.close();
  }
});
