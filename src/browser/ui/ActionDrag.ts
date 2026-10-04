/**
 * What a drag onto an action bar carries (WORK_PLAN 4.05): one format, the builders every source
 * uses, and the one strict reader the bars use.
 *
 * DOM-free and free of the bar itself, so a window that offers something for the bar — the spell
 * book, the bags, the macro window — does not have to import `ActionBar.ts` (which imports the
 * macro window back).
 *
 * The type byte is the server's `ActionButtonType` (TrinityCore Player.h:195-198, our
 * `ActionBarProtocol.ts`): spell 0x00, equipment set 0x20, macro 0x40, client macro 0x41, item
 * 0x80; the action is the spell, set, macro index or item entry, below 0x01000000
 * (`MAX_ACTION_BUTTON_ACTION_VALUE`). `from` is the bar slot a slot-to-slot drag left (0..143).
 */

import {
  ACTION_BUTTONS, ACTION_BUTTON_EQUIPMENT_SET, ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL,
} from "../../world/ActionBarProtocol.js";

export const ACTION_DRAG_FORMAT = "application/x-webclient-action";

/** ACTION_BUTTON_CMACRO (Player.h:197): the server keeps it as it is. */
const ACTION_BUTTON_CMACRO = 0x41;
const ACTION_TYPES: ReadonlySet<number> = new Set([
  ACTION_BUTTON_SPELL, ACTION_BUTTON_EQUIPMENT_SET, ACTION_BUTTON_MACRO, ACTION_BUTTON_CMACRO, ACTION_BUTTON_ITEM,
]);
/** MAX_ACTION_BUTTON_ACTION_VALUE (Player.h): the action shares a u32 with the type byte. */
const MAX_ACTION_VALUE = 0x01000000;

export interface ActionDrop {
  readonly action: number;
  readonly type: number;
  readonly from?: number;
}

function payload(action: number, type: number): [string, string] {
  return [ACTION_DRAG_FORMAT, JSON.stringify({ action, type })];
}

/** A spell out of the book. */
export function spellDragPayload(spellId: number): [string, string] {
  return payload(spellId, ACTION_BUTTON_SPELL);
}

/** An item out of a bag: the bar stores its entry, so the slot survives the item moving. */
export function itemActionDragPayload(entry: number): [string, string] {
  return payload(entry, ACTION_BUTTON_ITEM);
}

/** A macro out of the macro window, by its slot index (account and character share one numbering). */
export function macroActionDragPayload(index: number): [string, string] {
  return payload(index, ACTION_BUTTON_MACRO);
}

/** A slot-to-slot drag's payload: what the slot holds and where it was. */
export function slotDragPayload(content: { readonly action: number; readonly type: number }, from: number): [string, string] {
  return [ACTION_DRAG_FORMAT, JSON.stringify({ action: content.action, type: content.type, from })];
}

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/**
 * The drop, or undefined for anything that is not one: text that is not JSON, a value that is not
 * an object, a non-positive or oversized action, a type the server does not know, a `from` that
 * is not a bar slot. Another page's text dropped on a bar used to throw out of the handler.
 */
export function parseActionDrop(raw: string | undefined | null): ActionDrop | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { action, type, from } = value as Record<string, unknown>;
  if (!isWhole(action) || action <= 0 || action >= MAX_ACTION_VALUE) return undefined;
  if (!isWhole(type) || !ACTION_TYPES.has(type)) return undefined;
  if (from === undefined) return { action, type };
  if (!isWhole(from) || from < 0 || from >= ACTION_BUTTONS) return undefined;
  return { action, type, from };
}
