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
 * Where each native bar starts in the server's 144 slots.
 *
 * The first six pages are the main bar: the paging keys walk them. The native extra rows stand on
 * pages 7–10 (slots 72, 84, 96, 108) — which are not free: stock uses exactly those pages for the
 * bonus bars of stances, forms and stealth (`bonusActionPage` below), and puts its own multi-bars on
 * main pages 6, 5, 3 and 4 instead (`stockBase` below). Moving the native rows onto the stock pages,
 * together with the buttons players already placed there, is WORK_PLAN 4.16 (b, an owner's decision).
 */
export const ACTION_BAR_BASES = {
  main: 0,
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
 * Under the stock HUD a key presses that slot, the one its button shows (WORK_PLAN 4.16a).
 */
export const EXTRA_ACTION_BARS: ReadonlyArray<{ id: ExtraActionBar; base: number; stockBase: number; label: string }> = [
  { id: "bottomLeft", base: ACTION_BAR_BASES.bottomLeft, stockBase: 60, label: "Нижняя левая" },
  { id: "bottomRight", base: ACTION_BAR_BASES.bottomRight, stockBase: 48, label: "Нижняя правая" },
  { id: "right", base: ACTION_BAR_BASES.right, stockBase: 24, label: "Правая" },
  { id: "right2", base: ACTION_BAR_BASES.right2, stockBase: 36, label: "Правая вторая" },
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
