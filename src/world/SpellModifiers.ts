/**
 * What an active spell modifier changes, in words.
 *
 * Names follow TrinityCore's `SpellModOp` (`SpellDefines.h:93-126`); the Russian labels are this
 * client's. `effectIndex` is the spell-family bit the modifier applies to — the exact spells are
 * the server's business, so the book lists modifiers globally rather than per spell.
 */

const SPELLMOD_NAMES: Record<number, string> = {
  0: "урон",
  1: "длительность",
  2: "угроза",
  3: "эффект 1",
  4: "заряды",
  5: "дальность",
  6: "радиус",
  7: "шанс крита",
  8: "все эффекты",
  9: "защита от сбивания",
  10: "время сотворения",
  11: "восстановление",
  12: "эффект 2",
  13: "игнор брони",
  14: "стоимость",
  15: "бонус крита",
  16: "сопротивление промаху",
  17: "доп. цели",
  18: "шанс успеха",
  19: "время активации",
  20: "множитель урона",
  21: "глобальное восстановление",
  22: "урон за время",
  23: "эффект 3",
  24: "бонус-множитель",
  26: "проков в минуту",
  27: "множитель значения",
  28: "сопротивление рассеиванию",
  30: "возврат стоимости при неудаче",
};

export function spellModOpName(op: number): string {
  return SPELLMOD_NAMES[op] ?? `параметр ${op}`;
}

export interface SpellModifierView {
  effectIndex: number;
  op: number;
  value: number;
  pct: boolean;
}

/** One active modifier as a readable line, e.g. «урон заклинаний семейства 3: +15%». */
export function spellModifierText(modifier: SpellModifierView): string {
  const sign = modifier.value >= 0 ? "+" : "";
  const amount = modifier.pct ? `${sign}${modifier.value}%` : `${sign}${modifier.value}`;
  return `${spellModOpName(modifier.op)} (семейство ${modifier.effectIndex}): ${amount}`;
}
