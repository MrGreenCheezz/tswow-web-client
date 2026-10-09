import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { writeMovementInfo, type MovementInfo } from "./MovementProtocol.js";
import { writeSpellTargets, type SpellTargetSpec } from "./SpellTargets.js";
import type { WorldObjectState } from "./WorldState.js";

/**
 * 11.02-D: `CMSG_PET_CAST_SPELL`, the spell of a unit the character commands.
 *
 * TrinityCore (PetHandler.cpp:744-778) reads `u64 caster | u8 castCount | u32 spellId | u8 castFlags`,
 * then `SpellCastTargets` (Spell.cpp:144) and, when `castFlags & 2`, `f32 elevation | f32 speed |
 * u8 hasMovement` and, if set, a `u32` opcode and that movement packet (SpellHandler.cpp:52-73). The
 * caster must be the player's guardian pet or the unit it charms — a driven vehicle or a possessed
 * unit is the charmed one (`SetCharm` runs for `CHARM_TYPE_VEHICLE` too, Unit.cpp:12492) — and know
 * the spell (`HasSpell`: a creature's `m_spells`). A refusal comes back as `SMSG_PET_CAST_FAILED`.
 *
 * Wow.exe writes the same packet in its cast sender (0x0080ac90, at 0x0080b315) for any caster that is
 * not the character: the caster's full guid, the cast count, the spell, the flags (2 only for a
 * missile trajectory cast by the active mover), the targets, then elevation, speed and the mover's
 * movement.
 */

/** The trajectory tail `castFlags & 2` adds (slice E fills it). */
export interface PetCastTrajectory {
  readonly elevation: number;
  readonly speed: number;
  /** A movement packet of the caster to ride along: its opcode, guid and MovementInfo. */
  readonly movement?: { readonly opcode: number; readonly guid: bigint; readonly info: MovementInfo } | undefined;
}

/** `CAST_FLAG` bit that carries the trajectory tail (SpellHandler.cpp:55). */
export const PET_CAST_FLAG_TRAJECTORY = 0x02;

/** The packet, or undefined for a targets spec {@link writeSpellTargets} refuses. */
export function buildPetCastSpell(casterGuid: bigint, castCount: number, spellId: number, castFlags: number,
  targets: SpellTargetSpec, trajectory?: PetCastTrajectory): Uint8Array | undefined {
  const writer = new PacketWriter().u64(casterGuid).u8(castCount & 0xff).u32(spellId >>> 0).u8(castFlags & 0xff);
  if (!writeSpellTargets(writer, targets)) return undefined;
  if ((castFlags & PET_CAST_FLAG_TRAJECTORY) !== 0) {
    writer.f32(trajectory?.elevation ?? 0).f32(trajectory?.speed ?? 0);
    const movement = trajectory?.movement;
    writer.u8(movement ? 1 : 0);
    if (movement) writeMovementInfo(writer.u32(movement.opcode >>> 0), movement.guid, movement.info);
  }
  return writer.toUint8Array();
}

/**
 * Whether a pet-bar word is a spell, by Wow.exe's switch on `state & 0x3F` (0x005d4210): 1 —
 * `ACT_PASSIVE`, `ACT_DISABLED` 0x81, `ACT_ENABLED` 0xC1 — and 8…0x11, which takes in the vehicle
 * bar's slot states 8…15 (`VehicleSpellInitialize`, Player.cpp:21452). Commands (7), reactions (6)
 * and the rest are orders.
 */
export function petSlotCastsSpell(state: number): boolean {
  const kind = state & 0x3f;
  return kind === 1 || (kind >= 8 && kind <= 0x11);
}

/**
 * Whether the bar's spells go out as the unit's own casts: Wow.exe does so when the bar's unit is the
 * unit the character controls (0x005d4210 compares it with 0x006dd060's controlled unit) — a driven
 * vehicle or a possessed creature, whose bars the core cannot cast from `CMSG_PET_ACTION` (a vehicle has
 * no `CharmInfo`, PetHandler.cpp:138-144, and its states 8…15 fall to `default`, :388-389). A pet or a
 * charmed creature the character does not steer keeps `CMSG_PET_ACTION`. (Wow.exe also takes this path
 * for a spell with `AttributesEx4 & 0x20`: `petSpellCastsAsUnit`, L13.)
 */
export function petBarCastsAsUnit(barGuid: bigint, controlledGuid: bigint | undefined, selfGuid: bigint | undefined,
  barUnit?: WorldObjectState): boolean {
  if (barGuid !== 0n && controlledGuid !== undefined && controlledGuid !== selfGuid && controlledGuid === barGuid) return true;
  // 11.02-BCD-review: Wow.exe's controlled unit is not the active mover but the far-sight unit that is
  // possessed by the character (0x006dd060 → 0x004f7250), and a fear or confusion on it takes only
  // the steering (`SetClientControl(unit, 0)`, Unit.cpp:12343-12401), so the bar keeps casting as it.
  return barUnit !== undefined && barUnit.guid === barGuid && possessedBy(barUnit, selfGuid);
}

/** L13: `SPELL_ATTR4_UNK5` (SharedDefines.h:560), the bit 0x005d4210 tests at record +0x20 (AttributesEx4). */
export const SPELL_ATTR4_PET_CASTS_AS_UNIT = 0x20;

/** L13: the spell rows' eight attribute words (`/dbc/spells?v=14` `attributes`), by spell id; the page registers it. */
export type PetSpellAttributesSource = (spellId: number) => readonly number[] | undefined;

let spellAttributes: PetSpellAttributesSource | undefined;

/** L13: the page's spell rows (app/EnterWorld.ts: `game.spells`); without them no spell takes this path. */
export function setPetSpellAttributesSource(source: PetSpellAttributesSource | undefined): void {
  spellAttributes = source;
}

/**
 * L13, 11.02-D: Wow.exe 0x005d4210 casts a pet-bar spell through its own cast path — CMSG_PET_CAST_SPELL from the
 * bar's unit — also when the spell has `AttributesEx4 & 0x20`, whatever the unit (an ordinary pet too). 76 rows on
 * this dataset (Холод 33395 of the water elemental, Огненный ливень, Движение…), mostly area spells the realm
 * never casts from CMSG_PET_ACTION (PetHandler.cpp:290-294). Not known (no row yet): false — CMSG_PET_ACTION.
 */
export function petSpellCastsAsUnit(spellId: number, attributes = spellId > 0 ? spellAttributes?.(spellId) : undefined): boolean {
  return spellId > 0 && ((attributes?.[4] ?? 0) & SPELL_ATTR4_PET_CASTS_AS_UNIT) !== 0;
}

/** L13-review 11.02-D: `TARGET_FLAG_DEST_LOCATION` of Spell.dbc's Targets word — the spell lands on a point. */
export const PET_SPELL_TARGET_DEST_LOCATION = 0x40;

/**
 * L13-review 11.02-D: what the page knows of a press — the spell row's Targets word (`/dbc/spells?v=14` `targets`;
 * undefined without a row) and whether the player may attack a unit (Targeting.ts `canAttackUnit`).
 */
export interface PetSpellPlacementSource {
  readonly targets: (spellId: number) => number | undefined;
  readonly attackable: (guid: bigint) => boolean;
}

let placement: PetSpellPlacementSource | undefined;

/** L13-review 11.02-D: the page's answers (app/EnterWorld.ts); without them no bit spell takes the pet's own cast. */
export function setPetSpellPlacementSource(source: PetSpellPlacementSource | undefined): void {
  placement = source;
}

/**
 * L13-review 11.02-D: `petSpellCastsAsUnit` for a press at `unit` (0 — none) of a bar the character does not steer.
 * The realm puts a ground spell's point on the unit the packet names, or on the pet when it names none
 * (Spell::InitExplicitTargets, Spell.cpp:709-719), and Wow.exe lets the player aim it first (0x0080cce0 arms the
 * reticle). This client has no reticle for pet spells, so a spell with Targets & DEST_LOCATION goes out only at a
 * unit the player may attack; any other press keeps CMSG_PET_ACTION, which the realm drops for an area-enemy spell
 * (PetHandler.cpp:290-294) — the behaviour from before L13, never an area spell at a friend's feet or on the pet.
 * A row without its Targets word is unknown: false.
 */
export function petSpellCastsAsUnitAt(spellId: number, unit: bigint): boolean {
  const source = placement;
  if (source === undefined || !petSpellCastsAsUnit(spellId)) return false;
  const targets = source.targets(spellId);
  if (targets === undefined) return false;
  if ((targets & PET_SPELL_TARGET_DEST_LOCATION) === 0) return true;
  return unit !== 0n && source.attackable(unit);
}

/** `UNIT_FLAG_POSSESSED` (UnitDefines.h:159): set for a driven vehicle and a possessed unit (Unit.cpp:12528, 12532). */
export const UNIT_FLAG_POSSESSED = 0x0100_0000;

/**
 * 11.02-BCD-review: Wow.exe 0x004f7250 — the unit carries `UNIT_FLAG_POSSESSED` and its CHARMEDBY, or
 * its CREATEDBY when it has no charmer, is `selfGuid`.
 */
export function possessedBy(unit: WorldObjectState, selfGuid: bigint | undefined): boolean {
  if (selfGuid === undefined || ((unit.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset) ?? 0) & UNIT_FLAG_POSSESSED) === 0) return false;
  const charmer = guidField(unit, UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset);
  return (charmer !== 0n ? charmer : guidField(unit, UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset)) === selfGuid;
}

function guidField(unit: WorldObjectState, offset: number): bigint {
  const low = (unit.fields.get(offset) ?? 0) >>> 0;
  const high = (unit.fields.get(offset + 1) ?? 0) >>> 0;
  return high === 0 ? BigInt(low) : (BigInt(high) << 32n) | BigInt(low);
}
