/**
 * L7 4.16b / 3.32: the native extra rows on stock's pages, and the one-time move of what players had
 * placed on the old ones. DOM-free: the rules only; `ActionBarAccountSync.ts` runs them for a world.
 *
 * Until 4.16b the native rows stood on pages 7–10 (slots 72, 84, 96, 108) — stock's bonus pages of
 * stances, forms and stealth — while stock's own multi-bars show pages 6, 5, 3 and 4
 * (MultiActionBars.xml:41, 159, 277, 395). The rows now stand on the stock pages, and a button a
 * player put on a shown row before is copied once to the same column of the row's stock page:
 *
 * - only for a row the native HUD showed (a hidden row cannot have taken a drop; what sits on its old
 *   page is a stance or form bar, or nothing);
 * - only into an empty stock slot — a button already there was put there by the stock UI, Wow.exe or
 *   the main bar's page 3–6, and is never overwritten;
 * - (L7-review) never from a page the class's own stance, form or stealth bar uses — there the old
 *   row and the stance bar were one and the same slots, filled by whichever interface; copying them
 *   would put a stance bar on the stock multi-bars (`legacyRowIsBonusPage`);
 * - the old slot is left as it is: for a warrior, a druid or a rogue it is a live stance, form or
 *   stealth bar (`bonusActionPage`), and copying keeps both interfaces showing what they showed.
 *
 * The copy is an ordinary `CMSG_SET_ACTION_BUTTON` per slot (MiscHandler.cpp:983-994): the core
 * validates it like a drag (Player.cpp:6423-6491) and keeps it with the active talent group, which is
 * why the record of a finished move is a mask of talent groups.
 */

import {
  ACTION_BUTTONS_PER_PAGE, ACTIONBAR_MAIN_PAGES, EXTRA_ACTION_BARS, actionPage, bonusActionPage,
  type ActionButton, type ExtraActionBar,
} from "../../world/ActionBarProtocol.js";

/** One `CMSG_SET_ACTION_BUTTON` of the move: the stock slot, and the old slot it copies. */
export interface StockLayoutWrite extends ActionButton {
  from: number;
}

/**
 * L7-review 4.16b: the bonus bars a stock class's own stance, form or stealth puts on the main bar —
 * SpellShapeshiftForm.dbc BonusActionBar of the dataset: battle 1, defensive 2, berserker 3 (warrior);
 * stealth 1, shadow dance 2 (rogue); shadowform 1 (priest); cat 1, tree of life 2, bear and dire bear 3,
 * moonkin 4 (druid); every other form 0. A class missing here (TSWoW's own, such as the cross-class
 * HERO, or none known yet) may learn any form.
 */
const CLASS_BONUS_BARS: Readonly<Partial<Record<number, readonly number[]>>> = {
  1: [1, 2, 3], 2: [], 3: [], 4: [1, 2], 5: [1], 6: [], 7: [], 8: [], 9: [], 11: [1, 2, 3, 4],
};

/**
 * L7-review 4.16b: whether an old row's page is one of the class's stance, form or stealth pages
 * (bonus bar n is 0-based page 5 + n, `bonusActionPage`). The old native rows drew those pages too, so
 * what sits there may be the bar the stock UI or Wow.exe filled for a stance — and a player of the
 * stock UI has the row settings on whenever the byte has them (the stock options write them at world
 * entry), so «the row was shown» says nothing there. Such a page is never copied; an unknown class
 * counts every old page as one.
 */
export function legacyRowIsBonusPage(classId: number | undefined, legacyBase: number): boolean {
  const bars = classId === undefined ? undefined : CLASS_BONUS_BARS[classId];
  if (!bars) return true;
  return bars.some((bar) => bonusActionPage(0, bar) === actionPage(legacyBase));
}

/**
 * The writes that move what a shown old row holds onto its stock row, empty stock slots only.
 * `shown` answers whether the native HUD drew the row (its setting) before the move; `classId` is
 * the player's class (L7-review: rows on the class's bonus pages stay where they are).
 */
export function planStockLayoutMigration(
  buttons: readonly ActionButton[], shown: (bar: ExtraActionBar) => boolean, classId: number | undefined,
): StockLayoutWrite[] {
  const bySlot = new Map<number, ActionButton>();
  for (const button of buttons) if (button.action !== 0) bySlot.set(button.slot, button);
  const writes: StockLayoutWrite[] = [];
  for (const bar of EXTRA_ACTION_BARS) {
    if (bar.legacyBase === bar.stockBase || !shown(bar.id)) continue;
    if (legacyRowIsBonusPage(classId, bar.legacyBase)) continue; // L7-review
    for (let column = 0; column < ACTION_BUTTONS_PER_PAGE; column++) {
      const old = bySlot.get(bar.legacyBase + column);
      const target = bar.stockBase + column;
      if (!old || bySlot.has(target)) continue;
      writes.push({ slot: target, action: old.action, type: old.type, from: old.slot });
    }
  }
  return writes;
}

/** The record's bit for a talent group: the core keeps a set of 144 slots per group (`character_action.spec`). */
export function talentGroupBit(group: number | undefined): number {
  const index = Number.isInteger(group) && group! >= 0 && group! < 4 ? group! : 0;
  return 1 << index;
}

/**
 * The record as the settings carry it: the character's GUID counter × 16 plus the mask of talent
 * groups moved. The settings' `localStorage` mirror is one per browser, so a value another character
 * left there names that character and reads as nothing here.
 */
export function encodeLayoutRecord(guidCounter: number, mask: number): number {
  return guidCounter * 16 + (mask & 0x0f);
}

export function decodeLayoutRecord(value: number, guidCounter: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || guidCounter <= 0) return 0;
  return Math.floor(value / 16) === guidCounter ? value % 16 : 0;
}

/** How a per-character settings slot reads: nothing stored, this client's JSON, or another client's text. */
export type ConfigSlotKind = "empty" | "own" | "foreign";

export function classifyConfigSlot(text: string | undefined, parses: (text: string) => boolean): ConfigSlotKind {
  if (text === undefined || text === "") return "empty";
  return parses(text) ? "own" : "foreign";
}

/** The four rows as the toggles byte's bits: bottom left 0x01, bottom right 0x02, right 0x04, right two 0x08. */
export function extraBarBits(shown: (bar: ExtraActionBar) => boolean): number {
  let bits = 0;
  EXTRA_ACTION_BARS.forEach((bar, index) => {
    if (shown(bar.id)) bits |= 1 << index;
  });
  return bits;
}

/** Whether one row is on in a toggles byte. */
export function extraBarBit(bits: number, bar: ExtraActionBar): boolean {
  const index = EXTRA_ACTION_BARS.findIndex((entry) => entry.id === bar);
  return index >= 0 && (bits & (1 << index)) !== 0;
}

/**
 * Whether the paging keys may show a main page: stock `VIEWABLE_ACTION_BAR_PAGES` takes a page out
 * while the multi-bar showing it is up (MultiActionBars.lua:24-55), so `ActionBar_PageUp`/`PageDown`
 * never put the same twelve buttons on the main bar and on a multi-bar at once.
 */
export function mainPageViewable(page0: number, shown: (bar: ExtraActionBar) => boolean): boolean {
  return !EXTRA_ACTION_BARS.some((bar) => actionPage(bar.base) === page0 && shown(bar.id));
}

/**
 * `ActionBar_PageUp` / `ActionBar_PageDown` (ActionButton.lua:45-78) over 0-based pages: the next
 * viewable page up, or page 1; the next viewable page down, or the highest viewable one. Page 1 is no
 * multi-bar's page, so the walk always ends.
 */
export function stockPageStep(current0: number, delta: 1 | -1, viewable: (page0: number) => boolean): number {
  const pages = ACTIONBAR_MAIN_PAGES;
  const page = Number.isInteger(current0) && current0 >= 0 && current0 < pages ? current0 : 0;
  if (delta > 0) {
    for (let next = page + 1; next < pages; next++) if (viewable(next)) return next;
    return 0;
  }
  for (let next = page - 1; next >= 0; next--) if (viewable(next)) return next;
  for (let next = pages - 1; next >= 0; next--) if (viewable(next)) return next;
  return 0;
}
