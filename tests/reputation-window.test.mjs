import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { buildSetFactionAtWar } from "../dist/code/world/CharacterProgressProtocol.js";
import {
  resolveFrameXmlReputationRows,
} from "../dist/code/browser/framexml/FrameXmlReputationResolver.js";

// M4: the reputation window — the full met list with search, bars and the one thing the
// server lets the client change: war and peace.

function fakeConnection() {
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
}

test("the at-war packet is a list id and a flag byte, nothing else", () => {
  // CharacterHandler.cpp:1055-1067: u32 repListID, u8 flag.
  const body = buildSetFactionAtWar(72, true);
  assert.equal(body.length, 5);
  const view = new DataView(body.buffer, body.byteOffset);
  assert.equal(view.getUint32(0, true), 72);
  assert.equal(view.getUint8(4), 1);
  assert.equal(new DataView(buildSetFactionAtWar(72, false).buffer).getUint8(4), 0);
});

test("setFactionAtWar reaches the wire for a sane list id", () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  world.setFactionAtWar(72, true);
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].opcode, OPCODES.CMSG_SET_FACTION_ATWAR);
  world.setFactionAtWar(-1, true);
  world.setFactionAtWar(Number.NaN, true);
  assert.equal(connection.sent.length, 1, "garbage ids never reach the server");
  world.close();
  world.setFactionAtWar(72, true);
  assert.equal(connection.sent.length, 1, "a closed client stays silent");
});

const factions = (rows) => ({
  factions: new Map(rows.map((row) => [row.listId, row])),
});
const metadata = (names) => ({ ready: true, name: (listId) => names[listId] });

test("only met, named factions row up, with bars and war rights", () => {
  const world = factions([
    { listId: 72, flags: 0x01, standing: 5000 },
    { listId: 73, flags: 0x01 | 0x02, standing: -100 },
    { listId: 74, flags: 0x00, standing: 9000 },
    { listId: 75, flags: 0x01 | 0x04, standing: 100 },
  ]);
  const rows = resolveFrameXmlReputationRows(world, metadata({ 72: "Штормград", 73: "Враги", 75: "Скрытые" }));
  assert.deepEqual(rows.map((row) => row.listId), [72, 73],
    "unseen and hidden rows never show, unnamed rows have no name to show");
  const [stormwind, enemies] = rows;
  assert.equal(stormwind.name, "Штормград");
  assert.equal(stormwind.standingId, 5);
  assert.equal(stormwind.atWarWith, false);
  assert.equal(stormwind.canToggleAtWar, true);
  assert.equal(enemies.atWarWith, true);
  assert.ok(stormwind.barMin <= 5000 && 5000 <= stormwind.barMax, "the bar spans the rank");
});

test("the window lists, searches, bars and toggles war", async () => {
  const source = await readFile(new URL("../src/browser/ui/Reputation.ts", import.meta.url), "utf8");
  assert.match(source, /resolveFrameXmlReputationRows\(world, game\.factions\)/,
    "the same resolver as the stock frame, so the two can never disagree");
  assert.match(source, /reputationRankName\(row\.standingId\)/, "ranks in words, not numbers");
  assert.match(source, /world\.setFactionAtWar\(row\.listId, !row\.atWarWith,\s*frameXmlReputationBase\(world, game\.factions\?\.reputationCatalog, row\.listId\)\)/,
    "the toggle sends the row's own list id, flipped; the peace test adds the row's Faction.dbc base");
  assert.match(source, /Заключить мир.*Объявить войну|Объявить войну.*Заключить мир/,
    "the button names what it will do, not the current state");
  const windows = await readFile(new URL("../src/browser/ui/Windows.ts", import.meta.url), "utf8");
  assert.match(windows, /reputationOpen, close: closeReputation/, "Escape knows the window");
});
