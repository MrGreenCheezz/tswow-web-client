import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { WorldStore, SELF } from "../dist/code/world/WorldStore.js";
import { POWER, player, readByte, readField, unit } from "../dist/code/world/Fields.js";

function writeUpdateFields(writer, entries) {
  const sorted = entries.toSorted(([left], [right]) => left - right);
  const blockCount = Math.floor(sorted.at(-1)[0] / 32) + 1;
  const masks = Array.from({ length: blockCount }, () => 0);
  for (const [index] of sorted) masks[Math.floor(index / 32)] |= 1 << (index % 32);
  writer.u8(blockCount);
  for (const mask of masks) writer.u32(mask);
  for (const [, value] of sorted) writer.u32(value);
}

/** A create block for a unit standing at the origin, self-flagged so the store learns the guid. */
function createUnit(guid, fields, { self = true } = {}) {
  const writer = new PacketWriter().u32(1).u8(2).packedGuid(guid).u8(3)
    .u16(self ? 0x31 : 0x30)
    .u32(0).u16(0).u32(123).f32(1).f32(2).f32(3).f32(4).u32(0);
  for (let speed = 0; speed < 9; speed++) writer.f32(speed + 1);
  writer.u32(0x0b);
  writeUpdateFields(writer, fields);
  return writer.toUint8Array();
}

function values(guid, fields) {
  const writer = new PacketWriter().u32(1).u8(0).packedGuid(guid);
  writeUpdateFields(writer, fields);
  return writer.toUint8Array();
}

const float = (value) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};

test("a field reads back as the type the core declares for it", () => {
  const guid = 0xf130000000001234n;
  const state = new WorldState();
  state.applyUpdate(createUnit(guid, [
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 450],
    [UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, float(0.75)],
    [UPDATE_FIELDS.UNIT_FIELD_TARGET.offset, 0x11223344],
    [UPDATE_FIELDS.UNIT_FIELD_TARGET.offset + 1, 0xf1300000],
  ]));
  const object = state.objects.get(guid);

  assert.equal(readField(object, "UNIT_FIELD_HEALTH"), 450);
  assert.ok(Math.abs(readField(object, "UNIT_FIELD_BOUNDINGRADIUS") - 0.75) < 1e-6);
  // A LONG is two slots, low word first.
  assert.equal(readField(object, "UNIT_FIELD_TARGET"), 0xf130000011223344n);
  // Never sent is not zero: a health of 0 is a corpse and has to stay tellable from an unknown one.
  assert.equal(readField(object, "UNIT_FIELD_MAXHEALTH"), undefined);
});

test("a unit shows the power it actually uses, not slot one", () => {
  const guid = 0xf130000000000001n;
  const state = new WorldState();
  // Byte 3 of BYTES_0 is the power type; a warrior's is rage. Slot 1 holds mana and stays empty.
  state.applyUpdate(createUnit(guid, [
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (POWER.rage << 24) | (1 << 8)],
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + POWER.rage, 430],
    [UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + POWER.rage, 1000],
  ]));
  const object = state.objects.get(guid);

  assert.equal(unit.powerType(object), POWER.rage);
  assert.equal(unit.classId(object), 1);
  assert.equal(unit.power(object), 430);
  assert.equal(unit.maxPower(object), 1000);
  // Rage is stored ten times what the interface shows: Unit::GetCreatePowers gives it 1000.
  assert.equal(unit.powerScale(object), 10);
  assert.equal(readByte(object, "UNIT_FIELD_BYTES_0", 3), POWER.rage);
  // Reading slot 1 unconditionally, which is what the interface does today, finds nothing at all.
  assert.equal(readField(object, "UNIT_FIELD_POWER1"), undefined);
});

test("the quest log reads as slots of five words with packed counters", () => {
  const guid = 0xf130000000000002n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const stride = UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - base;
  const state = new WorldState();
  state.applyUpdate(createUnit(guid, [
    [base, 62],
    [base + 1, 0],
    [base + 2, (4 << 16) | 7],
    [base + 4, 1_700_000_000],
    [base + stride, 87],
  ]));
  const object = state.objects.get(guid);

  const first = player.questLog(object, 0);
  assert.equal(first.questId, 62);
  assert.deepEqual(first.counters, [7, 4, 0, 0]);
  assert.equal(first.timer, 1_700_000_000);
  assert.equal(player.questLog(object, 1).questId, 87);
  assert.equal(player.questLog(object, 2), undefined);
  assert.deepEqual(player.quests(object).map((entry) => entry.questId), [62, 87]);
});

test("a field subscription is called once a frame, however many blocks changed it", () => {
  const guid = 0xf130000000000003n;
  const state = new WorldState();
  const store = new WorldStore(state);
  const seen = [];
  store.field(guid, "UNIT_FIELD_HEALTH", (object) => seen.push(readField(object, "UNIT_FIELD_HEALTH")));

  state.applyUpdate(createUnit(guid, [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 500]]));
  state.applyUpdate(values(guid, [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 480]]));
  state.applyUpdate(values(guid, [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 460]]));
  assert.deepEqual(seen, [], "nothing is delivered until the frame is flushed");

  store.flush();
  assert.deepEqual(seen, [460], "three packets, one call, and it reads the value that survived");

  // A field nobody changed does not wake its subscribers.
  state.applyUpdate(values(guid, [[UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 12]]));
  store.flush();
  assert.deepEqual(seen, [460]);
});

test("SELF follows the controlled character, including before it is known", () => {
  const guid = 0xf130000000000004n;
  const state = new WorldState();
  const store = new WorldStore(state);
  const levels = [];
  const entered = [];
  store.field(SELF, "UNIT_FIELD_LEVEL", (object) => levels.push(object === undefined ? undefined : unit.level(object)));
  store.events.on("PLAYER_ENTERING_WORLD", (payload) => entered.push(payload.guid));

  state.applyUpdate(createUnit(guid, [[UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 1]]));
  store.flush();
  assert.deepEqual(entered, [guid]);
  // Once for the character arriving, once for the field it arrived with.
  assert.deepEqual(levels, [1, 1]);

  state.applyUpdate(values(guid, [[UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 2]]));
  store.flush();
  assert.deepEqual(levels, [1, 1, 2]);

  // Leaving the world takes the character with it, and the panel is told rather than left stale.
  state.destroy(guid);
  store.flush();
  assert.deepEqual(entered, [guid, undefined]);
  assert.equal(levels.at(-1), undefined);
});

test("arrival, movement and removal reach the bus as named events", () => {
  const guid = 0xf130000000000005n;
  const state = new WorldState();
  const store = new WorldStore(state);
  const log = [];
  for (const name of ["OBJECT_CREATED", "OBJECT_MOVED", "OBJECT_DESTROYED", "UNIT_HEALTH", "UNIT_POWER", "UNIT_DISPLAY_POWER", "PLAYER_QUEST_LOG_UPDATE"]) {
    store.events.on(name, () => log.push(name));
  }

  state.applyUpdate(createUnit(guid, [
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100],
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, POWER.energy << 24],
    [UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + POWER.energy, 100],
    [UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset, 62],
    [UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset + 2, 1],
  ]));
  store.flush();
  // Within one object the events follow the slot order the fields sit in, so BYTES_0 at 23 comes
  // before health at 24. The two quest words are one log update rather than two, and the energy
  // slot is UNIT_POWER whichever of the seven a unit happens to use.
  assert.deepEqual(log, ["OBJECT_CREATED", "UNIT_DISPLAY_POWER", "UNIT_HEALTH", "UNIT_POWER", "PLAYER_QUEST_LOG_UPDATE", "OBJECT_MOVED"]);

  log.length = 0;
  state.destroy(guid);
  store.flush();
  assert.deepEqual(log, ["OBJECT_DESTROYED"]);
});

test("one broken panel does not stop the others being told", () => {
  const guid = 0xf130000000000006n;
  const state = new WorldState();
  const store = new WorldStore(state);
  const errors = [];
  const reached = [];
  store.onListenerError = (error) => errors.push(error);
  store.field(guid, "UNIT_FIELD_HEALTH", () => { throw new Error("panel is broken"); });
  store.field(guid, "UNIT_FIELD_HEALTH", () => reached.push("second"));
  store.events.on("UNIT_HEALTH", () => { throw new Error("subscriber is broken"); });
  store.any(() => reached.push("any"));

  state.applyUpdate(createUnit(guid, [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 10]]));
  store.flush();

  assert.deepEqual(reached, ["second", "any"]);
  // Field subscribers are called before the named event that summarises the same change.
  assert.deepEqual(errors.map((error) => error.message), ["panel is broken", "subscriber is broken"]);
});

test("a dropped subscription stops arriving, and detaching stops all of them", () => {
  const guid = 0xf130000000000007n;
  const state = new WorldState();
  const store = new WorldStore(state);
  const seen = [];
  const stop = store.field(guid, "UNIT_FIELD_HEALTH", () => seen.push("field"));
  store.any(() => seen.push("any"));

  state.applyUpdate(createUnit(guid, [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 10]]));
  store.flush();
  assert.deepEqual(seen, ["field", "any"]);

  stop();
  state.applyUpdate(values(guid, [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 9]]));
  store.flush();
  assert.deepEqual(seen, ["field", "any", "any"]);

  store.detach();
  state.applyUpdate(values(guid, [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 8]]));
  store.flush();
  assert.deepEqual(seen, ["field", "any", "any"]);
  assert.equal(state.objects.get(guid).fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset), 8, "the state itself keeps working");
});

test("a whole-object subscription hears one call a frame, whatever changed", () => {
  const guid = 0xf130000000000008n;
  const state = new WorldState();
  const store = new WorldStore(state);
  const calls = [];
  store.object(SELF, (object, subject) => calls.push(object === undefined ? "gone" : subject));

  // Arrival, a movement block and two fields, all in one frame: the panel is woken once.
  state.applyUpdate(createUnit(guid, [
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100],
    [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 3],
  ]));
  store.flush();
  // Once because the character became known, once for everything that arrived with it.
  assert.deepEqual(calls, [guid, guid]);

  state.applyUpdate(values(guid, [[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 90]]));
  state.applyUpdate(values(guid, [[UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 4]]));
  store.flush();
  assert.deepEqual(calls, [guid, guid, guid]);

  state.destroy(guid);
  store.flush();
  assert.equal(calls.at(-1), "gone");
});
