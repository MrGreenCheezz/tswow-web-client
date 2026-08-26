import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReclaimCorpse,
  buildRepopRequest,
  buildResurrectResponse,
  buildSpiritHealerActivate,
  parseCorpseQuery,
  parseCorpseReclaimDelay,
  parseDeathReleaseLoc,
  parsePreResurrect,
  parseResurrectRequest,
} from "../dist/code/world/DeathProtocol.js";

const encoder = new TextEncoder();

test("corpse query decodes the found and not-found answers", () => {
  // QueryHandler.cpp writes uint8(0) when there is no corpse.
  assert.deepEqual(parseCorpseQuery(Uint8Array.from([0])), {
    found: false, mapId: -1, x: 0, y: 0, z: 0, corpseMapId: -1,
  });

  // Otherwise uint8(1), int32 mapID, three floats, int32 corpseMapID and an unused uint32.
  const bytes = new Uint8Array(1 + 6 * 4);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setInt32(1, 0, true);
  view.setFloat32(5, -8949.95, true);
  view.setFloat32(9, -132.493, true);
  view.setFloat32(13, 83.5312, true);
  view.setInt32(17, 571, true);
  view.setUint32(21, 0, true);

  const corpse = parseCorpseQuery(bytes);
  assert.equal(corpse.found, true);
  assert.equal(corpse.mapId, 0);
  assert.equal(corpse.corpseMapId, 571);
  assert.ok(Math.abs(corpse.x + 8949.95) < 0.01);
  assert.ok(Math.abs(corpse.z - 83.5312) < 0.001);
});

test("resurrect request decodes the caster, name and both flags", () => {
  // Spell.cpp: uint64 caster, uint32 nameLength including the terminator, the string, then
  // the resurrection-sickness flag and whether the reclaim timer applies.
  const name = encoder.encode("Спасатель");
  const bytes = new Uint8Array(8 + 4 + name.length + 1 + 2);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 0xabcdn, true);
  view.setUint32(8, name.length + 1, true);
  bytes.set(name, 12);
  bytes[12 + name.length] = 0;
  bytes[13 + name.length] = 1;
  bytes[14 + name.length] = 0;

  assert.deepEqual(parseResurrectRequest(bytes), {
    casterGuid: 0xabcdn,
    casterName: "Спасатель",
    sickness: true,
    useTimer: false,
  });
});

test("reclaim delay and release location decode", () => {
  const delay = new Uint8Array(4);
  new DataView(delay.buffer).setUint32(0, 30000, true);
  assert.equal(parseCorpseReclaimDelay(delay), 30000);

  const location = new Uint8Array(16);
  const view = new DataView(location.buffer);
  view.setInt32(0, 571, true);
  view.setFloat32(4, 100.5, true);
  view.setFloat32(8, -200.25, true);
  view.setFloat32(12, 12.75, true);
  assert.deepEqual(parseDeathReleaseLoc(location), { mapId: 571, x: 100.5, y: -200.25, z: 12.75 });
});

test("pre-resurrect uses a packed GUID, unlike the other death packets", () => {
  // Mask 0x05 selects bytes 0 and 2, giving 0x00AA00BB.
  assert.equal(parsePreResurrect(Uint8Array.from([0x05, 0xbb, 0xaa])), 0x00aa00bbn);
});

test("client death packets carry the bodies the handlers read", () => {
  assert.deepEqual([...buildRepopRequest()], [0]);
  assert.deepEqual([...buildRepopRequest(true)], [1]);
  assert.equal(buildReclaimCorpse(0n).length, 8);
  assert.equal(buildSpiritHealerActivate(7n).length, 8);

  const response = buildResurrectResponse(0x1122n, true);
  assert.equal(response.length, 9);
  assert.equal(new DataView(response.buffer, response.byteOffset).getBigUint64(0, true), 0x1122n);
  assert.equal(response[8], 1);
  assert.equal(buildResurrectResponse(0x1122n, false)[8], 0);
});
