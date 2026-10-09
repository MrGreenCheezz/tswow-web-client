/**
 * 6.11б (line A7a, slice H, 05.10): the copied look of a mirror image, a TSWoW outfit NPC
 * (`CreatureOutfit`) or an NPCBot.
 *
 * A unit carrying UNIT_FLAG2_MIRROR_IMAGE (0x10 in UNIT_FIELD_FLAGS_2) wears a character model whose
 * look is not in any display record; the client asks for it with CMSG_GET_MIRRORIMAGE_DATA (0x401,
 * the unit's u64 guid) and TrinityCore answers SMSG_MIRRORIMAGE_DATA (0x402,
 * `WorldSession::HandleMirrorImageDataRequest`, SpellHandler.cpp:607-800; parsed by
 * `SpellLogProtocol.parseMirrorImageData`). The flag is set by `SPELL_AURA_CLONE_CASTER`
 * (SpellAuraEffects.cpp:2178-2200, together with the caster's display id), by
 * `Creature::SetDisplayId` for an outfit (Creature.cpp:3462-3494) and by NPCBots.
 *
 * Every branch of the reply carries the unit's current display id (the caster's, the outfit's, the
 * bot's), and an outfit change goes through the invisible model 11686 (Creature.cpp:376) with the flag
 * dropped and raised again — so a reply is only worn while the unit still shows that display, and a
 * flagged unit whose display has no reply is asked about. One question per guid and display, again
 * after MIRROR_IMAGE_RETRY_MS without an answer, at most MIRROR_IMAGE_TRIES times (the core answers
 * nothing for a unit that is neither an outfit, a bot nor a clone, SpellHandler.cpp:722-728).
 * When and how often Wow.exe asks was not traced.
 *
 * Per-frame cost: `get` is one flag test for an ordinary unit; for a flagged one, two map lookups.
 */
import type { EquippedItem } from "../gateway/CharacterAppearance.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import type { MirrorImageData } from "./SpellLogProtocol.js";

export const UNIT_FLAG2_MIRROR_IMAGE = 0x10;
export const MIRROR_IMAGE_RETRY_MS = 5_000;
export const MIRROR_IMAGE_TRIES = 3;

export function buildGetMirrorImageData(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/**
 * The reply's eleven words as worn items. The order is CreatureOutfit.h's (and the player branch's):
 * HEAD, SHOULDERS, BODY, CHEST, WAIST, LEGS, FEET, WRISTS, HANDS, BACK, TABARD — the last two the
 * other way round from `CreatureDisplayInfoExtra.NPCItemDisplay`. Inventory types are the ones the
 * gateway gives an NPC's worn slots (`CharacterAppearance.NPC_ITEM_INVENTORY_TYPES`); a zero word —
 * nothing there, or a helm or cloak the player hides — is dropped.
 */
const MIRROR_SLOTS: readonly (readonly [slot: number, inventoryType: number])[] = [
  [0, 1], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [14, 16], [18, 19],
];

export function mirrorImageEquipment(displayIds: readonly number[]): EquippedItem[] {
  const worn: EquippedItem[] = [];
  MIRROR_SLOTS.forEach(([slot, inventoryType], index) => {
    const displayId = displayIds[index] ?? 0;
    if (displayId > 0) worn.push({ slot, inventoryType, displayId });
  });
  return worn;
}

interface Asked {
  displayId: number;
  at: number;
  tries: number;
}

/** The replies by guid, and the questions still out; a unit's go with it (`forget`, WorldClient). */
export class MirrorImages {
  readonly #send: (guid: bigint) => void;
  readonly #now: () => number;
  readonly #replies = new Map<bigint, MirrorImageData>();
  readonly #asked = new Map<bigint, Asked>();
  /** Moves whenever a reply lands, for callers that memoise on it. */
  generation = 0;

  constructor(send: (guid: bigint) => void, now: () => number) {
    this.#send = send;
    this.#now = now;
  }

  /** The look to wear for a unit showing `displayId` with these UNIT_FIELD_FLAGS_2, asking when needed. */
  get(guid: bigint, displayId: number, flags2: number): MirrorImageData | undefined {
    if ((flags2 & UNIT_FLAG2_MIRROR_IMAGE) === 0) return undefined;
    const reply = this.#replies.get(guid);
    if (reply && reply.displayId === displayId) return reply;
    this.#ask(guid, displayId);
    return undefined;
  }

  /** Whether a question for this unit and display is still worth waiting for. */
  awaiting(guid: bigint, displayId: number): boolean {
    const asked = this.#asked.get(guid);
    return asked !== undefined && asked.displayId === displayId
      && (asked.tries < MIRROR_IMAGE_TRIES || this.#now() - asked.at < MIRROR_IMAGE_RETRY_MS);
  }

  receive(data: MirrorImageData): void {
    this.#replies.set(data.guid, data);
    this.#asked.delete(data.guid);
    this.generation++;
  }

  /**
   * 05.10 review H: the unit left this client (destroyed, out of range, another map). A re-created
   * unit is asked about again, as a fresh object — an NPCBot re-equipped meanwhile shows the new gear
   * — and the map does not grow with every unit ever seen. (Wow.exe's own caching not traced.)
   */
  forget(guid: bigint): void {
    this.#replies.delete(guid);
    this.#asked.delete(guid);
  }

  clear(): void {
    this.#replies.clear();
    this.#asked.clear();
    this.generation++;
  }

  #ask(guid: bigint, displayId: number): void {
    const now = this.#now();
    let asked = this.#asked.get(guid);
    if (asked && asked.displayId === displayId) {
      if (asked.tries >= MIRROR_IMAGE_TRIES || now - asked.at < MIRROR_IMAGE_RETRY_MS) return;
      asked.tries++;
      asked.at = now;
    } else {
      asked = { displayId, at: now, tries: 1 };
      this.#asked.set(guid, asked);
    }
    this.#send(guid);
  }
}
