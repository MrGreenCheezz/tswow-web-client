/**
 * What the native character sheet prints (WORK_PLAN 4.03), DOM-free.
 *
 * The rows are the stock PaperDoll's four combat categories — `UpdatePaperdollStats` in
 * PaperDollFrame.lua: melee, ranged, spell, defences — with the stock row's value and the stock row's
 * tooltip sentence, both in the client's own words (GlobalStrings through `nativeString`, with a
 * Russian fallback for a checkout without local strings). The numbers come from
 * `world/CharacterStatFields.ts`, which answers what LiveWorldSeam answers the stock sheet, so the
 * two sheets agree on one character.
 *
 * Anything the fields alone cannot settle stays out rather than turning into a zero: a rating's
 * percentage and the defence a rating adds need the rating tables (`/dbc/character-stats`), and
 * without them the rating tooltips and the defence row are simply not there.
 */
import {
  CR, attackPower, attackSpeed, avoidanceFromDefense, blockChance, combatRating, defense, dodgeChance, expertise,
  expertisePercent, floatWord, magicSchoolSpread, manaRegen, meleeCritChance, meleeDamage, parryChance,
  rangedAttackSpeed, rangedCritChance, rangedDamage, resilience, shieldBlock, spellBonusDamage, spellBonusHealing,
  spellCritChance, spellPenetration, unitResistance, unitStat, type DefenseSkill, type DamageRange,
} from "../../world/CharacterStatFields.js";
import { characterCombatRatingBonus, type CharacterStatCatalog } from "../../world/CharacterStatData.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { nativeString } from "./Strings.js";

export type SheetTone = "buff" | "debuff";

export interface SheetRow {
  readonly label: string;
  readonly value: string;
  /** A plain tooltip: first line the title, the rest lines under it. */
  readonly tip?: string;
  readonly tone?: SheetTone;
}

export interface SheetSection {
  readonly key: "base" | "melee" | "ranged" | "spell" | "defenses";
  readonly title: string;
  readonly rows: readonly SheetRow[];
}

export interface SheetContext {
  readonly classId: number;
  readonly level: number;
  /** `/dbc/character-stats`' rating tables; undefined until (or unless) they arrive. */
  readonly catalog: CharacterStatCatalog | undefined;
  /** The player's SKILL_DEFENSE entry (ui/Skills.ts `readSkills`). */
  readonly defenseSkill: DefenseSkill | undefined;
  /** Stock `UnitHasMana("player")`: the mana row says «НЕТ» otherwise. */
  readonly hasMana: boolean;
  /** A ranged item in slot 18 and no relic slot (PaperDollFrame_SetRangedDamage's test). */
  readonly rangedWeapon: boolean;
}

/** `ATTACK_POWER_MAGIC_NUMBER` (PaperDollFrame.lua): attack power per point of DPS. */
export const ATTACK_POWER_MAGIC_NUMBER = 14;

/** `RESILIENCE_CRIT_CHANCE_TO_DAMAGE_REDUCTION_MULTIPLIER` and `…_TO_CONSTANT_…` (PaperDollFrame.lua:42-43). */
const RESILIENCE_TO_CRIT_DAMAGE = 2.2;
const RESILIENCE_TO_CONSTANT_DAMAGE = 2.0;

/**
 * `GetMaxCombatRatingBonus(index)` as Wow.exe answers it (0x006082c0): no table — the double at
 * 0x00a1f778 (33.0000013…) for the three crit-taken ratings, CR 15-17, and the one at 0x009ec208 (-1)
 * for every other index.
 */
export function maxCombatRatingBonus(index: number): number {
  return index >= CR.CRIT_TAKEN_MELEE && index <= CR.CRIT_TAKEN_SPELL ? 33.000001311302185 : -1;
}

/** `PaperDollFrame_GetArmorReduction(armor, attackerLevel)` (PaperDollFrame.lua:1497-1514), in percent. */
export function armorReduction(armor: number, attackerLevel: number): number {
  const level = attackerLevel > 59 ? attackerLevel + 4.5 * (attackerLevel - 59) : attackerLevel;
  let reduction = 0.1 * armor / (8.5 * level + 40);
  reduction /= 1 + reduction;
  return reduction > 0.75 ? 75 : reduction < 0 ? 0 : reduction * 100;
}

/**
 * `ComputePetBonus("PET_BONUS_ARMOR", value)` (PaperDollFrame.lua:1662): the pet's share for the two stock
 * pet classes by `UnitClass`'s token — 3 HUNTER and 9 WARLOCK, both 0.35 — and nothing for any other.
 */
function petArmorBonus(classId: number, armor: number): number {
  return petBonus(classId, "PET_BONUS_ARMOR", armor);
}

/**
 * L7 4.03: stock `ComputePetBonus(stat, value)` (PaperDollFrame.lua:1662-1680) over its two tables
 * (:46-64), keyed by `UnitClass`'s token: HUNTER (3) and WARLOCK (9) only; a stat a table lacks is 0.
 */
const PET_BONUS: Readonly<Record<number, Readonly<Record<string, number>>>> = {
  3: { PET_BONUS_RAP_TO_AP: 0.22, PET_BONUS_RAP_TO_SPELLDMG: 0.1287, PET_BONUS_STAM: 0.3, PET_BONUS_RES: 0.4,
    PET_BONUS_ARMOR: 0.35, PET_BONUS_SPELLDMG_TO_SPELLDMG: 0, PET_BONUS_SPELLDMG_TO_AP: 0, PET_BONUS_INT: 0 },
  9: { PET_BONUS_RAP_TO_AP: 0, PET_BONUS_RAP_TO_SPELLDMG: 0, PET_BONUS_STAM: 0.3, PET_BONUS_RES: 0.4,
    PET_BONUS_ARMOR: 0.35, PET_BONUS_SPELLDMG_TO_SPELLDMG: 0.15, PET_BONUS_SPELLDMG_TO_AP: 0.57, PET_BONUS_INT: 0.3 },
};

export function petBonus(classId: number, stat: string, value: number): number {
  return value * (PET_BONUS[classId]?.[stat] ?? 0);
}

/**
 * `nativeString`, with the Lua source's `\n` escape — kept verbatim by the generator — turned into the
 * line break the tooltip splits on.
 */
const S = (key: string, fallback: string, ...args: (string | number)[]): string =>
  nativeString(key, fallback, ...args).replace(/\\n/g, "\n");
const percent = (value: number): string => `${value.toFixed(2)}%`;
const labelled = (name: string, value: string | number): string => `${S("PAPERDOLLFRAME_TOOLTIP_FORMAT", "%s:", name)} ${value}`;

/** PaperDollFormatStat: the clamped total, a tooltip with the base and both buffs, green or red. */
function formattedStat(label: string, tipName: string, base: number, positive: number, negative: number,
  extra?: string): SheetRow {
  const effective = Math.max(0, base + positive + negative);
  let tip = labelled(tipName, effective);
  let tone: SheetTone | undefined;
  if (positive !== 0 || negative !== 0) {
    if (positive > 0 || negative < 0) tip += ` (${base}`;
    if (positive > 0) tip += ` +${positive}`;
    if (negative < 0) tip += ` ${negative}`;
    if (positive > 0 || negative < 0) tip += ")";
    tone = negative < 0 ? "debuff" : "buff";
  }
  if (extra) tip += `\n${extra}`;
  return tone ? { label, value: String(effective), tip, tone } : { label, value: String(effective), tip };
}

/** PaperDollFrame_SetDamage's text: floor/ceil at least one, spaced around the dash below a hundred. */
export function damageText(range: DamageRange): string {
  const low = Math.max(Math.floor(range.min), 1);
  const high = Math.max(Math.ceil(range.max), 1);
  return low < 100 && high < 100 ? `${low} - ${high}` : `${low}-${high}`;
}

/** The physical damage modifiers of UnitDamage: school 0 of the three damage arrays, the percent a float word. */
function physicalModifiers(object: WorldObjectState): { positive: number; negative: number; percent: number } {
  const at = (name: "PLAYER_FIELD_MOD_DAMAGE_DONE_POS" | "PLAYER_FIELD_MOD_DAMAGE_DONE_NEG" | "PLAYER_FIELD_MOD_DAMAGE_DONE_PCT") =>
    object.fields.get(UPDATE_FIELDS[name].offset);
  const raw = at("PLAYER_FIELD_MOD_DAMAGE_DONE_PCT");
  const decoded = raw === undefined ? 1 : floatWord(raw);
  return { positive: (at("PLAYER_FIELD_MOD_DAMAGE_DONE_POS") ?? 0) | 0, negative: (at("PLAYER_FIELD_MOD_DAMAGE_DONE_NEG") ?? 0) | 0,
    percent: decoded > 0 ? decoded : 1 };
}

/** The damage row's colour: the stock row is tinted when the base-to-full bonus is outside ±0.1. */
function damageTone(range: DamageRange, modifiers: ReturnType<typeof physicalModifiers>): SheetTone | undefined {
  const min = range.min / modifiers.percent - modifiers.positive - modifiers.negative;
  const max = range.max / modifiers.percent - modifiers.positive - modifiers.negative;
  const base = (min + max) * 0.5;
  const bonus = (base + modifiers.positive + modifiers.negative) * modifiers.percent - base;
  return bonus >= 0.1 ? "buff" : bonus <= -0.1 ? "debuff" : undefined;
}

function row(label: string, value: string, tip?: string, tone?: SheetTone): SheetRow {
  return { label, value, ...(tip ? { tip } : {}), ...(tone ? { tone } : {}) };
}

export function characterStatSections(object: WorldObjectState, context: SheetContext): SheetSection[] {
  const bonus = (index: number): number | undefined => characterCombatRatingBonus(context.catalog, context.classId,
    context.level, index, combatRating(object, index));
  /** The stock rating tooltip, or nothing without the tables. */
  const ratingTip = (title: string, key: string, fallback: string, index: number, ...extra: (string | number)[]): string | undefined => {
    const value = bonus(index);
    return value === undefined ? undefined : `${title}\n${S(key, fallback, combatRating(object, index), value, ...extra)}`;
  };
  const crName = (index: number, fallback: string): string => S(`COMBAT_RATING_NAME${index}`, fallback);

  // ---- base stats -------------------------------------------------------------------------------
  const statNames = ["Сила", "Ловкость", "Выносливость", "Интеллект", "Дух"];
  const base: SheetRow[] = [];
  for (let index = 1; index <= 5; index++) {
    const stat = unitStat(object, index)!;
    const name = S(`SPELL_STAT${index}_NAME`, statNames[index - 1]!);
    // UnitStat's first value is the total less the buffs (PaperDollFrame_SetStat subtracts them).
    // L7 4.03: the pet's share of stamina and intellect (PaperDollFrame_SetStat :281-306). The stock line
    // above it (DEFAULT_STAT3/4_TOOLTIP) needs GetUnitMaxHealthModifier and the intellect crit table,
    // which this sheet does not have, so only the pet's line is written.
    const petKey = index === 3 ? "PET_BONUS_STAM" : index === 4 ? "PET_BONUS_INT" : undefined;
    const pet = petKey ? petBonus(context.classId, petKey, stat.effective) : 0;
    const petLine = pet <= 0 ? undefined : index === 3
      ? S("PET_BONUS_TOOLTIP_STAMINA", "Увеличивает выносливость питомца на %d.", pet)
      : S("PET_BONUS_TOOLTIP_INTELLECT", "Увеличивает интеллект питомца на %d.", pet);
    base.push(formattedStat(name, name, stat.effective - stat.positive - stat.negative, stat.positive, stat.negative, petLine));
  }

  // ---- melee ------------------------------------------------------------------------------------
  const damageLabel = S("DAMAGE", "Урон");
  const speedLabel = S("WEAPON_SPEED", "Скорость");
  const damage = meleeDamage(object);
  const modifiers = physicalModifiers(object);
  const [mainSpeed, offSpeed] = attackSpeed(object);
  const speedText = offSpeed === undefined ? mainSpeed.toFixed(2) : `${mainSpeed.toFixed(2)} / ${offSpeed.toFixed(2)}`;
  const melee = attackPower(object);
  const hitName = crName(CR.HIT_MELEE, "Рейт. меткости");
  const armorPenetration = Math.min(bonus(CR.ARMOR_PENETRATION) ?? 0, 100);
  const meleeCrit = percent(meleeCritChance(object));
  const [mainExpertise, offExpertise] = expertise(object);
  const [mainExpertisePercent, offExpertisePercent] = expertisePercent(object);
  const expertiseText = offSpeed === undefined ? String(mainExpertise) : `${mainExpertise} / ${offExpertise}`;
  const expertisePercentText = offSpeed === undefined ? `${mainExpertisePercent.toFixed(2)}%`
    : `${mainExpertisePercent.toFixed(2)}% / ${offExpertisePercent.toFixed(2)}%`;
  const expertiseBonus = bonus(CR.EXPERTISE);
  const meleeRows: SheetRow[] = [
    row(damageLabel, damageText(damage.main), undefined, damageTone(damage.main, modifiers)),
    row(speedLabel, speedText, ratingTip(labelled(S("ATTACK_SPEED", "Скорость атаки"), speedText),
      "CR_HASTE_RATING_TOOLTIP", "Рейтинг скорости %d (скорость: +%.2f%%)", CR.HASTE_MELEE)),
    formattedStat(S("ATTACK_POWER", "Сила атаки"), S("MELEE_ATTACK_POWER", "Сила атаки ближнего боя"),
      melee.base, melee.positive, melee.negative,
      S("MELEE_ATTACK_POWER_TOOLTIP", "Увеличивает урон от оружия ближнего боя на %.1f ед. урона в секунду.",
        melee.effective / ATTACK_POWER_MAGIC_NUMBER)),
    row(hitName, String(combatRating(object, CR.HIT_MELEE)), bonus(CR.HIT_MELEE) === undefined ? undefined
      : `${labelled(hitName, combatRating(object, CR.HIT_MELEE))}\n${S("CR_HIT_MELEE_TOOLTIP",
        "Вероятность нанести цели %d-го уровня урон в ближнем бою повышена на %.2f%%.\n\nРейтинг пробивания брони %d (+%.2f%%)",
        context.level, bonus(CR.HIT_MELEE)!, combatRating(object, CR.ARMOR_PENETRATION), armorPenetration)}`),
    row(S("MELEE_CRIT_CHANCE", "Крит. удар"), meleeCrit, ratingTip(labelled(S("MELEE_CRIT_CHANCE", "Крит. удар"), meleeCrit),
      "CR_CRIT_MELEE_TOOLTIP", "Рейтинг критического удара: %d (вероятность нанесения +%.2f%%).", CR.CRIT_MELEE)),
    row(S("STAT_EXPERTISE", "Мастерство"), expertiseText, expertiseBonus === undefined ? undefined
      : `${labelled(crName(CR.EXPERTISE, "Мастерство"), expertiseText)}\n${S("CR_EXPERTISE_TOOLTIP",
        "Вероятность того, что противник уклонится от удара или парирует его, снижена на %s.\nРейтинг мастерства %d (+%.2f мастерства)",
        expertisePercentText, combatRating(object, CR.EXPERTISE), expertiseBonus)}`),
  ];

  // ---- ranged -----------------------------------------------------------------------------------
  const notApplicable = S("NOT_APPLICABLE", "НЕТ");
  const ranged = attackPower(object, true);
  // L7 4.03: PaperDollFrame_SetRangedAttackPower (:899-909) — the pet's share of the unclamped total.
  const rangedTotal = ranged.base + ranged.positive + ranged.negative;
  const petAttackPower = petBonus(context.classId, "PET_BONUS_RAP_TO_AP", rangedTotal);
  const petSpellDamage = petBonus(context.classId, "PET_BONUS_RAP_TO_SPELLDMG", rangedTotal);
  const rangedPetLines = [
    petAttackPower > 0 ? S("PET_BONUS_TOOLTIP_RANGED_ATTACK_POWER", "Увеличивает силу атаки питомца на %d.", petAttackPower) : "",
    petSpellDamage > 0 ? S("PET_BONUS_TOOLTIP_SPELLDAMAGE", "Увеличивает урон от заклинаний питомца на %d.", petSpellDamage) : "",
  ].filter(Boolean);
  const rangedSpeed = rangedAttackSpeed(object).toFixed(2);
  const rangedHitName = crName(CR.HIT_RANGED, "Рейт. меткости");
  const rangedCrit = percent(rangedCritChance(object));
  const rangedRows: SheetRow[] = [
    context.rangedWeapon
      ? row(damageLabel, damageText(rangedDamage(object)), undefined, damageTone(rangedDamage(object), modifiers))
      : row(damageLabel, notApplicable),
    row(speedLabel, context.rangedWeapon ? rangedSpeed : notApplicable, ratingTip(
      context.rangedWeapon ? labelled(S("ATTACK_SPEED", "Скорость атаки"), rangedSpeed) : speedLabel,
      "CR_HASTE_RATING_TOOLTIP", "Рейтинг скорости %d (скорость: +%.2f%%)", CR.HASTE_RANGED)),
    formattedStat(S("ATTACK_POWER", "Сила атаки"), S("RANGED_ATTACK_POWER", "Сила атаки дальнего боя"),
      ranged.base, ranged.positive, ranged.negative,
      [S("RANGED_ATTACK_POWER_TOOLTIP", "Увеличивает урон от оружия дальнего боя на %.1f ед. урона в секунду.",
        ranged.effective / ATTACK_POWER_MAGIC_NUMBER), ...rangedPetLines].join("\n")), // L7 4.03: + pet lines
    row(rangedHitName, String(combatRating(object, CR.HIT_RANGED)), bonus(CR.HIT_RANGED) === undefined ? undefined
      : `${labelled(rangedHitName, combatRating(object, CR.HIT_RANGED))}\n${S("CR_HIT_RANGED_TOOLTIP",
        "Вероятность нанести цели %d-го уровня урон в дальнем бою повышена на %.2f%%.\n\nРейтинг пробивания брони %d (+%.2f%%)",
        context.level, bonus(CR.HIT_RANGED)!, combatRating(object, CR.ARMOR_PENETRATION), armorPenetration)}`),
    row(S("RANGED_CRIT_CHANCE", "Крит. удар"), rangedCrit, ratingTip(labelled(S("RANGED_CRIT_CHANCE", "Крит. удар"), rangedCrit),
      "CR_CRIT_RANGED_TOOLTIP", "Рейтинг критического удара: %d (вероятность нанесения +%.2f%%).", CR.CRIT_RANGED)),
  ];

  // ---- spell ------------------------------------------------------------------------------------
  const schoolNames = ["", "", "свет", "огонь", "природа", "лед", "тьма", "тайная магия"];
  const schoolLines = (spread: ReturnType<typeof magicSchoolSpread>, format: (value: number) => string): string =>
    [...spread.bySchool].map(([school, value]) => `${S(`DAMAGE_SCHOOL${school}`, schoolNames[school]!)}: ${format(value)}`).join("\n");
  const damageSpread = magicSchoolSpread((school) => spellBonusDamage(object, school));
  const critSpread = magicSchoolSpread((school) => spellCritChance(object, school));
  const bonusDamageName = S("BONUS_DAMAGE", "Доп. урон");
  const healing = spellBonusHealing(object);
  const healingName = S("BONUS_HEALING", "Доп. лечение");
  const spellHitName = crName(CR.HIT_SPELL, "Рейт. меткости");
  const penetration = spellPenetration(object);
  const hasteName = S("SPELL_HASTE", "Рейт. скорости");
  const hasteBonus = bonus(CR.HASTE_SPELL);
  const manaName = S("MANA_REGEN", "Восп. маны");
  const [regen, casting] = manaRegen(object);
  const spellRows: SheetRow[] = [
    row(bonusDamageName, String(damageSpread.min), `${labelled(bonusDamageName, damageSpread.min)}\n${schoolLines(damageSpread, String)}`),
    row(healingName, String(healing), `${healingName}\n${S("BONUS_HEALING_TOOLTIP", "Увеличивает способность исцелять на %d", healing)}`),
    row(spellHitName, String(combatRating(object, CR.HIT_SPELL)), bonus(CR.HIT_SPELL) === undefined ? undefined
      : `${labelled(spellHitName, combatRating(object, CR.HIT_SPELL))}\n${S("CR_HIT_SPELL_TOOLTIP",
        "Вероятность нанести цели %d-го уровня урон заклинаниями повышена на %.2f%%.\n\nПроникающая способность заклинаний %d (сопротивление цели снижено на %d)",
        context.level, bonus(CR.HIT_SPELL)!, penetration, penetration)}`),
    row(S("SPELL_CRIT_CHANCE", "Крит. удар"), percent(critSpread.min),
      `${labelled(crName(CR.CRIT_SPELL, "Рейтинг критического удара"), combatRating(object, CR.CRIT_SPELL))}\n${schoolLines(critSpread, percent)}`),
    row(hasteName, String(combatRating(object, CR.HASTE_SPELL)), hasteBonus === undefined ? undefined
      : `${hasteName}\n${S("SPELL_HASTE_TOOLTIP", "Скорость произнесения заклинаний повышена на %.2f%%.", hasteBonus)}`),
    context.hasMana
      ? row(manaName, String(Math.floor(regen * 5)), `${manaName}\n${S("MANA_REGEN_TOOLTIP",
        "Восполнение маны: %d каждые 5 секунд, если вы не творите заклинания;\n%d каждые 5 секунд, если вы творите заклинания.",
        Math.floor(regen * 5), Math.floor(casting * 5))}`)
      : row(manaName, notApplicable),
  ];

  // ---- defences ---------------------------------------------------------------------------------
  const armorName = S("ARMOR", "Броня");
  const armor = unitResistance(object, 0)!;
  const defenseName = S("DEFENSE", "Защита");
  const defenseValue = defense(context.defenseSkill, bonus(CR.DEFENSE_SKILL));
  const dodge = percent(dodgeChance(object));
  const parry = percent(parryChance(object));
  const block = percent(blockChance(object));
  const resilient = resilience(object);
  const resilienceBonus = bonus(resilient.index);
  const resilienceName = S("STAT_RESILIENCE", "Устойчивость");
  // PaperDollFrame_SetArmor: the reduction against a same-level attacker, then a pet class's share.
  const petArmor = petArmorBonus(context.classId, armor.effective);
  const armorTip = S("DEFAULT_STATARMOR_TOOLTIP", "Получаемый физический урон снижен на %0.2f%%.",
    armorReduction(armor.effective, context.level))
    + (petArmor > 0 ? `\n${S("PET_BONUS_TOOLTIP_ARMOR", "Увеличивает броню питомца на %d.", petArmor)}` : "");
  const defenseRows: SheetRow[] = [
    formattedStat(armorName, armorName, armor.base, armor.positive, armor.negative, armorTip),
  ];
  if (defenseValue) {
    const [skill, modifier] = defenseValue;
    const avoidance = avoidanceFromDefense(defenseValue, context.level);
    defenseRows.push(formattedStat(defenseName, defenseName, skill, Math.max(modifier, 0), Math.min(modifier, 0),
      S("DEFAULT_STATDEFENSE_TOOLTIP",
        "Рейтинг защиты: %d (+%d защиты)\nВероятность уклониться, блокировать или парировать удар повышена на %.2f%%\nВероятность того, что противник попадет по вам или нанесет критический удар, снижена на %.2f%%",
        combatRating(object, CR.DEFENSE_SKILL), bonus(CR.DEFENSE_SKILL)!, avoidance, avoidance)));
  }
  defenseRows.push(
    row(S("STAT_DODGE", "Уклонение"), dodge, ratingTip(labelled(S("DODGE_CHANCE", "Вероятность уклонения"), dodge),
      "CR_DODGE_TOOLTIP", "%d рейтинга уклонения добавляет %.2f%% к вероятности уклонения.", CR.DODGE)),
    row(S("STAT_PARRY", "Парирование"), parry, ratingTip(labelled(S("PARRY_CHANCE", "Вероятность парирования"), parry),
      "CR_PARRY_TOOLTIP", "%d рейтинга парирования добавляет %.2f%% к вероятности парирования.", CR.PARRY)),
    row(S("STAT_BLOCK", "Блок"), block, ratingTip(labelled(S("BLOCK_CHANCE", "Вероятность блока"), block),
      "CR_BLOCK_TOOLTIP", "Рейтинг блока %d увеличивает вероятность блокировать удар на %.2f%%\nПри успешном блоке урон уменьшается на %d.",
      CR.BLOCK, shieldBlock(object))),
    // PaperDollFrame_SetResilience: crit chance, crit damage capped by GetMaxCombatRatingBonus, all damage.
    row(resilienceName, String(resilient.rating), resilienceBonus === undefined ? undefined
      : `${labelled(resilienceName, resilient.rating)}\n${S("RESILIENCE_TOOLTIP",
        "Снижает вероятность того, что противник нанесет вам критический удар, на %.2f%%\\nПонижает эффективность похищения маны и урон, получаемый от критических ударов, на %.2f%%.\\nСнижает весь урон, получаемый от других игроков, их питомцев и прислужников, еще на %.2f%%.",
        resilienceBonus, Math.min(resilienceBonus * RESILIENCE_TO_CRIT_DAMAGE, maxCombatRatingBonus(resilient.index)),
        resilienceBonus * RESILIENCE_TO_CONSTANT_DAMAGE)}`),
  );

  return [
    { key: "base", title: S("PLAYERSTAT_BASE_STATS", "Основные"), rows: base },
    { key: "melee", title: S("PLAYERSTAT_MELEE_COMBAT", "Ближний бой"), rows: meleeRows },
    { key: "ranged", title: S("PLAYERSTAT_RANGED_COMBAT", "Дальний бой"), rows: rangedRows },
    { key: "spell", title: S("PLAYERSTAT_SPELL_COMBAT", "Магия"), rows: spellRows },
    { key: "defenses", title: S("PLAYERSTAT_DEFENSES", "Защита"), rows: defenseRows },
  ];
}

/** The title picker's source: FrameXmlTitles.ts's model, the one the stock picker reads too. */
export interface TitleSource {
  count(): number;
  isKnown(index: unknown): boolean;
  name(index: unknown): string | undefined;
  current(): number;
}

export interface TitleChoice {
  /** The CharTitles mask, or -1 for «Нет». */
  readonly value: number;
  readonly label: string;
}

/**
 * PlayerTitleFrame_UpdateTitles (PaperDollFrame.lua): «Нет» (-1) first, then every known title by its
 * trimmed name in byte order (`PlayerTitleSort`, Lua's `<`); nothing at all when no title is known
 * (the stock frame hides itself below two rows). `current` is GetCurrentTitle's -1 or the worn mask.
 */
export function titleChoices(titles: TitleSource): { readonly current: number; readonly options: readonly TitleChoice[] } | undefined {
  const known: TitleChoice[] = [];
  for (let index = 1; index < titles.count(); index++) {
    if (!titles.isKnown(index)) continue;
    const name = titles.name(index)?.trim();
    if (name) known.push({ value: index, label: name });
  }
  if (known.length === 0) return undefined;
  known.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
  return { current: titles.current(), options: [{ value: -1, label: nativeString("NONE", "Нет") }, ...known] };
}
