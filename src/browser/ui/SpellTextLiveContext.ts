import { POWER, readField, readSlot } from "../../world/Fields.js";
import type { ItemTemplate } from "../../world/QueryCacheProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import type { SpellDescriptionContext, SpellNumbers } from "./SpellText.js";
import type { SpellTextItem, SpellTextPlayer } from "./SpellTextPlayer.js";

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
  readonly auras: ReadonlyMap<bigint, ReadonlyMap<number, { readonly spellId: number }>>;
  readonly itemTemplates: ReadonlyMap<number, ItemTemplate>;
  readonly bindPoint?: { readonly areaId: number } | undefined;
}

export interface SpellTextLiveOptions {
  /** AreaTable's name of an area (AreaClient), for `$z`. */
  readonly areaName?: (areaId: number) => string | undefined;
  /** Whether the gateway has answered for a row (SpellMetadataClient.answered). */
  readonly answered?: (id: number) => boolean;
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
export function spellTextLivePlayer(world: SpellTextWorld | undefined): SpellTextPlayer | undefined {
  const guid = world?.state.selfGuid;
  const self = guid === undefined ? undefined : world!.state.objects.get(guid);
  if (!world || guid === undefined || !self) return undefined;
  let known: Set<number> | undefined;
  return {
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
  });
}

/** The whole context for a description written in this session. */
export function spellTextLiveContext(world: SpellTextWorld | undefined,
  spells: ReadonlyMap<number, SpellNumbers> | undefined, options: SpellTextLiveOptions = {}): SpellDescriptionContext {
  const player = spellTextLivePlayer(world);
  const areaId = world?.bindPoint?.areaId;
  const homeName = areaId === undefined ? undefined : options.areaName?.(areaId);
  return {
    ...(spells ? { spells } : {}),
    ...(options.answered ? { answered: options.answered } : {}),
    ...(player ? { player } : {}),
    ...(homeName ? { homeName } : {}),
  };
}
