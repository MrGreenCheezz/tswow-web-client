/**
 * `HasFullControl()` and the two edges stock hears when the character is taken out of the player's
 * hands, `PLAYER_CONTROL_LOST`/`PLAYER_CONTROL_GAINED`.
 *
 * Readers in the 3.3.5 corpus:
 *
 * * UnitPopup.lua:1048 (TRADE) and :1092 (DUEL): `UnitIsDeadOrGhost("player") or (not
 *   HasFullControl()) or …` disables the row. The name was unbound, so its stub's nil greyed both
 *   rows for everybody, always. The client answers 1 or nil.
 * * UIParent.lua:800-835: PLAYER_CONTROL_LOST runs `CloseAllWindows_WithExceptions()` — every bag and
 *   panel — unless `UnitOnTaxi("player")` (:801: the client raises the edge for a flight too), and
 *   sets `UIParent.isOutOfControl`; GAINED clears it. The one window kept open is the scoreboard at
 *   «the game over spell effect» (:2160), the battleground's own `SetClientControl(player, false)`
 *   (Battleground.cpp `BlockMovement`), and the commented-out rule before it names the case:
 *   «couldn't open frames if player was out of control i.e. feared» (:2074-2076).
 * * PetActionBarFrame.lua:15-16, :47 redraws the pet bar on either edge.
 *
 * What the wire says (TrinityCore): `Player::SetClientControl` (Player.cpp:24573) sends
 * SMSG_CLIENT_CONTROL_UPDATE(packed guid, u8 allowMove) for fear and confusion (`Unit::SetFeared`/
 * `SetConfused`, Unit.cpp:12349-12400; control is refused back while either state holds), for charm
 * and possession (Unit.cpp:12499-12668: the victim gets allowed = 0 on its own guid; a player who
 * possesses a unit or drives a vehicle gets allowed = 1 on *that* guid, and on leaving it allowed = 0
 * on it, then allowed = 1 on the character) and at a battleground's end. WorldClient keeps the
 * allowed guid (`controlledGuid`) and the refused one (`controlRefusedGuid`), and drops both at a
 * worldport, where the core re-allows the character without a packet. A taxi flight sends nothing:
 * FlightPathMovementGenerator.cpp:75 sets UNIT_FLAG_REMOVE_CLIENT_CONTROL | UNIT_FLAG_ON_TAXI. The
 * flags are the public UNIT_FIELD_FLAGS (UnitDefines.h:153-159): STUNNED has no packet of its own,
 * FLEEING/CONFUSED come with the packet, POSSESSED marks the unit a player controls.
 *
 * Two predicates over those words:
 *
 * * {@link frameXmlInControl} — the player is not out of control: no fear, confusion, a player's
 *   possession or a flight on the character, and no refusal of the character's own guid. Its
 *   transitions are the two events. wowee fires them from the same packet, and only for the player's
 *   own guid (movement_handler.cpp, `handleClientControlUpdate`): driving a vehicle or a possessed
 *   unit is control, not its loss — and leaving one refuses *that* unit, which the world loop may
 *   deliver a frame before the character's own allowance — while a stun must not reach UIParent's
 *   handler, which would close the bags at every stun.
 * * {@link frameXmlHasFullControl} — in control, not stunned, and moving the character itself rather
 *   than a vehicle or a possessed unit: the work plan's «страх, контроль, оглушение, подчинение» for
 *   the menu rows (TradeHandler.cpp:648 refuses a trade in flight as well).
 *
 * wowee answers `HasFullControl` with a constant true («nothing here charms, fears or confuses
 * anyone», lua_unit_api.cpp:1872); here all of that happens, so the answer is read from the world.
 * A seam without the member answers 1: an empty world takes nobody's control away.
 */
import { unit as unitField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";

/** UnitFlags, UnitDefines.h:153-159. */
export const UNIT_FLAG_STUNNED = 0x00040000;
export const UNIT_FLAG_ON_TAXI = 0x00100000;
export const UNIT_FLAG_CONFUSED = 0x00400000;
export const UNIT_FLAG_FLEEING = 0x00800000;
export const UNIT_FLAG_POSSESSED = 0x01000000;

/** The flags under which the character is out of the player's hands: a flight, fear, confusion, a player's possession. */
const OUT_OF_CONTROL_FLAGS = UNIT_FLAG_ON_TAXI | UNIT_FLAG_CONFUSED | UNIT_FLAG_FLEEING | UNIT_FLAG_POSSESSED;

export const FRAMEXML_CONTROL_EVENTS = Object.freeze({
  lost: "PLAYER_CONTROL_LOST",
  gained: "PLAYER_CONTROL_GAINED",
} as const);

/** The world's words the two predicates read. */
export interface FrameXmlControlWords {
  /** UNIT_FIELD_FLAGS of the player's own object; undefined before it arrived. */
  readonly flags: number | undefined;
  readonly selfGuid: bigint | undefined;
  /** `WorldClient.controlledGuid`: the unit the last allowed control update named. */
  readonly controlledGuid: bigint | undefined;
  /** `WorldClient.controlRefusedGuid`: the unit the last refusal named, until an allowance. */
  readonly controlRefusedGuid: bigint | undefined;
}

/** The part of `WorldClient` the words come from. */
export interface FrameXmlControlWorld {
  readonly state: { readonly selfGuid?: bigint | undefined };
  readonly controlledGuid?: bigint | undefined;
  readonly controlRefusedGuid?: bigint | undefined;
}

export function frameXmlControlWords(
  world: FrameXmlControlWorld | undefined,
  self: WorldObjectState | undefined,
): FrameXmlControlWords {
  return {
    flags: self === undefined ? undefined : unitField.flags(self),
    selfGuid: world?.state.selfGuid,
    controlledGuid: world?.controlledGuid,
    controlRefusedGuid: world?.controlRefusedGuid,
  };
}

/**
 * Whether the player is in control of something: no out-of-control flag on the character, and no
 * refusal of the character's own guid (a refusal of a vehicle or a possessed unit being left is not).
 */
export function frameXmlInControl(words: FrameXmlControlWords): boolean {
  if (((words.flags ?? 0) & OUT_OF_CONTROL_FLAGS) !== 0) return false;
  return words.controlRefusedGuid === undefined || words.controlRefusedGuid !== words.selfGuid;
}

/** `HasFullControl()`: in control, not stunned, and the mover is the character itself. */
export function frameXmlHasFullControl(words: FrameXmlControlWords): boolean {
  return frameXmlInControl(words)
    && ((words.flags ?? 0) & UNIT_FLAG_STUNNED) === 0
    && (words.controlledGuid === undefined || words.controlledGuid === words.selfGuid);
}

/**
 * The last control edge told to Lua. It starts «in control» at every attach, so the first check
 * publishes a loss already under way, and it fires only when the answer changes.
 */
export class FrameXmlControlEdge {
  #inControl = true;

  reset(): void {
    this.#inControl = true;
  }

  /** PLAYER_CONTROL_LOST or _GAINED when `inControl` differs from the last edge; nothing otherwise. */
  reconcile(inControl: boolean, pump: FrameXmlSeamPump | undefined): void {
    if (!pump || inControl === this.#inControl) return;
    this.#inControl = inControl;
    pump.fire(inControl ? FRAMEXML_CONTROL_EVENTS.gained : FRAMEXML_CONTROL_EVENTS.lost);
  }
}

/** What a seam answers; absent means «in control». */
export interface FrameXmlPlayerControl {
  hasFullControl?(): boolean;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const YES: readonly unknown[] = Object.freeze([1]);

export const FRAMEXML_CONTROL_BINDINGS: Readonly<Record<string,
  (host: FrameXmlPlayerControl, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  // The client's 1/nil: UnitPopup tests it with `not`, and an add-on may compare it with 1.
  HasFullControl: (host) => ((host.hasFullControl?.() ?? true) ? YES : NOTHING),
});
