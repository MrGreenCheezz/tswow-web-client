/**
 * Focus, assist, dismount and the stance bar's cancel for the stock UI.
 *
 * Callers in the 3.3.5 corpus:
 *
 * * `FocusUnit(unit)`/`ClearFocus(unit)` — the unit menus' SET_FOCUS and CLEAR_FOCUS
 *   (UnitPopup.lua:1381-1384); `ClearFocus()` from FocusFrame when its unit is gone
 *   (TargetFrame.lua:196-202); SecureTemplates' `focus` action (:417-420); `/focus` with an empty
 *   line calls `FocusUnit()` — the target — and with a token or a name `FocusUnit(target)`
 *   (ChatFrame.lua:1244-1262).
 * * `AssistUnit(unit)` — SecureTemplates' `assist` action (:422-425) and `/assist`, bare for the
 *   target (ChatFrame.lua:1229-1241): select whatever that unit has selected. DEC-A 3.11: as Wow.exe
 *   0x00525eb0 — no unit there is ERR_GENERIC_NO_TARGET / ERR_UNIT_NOT_FOUND, and the assistAttack CVar
 *   («Автоматическая помощь») attacks the unit assisted.
 * * `Dismount()` — `/dismount` (ChatFrame.lua:2114-2118); `CancelShapeshiftForm()` — `/cancelform`
 *   (:1080-1084).
 *
 * The focus is the interface's, not the realm's: the browser game keeps it (`game.focusGuid`,
 * game/Targeting.ts) and the seam publishes PLAYER_FOCUS_CHANGED when it moves on its next frame;
 * the host hands the writer in as `setFocus`. A token that names nobody takes the focus with it, as
 * the native «focus the target» does with no target; a name nobody in sight carries changes nothing.
 * Assist selects through `WorldClient.selectTarget`, which already refuses a guid not in the world —
 * the unit's target is its UNIT_FIELD_TARGET. `Dismount` is CMSG_CANCEL_MOUNT_AURA (empty body,
 * SpellHandler.cpp HandleCancelMountAuraOpcode); `CancelShapeshiftForm` is CMSG_CANCEL_AURA for the
 * active stance-bar form's spell (FrameXmlShapeshiftForms.ts), which the core refuses for an aura
 * that cannot be cancelled (a warrior's stance). Only a SPELL_AURA_MOD_SHAPESHIFT form: a paladin
 * aura or a death knight's presence sits on the same bar, and CMSG_CANCEL_AURA removes any positive,
 * non-passive aura (SpellHandler.cpp HandleCancelAuraOpcode).
 *
 * Not here: `SpellTargetUnit` and `DropItemOnUnit` belong to the cursor-target owner (mechanism M3,
 * line A3); `TargetNearest*`/`TargetLast*` only reach Lua through macros and key bindings the binding
 * layer already turns into the native actions (FrameXmlBinding.ts) — slice 1.10c.
 */
import { unit as unitField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/** The seam's own unit-token grammar (LiveWorldSeam `FRAMEXML_UNIT_TOKEN`), for «token or name». */
const UNIT_TOKEN =
  /^(?:player|target|focus|mouseover|pet|vehicle|npc|none|party[1-4]|partypet[1-4]|raid\d{1,2}|raidpet\d{1,2}|arena[1-5]|arenapet[1-5]|boss[1-4])(?:target)*$/;

/** The part of `WorldClient` the commands read and send through. */
export interface FrameXmlTargetingWorld {
  readonly state: { readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  /** DEC-A 3.11: the selection, read back after an assist's select. */
  readonly targetGuid?: bigint | undefined;
  selectTarget?(guid: bigint | undefined): void;
  /** DEC-A 3.11: StartAttack on the selection (Wow.exe 0x006e4950, the assistAttack swing). */
  startAttack?(): void;
  /** DEC-review 3.11: CanAttack (Wow.exe 0x00729740 via 0x006e2610) — WorldClient's hook; absent, no veto. */
  canAttackUnit?(object: WorldObjectState): boolean;
  dismount?(): void;
  cancelAura?(spellId: number): void;
}

export interface FrameXmlTargetingContext {
  world(): FrameXmlTargetingWorld | undefined;
  /** A unit token (lower case) to its guid, as the seam resolves every other unit question. */
  unitGuid(unit: string): bigint | undefined;
  /** A group member's or a unit in sight's name to its guid; undefined when nobody carries it. */
  namedGuid?(name: string): bigint | undefined;
  /** The interface's focus writer; absent, the focus stays where the host keeps it. */
  setFocus?(guid: bigint | undefined): void;
  /** The stance-bar entries the player has active, in bar order (`formId` only for a MOD_SHAPESHIFT form). */
  activeStanceEntries?(): readonly { readonly spellId: number; readonly formId: number | undefined }[];
  /** DEC-A 3.11: a UIErrorsFrame line by its GlobalStrings key (Wow.exe 0x005216f0); absent, silent. */
  uiError?(name: string): void;
  /** DEC-A 3.11: the assistAttack CVar (Wow.exe 0x00bd0918, registered with "0"); absent, off. */
  assistAttack?(): boolean;
}

export interface FrameXmlTargeting {
  focusUnit(unitOrName: string | undefined): void;
  clearFocus(): void;
  assistUnit(unitOrName: string | undefined): void;
  dismount(): void;
  cancelShapeshiftForm(): void;
}

export class FrameXmlTargetingModel implements FrameXmlTargeting {
  readonly #context: FrameXmlTargetingContext;

  constructor(context: FrameXmlTargetingContext) {
    this.#context = context;
  }

  /**
   * `{ guid }` for a token (the guid may be undefined: nobody) or a name somebody carries;
   * undefined for a name nobody carries.
   */
  #resolve(unitOrName: string | undefined): { readonly guid: bigint | undefined } | undefined {
    const typed = unitOrName?.trim() ?? "";
    const token = typed.length === 0 ? "target" : typed.toLowerCase();
    if (UNIT_TOKEN.test(token)) {
      const guid = this.#context.unitGuid(token);
      return { guid: guid === 0n ? undefined : guid };
    }
    const guid = this.#context.namedGuid?.(typed);
    return guid === undefined || guid === 0n ? undefined : { guid };
  }

  focusUnit(unitOrName: string | undefined): void {
    const resolved = this.#resolve(unitOrName);
    if (resolved) this.#context.setFocus?.(resolved.guid);
  }

  clearFocus(): void {
    this.#context.setFocus?.(undefined);
  }

  assistUnit(unitOrName: string | undefined): void {
    const world = this.#context.world();
    if (!world) return;
    const guid = this.#resolve(unitOrName)?.guid;
    const object = guid === undefined ? undefined : world.state.objects.get(guid);
    // DEC-A 3.11: Wow.exe 0x00525eb0 looks the token up as a unit (0x004d4db0, TYPEMASK_UNIT): nobody there —
    // or a corpse, whose words at UNIT_FIELD_TARGET's offset are no selection — is a UI error (0x005216f0).
    if (object?.typeId !== 3 && object?.typeId !== 4) { // DEC-A 3.11
      this.#context.uiError?.(assistErrorName(unitOrName));
      return;
    }
    const selected = unitField.target(object);
    if (selected === undefined || selected === 0n || !world.state.objects.has(selected)) return;
    world.selectTarget?.(selected);
    // DEC-A 3.11: with assistAttack on, 0x006e4950 attacks the unit assisted; WorldClient.startAttack swings at
    // the selection, so only once the select took (a unit already selected counts — 0x006e4950 runs then too).
    if (world.targetGuid !== selected || this.#context.assistAttack?.() !== true) return; // DEC-review 3.11: was one `if`
    // DEC-review 3.11: 0x006e4950 → 0x006e2610 asks CanAttack (0x00729a70 → 0x00729740) and sends no CMSG_ATTACKSWING
    // when it refuses: an assist that selected the player himself or a friend swings at nothing.
    const chosen = world.state.objects.get(selected);
    if (chosen !== undefined && world.canAttackUnit?.(chosen) !== false) world.startAttack?.(); // DEC-review 3.11
  }

  dismount(): void {
    this.#context.world()?.dismount?.();
  }

  cancelShapeshiftForm(): void {
    const form = this.#context.activeStanceEntries?.().find((entry) => entry.formId !== undefined);
    if (form && form.spellId > 0) this.#context.world()?.cancelAura?.(form.spellId);
  }
}

/**
 * DEC-A 3.11: AssistUnit's error when its token names no unit — Wow.exe 0x00525eb0 compares the argument
 * itself: empty (a bare `/assist`) or "target" (Storm's case-insensitive compare) is 0x005216f0(199)
 * ERR_GENERIC_NO_TARGET, any other token or a name is (314) ERR_UNIT_NOT_FOUND.
 */
function assistErrorName(unitOrName: string | undefined): string {
  const raw = unitOrName ?? "";
  return raw.length === 0 || raw.toLowerCase() === "target" ? "ERR_GENERIC_NO_TARGET" : "ERR_UNIT_NOT_FOUND";
}

/** The part of the world seam the bindings read. */
export interface FrameXmlTargetingHost {
  readonly targeting?: FrameXmlTargeting | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function unitOrName(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const FRAMEXML_TARGETING_BINDINGS: Readonly<Record<string,
  (host: FrameXmlTargetingHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  FocusUnit: (host, args) => { host.targeting?.focusUnit(unitOrName(args[0])); return NOTHING; },
  // Stock passes the menu's unit (UnitPopup.lua:1384) or nothing (TargetFrame.lua:201); either clears.
  ClearFocus: (host) => { host.targeting?.clearFocus(); return NOTHING; },
  AssistUnit: (host, args) => { host.targeting?.assistUnit(unitOrName(args[0])); return NOTHING; },
  Dismount: (host) => { host.targeting?.dismount(); return NOTHING; },
  CancelShapeshiftForm: (host) => { host.targeting?.cancelShapeshiftForm(); return NOTHING; },
});
