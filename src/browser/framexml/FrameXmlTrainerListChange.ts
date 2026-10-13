/**
 * 3.29 (13.10): what one `WorldClient.onTrainerChanged` means for the stock trainer list — a new list, a
 * state change, or nothing — so the collapse and the line filter go only where Wow.exe 3.3.5a 12340 drops
 * them.
 *
 * Wow.exe: only a new list (SMSG_TRAINER_LIST for the open trainer, 0x006d12c0 → 0x00596450) expands every
 * line and turns every line on again. A purchase does not ask for a list: TrinityCore answers
 * CMSG_TRAINER_BUY_SPELL with SMSG_TRAINER_BUY_SUCCEEDED or _FAILED alone (Trainer::TeachSpell,
 * Trainer.cpp:110-148), and the learned spell reaches the window through the player's field update, which
 * counts the states again and sorts the array as it stands (0x006e7f50 → 0x00596b00 → 0x00594ba0), the
 * collapse mask (0x00c0e4b0) and the line mask (0x00c0e4ac) untouched.
 *
 * WorldClient (not this lane's file) learns the new states differently: after SMSG_TRAINER_BUY_SUCCEEDED it
 * asks the same trainer's list again and sets a non-error interaction message (WorldClient.ts, the
 * TRAINER_BUY_SUCCEEDED handler), and that list arrives as a new object. So: a callback with the same list
 * object is the purchase's answer and changes no list; the next list of the same trainer after a successful
 * purchase is that refresh — the client's state change; any other list (another trainer, a new talk to the
 * same one) is a new list. Before 13.10 every callback, the answers included, reset the collapse and the
 * line filter.
 */

export type FrameXmlTrainerListChange = "list" | "state" | "none";

/** The parts of WorldClient this reads. */
export interface FrameXmlTrainerListChangeWorld {
  readonly trainer?: { readonly guid: bigint } | undefined;
  readonly merchantMessage?: { readonly error: boolean } | undefined;
}

export class FrameXmlTrainerListChanges {
  #seen: object | undefined;
  #seenGuid: bigint | undefined;
  /** The trainer whose list WorldClient asked again after a successful purchase. */
  #refreshGuid: bigint | undefined;

  classify(world: FrameXmlTrainerListChangeWorld): FrameXmlTrainerListChange {
    const trainer = world.trainer;
    if (trainer === undefined) {
      const had = this.#seen !== undefined;
      this.#seen = undefined;
      this.#seenGuid = undefined;
      this.#refreshGuid = undefined;
      return had ? "list" : "none";
    }
    if (trainer === this.#seen) {
      // SMSG_TRAINER_BUY_SUCCEEDED / _FAILED for the open list; only a success asks the list again.
      if (world.merchantMessage?.error === false) this.#refreshGuid = trainer.guid;
      return "none";
    }
    const refresh = this.#seen !== undefined && this.#seenGuid === trainer.guid && this.#refreshGuid === trainer.guid;
    this.#seen = trainer;
    this.#seenGuid = trainer.guid;
    this.#refreshGuid = undefined;
    return refresh ? "state" : "list";
  }
}
