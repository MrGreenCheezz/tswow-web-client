/**
 * Plan item 3.16: the `boss1`…`bossN` unit tokens and `INSTANCE_ENCOUNTER_ENGAGE_UNIT`, which draw
 * the stock `Boss1TargetFrame`…`Boss4TargetFrame` (TargetFrame.lua:158-161, :923-947).
 *
 * Kept the way Wow.exe keeps it (handler 0x5eddd0 for `SMSG_UPDATE_INSTANCE_ENCOUNTER_UNIT`):
 *
 * - ENGAGE (0) adds the unit with the packet's priority byte, unless it is already listed
 *   (0x5ed7b0); the table has sixteen slots and a seventeenth unit is not added;
 * - DISENGAGE (1) removes a listed unit (0x5ed870); an unlisted one changes nothing;
 * - UPDATE_PRIORITY (2) sets a listed unit's priority (0x5ed930);
 * - PHASE_SHIFT_CHANGED (7) only re-sorts;
 * - after each change the list is sorted by priority, lowest first, then by previous position — a
 *   newly engaged unit goes after the others of its priority (qsort with 0x5ed5f0/0x5ed590,
 *   positions renumbered by 0x5ed750) — and event 0x295 `INSTANCE_ENCOUNTER_ENGAGE_UNIT` is
 *   signalled with no arguments. ENGAGE of a listed unit and DISENGAGE of an unlisted one signal
 *   nothing;
 * - `bossN` is the N-th entry in that order (unit-token parser 0x60abf0 → 0x5ed710), for any N up
 *   to the entries held; stock draws only four frames (`MAX_BOSS_FRAMES`).
 *
 * The list is not cleared on a world change: the client drops it only when the connection's
 * handlers go (0x5edb10). A boss left behind in another instance simply does not exist there, so
 * `UnitExists("boss1")` is false and TargetFrame_Update hides its frame.
 */

import {
  ENCOUNTER_FRAME_DISENGAGE, ENCOUNTER_FRAME_ENGAGE, ENCOUNTER_FRAME_PHASE_SHIFT_CHANGED,
  ENCOUNTER_FRAME_UPDATE_PRIORITY,
} from "../../world/InstanceProtocol.js";

/** Wow.exe allocates sixteen slots on the first ENGAGE (0x5ed7b0). */
export const FRAMEXML_ENCOUNTER_SLOTS = 16;

export const INSTANCE_ENCOUNTER_ENGAGE_UNIT = "INSTANCE_ENCOUNTER_ENGAGE_UNIT";

export interface FrameXmlEncounterFrame {
  readonly type: number;
  readonly guid: bigint | undefined;
  readonly param1: number;
}

interface Entry { guid: bigint; priority: number }

export interface FrameXmlEncountersPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

export interface FrameXmlEncountersContext {
  /** The world's event bus; the model listens to `ENCOUNTER_FRAME` while attached. */
  readonly events: () => {
    on(name: "ENCOUNTER_FRAME", listener: (frame: FrameXmlEncounterFrame) => void): () => void;
  } | undefined;
}

export class FrameXmlEncounters {
  readonly #context: FrameXmlEncountersContext | undefined;
  #entries: Entry[] = [];
  #pump: FrameXmlEncountersPump | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(context?: FrameXmlEncountersContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlEncountersPump): void {
    this.detach();
    this.#pump = pump;
    this.#unsubscribe = this.#context?.events()?.on("ENCOUNTER_FRAME", (frame) => { this.receive(frame); });
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
  }

  /** One `SMSG_UPDATE_INSTANCE_ENCOUNTER_UNIT`; returns whether the event was signalled. */
  receive(frame: FrameXmlEncounterFrame): boolean {
    const guid = frame.guid;
    const index = guid === undefined ? -1 : this.#entries.findIndex((entry) => entry.guid === guid);
    switch (frame.type) {
      case ENCOUNTER_FRAME_ENGAGE:
        if (guid === undefined || index >= 0) return false;
        // The client's slot loop finds no free slot and adds nothing, but still signals.
        if (this.#entries.length < FRAMEXML_ENCOUNTER_SLOTS) this.#entries.push({ guid, priority: frame.param1 & 0xff });
        break;
      case ENCOUNTER_FRAME_DISENGAGE:
        if (index < 0) return false;
        this.#entries.splice(index, 1);
        break;
      case ENCOUNTER_FRAME_UPDATE_PRIORITY: {
        const entry = this.#entries[index];
        if (!entry) return false;
        entry.priority = frame.param1 & 0xff;
        break;
      }
      case ENCOUNTER_FRAME_PHASE_SHIFT_CHANGED:
        break;
      default:
        return false;
    }
    // Stable: equal priorities keep their previous order, and a new unit was appended last.
    this.#entries = this.#entries
      .map((entry, position) => ({ entry, position }))
      .sort((left, right) => left.entry.priority - right.entry.priority || left.position - right.position)
      .map(({ entry }) => entry);
    this.#pump?.fire(INSTANCE_ENCOUNTER_ENGAGE_UNIT);
    return true;
  }

  /** `bossN`'s guid, 1-based; undefined past the listed units. */
  bossGuid(index: number): bigint | undefined {
    return Number.isInteger(index) && index >= 1 ? this.#entries[index - 1]?.guid : undefined;
  }

  /** `bossN`'s N for a listed unit (a unit is listed once), 0 otherwise; no allocation per unit event. */
  indexOf(guid: bigint): number {
    const entries = this.#entries;
    for (let index = 0; index < entries.length; index += 1) if (entries[index]!.guid === guid) return index + 1;
    return 0;
  }

  /** The listed units in order (a copy). */
  guids(): readonly bigint[] {
    return this.#entries.map((entry) => entry.guid);
  }

  /** The connection's handlers go (0x5edb10): the list is dropped without an event. */
  clear(): void {
    this.#entries = [];
  }
}

/** `boss<N>` → N, or undefined for any other token (case-insensitive, as the client compares). */
export function frameXmlBossTokenIndex(unit: string): number | undefined {
  const match = /^boss(\d+)$/i.exec(unit);
  if (!match) return undefined;
  const index = Number(match[1]);
  return index >= 1 ? index : undefined;
}
