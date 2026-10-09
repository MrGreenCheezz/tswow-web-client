/**
 * Plan item 3.12 (04.10, L4): two lines `GameTooltip:SetUnit` writes from the world, as Wow.exe
 * 3.3.5a 12340 does (0x00621070, read-only Ghidra 2026-10-04; described in this file's words):
 *
 * * **The guild of any player** — from the guild cache by the unit's PLAYER_GUILDID (0x0067d930): a
 *   miss asks the realm once (CMSG_GUILD_QUERY) and the line comes with the answer. The Lua
 *   `GetGuildInfo` answers only the player's own guild, so the line for anyone else was missing.
 * * **UNITNAME_SUMMON_TITLE<n>** (0x0061e830), under the sub-name, for any unit with an owner: the
 *   owner is UNIT_FIELD_CHARMEDBY, else UNIT_FIELD_CREATEDBY; when that owner is in view and has an
 *   owner of its own, that one (0x004f5f20). The title: the first SPELL_EFFECT_SUMMON (28) of the
 *   unit's UNIT_CREATED_BY_SPELL names a SummonProperties row by its EffectMiscValueB, whose Title is
 *   the key's number — 0 writes nothing, -1 (or no row) falls to the default; with no summon effect
 *   (or no spell) the default is TITLE1 («Питомец») for a beast (0x0071f300 = 1) and TITLE3
 *   («Прислужник») for anything else. The owner's name (0x0074d750): a player's from the name cache,
 *   a creature's from its object or the creature cache, a pet's from the pet name; UNKNOWNOBJECT
 *   when there is none yet.
 *
 * L13 (04.10): `/dbc/spells?v=17` serves, on a row with a summon effect, the SummonProperties row each summon
 * effect names (`summonProperties`, gateway/SummonPropertiesMetadata.ts); with no `summonPropertiesTitle` of the
 * caller's own the title comes from the page's spell rows (`game.spells`, the map LiveWorldSeam's `spell`
 * reads — FrameXmlWorldMount). Still no line, not a guess: a row from an older gateway, a dataset without
 * SummonProperties.dbc, a spell row not loaded yet. A shapeshift form's creature type (0x0071f300 reads
 * SpellShapeshiftForm.CreatureType first) is not known here.
 */
import { readField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { SummonPropertiesRow } from "../../gateway/SummonPropertiesMetadata.js"; // L13
import { game } from "../game/Context.js"; // L13: the page's spell rows

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
const SPELL_EFFECT_SUMMON = 28;
const CREATURE_TYPE_BEAST = 1;
const HIGH_GUID_UNIT = 0xf130n;
const HIGH_GUID_PET = 0xf140n;
const HIGH_GUID_VEHICLE = 0xf150n;

/** What the two lines read of the world; the live WorldClient satisfies it. */
export interface FrameXmlUnitTooltipWorld {
  readonly state: { readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  readonly names: { get(guid: bigint): string | undefined };
  requestName?(guid: bigint): void;
  readonly creatureTemplates: ReadonlyMap<number, { readonly found: boolean; readonly name: string; readonly creatureType: number }>;
  petNameOf?(object: WorldObjectState): string | undefined;
  readonly guildNames?: { name(guildId: number): string | undefined };
  queryGuildName?(guildId: number): void;
  readonly group?: { readonly members: readonly { readonly guid: bigint }[] } | undefined;
}

/** The guild line's name for a player unit; undefined (and asked for) while the cache lacks it. */
export function frameXmlUnitGuildName(world: FrameXmlUnitTooltipWorld, object: WorldObjectState | undefined): string | undefined {
  if (object?.typeId !== TYPEID_PLAYER) return undefined;
  const guildId = readField(object, "PLAYER_GUILDID") ?? 0;
  if (guildId <= 0) return undefined;
  const name = world.guildNames?.name(guildId);
  if (name === undefined) world.queryGuildName?.(guildId);
  return name;
}

/**
 * What a unit tooltip drawn now still waits for — the player's guild name, a corpse's loot owners'
 * names — as one test that turns true once any of it has come; undefined when nothing is pending.
 * Wow.exe redraws the tooltip from the cache callback (0x0061ddd0) that the guild (0x0067d930) and
 * name (0x0067d770) lookups of 0x00621070 register.
 */
export function frameXmlUnitPendingAnswers(
  world: FrameXmlUnitTooltipWorld, object: WorldObjectState | undefined,
  lootOwners: { readonly masterLooterGuid: bigint; readonly allowedLooterGuid: bigint } | undefined,
): (() => boolean) | undefined {
  const guildId = object?.typeId === TYPEID_PLAYER ? readField(object, "PLAYER_GUILDID") ?? 0 : 0;
  const guild = guildId > 0 && world.guildNames?.name(guildId) === undefined ? guildId : 0;
  const master = lootOwners && !named(world, lootOwners.masterLooterGuid) ? lootOwners.masterLooterGuid : 0n;
  const allowed = lootOwners && !named(world, lootOwners.allowedLooterGuid) ? lootOwners.allowedLooterGuid : 0n;
  if (guild === 0 && master === 0n && allowed === 0n) return undefined;
  return () => (guild !== 0 && world.guildNames?.name(guild) !== undefined)
    || (master !== 0n && named(world, master)) || (allowed !== 0n && named(world, allowed));
}

/** The loot lines' own lookup (LiveWorldSeam.unitLootOwners): the name cache, then the group list. */
function named(world: FrameXmlUnitTooltipWorld, guid: bigint): boolean {
  if (guid === 0n || world.names.get(guid) !== undefined) return true;
  for (const member of world.group?.members ?? NO_MEMBERS) if (member.guid === guid) return true;
  return false;
}
const NO_MEMBERS: readonly { readonly guid: bigint }[] = Object.freeze([]);

/** One unit tooltip's wait (FrameXmlUnitPendingAnswers), polled once per HUD frame. */
export class FrameXmlUnitTooltipRefresh {
  #pending: { readonly ready: () => boolean; readonly redraw: () => void } | undefined;

  watch(ready: () => boolean, redraw: () => void): () => void {
    const pending = { ready, redraw };
    this.#pending = pending;
    return () => { if (this.#pending === pending) this.#pending = undefined; };
  }

  tick(): void {
    const pending = this.#pending;
    if (!pending || !pending.ready()) return;
    this.#pending = undefined;
    pending.redraw();
  }
}

/** UNIT_FIELD_CHARMEDBY, else UNIT_FIELD_CREATEDBY; 0n with neither. */
function ownerOf(unit: WorldObjectState): bigint {
  const charmer = readField(unit, "UNIT_FIELD_CHARMEDBY") ?? 0n;
  return charmer !== 0n ? charmer : readField(unit, "UNIT_FIELD_CREATEDBY") ?? 0n;
}

/** 0x0074d750: the name a guid goes by; undefined while nothing names it (a player is asked for). */
function nameOf(world: FrameXmlUnitTooltipWorld, guid: bigint): string | undefined {
  const high = guid >> 48n;
  if ((guid >> 60n) === 0n) {
    const name = world.names.get(guid);
    if (name === undefined) world.requestName?.(guid);
    return name;
  }
  const object = world.state.objects.get(guid);
  if (high === HIGH_GUID_PET) return object ? world.petNameOf?.(object) : undefined;
  if (high !== HIGH_GUID_UNIT && high !== HIGH_GUID_VEHICLE) return undefined;
  const pet = object ? world.petNameOf?.(object) : undefined;
  if (pet) return pet;
  const entry = object ? readField(object, "OBJECT_FIELD_ENTRY") ?? 0 : Number((guid >> 24n) & 0xffffffn);
  const template = world.creatureTemplates.get(entry);
  return template?.found && template.name ? template.name : undefined;
}

export interface FrameXmlSummonTitleSources {
  /** The effect types of a spell row; undefined while the row is not loaded. */
  readonly spellEffects: (spellId: number) => readonly number[] | undefined;
  /**
   * SummonProperties.Title for the spell's `effect`-th effect (by its EffectMiscValueB): a number, -1
   * for the default rule; undefined while unknown (not served yet).
   */
  readonly summonPropertiesTitle?: (spellId: number, effect: number) => number | undefined;
}

/** L13: the spell row column the title reads (`/dbc/spells?v=17`, only on rows with a summon effect). */
export interface FrameXmlSummonSpellRow {
  readonly summonProperties?: readonly (SummonPropertiesRow | null)[] | undefined;
}

/**
 * L13 (3.12): SummonProperties.Title for the row's `effect`-th effect, as 0x0061e830 reads it: the row's Title,
 * -1 (the default) when the effect names no row; undefined while unknown — no row, or a summon row without
 * `summonProperties` (a gateway older than v=17, or a dataset without SummonProperties.dbc).
 */
export function frameXmlSummonPropertiesTitle(row: FrameXmlSummonSpellRow | undefined, effect: number): number | undefined {
  const properties = row?.summonProperties;
  if (properties === undefined) return undefined;
  return properties[effect]?.title ?? -1;
}

/** L13: the page's rows (`game.spells`), for a caller with no `summonPropertiesTitle` of its own. */
function pageSummonPropertiesTitle(spellId: number, effect: number): number | undefined {
  return frameXmlSummonPropertiesTitle(game.spells.get(spellId), effect);
}

/** The UNITNAME_SUMMON_TITLE line's key and owner name for a unit; undefined writes none. */
export function frameXmlUnitSummonTitle(
  world: FrameXmlUnitTooltipWorld, object: WorldObjectState | undefined, sources: FrameXmlSummonTitleSources,
): { readonly globalName: string; readonly ownerName: string | undefined } | undefined {
  if (!object || (object.typeId !== TYPEID_UNIT && object.typeId !== TYPEID_PLAYER)) return undefined;
  let owner = ownerOf(object);
  if (owner === 0n) return undefined;
  const ownerObject = world.state.objects.get(owner);
  if (ownerObject && (ownerObject.typeId === TYPEID_UNIT || ownerObject.typeId === TYPEID_PLAYER)) {
    const up = ownerOf(ownerObject);
    if (up !== 0n) owner = up;
  }
  let title: number | undefined;
  const spellId = readField(object, "UNIT_CREATED_BY_SPELL") ?? 0;
  if (spellId > 0) {
    const effects = sources.spellEffects(spellId);
    if (effects === undefined) return undefined;
    const summon = effects.slice(0, 3).indexOf(SPELL_EFFECT_SUMMON);
    if (summon >= 0) {
      const row = (sources.summonPropertiesTitle ?? pageSummonPropertiesTitle)(spellId, summon); // L13: + the page's rows
      if (row === undefined) return undefined;
      if (row === 0) return undefined;
      if (row > 0) title = row;
    }
  }
  if (title === undefined) {
    const entry = object.typeId === TYPEID_UNIT ? readField(object, "OBJECT_FIELD_ENTRY") ?? 0 : 0;
    const template = entry > 0 ? world.creatureTemplates.get(entry) : undefined;
    title = template?.found && template.creatureType === CREATURE_TYPE_BEAST ? 1 : 3;
  }
  return { globalName: `UNITNAME_SUMMON_TITLE${title}`, ownerName: nameOf(world, owner) };
}
