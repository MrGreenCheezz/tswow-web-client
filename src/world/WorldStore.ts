import { UPDATE_FIELDS, type UpdateFieldName } from "../generated/updateFields.js";
import { EventBus, type Unsubscribe, type WorldEvents } from "./EventBus.js";
import { EXPLORED_ZONES_WORDS, QUEST_LOG_SLOTS } from "./Fields.js";
import type { StateObserver, WorldObjectState, WorldState } from "./WorldState.js";

/** Stands for the controlled character, which has no guid yet when a panel subscribes. */
export const SELF = "self";
export type Subject = bigint | typeof SELF;

/** Inner key for "this object changed at all", as opposed to one named field of it. */
const ANY_FIELD = -1;

export type StoreListener = (object: WorldObjectState | undefined, guid: bigint | undefined) => void;

/**
 * Which event a field carries. A field with no entry still reaches field subscribers; it just has
 * no name of its own worth announcing.
 */
const FIELD_EVENTS: ReadonlyArray<readonly [UpdateFieldName, keyof WorldEvents]> = [
  ["UNIT_FIELD_HEALTH", "UNIT_HEALTH"],
  ["UNIT_FIELD_MAXHEALTH", "UNIT_MAX_HEALTH"],
  ["UNIT_FIELD_LEVEL", "UNIT_LEVEL"],
  ["UNIT_FIELD_TARGET", "UNIT_TARGET"],
  ["UNIT_FIELD_DISPLAYID", "UNIT_DISPLAY_ID"],
  ["UNIT_FIELD_FLAGS", "UNIT_FLAGS"],
  ["UNIT_DYNAMIC_FLAGS", "UNIT_DYNAMIC_FLAGS"],
  ["UNIT_NPC_FLAGS", "UNIT_NPC_FLAGS"],
  ["UNIT_FIELD_FACTIONTEMPLATE", "UNIT_FACTION"],
  // Which power a unit shows is a byte of BYTES_0, so a change to it can mean the bar itself
  // changed colour and scale. Race, class and gender share the word and do not move afterwards.
  ["UNIT_FIELD_BYTES_0", "UNIT_DISPLAY_POWER"],
  ["PLAYER_XP", "PLAYER_XP"],
  ["PLAYER_NEXT_LEVEL_XP", "PLAYER_XP"],
  ["PLAYER_FIELD_COINAGE", "PLAYER_MONEY"],
  ["GAMEOBJECT_BYTES_1", "GAMEOBJECT_STATE"],
  // The two tracking masks. Nothing announces them; they simply appear in the player's fields.
  ["PLAYER_TRACK_CREATURES", "PLAYER_TRACK_CREATURES"],
  ["PLAYER_TRACK_RESOURCES", "PLAYER_TRACK_RESOURCES"],
];

function buildFieldEvents(): Map<number, keyof WorldEvents> {
  const events = new Map<number, keyof WorldEvents>();
  for (const [name, event] of FIELD_EVENTS) {
    const field = UPDATE_FIELDS[name] as { offset: number; size: number };
    // A LONG occupies two slots and either of them can arrive alone.
    for (let slot = 0; slot < field.size; slot++) events.set(field.offset + slot, event);
  }
  // The seven power slots and the seven maximums are one event each, whichever one a unit uses.
  for (let power = 0; power < 7; power++) {
    events.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + power, "UNIT_POWER");
    events.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + power, "UNIT_MAX_POWER");
  }
  // 25 quest slots of 5 words: one event for the log rather than 125 for its words.
  const questStride = UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  for (let slot = 0; slot < QUEST_LOG_SLOTS * questStride; slot++) {
    events.set(UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset + slot, "PLAYER_QUEST_LOG_UPDATE");
  }
  // The exploration mask the same way: 128 words under one name. Naming only the first would
  // subscribe a map to areas 0 to 31 and leave the other 4,064 silent.
  for (let word = 0; word < EXPLORED_ZONES_WORDS; word++) {
    events.set(UPDATE_FIELDS.PLAYER_EXPLORED_ZONES_1.offset + word, "PLAYER_EXPLORED_ZONES");
  }
  return events;
}

const FIELD_EVENT_BY_INDEX = buildFieldEvents();

/**
 * Turns the world state into something a panel can subscribe to.
 *
 * Today one function redraws every panel whenever any object changes, because that is the only
 * shape `onStateChange` allows: it hands over the whole state and says "something happened". With
 * 125 interface features still to build, each of which cares about one or two fields, that becomes
 * a full rebuild of the interface several times a second.
 *
 * Changes are collected as they arrive and delivered once per frame from `flush`, so a burst of
 * update blocks in one packet — and a packet can carry hundreds — costs each panel one call.
 */
export class WorldStore implements StateObserver {
  readonly events = new EventBus<WorldEvents>();

  /** Reported rather than thrown, for the reason `EventBus` gives. */
  onListenerError: ((error: unknown) => void) | undefined;

  readonly #subjects = new Map<Subject, Map<number, Set<StoreListener>>>();
  readonly #changedFields = new Map<bigint, Set<number>>();
  readonly #created = new Map<bigint, number | undefined>();
  readonly #destroyed = new Set<bigint>();
  readonly #moved = new Set<bigint>();
  #selfChanged = false;
  #anyChange = false;
  readonly #anyListeners = new Set<() => void>();

  constructor(readonly state: WorldState) {
    state.observer = this;
    this.events.onListenerError = (_name, error) => this.onListenerError?.(error);
  }

  /** Stops watching. The state keeps working; nothing is recorded for it any more. */
  detach(): void {
    if (this.state.observer === this) this.state.observer = undefined;
    this.#subjects.clear();
    this.#anyListeners.clear();
    this.events.clear();
    this.#discard();
  }

  /** Calls back when one named field of one object changes. `SELF` follows the character. */
  field(subject: Subject, name: UpdateFieldName, listener: StoreListener): Unsubscribe {
    return this.#subscribe(subject, UPDATE_FIELDS[name].offset, listener);
  }

  /**
   * Calls back when any word in one named array field changes. Scalar `field` subscriptions remain
   * intentionally cheap; array consumers such as PLAYER_SKILL_INFO_1_1 need the complete range or
   * an update in a later slot would be invisible to them.
   */
  fieldRange(subject: Subject, name: UpdateFieldName, listener: StoreListener): Unsubscribe {
    const field = UPDATE_FIELDS[name];
    const unsubscriptions: Unsubscribe[] = [];
    for (let offset = 0; offset < (field.size ?? 1); offset++) {
      unsubscriptions.push(this.#subscribe(subject, field.offset + offset, listener));
    }
    return () => {
      for (const unsubscribe of unsubscriptions) unsubscribe();
    };
  }

  /** Calls back when anything about one object changes, including its arrival and its removal. */
  object(subject: Subject, listener: StoreListener): Unsubscribe {
    return this.#subscribe(subject, ANY_FIELD, listener);
  }

  /**
   * Calls back once per frame in which anything at all changed. This is the old whole-interface
   * redraw, kept so panels can be moved off it one at a time rather than all at once.
   */
  any(listener: () => void): Unsubscribe {
    this.#anyListeners.add(listener);
    return () => this.#anyListeners.delete(listener);
  }

  fieldsChanged(guid: bigint, indices: readonly number[]): void {
    if (indices.length === 0) return;
    let changed = this.#changedFields.get(guid);
    if (!changed) {
      changed = new Set();
      this.#changedFields.set(guid, changed);
    }
    for (const index of indices) changed.add(index);
    this.#anyChange = true;
  }

  objectCreated(guid: bigint, typeId: number | undefined): void {
    // A guid can be created implicitly and then properly, and only the second call knows its type.
    if (typeId !== undefined || !this.#created.has(guid)) this.#created.set(guid, typeId);
    this.#destroyed.delete(guid);
    this.#anyChange = true;
  }

  objectDestroyed(guid: bigint): void {
    this.#created.delete(guid);
    this.#changedFields.delete(guid);
    this.#moved.delete(guid);
    this.#destroyed.add(guid);
    this.#anyChange = true;
  }

  objectMoved(guid: bigint): void {
    this.#moved.add(guid);
    this.#anyChange = true;
  }

  selfChanged(): void {
    this.#selfChanged = true;
    this.#anyChange = true;
  }

  /** Delivers everything collected since the last call. Meant for once per animation frame. */
  flush(): void {
    if (!this.#anyChange) return;
    const created = [...this.#created];
    const destroyed = [...this.#destroyed];
    const moved = [...this.#moved];
    const changedFields = [...this.#changedFields].map(([guid, indices]) => [guid, [...indices]] as const);
    const selfChanged = this.#selfChanged;
    this.#discard();

    if (selfChanged) this.#emit("PLAYER_ENTERING_WORLD", { guid: this.state.selfGuid });
    for (const [guid, typeId] of created) this.#emit("OBJECT_CREATED", { guid, typeId });

    // Whoever watches a whole object is told once, however many of these reasons applied to it.
    const touched = new Set<bigint>(created.map(([guid]) => guid));

    for (const [guid, indices] of changedFields) {
      const names = new Set<keyof WorldEvents>();
      for (const index of indices) {
        const event = FIELD_EVENT_BY_INDEX.get(index);
        if (event) names.add(event);
        this.#notify(guid, index);
      }
      for (const name of names) this.#emit(name, { guid });
      touched.add(guid);
    }

    for (const guid of moved) {
      this.#emit("OBJECT_MOVED", { guid });
      touched.add(guid);
    }
    for (const guid of touched) this.#notify(guid, ANY_FIELD);
    for (const guid of destroyed) {
      this.#emit("OBJECT_DESTROYED", { guid });
      this.#notify(guid, ANY_FIELD);
    }
    // A new character means every SELF subscription is now watching a different object.
    if (selfChanged) this.#notifySelf();

    for (const listener of [...this.#anyListeners]) {
      // Inlined rather than wrapped: a closure per listener per flush was pure garbage, and the
      // error contract (report, never throw out of the loop) is exactly what the wrapper did.
      try {
        listener();
      } catch (error) {
        this.onListenerError?.(error);
      }
    }
  }

  #subscribe(subject: Subject, index: number, listener: StoreListener): Unsubscribe {
    let fields = this.#subjects.get(subject);
    if (!fields) {
      fields = new Map();
      this.#subjects.set(subject, fields);
    }
    let listeners = fields.get(index);
    if (!listeners) {
      listeners = new Set();
      fields.set(index, listeners);
    }
    listeners.add(listener);
    return () => {
      const fields = this.#subjects.get(subject);
      const current = fields?.get(index);
      current?.delete(listener);
      // An empty field set is unobservable, and so is an empty subject: drop both so a raid
      // night of add waves does not leave one empty Map per guid behind after unsubscribing.
      if (current?.size === 0) fields?.delete(index);
      if (fields?.size === 0) this.#subjects.delete(subject);
    };
  }

  /** Everyone watching this guid for this field, plus everyone watching the character for it. */
  #notify(guid: bigint, index: number): void {
    const own = this.#listeners(guid, index);
    // Nobody watching is the common case — every changed word of every object in view comes
    // through here — and it returns before the object lookup and without an array to walk.
    if (own === undefined && (guid !== this.state.selfGuid || !this.#subjects.get(SELF)?.has(index))) return;
    const object = this.state.objects.get(guid);
    if (own) {
      for (const listener of own) {
        try {
          listener(object, guid);
        } catch (error) {
          this.onListenerError?.(error);
        }
      }
    }
    if (guid !== this.state.selfGuid) return;
    const self = this.#listeners(SELF, index);
    if (!self) return;
    for (const listener of self) {
      try {
        listener(object, guid);
      } catch (error) {
        this.onListenerError?.(error);
      }
    }
  }

  #notifySelf(): void {
    const guid = this.state.selfGuid;
    const object = guid === undefined ? undefined : this.state.objects.get(guid);
    const fields = this.#subjects.get(SELF);
    if (!fields) return;
    for (const listeners of [...fields.values()]) {
      for (const listener of [...listeners]) {
        try {
          listener(object, guid);
        } catch (error) {
          this.onListenerError?.(error);
        }
      }
    }
  }

  /**
   * A copy, because a listener may unsubscribe itself while the loop runs; `undefined` when nobody
   * watches, rather than an empty array per (guid, field) of every flush.
   */
  #listeners(subject: Subject, index: number): StoreListener[] | undefined {
    const listeners = this.#subjects.get(subject)?.get(index);
    return listeners ? [...listeners] : undefined;
  }

  #emit<Name extends keyof WorldEvents>(name: Name, payload: WorldEvents[Name]): void {
    this.events.emit(name, payload);
  }

  #discard(): void {
    this.#changedFields.clear();
    this.#created.clear();
    this.#destroyed.clear();
    this.#moved.clear();
    this.#selfChanged = false;
    this.#anyChange = false;
  }
}
