/**
 * 5.20: the stock debuff border colours, BuffFrame.lua:16-21 (`DebuffTypeColor`), keyed by the
 * `debuffType` string UnitAura hands out (Wow.exe 0x006147c0, resolved by the gateway): Magic,
 * Curse, Disease, Poison, and "" (Enrage), which the stock table aliases to "none". Undefined for a
 * row without a type or before its metadata arrives — the native strip's plain debuff border stays.
 */
export function debuffTypeBorder(debuffType: string | undefined): string | undefined {
  switch (debuffType) {
    case "Magic": return "rgb(51, 153, 255)";
    case "Curse": return "rgb(153, 0, 255)";
    case "Disease": return "rgb(153, 102, 0)";
    case "Poison": return "rgb(0, 153, 0)";
    case "": return "rgb(204, 0, 0)";
    default: return undefined;
  }
}
