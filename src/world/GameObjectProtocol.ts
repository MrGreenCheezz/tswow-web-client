// Doors, levers, chests, ore, herbs, portals, chairs and mailboxes — the half of the world that
// is not a creature.
//
// Nothing here was sent or read before: `CMSG_GAMEOBJ_USE` did not appear anywhere in the client,
// so every one of these was scenery. Two things had to be true before a door could open. The
// object had to be clickable at all, which it was not — the picker scans a list of hit rectangles
// that only units were ever added to. And the client had to know what kind of object it was
// looking at, which needs the template: the update fields carry a display id and a state, not a
// type it can act on.

import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

/**
 * `GameobjectTypes`. Only the ones this client can tell apart usefully are named.
 *
 * The split that matters is which of them `GameObject::Use` handles on the server. A door, a
 * lever, a quest object, a chair, a portal or a flag is used directly. A chest, an ore vein or a
 * herb is not in that switch at all — those are opened by casting a lock-opening spell at them,
 * which needs `Lock.dbc` and is separate work.
 */
export const GO_TYPE_DOOR = 0;
export const GO_TYPE_BUTTON = 1;
export const GO_TYPE_QUESTGIVER = 2;
export const GO_TYPE_CHEST = 3;
export const GO_TYPE_TRAP = 6;
export const GO_TYPE_CHAIR = 7;
export const GO_TYPE_GOOBER = 10;
export const GO_TYPE_TRANSPORT = 11;
export const GO_TYPE_AREADAMAGE = 12;
export const GO_TYPE_CAMERA = 13;
export const GO_TYPE_FISHINGNODE = 17;
export const GO_TYPE_SUMMONING_RITUAL = 18;
export const GO_TYPE_MAILBOX = 19;
export const GO_TYPE_SPELLCASTER = 22;
export const GO_TYPE_MEETINGSTONE = 23;
export const GO_TYPE_FLAGSTAND = 24;
export const GO_TYPE_FISHINGHOLE = 25;
export const GO_TYPE_FLAGDROP = 26;
export const GO_TYPE_BARBER_CHAIR = 32;

/** The types the server's own `GameObject::Use` switch accepts. Everything else it ignores. */
const USABLE_TYPES = new Set([
  GO_TYPE_DOOR, GO_TYPE_BUTTON, GO_TYPE_QUESTGIVER, GO_TYPE_TRAP, GO_TYPE_CHAIR, GO_TYPE_GOOBER,
  GO_TYPE_CAMERA, GO_TYPE_FISHINGNODE, GO_TYPE_SUMMONING_RITUAL, GO_TYPE_SPELLCASTER,
  GO_TYPE_MEETINGSTONE, GO_TYPE_FLAGSTAND, GO_TYPE_FISHINGHOLE, GO_TYPE_FLAGDROP,
  GO_TYPE_BARBER_CHAIR,
]);

export function usableByHand(type: number): boolean {
  return USABLE_TYPES.has(type);
}

/**
 * How close the server insists you are, by type.
 *
 * Not a flat five yards, and the differences are large enough to matter: a fishing bobber is a
 * hundred yards away and an area-damage trigger cannot be used at any distance at all. This is the
 * fallback radius; when an object carries a lock whose key is a spell, the server measures against
 * that spell's range instead, and it uses the display's oriented box rather than a sphere.
 */
export function interactionDistance(type: number): number {
  switch (type) {
    case GO_TYPE_AREADAMAGE: return 0;
    case GO_TYPE_QUESTGIVER: case GO_TYPE_FLAGSTAND: case GO_TYPE_FLAGDROP: return 5.5555553;
    case GO_TYPE_CHAIR: case GO_TYPE_BARBER_CHAIR: return 3;
    case GO_TYPE_FISHINGNODE: return 100;
    case GO_TYPE_FISHINGHOLE: return 20 + CONTACT_DISTANCE;
    case GO_TYPE_MAILBOX: return 10;
    default: return INTERACTION_DISTANCE;
  }
}

const INTERACTION_DISTANCE = 5;
const CONTACT_DISTANCE = 0.5;

/** `GameObjectFlags`, the bits the client is expected to read before offering a click. */
export const GO_FLAG_LOCKED = 0x02;
export const GO_FLAG_INTERACT_COND = 0x04;
export const GO_FLAG_NOT_SELECTABLE = 0x10;

/**
 * Which of the template's data words holds the lock id, by type.
 *
 * It is not the same word for everything: a door and a lever keep it second, a fishing hole keeps
 * it fifth, and everything else that has one keeps it first. A type not listed has no lock.
 */
export function lockIdOf(template: GameObjectTemplate): number {
  const at = template.type === GO_TYPE_DOOR || template.type === GO_TYPE_BUTTON ? 1
    : template.type === GO_TYPE_FISHINGHOLE ? 4
      : LOCKED_TYPES.has(template.type) ? 0
        : -1;
  return at < 0 ? 0 : template.data[at] ?? 0;
}

const LOCKED_TYPES = new Set([
  GO_TYPE_QUESTGIVER, GO_TYPE_CHEST, GO_TYPE_TRAP, GO_TYPE_GOOBER, GO_TYPE_AREADAMAGE,
  GO_TYPE_CAMERA, GO_TYPE_FLAGSTAND, GO_TYPE_FLAGDROP,
]);

/** How many of `gameobject_template`'s twenty-four data words the query response carries. */
const TEMPLATE_DATA = 24;
const QUEST_ITEMS = 6;
/** Set in the id when the server has never heard of the entry; the rest of the packet is absent. */
const UNKNOWN_ENTRY = 0x80000000;

export interface GameObjectTemplate {
  entry: number;
  type: number;
  displayId: number;
  name: string;
  /**
   * A cursor hint, and one specific value is load-bearing: an object whose icon is `Point` is
   * refused by the server before anything else is checked, so it must never be offered.
   */
  iconName: string;
  /** Shown while a cast that opens this object is running — "Collecting", "Herb Gathering". */
  castBarCaption: string;
  data: number[];
  size: number;
}

/** The client asks by entry; the guid rides along and the server only logs it. */
export function buildGameObjectQuery(entry: number, guid: bigint): Uint8Array {
  return new PacketWriter().u32(entry).u64(guid).toUint8Array();
}

/**
 * The template behind one game object.
 *
 * Returns undefined for an entry the server does not know: it answers with the id and bit 31 set
 * and stops, so the packet is four bytes long and there is nothing else to read.
 */
export function parseGameObjectQueryResponse(payload: Uint8Array): GameObjectTemplate | undefined {
  const reader = new PacketReader(payload);
  const raw = reader.u32();
  if ((raw & UNKNOWN_ENTRY) !== 0) {
    reader.assertFinished();
    return undefined;
  }
  const type = reader.u32();
  const displayId = reader.u32();
  const name = reader.cString();
  // Three more names the server always writes empty, then the icon and the cast caption.
  reader.cString();
  reader.cString();
  reader.cString();
  const iconName = reader.cString();
  const castBarCaption = reader.cString();
  reader.cString();
  const data: number[] = [];
  for (let index = 0; index < TEMPLATE_DATA; index++) data.push(reader.u32());
  const size = reader.f32();
  for (let index = 0; index < QUEST_ITEMS; index++) reader.u32();
  reader.assertFinished();
  return { entry: raw, type, displayId, name, iconName, castBarCaption, data, size };
}

/**
 * Uses an object — the packet that did not exist, so no door in the world had ever been opened.
 *
 * The guid is a plain 64-bit value, not a packed one; only spell targets are packed. There is no
 * reply of any kind when the server refuses: an object out of range, not in the world, or marked
 * with the `Point` icon is dropped without a word, so the client has to decide for itself whether
 * the click was worth sending.
 */
export function buildGameObjectUse(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/** Tells the server an object was used, for quest credit. Also silent, and also never sent here. */
export function buildGameObjectReportUse(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export function parseGameObjectCustomAnim(payload: Uint8Array): { guid: bigint; animation: number } {
  const reader = new PacketReader(payload);
  const result = { guid: reader.u64(), animation: reader.u32() };
  reader.assertFinished();
  return result;
}

/**
 * An object playing its disappearing animation.
 *
 * The only warning a mined vein or a picked herb gives that it is going: the destroy update
 * follows later, and until it does the object would otherwise stand there fully drawn.
 */
export function parseGameObjectDespawnAnim(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

/**
 * A goober asking for its page to be opened — a sign, a plaque, a book on a lectern.
 *
 * Only the object's guid: which page it holds is in the template, so the text needs two more
 * round trips, `CMSG_GAMEOBJECT_QUERY` for the page id and then `CMSG_PAGE_TEXT_QUERY` for the
 * text. The core sends this instead of the gossip menu, never as well as it.
 */
export function parseGameObjectPageText(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

/**
 * The fish got away, or there was never one on the line.
 *
 * Both are empty: the opcode is the whole message, and neither names the bobber. `FISH_ESCAPED`
 * comes from the fishing node when the bobber is used too late, `FISH_NOT_HOOKED` when it is used
 * before anything bit.
 */
export function parseFishingFailure(payload: Uint8Array): void {
  new PacketReader(payload).assertFinished();
}

/**
 * A barber's chair opening its window.
 *
 * Empty, and it arrives *before* the stand state that seats the character — the core sends this,
 * then sets `UNIT_STAND_STATE_SIT_LOW_CHAIR + chairheight`. Which matters because
 * `CMSG_ALTER_APPEARANCE` is refused unless the stand state already matches the chair's height, so
 * the window may open a moment before the haircut it offers can be paid for.
 */
export function parseEnableBarberShop(payload: Uint8Array): void {
  new PacketReader(payload).assertFinished();
}
