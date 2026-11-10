/**
 * What a spell's tooltip says: the native box's facts, and the stock `GameTooltip`'s pairs for the
 * FrameXML HUD. Rows out of `game.spells` and the session, no page: the stock interface reads this
 * whatever the spell book window does.
 */

import { POWER, POWER_DISPLAY_SCALE, readField } from "../../world/Fields.js";
import { globalString } from "../../generated/globalStrings.js";
import { game } from "../game/Context.js";
import { GROUND_TARGET_MODE } from "../game/GroundTarget.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { unknownLabel } from "./Format.js";
import { fillTemplate } from "./ItemTooltip.js";
import { formatSpellDescription, type SpellDescriptionContext } from "./SpellText.js";
import { sessionSpellDescriptionContext } from "./SpellTextLiveContext.js"; // 12.10
import type { TooltipContent, TooltipLine } from "./TooltipTypes.js";

/**
 * What a description reads from this session. 12.10: the active player itself — Wow.exe's writer
 * reads its update fields, spellbook and auras (SpellTextLiveContext.ts) for `$AP`, `$SPH`, `$?s…`
 * and `$g` — the rows fetched so far with whether the gateway has answered for one still missing,
 * and the hearthstone's area for `$z`.
 */
export function spellDescriptionContext(): SpellDescriptionContext {
  return sessionSpellDescriptionContext();
}

/** `SchoolMask`, one bit per school, in the order `SPELL_SCHOOL_*` runs. */
const SCHOOL_NAMES = ["физический", "свет", "огонь", "природа", "лед", "тьма", "тайная магия"];

/**
 * Seconds with one decimal only when there is one, so 1500 ms reads «1,5» and 3000 reads «3».
 *
 * The comma is not decoration: every string on this screen is Russian and a decimal point in the
 * middle of one reads as a full stop. `toFixed` has no locale.
 */
const seconds = (milliseconds: number): string =>
  (milliseconds / 1000).toFixed(milliseconds % 1000 ? 1 : 0).replace(".", ",");

/** `SpellRange.Flags` 1: the row is the melee reach rather than a distance. Only row 2 carries it. */
const SPELL_RANGE_FLAG_MELEE = 1;

/**
 * The yards `SpellRange` writes for «anywhere», which are not yards.
 *
 * Two of the 65 rows carry it — 13 «Anywhere» and 173 «Anywhere (Combat Min Range)» — and no other
 * row in the table reaches four digits except 174's «U L T R A» thousand. 59 of the 7,369 spells
 * that reach the book resolve to row 13, 30 of them through a `SkillLineAbility` row with a
 * `ClassMask`, so they are in somebody's book: «Око Килрогга» (126), «Звериный глаз» (1002),
 * «Орлиный глаз» (6197), «Дальнее зрение» (6196), «Хватка смерти» (49575), the three ranks of the
 * mage's «Окоченение» (12484-12486). None of the 59 is marked passive, so all of them printed the
 * sentinel with «Мгновенное» under it.
 */
const UNLIMITED_RANGE = 50000;

/**
 * «Радиус действия: N м», or the two cases where the client writes words instead of a number.
 *
 * The strings are the ruRU client's own, out of `Interface\FrameXML\GlobalStrings.lua`:
 * `MELEE_RANGE` (:4919), `SPELL_RANGE` (:7234) and `SPELL_RANGE_UNLIMITED` (:7237). Neither
 * special case is rare — 544 book spells resolve to row 2 («Удар героя» 78, «Удар щитом» 72,
 * «Удар в спину» 53) and 59 to row 13 — and printing the number gave «Дальность: 5 м» for a melee
 * swing and «Дальность: 50000 м» for a spell that has no range at all.
 *
 * `SPELL_RANGE_DUAL` (:7236, «Радиус действия (%1$s): %2$s м») is what the client prints for the
 * 28 book rows with a minimum — «Рывок» is 8-25 — but nothing on this machine says what its first
 * argument holds, so the pair keeps the single string's shape rather than a guessed one.
 */
function rangeLine(metadata: SpellMetadata): string | undefined {
  if ((metadata.rangeFlags & SPELL_RANGE_FLAG_MELEE) !== 0) return "Дистанция ближнего боя";
  if (metadata.rangeMax >= UNLIMITED_RANGE) return "Неограниченное расстояние";
  if (metadata.rangeMax <= 0) return undefined;
  return metadata.rangeMin > 0
    ? `Радиус действия: ${metadata.rangeMin}-${metadata.rangeMax} м`
    : `Радиус действия: ${metadata.rangeMax} м`;
}

/**
 * «Затраты: N», which for a caster is not in the spell's own row.
 *
 * `ManaCost` is zero on 6,728 of the 7,369 spells that reach the book, and 1,543 of those price
 * themselves as a percentage in `ManaCostPct` instead — so before this line existed the cost was
 * missing from *every* spell a mage, a priest, a warlock, a druid or a shaman owns. No row on this
 * dataset carries both, so the two are alternatives and not summands.
 *
 * The base the percentage multiplies is the caster's, as `Spell::CalcPowerCost` has it:
 * `GetCreateMana()` — `UNIT_FIELD_BASE_MANA` — for a mana spell and `GetCreateHealth()` for a
 * health one. Of the 1,543 percentage rows in the book 1,530 are mana, 12 are health and one is
 * runes; the last is left as a percentage rather than guessed at. Rage and runic power are stored
 * ten times what they read (`POWER_DISPLAY_SCALE`), which is why «Удар героя» costs 150 in the
 * table and 15 on the screen.
 */
function powerCostLine(metadata: SpellMetadata): string | undefined {
  const scale = POWER_DISPLAY_SCALE[metadata.powerType] ?? 1;
  if (metadata.powerCost > 0) return `Затраты: ${Math.round(metadata.powerCost / scale)}`;
  if (metadata.powerCostPercent <= 0) return undefined;
  const base = basePower(metadata.powerType);
  return base === undefined
    ? `Затраты: ${metadata.powerCostPercent}%`
    : `Затраты: ${Math.floor(base * metadata.powerCostPercent / 100 / scale)}`;
}

/** The player's own create-time pool, which is what a percentage cost is taken from. */
function basePower(powerType: number): number | undefined {
  const world = game.world;
  const self = world?.state.selfGuid === undefined ? undefined
    : world.state.objects.get(world.state.selfGuid);
  if (!self) return undefined;
  if (powerType === POWER.mana) return readField(self, "UNIT_FIELD_BASE_MANA");
  // `POWER_HEALTH` is −2 in the core's enum and in this column, and it is the warlock's twelve.
  if (powerType === -2) return readField(self, "UNIT_FIELD_BASE_HEALTH");
  return undefined;
}

/** Name a reagent from the session before falling back to the honest unnamed label. */
function reagentName(itemId: number): string {
  const world = game.world;
  return world?.itemTemplate(itemId)?.name
    ?? game.itemMetadata?.get(itemId)?.name
    ?? unknownLabel("предмет", itemId);
}

function durationLine(milliseconds: number): string | undefined {
  if (!(milliseconds > 0)) return undefined;
  const total = Math.round(milliseconds / 1000);
  if (total >= 3600) return `Длительность: ${Math.ceil(total / 3600)} ч`;
  if (total >= 60) return `Длительность: ${Math.ceil(total / 60)} мин`;
  return `Длительность: ${seconds(milliseconds)} с`;
}

/** Name, rank, what it costs and what it does — the reason a spellbook is worth opening. */
export function spellTooltip(spellId: number): TooltipContent {
  const metadata = game.spells.get(spellId);
  if (!metadata) return { title: unknownLabel("заклинание", spellId), footer: ["Описание загружается…"] };
  const lines: Array<string | TooltipLine> = [];
  if (metadata.rank) lines.push(metadata.rank);
  const school = SCHOOL_NAMES.filter((_, bit) => (metadata.schoolMask & (1 << bit)) !== 0);
  if (school.length > 0) lines.push(`Школа: ${school.join(", ")}`);
  const range = rangeLine(metadata);
  if (range) lines.push(range);
  if (!metadata.passive) {
    lines.push(metadata.castTime > 0 ? `Сотворение: ${seconds(metadata.castTime)} с` : "Мгновенное");
  }
  const cost = powerCostLine(metadata);
  if (cost) lines.push(cost);
  const cooldown = Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime);
  if (cooldown > 0) lines.push(`Восстановление: ${seconds(cooldown)} с`);
  const duration = durationLine(metadata.duration);
  if (duration) lines.push({ text: duration, tone: "muted" });
  const radius = Math.max(0, ...(metadata.effectRadius ?? []));
  if (radius > 0) lines.push({ text: `Радиус поражения: ${radius} м`, tone: "muted" });
  if (metadata.procChance > 0 && metadata.procChance < 100) {
    lines.push({ text: `Шанс срабатывания: ${metadata.procChance}%`, tone: "muted" });
  }
  if (metadata.reagents && metadata.reagents.length > 0) {
    const parts = metadata.reagents.map((reagent) => reagent.count > 1
      ? `${reagentName(reagent.itemId)} ×${reagent.count}` : reagentName(reagent.itemId));
    lines.push({ text: `Реагенты: ${parts.join(", ")}`, tone: "gold" });
  }
  if (metadata.requiredToolNames && metadata.requiredToolNames.length > 0) {
    lines.push({ text: `Инструмент: ${metadata.requiredToolNames.join(", ")}`, tone: "muted" });
  }
  if (metadata.requiredTargetMode === GROUND_TARGET_MODE) {
    lines.push({ text: "Цель: точка на земле", tone: "spell" });
  }
  if (metadata.passive) lines.push("Пассивное");
  // A description out of `Spell.dbc` is a template, not a sentence: «$s1 ед. урона» is what
  // 22,599 of them look like, and every one of those markers used to reach the tooltip intact.
  // It is also the spell's main body copy, not an interaction hint: keeping it in the footer made
  // long Russian text as small and muted as «Перетащите на панель команд».
  const description = formatSpellDescription(metadata.description, metadata, spellDescriptionContext());
  if (description) lines.push({ text: description, tone: "description" });
  return {
    title: metadata.name,
    lines,
    footer: metadata.passive ? undefined : ["Перетащите на панель команд"],
  };
}

/**
 * The ruRU client's own words for the stock spell tooltip's rows, line for line out of
 * `Interface\FrameXML\GlobalStrings.lua`. The generated table (`tools/generate-global-strings.mjs`)
 * takes the `ITEM_*`, `INVTYPE_*` and `SPELL_FAILED_*` families and a named few, none of these, so
 * the same line of the same file stands in; a locale the generator does learn wins over it.
 * `SPELL_TOTEMS` is written `"Инструменты:\32"` there, `\32` being Lua's escape for the space.
 */
const STOCK_SPELL_STRINGS: Readonly<Record<string, string>> = {
  MANA_COST: "Мана: %d", // :4892
  RAGE_COST: "Ярость: %d", // :5938
  FOCUS_COST: "Тонус: %d", // :3713
  ENERGY_COST: "Энергия: %d", // :2816
  RUNIC_POWER_COST: "Требуется %d |4единица:единицы:единиц; силы рун", // :6162
  HEALTH_COST: "Здоровье: %d", // :4011
  SPELL_CAST_TIME_INSTANT: "Мгновенное действие", // :6919
  SPELL_CAST_CHANNELED: "Потоковое", // :6915
  SPELL_ON_NEXT_SWING: "Следующая атака", // :7222
  SPELL_CAST_TIME_SEC: "Применение: %.3g сек.", // :6923
  SPELL_CAST_TIME_MIN: "применение заклинания: %.3g мин.", // :6921
  SPELL_RECAST_TIME_SEC: "Восстановление: %.3g сек.", // :7241
  SPELL_RECAST_TIME_MIN: "Восстановление: %.3g мин.", // :7240
  SPELL_REAGENTS: "Реагенты: |n", // :7238
  SPELL_TOTEMS: "Инструменты: ", // :7321
};

const stockSpellString = (key: string): string => globalString(key) ?? STOCK_SPELL_STRINGS[key] ?? "";

/** C's `%.3g`, which is how the client writes a cast or a cooldown: 1.5, 2.5, 3, 10, 120. */
const threeDigits = (value: number): string => String(Number(value.toPrecision(3)));

/** The cost row's word per `Powers` value; −2 is the core's `POWER_HEALTH`. Runes have none here. */
const STOCK_POWER_COST_KEYS: Readonly<Record<number, string>> = {
  [POWER.mana]: "MANA_COST", [POWER.rage]: "RAGE_COST", [POWER.focus]: "FOCUS_COST",
  [POWER.energy]: "ENERGY_COST", [POWER.runicPower]: "RUNIC_POWER_COST", [-2]: "HEALTH_COST",
};

/**
 * «Мана: 320», the stock cost row's left half: the same amount `powerCostLine` works out, under the
 * power's own word instead of the native «Затраты».
 */
function stockPowerCost(metadata: SpellMetadata): string | undefined {
  const key = STOCK_POWER_COST_KEYS[metadata.powerType];
  if (key === undefined) return undefined;
  const scale = POWER_DISPLAY_SCALE[metadata.powerType] ?? 1;
  let amount: number | string | undefined;
  if (metadata.powerCost > 0) amount = Math.round(metadata.powerCost / scale);
  else if (metadata.powerCostPercent > 0) {
    const base = basePower(metadata.powerType);
    amount = base === undefined ? `${metadata.powerCostPercent}%`
      : Math.floor(base * metadata.powerCostPercent / 100 / scale);
  }
  return amount === undefined ? undefined : fillTemplate(stockSpellString(key), amount);
}

/** A cast or a recovery in the client's two units: seconds under a minute, minutes from one up. */
function stockTime(milliseconds: number, secondsKey: string, minutesKey: string): string {
  return milliseconds >= 60_000
    ? stockSpellString(minutesKey).replace("%.3g", threeDigits(milliseconds / 60_000))
    : stockSpellString(secondsKey).replace("%.3g", threeDigits(milliseconds / 1000));
}

/** `stockSpellTooltip`'s options: the buff bar's tooltip, and 3.43's facts of the aura slot it is drawn for. */
export interface StockSpellTooltipOptions {
  readonly aura?: boolean;
  /** 3.43: the aura slot's caster level (SMSG_AURA_UPDATE; Wow.exe 0x0061f890, slot byte +0xd); absent, 0. */
  readonly auraLevel?: number;
  /** 3.43: the aura slot's applications byte (0x0061f8d0, slot byte +0xe); absent, the multiplier stays 1. */
  readonly auraCount?: number;
}

/**
 * 3.43 (11.11): the description context of an aura's tooltip, as Wow.exe 0x00625350 calls 0x0057abc0 — the slot's
 * caster level (0 is the caster's own), the slot's count as the multiplier only for a spell whose CumulativeAura is
 * 2 or more (else 1), and the aura flag that leaves the effect values and `$d` without the spell modifiers.
 *
 * The slot's level is not capped at the row's MaxLevel on this path: 0x00625f00 masks the byte (& 0xff) and nothing
 * else, 0x0057abc0 calls 0x007ff070 (whose player vtable slot 0x006dc330 holds the only MaxLevel × 5 cap) only for
 * a level of 0, 0x00579e50 caps at MaxLevel only for a written spell id (`$12345s1`), and 0x007ff770 (listing
 * 0x007ff7b3…0x007ff7dd) subtracts BaseLevel and clamps at 0 alone. A rank-1 Power Word: Shield (17: 43, 0.8 a level
 * from 6, MaxLevel 11) on a level-80 caster's slot therefore reads 44 + 0.8 × 74 = 103 in the original as here.
 */
export function auraDescriptionContext(base: SpellDescriptionContext, metadata: Pick<SpellMetadata, "stackAmount">,
  options: StockSpellTooltipOptions): SpellDescriptionContext {
  const count = options.auraCount;
  const multiplier = (metadata.stackAmount ?? 0) < 2 || count === undefined ? 1 : count & 0xff;
  return { ...base, aura: true, level: (options.auraLevel ?? 0) & 0xff, multiplier };
}

/**
 * The spell as the stock `GameTooltip` draws it in 3.3.5, for the FrameXML HUD.
 *
 * The native {@link spellTooltip} lists one fact per line, which suits the spellbook's own box and
 * stays as it is. The original pairs them instead: the name with the rank right-aligned in grey,
 * the cost with the range, the cast time with the cooldown, and then the description as wrapped
 * gold prose. Duration, radius and proc chance are not rows of their own there — the description
 * says them — and neither is the school, which the native box alone prints. The description keeps
 * its `description` tone because the aura tooltip picks it out by that tone.
 *
 * The cast row is the `SpellAttributes` bits first, then the time: an on-next-swing strike
 * («Удар героя») reads «Следующая атака» and a channelled spell («Чародейские стрелы», cast time
 * 0 on 1,745 of the dataset's 1,961 channels) «Потоковое», before a cast time or «Мгновенное
 * действие» is considered. A gateway that predates those bits (`onNextSwing`/`channeled` absent)
 * gets the time rows it got before.
 *
 * `aura: true` is the buff bar's tooltip: the same rows with the spell's `AuraDescription` as the
 * gold prose, which is what the 3.3.5 client shows on a buff or debuff, and the cast description
 * when the row has none or the gateway serves none.
 */
export function stockSpellTooltip(spellId: number, options?: StockSpellTooltipOptions): TooltipContent {
  const metadata = game.spells.get(spellId);
  if (!metadata) return { title: unknownLabel("заклинание", spellId), footer: ["Описание загружается…"] };
  const lines: TooltipLine[] = [];
  const pair = (left: string | undefined, right: string | undefined): void => {
    if (!left && !right) return;
    lines.push(right ? { text: left ?? "", right } : { text: left ?? "" });
  };
  pair(stockPowerCost(metadata), rangeLine(metadata));
  const cooldown = Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime);
  pair(
    metadata.passive ? undefined
      : metadata.onNextSwing === true ? stockSpellString("SPELL_ON_NEXT_SWING")
        : metadata.channeled === true ? stockSpellString("SPELL_CAST_CHANNELED")
          : metadata.castTime > 0
            ? stockTime(metadata.castTime, "SPELL_CAST_TIME_SEC", "SPELL_CAST_TIME_MIN")
            : stockSpellString("SPELL_CAST_TIME_INSTANT"),
    cooldown > 0 ? stockTime(cooldown, "SPELL_RECAST_TIME_SEC", "SPELL_RECAST_TIME_MIN") : undefined,
  );
  if (metadata.reagents && metadata.reagents.length > 0) {
    const parts = metadata.reagents.map((reagent) => reagent.count > 1
      ? `${reagentName(reagent.itemId)} ×${reagent.count}` : reagentName(reagent.itemId));
    // `|n` is the client's line break; the list stays on the label's line, as the native box has it.
    lines.push({ text: `${stockSpellString("SPELL_REAGENTS").replace(/\|n\s*$/, "")}${parts.join(", ")}` });
  }
  if (metadata.requiredToolNames && metadata.requiredToolNames.length > 0) {
    lines.push({ text: `${stockSpellString("SPELL_TOTEMS")}${metadata.requiredToolNames.join(", ")}` });
  }
  // The aura text uses the same `$` markers as the description (`$s1`, `$t2`, `$42208s1`), so it
  // goes through the same formatter.
  const prose = options?.aura && metadata.auraDescription ? metadata.auraDescription : metadata.description;
  const description = formatSpellDescription(prose, metadata,
    options?.aura ? auraDescriptionContext(spellDescriptionContext(), metadata, options) : spellDescriptionContext());
  if (description) lines.push({ text: description, tone: "description", wrap: true });
  return metadata.rank ? { title: metadata.name, titleRight: metadata.rank, lines } : { title: metadata.name, lines };
}
