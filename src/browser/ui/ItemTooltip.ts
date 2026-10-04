import { ITEM_MOD_NAMES, globalString } from "../../generated/globalStrings.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { ItemMetadata } from "../ItemMetadata.js";
import { itemEnchantments, itemSocketColors, type ItemEnchantmentInfo, type GemPropertyInfo } from "../ItemEnchantments.js";
import { hasItemSpell, type ItemSpell, type ItemTemplate } from "../../world/QueryCacheProtocol.js";
import { worldObject } from "../../world/Fields.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { playerInventory } from "../Inventory.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { game } from "../game/Context.js";
import { formatMoney, reputationRankName, unknownLabel } from "./Format.js";
import { ensureSpellNames, spellName } from "./SpellNames.js";
import { formatSpellDescription } from "./SpellText.js";
import { className, raceName } from "./UnitSnapshot.js";
import { itemDurationParts, itemDurationSeconds } from "./ItemDurationText.js"; // 5.22 (04.10, L4)
import {
  refreshTooltip, type TooltipContent, type TooltipLine, type TooltipRefresh, type TooltipTone,
} from "./Widgets.js";

/**
 * The one item tooltip, for the nine places that show one.
 *
 * Nineteen places printed «Предмет N» and seven of them asked for the row that would have replaced
 * it; the loot window, the vendor's shelf, the group roll, the trade offer, the auction and the
 * mail were not among the seven. What every one of them showed instead came from
 * `ItemMetadataClient`, whose ten fields are a name, an icon, a quality, a slot and a stack size —
 * so a weapon's tooltip was three lines long and 8,086 of the dump's 38,609 rows had a tooltip of
 * exactly one line, the word for the quality (taken over `data/items.json`; the counting script is
 * in the slice's report).
 *
 * The whole row was never missing. `SMSG_ITEM_QUERY_SINGLE_RESPONSE` is parsed field for field
 * (`QueryCacheProtocol.ts:214-311`), `WorldClient.itemTemplates` keeps it, and
 * `world.itemTemplate(entry)` hands it back synchronously and sends the query itself on a miss. So
 * this takes the two sources side by side rather than merging them: `ItemMetadata` is a gateway
 * type validated by `isItemMetadata`, and `src/gateway` may not depend on `src/world`.
 *
 * DOM-free, like `ChatLink` and `SpellText`, so the order of the lines can be tested without a
 * page. The order itself is the reference client's (`wowee/src/ui/item_tooltip.cpp:219-604`), and
 * the words are the dataset's own — `ITEM_*`, `INVTYPE_*`, `RESISTANCE*`, `ARMOR_TEMPLATE`,
 * `DAMAGE_TEMPLATE`, `DPS_TEMPLATE`, `DURABILITY_TEMPLATE`, `SELL_PRICE`, `SPEED` — because
 * writing them again would be inventing a translation for a game that has one.
 */

/** `ItemFlags` bits a tooltip reads (`ItemTemplate.h:159` and `:175`). */
const ITEM_FLAG_HEROIC_TOOLTIP = 0x0000_0008;
const ITEM_FLAG_UNIQUE_EQUIPPABLE = 0x0008_0000;

/** A mask with every bit set is what «any class» and «any race» look like on the wire. */
const ALLOW_ANY = 0xffff_ffff;

/**
 * The classes and races 3.3.5 has, which are the only ones a restriction can be naming.
 *
 * There is no class 10 and no race 9 in this build — `CLASS_NAMES` and `RACE_NAMES`
 * (`UnitSnapshot.ts:93` and `:107`) are records rather than dense arrays for exactly that reason —
 * and the mask is 32 bits wide, so reading every bit of one invents a name for classes 10 and 12
 * to 32 and for races 9 and 12 to 32. The reference client walks its own list of the real ten and
 * nothing else (`wowee/src/ui/item_tooltip.cpp:63-78` and `:80-97`, over `kClassMasks` and
 * `kRaceMasks` in `include/ui/ui_colors.hpp:215-226`).
 */
const PLAYABLE_CLASSES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11];
const PLAYABLE_RACES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11];

/**
 * What counts as a weapon for the damage line, by the slot it is worn in.
 *
 * A damage range together with a swing timer is not the test. Of the 4,395 `item_template` rows of
 * `TDB_full_world_335.24081` that carry both, 55 are worn in no weapon slot: 53 are arrows and
 * bullets — class 6, `INVTYPE_AMMO`, `Rough Arrow` (2512) among them, 1–2 damage and a `delay` of
 * 3000 that is a leftover rather than a swing — and the other two are `Throwing Tomahawk` (4959,
 * slot 0) and `Admin Warlord's Claymore` (1700, slot 2, `itemClass` 0). All 55 were getting the
 * weapon block; the arrow's read «Урон: 1 - 2  Скорость 3.00» and «(0.5 ед. урона в секунду)».
 * The reference closes the same block by slot (`wowee/include/game/inventory.hpp:71-84`, used at
 * `src/ui/item_tooltip.cpp:297`).
 *
 * 22 is on this list and not on the reference's, whose predicate is there to decide whether two
 * items may be compared side by side and lumps the off hand in with shields and held-in-off-hand.
 * Every one of the dump's 159 rows worn in slot 22 with damage is `itemClass` 2 — `Dal'Rend's
 * Tribal Guardian`, `White Bone Shredder` — and an off-hand sword's damage is on its tooltip.
 */
const WEAPON_INVENTORY_TYPES: readonly number[] = [13, 15, 17, 21, 22, 25, 26];

/**
 * `InventoryType` as the *client* names it, which is not quite how the core does.
 *
 * The words are the dataset's `INVTYPE_*`, so what this list carries is the join between the
 * number on the wire (`ItemTemplate.h:263-294`) and the name of the string. Three of them differ
 * and the two lists therefore cannot simply be zipped: the core's `SHOULDERS`, `WRISTS` and
 * `HANDS` are the client's `SHOULDER`, `WRIST` and `HAND`. Slot 0 is `INVTYPE_NON_EQUIP` — a
 * reagent, a quest item, a recipe — and has no word in either.
 */
const INVENTORY_TYPE_KEYS: readonly string[] = [
  "", "HEAD", "NECK", "SHOULDER", "BODY", "CHEST", "WAIST", "LEGS", "FEET", "WRIST", "HAND",
  "FINGER", "TRINKET", "WEAPON", "SHIELD", "RANGED", "CLOAK", "2HWEAPON", "BAG", "TABARD", "ROBE",
  "WEAPONMAINHAND", "WEAPONOFFHAND", "HOLDABLE", "AMMO", "THROWN", "RANGEDRIGHT", "QUIVER", "RELIC",
];

/** What an item is worn as, in the realm's own words, or nothing for the 13,230 worn as nothing. */
export function inventoryTypeName(inventoryType: number): string | undefined {
  const key = INVENTORY_TYPE_KEYS[inventoryType];
  return key ? globalString(`INVTYPE_${key}`) : undefined;
}

/** `SocketColor` (`ItemTemplate.h:255-258`) and the dataset's word for an empty one of each. */
const SOCKET_COLORS: ReadonlyArray<readonly [number, string]> = [
  [1, "META"], [2, "RED"], [4, "YELLOW"], [8, "BLUE"],
];

/**
 * `ItemSpelltriggerType` as a line's opening word.
 *
 * Four of the six triggers are «Использование:»: 0 is on use, 4 is a soulstone, 5 is on use with
 * no delay and 6 teaches a recipe. The reference client keeps the same four together and explains
 * why (`wowee/include/game/item_text.hpp:32-41`); a trigger with nothing to say gives no line at
 * all. A recipe's «Использование: Обучает…» is not one of these lines, though: its two spells —
 * «Изучение» (483) and the craft spell it teaches — both have empty descriptions, and the
 * teaching is the *item's* description (`ITEM_CLASS_RECIPE` below).
 */
function spellTriggerText(trigger: number): string | undefined {
  if (trigger === 1) return globalString("ITEM_SPELL_TRIGGER_ONEQUIP");
  if (trigger === 2) return globalString("ITEM_SPELL_TRIGGER_ONPROC");
  if (trigger === 0 || trigger === 4 || trigger === 5 || trigger === 6) {
    return globalString("ITEM_SPELL_TRIGGER_ONUSE");
  }
  return undefined;
}

/**
 * `ItemClass` 9, a recipe: the one class whose description the original prints as the green
 * «Использование:» line rather than as the quoted gold line at the bottom. 6328 «Рецепт:
 * острозубый илистый луциан» carries «Обучает приготовлению острозубого илистого луциана.» there,
 * and neither of its spells has a word to say.
 */
const ITEM_CLASS_RECIPE = 9;
/** `ItemSpelltriggerType` 6, `ITEM_SPELLTRIGGER_LEARN_SPELL_ID`: the spell a recipe teaches. */
const ITEM_SPELLTRIGGER_LEARN_SPELL = 6;
/** `SPELL_EFFECT_CREATE_ITEM` (24): the effect whose `EffectItemType` is what a craft spell makes. */
const SPELL_EFFECT_CREATE_ITEM = 24;

/**
 * `ITEM_QUALITY_COLORS[0..7].hex` (`UIParent.lua`), for the name of a recipe's product: a line
 * inside a tooltip has no quality of its own, only a colour.
 */
const STOCK_QUALITY_COLORS: readonly string[] = [
  "#9d9d9d", "#ffffff", "#1eff00", "#0070dd", "#a335ee", "#ff8000", "#e6cc80", "#e6cc80",
];

/** `ItemBondingType`: 1 on pickup, 2 on equip, 3 on use, 4 a quest item; 0 binds to nobody. */
function bindingText(bonding: number): string | undefined {
  return globalString(["", "ITEM_BIND_ON_PICKUP", "ITEM_BIND_ON_EQUIP", "ITEM_BIND_ON_USE",
    "ITEM_BIND_QUEST"][bonding] ?? "");
}

/**
 * One of the client's own templates with the numbers put into it.
 *
 * A FrameXML string is a `printf` template with two additions, and both are in the strings this
 * file uses: `%1$d` names its argument where the translation reordered them, and
 * `|4one:few:many;` is a plural that agrees with the number written before it. `CONTAINER_SLOTS`
 * is «%2$s (%1$d |4ячейка:ячейки:ячеек;)» and needs both at once. `%c` is not handled here — it
 * is a stat's sign, and the caller puts it in before the rest, because whether a value carries its
 * own sign depends on whether the template asked for one.
 */
export function fillTemplate(template: string, ...values: ReadonlyArray<string | number>): string {
  let next = 0;
  /** The last number written out, which is what a plural has to agree with. */
  let last = 0;
  const filled = template.replace(/%(?:(\d+)\$)?(?:\.(\d+))?([dsf])/g,
    (whole, position: string | undefined, precision: string | undefined, kind: string) => {
      const value = values[position ? Number(position) - 1 : next++];
      if (value === undefined) return whole;
      if (typeof value !== "number") return value;
      last = value;
      return kind === "f" ? value.toFixed(Number(precision ?? "0")) : String(Math.round(value));
    });
  // Russian takes three forms — one, two to four, five and up — and eleven to fourteen take the
  // third whatever their last digit is. The three forms are the dataset's; only the choice is code.
  return filled.replace(/\|4([^:;]*):([^:;]*):([^;]*);/g,
    (_whole, one: string, few: string, many: string) => {
      const hundreds = Math.abs(last) % 100;
      const tens = hundreds % 10;
      if (hundreds >= 11 && hundreds <= 14) return many;
      return tens === 1 ? one : tens >= 2 && tens <= 4 ? few : many;
    });
}

const signed = (value: number): string => value < 0 ? String(value) : `+${value}`;

/** 5.22 (04.10, L4): a timed item's ITEM_DURATION_* line, or undefined (ItemDurationText.ts). */
function itemDurationLine(templateDuration: number, left: number | undefined): string | undefined {
  const seconds = itemDurationSeconds(templateDuration, left);
  if (seconds === undefined) return undefined;
  const { key, count } = itemDurationParts(seconds);
  const template = globalString(key);
  return template === undefined ? undefined : fillTemplate(template, count);
}

/**
 * One stat of the counted block, in words.
 *
 * The dataset provides both long and short forms for each stat. The short form is what goes on the
 * shared line the five primary stats sit on. The numbering has holes — 2 and 8 to 11 do not exist and 40 is not in
 * 3.3 — so `ITEM_MOD_NAMES` is a join rather than an index, and a type this build has no name for
 * still prints its number rather than vanishing.
 */
function statText(type: number, value: number, short: boolean): string {
  const key = ITEM_MOD_NAMES[type];
  const template = key === undefined ? undefined : globalString(short ? `ITEM_MOD_${key}_SHORT` : `ITEM_MOD_${key}`);
  if (template === undefined) return `${signed(value)} к характеристике ${type}`;
  if (short) return `${signed(value)} ${template}`;
  // Two ways of asking for a sign and both are in the table: seven templates write `%c` and let
  // the caller fill it, and 25 more write the plus into the sentence themselves — «Рейтинг
  // меткости +%d.» — which read «+-12» for a negative value. The remaining eleven ask for neither
  // («Увеличивает силу атаки на %d.») and take the number as it comes. Whichever of the two is
  // there, the sign comes out of the template and the magnitude goes in, so the plural still has
  // a number to agree with. The reference reaches the same place with `%+d`
  // (`wowee/src/ui/item_tooltip.cpp:346`). Unreachable from the shipped TDB — all 21 of its
  // negative `stat_value`s are on types 3–7, which go the short way — and reachable from an
  // `item_template` row a tswow module writes.
  const sign = /%c|\+(?=%(?:\d+\$)?d)/;
  if (!sign.test(template)) return fillTemplate(template, value);
  return fillTemplate(template.replace(sign, value < 0 ? "-" : "+"), Math.abs(value));
}

/** The five that share a line, in the order the original and the reference both write them. */
const PRIMARY_STATS: readonly number[] = [4, 3, 7, 5, 6];

/** What the client knows about one item: the dump's row, the server's row, or neither. */
export interface ItemFacts {
  entry: number;
  /** `data/items.json` plus whatever the query has already corrected — a name, an icon, a slot. */
  metadata?: ItemMetadata | undefined;
  /** The whole `item_template` row. Everything below the first two lines is made of this. */
  template?: ItemTemplate | undefined;
}

/** What the caller knows and the item does not. */
export interface ItemTooltipContext {
  /** Enchantment slots on this exact item instance, never inferred from its template. */
  enchantments?: readonly number[] | undefined;
  enchantment?: ((id: number) => ItemEnchantmentInfo | undefined) | undefined;
  gemProperty?: ((id: number) => GemPropertyInfo | undefined) | undefined;
  gemMetadataReady?: boolean | undefined;
  gemName?: ((entry: number) => string | undefined) | undefined;
  /** How many are in hand: a stack, a loot bundle, a vendor's `buyCount`, a mail attachment. */
  count?: number | undefined;
  /** The character's level, which is what decides whether «Требуется уровень» is red. */
  playerLevel?: number | undefined;
  /** `ITEM_FIELD_DURABILITY`, which only an item the player actually owns has. */
  durability?: number | undefined;
  /**
   * 5.22 (04.10, L4): `ITEM_FIELD_DURATION` of an item object, the seconds a timed item has left
   * (ItemDurationText.ts); without it the record's own Duration is shown.
   */
  durationLeft?: number | undefined;
  /** `SkillLine.Name` for the skill an item demands, when the caller has the table. */
  skillName?: ((skillId: number) => string | undefined) | undefined;
  /**
   * A spell's name, for the native layout's «Использование:» lines (the stock one prints the
   * description). Nothing for a row that has nothing to say, or none yet: then there is no line.
   */
  spellName?: ((spellId: number) => string | undefined) | undefined;
  /** What a click will do here, which differs in every one of the nine windows. */
  footer?: readonly string[] | undefined;
  /** True when this tooltip is for an already-equipped item: no worn-comparison is added. */
  equipped?: boolean | undefined;
  /**
   * False: no «Сейчас надето» lines at all. The stock `GameTooltip` never carries them — the
   * original compares in `ShoppingTooltip1/2`, on Shift — so the FrameXML adapter always says so.
   */
  compare?: boolean | undefined;
  /** "stock": the rows the 3.3.5 `GameTooltip` draws ({@link stockItemTooltipContent}). */
  layout?: "native" | "stock" | undefined;
  /** A spell's description, filled in: what the stock «Использование:» line says. */
  spellDescription?: ((spellId: number) => string | undefined) | undefined;
  /**
   * `ItemSubClass` in words — «Латы», «Топор» — the right half of the stock slot row. The FrameXML
   * adapter passes `ItemMetadataClient.tooltipSubclassName` (the gateway's `/dbc/item-subclasses`);
   * a caller without it, or before that table has answered, gets the slot alone.
   */
  subclassName?: ((itemClass: number, subClass: number) => string | undefined) | undefined;
  /**
   * `SMSG_SET_PROFICIENCY` (5.22): false paints that subclass word red, as the original's tooltip
   * (0x628xxx through 0x6cde90) does for armour and weapons the character cannot use.
   */
  proficient?: ((itemClass: number, subClass: number) => boolean) | undefined;
  /**
   * The row of an item's spell, for what a recipe's learn spell makes and takes: the product is
   * the `EffectItemType` of its `SPELL_EFFECT_CREATE_ITEM` effect, the reagents are the
   * «Требуется:» line. Nothing for a row not yet cached: the block waits for it.
   */
  spellRow?: ((spellId: number) => RecipeSpellRow | undefined) | undefined;
  /**
   * What this session knows of another item the tooltip names — a recipe's product, a reagent —
   * `template` still undefined while its row is on its way, `found` false when the server has no
   * such row. Asking is the caller's: `itemTooltipFor` sends the query and waits for the answer.
   */
  item?: ((entry: number) => ItemFacts | undefined) | undefined;
  /**
   * True for a recipe's product drawn inside the recipe's own tooltip: its rows without a sell
   * price, flavour text, footer or block of its own, which the original prints once, for the
   * recipe.
   */
  nested?: boolean | undefined;
}

/** The three columns of a spell row a recipe's block reads. */
export type RecipeSpellRow = Pick<SpellMetadata, "effects" | "effectItemType" | "reagents">;

export function itemTooltipContent(facts: ItemFacts, context: ItemTooltipContext = {}): TooltipContent {
  if (context.layout === "stock") return stockItemTooltipContent(facts, context);
  // A row the server answered with the missing bit set is not a row: it carries an entry and
  // nothing else, and treating it as one would print an item made entirely of zeros.
  const template = facts.template?.found === true ? facts.template : undefined;
  const metadata = facts.metadata;
  const lines: TooltipLine[] = [];
  const footer: string[] = [];
  const push = (text: string | undefined, tone?: TooltipTone): void => {
    if (text) lines.push(tone === undefined ? { text } : { text, tone });
  };

  if (template) {
    if (template.itemLevel > 0) push(fillTemplate(globalString("ITEM_LEVEL") ?? "", template.itemLevel), "muted");
    if ((template.flags & ITEM_FLAG_HEROIC_TOOLTIP) !== 0) push(globalString("ITEM_HEROIC"), "stat");
    // `MaxCount` is how many the character may hold: 0 is unlimited, 1 is the plain «Уникальный»,
    // and anything above 1 is the count the original prints in brackets.
    if (template.maxCount === 1) push(globalString("ITEM_UNIQUE"), "gold");
    else if (template.maxCount > 1) push(fillTemplate(globalString("ITEM_UNIQUE_MULTIPLE") ?? "", template.maxCount), "gold");
    else if ((template.flags & ITEM_FLAG_UNIQUE_EQUIPPABLE) !== 0) push(globalString("ITEM_UNIQUE_EQUIPPABLE"), "gold");
    push(bindingText(template.bonding));
  }

  const inventoryType = template?.inventoryType ?? metadata?.inventoryType ?? 0;
  const slotWord = inventoryTypeName(inventoryType);
  // A container says how much it holds instead of what it is worn as. Class 1 is a bag and class
  // 11 a quiver or an ammo pouch, and both carry `ContainerSlots`.
  if (template && (template.itemClass === 1 || template.itemClass === 11) && template.containerSlots > 0) {
    push(fillTemplate(globalString("CONTAINER_SLOTS") ?? "", template.containerSlots, slotWord ?? ""), "muted");
  } else {
    push(slotWord, "muted");
  }

  if (template) {
    // The slot decides, and the damage range and the swing timer only confirm: 55 rows of the dump
    // carry both without being worn in a weapon slot, and 53 of them are ammunition, whose `delay`
    // is a leftover (see `WEAPON_INVENTORY_TYPES`).
    const damage = template.damage[0];
    if (WEAPON_INVENTORY_TYPES.includes(template.inventoryType) && damage && damage.max > 0 && template.delay > 0) {
      const speed = template.delay / 1000;
      const line = fillTemplate(globalString("DAMAGE_TEMPLATE") ?? "", damage.min, damage.max);
      push(`${line}  ${globalString("SPEED") ?? ""} ${speed.toFixed(2)}`.trim());
      push(fillTemplate(globalString("DPS_TEMPLATE") ?? "", (damage.min + damage.max) / 2 / speed), "muted");
    }
    // There is no armour field in 3.3.5: the core writes armour into resistance slot zero on its
    // way out (`ItemTemplate.cpp:250`), which the dataset confirms by calling that slot «к броне».
    const armor = template.resistances[0] ?? 0;
    if (armor > 0) push(fillTemplate(globalString("ARMOR_TEMPLATE") ?? "", armor));
    for (let school = 1; school < template.resistances.length; school++) {
      const value = template.resistances[school] ?? 0;
      // `ITEM_RESIST_SINGLE` is «%c%d к сопротивлению |3-7(%s)» and that `|3-7` is a grammatical
      // case this client has no declension table for, so the school's own name goes in whole, the
      // way the reference writes it (`item_tooltip.cpp:322`).
      if (value > 0) push(`${signed(value)} ${globalString(`RESISTANCE${school}_NAME`) ?? ""}`.trim());
    }

    const primary: string[] = [];
    for (const type of PRIMARY_STATS) {
      const stat = template.stats.find((entry) => entry.type === type && entry.value !== 0);
      if (stat) primary.push(statText(type, stat.value, true));
    }
    if (primary.length > 0) push(primary.join("  "), "stat");
    for (const stat of template.stats) {
      if (stat.value === 0 || PRIMARY_STATS.includes(stat.type)) continue;
      push(statText(stat.type, stat.value, false), "stat");
    }

    // Level 1 is every item's floor and the original prints nothing for it.
    if (template.requiredLevel > 1) {
      const met = context.playerLevel === undefined || context.playerLevel >= template.requiredLevel;
      push(fillTemplate(globalString("ITEM_MIN_LEVEL") ?? "", template.requiredLevel), met ? "muted" : "unmet");
    }
    if (template.maxDurability > 0) {
      push(fillTemplate(globalString("DURABILITY_TEMPLATE") ?? "",
        context.durability ?? template.maxDurability, template.maxDurability), "muted");
    }
    push(itemDurationLine(template.duration, context.durationLeft)); // 5.22 (04.10, L4)
    const recipe = template.itemClass === ITEM_CLASS_RECIPE;
    if (recipe && template.description) push(`${globalString("ITEM_SPELL_TRIGGER_ONUSE") ?? ""} ${template.description}`.trim(), "spell");
    for (const spell of template.spells) {
      // An empty slot is `0, 0, 0, -1, 0, -1` rather than all zeros, which is why this asks the
      // parser's own predicate instead of testing the six numbers.
      if (!hasItemSpell(spell)) continue;
      const trigger = spellTriggerText(spell.trigger);
      if (!trigger) continue;
      // Only a row the caller can name. «Использование: Заклинание 8690» was the placeholder for
      // a row still on its way, drawn as if it were the spell; the row lands, the tooltip is
      // rebuilt, and the line is written then. `itemTooltipFor` names only a row with a
      // description, so a recipe's «Изучение» gets no line here either (see the stock layout).
      const name = context.spellName?.(spell.spellId);
      if (name) push(`${trigger} ${name}`, "spell");
    }
    if (template.requiredSkill !== 0 && template.requiredSkillRank > 0) {
      push(fillTemplate(globalString("ITEM_MIN_SKILL") ?? "",
        context.skillName?.(template.requiredSkill) ?? `навык ${template.requiredSkill}`,
        template.requiredSkillRank), "muted");
    }
    if (template.requiredReputationFaction !== 0 && template.requiredReputationRank > 0) {
      // The faction stays a number. `FactionMetadata.ts:12-14` keys the client's name table by
      // `ReputationIndex`, the slot the wire uses, and an item template names the `Faction.dbc`
      // row instead; joining the two needs a route that does not exist yet.
      push(fillTemplate(globalString("ITEM_REQ_SKILL") ?? "",
        `${reputationRankName(template.requiredReputationRank)}, фракция ${template.requiredReputationFaction}`), "muted");
    }
    const classes = allowedNames(template.allowableClass, PLAYABLE_CLASSES, className);
    if (classes) push(fillTemplate(globalString("ITEM_CLASSES_ALLOWED") ?? "", classes), "muted");
    const races = allowedNames(template.allowableRace, PLAYABLE_RACES, raceName);
    if (races) push(fillTemplate(globalString("ITEM_RACES_ALLOWED") ?? "", races), "muted");

    for (const [index, color] of itemSocketColors(template.sockets, context.enchantments).entries()) {
      if (color === 0) continue;
      const enchantmentId = context.enchantments?.[index + 2] ?? 0;
      if (enchantmentId > 0) {
        const enchantment = context.enchantment?.(enchantmentId);
        const name = enchantment?.gemItemId ? context.gemName?.(enchantment.gemItemId) : undefined;
        push([name ?? `Установленный камень ${index + 1}`, enchantment?.name || "Описание загружается…"].join(" — "), "stat");
        if (enchantment?.conditionId) push("Особый камень: действие зависит от сочетания камней в экипировке", "muted");
        continue;
      }
      const colour = color === 14 ? undefined : SOCKET_COLORS.find(([bit]) => (color & bit) !== 0);
      push(globalString(`EMPTY_SOCKET_${colour?.[1] ?? "NO_COLOR"}`), "muted");
    }
    if (template.socketBonus > 0) {
      const bonus = context.enchantment?.(template.socketBonus);
      const active = context.enchantments?.[5] === template.socketBonus;
      push(`Бонус за гнёзда: ${bonus?.name || "Описание загружается…"}${context.enchantments ? active ? " (активен)" : " (неактивен)" : ""}`,
        active ? "stat" : "muted");
    }
    if (template.gemProperties > 0) {
      const property = context.gemProperty?.(template.gemProperties);
      const enchantment = property && context.enchantment?.(property.enchantmentId);
      if (enchantment?.name) push(enchantment.name, "stat");
      push(property ? property.color === 1 ? "Подходит для особого гнезда" : "Подходит для обычных гнёзд"
        : context.gemMetadataReady ? "Свойств этого камня нет в активной сборке." : "Сведения о камне загружаются…", "muted");
    }
    if (template.startQuest !== 0) push(globalString("ITEM_STARTS_QUEST"), "gold");
    // A recipe's description is its «Использование:» line above, not a quotation.
    if (!recipe && template.description) push(`«${template.description}»`, "flavour");
    if (template.sellPrice > 0) push(`${globalString("SELL_PRICE") ?? ""}: ${formatMoney(template.sellPrice)}`, "muted");
  }

  const stackable = template?.stackable ?? metadata?.stackable ?? 0;
  if (stackable > 1) push(`В стопке до ${stackable}`, "muted");
  const count = context.count ?? 0;
  if (count > 1) push(`Количество: ${count}`, "muted");

  if (!template) {
    // The row has not arrived yet, or the server says there is no such row. Either way the tooltip
    // says which rather than showing a bare number as if it were a name.
    footer.push(facts.template === undefined ? "Описание загружается…" : "Сервер не знает такого предмета");
  }
  footer.push(...(context.footer ?? []));

  return {
    title: template?.name || metadata?.name || unknownLabel("предмет", facts.entry),
    quality: template?.quality ?? metadata?.quality,
    lines,
    footer,
  };
}

/**
 * `ItemModType`s the original prints as white base-stat rows: mana, health, agility, strength,
 * intellect, spirit, stamina. Every other type — the ratings, attack and spell power — is an
 * «Если на персонаже:» line in green, which is where 3.3 moved them when ratings became stats.
 */
const BASE_STAT_TYPES: readonly number[] = [0, 1, 3, 4, 5, 6, 7];

/** `GRAY_FONT_COLOR`, which no tone maps to: an empty socket, an inactive socket bonus. */
const STOCK_GRAY = "#808080";
/** `RED_FONT_COLOR` (1.0, 0.125, 0.125): a subclass the character has no proficiency in (5.22). */
const STOCK_RED = "#ff2020";

/**
 * Two of the dataset's templates the generated table does not carry (it takes a named few beside
 * the `ITEM_*` family), as `Interface\FrameXML\GlobalStrings.lua` writes them.
 */
const STOCK_ITEM_STRINGS: Readonly<Record<string, string>> = {
  SHIELD_BLOCK_TEMPLATE: "Блокирование: %d", // :6242
  ITEM_SOCKET_BONUS: "При соответствии цвета: %s", // :4518
};
const stockItemString = (key: string): string => globalString(key) ?? STOCK_ITEM_STRINGS[key] ?? "";

/** `ITEM_COOLDOWN_TOTAL_*`, largest unit first, and the seconds in each. */
const COOLDOWN_UNITS: ReadonlyArray<readonly [number, string]> = [
  [86_400, "DAYS"], [3_600, "HOURS"], [60, "MIN"], [1, "SEC"],
];

/**
 * «(Восстановление: 2 мин.)», the stock tail of an «Использование:» line: the longer of the item
 * spell's own cooldown and its category's, in the largest unit it is a whole number of (a
 * 90-second cooldown stays «90 сек.» rather than being rounded to a minute).
 *
 * Only the row's own numbers. This core sends them as the template has them
 * (`ItemTemplate.cpp:262-270`), −1 where the row leaves the cooldown to the spell, and those get
 * no tail: the spell's `RecoveryTime` is what the server enforces then, but nothing says the
 * client's tooltip prints it, and a wrong cooldown is worse than none.
 *
 * Food and drink carry a one-second category cooldown (`spellcategorycooldown_1 = 1000`,
 * category 11) that only stops a double click; the original never writes «(Восстановление:
 * 1 сек.)» under a meal, so a tail shorter than {@link MIN_COOLDOWN_TAIL_SECONDS} is not a
 * cooldown the player is told about.
 */
const MIN_COOLDOWN_TAIL_SECONDS = 5;

function useCooldownText(spell: ItemSpell): string | undefined {
  const seconds = Math.round(Math.max(spell.cooldown, spell.categoryCooldown) / 1000);
  if (!(seconds >= MIN_COOLDOWN_TAIL_SECONDS)) return undefined;
  const [unit, key] = COOLDOWN_UNITS.find(([size]) => seconds % size === 0) ?? [1, "SEC"];
  const template = globalString(`ITEM_COOLDOWN_TOTAL_${key}`);
  return template === undefined ? undefined : fillTemplate(template, seconds / unit);
}

/**
 * The item as the stock 3.3.5 `GameTooltip` draws it, for the FrameXML HUD.
 *
 * The native {@link itemTooltipContent} is one fact per line in the reference client's order, and
 * stays as it is for the native panels. The original pairs some of them and colours others, and
 * this is that shape: the slot on the left with the armour or weapon type on the right; the damage
 * range with the swing speed; every base stat on its own white row in the item's own order; the
 * ratings and the item's spells as green «Если на персонаже:» / «Использование:» prose, the spell
 * by its description rather than its name; empty sockets and an unmatched socket bonus in grey;
 * the item level under the requirements (3.3 prints it there, not under the name); and the sell
 * price as a money row the stock `SetTooltipMoney` can draw as coins. What only the native panels
 * print — the stack size, the count in hand, the worn comparison — is not here.
 */
export function stockItemTooltipContent(facts: ItemFacts, context: ItemTooltipContext = {}): TooltipContent {
  const template = facts.template?.found === true ? facts.template : undefined;
  const metadata = facts.metadata;
  const lines: TooltipLine[] = [];
  const footer: string[] = [];
  const push = (text: string | undefined, style: Omit<TooltipLine, "text"> = {}): void => {
    if (text) lines.push({ text, ...style });
  };
  const green = { tone: "spell", wrap: true } as const;

  if (template) {
    if ((template.flags & ITEM_FLAG_HEROIC_TOOLTIP) !== 0) push(globalString("ITEM_HEROIC"), { tone: "spell" });
    push(bindingText(template.bonding));
    if (template.maxCount === 1) push(globalString("ITEM_UNIQUE"));
    else if (template.maxCount > 1) push(fillTemplate(globalString("ITEM_UNIQUE_MULTIPLE") ?? "", template.maxCount));
    else if ((template.flags & ITEM_FLAG_UNIQUE_EQUIPPABLE) !== 0) push(globalString("ITEM_UNIQUE_EQUIPPABLE"));
    if (template.startQuest !== 0) push(globalString("ITEM_STARTS_QUEST"));
  }

  const inventoryType = template?.inventoryType ?? metadata?.inventoryType ?? 0;
  const slotWord = inventoryTypeName(inventoryType);
  if (template && (template.itemClass === 1 || template.itemClass === 11) && template.containerSlots > 0) {
    push(fillTemplate(globalString("CONTAINER_SLOTS") ?? "", template.containerSlots, slotWord ?? ""));
  } else if (slotWord) {
    const kind = template ? context.subclassName?.(template.itemClass, template.subClass) : undefined;
    const proficient = !template || (context.proficient?.(template.itemClass, template.subClass) ?? true);
    lines.push(kind ? { text: slotWord, right: kind, ...(proficient ? {} : { rightColor: STOCK_RED }) } : { text: slotWord });
  }

  if (template) {
    const damage = template.damage[0];
    if (WEAPON_INVENTORY_TYPES.includes(template.inventoryType) && damage && damage.max > 0 && template.delay > 0) {
      const speed = template.delay / 1000;
      lines.push({
        text: fillTemplate(globalString("DAMAGE_TEMPLATE") ?? "", damage.min, damage.max),
        right: `${globalString("SPEED") ?? ""} ${speed.toFixed(2)}`.trim(),
      });
      push(fillTemplate(globalString("DPS_TEMPLATE") ?? "", (damage.min + damage.max) / 2 / speed));
    }
    const armor = template.resistances[0] ?? 0;
    if (armor > 0) push(fillTemplate(globalString("ARMOR_TEMPLATE") ?? "", armor));
    if (template.block > 0) push(fillTemplate(stockItemString("SHIELD_BLOCK_TEMPLATE"), template.block));
    for (const stat of template.stats) {
      if (stat.value !== 0 && BASE_STAT_TYPES.includes(stat.type)) push(statText(stat.type, stat.value, false));
    }
    for (let school = 1; school < template.resistances.length; school++) {
      const value = template.resistances[school] ?? 0;
      if (value > 0) push(`${signed(value)} ${globalString(`RESISTANCE${school}_NAME`) ?? ""}`.trim());
    }
    // The permanent and the temporary enchantment, green under the stats; slots 0 and 1 of the
    // instance, never the template.
    for (const slot of [0, 1]) {
      const id = context.enchantments?.[slot] ?? 0;
      if (id > 0) push(context.enchantment?.(id)?.name, { tone: "spell" });
    }

    for (const [index, color] of itemSocketColors(template.sockets, context.enchantments).entries()) {
      if (color === 0) continue;
      const enchantmentId = context.enchantments?.[index + 2] ?? 0;
      if (enchantmentId > 0) {
        const enchantment = context.enchantment?.(enchantmentId);
        const gem = enchantment?.gemItemId ? context.gemName?.(enchantment.gemItemId) : undefined;
        push(enchantment?.name || gem || `Установленный камень ${index + 1}`);
        continue;
      }
      const colour = color === 14 ? undefined : SOCKET_COLORS.find(([bit]) => (color & bit) !== 0);
      push(globalString(`EMPTY_SOCKET_${colour?.[1] ?? "NO_COLOR"}`), { color: STOCK_GRAY });
    }
    if (template.socketBonus > 0) {
      const bonus = context.enchantment?.(template.socketBonus)?.name;
      const active = context.enchantments?.[5] === template.socketBonus;
      if (bonus) push(fillTemplate(stockItemString("ITEM_SOCKET_BONUS"), bonus), active ? { tone: "spell" } : { color: STOCK_GRAY });
    }
    if (template.gemProperties > 0) {
      const property = context.gemProperty?.(template.gemProperties);
      const enchantment = property && context.enchantment?.(property.enchantmentId);
      push(enchantment ? enchantment.name : undefined);
    }

    if (template.maxDurability > 0) {
      const current = context.durability ?? template.maxDurability;
      push(fillTemplate(globalString("DURABILITY_TEMPLATE") ?? "", current, template.maxDurability),
        current <= 0 ? { tone: "unmet" } : {});
    }
    // 5.22 (04.10, L4): white, right after durability (Wow.exe 0x006277f0; ItemDurationText.ts).
    push(itemDurationLine(template.duration, context.durationLeft));
    const classes = allowedNames(template.allowableClass, PLAYABLE_CLASSES, className);
    if (classes) push(fillTemplate(globalString("ITEM_CLASSES_ALLOWED") ?? "", classes));
    const races = allowedNames(template.allowableRace, PLAYABLE_RACES, raceName);
    if (races) push(fillTemplate(globalString("ITEM_RACES_ALLOWED") ?? "", races));
    if (template.requiredLevel > 1) {
      const met = context.playerLevel === undefined || context.playerLevel >= template.requiredLevel;
      push(fillTemplate(globalString("ITEM_MIN_LEVEL") ?? "", template.requiredLevel), met ? {} : { tone: "unmet" });
    }
    if (template.requiredSkill !== 0 && template.requiredSkillRank > 0) {
      push(fillTemplate(globalString("ITEM_MIN_SKILL") ?? "",
        context.skillName?.(template.requiredSkill) ?? `навык ${template.requiredSkill}`, template.requiredSkillRank));
    }
    if (template.requiredReputationFaction !== 0 && template.requiredReputationRank > 0) {
      push(fillTemplate(globalString("ITEM_REQ_SKILL") ?? "",
        `${reputationRankName(template.requiredReputationRank)}, фракция ${template.requiredReputationFaction}`));
    }
    if (template.itemLevel > 0 && slotWord) push(fillTemplate(globalString("ITEM_LEVEL") ?? "", template.itemLevel));

    const onEquip = globalString("ITEM_SPELL_TRIGGER_ONEQUIP");
    for (const stat of template.stats) {
      if (stat.value === 0 || BASE_STAT_TYPES.includes(stat.type)) continue;
      push(`${onEquip ? `${onEquip} ` : ""}${statText(stat.type, stat.value, false)}`, green);
    }
    const recipe = template.itemClass === ITEM_CLASS_RECIPE;
    // A recipe's description is what it teaches, and the original prints it as the green
    // «Использование:» line where any other item's description is the quoted gold line at the
    // bottom (`ITEM_CLASS_RECIPE`).
    if (recipe && template.description) push(`${globalString("ITEM_SPELL_TRIGGER_ONUSE") ?? ""} ${template.description}`.trim(), green);
    for (const spell of template.spells) {
      if (!hasItemSpell(spell)) continue;
      const trigger = spellTriggerText(spell.trigger);
      if (!trigger) continue;
      // The original reads the spell's description here, not its name — «Использование:
      // Восстанавливает 2148 ед. здоровья», not «Использование: Большое лечебное зелье» — and
      // writes nothing for a spell with no description. The name fallback the reference takes
      // (`wowee/src/ui/item_tooltip.cpp:374-377`) put «Использование: Изучение» on every recipe,
      // and the «Использование: Заклинание 483» in the report was the placeholder for that row
      // while it was still on its way. A row not yet cached is the same nothing: the tooltip is
      // rebuilt when it lands, and the line is written then.
      const text = context.spellDescription?.(spell.spellId);
      if (!text) continue;
      // An «Использование:» line ends on its cooldown; «Если на персонаже:» and a proc have none.
      const cooldown = spell.trigger === 1 || spell.trigger === 2 ? undefined : useCooldownText(spell);
      push(`${trigger} ${text}${cooldown ? ` ${cooldown}` : ""}`, green);
    }
    if (!context.nested) {
      // What the recipe teaches, as far as the learn spell's row says: its product's own rows
      // under a blank row and its name, then the reagents. An enchanting formula makes nothing
      // and keeps the reagents line; a row not yet cached draws nothing yet.
      const teaching = recipeTeaching(template, context.spellRow);
      const crafted = teaching?.crafted === undefined ? undefined : context.item?.(teaching.crafted);
      if (crafted?.template?.found === true) {
        // `AddLine(" ")`: the stock writer keeps a row of one space where it drops an empty one.
        lines.push({ text: " " });
        const product = stockItemTooltipContent(crafted, productContext(context));
        lines.push({ text: product.title, color: STOCK_QUALITY_COLORS[product.quality ?? 1] ?? "#ffffff" });
        for (const line of product.lines ?? []) lines.push(typeof line === "string" ? { text: line } : line);
      }
      const reagents = teaching === undefined ? undefined : reagentsText(teaching.reagents, context.item);
      if (reagents) push(fillTemplate(globalString("ITEM_REQ_SKILL") ?? "", reagents));
      if (!recipe && template.description) push(`«${template.description}»`, { tone: "flavour", wrap: true });
      if (template.sellPrice > 0) {
        const label = `${globalString("SELL_PRICE") ?? ""}:`;
        lines.push({ text: `${label} ${formatMoney(template.sellPrice)}`, money: { copper: template.sellPrice, label } });
      }
    }
  }

  if (!template) footer.push(facts.template === undefined ? "Описание загружается…" : "Сервер не знает такого предмета");
  footer.push(...(context.footer ?? []));
  return {
    title: template?.name || metadata?.name || unknownLabel("предмет", facts.entry),
    quality: template?.quality ?? metadata?.quality,
    lines,
    footer,
  };
}

/** What a recipe's learn spell says it makes and takes, as far as its cached row goes. */
interface RecipeTeaching {
  /** The product, when the spell has a CREATE_ITEM effect; an enchanting formula has none. */
  readonly crafted: number | undefined;
  readonly reagents: ReadonlyArray<{ readonly itemId: number; readonly count: number }>;
}

/**
 * The learn spell (trigger 6) of a recipe and what its row says: the product is the
 * `EffectItemType` of its `SPELL_EFFECT_CREATE_ITEM` effect — 7753, taught by 6328, makes 4592
 * «Острозубый илистый луциан» from one 6289 — and the reagents are the row's own. Nothing without
 * the row, which `itemTooltipFor` asks for; nothing for an item that teaches nothing.
 */
function recipeTeaching(template: ItemTemplate, spellRow: ItemTooltipContext["spellRow"]): RecipeTeaching | undefined {
  const learn = template.spells.find((spell) => hasItemSpell(spell) && spell.trigger === ITEM_SPELLTRIGGER_LEARN_SPELL);
  const row = learn === undefined ? undefined : spellRow?.(learn.spellId);
  if (!row) return undefined;
  const effect = (row.effects ?? []).indexOf(SPELL_EFFECT_CREATE_ITEM);
  const crafted = effect < 0 ? 0 : row.effectItemType?.[effect] ?? 0;
  return {
    crafted: crafted > 0 ? crafted : undefined,
    reagents: (row.reagents ?? []).filter((reagent) => reagent.itemId > 0 && reagent.count > 0),
  };
}

/**
 * «Сырой острозубый илистый луциан», «Медный слиток (5), Грубый камень (2)»: each reagent by name,
 * its count in brackets past one, the way the original writes a recipe's «Требуется:» line.
 * Nothing until every name is known — `itemTooltipFor` asks for the rows, and the line is written
 * on the redraw they wake — and «Предмет N» only for a row the server says it has not got.
 */
function reagentsText(reagents: RecipeTeaching["reagents"], item: ItemTooltipContext["item"]): string | undefined {
  const names: string[] = [];
  for (const reagent of reagents) {
    const facts = item?.(reagent.itemId);
    const name = (facts?.template?.found === true ? facts.template.name : "") || facts?.metadata?.name;
    if (!name && facts?.template?.found !== false) return undefined;
    const label = name || unknownLabel("предмет", reagent.itemId);
    names.push(reagent.count > 1 ? `${label} (${reagent.count})` : label);
  }
  return names.length > 0 ? names.join(", ") : undefined;
}

/**
 * A recipe's product as the recipe's context reaches it: the character's level for its own
 * «Требуется уровень», the tables and the words it shares with any hover — never the recipe
 * instance's enchantments, wear or count — and `nested`, so it draws no price, no flavour text
 * and no block of its own.
 */
function productContext(context: ItemTooltipContext): ItemTooltipContext {
  return {
    layout: "stock", nested: true, compare: false,
    playerLevel: context.playerLevel, skillName: context.skillName, subclassName: context.subclassName,
    proficient: context.proficient,
    spellDescription: context.spellDescription, spellName: context.spellName,
    enchantment: context.enchantment, gemProperty: context.gemProperty,
    gemMetadataReady: context.gemMetadataReady, gemName: context.gemName,
  };
}

/**
 * Stock tooltips waiting for a late answer, one redraw each.
 *
 * The native box has `refreshTooltip`; a stock `GameTooltip` is refreshed by its owner's
 * `UpdateTooltip` five times a second when it has one (`GameTooltip.lua:185-197`), and this is for
 * the setters whose owner has none — a chat link in `ItemRefTooltip`, an add-on's `SetHyperlink`.
 * One per item: an owner that does refresh registers again on every paint while it waits, and the
 * latest paint is the one worth redrawing. Bounded as well, and each redraw checks for itself that
 * its tooltip still shows what it drew.
 *
 * Everything here belongs to one world and the HUD drawn in it. A redraw closes over that HUD's
 * Lua state, and the subscription over the world's event bus — and through its other listeners,
 * the world — so both are dropped the moment `game.world` is another one (a logout, a new
 * character), and {@link resetStockTooltipRedraws} drops them when a new FrameXML HUD is built.
 */
const lateRedraws = new Map<number, () => void>();
const LATE_REDRAW_LIMIT = 16;
/** The world whose `QUERY_CACHE_CHANGED` item answers wake the redraws, and its unsubscribe. */
let lateWorld: { world: WorldClient; off: () => void } | undefined;

/** Forgets every waiting stock redraw and lets go of the world that would have woken them. */
export function resetStockTooltipRedraws(): void {
  lateRedraws.clear();
  lateWorld?.off();
  lateWorld = undefined;
}

/** Drops what a world that is no longer the current one left behind. */
function forgetStaleWorld(): void {
  if (lateWorld !== undefined && lateWorld.world !== game.world) resetStockTooltipRedraws();
}

/**
 * Runs each waiting redraw once, each on its own: one that throws is reported and neither stops
 * the rest nor the listeners called after this one (`ensureSpellNames` calls its listeners in a
 * row, and a throw there skipped the native box's `refreshTooltip`).
 */
function runLateRedraws(): void {
  forgetStaleWorld();
  if (lateRedraws.size === 0) return;
  const due = [...lateRedraws.values()];
  lateRedraws.clear();
  for (const redraw of due) {
    try {
      redraw();
    } catch (error) {
      console.warn("Tooltip redraw failed", error);
    }
  }
}

/** A late answer for an item tooltip: the native box is rebuilt, and so is every stock one waiting. */
function lateData(): void {
  refreshTooltip();
  runLateRedraws();
}

/** The {@link TooltipRefresh} of an item tooltip that is still waiting for something. */
function lateRefresh(entry: number, rebuild: () => TooltipContent): TooltipRefresh {
  return {
    watch(redraw) {
      forgetStaleWorld();
      const world = game.world;
      if (world && lateWorld === undefined && typeof world.events?.on === "function") {
        // An item row is the one late answer with no callback of its own to hand: the query is
        // sent by `WorldClient.itemTemplate` and answered on the wire.
        lateWorld = { world, off: world.events.on("QUERY_CACHE_CHANGED", (change) => {
          if (change.kind === "item") runLateRedraws();
        }) };
      }
      const run = (): void => { redraw(rebuild()); };
      lateRedraws.delete(entry);
      lateRedraws.set(entry, run);
      if (lateRedraws.size > LATE_REDRAW_LIMIT) lateRedraws.delete(lateRedraws.keys().next().value!);
      return () => { if (lateRedraws.get(entry) === run) lateRedraws.delete(entry); };
    },
  };
}

/** An item spell's own words, the way the stock «Использование:» line reads them. */
function itemSpellDescription(spellId: number): string | undefined {
  const metadata = game.spells.get(spellId);
  if (!metadata?.description) return undefined;
  // An empty `values` is the formatter's «live tooltip» mode: an attack-power operand this module
  // cannot read becomes readable words, never a raw `$AP` marker (`Spellbook.spellDescriptionContext`).
  return formatSpellDescription(metadata.description, metadata, { spells: game.spells, values: {} }) || undefined;
}

/**
 * The same tooltip, from whatever this session happens to know about the entry.
 *
 * All nine windows hold an entry and nothing else, so this is what they call. The template comes
 * from `WorldClient.itemTemplate`, which answers from its own cache and sends
 * `CMSG_ITEM_QUERY_SINGLE` on a miss — once per entry for the life of the session, because the
 * asked-set is remembered — so hovering an item is also what fetches it. The lookups the pure
 * builder cannot do — a spell's row, another item's, the tables — are wired here and nowhere else.
 */
export function itemTooltipFor(entry: number, context: ItemTooltipContext = {}): TooltipContent {
  // Every item tooltip, native ones included, lets go of a world the stock redraws were left in.
  forgetStaleWorld();
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  const template = world?.itemTemplate(entry);
  // An item's spell is a row nothing else in the client has any reason to want. `game.spells` is
  // filled in three places — the spellbook, for what the character knows (`Spellbook.ts:523`);
  // the aura strip, for what is on a unit (`Auras.ts:69`); and `ensureSpellNames`, for casts, the
  // command bar and the talent trees (`SpellNames.ts:66`) — and an item's is in none of them, so
  // reading `game.spells` alone printed «Использование: Заклинание 8690» on the Hearthstone and
  // left it there. 15,811 of the dump's 38,607 rows have at least one such line, over 7,587
  // distinct spells. Ordered here, where the ids are: the answer lands after the tooltip is
  // already up, which is what `refreshTooltip` is for.
  const itemSpells = namedItemSpells(template);
  ensureSpellNames(itemSpells, lateData);
  const enchants = game.gatewayOrigin ? itemEnchantments(game.gatewayOrigin) : undefined;
  const needsEnchants = template && (template.gemProperties > 0 || template.socketBonus > 0
    || template.sockets.some((socket) => socket.color > 0)) || context.enchantments?.some((id) => id > 0);
  if (needsEnchants && enchants && !enchants.ready) {
    void enchants.load().then(lateData).catch(() => undefined);
  }
  const gemEntries = (context.enchantments ?? []).slice(2, 5)
    .map((id) => enchants?.enchantments.get(id)?.gemItemId ?? 0).filter((id) => id > 0);
  if (gemEntries.length) void game.itemMetadata?.load(gemEntries).then((changed) => { if (changed) lateData(); }).catch(() => undefined);
  const gemName = (id: number): string | undefined => world?.itemTemplate(id)?.name || game.itemMetadata?.get(id)?.name;
  // A recipe's block names two more kinds of row: its product's, which *is* the block, and its
  // reagents', which are the «Требуется:» line. The ids are in the learn spell's row, so they are
  // asked for on the redraw that row wakes — `world.itemTemplate` sends the query on a miss, once
  // per entry, and the gateway's name may land first — and the tooltip waits once more for them.
  const teaching = template === undefined ? undefined : recipeTeaching(template, (id) => game.spells.get(id));
  const itemFacts = (id: number): ItemFacts => ({ entry: id, metadata: game.itemMetadata?.get(id), template: world?.itemTemplate(id) });
  const product = teaching?.crafted === undefined ? undefined : itemFacts(teaching.crafted);
  const lateItems = (teaching?.reagents ?? []).map((reagent) => reagent.itemId).filter((id) => {
    const facts = itemFacts(id);
    return facts.template === undefined && !facts.metadata?.name;
  });
  // The product's rows are the block, so its name alone is not enough.
  if (product !== undefined && product.template === undefined) lateItems.unshift(product.entry);
  if (lateItems.length) void game.itemMetadata?.load(lateItems).then((changed) => { if (changed) lateData(); }).catch(() => undefined);
  // The product's own spells are its block's «Использование:» lines and, like the recipe's,
  // nothing else in the client asks for them. Known one answer later than the product itself,
  // which is one redraw more: the block first without that line, then with it.
  const productSpells = namedItemSpells(product?.template);
  ensureSpellNames(productSpells, lateData);
  const content = itemTooltipContent(
    { entry, metadata: game.itemMetadata?.get(entry), template },
    {
      playerLevel: self?.fields.get(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset),
      // `spellName` and not `game.spells.get(id)?.name`, so a ranked spell reads «Взрыв разума
      // (Ранг 2)» here as it does over a cast bar — and only for a row that is cached and has
      // something to say: the native line is the spell's name, but whether there is a line is the
      // description's call, as it is in the stock layout, so a recipe's «Изучение» gets none and
      // a row still on its way gets no «Заклинание N» in its place.
      spellName: (id) => game.spells.get(id)?.description ? spellName(id) : undefined,
      spellDescription: itemSpellDescription,
      spellRow: (id) => game.spells.get(id),
      item: itemFacts,
      skillName: (skillId) => game.talentData?.skillLine(skillId)?.name,
      enchantment: (id) => enchants?.enchantments.get(id),
      gemProperty: (id) => enchants?.gems.get(id),
      gemMetadataReady: enchants?.ready,
      gemName,
      ...context,
    });
  // What is worn where this would go: names, not stat math — a real upgrade verdict needs Sim
  // data no client has, but "better than an empty slot / what it replaces" answers most hovers.
  if (world && !context.equipped && context.compare !== false) {
    const worn = wornComparisonLines(world, template, entry).map((text) => ({ text, tone: "muted" as const }));
    if (worn.length > 0) content.lines = [...(content.lines ?? []), ...worn];
  }
  // Built before something it names had arrived: the row itself, a spell's words, the enchantment
  // table, a gem, or what a recipe makes and takes. A stock tooltip whose owner does not refresh
  // it asks to be drawn again.
  const waiting = world !== undefined && (template === undefined
    || itemSpells.some((id) => !game.spells.has(id))
    || Boolean(needsEnchants) && enchants !== undefined && !enchants.ready
    || gemEntries.some((id) => !gemName(id))
    || lateItems.length > 0
    || productSpells.some((id) => !game.spells.has(id)));
  if (waiting) content.refresh = lateRefresh(entry, () => itemTooltipFor(entry, context));
  return content;
}

/**
 * Equipment indexes one `InventoryType` can go to, in `PLAYER_FIELD_INV_SLOT_*` order 0..18.
 *
 * Two-slot kinds name both (finger, trinket, weapon); weapons follow the hand rules — a
 * two-hander or main-hander never compares against the off hand. Kinds with nowhere to go
 * (non-equip, bag, ammo, quiver) answer none and the tooltip stays as it was.
 */
function comparisonSlots(inventoryType: number): number[] {
  switch (inventoryType) {
    case 1: return [0];
    case 2: return [1];
    case 3: return [2];
    case 4: return [3];
    case 5:
    case 20: return [4];
    case 6: return [5];
    case 7: return [6];
    case 8: return [7];
    case 9: return [8];
    case 10: return [9];
    case 11: return [10, 11];
    case 12: return [12, 13];
    case 16: return [14];
    case 13: return [15, 16];
    case 17:
    case 21: return [15];
    case 14:
    case 22:
    case 23: return [16];
    case 15:
    case 25:
    case 26:
    case 28: return [17];
    case 19: return [18];
    default: return [];
  }
}

function wornComparisonLines(
  world: WorldClient, template: ItemTemplate | undefined, entry: number,
): string[] {
  const slots = template ? comparisonSlots(template.inventoryType) : [];
  if (slots.length === 0) return [];
  const inventory = playerInventory(world.state);
  if (!inventory) return [];
  return slots.map((index) => {
    const worn = inventory.equipment[index];
    const wornEntry = worn?.item === undefined ? 0 : worldObject.entry(worn.item) ?? 0;
    if (wornEntry <= 0 || wornEntry === entry) {
      return slots.length > 1
        ? `Сейчас надето (${slotShortName(index)}): —`
        : "Сейчас надето: —";
    }
    const wornTemplate = world.itemTemplate(wornEntry);
    const name = wornTemplate?.name || game.itemMetadata?.get(wornEntry)?.name || `предмет ${wornEntry}`;
    const level = wornTemplate && wornTemplate.itemLevel > 0 ? `, ур. предмета ${wornTemplate.itemLevel}` : "";
    return slots.length > 1
      ? `Сейчас надето (${slotShortName(index)}): ${name}${level}`
      : `Сейчас надето: ${name}${level}`;
  });
}

/** Short equipment slot names for the two-slot kinds; the doll itself already names the rest. */
function slotShortName(index: number): string {
  if (index === 10 || index === 11) return index === 10 ? "палец 1" : "палец 2";
  if (index === 12 || index === 13) return index === 12 ? "аксессуар 1" : "аксессуар 2";
  if (index === 15) return "правая рука";
  return "левая рука";
}

/**
 * The spells this tooltip will actually read, which is what is worth a request.
 *
 * A slot with a trigger the tooltip has no opening word for gives no line (`spellTriggerText`),
 * and asking for its row would retire the id into the session's asked-set for nothing. A recipe's
 * learn spell (trigger 6) has no line of its own either, but its row is what the recipe's block
 * is made of, and the opening word keeps it on the list.
 */
function namedItemSpells(template: ItemTemplate | undefined): number[] {
  return (template?.spells ?? [])
    .filter((spell) => hasItemSpell(spell) && spellTriggerText(spell.trigger) !== undefined)
    .map((spell) => spell.spellId);
}

/**
 * The classes or races an item is restricted to, or nothing when it is restricted to none.
 *
 * Zero and a mask with every bit set both mean «anyone»: the core writes −1 for an unrestricted
 * item and the field is unsigned on the wire, so it arrives as `0xFFFFFFFF`. Bit *n* is class or
 * race *n + 1*, both being one-based.
 *
 * A mask that covers every class or race there is means the same thing however it is spelled, and
 * the reference prints nothing for it either — it counts the real ones and leaves at ten
 * (`item_tooltip.cpp:67`) or tests the covering mask outright (`:81`). Measured over the dump: 335
 * rows write `AllowableClass = 1535` rather than −1 and had been listing all ten classes.
 */
function allowedNames(mask: number, ids: readonly number[], nameOf: (id: number) => string): string | undefined {
  if (mask === 0 || mask === ALLOW_ANY) return undefined;
  const allowed = ids.filter((id) => (mask & (1 << (id - 1))) !== 0);
  if (allowed.length === 0 || allowed.length === ids.length) return undefined;
  return allowed.map(nameOf).join(", ");
}
