import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { WorldStore } from "../dist/code/world/WorldStore.js";
import {
  EXPLORED_ZONES_WORDS, exploredZones, isAreaExplored, trackedTypesFromMask,
} from "../dist/code/world/Fields.js";

function object(guid) {
  return { guid, typeId: 4, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: undefined, turnRate: undefined, motion: undefined, fields: new Map() };
}

function writeUpdateFields(writer, entries) {
  const sorted = entries.toSorted(([left], [right]) => left - right);
  const blockCount = Math.floor(sorted.at(-1)[0] / 32) + 1;
  const masks = Array.from({ length: blockCount }, () => 0);
  for (const [index] of sorted) masks[Math.floor(index / 32)] |= 1 << (index % 32);
  writer.u8(blockCount);
  for (const mask of masks) writer.u32(mask);
  for (const [, value] of sorted) writer.u32(value);
}

function values(guid, fields) {
  const writer = new PacketWriter().u32(1).u8(0).packedGuid(guid);
  writeUpdateFields(writer, fields);
  return writer.toUint8Array();
}

test("an area's bit is the word and bit Player::CheckAreaExploreAndOutdoor writes", () => {
  const player = object(1n);
  const base = UPDATE_FIELDS.PLAYER_EXPLORED_ZONES_1.offset;
  // The core sets PLAYER_EXPLORED_ZONES_1 + AreaBit / 32 to 1 << (AreaBit % 32), so bit 0 of word 0
  // and the top bit of word 127 are the two ends of the mask.
  player.fields.set(base, 1);
  player.fields.set(base + 127, 0x8000_0000);
  player.fields.set(base + 3, 1 << 7);

  const words = exploredZones(player);
  assert.equal(words.length, EXPLORED_ZONES_WORDS);
  assert.equal(isAreaExplored(words, 0), true);
  assert.equal(isAreaExplored(words, 1), false);
  assert.equal(isAreaExplored(words, 127 * 32 + 31), true, "the top bit of the last word is signed in JS and must still read as set");
  assert.equal(isAreaExplored(words, 3 * 32 + 7), true);

  // One past the end is unexplored rather than an exception or an undefined read.
  assert.equal(isAreaExplored(words, EXPLORED_ZONES_WORDS * 32), false);
  assert.equal(isAreaExplored(words, -1), false);
  assert.equal(isAreaExplored(words, 1.5), false);
});

test("no words at all and nothing explored are different answers", () => {
  // The private block has not arrived: there is nothing to say yet.
  assert.equal(exploredZones(object(1n)), undefined);

  // One word arrived holding zero. Everything else is a zero the server never sends, not an
  // omission — so this character has a mask, and it is empty.
  const started = object(1n);
  started.fields.set(UPDATE_FIELDS.PLAYER_EXPLORED_ZONES_1.offset + 5, 0);
  const words = exploredZones(started);
  assert.notEqual(words, undefined);
  assert.equal(words.some((word) => word !== 0), false);

  // CONFIG_START_ALL_EXPLORED gives every word 0xFFFFFFFF, which is a real state and not a bug.
  const everything = object(1n);
  for (let word = 0; word < EXPLORED_ZONES_WORDS; word++) {
    everything.fields.set(UPDATE_FIELDS.PLAYER_EXPLORED_ZONES_1.offset + word, 0xffff_ffff);
  }
  assert.equal(isAreaExplored(exploredZones(everything), 4095), true);
});

test("any of the 128 mask words reaches the bus under one name", () => {
  const guid = 0xf130000000000009n;
  const state = new WorldState();
  const store = new WorldStore(state);
  const seen = [];
  store.events.on("PLAYER_EXPLORED_ZONES", () => seen.push(1));

  // Word 59 rather than word 0: naming only the first slot would subscribe a map to areas 0 to 31
  // and leave the other four thousand silent.
  state.objects.set(guid, object(guid));
  state.applyUpdate(values(guid, [[UPDATE_FIELDS.PLAYER_EXPLORED_ZONES_1.offset + 59, 0x40]]));
  store.flush();
  assert.equal(seen.length, 1);

  // Two words in one block are one event for the mask, not two.
  seen.length = 0;
  state.applyUpdate(values(guid, [
    [UPDATE_FIELDS.PLAYER_EXPLORED_ZONES_1.offset + 1, 2],
    [UPDATE_FIELDS.PLAYER_EXPLORED_ZONES_1.offset + 2, 4],
  ]));
  store.flush();
  assert.equal(seen.length, 1);
});

test("a tracking mask names ids one higher than the bits it sets", () => {
  // The core sets `1 << (MiscValue - 1)`, so bit 0 is creature type 1. Reading a bit as the type
  // itself files every beast under type 0, which is "none" and matches nothing on the map.
  assert.deepEqual([...trackedTypesFromMask(0b1000001)], [1, 7], "beast and humanoid, not 0 and 6");
  assert.deepEqual([...trackedTypesFromMask(0)], []);
  assert.deepEqual([...trackedTypesFromMask(undefined)], []);

  // The two resource types a gatherer actually uses: herbalism is LockType 2 and mining is 3.
  assert.deepEqual([...trackedTypesFromMask((1 << 1) | (1 << 2))], [2, 3]);

  // The top bit is negative once JavaScript treats the word as signed, and must still be read.
  assert.deepEqual([...trackedTypesFromMask(0x8000_0000)], [32]);
});
