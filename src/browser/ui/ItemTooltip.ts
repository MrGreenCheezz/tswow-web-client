import { ITEM_MOD_NAMES, globalString } from "../../generated/globalStrings.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { ItemMetadata } from "../ItemMetadata.js";
import { hasItemSpell, type ItemTemplate } from "../../world/QueryCacheProtocol.js";
import { game } from "../game/Context.js";
import { formatMoney, reputationRankName, unknownLabel } from "./Format.js";
import { ensureSpellNames, spellName } from "./SpellNames.js";
import { className, raceName } from "./UnitSnapshot.js";
import { refreshTooltip, type TooltipContent, type TooltipLine, type TooltipTone } from "./Widgets.js";

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
 * no delay and 6 teaches a recipe — and the original writes a recipe as «Использование: Обучает
 * вас…», with the teaching in the spell's own description. The reference client keeps the same
 * four together and explains why (`wowee/include/game/item_text.hpp:32-41`); a trigger with
 * nothing to say gives no line at all.
 */
function spellTriggerText(trigger: number): string | undefined {
  if (trigger === 1) return globalString("ITEM_SPELL_TRIGGER_ONEQUIP");
  if (trigger === 2) return globalString("ITEM_SPELL_TRIGGER_ONPROC");
  if (trigger === 0 || trigger === 4 || trigger === 5 || trigger === 6) {
    return globalString("ITEM_SPELL_TRIGGER_ONUSE");
  }
  return undefined;
}

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
  /** How many are in hand: a stack, a loot bundle, a vendor's `buyCount`, a mail attachment. */
  count?: number | undefined;
  /** The character's level, which is what decides whether «Требуется уровень» is red. */
  playerLevel?: number | undefined;
  /** `ITEM_FIELD_DURABILITY`, which only an item the player actually owns has. */
  durability?: number | undefined;
  /** `SkillLine.Name` for the skill an item demands, when the caller has the table. */
  skillName?: ((skillId: number) => string | undefined) | undefined;
  /** A spell's name, for the «Использование:» lines. */
  spellName?: ((spellId: number) => string | undefined) | undefined;
  /** What a click will do here, which differs in every one of the nine windows. */
  footer?: readonly string[] | undefined;
}

export function itemTooltipContent(facts: ItemFacts, context: ItemTooltipContext = {}): TooltipContent {
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
    for (const spell of template.spells) {
      // An empty slot is `0, 0, 0, -1, 0, -1` rather than all zeros, which is why this asks the
      // parser's own predicate instead of testing the six numbers.
      if (!hasItemSpell(spell)) continue;
      const trigger = spellTriggerText(spell.trigger);
      if (!trigger) continue;
      const name = context.spellName?.(spell.spellId);
      push(`${trigger} ${name ?? unknownLabel("заклинание", spell.spellId)}`, "spell");
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

    for (const socket of template.sockets) {
      if (socket.color === 0) continue;
      const colour = SOCKET_COLORS.find(([bit]) => (socket.color & bit) !== 0);
      push(globalString(`EMPTY_SOCKET_${colour?.[1] ?? "NO_COLOR"}`), "muted");
    }
    if (template.startQuest !== 0) push(globalString("ITEM_STARTS_QUEST"), "gold");
    if (template.description) push(`«${template.description}»`, "flavour");
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
 * The same tooltip, from whatever this session happens to know about the entry.
 *
 * All nine windows hold an entry and nothing else, so this is what they call. The template comes
 * from `WorldClient.itemTemplate`, which answers from its own cache and sends
 * `CMSG_ITEM_QUERY_SINGLE` on a miss — once per entry for the life of the session, because the
 * asked-set is remembered — so hovering an item is also what fetches it. The three lookups the
 * pure builder cannot do are wired here and nowhere else.
 */
export function itemTooltipFor(entry: number, context: ItemTooltipContext = {}): TooltipContent {
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
  ensureSpellNames(namedItemSpells(template), refreshTooltip);
  return itemTooltipContent(
    { entry, metadata: game.itemMetadata?.get(entry), template },
    {
      playerLevel: self?.fields.get(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset),
      // `spellName` and not `game.spells.get(id)?.name`, so a ranked spell reads «Взрыв разума
      // (Ранг 2)» here as it does over a cast bar. Its miss is the same «Заклинание N» this
      // builder falls back to anyway.
      spellName,
      skillName: (skillId) => game.talentData?.skillLine(skillId)?.name,
      ...context,
    });
}

/**
 * The spells this tooltip will actually name, which is what is worth a request.
 *
 * A slot with a trigger the tooltip has no opening word for gives no line (`spellTriggerText`),
 * and asking for its row would retire the id into the session's asked-set for nothing.
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
