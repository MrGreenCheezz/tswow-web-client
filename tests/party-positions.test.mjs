// 4.06: party members out of sight stay on the map and the minimap at the whole-yard position
// SMSG_PARTY_MEMBER_STATS carries (GROUP_UPDATE_FLAG_POSITION, two uint16 of the truncated world
// coordinate), and a plain click inside the minimap's circle pings as stock Minimap_OnClick does.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

installFakeUiDocument();
const positions = await import("../dist/code/browser/game/PartyPositions.js");

test("a truncated uint16 reads back as the signed yard", () => {
  assert.equal(positions.int16FromWire(65536 - 8000), -8000);
  assert.equal(positions.int16FromWire(1234), 1234);
  assert.equal(positions.int16FromWire(32767), 32767);
  assert.equal(positions.int16FromWire(32768), -32768);
  assert.equal(positions.int16FromWire(65535), -1);
});

function world() {
  return {
    mapId: 0,
    state: { selfGuid: 1n, objects: new Map([[2n, { guid: 2n, typeId: 4, position: { x: 10.5, y: -20.25, z: 0 } }]]) },
    group: { members: [
      { guid: 1n, online: true }, { guid: 2n, online: true }, { guid: 3n, online: true }, { guid: 4n, online: false },
    ] },
    partyStats: new Map([
      [3n, { guid: 3n, flags: 0x100 | 0x80, zoneId: 12, positionX: 57536, positionY: 800 }],
      [4n, { guid: 4n, flags: 0x100 | 0x80, zoneId: 12, positionX: 100, positionY: 100 }],
    ]),
  };
}
const areaMap = (zone) => (zone === 12 ? 0 : zone === 14 ? 1 : undefined);

test("in sight: the exact position; out of sight on the same map: the signed whole yards", () => {
  const w = world();
  assert.deepEqual(positions.partyMemberPosition(w, 2n, areaMap), { x: 10.5, y: -20.25, precise: true });
  assert.deepEqual(positions.partyMemberPosition(w, 3n, areaMap), { x: -8000, y: 800, precise: false });
  w.partyStats.get(3n).zoneId = 14;
  assert.equal(positions.partyMemberPosition(w, 3n, areaMap), undefined, "a zone on another map: no point");
  w.partyStats.get(3n).zoneId = 99;
  assert.equal(positions.partyMemberPosition(w, 3n, areaMap), undefined, "an unknown zone: no point");
});

test("the blip list: not the player, not an offline member, the stats' online bit over the roster's", () => {
  const w = world();
  assert.deepEqual(positions.partyBlipMembers(w, areaMap).map((m) => [m.guid, m.precise]), [[2n, true], [3n, false]]);
  w.partyStats.get(4n).flags |= 0x1;
  w.partyStats.get(4n).status = 0x1;
  assert.deepEqual(positions.partyBlipMembers(w, areaMap).map((m) => m.guid), [2n, 3n, 4n]);
  w.partyStats.get(3n).flags |= 0x1;
  w.partyStats.get(3n).status = 0;
  assert.deepEqual(positions.partyBlipMembers(w, areaMap).map((m) => m.guid), [2n, 4n]);
  assert.deepEqual(positions.partyBlipMembers({ ...w, group: undefined }, areaMap), []);
  w.group.members[1].online = false;
  assert.ok(positions.partyBlipMembers(w, areaMap).some((m) => m.guid === 2n), "a member in sight is drawn whatever the roster bit says");
});

test("a click inside the minimap circle pings, outside or twice within half a second it does not", async () => {
  const { minimapClickPings, MINIMAP_CLICK_PING_INTERVAL_MS } = await import("../dist/code/browser/ui/Minimap.js");
  assert.equal(MINIMAP_CLICK_PING_INTERVAL_MS, 500);
  assert.equal(minimapClickPings({ column: 10, row: 10 }, 160, 1_000, Number.NEGATIVE_INFINITY), true);
  assert.equal(minimapClickPings({ column: 70, row: 70 }, 160, 1_000, Number.NEGATIVE_INFINITY), false, "the corner is outside");
  assert.equal(minimapClickPings({ column: 0, row: 0 }, 160, 1_100, 1_000), false, "a double click is one ping");
  assert.equal(minimapClickPings({ column: 0, row: 0 }, 160, 1_500, 1_000), true);
  const source = await readFile(new URL("../src/browser/ui/Minimap.ts", import.meta.url), "utf8");
  assert.match(source, /canvas\.addEventListener\("click", \(event\) => onCanvasClick\(event, canvas\)\);/,
    "any left click, not only Ctrl+click");
});
