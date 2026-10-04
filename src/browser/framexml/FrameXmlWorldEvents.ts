/**
 * Plan item 3.22 (b–d): world events the stock UI registers and this seam did not publish, each
 * from the source Wow.exe fires it from.
 *
 * - `PET_ATTACK_START` / `PET_ATTACK_STOP` (PetFrame.lua:21-22, :86-89): Wow.exe's UNIT_FIELD_FLAGS
 *   change handler (0x73c330) signals event 0x140/0x141 (0x5d30a0) when `UNIT_FLAG_PET_IN_COMBAT`
 *   (0x800) flips on a unit charmed by — or, with no charmer, summoned by — the active player. The
 *   core sets that flag while a player's pet chases a target (PetAI.cpp:405, :415).
 * - `CHARACTER_POINTS_CHANGED(delta1, delta2)` (PaperDollFrame.lua:119): the field callback 0x5e8330,
 *   registered on the player's PLAYER_CHARACTER_POINTS1..2 (0x5e8488), signals 0xf6 with the new
 *   minus the old value of each word.
 * - `COMBAT_RATING_UPDATE` (PaperDollFrame.lua:134, :197): the callback 0x6cddf0, registered on the 25
 *   PLAYER_FIELD_COMBAT_RATING_1 words and on PLAYER_SHIELD_BLOCK (0x6e5777, 0x6e579a), signals 0x208
 *   with no argument.
 * - `PARTY_LOOT_METHOD_CHANGED` (PlayerFrame.lua:25, PartyMemberFrame.lua:85): the group list handler
 *   (0x6d8870) hands the loot method, master looter and threshold to 0x52bd90, which queues event
 *   0xb9 when any of the three changed or the list is the first of a group.
 * - `UNIT_PET_EXPERIENCE` (PetPaperDollFrame.lua:11, :136 — the handler reads no argument): when the
 *   pet's UNIT_FIELD_PETEXPERIENCE or UNIT_FIELD_PETNEXTLEVELEXP moves; the unit argument is "pet",
 *   the unit whose fields changed (the client's own firing site was not traced).
 *
 * Several words of one callback's range changing in one update are one event in the client; here
 * every word's store callback compares the whole range with what was last told, so a burst is one
 * event as well.
 */

import { readField } from "../../world/Fields.js";
import { UPDATE_FIELDS, type UpdateFieldName } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

export const PET_ATTACK_START = "PET_ATTACK_START";
export const PET_ATTACK_STOP = "PET_ATTACK_STOP";
export const CHARACTER_POINTS_CHANGED = "CHARACTER_POINTS_CHANGED";
export const COMBAT_RATING_UPDATE = "COMBAT_RATING_UPDATE";
export const PARTY_LOOT_METHOD_CHANGED = "PARTY_LOOT_METHOD_CHANGED";
export const UNIT_PET_EXPERIENCE = "UNIT_PET_EXPERIENCE";

/** `UNIT_FLAG_PET_IN_COMBAT` (UnitDefines.h). */
export const UNIT_FLAG_PET_IN_COMBAT = 0x800;

const SELF = "self";
const RATING_WORDS = 25;

export interface FrameXmlWorldEventsPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** The part of WorldStore the events listen to. */
export interface FrameXmlWorldEventsStore {
  field?(subject: typeof SELF, name: UpdateFieldName, listener: () => void): () => void;
  fieldRange?(subject: typeof SELF, name: UpdateFieldName, listener: () => void): () => void;
  any?(listener: () => void): () => void;
  readonly events?: {
    on(name: "UNIT_FLAGS", listener: (payload: { guid: bigint }) => void): () => void;
  } | undefined;
}

export interface FrameXmlWorldEventsContext {
  readonly self: () => WorldObjectState | undefined;
  readonly object: (guid: bigint) => WorldObjectState | undefined;
  /** The player's pet (the pet bar's guid), for its experience. */
  readonly pet: () => WorldObjectState | undefined;
  readonly group: () => { lootMethod: number; masterLooterGuid: bigint; lootThreshold: number } | undefined;
}

const CHARMEDBY = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
const SUMMONEDBY = UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset;

/** Whether a guid field names the player: word by word, so a crowd's flag changes allocate nothing. */
function namesPlayer(object: WorldObjectState, offset: number, low: number, high: number): boolean {
  return ((object.fields.get(offset) ?? 0) >>> 0) === low && ((object.fields.get(offset + 1) ?? 0) >>> 0) === high;
}

function isZero(object: WorldObjectState, offset: number): boolean {
  return (object.fields.get(offset) ?? 0) === 0 && (object.fields.get(offset + 1) ?? 0) === 0;
}

export class FrameXmlWorldEvents {
  readonly #context: FrameXmlWorldEventsContext;
  #pump: FrameXmlWorldEventsPump | undefined;
  readonly #unsubscribe: (() => void)[] = [];
  readonly #petCombat = new Map<bigint, boolean>();
  #points: readonly [number, number] = [0, 0];
  /** PLAYER_SHIELD_BLOCK, then the 25 rating words, as last told (NaN: not present). */
  readonly #ratings = new Float64Array(RATING_WORDS + 1).fill(Number.NaN);
  #petGuid: bigint | undefined;
  #petXp: number | undefined;
  #petNext: number | undefined;
  #loot: string | undefined;
  #selfGuid: bigint | undefined;
  #selfLow = 0;
  #selfHigh = 0;

  constructor(context: FrameXmlWorldEventsContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlWorldEventsPump, store: FrameXmlWorldEventsStore | undefined): void {
    this.detach();
    this.#pump = pump;
    this.#points = this.#readPoints();
    this.#readRatings();
    this.#rememberPet();
    this.#loot = this.#readLoot();
    if (!store) return;
    if (store.field) {
      const points = (): void => this.#pointsChanged();
      this.#unsubscribe.push(store.field(SELF, "PLAYER_CHARACTER_POINTS1", points));
      this.#unsubscribe.push(store.field(SELF, "PLAYER_CHARACTER_POINTS2", points));
      this.#unsubscribe.push(store.field(SELF, "PLAYER_SHIELD_BLOCK", () => this.#ratingsChanged()));
    }
    if (store.fieldRange) {
      this.#unsubscribe.push(store.fieldRange(SELF, "PLAYER_FIELD_COMBAT_RATING_1", () => this.#ratingsChanged()));
    }
    const flags = store.events?.on("UNIT_FLAGS", ({ guid }) => this.#flagsChanged(guid));
    if (flags) this.#unsubscribe.push(flags);
    if (store.any) this.#unsubscribe.push(store.any.call(store, () => this.#petExperienceChanged()));
  }

  detach(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#pump = undefined;
    this.#petCombat.clear();
  }

  /** After each group list or group change (the seam's group callback). */
  groupChanged(): void {
    const next = this.#readLoot();
    const previous = this.#loot;
    this.#loot = next;
    // Out of a group there is nothing to tell; the first list of a group always tells (0x52bd90).
    if (next === undefined || next === previous) return;
    this.#pump?.fire(PARTY_LOOT_METHOD_CHANGED);
  }

  #readLoot(): string | undefined {
    const group = this.#context.group();
    return group ? `${group.lootMethod}:${group.masterLooterGuid}:${group.lootThreshold}` : undefined;
  }

  #readPoints(): readonly [number, number] {
    const self = this.#context.self();
    return self
      ? [readField(self, "PLAYER_CHARACTER_POINTS1") ?? 0, readField(self, "PLAYER_CHARACTER_POINTS2") ?? 0]
      : [0, 0];
  }

  #pointsChanged(): void {
    const next = this.#readPoints();
    const previous = this.#points;
    if (next[0] === previous[0] && next[1] === previous[1]) return;
    this.#points = next;
    this.#pump?.fire(CHARACTER_POINTS_CHANGED, next[0] - previous[0], next[1] - previous[1]);
  }

  /** Copies the words into `#ratings` and tells whether any differed; allocates nothing. */
  #readRatings(): boolean {
    const self = this.#context.self();
    const ratings = this.#ratings;
    const base = UPDATE_FIELDS.PLAYER_FIELD_COMBAT_RATING_1.offset;
    let changed = false;
    for (let word = 0; word <= RATING_WORDS; word += 1) {
      const offset = word === 0 ? UPDATE_FIELDS.PLAYER_SHIELD_BLOCK.offset : base + word - 1;
      const value = self ? self.fields.get(offset) ?? Number.NaN : Number.NaN;
      if (!Object.is(value, ratings[word])) { ratings[word] = value; changed = true; }
    }
    return changed;
  }

  #ratingsChanged(): void {
    if (this.#readRatings()) this.#pump?.fire(COMBAT_RATING_UPDATE);
  }

  #flagsChanged(guid: bigint): void {
    const self = this.#context.self();
    const object = this.#context.object(guid);
    if (!self || !object) return;
    if (self.guid !== this.#selfGuid) {
      this.#selfGuid = self.guid;
      this.#selfLow = Number(self.guid & 0xffffffffn);
      this.#selfHigh = Number(self.guid >> 32n);
    }
    const owner = isZero(object, CHARMEDBY) ? SUMMONEDBY : CHARMEDBY;
    if (!namesPlayer(object, owner, this.#selfLow, this.#selfHigh)) return;
    const inCombat = ((readField(object, "UNIT_FIELD_FLAGS") ?? 0) & UNIT_FLAG_PET_IN_COMBAT) !== 0;
    // A unit not seen before starts from no flags, as the client's first value does.
    if ((this.#petCombat.get(guid) ?? false) === inCombat) return;
    this.#petCombat.set(guid, inCombat);
    this.#pump?.fire(inCombat ? PET_ATTACK_START : PET_ATTACK_STOP);
  }

  #rememberPet(): void {
    const pet = this.#context.pet();
    this.#petGuid = pet?.guid;
    this.#petXp = pet ? readField(pet, "UNIT_FIELD_PETEXPERIENCE") : undefined;
    this.#petNext = pet ? readField(pet, "UNIT_FIELD_PETNEXTLEVELEXP") : undefined;
  }

  /** Every store flush: two field reads of one object, nothing allocated. */
  #petExperienceChanged(): void {
    const pet = this.#context.pet();
    const guid = pet?.guid;
    const xp = pet ? readField(pet, "UNIT_FIELD_PETEXPERIENCE") : undefined;
    const next = pet ? readField(pet, "UNIT_FIELD_PETNEXTLEVELEXP") : undefined;
    if (guid === this.#petGuid && xp === this.#petXp && next === this.#petNext) return;
    const samePet = guid !== undefined && guid === this.#petGuid;
    this.#petGuid = guid;
    this.#petXp = xp;
    this.#petNext = next;
    // A pet arriving or leaving is UNIT_PET's edge, not an experience change.
    if (samePet) this.#pump?.fire(UNIT_PET_EXPERIENCE, "pet");
  }
}
