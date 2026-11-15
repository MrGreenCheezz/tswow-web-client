import { POWER, readField, readGuidAt, readSlot } from "../../world/Fields.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js"; // 3.43 (15.11)
import type { SpellCostInventoryItem } from "./SpellTextCost.js"; // 3.43 (15.11)
import type { ItemTemplate } from "../../world/QueryCacheProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { readSkills, type SkillEntry } from "./Skills.js"; // 3.43 (11.11)
import type { SpellDescriptionContext, SpellNumbers } from "./SpellText.js";
import {
  spellTextPeriodicHaste, spellTextPlayerSpellLevel, type SpellTextCaster, type SpellTextModifier,
  type SpellTextSkillAbility, type SpellTextWeaponSwap,
} from "./SpellTextCaster.js"; // 3.43 (11.11)
import type { SpellTextItem, SpellTextPlayer } from "./SpellTextPlayer.js";
import { classSpellFamily } from "./UnitSnapshot.js"; // 3.43 (11.11)

/**
 * 12.10: the description context of a live session — the active player Wow.exe's writer reads
 * (SpellTextPlayer.ts), the rows already fetched, and the hearthstone's area for `$z`. One builder
 * for every surface that writes a spell description (the spellbook, the stock tooltips, an item's
 * «Использование:» line, the trade skill window), so none of them falls back to Wow.exe's
 * «no active player» rules while a player is in the world.
 */

/** The part of a WorldClient this reads. */
export interface SpellTextWorld {
  readonly state: { readonly selfGuid: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  readonly knownSpells: readonly { readonly id: number }[];
  /** 3.43: with the slot's flags byte (AFLAG_EFF_INDEX_n in bits 0-2), which the aura-316 haste reads. */
  readonly auras: ReadonlyMap<bigint, ReadonlyMap<number, { readonly spellId: number; readonly flags?: number }>>;
  readonly itemTemplates: ReadonlyMap<number, ItemTemplate>;
  readonly bindPoint?: { readonly areaId: number } | undefined;
  /** 3.43: the player's SPELLMOD entries (SMSG_SET_FLAT/PCT_SPELL_MODIFIER, WorldClient.spellModifiers). */
  readonly spellModifiers?: ReadonlyMap<string, SpellTextModifier>;
  /** 3.43 (15.11): the action buttons (SMSG_ACTION_BUTTONS), for the multi-cast totems' cost; absent, unknown. */
  readonly actionButtons?: readonly { readonly slot: number; readonly action: number; readonly type: number }[];
}

export interface SpellTextLiveOptions {
  /** AreaTable's name of an area (AreaClient), for `$z`. */
  readonly areaName?: (areaId: number) => string | undefined;
  /** Whether the gateway has answered for a row (SpellMetadataClient.answered). */
  readonly answered?: (id: number) => boolean;
  /** 3.43: a spell's SkillLineAbility rows (TalentClient.spellAbilitiesOf); absent, no row — level 0. */
  readonly spellAbilities?: (spellId: number) => readonly SpellTextSkillAbility[] | undefined;
  /** 3.43: ChrClasses.SpellClassSet of a class (UnitSnapshot.classSpellFamily); absent, no spell modifiers. */
  readonly spellFamily?: (classId: number) => number | undefined;
}

const NO_MODIFIERS: readonly SpellTextModifier[] = [];

/**
 * 3.43 (11.11): the active player as the caster-side rules read it (SpellTextCaster.ts) — the level a spell grows by
 * from its skill line, the class's spell family, the SPELLMOD entries and the aura-316 haste — or undefined without
 * one in the world.
 */
export function spellTextLiveCaster(world: SpellTextWorld | undefined, spells: ReadonlyMap<number, SpellNumbers> | undefined,
  options: SpellTextLiveOptions = {}): SpellTextCaster | undefined {
  const guid = world?.state.selfGuid;
  const self = guid === undefined ? undefined : world!.state.objects.get(guid);
  if (!world || guid === undefined || !self) return undefined;
  // UNIT_FIELD_BYTES_0: race in byte 0 (+0x44), class in byte 1 (+0x45), as 0x006dc330 reads them.
  const bytes0 = readField(self, "UNIT_FIELD_BYTES_0") ?? 0;
  const race = bytes0 & 0xff;
  const classId = (bytes0 >>> 8) & 0xff;
  let skills: SkillEntry[] | undefined;
  // 3.43 (15.11): 0x006d4920's swap — the weapons in the three attack hands and the swapped spell's row and abilities.
  const swap: SpellTextWeaponSwap = {
    weapon: (hand) => {
      const entry = Math.abs(readSlot(self, UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset + (15 + hand) * 2) ?? 0);
      if (entry === 0) return null;
      const template = world.itemTemplates.get(entry);
      return template?.found ? { itemClass: template.itemClass, subClass: template.subClass } : undefined;
    },
    row: (id) => spells?.get(id) ?? (options.answered && !options.answered(id) ? "pending" : undefined),
    abilities: (id) => options.spellAbilities?.(id),
  };
  return {
    level: (record) => record.id === undefined ? 0
      : spellTextPlayerSpellLevel(record, race, classId, options.spellAbilities?.(record.id), skills ??= readSkills(self), swap),
    family: options.spellFamily?.(classId),
    modifiers: () => world.spellModifiers?.values() ?? NO_MODIFIERS,
    periodicHaste: (record) => spellTextPeriodicHaste(record, world.auras.get(guid)?.values() ?? [], (id) => spells?.get(id)),
  };
}

/** SPELL_AURA_MOD_SHAPESHIFT. */
const SPELL_AURA_MOD_SHAPESHIFT = 36;

/**
 * 3.43 (15.11): the CombatRoundTime of the player's form (0x008012f0 via 0x0071af70), read off the form aura's row
 * (`shapeshiftCombatRoundTime`, /dbc/spells?v=22): an aura with a MOD_SHAPESHIFT effect of that form. Undefined while
 * no such row is known.
 */
export function spellTextFormRoundTime(auras: Iterable<{ readonly spellId: number }>, form: number,
  spells: ReadonlyMap<number, SpellNumbers> | undefined): number | undefined {
  for (const aura of auras) {
    const row = spells?.get(aura.spellId);
    if (!row || row.shapeshiftCombatRoundTime === undefined) continue;
    const effect = (row.effectAura ?? []).indexOf(SPELL_AURA_MOD_SHAPESHIFT);
    if (effect >= 0 && row.effectMiscValue?.[effect] === form) return row.shapeshiftCombatRoundTime;
  }
  return undefined;
}

/**
 * 3.43 (15.11): the item in an equipment slot as 0x008012f0 reads it (0x00754400: PLAYER_FIELD_INV_SLOT_HEAD's guid;
 * 0x006d71a0: its flags and durability; 0x0067ca30: the template's Delay). Null for an empty slot; undefined while the
 * item object is not known.
 */
function spellTextInventoryItem(world: SpellTextWorld, self: WorldObjectState, equipSlot: number): SpellCostInventoryItem | null | undefined {
  const guid = readGuidAt(self, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + equipSlot * 2);
  if (guid === undefined) return undefined;
  if (guid === 0n) return null;
  const item = world.state.objects.get(guid);
  if (!item) return undefined;
  const entry = readField(item, "OBJECT_FIELD_ENTRY") ?? 0;
  const template = world.itemTemplates.get(entry);
  return {
    flags: readField(item, "ITEM_FIELD_FLAGS") ?? 0,
    durability: readField(item, "ITEM_FIELD_DURABILITY") ?? 0,
    maxDurability: readField(item, "ITEM_FIELD_MAXDURABILITY") ?? 0,
    delay: template?.found ? template.delay : undefined,
  };
}

/** The first damage entry and class of an item template, as 0x0067ca30's record has them. */
function spellTextItem(template: ItemTemplate | undefined): SpellTextItem | undefined {
  if (!template?.found) return undefined;
  const damage = template.damage[0];
  return {
    itemClass: template.itemClass, subClass: template.subClass,
    damageMin: damage?.min ?? 0, damageMax: damage?.max ?? 0, damageType: damage?.type ?? 0,
  };
}

/** The active player as the description writer reads it, or undefined without one in the world. */
export function spellTextLivePlayer(world: SpellTextWorld | undefined,
  spells?: ReadonlyMap<number, SpellNumbers>): SpellTextPlayer | undefined {
  const guid = world?.state.selfGuid;
  const self = guid === undefined ? undefined : world!.state.objects.get(guid);
  if (!world || guid === undefined || !self) return undefined;
  let known: Set<number> | undefined;
  return {
    // 3.43 (15.11): what 0x008012f0 reads besides the fields (SpellTextCost.ts).
    formRoundTime: (form) => spellTextFormRoundTime(world.auras.get(guid)?.values() ?? [], form, spells),
    inventoryItem: (equipSlot) => spellTextInventoryItem(world, self, equipSlot),
    actionSpell: (slot) => {
      const buttons = world.actionButtons;
      if (!buttons) return undefined;
      const button = buttons.find((entry) => entry.slot === slot);
      if (!button) return 0;
      // ACTION_BUTTON_SPELL; a macro or an item button 0x005a8c30 resolves further, which this does not read.
      return button.type === 0 ? button.action : undefined;
    },
    slot: (index) => readSlot(self, index),
    knowsSpell: (id) => (known ??= new Set(world.knownSpells.map((spell) => spell.id))).has(id),
    hasAura: (id) => {
      for (const aura of world.auras.get(guid)?.values() ?? []) if (aura.spellId === id) return true;
      return false;
    },
    item: (entry) => spellTextItem(world.itemTemplates.get(entry)),
    // 0x0071b770 for mana is UNIT_FIELD_BASE_MANA, as Spellbook.ts's cost row reads it.
    basePower: (powerType) => powerType === POWER.mana ? readField(self, "UNIT_FIELD_BASE_MANA") : undefined,
  };
}

/** This session's context: `game`'s world, rows, areas and metadata client. */
export function sessionSpellDescriptionContext(): SpellDescriptionContext {
  return spellTextLiveContext(game.world, game.spells, {
    areaName: (areaId) => game.areas?.area(areaId)?.name,
    answered: (id) => game.spellMetadataClient?.answered(id) ?? true,
    spellAbilities: (id) => game.talentData?.spellAbilitiesOf(id), // 3.43 (11.11)
    spellFamily: classSpellFamily, // 3.43 (11.11)
  });
}

/** The whole context for a description written in this session. */
export function spellTextLiveContext(world: SpellTextWorld | undefined,
  spells: ReadonlyMap<number, SpellNumbers> | undefined, options: SpellTextLiveOptions = {}): SpellDescriptionContext {
  const player = spellTextLivePlayer(world, spells);
  const caster = spellTextLiveCaster(world, spells, options); // 3.43 (11.11)
  const areaId = world?.bindPoint?.areaId;
  const homeName = areaId === undefined ? undefined : options.areaName?.(areaId);
  return {
    ...(spells ? { spells } : {}),
    ...(options.answered ? { answered: options.answered } : {}),
    ...(player ? { player } : {}),
    ...(caster ? { caster } : {}),
    ...(homeName ? { homeName } : {}),
  };
}
