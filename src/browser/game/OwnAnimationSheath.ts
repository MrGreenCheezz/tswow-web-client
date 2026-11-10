/**
 * 5.05 (11.11): the page's half of Wow.exe's animation-driven sheath (world/AnimationSheathRule.ts, 0x007385c0 →
 * 0x00738180). The renderer — in the page or in the render worker — counts the non-kit animation starts of the active
 * player's model and publishes them with the animation it plays (RenderResults.ts `ownAnimation`); after every draw
 * this hands each new count to the world client, which judges it against the game state the page holds (the held
 * sheath, the swing, the cast bar) and sends CMSG_SET_SHEATHED on a change. One judgement per draw that moved the
 * count: starts within one frame end on that frame's animation.
 */
import type { OwnAnimationResult } from "../RenderResults.js";

export interface OwnAnimationWorld {
  readonly state: { readonly selfGuid?: bigint | undefined };
  ownAnimationStarted(animation: number): void;
}

export class OwnAnimationSheath {
  #guid: bigint | undefined;
  #starts = 0;

  /** After a draw: judge again when the active player's model started something since the last call. */
  afterDraw(world: OwnAnimationWorld | undefined, own: OwnAnimationResult | undefined): void {
    if (world === undefined || own === undefined || own.guid !== world.state.selfGuid) return;
    if (own.guid !== this.#guid) {
      // A new character (or the first draw): its count is where it stands, nothing to judge yet.
      this.#guid = own.guid;
      this.#starts = own.starts;
      return;
    }
    if (own.starts === this.#starts) return;
    this.#starts = own.starts;
    world.ownAnimationStarted(own.animation);
  }
}
