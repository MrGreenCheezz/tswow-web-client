import { POWER_COUNT, POWER_DISPLAY_SCALE, unit as unitField } from "../../world/Fields.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { PartyMemberStats } from "../../world/PartyProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * 11.10: `UnitPower(unit[, type])` and `UnitPowerMax(unit[, type])` with their second argument, as
 * Wow.exe 3.3.5a 12340 answers them (read 2026-10-11). `UnitMana`/`UnitManaMax` are the same two C
 * functions: their table entries (.data 0x00ad2308/0x00ad2310) point at the same code as UnitPower's
 * and UnitPowerMax's (0x00ad2318 → 0x0060ed40, 0x00ad2320 → 0x0060ef40).
 *
 * Both read the type when argument 2 is a number (0x0084df20, then 0x0084e070 for its integer) and
 * take 7 otherwise; below 0 or above 7 the answer is a plain 0, and 7 — the default — means the
 * power the unit displays (byte 3 of UNIT_FIELD_BYTES_0, the descriptor's +0x47). For a unit object
 * in view:
 * * UnitPowerMax reads UNIT_FIELD_MAXPOWER1 + type (descriptor +0x6c + type*4) for any type;
 * * UnitPower reads UNIT_FIELD_POWER1 + type (0x0071c2e0, descriptor +0x4c + type*4, when no
 *   predicted power is kept) only when the type is the displayed one or the unit is the active player
 *   (0x004cee50 compares the unit's GUID with 0x004d3790's); for anyone else's other power it is 0.
 * Both divide by 0x007fde00(type) — rage and runic power are kept in tenths (CombatEventModel.ts) —
 * as an unsigned integer division. A party or raid member out of view answers from the group's
 * cached stats (SMSG_PARTY_MEMBER_STATS): its value for type 7 or its own cached type, else 0.
 *
 * Why it matters: stock AlternatePowerBar.lua:62 shows PlayerFrameAlternateManaBar (the druid's
 * mana in a form) while `UnitPowerType(unit) ~= 0 and UnitPowerMax(unit, 0) ~= 0`, and fills it
 * with `UnitPower(unit, 0)`. Answered without the type, a rogue's UnitPowerMax("player", 0) was its
 * 100 energy: a blue «Мана» bar appeared under the energy bar and moved like energy. The real
 * UNIT_FIELD_MAXPOWER1 of a class without mana is 0 (Player::UpdateMaxPower, StatSystem.cpp:472).
 *
 * Not modelled: 0x0060ed40 also answers 0 for a unit whose UNIT_DYNAMIC_FLAGS has
 * UNIT_DYNFLAG_DEAD (0x20) unless 0x00512a30(guid) — a check not read yet; the predicted power the
 * client keeps beside the field (+0xfb4) when its CVar is on, which this client never keeps.
 */

/** The type argument's default: the power the unit displays. */
export const FRAMEXML_DISPLAYED_POWER = 7;

/**
 * The second argument as 0x0060ed40/0x0060ef40 read it: a number (or a string that reads as one)
 * truncated to an integer, 7 when absent or not a number, and `undefined` when it is out of 0..7 —
 * the case both functions answer with a bare 0 before looking at the unit.
 */
export function frameXmlPowerTypeArgument(value: unknown): number | undefined {
  const number = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return FRAMEXML_DISPLAYED_POWER;
  const type = Math.trunc(number);
  return type < 0 || type > FRAMEXML_DISPLAYED_POWER ? undefined : type;
}

/** One power word divided as 0x007fde00 says; the fields are unsigned. */
function displayed(raw: number, type: number): number {
  return Math.floor((raw >>> 0) / (POWER_DISPLAY_SCALE[type] ?? 1));
}

/**
 * A unit object's power (or maximum) of `type`. Undefined only while the object has no
 * UNIT_FIELD_BYTES_0 yet (or displays a power past the seven fields), which the caller answers from
 * the group cache as before.
 */
export function frameXmlObjectPower(
  object: WorldObjectState, type: number, activePlayer: boolean, maximum: boolean,
): number | undefined {
  const shown = unitField.powerType(object);
  if (shown === undefined) return undefined;
  const power = type === FRAMEXML_DISPLAYED_POWER ? shown : type;
  if (power >= POWER_COUNT) return undefined;
  // 0x0060ed40: another unit's power other than the one it displays is not answered.
  if (!maximum && power !== shown && !activePlayer) return 0;
  const field = (maximum ? UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1 : UPDATE_FIELDS.UNIT_FIELD_POWER1).offset + power;
  return displayed(object.fields.get(field) ?? 0, power);
}

/** A group member out of view: the cached value for type 7 or the cached type, else 0. */
export function frameXmlPartyPower(
  stats: PartyMemberStats | undefined, type: number, maximum: boolean,
): number | undefined {
  if (!stats) return undefined;
  const cached = stats.powerType ?? 0;
  if (type !== FRAMEXML_DISPLAYED_POWER && type !== cached) return 0;
  const value = maximum ? stats.maxPower : stats.power;
  return value === undefined ? undefined : displayed(value, cached);
}
