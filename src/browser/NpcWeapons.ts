// What a creature holds in its hands (plan item 6.02, line A7a slice B, 05.10).
//
// `UNIT_VIRTUAL_ITEM_SLOT_ID` is three words — main hand, off hand, ranged — and each is an item
// *entry* (`gateway/NpcWeapons.ts` says where the server writes them and why the entry is read
// through `Item.dbc`). They become slots 15, 16 and 17, the same equipment slots a player's visible
// items use, so `Attachment.ts` hangs them and `weaponPose` swings them exactly as it does a
// player's. The models come from `/dbc/npc-weapons`; the result rides `UnitModel.held`, beside and
// not inside `appearance`, because most armed creatures (ogres, kobolds, murlocs with spears) wear
// no character model and have no appearance to put it in.
//
// Per-frame cost: `withVirtualWeapons` runs for every creature every time its model is asked for.
// A creature whose three words are zero costs three field reads and returns the record it was
// given; an armed one costs a WeakMap read and a few compares while nothing changed. A new record
// is made only when the words, the display record or an answer change.

import type { AttachedModel } from "../gateway/CharacterAppearance.js";
import type { NpcWeapon } from "../gateway/NpcWeapons.js";
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { WorldObjectState } from "../world/WorldState.js";
import { IMAGE_RETRY_BACKOFF_MS } from "./CharacterAtlas.js";
import type { UnitModel } from "./CreatureModelClient.js";

/** `/dbc/npc-weapons?v=`: the shape of the answer, separated from older deployments. */
export const NPC_WEAPONS_VERSION = 1;
/** What the route accepts in one request (`gateway/NpcWeapons.ts` NPC_WEAPONS_MAX_ENTRIES). */
const ENTRIES_PER_REQUEST = 200;

const VIRTUAL_ITEM_FIRST = UPDATE_FIELDS.UNIT_VIRTUAL_ITEM_SLOT_ID.offset;
/** EQUIPMENT_SLOT_MAINHAND, OFFHAND, RANGED: what words 0, 1 and 2 are worn as. */
export const VIRTUAL_ITEM_SLOTS: readonly number[] = [15, 16, 17];

/** One word of `UNIT_VIRTUAL_ITEM_SLOT_ID`: an item entry, or 0 for an empty hand. */
export function virtualItemEntry(object: WorldObjectState, word: number): number {
  return object.fields.get(VIRTUAL_ITEM_FIRST + word) ?? 0;
}

/** Where one entry stands: answered, being asked, waiting out a failure, or given up on. */
export type NpcWeaponState = "known" | "inflight" | "waiting" | "settled";

/**
 * Item entry → the model a creature holds, batched and remembered for the tab.
 *
 * The answer to an entry never changes within a dataset, so an entry is asked for once. A failed
 * batch is asked again on the texture ladder (`IMAGE_RETRY_BACKOFF_MS`) and then left alone; a 404
 * means a gateway that predates the route (it waits for the owner's restart), and then nothing more
 * is asked until the page is reloaded — creatures stay unarmed, exactly as before this existed.
 */
export class NpcWeaponClient {
  readonly #baseUrl: string;
  readonly #now: () => number;
  /** null: `Item.dbc` has no such entry, or it names no model. */
  readonly #known = new Map<number, NpcWeapon | null>();
  readonly #requested = new Set<number>();
  readonly #failures = new Map<number, { attempts: number; after: number }>();
  #queue: number[] = [];
  #scheduled = false;
  #absent = false;
  #generation = 0;

  /** @param origin the gateway's http(s) origin. */
  constructor(origin: string, now: () => number = Date.now) {
    this.#baseUrl = origin;
    this.#now = now;
  }

  /** Moves whenever an answer (or a failure) lands; part of every memo built over this client. */
  get generation(): number {
    return this.#generation;
  }

  /** What the gateway said about an entry: the weapon, null for none, undefined while unknown. */
  weapon(entry: number): NpcWeapon | null | undefined {
    return this.#known.get(entry);
  }

  state(entry: number): NpcWeaponState {
    if (this.#known.has(entry)) return "known";
    if (this.#absent) return "settled";
    if (this.#requested.has(entry)) return "inflight";
    const failure = this.#failures.get(entry);
    if (failure) return failure.after === Infinity ? "settled" : "waiting";
    return "inflight";
  }

  /** Asks for an entry unless it is known, already asked, or waiting out a failure. */
  request(entry: number): void {
    if (entry <= 0 || this.#absent || this.#known.has(entry) || this.#requested.has(entry)) return;
    const failure = this.#failures.get(entry);
    if (failure && this.#now() < failure.after) return;
    this.#requested.add(entry);
    this.#queue.push(entry);
    if (this.#scheduled) return;
    this.#scheduled = true;
    // One request for every entry asked during this frame, not one per creature.
    void Promise.resolve().then(() => this.#flush());
  }

  async #flush(): Promise<void> {
    this.#scheduled = false;
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, ENTRIES_PER_REQUEST);
      try {
        const response = await fetch(
          `${this.#baseUrl}/dbc/npc-weapons?v=${NPC_WEAPONS_VERSION}&entries=${batch.join(",")}`);
        if (response.status === 404) {
          // A gateway without the route: the old behaviour, quietly, until a reload.
          this.#absent = true;
          for (const entry of batch) this.#requested.delete(entry);
          this.#queue = [];
          this.#generation++;
          return;
        }
        if (!response.ok) throw new Error(`NPC weapon gateway returned ${response.status}`);
        const value: unknown = await response.json();
        if (!Array.isArray(value) || !value.every(isNpcWeapon)) throw new Error("NPC weapon gateway returned invalid data");
        const answered = new Map(value.map((weapon) => [weapon.entry, weapon]));
        for (const entry of batch) {
          const weapon = answered.get(entry);
          this.#known.set(entry, weapon && weapon.model ? weapon : null);
          this.#requested.delete(entry);
          this.#failures.delete(entry);
        }
      } catch {
        for (const entry of batch) {
          this.#requested.delete(entry);
          const attempts = (this.#failures.get(entry)?.attempts ?? 0) + 1;
          const wait = IMAGE_RETRY_BACKOFF_MS[attempts - 1];
          this.#failures.set(entry, { attempts, after: wait === undefined ? Infinity : this.#now() + wait });
        }
      }
      this.#generation++;
    }
  }
}

function isNpcWeapon(value: unknown): value is NpcWeapon {
  if (!value || typeof value !== "object") return false;
  const weapon = value as Record<string, unknown>;
  return typeof weapon.entry === "number" && typeof weapon.inventoryType === "number"
    && (weapon.subClass === undefined || typeof weapon.subClass === "number")
    && typeof weapon.model === "string" && typeof weapon.texture === "string"
    && (weapon.displayId === undefined || typeof weapon.displayId === "number") // 05.10-A7a-E2
    && (weapon.sheathe === undefined || typeof weapon.sheathe === "number"); // 05.10-A7a-G2 6.08
}

/** The held list for three entries, and whether an answer is still coming for any of them. */
export function heldWeapons(entries: readonly number[], client: NpcWeaponClient):
  { held: AttachedModel[]; pending: boolean; waiting: boolean } {
  const held: AttachedModel[] = [];
  let pending = false;
  let waiting = false;
  for (let word = 0; word < VIRTUAL_ITEM_SLOTS.length; word++) {
    const entry = entries[word] ?? 0;
    if (entry <= 0) continue;
    const weapon = client.weapon(entry);
    if (weapon === undefined) {
      client.request(entry);
      const state = client.state(entry);
      if (state === "inflight") pending = true;
      else if (state === "waiting") { pending = true; waiting = true; }
      continue;
    }
    if (weapon === null) continue;
    held.push({
      slot: VIRTUAL_ITEM_SLOTS[word]!, inventoryType: weapon.inventoryType, side: "left",
      model: weapon.model, texture: weapon.texture,
      ...(weapon.subClass === undefined ? {} : { subClass: weapon.subClass }),
      ...(weapon.displayId === undefined ? {} : { displayId: weapon.displayId }), // 05.10-A7a-E2 (6.14)
      ...(weapon.sheathe === undefined ? {} : { sheathe: weapon.sheathe }), // 05.10-A7a-G2 6.08 (SheathPoints.ts)
    });
  }
  return { held, pending, waiting };
}

interface ArmedModel {
  readonly metadata: UnitModel;
  readonly client: NpcWeaponClient;
  readonly generation: number;
  readonly main: number;
  readonly off: number;
  readonly ranged: number;
  readonly model: UnitModel;
}

/** Tied to the world object, so a creature leaving visibility takes its memo with it. */
const armedModels = new WeakMap<WorldObjectState, ArmedModel>();

/**
 * A creature's display record with what it holds: `held` (slots 15–17) and `heldPending` while an
 * answer is on its way. Unarmed creatures, and callers without a client, get the record unchanged.
 */
export function withVirtualWeapons(metadata: UnitModel, object: WorldObjectState,
  client: NpcWeaponClient | undefined): UnitModel {
  if (!client) return metadata;
  const main = virtualItemEntry(object, 0);
  const off = virtualItemEntry(object, 1);
  const ranged = virtualItemEntry(object, 2);
  if (main === 0 && off === 0 && ranged === 0) return metadata;
  const cached = armedModels.get(object);
  if (cached && cached.metadata === metadata && cached.client === client
    && cached.generation === client.generation
    && cached.main === main && cached.off === off && cached.ranged === ranged) return cached.model;
  const { held, pending, waiting } = heldWeapons([main, off, ranged], client);
  const model: UnitModel = { ...metadata, held, ...(pending ? { heldPending: true } : {}) };
  // Not remembered while an entry waits out a failure: nothing moves the generation when the wait
  // ends, and the next ask is what sends the retry.
  if (waiting) armedModels.delete(object);
  else armedModels.set(object, { metadata, client, generation: client.generation, main, off, ranged, model });
  return model;
}

const mergedAttachments = new WeakMap<UnitModel, readonly AttachedModel[]>();

/**
 * Everything hung off a unit: the worn pieces of its appearance (helmet, pauldrons, a player's
 * weapons) and a creature's held weapons. No allocation unless both lists are non-empty, and then
 * once per record.
 */
export function attachedOf(metadata: UnitModel | undefined): readonly AttachedModel[] | undefined {
  if (!metadata) return undefined;
  const worn = metadata.appearance?.attached;
  const held = metadata.held;
  if (!held || held.length === 0) return worn;
  if (!worn || worn.length === 0) return held;
  let both = mergedAttachments.get(metadata);
  if (!both) {
    both = [...worn, ...held];
    mergedAttachments.set(metadata, both);
  }
  return both;
}

/**
 * Whether a shot must still wait before it picks its weapon: no record, a player's visible items
 * still loading, a creature's weapons still being asked for — or nothing at all to read (no
 * appearance and no `held`), which is what every creature was before 6.02.
 */
export function weaponMetadataPending(metadata: UnitModel | undefined): boolean {
  if (metadata === undefined) return true;
  if (metadata.appearancePending === true || metadata.heldPending === true) return true;
  return metadata.appearance === undefined && metadata.held === undefined;
}
