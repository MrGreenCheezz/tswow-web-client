import { POWER_COUNT, POWER_DISPLAY_SCALE, readField, unit as unitField } from "../../world/Fields.js";
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
 * 3.41 (11.11, `.runtime/re-2026-11-11/api4/d1.c`): UnitPower (0x0060ed40, not UnitPowerMax 0x0060ef40)
 * answers 0 for a unit object whose UNIT_DYNAMIC_FLAGS (descriptor +0x124) has UNIT_DYNFLAG_DEAD (0x20)
 * unless 0x00512a30 keeps it: 0x0052d310 — the player, the player's charm or else summon, a party member
 * (0x00bd1948, four slots) or a party member's charm-or-summon (the cached pet guid while the member is
 * out of view) — or 0x00573200, the same over the raid list (0x00beb568). The check comes after type 7
 * is resolved and before the displayed-power rule.
 *
 * Not modelled: the predicted power the client keeps beside the field (+0xfb4) when its CVar is on,
 * which this client never keeps.
 */

/** UNIT_DYNFLAG_DEAD (SharedDefines.h `UnitDynFlags`), the bit 0x0060ed40 tests. */
export const UNIT_DYNFLAG_DEAD = 0x20;

/** What 0x00512a30 looks at; LiveWorldSeam supplies it from the world. */
export interface FrameXmlPowerKeepers {
  readonly selfGuid: bigint | undefined;
  object(guid: bigint): WorldObjectState | undefined;
  /** The party's members, or the raid's (0x00bd1948, 0x00beb568). */
  groupMembers(): Iterable<bigint>;
  /** The member's pet from the group cache (SMSG_PARTY_MEMBER_STATS), for a member out of view. */
  cachedPet(member: bigint): bigint | undefined;
}

/** A unit's charm, or its summon when it has no charm — the descriptor pair 0x0052d310 reads. */
function charmOrSummon(object: WorldObjectState): bigint | undefined {
  const charm = readField(object, "UNIT_FIELD_CHARM");
  return charm !== undefined && charm !== 0n ? charm : readField(object, "UNIT_FIELD_SUMMON");
}

/** Wow.exe 0x00512a30: whether a dead unit's power is still answered. */
export function frameXmlKeepsPowerWhenDead(guid: bigint, keepers: FrameXmlPowerKeepers): boolean {
  if (guid === 0n) return false;
  const selfGuid = keepers.selfGuid;
  if (guid === selfGuid) return true;
  const self = selfGuid === undefined ? undefined : keepers.object(selfGuid);
  if (self && charmOrSummon(self) === guid) return true;
  for (const member of keepers.groupMembers()) {
    if (member === 0n) continue;
    if (member === guid) return true;
    const object = keepers.object(member);
    if (object ? charmOrSummon(object) === guid : keepers.cachedPet(member) === guid) return true;
  }
  return false;
}

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
  keepers?: FrameXmlPowerKeepers,
): number | undefined {
  const shown = unitField.powerType(object);
  if (shown === undefined) return undefined;
  const power = type === FRAMEXML_DISPLAYED_POWER ? shown : type;
  if (power >= POWER_COUNT) return undefined;
  // 3.41 (11.11): 0x0060ed40 — a dead unit's power is 0 unless 0x00512a30 keeps it.
  if (!maximum && keepers && ((object.fields.get(UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset) ?? 0) & UNIT_DYNFLAG_DEAD) !== 0
    && !frameXmlKeepsPowerWhenDead(object.guid, keepers)) return 0;
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
