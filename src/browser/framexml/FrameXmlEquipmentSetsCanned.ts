/**
 * The offline equipment-set fixture for the canned world: one saved set over the canned paper doll —
 * its worn piece, a piece in the backpack, a piece the character no longer has and an ignored slot —
 * and a realm stand-in that folds a save in and names a guid the way SMSG_EQUIPMENT_SET_SAVED does,
 * answers a use when a test says (`answerUse`), and drops a deleted set, so the stock GearManagerDialog
 * can be driven with no server.
 */
import {
  FRAMEXML_EQUIPMENT_SET_SLOTS, FrameXmlEquipmentSetModel, type FrameXmlEquipmentSetLocated,
  type FrameXmlEquipmentSetRow, type FrameXmlEquipmentSetUsePiece,
} from "./FrameXmlEquipmentSets.js";

/** The worn piece's guid is its paper-doll slot above this; the canned fixture has no item objects. */
export const CANNED_WORN_GUID_BASE = 0x1e00n;
/** In the backpack's third slot (stock bag 0, slot 3; the item opcodes' bag 255, slot 25). */
export const CANNED_CARRIED_PIECE = Object.freeze({ guid: 0x1e20n, entry: 2092, bagId: 0, slot: 3, bag: 255, opcodeSlot: 25 });
/** Sold, mailed, gone: the set still names it. */
export const CANNED_MISSING_PIECE_GUID = 0x1e30n;
/** The guid the stand-in realm gives a new set: SMSG_EQUIPMENT_SET_SAVED's, by index. */
export const CANNED_SET_GUID_BASE = 0xa000n;

function cannedSet(): FrameXmlEquipmentSetRow {
  const pieces = new Array<bigint>(FRAMEXML_EQUIPMENT_SET_SLOTS).fill(0n);
  pieces[0] = CANNED_WORN_GUID_BASE + 1n;
  pieces[15] = CANNED_CARRIED_PIECE.guid;
  pieces[16] = CANNED_MISSING_PIECE_GUID;
  pieces[18] = 1n;
  return { guid: CANNED_SET_GUID_BASE, setId: 0, name: "Бой", icon: "Interface\\Icons\\INV_Sword_04", pieces };
}

export type CannedFrameXmlEquipmentSetPacket =
  | readonly ["save", bigint, number, string, string, readonly bigint[]]
  | readonly ["use", readonly FrameXmlEquipmentSetUsePiece[]]
  | readonly ["delete", bigint];

export interface CannedFrameXmlEquipmentSetWorld {
  /** Every packet the stand-in realm was asked, in order. */
  readonly sent: readonly CannedFrameXmlEquipmentSetPacket[];
  /** The sets as the realm holds them. */
  sets(): readonly FrameXmlEquipmentSetRow[];
  /** The SMSG_EQUIPMENT_SET_USE_RESULT for the last use: true for 0, false for «inventory full». */
  answerUse(success: boolean): boolean;
}

export interface CannedFrameXmlEquipmentSetHost {
  /** The canned paper doll's worn item entry and texture by 1-based slot. */
  wornEntry(slot: number): number | undefined;
  wornTexture(slot: number): string | undefined;
  macroIcon(index: number): string | undefined;
  macroIconCount(): number;
}

export interface CannedFrameXmlEquipmentSets {
  readonly model: FrameXmlEquipmentSetModel;
  readonly world: CannedFrameXmlEquipmentSetWorld;
}

export function createCannedFrameXmlEquipmentSets(host: CannedFrameXmlEquipmentSetHost): CannedFrameXmlEquipmentSets {
  let sets: FrameXmlEquipmentSetRow[] = [cannedSet()];
  const sent: CannedFrameXmlEquipmentSetPacket[] = [];
  let pending: ((success: boolean) => void) | undefined;
  const wornGuid = (slot: number): bigint =>
    (slot >= 1 && slot <= FRAMEXML_EQUIPMENT_SET_SLOTS && host.wornEntry(slot) !== undefined ? CANNED_WORN_GUID_BASE + BigInt(slot) : 0n);
  const locate = (guid: bigint): FrameXmlEquipmentSetLocated | undefined => {
    if (guid > CANNED_WORN_GUID_BASE && guid <= CANNED_WORN_GUID_BASE + BigInt(FRAMEXML_EQUIPMENT_SET_SLOTS)) {
      const slot = Number(guid - CANNED_WORN_GUID_BASE);
      return wornGuid(slot) === guid ? { place: { kind: "worn", slot }, bag: 255, slot: slot - 1 } : undefined;
    }
    if (guid === CANNED_CARRIED_PIECE.guid) {
      return {
        place: { kind: "bag", bagId: CANNED_CARRIED_PIECE.bagId, slot: CANNED_CARRIED_PIECE.slot },
        bag: CANNED_CARRIED_PIECE.bag, slot: CANNED_CARRIED_PIECE.opcodeSlot,
      };
    }
    return undefined;
  };
  const model = new FrameXmlEquipmentSetModel({
    sets: () => sets,
    locate,
    itemId: (guid) => {
      const located = locate(guid);
      if (!located) return undefined;
      return located.place.kind === "worn" ? host.wornEntry(located.place.slot) : CANNED_CARRIED_PIECE.entry;
    },
    wornGuid,
    wornTexture: (slot) => host.wornTexture(slot),
    macroIcon: (index) => host.macroIcon(index),
    macroIconCount: () => host.macroIconCount(),
    save: (setGuid, index, name, icon, pieces) => {
      sent.push(["save", setGuid, index, name, icon, pieces]);
      // WorldClient.saveEquipmentSet folds the set in at once; the realm then names a new one's guid.
      const guid = setGuid === 0n ? CANNED_SET_GUID_BASE + BigInt(index) : setGuid;
      const saved: FrameXmlEquipmentSetRow = { guid, setId: index, name, icon, pieces: [...pieces] };
      const existing = sets.findIndex((set) => set.setId === index);
      sets = existing < 0 ? [...sets, saved] : sets.map((set, at) => (at === existing ? saved : set));
    },
    use: (pieces, finished) => {
      sent.push(["use", pieces]);
      pending = finished;
    },
    remove: (setGuid) => {
      sent.push(["delete", setGuid]);
      sets = sets.filter((set) => set.guid !== setGuid);
    },
  });
  return {
    model,
    world: {
      sent,
      sets: () => sets,
      answerUse: (success) => {
        const finished = pending;
        pending = undefined;
        if (!finished) return false;
        finished(success);
        return true;
      },
    },
  };
}
