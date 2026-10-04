import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  buildSetFactionInactive, buildSetWatchedFaction,
} from "../dist/code/world/CharacterProgressProtocol.js";

const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { resolveFrameXmlReputationRows } =
  await import("../dist/code/browser/framexml/FrameXmlReputationResolver.js");

// 5.19: watched/inactive/at-war go to the server. The core answers none of them with flags
// (ReputationMgr::SendState carries standings only), so the client flips its own copy as it
// sends — Wow.exe 0x005d0a10 (war), 0x005d1c10 (inactive) — while the watched faction is the
// player field PLAYER_FIELD_WATCHED_FACTION_INDEX that the core writes (0x005d0ba0 sends only).

const SELF = 0x1234n;
const WATCHED = UPDATE_FIELDS.PLAYER_FIELD_WATCHED_FACTION_INDEX.offset;
const UNIT_FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;

function fakeConnection() {
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload: [...payload] }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
}

function world(factions = []) {
  const connection = fakeConnection();
  const client = new WorldClient(connection);
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  for (const faction of factions) client.factions.set(faction.listId, faction);
  const edges = [];
  client.events.on("REPUTATION_CHANGED", () => edges.push(1));
  return { client, connection, edges };
}

test("the watched and inactive packets are the handlers' layouts", () => {
  // CharacterHandler.cpp:1103-1109 (u32) and :1111-1119 (u32, u8).
  assert.deepEqual([...buildSetWatchedFaction(5)], [5, 0, 0, 0]);
  assert.deepEqual([...buildSetWatchedFaction(undefined)], [0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual([...buildSetFactionInactive(7, true)], [7, 0, 0, 0, 1]);
  assert.deepEqual([...buildSetFactionInactive(7, false)], [7, 0, 0, 0, 0]);
});

test("inactive flips the world's own flag and sends once per call", () => {
  const { client, connection, edges } = world([{ listId: 12, flags: 0x01, standing: 100 }]);
  client.setFactionInactive(12, true);
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].opcode, OPCODES.CMSG_SET_FACTION_INACTIVE);
  assert.deepEqual(connection.sent[0].payload, [12, 0, 0, 0, 1]);
  assert.equal(client.factions.get(12).flags, 0x21, "INACTIVE set locally");
  assert.equal(edges.length, 1);
  client.setFactionInactive(12, false);
  assert.equal(client.factions.get(12).flags, 0x01);
  assert.deepEqual(connection.sent[1].payload, [12, 0, 0, 0, 0]);
  client.setFactionInactive(0x80, true);
  client.setFactionInactive(-1, true);
  assert.equal(connection.sent.length, 2, "only the 128 list slots exist");
});

test("war and peace follow Wow.exe 0x005d0a10", () => {
  const { client, connection, edges } = world([
    { listId: 1, flags: 0x01, standing: 100 },
    { listId: 2, flags: 0x01 | 0x10, standing: 100 },
    { listId: 3, flags: 0x01 | 0x02, standing: -3001 },
    { listId: 4, flags: 0x01 | 0x02, standing: -3000 },
  ]);
  assert.equal(client.setFactionAtWar(1, true), undefined);
  assert.equal(client.factions.get(1).flags, 0x03, "AT_WAR set on the client's copy");
  assert.deepEqual(connection.sent.at(-1).payload, [1, 0, 0, 0, 1]);
  assert.equal(edges.length, 1);

  assert.equal(client.setFactionAtWar(2, true), undefined);
  assert.equal(client.factions.get(2).flags, 0x11, "PEACE_FORCED: the bit stays clear");
  assert.equal(connection.sent.length, 2, "…but the request still goes out");

  assert.equal(client.setFactionAtWar(3, false), "standing");
  assert.equal(client.factions.get(3).flags, 0x03);
  assert.equal(connection.sent.length, 2, "no peace below -3000");
  assert.equal(client.setFactionAtWar(4, false), undefined);
  assert.equal(client.factions.get(4).flags, 0x01);
  assert.deepEqual(connection.sent.at(-1).payload, [4, 0, 0, 0, 0]);

  client.setFactionAtWar(1, true);
  client.state.setField(SELF, UNIT_FLAGS, 0x80000);
  const before = connection.sent.length;
  assert.equal(client.setFactionAtWar(1, false), "combat");
  assert.equal(connection.sent.length, before, "no peace in combat");
  assert.equal(client.factions.get(1).flags & 0x02, 0x02);
  assert.equal(client.setFactionAtWar(4, true), undefined, "war may be declared in combat");
  assert.equal(client.factions.get(4).flags & 0x02, 0x02);
});

test("the watched faction is the player field, and asking only sends", () => {
  const { client, connection } = world([{ listId: 12, flags: 0x01, standing: 100 }]);
  assert.equal(client.watchedFactionListId, undefined, "no field yet");
  client.state.setField(SELF, WATCHED, 0xFFFF_FFFF);
  assert.equal(client.watchedFactionListId, undefined);
  client.setWatchedFaction(12);
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].opcode, OPCODES.CMSG_SET_WATCHED_FACTION);
  assert.deepEqual(connection.sent[0].payload, [12, 0, 0, 0]);
  assert.equal(client.watchedFactionListId, undefined, "nothing changes before the server writes");
  client.state.setField(SELF, WATCHED, 12);
  assert.equal(client.watchedFactionListId, 12);
  client.setWatchedFaction(12);
  assert.equal(connection.sent.length, 1, "asking for the current value is not sent");
  client.setWatchedFaction(undefined);
  assert.deepEqual(connection.sent[1].payload, [0xff, 0xff, 0xff, 0xff]);
});

function liveSeam(client) {
  const names = { 3: "Дарнас", 12: "Штормград", 30: "Стальгорн" };
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => client,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    reputation: (w) => resolveFrameXmlReputationRows(w, { ready: true, name: (id) => names[id] }),
  });
  seam.attach({ now: () => 1, fire: (...args) => { fired.push(args); return 1; } });
  return { seam, fired };
}

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("stock reputation calls send the row's list id and read the server's state", () => {
  const { client, connection } = world([
    { listId: 3, flags: 0x01, standing: 100 },
    { listId: 12, flags: 0x01, standing: 5000 },
    { listId: 30, flags: 0x01, standing: 0 },
  ]);
  client.state.setField(SELF, WATCHED, 12);
  const { seam, fired } = liveSeam(client);
  assert.deepEqual(call("GetWatchedFactionInfo", seam)[0], "Штормград", "restored from the field at login");
  assert.equal(call("GetFactionInfo", seam, 2)[11], true, "isWatching");

  call("SetWatchedFactionIndex", seam, 3);
  assert.deepEqual(connection.sent.at(-1).payload, [30, 0, 0, 0], "third visible row's list id, not 3");
  assert.equal(call("GetWatchedFactionInfo", seam)[0], "Штормград", "until the field moves");
  client.state.setField(SELF, WATCHED, 30);
  assert.equal(call("GetWatchedFactionInfo", seam)[0], "Стальгорн");
  call("SetWatchedFactionIndex", seam, 0);
  assert.deepEqual(connection.sent.at(-1).payload, [0xff, 0xff, 0xff, 0xff]);
  call("SetWatchedFactionIndex", seam, 9);
  assert.equal(connection.sent.filter((p) => p.opcode === OPCODES.CMSG_SET_WATCHED_FACTION).length, 3,
    "past the list also clears");

  call("SetFactionInactive", seam, 1);
  assert.deepEqual(connection.sent.at(-1).payload, [3, 0, 0, 0, 1]);
  assert.deepEqual(call("IsFactionInactive", seam, 1), [true], "at once, from the world's flags");
  call("FactionToggleAtWar", seam, 2);
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_SET_FACTION_ATWAR);
  assert.deepEqual(connection.sent.at(-1).payload, [12, 0, 0, 0, 1]);
  assert.equal(call("GetFactionInfo", seam, 2)[6], true);

  client.state.setField(SELF, UNIT_FLAGS, 0x80000);
  fired.length = 0;
  const sent = connection.sent.length;
  call("FactionToggleAtWar", seam, 2);
  assert.equal(connection.sent.length, sent);
  assert.deepEqual(fired.map(([event]) => event), ["UI_ERROR_MESSAGE"], "ERR_NOT_IN_COMBAT");
  assert.equal(call("GetFactionInfo", seam, 2)[6], true);
  seam.detach();
});

test("rows and the peace test add Faction.dbc's race/class base to the wire's standing (0x005d05b0)", () => {
  // A human (race 1) warrior (class 1). The core stores and sends the standing without the base
  // (ReputationMgr.cpp:126, :396); the client sums both per row and compares -3000 to the sum.
  const { client, connection } = world([
    { listId: 3, flags: 0x01, standing: 0 },
    { listId: 5, flags: 0x01 | 0x02, standing: 0 },
    { listId: 7, flags: 0x01 | 0x02, standing: -3500 },
  ]);
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 0x0101);
  const row = (raceMask, base) => ({
    factionId: 1, raceMasks: [raceMask, 0, 0, 0], classMasks: [0, 0, 0, 0], bases: [base, 0, 0, 0], flags: [0, 0, 0, 0],
  });
  const catalog = { version: 1, factions: { 3: row(1, 3100), 5: row(1, -3500), 7: row(1 << 1, 9999) } };
  const names = { 3: "Штормград", 5: "Синдикат", 7: "Оргриммар" };
  const seam = new LiveWorldSeam({
    world: () => client,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    reputation: (w) => resolveFrameXmlReputationRows(w, { ready: true, name: (id) => names[id], reputationCatalog: catalog }),
    reputationCatalog: () => catalog,
  });
  seam.attach({ now: () => 1, fire: () => 1 });
  const info = (index) => call("GetFactionInfo", seam, index);
  assert.deepEqual([info(1)[2], info(1)[5]], [5, 3100], "home city: Friendly at 3100, not Neutral at 0");
  assert.deepEqual([info(2)[2], info(2)[5]], [2, -3500], "a negative base makes a Hostile row");
  assert.deepEqual([info(3)[2], info(3)[5]], [2, -3500], "an entry for another race adds nothing");

  const sent = connection.sent.length;
  call("FactionToggleAtWar", seam, 2);
  assert.equal(connection.sent.length, sent, "peace at base -3500 + 0 is refused on the client");
  assert.equal(info(2)[6], true);
  assert.equal(client.setFactionAtWar(5, false, -2000), undefined, "…and allowed when the sum is -2000");
  assert.deepEqual(connection.sent.at(-1).payload, [5, 0, 0, 0, 0]);
  seam.detach();
});
