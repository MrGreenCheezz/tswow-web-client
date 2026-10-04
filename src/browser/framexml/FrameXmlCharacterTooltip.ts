import type { ItemMetadata } from "../ItemMetadata.js";
import type { ItemTemplate } from "../../world/QueryCacheProtocol.js";
import {
  itemTooltipContent, itemTooltipFor, resetStockTooltipRedraws, type ItemTooltipContext,
} from "../ui/ItemTooltip.js";
import { game } from "../game/Context.js";
import { unknownLabel } from "../ui/Format.js";
import { ensureSpellNames } from "../ui/SpellNames.js";
import { formatSpellDescription } from "../ui/SpellText.js";
import type { TooltipContent, TooltipRefresh } from "../ui/Widgets.js";
import type { GameTooltipWidgetAdapter } from "../glue/GlueWidgets.js";
import type { FrameXmlActionTooltip, FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import type { FrameXmlSkinnableLine } from "./FrameXmlSkinnableTooltip.js";
import type { FrameXmlLootOwnerLine } from "./FrameXmlLootOwnerTooltip.js"; // 5.28 (L6)
import { frameXmlTooltipExtrasAdapter, type FrameXmlTooltipExtrasWorld } from "./FrameXmlTooltipExtrasAdapter.js";

/**
 * The item identity that the stock inventory buttons own, kept separate from the five-value C API
 * tuple. The seam reads the cached item instance; the shared live tooltip may asynchronously warm
 * enchantment and gem descriptions without waiting inside the synchronous Lua method.
 */
export interface FrameXmlInventoryTooltipItem {
  readonly entry: number;
  readonly metadata?: ItemMetadata;
  readonly template?: ItemTemplate;
  readonly count?: number;
  readonly durability?: number;
  readonly enchantments?: readonly number[];
  /** 5.22 (04.10, L4): ITEM_FIELD_DURATION, the seconds a timed item has left (ITEM_DURATION_* line). */
  readonly durationLeft?: number | undefined;
}

/** Optional, item-aware extension implemented by the world seams without widening the base seam. */
export interface FrameXmlInventoryTooltipSeam {
  readonly inventoryItemTooltip?:
    (unit: string, slot: number) => FrameXmlInventoryTooltipItem | undefined;
  readonly containerItemTooltip?:
    (bag: number, slot: number) => FrameXmlInventoryTooltipItem | undefined;
  /**
   * An item by entry for a link-shaped tooltip, from the seam's own item source. Only a seam with
   * no world behind it answers (CannedWorldSeam's fixtures); live, the world's cache is the source.
   */
  readonly itemTooltip?: (entry: number) => FrameXmlInventoryTooltipItem | undefined;
  /**
   * The client's own skinnable line for a unit (FrameXmlSkinnableTooltip.ts); live seams only.
   * `colorblind` is the `colorblindMode` CVar the binder read for this SetUnit.
   */
  readonly unitSkinnableLine?: (unit: string, colorblind?: boolean) => FrameXmlSkinnableLine | undefined;
  /** 3.12e: a creature's sub-name line (FrameXmlUnitSubName.ts); live seams only. */
  readonly unitSubName?: (unit: string) => string | undefined;
  /** 5.28 (L6): a corpse's MASTER_LOOTER/LOOT lines (FrameXmlLootOwnerTooltip.ts); live seams only. */
  readonly unitLootOwners?: (unit: string) => readonly FrameXmlLootOwnerLine[];
  /** 3.12 (04.10, L4): any player's guild name and the summon title line (FrameXmlUnitTooltipExtras.ts); live seams only. */
  readonly unitGuildName?: (unit: string) => string | undefined;
  readonly unitSummonTitle?: (unit: string) => { readonly globalName: string; readonly ownerName: string | undefined } | undefined;
  readonly watchUnitAnswers?: (unit: string, redraw: () => void) => (() => void) | undefined;
  /** The item's repair price for SetInventoryItem/SetBagItem (FrameXmlRepair.ts); live seams only. */
  readonly inventoryItemRepairCost?: (unit: string, slot: number) => number;
  readonly containerItemRepairCost?: (bag: number, slot: number) => number;
  /** 2.10: refund seconds for the item tooltip's REFUND_TIME_REMAINING line (FrameXmlRefund.ts); live seams only. */
  readonly containerItemRefundSeconds?: (bag: number, slot: number) => number | undefined;
  readonly inventoryItemRefundSeconds?: (unit: string, slot: number) => number | undefined;
}

/** `INVSLOT_FIRST_EQUIPPED..INVSLOT_LAST_EQUIPPED`: the worn slots `SetInventoryItem` names. */
const FIRST_EQUIPPED_SLOT = 1;
const LAST_EQUIPPED_SLOT = 19;

/**
 * The spellbook module, once loaded: its stock spell tooltip, and the description context that
 * knows the character's attack power for an item spell's words.
 *
 * Loaded rather than imported: the spellbook brings the whole native interface with it, which a
 * FrameXML boot without a world never needs. A boot with a world starts loading it when its
 * adapter is built, so the first spell hovered is not the one that waits for it. Until it has
 * arrived a spell falls back to its name; the stock action tooltip refreshes itself five times a
 * second, and a link-shaped tooltip is redrawn by {@link spellRefresh} when the module lands.
 */
let spellbook: typeof import("../ui/Spellbook.js") | undefined;
let spellbookLoading = false;

/**
 * Stock tooltips drawn before their spell row (or the spellbook module) arrived, one per spell and
 * kind (a buff's is keyed by the negated id).
 * Each redraw closes over the HUD that drew it, so a new HUD starts with none
 * ({@link resetFrameXmlTooltipRedraws}).
 */
const spellRedraws = new Map<number, () => void>();
const SPELL_REDRAW_LIMIT = 16;

/**
 * Runs each waiting redraw once, each on its own: `ensureSpellNames` calls its listeners in a row,
 * and a redraw that threw used to skip the ones after it — the native box's `refreshTooltip`
 * among them.
 */
function runSpellRedraws(): void {
  const due = [...spellRedraws.values()];
  spellRedraws.clear();
  for (const redraw of due) {
    try {
      redraw();
    } catch (error) {
      console.warn("Tooltip redraw failed", error);
    }
  }
}

/**
 * Forgets every stock tooltip still waiting for a late item or spell answer. Each of them belongs
 * to the HUD that drew it, and a redraw that outlives its HUD runs against a closed Lua state, so a
 * new HUD — a new adapter — starts without them; an unmount can call it too.
 */
export function resetFrameXmlTooltipRedraws(): void {
  spellRedraws.clear();
  resetStockTooltipRedraws();
}

function loadSpellbook(): void {
  if (spellbook || spellbookLoading) return;
  spellbookLoading = true;
  void import("../ui/Spellbook.js").then((module) => { spellbook = module; runSpellRedraws(); },
    () => { spellbookLoading = false; });
}

/**
 * Everything the FrameXML item paths share: the stock rows, never a worn comparison, and the
 * `ItemSubClass` word for the right half of the slot row («Двуручное» | «Топор»). That word comes
 * from the gateway's `/dbc/item-subclasses`, asked once per session on first use; until it has
 * answered — or on a gateway process that predates the route — the row is the slot alone, as before.
 */
function stockItemContext(): ItemTooltipContext {
  const context: ItemTooltipContext = {
    layout: "stock",
    compare: false,
    subclassName: (itemClass, subClass) => game.itemMetadata?.tooltipSubclassName(itemClass, subClass),
    // 5.22: the subclass word goes red without the proficiency (SMSG_SET_PROFICIENCY).
    proficient: (itemClass, subClass) => game.world?.isProficient?.(itemClass, subClass) ?? true,
  };
  const book = spellbook;
  // With the spellbook loaded an item spell's description is filled from the character's own
  // attack power and healing; without it `itemTooltipFor` still resolves it, those operands aside.
  if (book) {
    context.spellDescription = (id) => {
      const metadata = game.spells.get(id);
      return metadata?.description
        ? formatSpellDescription(metadata.description, metadata, book.spellDescriptionContext()) || undefined
        : undefined;
    };
  }
  return context;
}

function contentFor(
  item: FrameXmlInventoryTooltipItem | undefined, equipped = false,
): TooltipContent | undefined {
  if (!item || !Number.isSafeInteger(item.entry) || item.entry <= 0) return undefined;
  const facts: {
    entry: number;
    metadata?: ItemMetadata;
    template?: ItemTemplate;
  } = { entry: item.entry };
  if (item.metadata !== undefined) facts.metadata = item.metadata;
  if (item.template !== undefined) facts.template = item.template;
  const context = stockItemContext();
  // What is worn is never compared with itself; the stock setter says whether this is worn.
  if (equipped) context.equipped = true;
  if (item.enchantments !== undefined) context.enchantments = item.enchantments;
  if (item.count !== undefined && Number.isFinite(item.count) && item.count > 0) {
    context.count = Math.trunc(item.count);
  }
  if (item.durability !== undefined && Number.isFinite(item.durability) && item.durability >= 0) {
    context.durability = item.durability;
  }
  // 5.22 (04.10, L4): the item object's time left, for ITEM_DURATION_* (Wow.exe 0x006277f0 → 0x007070b0).
  if (item.durationLeft !== undefined && Number.isFinite(item.durationLeft)) context.durationLeft = item.durationLeft;
  return game.world && item.enchantments ? itemTooltipFor(item.entry, context) : itemTooltipContent(facts, context);
}

/** Redraws a link-shaped spell tooltip once its row, or the module that draws it, has landed. */
function spellRefresh(id: number, aura = false): TooltipRefresh {
  // A buff's tooltip and a link to the same spell wait side by side: they draw different prose.
  const key = aura ? -id : id;
  return {
    watch(redraw) {
      const run = (): void => {
        const next = spellContent(id, aura);
        // The row may land before the module that draws it, or the other way round.
        if (next) redraw(next);
        else if (!spellRedraws.has(key)) spellRedraws.set(key, run);
      };
      spellRedraws.delete(key);
      spellRedraws.set(key, run);
      if (spellRedraws.size > SPELL_REDRAW_LIMIT) spellRedraws.delete(spellRedraws.keys().next().value!);
      return () => { if (spellRedraws.get(key) === run) spellRedraws.delete(key); };
    },
  };
}

/**
 * A spell as the stock tooltip draws it — name and grey rank, cost and range, cast and cooldown,
 * gold description — once there is a live world whose spell metadata it reads. A row nobody has
 * asked for yet (a chat link, a trainer's spell) is asked for here, and its answer wakes the
 * tooltips waiting on it. `aura` draws the buff bar's text in place of the cast description.
 */
function spellContent(id: number, aura = false): TooltipContent | undefined {
  if (!game.world || !Number.isSafeInteger(id) || id <= 0) return undefined;
  if (!game.spells.get(id)) {
    ensureSpellNames([id], runSpellRedraws);
    return undefined;
  }
  if (!spellbook) {
    loadSpellbook();
    return undefined;
  }
  return aura ? spellbook.stockSpellTooltip(id, { aura: true }) : spellbook.stockSpellTooltip(id);
}

/**
 * `spell` for `SetHyperlink` (and `aura` for the buff bar): the full tooltip, or — while something
 * is on its way — what a stock tooltip keeps up and redraws rather than hiding. A cached row whose
 * module has not landed yet is already the spell's name and rank, so `GetSpell` names it; only a
 * row still on the wire is the numbered placeholder.
 */
function linkedSpellContent(id: number, aura = false): TooltipContent | undefined {
  const content = spellContent(id, aura);
  if (content || !game.world || !Number.isSafeInteger(id) || id <= 0) return content;
  const known = game.spells.get(id);
  if (known) {
    return known.rank
      ? { title: known.name, titleRight: known.rank, refresh: spellRefresh(id, aura) }
      : { title: known.name, refresh: spellRefresh(id, aura) };
  }
  return { title: unknownLabel("заклинание", id), footer: ["Описание загружается…"], refresh: spellRefresh(id, aura) };
}

/** An item by entry: the live item tooltip with a world, the template-less one without. */
function itemContent(entry: number): TooltipContent | undefined {
  if (!Number.isSafeInteger(entry) || entry <= 0) return undefined;
  const context = stockItemContext();
  return game.world ? itemTooltipFor(entry, context) : itemTooltipContent({ entry }, context);
}

/**
 * An item by entry with no world: what the seam itself knows of it — its fixture (a template, or a
 * name and quality), else the GetItemInfo prefix it serves the corpus — so a link on a canned route
 * names its item instead of «Предмет N / Описание загружается…». Undefined when the seam knows
 * nothing either.
 */
function seamItemContent(
  source: FrameXmlWorldSeam & FrameXmlInventoryTooltipSeam, entry: number,
): TooltipContent | undefined {
  if (!Number.isSafeInteger(entry) || entry <= 0) return undefined;
  const fixture = source.itemTooltip?.(entry);
  if (fixture) return contentFor(fixture);
  const info = source.itemInfo(entry);
  if (!info) return undefined;
  const [name, , quality] = info;
  return contentFor({
    entry, metadata: { entry, name, quality, displayId: 0, inventoryType: 0, stackable: 0, iconId: 0 },
  });
}

function actionContent(action: FrameXmlActionTooltip | undefined): TooltipContent | undefined {
  if (!action || !Number.isSafeInteger(action.id) || action.id <= 0
    || !["spell", "item", "macro", "equipment"].includes(action.kind)
    || typeof action.name !== "string" || action.name.length === 0) return undefined;
  const full = action.kind === "spell" ? spellContent(action.id)
    : action.kind === "item" && game.world ? itemContent(action.id) : undefined;
  if (full) return full;
  // The rank sits where the stock tooltip puts it, right of the name in grey.
  const rank = typeof action.rank === "string" && action.rank.length > 0 ? action.rank : undefined;
  return rank === undefined ? { title: action.name } : { title: action.name, titleRight: rank };
}

/**
 * The adapter this module builds: the binder's own shape, plus `aura` — a buff or debuff by spell
 * id, drawn with the spell's `AuraDescription` as the 3.3.5 client draws its buff bar. The binder's
 * aura setter (`GlueWidgets.setGameTooltipAura`) asks `aura` first and `spell` only when `aura`
 * answers nothing, per call; a spell row served without `AuraDescription` (a gateway older than
 * the field) draws its cast description through `aura` itself.
 */
export type FrameXmlCharacterTooltipAdapter = GameTooltipWidgetAdapter & {
  readonly aura: (id: number) => TooltipContent | undefined;
  /**
   * The line `GameTooltip:SetUnit` writes itself for a skinnable body, after the PvP line and
   * before `OnTooltipSetUnit`: `prefix` plus the GlobalStrings value `globalName`, in `color`.
   * `colorblind` is the `colorblindMode` CVar at the call; the prefix is its mark when on.
   */
  readonly unitSkinnable: (unit: string, colorblind: boolean) => FrameXmlSkinnableLine | undefined;
  /** 5.28 (L6): the loot lines SetUnit writes for a corpse (FrameXmlLootOwnerTooltip.ts); read by SetUnit since 04.10 (L4). */
  readonly unitLootOwners: (unit: string) => readonly FrameXmlLootOwnerLine[];
};

/** Build the common GameTooltip adapter from a live/canned item-aware seam. */
export function createFrameXmlCharacterTooltipAdapter(
  seam: FrameXmlWorldSeam | undefined,
): FrameXmlCharacterTooltipAdapter | undefined {
  const source = seam as (FrameXmlWorldSeam & FrameXmlInventoryTooltipSeam) | undefined;
  if (!source) return undefined;
  // One adapter per FrameXML boot: whatever the last HUD left waiting is for a Lua state that is
  // closed or about to be.
  resetFrameXmlTooltipRedraws();
  if (game.world) loadSpellbook();
  return {
    inventoryItem: (unit, slot) => contentFor(source.inventoryItemTooltip?.(unit, slot),
      unit === "player" && slot >= FIRST_EQUIPPED_SLOT && slot <= LAST_EQUIPPED_SLOT),
    containerItem: (bag, slot) => contentFor(source.containerItemTooltip?.(bag, slot)),
    action: (slot) => actionContent(source.actionTooltip?.(slot)),
    // What the slot holds, so `SetAction` can answer `GetSpell`/`GetItem` and raise the event
    // AnyIDTooltip's «SpellID:» row hangs off.
    actionIdentity: (slot) => {
      const action = source.actionTooltip?.(slot);
      return action && Number.isSafeInteger(action.id) && action.id > 0 ? { kind: action.kind, id: action.id } : undefined;
    },
    // A pet bar spell for GameTooltip:SetPetAction (FrameXmlPetActionBar.ts); commands keep their name line.
    petActionSpell: (index) => source.petActions?.spellAt(index),
    // 11.02-IF-review: GameTooltip:SetPossession(1) draws the seam's possess spell (FrameXmlPossess.ts).
    possessionSpell: () => source.possess?.possessSpell || undefined,
    // Live, the world's item cache; with none (the canned routes) the seam's own item source first.
    item: (entry) => (game.world ? undefined : seamItemContent(source, entry)) ?? itemContent(entry),
    spell: (id) => linkedSpellContent(id),
    aura: (id) => linkedSpellContent(id, true),
    // 5.20: `/dbc/spells?v=15`'s dispelName (SpellDispelType.Name, Wow.exe 0x00625350); none before it.
    auraDispelName: (id) => game.spells.get(id)?.dispelName,
    unitSkinnable: (unit, colorblind) => source.unitSkinnableLine?.(unit, colorblind),
    unitSubName: (unit) => source.unitSubName?.(unit),
    unitLootOwners: (unit) => source.unitLootOwners?.(unit) ?? [], // 5.28 (L6)
    unitGuildName: (unit) => source.unitGuildName?.(unit), // 3.12 (04.10, L4)
    unitSummonTitle: (unit) => source.unitSummonTitle?.(unit), // 3.12 (04.10, L4)
    watchUnitAnswers: (unit, redraw) => source.watchUnitAnswers?.(unit, redraw), // 3.12 (04.10, L4)
    inventoryItemRepairCost: (unit, slot) => source.inventoryItemRepairCost?.(unit, slot) ?? 0,
    containerItemRepairCost: (bag, slot) => source.containerItemRepairCost?.(bag, slot) ?? 0,
    containerItemRefundSeconds: (bag, slot) => source.containerItemRefundSeconds?.(bag, slot),
    inventoryItemRefundSeconds: (unit, slot) => source.inventoryItemRefundSeconds?.(unit, slot),
    // Plan item 3.12: talents, quest/glyph links and the reward spells (FrameXmlTooltipExtrasAdapter.ts).
    ...frameXmlTooltipExtrasAdapter(source, (): FrameXmlTooltipExtrasWorld => game, (id) => linkedSpellContent(id)),
  };
}
