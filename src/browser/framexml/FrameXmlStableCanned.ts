/**
 * The offline stable master: a scripted world that records every stable command, for
 * `CannedWorldSeam`, its tests and the `?npc=stable` preview.
 *
 * The list has SendStablePet's shape (NPCHandler.cpp:354-416): the pet that is out first with flag
 * 1, then the stabled ones with flag 2; two of three bought slots are taken. The pet that is out
 * matches the canned seam's own pet (CANNED_PET: «Боевой питомец», level 60). The creature entries
 * are real beasts of the four families below (the creature dump's rows 69, 681, 30); the families'
 * names, icons and talent trees are this fixture's, in the client's ruRU wording, not read from DBC.
 */
import {
  STABLED_PET_ACTIVE, STABLED_PET_STABLED, isStableSuccess, stableResultText, type StableList,
} from "../../world/StableProtocol.js";
import { FrameXmlStableModel, type FrameXmlStableWorld } from "./FrameXmlStable.js";

export const FRAMEXML_CANNED_STABLE_MASTER_GUID = 0xF1300000E3000401n;
/** The canned player (the same low guid the charter fixture uses). */
export const FRAMEXML_CANNED_STABLE_SELF = 0x0000000000000011n;

const WOLF = 69;
const TIGER = 681;
const SPIDER = 30;

export const FRAMEXML_CANNED_STABLE_LIST: StableList = Object.freeze({
  npcGuid: FRAMEXML_CANNED_STABLE_MASTER_GUID,
  stableSlots: 3,
  pets: [
    Object.freeze({ petNumber: 7, creatureId: WOLF, level: 60, name: "Боевой питомец", flags: STABLED_PET_ACTIVE }),
    Object.freeze({ petNumber: 3, creatureId: TIGER, level: 42, name: "Полосатик", flags: STABLED_PET_STABLED }),
    Object.freeze({ petNumber: 5, creatureId: SPIDER, level: 18, name: "Паучок", flags: STABLED_PET_STABLED }),
  ],
});

/** Family, its name, icon and talent tree per canned entry. */
const FAMILIES = new Map<number, number>([[WOLF, 1], [TIGER, 2], [SPIDER, 3]]);
const FAMILY_FACTS = new Map<number, { name: string; icon: string; talent: string }>([
  [1, { name: "Волк", icon: "Interface\\Icons\\Ability_Hunter_Pet_Wolf", talent: "Свирепость" }],
  [2, { name: "Кошка", icon: "Interface\\Icons\\Ability_Hunter_Pet_Cat", talent: "Свирепость" }],
  [3, { name: "Паук", icon: "Interface\\Icons\\Ability_Hunter_Pet_Spider", talent: "Хитрость" }],
]);

/** The canned `StableSlotPrices.dbc` prices, row `owned + 1` (copper). */
const SLOT_PRICES = [500, 5000, 50000, 100000];

type Listener = () => void;

class CannedEvents {
  readonly #listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, set = new Set());
    set.add(listener);
    return () => { set?.delete(listener); };
  }
  emit(event: string): void {
    for (const listener of [...this.#listeners.get(event) ?? []]) listener();
  }
}

export type FrameXmlCannedStableCall =
  | { readonly kind: "stable" | "buy" }
  | { readonly kind: "unstable" | "swap"; readonly petNumber: number };

/** `WorldClient`'s stable fields and commands. Commands only record; `open`/`answer` play the server. */
export class FrameXmlCannedStableWorld implements FrameXmlStableWorld {
  readonly events = new CannedEvents();
  readonly calls: FrameXmlCannedStableCall[] = [];
  readonly state = { selfGuid: FRAMEXML_CANNED_STABLE_SELF };
  stable: StableList | undefined;
  stableMasterGuid = 0n;
  stableMessage: { text: string; error: boolean } | undefined;
  /** Entries whose creature template has not answered yet. */
  readonly uncached = new Set<number>();

  /** `MSG_LIST_STABLED_PETS` from the stable master (or any other list). */
  open(list: StableList = FRAMEXML_CANNED_STABLE_LIST): void {
    this.stable = list;
    this.stableMasterGuid = list.npcGuid;
    this.events.emit("STABLE_CHANGED");
  }

  /** `SMSG_STABLE_RESULT`, and on success the list asked for again. */
  answer(result: number, list?: StableList): void {
    this.stableMessage = { text: stableResultText(result), error: !isStableSuccess(result) };
    this.events.emit("STABLE_CHANGED");
    if (list && isStableSuccess(result)) this.open(list);
  }

  /** A creature template lands (`QUERY_CACHE_CHANGED`). */
  cacheCreature(entry: number): void {
    this.uncached.delete(entry);
    this.events.emit("QUERY_CACHE_CHANGED");
  }

  stablePet(): void { this.calls.push({ kind: "stable" }); }
  unstablePet(petNumber: number): void { this.calls.push({ kind: "unstable", petNumber }); }
  swapStabledPet(petNumber: number): void { this.calls.push({ kind: "swap", petNumber }); }
  buyStableSlot(): void { this.calls.push({ kind: "buy" }); }
}

/** The canned stable model over one scripted world. */
export function createCannedFrameXmlStable(): { readonly world: FrameXmlCannedStableWorld; readonly model: FrameXmlStableModel } {
  const world = new FrameXmlCannedStableWorld();
  const model = new FrameXmlStableModel({
    world: () => world,
    creatureFamily: (entry) => world.uncached.has(entry) ? undefined : FAMILIES.get(entry),
    familyIcon: (family) => FAMILY_FACTS.get(family)?.icon,
    familyName: (family) => FAMILY_FACTS.get(family)?.name,
    talentTree: (family) => FAMILY_FACTS.get(family)?.talent,
    petEntry: () => WOLF,
    stableSlotPrice: (owned) => SLOT_PRICES[owned],
  });
  return { world, model };
}
