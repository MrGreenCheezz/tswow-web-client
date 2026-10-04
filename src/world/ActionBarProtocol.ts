import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

/**
 * The action bars: what the player put in which slot, kept on the server.
 *
 * 144 slots, twelve pages of twelve, sent as one array of packed words — `Player::SendActionButtons`
 * writes every slot including the empty ones, so the array's index is the slot number and there is
 * no id to match on.
 */
export const ACTION_BUTTONS = 144;
export const ACTION_BUTTONS_PER_PAGE = 12;

/** `ActionButtonType`, from the core's own enum. */
export const ACTION_BUTTON_SPELL = 0x00;
export const ACTION_BUTTON_EQUIPMENT_SET = 0x20;
export const ACTION_BUTTON_MACRO = 0x40;
export const ACTION_BUTTON_ITEM = 0x80;

/**
 * `state` on the packet: 0 and 1 both carry buttons — the core sends 1 because 0 gave the original
 * client trouble — and 2 means "clear the bars", sent during a specialisation swap before the new
 * buttons arrive.
 */
export const ACTION_BUTTON_STATE_CLEAR = 2;

export interface ActionButton {
  slot: number;
  /** Spell id, item id, macro id or equipment set id, depending on `type`. */
  action: number;
  type: number;
}

export interface ActionButtons {
  state: number;
  /** Only the slots that hold something; an empty slot is absent rather than zero. */
  buttons: ActionButton[];
}

export function parseActionButtons(payload: Uint8Array): ActionButtons {
  const reader = new PacketReader(payload);
  const state = reader.u8();
  if (state === ACTION_BUTTON_STATE_CLEAR) {
    reader.assertFinished();
    return { state, buttons: [] };
  }

  const buttons: ActionButton[] = [];
  for (let slot = 0; slot < ACTION_BUTTONS; slot++) {
    const packed = reader.u32();
    if (packed === 0) continue;
    // The action is the low 24 bits and the type the high 8: ACTION_BUTTON_ACTION and
    // ACTION_BUTTON_TYPE in the core.
    buttons.push({ slot, action: packed & 0x00ff_ffff, type: (packed >>> 24) & 0xff });
  }
  reader.assertFinished();
  return { state, buttons };
}

/** `CMSG_SET_ACTION_BUTTON`. A packed word of zero is how a slot is emptied. */
export function buildSetActionButton(slot: number, action: number, type: number): Uint8Array {
  if (slot < 0 || slot >= ACTION_BUTTONS) throw new RangeError(`Action slot ${slot} is out of range`);
  if (action < 0 || action > 0x00ff_ffff) throw new RangeError(`Action ${action} does not fit in 24 bits`);
  return new PacketWriter().u8(slot).u32(action === 0 ? 0 : ((type & 0xff) << 24) | action).toUint8Array();
}

/**
 * `CMSG_SET_ACTIONBAR_TOGGLES`: one byte, bit `i` set when extra bar `i + 1` is shown — bottom
 * left 0x01, bottom right 0x02, right 0x04, right two 0x08 (Wow.exe 0x5a8290, the Lua
 * `SetActionBarToggles`, packs its first four arguments this way). The core stores the byte as is in
 * `PLAYER_FIELD_BYTES` byte 2 (`HandleSetActionBarToggles`, MiscHandler.cpp:1018-1031).
 */
export function buildSetActionBarToggles(bars: number): Uint8Array {
  return new PacketWriter().u8(bars & 0x0f).toUint8Array();
}

/**
 * Where each native bar starts in the server's 144 slots.
 *
 * The first six pages are the main bar: the paging keys walk them. The four extra rows stand where
 * stock's multi-bars do — main pages 6, 5, 3 and 4 (MultiActionBars.xml:41, 159, 277, 395;
 * ActionButton.lua:6-9) — so a button placed in either interface is on the same slot in the other
 * (L7 4.16b). Pages 7–10 belong to the bonus bars of stances, forms and stealth (`bonusActionPage`
 * below); the native rows stood there until 4.16b (`LEGACY_EXTRA_BAR_BASES`).
 */
export const ACTION_BAR_BASES = {
  main: 0,
  bottomLeft: 60,
  bottomRight: 48,
  right: 24,
  right2: 36,
} as const;

/**
 * L7 4.16b: where the native extra rows stood before they moved to the stock pages — the bonus pages
 * 7–10. Read only by the one-time migration (browser/ui/ActionBarStockLayout.ts), which copies what a
 * player placed on a shown row there to the row's stock slot when that slot is empty.
 */
export const LEGACY_EXTRA_BAR_BASES = {
  bottomLeft: 72,
  bottomRight: 84,
  right: 96,
  right2: 108,
} as const;

export type ExtraActionBar = "bottomLeft" | "bottomRight" | "right" | "right2";

/**
 * The four in the order the original client stacks them, with the setting that shows each.
 *
 * `stockBase` is where the stock multi-bar answering to the same keys starts: MULTIACTIONBAR1..4
 * press MultiBarBottomLeft, MultiBarBottomRight, MultiBarRight and MultiBarLeft (Bindings.xml:875,
 * :959, :1043, :1127), which show pages 6, 5, 3 and 4 (ActionButton.lua:6-9, MultiActionBars.xml).
 * Under the stock HUD a key presses that slot, the one its button shows (WORK_PLAN 4.16a). Since
 * L7 4.16b the native row stands there too (`base` equals `stockBase`); `legacyBase` is its old page.
 */
export const EXTRA_ACTION_BARS: ReadonlyArray<{
  id: ExtraActionBar; base: number; stockBase: number; legacyBase: number; label: string;
}> = [
  { id: "bottomLeft", base: ACTION_BAR_BASES.bottomLeft, stockBase: 60, legacyBase: LEGACY_EXTRA_BAR_BASES.bottomLeft, label: "Нижняя левая" },
  { id: "bottomRight", base: ACTION_BAR_BASES.bottomRight, stockBase: 48, legacyBase: LEGACY_EXTRA_BAR_BASES.bottomRight, label: "Нижняя правая" },
  { id: "right", base: ACTION_BAR_BASES.right, stockBase: 24, legacyBase: LEGACY_EXTRA_BAR_BASES.right, label: "Правая" },
  { id: "right2", base: ACTION_BAR_BASES.right2, stockBase: 36, legacyBase: LEGACY_EXTRA_BAR_BASES.right2, label: "Правая вторая" },
];

/** Which page a slot belongs to, and where on that page it sits. */
export const actionPage = (slot: number): number => Math.floor(slot / ACTION_BUTTONS_PER_PAGE);
export const actionColumn = (slot: number): number => slot % ACTION_BUTTONS_PER_PAGE;
export const actionSlot = (page: number, column: number): number => page * ACTION_BUTTONS_PER_PAGE + column;

/**
 * The main bar's pages, `NUM_ACTIONBAR_PAGES` (FrameXML/ActionButton.lua:2): what the paging keys
 * walk. The pages after them are the ones a stance, a form or stealth puts on the main bar.
 */
export const ACTIONBAR_MAIN_PAGES = 6;

/**
 * The 0-based page the main bar's twelve buttons — and keys 1 to = — use.
 *
 * Stock `ActionButton_CalculateAction` (ActionButton.lua:131-153) gives a bonus button the 1-based
 * page `NUM_ACTIONBAR_PAGES + GetBonusBarOffset()`, and only while `GetActionBarPage()` is 1: on pages
 * 2–6 the stance bar is ignored. Offset n on the first page is therefore 0-based page 5 + n, capped at
 * the last of the twelve pages the server keeps. Stock's fallback to `BonusActionBarFrame.lastBonusBar`
 * at offset 0 only covers the bar's 0.15 s hide animation and is not carried over.
 */
export function bonusActionPage(mainPage0: number, offset: number): number {
  return mainPage0 === 0 && offset > 0
    ? Math.min(ACTIONBAR_MAIN_PAGES - 1 + offset, ACTION_BUTTONS / ACTION_BUTTONS_PER_PAGE - 1)
    : mainPage0;
}
