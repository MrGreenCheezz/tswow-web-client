import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { fieldFloat } from "../../world/WorldState.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";

/**
 * The death knight's rune bar: RuneFrame.xml's `GetRuneType`/`GetRuneCooldown` and the two events
 * RuneFrame_OnEvent listens for, `RUNE_POWER_UPDATE(rune, usable)` and `RUNE_TYPE_UPDATE(rune)`.
 *
 * Numbering. A rune's id is the core's index plus one: `Player::ResyncRunes` writes the six in
 * index order, and RuneFrame.xml gives its buttons the ids 1, 2, 5, 6, 3, 4, which
 * RuneFrame_FixRunes turns into `RuneFrame.runes[id]` on the first PLAYER_ENTERING_WORLD. A rune's
 * type is the core's `RuneType` (blood 0, unholy 1, frost 2, death 3) plus one: RuneFrame.lua's
 * RUNETYPE_BLOOD..RUNETYPE_DEATH.
 *
 * Time. `SMSG_RESYNC_RUNES` carries, per rune, `255 - cooldown * 255 / RUNE_BASE_COOLDOWN`
 * (`Player::ResyncRunes`): the milliseconds the rune still waits, measured against the unhasted
 * ten seconds whatever its own cooldown is. The full cooldown is `1 / PLAYER_RUNE_REGEN_1[base
 * type]` seconds (`Player::UpdateRuneRegen` writes 1000 / cooldown ms there; 0.1 at base), and the
 * base type follows the index (`runeSlotTypes`: 0-1 blood, 2-3 unholy, 4-5 frost), which is also
 * the type `Player::GetRuneBaseCooldown` hastes. So a spent rune's start is `readAt + wait - duration`
 * on one clock, GetTime's: `readAt` is the GetTime second the reading came, so the start is one number
 * until the next reading and RuneButton_OnUpdate's CooldownFrame_SetTimer repaints nothing per frame.
 *
 * Ready only when the realm says so. The core counts a rune down only while the player is alive
 * (`Player::Update` runs RegenerateAll only then) and resyncs on arriving on a map, so a local
 * estimate that runs out proves nothing: the rune answers a finished sweep that still waits.
 */

/** RuneFrame_OnEvent's two events. */
export const FRAMEXML_RUNE_EVENTS = Object.freeze({
  powerUpdate: "RUNE_POWER_UPDATE",
  typeUpdate: "RUNE_TYPE_UPDATE",
});

/** `MAX_RUNES` (Player.h). */
export const FRAMEXML_RUNE_COUNT = 6;

/** `RUNE_BASE_COOLDOWN` (Player.h), in seconds: the scale of a resync's readiness byte. */
export const RUNE_BASE_COOLDOWN_SECONDS = 10;

/** A resync's readiness for a rune that is ready. */
export const RUNE_READY = 255;

/** `NUM_RUNE_TYPES`: blood, unholy, frost, death — the four icons RuneFrame.lua has. */
const RUNE_TYPES = 4;

/** `GetRuneCooldown`'s three values: GetTime seconds, seconds, and whether the rune can be spent. */
export type FrameXmlRuneCooldown = readonly [start: number, duration: number, runeReady: boolean];

/**
 * A ready rune at the base duration — the API answers the duration whether the rune waits or not;
 * `CooldownFrame_SetTimer` hides the sweep for a zero start.
 */
export const FRAMEXML_RUNE_READY: FrameXmlRuneCooldown =
  Object.freeze([0, RUNE_BASE_COOLDOWN_SECONDS, true]) as FrameXmlRuneCooldown;

/** The core's index 0..5 behind a stock rune id 1..6, or nothing for anything else. */
export function frameXmlRuneIndex(rune: number): number | undefined {
  return Number.isInteger(rune) && rune >= 1 && rune <= FRAMEXML_RUNE_COUNT ? rune - 1 : undefined;
}

/** RuneFrame.lua's 1..4 for the core's `RuneType`; a type it has no icon for is no type at all. */
export function frameXmlRuneType(coreType: number): number | undefined {
  return Number.isInteger(coreType) && coreType >= 0 && coreType < RUNE_TYPES ? coreType + 1 : undefined;
}

/** A full cooldown in seconds from the rune regen field (runes a second); the base ten without one. */
export function frameXmlRuneDuration(regen: number | undefined): number {
  return regen !== undefined && Number.isFinite(regen) && regen > 0 ? 1 / regen : RUNE_BASE_COOLDOWN_SECONDS;
}

/** The seconds a reading still waited: `Player::ResyncRunes` scales the wait to the unhasted ten. */
export function frameXmlRuneWait(readiness: number): number {
  return Math.max(0, RUNE_READY - readiness) / RUNE_READY * RUNE_BASE_COOLDOWN_SECONDS;
}

/**
 * `GetRuneCooldown` for one rune: `readiness` as the last resync said it, taken at the GetTime second
 * `readAt`; `duration` from the regen field. A function of the reading alone, so one start until the
 * next reading. Ready only when the readiness says so; a duration shorter than the wait (a field not
 * yet updated) is stretched to it, so the start is never after the reading.
 */
export function frameXmlRuneCooldown(readiness: number, readAt: number, duration: number): FrameXmlRuneCooldown {
  if (readiness >= RUNE_READY) return [0, duration, true];
  const wait = frameXmlRuneWait(readiness);
  const full = Math.max(duration, wait);
  return [readAt + wait - full, full, false];
}

/**
 * The addonsOnly mode shows the native HUD and paints only the stock frames TSWoW modules use, so
 * RuneFrame is never on screen there. It stays loaded — UnitFrame_SetUnit calls RuneFrame:SetScale
 * for a death knight unconditionally (UnitFrame.lua:64-77) — but hidden: a hidden frame's buttons
 * run no RuneButton_OnUpdate, so a spent rune costs the Lua VM nothing for a bar nobody sees, and
 * `RuneFrame:IsShown()` tells a module the truth. Nothing in the stock files shows it again;
 * RuneFrame_OnLoad is the only other Show/Hide of it. Called from the mount's `beforeExercise`, so
 * it is down before PLAYER_ENTERING_WORLD. (The native HUD has no rune bar of its own.)
 */
export function hideFrameXmlRuneFrame(boot: {
  readonly bridge: Pick<FrameXmlUiBridge, "getFrame" | "Hide">;
}): void {
  const frame = boot.bridge.getFrame("RuneFrame");
  if (frame) boot.bridge.Hide(frame);
}

/** What both rune models answer; ids are the stock 1..6. */
export interface FrameXmlRunes {
  /** `GetRuneType(id)`: 1..4, or nothing outside 1..6 or before the realm said. */
  runeType(rune: number): number | undefined;
  /** `GetRuneCooldown(id)`: nothing outside 1..6; a rune with no reading is ready. */
  runeCooldown(rune: number): FrameXmlRuneCooldown | undefined;
}

/** The WorldClient surface the live runes read; `runes` is optional so older doubles still attach. */
export type FrameXmlRunesWorld = Pick<WorldClient, "events" | "state"> & Partial<Pick<WorldClient, "runes">>;

export interface FrameXmlRunesLiveContext {
  readonly world: () => FrameXmlRunesWorld | undefined;
}

/** One rune's last reading: the record it came from, its readiness, and the GetTime second it came. */
interface RuneReading {
  readonly record: { readonly type: number; readonly readiness: number } | undefined;
  readonly readiness: number;
  readonly at: number;
}

/** What the stock frame was last told about one rune: its icon, and whether it can be spent. */
interface RuneShape {
  readonly type: number | undefined;
  readonly ready: boolean;
}

/**
 * The runes over the live WorldClient. Its three packets end in one `RUNES_CHANGED` with no payload
 * (`WorldClient.runes` is the state), so each reading is stamped here, on the synchronous event:
 * `SMSG_RESYNC_RUNES` replaces the records (every rune is read anew), `SMSG_ADD_RUNE_POWER` sets a
 * record's readiness in place (a new reading of that rune), and `SMSG_CONVERT_RUNE` changes only a
 * type (the running wait keeps its stamp). Events are edges of the shape: the resync the core sends
 * every regen tick while a rune waits changes readiness, not whether the rune is ready.
 *
 * A rune waits in Lua only once RUNE_POWER_UPDATE(id, false) hung RuneButton_OnUpdate on it. After a
 * mount none has (RuneFrame's PLAYER_ENTERING_WORLD repaints icons only, and nothing may fire before
 * RuneFrame_FixRunes runs there), so the mount seeds every rune as ready and the first unready reading
 * after it is announced; so is the first unready reading after an estimate ran out.
 */
export class FrameXmlRunesLive implements FrameXmlRunes {
  readonly #context: FrameXmlRunesLiveContext;
  #pump: FrameXmlSeamPump | undefined;
  #off: (() => void) | undefined;
  readonly #readings: (RuneReading | undefined)[] = [];
  readonly #published: RuneShape[] = [];

  constructor(context: FrameXmlRunesLiveContext) {
    this.#context = context;
  }

  attach(pump: FrameXmlSeamPump): void {
    if (this.#pump) this.detach();
    this.#pump = pump;
    const runes = this.#context.world()?.runes;
    const now = pump.now();
    for (let index = 0; index < FRAMEXML_RUNE_COUNT; index++) {
      const record = runes?.[index];
      this.#readings[index] = { record, readiness: record?.readiness ?? RUNE_READY, at: now };
      // Icons known at the mount are PLAYER_ENTERING_WORLD's to paint; no rune waits in Lua yet.
      this.#published[index] = { type: this.#shape(record).type, ready: true };
    }
    const world = this.#context.world();
    if (typeof world?.events?.on !== "function") return;
    this.#off = world.events.on("RUNES_CHANGED", () => this.#changed());
  }

  detach(): void {
    this.#off?.();
    this.#off = undefined;
    this.#pump = undefined;
    this.#readings.length = 0;
    this.#published.length = 0;
  }

  runeType(rune: number): number | undefined {
    const index = frameXmlRuneIndex(rune);
    const record = index === undefined ? undefined : this.#context.world()?.runes?.[index];
    return record ? frameXmlRuneType(record.type) : undefined;
  }

  runeCooldown(rune: number): FrameXmlRuneCooldown | undefined {
    const index = frameXmlRuneIndex(rune);
    if (index === undefined) return undefined;
    const record = this.#context.world()?.runes?.[index];
    const duration = this.#duration(index);
    if (!record) return [0, duration, true];
    // A record met before its event was handled reads as taken now.
    const reading = this.#readings[index];
    const at = reading?.record === record && reading.readiness === record.readiness
      ? reading.at : this.#pump?.now() ?? 0;
    return frameXmlRuneCooldown(record.readiness, at, duration);
  }

  #changed(): void {
    const pump = this.#pump;
    if (!pump) return;
    const runes = this.#context.world()?.runes;
    const now = pump.now();
    for (let index = 0; index < FRAMEXML_RUNE_COUNT; index++) {
      const record = runes?.[index];
      const previous = this.#readings[index];
      // A new record (resync) or a new readiness (ready packet) is a new reading; a convert is not.
      const fresh = previous?.record !== record || previous?.readiness !== record?.readiness;
      if (fresh) this.#readings[index] = { record, readiness: record?.readiness ?? RUNE_READY, at: now };
      const lapsed = fresh && previous !== undefined && previous.readiness < RUNE_READY
        && previous.at + frameXmlRuneWait(previous.readiness) <= now;
      const shape = this.#shape(record);
      const published = this.#published[index];
      this.#published[index] = shape;
      if (shape.type !== published?.type) pump.fire(FRAMEXML_RUNE_EVENTS.typeUpdate, index + 1);
      if (shape.ready !== (published?.ready ?? true) || (!shape.ready && lapsed)) {
        pump.fire(FRAMEXML_RUNE_EVENTS.powerUpdate, index + 1, shape.ready);
      }
    }
  }

  /** A rune with no record is drawn ready and without an icon, as the stock frame draws it at load. */
  #shape(record: { readonly type: number; readonly readiness: number } | undefined): RuneShape {
    return { type: record ? frameXmlRuneType(record.type) : undefined, ready: !record || record.readiness >= RUNE_READY };
  }

  /** The player's regen field for this rune's base type (Player.cpp runeSlotTypes: two runes a type). */
  #duration(index: number): number {
    const world = this.#context.world();
    const selfGuid = world?.state?.selfGuid;
    const player = selfGuid === undefined ? undefined : world?.state?.objects?.get(selfGuid);
    const regen = player ? fieldFloat(player, UPDATE_FIELDS.PLAYER_RUNE_REGEN_1.offset + (index >> 1)) : undefined;
    return frameXmlRuneDuration(regen);
  }
}

/** A canned rune: its core type and, while it waits, the GetTime second it was spent. */
interface CannedRune {
  type: number;
  spentAt: number | undefined;
}

/**
 * Six runes over the scripted offline world, all ready from the moment the seam attaches, for a
 * canned death knight's RuneFrame: tests (and the offline page) spend one, let it come back, and
 * turn one into a death rune with the same events the live model fires.
 */
export class FrameXmlRunesCanned implements FrameXmlRunes {
  #pump: FrameXmlSeamPump | undefined;
  readonly #runes: CannedRune[] = [];

  attach(pump: FrameXmlSeamPump): void {
    this.#pump = pump;
    this.#runes.length = 0;
    for (let index = 0; index < FRAMEXML_RUNE_COUNT; index++) this.#runes.push({ type: index >> 1, spentAt: undefined });
  }

  detach(): void {
    this.#pump = undefined;
  }

  /** Once a frame: a rune whose ten seconds ran out comes back with the edge the live model fires. */
  tick(): void {
    const pump = this.#pump;
    if (!pump) return;
    const now = pump.now();
    this.#runes.forEach((rune, index) => {
      if (rune.spentAt !== undefined && now - rune.spentAt >= RUNE_BASE_COOLDOWN_SECONDS) this.refreshRune(index + 1);
    });
  }

  /** Spend a ready rune (1..6), as a strike would: its ten seconds start now. */
  useRune(rune: number): void {
    const index = frameXmlRuneIndex(rune);
    const record = index === undefined ? undefined : this.#runes[index];
    if (!this.#pump || !record || record.spentAt !== undefined) return;
    record.spentAt = this.#pump.now();
    this.#pump.fire(FRAMEXML_RUNE_EVENTS.powerUpdate, rune, false);
  }

  /** Bring a spent rune (1..6) back, as the realm's ready resync would. */
  refreshRune(rune: number): void {
    const index = frameXmlRuneIndex(rune);
    const record = index === undefined ? undefined : this.#runes[index];
    if (!this.#pump || !record || record.spentAt === undefined) return;
    record.spentAt = undefined;
    this.#pump.fire(FRAMEXML_RUNE_EVENTS.powerUpdate, rune, true);
  }

  /** Turn a rune (1..6) into another core type (3 is death), as `SMSG_CONVERT_RUNE` would. */
  convertRune(rune: number, coreType: number): void {
    const index = frameXmlRuneIndex(rune);
    const record = index === undefined ? undefined : this.#runes[index];
    if (!this.#pump || !record || frameXmlRuneType(coreType) === undefined || record.type === coreType) return;
    record.type = coreType;
    this.#pump.fire(FRAMEXML_RUNE_EVENTS.typeUpdate, rune);
  }

  runeType(rune: number): number | undefined {
    const index = frameXmlRuneIndex(rune);
    const record = index === undefined ? undefined : this.#runes[index];
    return record ? frameXmlRuneType(record.type) : undefined;
  }

  runeCooldown(rune: number): FrameXmlRuneCooldown | undefined {
    const index = frameXmlRuneIndex(rune);
    if (index === undefined) return undefined;
    const record = this.#runes[index];
    // Ready when `tick` or `refreshRune` says so, as the live rune waits for the realm's resync.
    if (!record || record.spentAt === undefined) return FRAMEXML_RUNE_READY;
    return [record.spentAt, RUNE_BASE_COOLDOWN_SECONDS, false];
  }
}
