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

/** Which page a slot belongs to, and where on that page it sits. */
/**
 * Where each bar starts in the server's 144 slots.
 *
 * The first six pages are the main bar — that is what the paging keys walk — and the four after
 * them are separate bars that the original client shows all at once, each with its own row of
 * keys. They are not pages of anything: slot 72 is the first button of the bottom-left bar
 * whatever page the main bar happens to be on.
 */
export const ACTION_BAR_BASES = {
  main: 0,
  bottomLeft: 72,
  bottomRight: 84,
  right: 96,
  right2: 108,
} as const;

export type ExtraActionBar = "bottomLeft" | "bottomRight" | "right" | "right2";

/** The four in the order the original client stacks them, with the setting that shows each. */
export const EXTRA_ACTION_BARS: ReadonlyArray<{ id: ExtraActionBar; base: number; label: string }> = [
  { id: "bottomLeft", base: ACTION_BAR_BASES.bottomLeft, label: "Нижняя левая" },
  { id: "bottomRight", base: ACTION_BAR_BASES.bottomRight, label: "Нижняя правая" },
  { id: "right", base: ACTION_BAR_BASES.right, label: "Правая" },
  { id: "right2", base: ACTION_BAR_BASES.right2, label: "Правая вторая" },
];

export const actionPage = (slot: number): number => Math.floor(slot / ACTION_BUTTONS_PER_PAGE);
export const actionColumn = (slot: number): number => slot % ACTION_BUTTONS_PER_PAGE;
export const actionSlot = (page: number, column: number): number => page * ACTION_BUTTONS_PER_PAGE + column;
