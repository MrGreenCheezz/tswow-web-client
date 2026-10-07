import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installCountingUiDocument, resetStats, stats, textUnder } from "./fixtures/counting-ui-document.mjs";

// P1-20b: the five packet events behind the unit frames (ENCOUNTER_FRAME, RAID_TARGET_UPDATE,
// PET_BAR_CHANGED, PARTY_MEMBER_STATS, THREAT_CHANGED) ask for the frame's one world refresh instead
// of painting all the frames on the spot. A burst of them writes nothing until `drainWorldState`,
// which paints once; the boss list is still edited the moment the packet lands.

installCountingUiDocument();

const { game } = await import("../dist/code/browser/game/Context.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { drainWorldState, queueWorldState } = await import("../dist/code/browser/ui/WorldView.js");
const { engagedBossGuids, forgetUnitFrames, showUnitFrames } = await import("../dist/code/browser/ui/UnitFrames.js");
const { bindUnitFrameRefresh } = await import("../dist/code/browser/ui/UnitFrameRefresh.js");
const { diagnosticsWindow, partyFrames } = await import("../dist/code/browser/ui/Dom.js");
const { ENCOUNTER_FRAME_DISENGAGE, ENCOUNTER_FRAME_ENGAGE } = await import("../dist/code/world/InstanceProtocol.js");

const SELF = 0x10n;
const MEMBER = 0x20n;

function unitObject(guid, health, typeId = 4) {
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 1000],
    [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 80],
  ]);
  return { guid, typeId, position: { x: 0, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0, fields };
}

/** A real client in a party of two: the player and one member with an object in view. */
function partyClient() {
  const client = new WorldClient({ send() {}, close() {} });
  client.state.selfGuid = SELF;
  client.state.objects.set(SELF, unitObject(SELF, 1000));
  client.state.objects.set(MEMBER, unitObject(MEMBER, 1000));
  client.group = {
    groupType: 0, ownSubGroup: 0, ownFlags: 0, ownRoles: 0, guid: 1n, counter: 1, leaderGuid: SELF,
    lootMethod: 0, masterLooterGuid: 0n, lootThreshold: 2, dungeonDifficulty: 0, raidDifficulty: 0,
    members: [{ name: "Бот", guid: MEMBER, online: true, status: 1, subGroup: 0, flags: 0, roles: 0 }],
  };
  return client;
}

const partyText = () => textUnder(partyFrames);

test.beforeEach(() => {
  diagnosticsWindow.hidden = true;
});

test.afterEach(() => {
  game.world = undefined;
  forgetUnitFrames();
  drainWorldState();
});

test("200 PARTY_MEMBER_STATS write nothing until the frame's drain, which paints the frames once", () => {
  const client = partyClient();
  game.world = client;
  const stops = bindUnitFrameRefresh(client.events, () => queueWorldState(client.state));
  try {
    showUnitFrames();
    drainWorldState();
    assert.match(partyText(), /1000\/1000/, "the member is drawn");
    const member = client.state.objects.get(MEMBER);
    resetStats();
    for (let index = 1; index <= 200; index++) {
      member.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 1000 - index);
      client.events.emit("PARTY_MEMBER_STATS", { guid: MEMBER });
    }
    assert.equal(stats.writes, 0, "no DOM write in the packet tasks");
    assert.match(partyText(), /1000\/1000/, "and the frame still shows the old value");
    drainWorldState();
    assert.ok(stats.writes > 0, "the drain paints");
    assert.match(partyText(), /800\/1000/, "the last value, once");
    resetStats();
    drainWorldState();
    assert.equal(stats.writes, 0, "nothing is left queued: the burst was one refresh");
  } finally { for (const stop of stops) stop(); }
});

test("raid marks, the pet bar, threat and member stats each only queue the refresh", () => {
  const client = partyClient();
  game.world = client;
  let requests = 0;
  const stops = bindUnitFrameRefresh(client.events, () => { requests++; });
  try {
    client.events.emit("RAID_TARGET_UPDATE", { icon: 1 });
    client.events.emit("PET_BAR_CHANGED", { guid: 0n });
    client.events.emit("THREAT_CHANGED", { guid: MEMBER });
    client.events.emit("PARTY_MEMBER_STATS", { guid: MEMBER });
    assert.equal(requests, 4);
  } finally { for (const stop of stops) stop(); }
  client.events.emit("THREAT_CHANGED", { guid: MEMBER });
  assert.equal(requests, 4, "unsubscribed, nothing is asked for");
});

test("the control: a direct repaint per event (the old wiring) writes inside the packet task", () => {
  const client = partyClient();
  game.world = client;
  showUnitFrames();
  const stops = bindUnitFrameRefresh(client.events, () => showUnitFrames());
  try {
    client.state.objects.get(MEMBER).fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 500);
    resetStats();
    client.events.emit("PARTY_MEMBER_STATS", { guid: MEMBER });
    assert.ok(stats.writes > 0, "the counter sees a paint made in the packet task");
  } finally { for (const stop of stops) stop(); }
});

test("ENCOUNTER_FRAME edits the boss list at once and queues one refresh; other types ask for nothing", () => {
  const client = partyClient();
  game.world = client;
  const boss = 0xF130000000001234n;
  client.state.objects.set(boss, unitObject(boss, 5000, 3));
  let requests = 0;
  const stops = bindUnitFrameRefresh(client.events, () => { requests++; });
  try {
    client.events.emit("ENCOUNTER_FRAME", { type: ENCOUNTER_FRAME_ENGAGE, guid: boss, param1: 0, param2: 0 });
    assert.deepEqual([...engagedBossGuids()], [boss], "the list holds the boss before any drain");
    assert.equal(requests, 1);
    client.events.emit("ENCOUNTER_FRAME", { type: 99, guid: boss, param1: 0, param2: 0 });
    assert.equal(requests, 1, "an encounter frame of another kind changes nothing");
    client.events.emit("ENCOUNTER_FRAME", { type: ENCOUNTER_FRAME_DISENGAGE, guid: boss, param1: 0, param2: 0 });
    assert.deepEqual([...engagedBossGuids()], []);
    assert.equal(requests, 2);
  } finally { for (const stop of stops) stop(); }
});

test("switching the interface between stock FrameXML and native and back keeps the native frames current", async () => {
  const replacement = await import("../dist/code/browser/ui/NativeHudReplacement.js");
  // The classes the world mount publishes on <body> while the stock UI owns the screen (the private
  // party/pet/tot strings of FrameXmlWorldMount.ts included); the setting's switch takes them off.
  const stock = [replacement.NATIVE_LANES_REPLACED, replacement.NATIVE_TARGET_CONTEXT_REPLACED,
    replacement.NATIVE_FOCUS_REPLACED, "framexml-world-replaces-party", "framexml-world-replaces-pet",
    "framexml-world-replaces-tot"];
  const set = (on) => { for (const name of stock) document.body.classList.toggle(name, on); };
  const client = partyClient();
  game.world = client;
  const stops = bindUnitFrameRefresh(client.events, () => queueWorldState(client.state));
  const member = client.state.objects.get(MEMBER);
  const step = (health) => {
    member.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health);
    client.events.emit("PARTY_MEMBER_STATS", { guid: MEMBER });
    drainWorldState();
    return partyText();
  };
  try {
    for (const [owner, health] of [["stock", 900], ["native", 700], ["stock", 650], ["native", 400], ["native", 350]]) {
      set(owner === "stock");
      assert.match(step(health), new RegExp(`${health}/1000`), `${owner}: the native party frame shows ${health}`);
    }
  } finally {
    set(false);
    for (const stop of stops) stop();
  }
});

test("EnterWorld binds the five events to the queued refresh, and none of them paints directly", async () => {
  const source = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(source, /bindUnitFrameRefresh\(world\.events, \(\) => queueWorldState\(world\.state\)\)/);
  for (const name of ["ENCOUNTER_FRAME", "RAID_TARGET_UPDATE", "PARTY_MEMBER_STATS", "THREAT_CHANGED"]) {
    assert.equal(source.includes(`onWorldEvent("${name}"`), false, `${name} is bound only through bindUnitFrameRefresh`);
  }
  assert.equal(/onWorldEvent\("PET_BAR_CHANGED", \(\) => showUnitFrames\(\)\)/.test(source), false);
});
