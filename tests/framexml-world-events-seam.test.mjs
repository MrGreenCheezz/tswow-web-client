// Plan item 3.22 (b–d): PET_ATTACK_START/STOP (Wow.exe 0x73c330 → 0x5d30a0), CHARACTER_POINTS_CHANGED
// (0x5e8330), COMBAT_RATING_UPDATE (0x6cddf0), PARTY_LOOT_METHOD_CHANGED (0x6d8870 → 0x52bd90) and
// UNIT_PET_EXPERIENCE, each from the field or packet the client fires it from.
import assert from "node:assert/strict";
import test from "node:test";

const {
  FrameXmlWorldEvents, UNIT_FLAG_PET_IN_COMBAT,
} = await import("../dist/code/browser/framexml/FrameXmlWorldEvents.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const offset = (name) => UPDATE_FIELDS[name].offset;

/** A store double: named field subscriptions, the per-flush `any`, and the UNIT_FLAGS event. */
class FakeStore {
  fields = new Map();
  anys = new Set();
  flags = new Set();
  subscriptions = 0;
  #add(key, listener) {
    const set = this.fields.get(key) ?? new Set();
    set.add(listener);
    this.fields.set(key, set);
    this.subscriptions += 1;
    return () => { set.delete(listener); this.subscriptions -= 1; };
  }
  field(subject, name, listener) { return this.#add(offset(name), listener); }
  fieldRange(subject, name, listener) {
    const offs = [];
    for (let i = 0; i < (UPDATE_FIELDS[name].size ?? 1); i += 1) offs.push(this.#add(offset(name) + i, listener));
    return () => offs.forEach((off) => off());
  }
  any(listener) { this.anys.add(listener); this.subscriptions += 1; return () => { this.anys.delete(listener); this.subscriptions -= 1; }; }
  events = { on: (name, listener) => { this.flags.add(listener); this.subscriptions += 1; return () => { this.flags.delete(listener); this.subscriptions -= 1; }; } };
  /** One flush: each changed word's listeners, then `any`. */
  flush(object, changes) {
    for (const [key, value] of changes) object.fields.set(key, value);
    for (const [key] of changes) for (const listener of this.fields.get(key) ?? []) listener(object, object.guid);
    for (const listener of this.anys) listener();
  }
  unitFlags(guid) { for (const listener of this.flags) listener({ guid }); }
}

function fixture() {
  const self = { guid: 0x0000000200000010n, fields: new Map() };
  const pet = { guid: 0xf140000000000abcn, fields: new Map() };
  const stranger = { guid: 0xf140000000000def0n, fields: new Map() };
  const setGuid = (object, name, guid) => {
    object.fields.set(offset(name), Number(guid & 0xffffffffn));
    object.fields.set(offset(name) + 1, Number(guid >> 32n));
  };
  setGuid(pet, "UNIT_FIELD_SUMMONEDBY", self.guid);
  setGuid(stranger, "UNIT_FIELD_SUMMONEDBY", 0x99n);
  const objects = new Map([[self.guid, self], [pet.guid, pet], [stranger.guid, stranger]]);
  const world = { group: undefined, petGuid: pet.guid };
  const fired = [];
  const events = new FrameXmlWorldEvents({
    self: () => self,
    object: (guid) => objects.get(guid),
    pet: () => (world.petGuid === undefined ? undefined : objects.get(world.petGuid)),
    group: () => world.group,
  });
  const store = new FakeStore();
  events.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } }, store);
  return { self, pet, stranger, world, fired, events, store, setGuid };
}

test("PET_ATTACK_START/STOP follow UNIT_FLAG_PET_IN_COMBAT of the player's pet, and only its", () => {
  const { pet, stranger, store, fired, self, setGuid } = fixture();
  pet.fields.set(offset("UNIT_FIELD_FLAGS"), UNIT_FLAG_PET_IN_COMBAT | 0x8);
  store.unitFlags(pet.guid);
  store.unitFlags(pet.guid);
  assert.deepEqual(fired, [["PET_ATTACK_START"]], "once per flip");
  pet.fields.set(offset("UNIT_FIELD_FLAGS"), 0x8);
  store.unitFlags(pet.guid);
  assert.deepEqual(fired.at(-1), ["PET_ATTACK_STOP"]);
  stranger.fields.set(offset("UNIT_FIELD_FLAGS"), UNIT_FLAG_PET_IN_COMBAT);
  store.unitFlags(stranger.guid);
  assert.equal(fired.length, 2, "another player's pet is not ours");
  // A unit the player charms counts though it was summoned by someone else.
  setGuid(stranger, "UNIT_FIELD_CHARMEDBY", self.guid);
  store.unitFlags(stranger.guid);
  assert.deepEqual(fired.at(-1), ["PET_ATTACK_START"]);
});

test("CHARACTER_POINTS_CHANGED carries both words' differences, once per change", () => {
  const { self, store, fired } = fixture();
  store.flush(self, [[offset("PLAYER_CHARACTER_POINTS1"), 1]]);
  assert.deepEqual(fired, [["CHARACTER_POINTS_CHANGED", 1, 0]]);
  store.flush(self, [[offset("PLAYER_CHARACTER_POINTS1"), 0], [offset("PLAYER_CHARACTER_POINTS2"), 2]]);
  assert.deepEqual(fired.at(-1), ["CHARACTER_POINTS_CHANGED", -1, 2]);
  assert.equal(fired.length, 2, "two words in one update are one event");
  store.flush(self, [[offset("PLAYER_CHARACTER_POINTS2"), 2]]);
  assert.equal(fired.length, 2, "the same value is no change");
});

test("COMBAT_RATING_UPDATE on any rating word or the shield block, once per update", () => {
  const { self, store, fired } = fixture();
  const base = offset("PLAYER_FIELD_COMBAT_RATING_1");
  store.flush(self, [[base + 24, 30], [base + 5, 12]]);
  assert.deepEqual(fired, [["COMBAT_RATING_UPDATE"]]);
  store.flush(self, [[offset("PLAYER_SHIELD_BLOCK"), 40]]);
  assert.equal(fired.length, 2);
  store.flush(self, [[base + 24, 30]]);
  assert.equal(fired.length, 2);
  store.flush(self, [[base, 7]]);
  assert.equal(fired.length, 3, "the first rating word counts too");
});

test("PARTY_LOOT_METHOD_CHANGED: the first list of a group, then a changed method, looter or threshold", () => {
  const { world, events, fired } = fixture();
  events.groupChanged();
  assert.equal(fired.length, 0, "no group, nothing");
  world.group = { lootMethod: 3, masterLooterGuid: 0n, lootThreshold: 2 };
  events.groupChanged();
  assert.deepEqual(fired, [["PARTY_LOOT_METHOD_CHANGED"]]);
  events.groupChanged();
  assert.equal(fired.length, 1, "the same settings, nothing");
  world.group = { lootMethod: 2, masterLooterGuid: 0x10n, lootThreshold: 2 };
  events.groupChanged();
  world.group = { lootMethod: 2, masterLooterGuid: 0x10n, lootThreshold: 3 };
  events.groupChanged();
  assert.equal(fired.length, 3);
  world.group = undefined;
  events.groupChanged();
  world.group = { lootMethod: 2, masterLooterGuid: 0x10n, lootThreshold: 3 };
  events.groupChanged();
  assert.equal(fired.length, 4, "a new group's first list tells again");
});

test("UNIT_PET_EXPERIENCE when the same pet's experience moves; a new pet is not an experience change", () => {
  const { pet, self, store, fired, world } = fixture();
  store.flush(pet, [[offset("UNIT_FIELD_PETEXPERIENCE"), 100], [offset("UNIT_FIELD_PETNEXTLEVELEXP"), 1000]]);
  assert.deepEqual(fired, [["UNIT_PET_EXPERIENCE", "pet"]]);
  store.flush(self, [[offset("UNIT_FIELD_HEALTH"), 5]]);
  assert.equal(fired.length, 1, "an unrelated flush is quiet");
  world.petGuid = undefined;
  store.flush(self, []);
  world.petGuid = pet.guid;
  store.flush(self, []);
  assert.equal(fired.length, 1, "dismissed and called again: UNIT_PET's edge, not this one");
});

test("detach removes every subscription", () => {
  const { events, store, fired, pet } = fixture();
  assert.ok(store.subscriptions > 0);
  events.detach();
  assert.equal(store.subscriptions, 0);
  pet.fields.set(offset("UNIT_FIELD_FLAGS"), UNIT_FLAG_PET_IN_COMBAT);
  store.unitFlags(pet.guid);
  assert.equal(fired.length, 0);
});
