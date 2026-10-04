/**
 * L7 4.14: the time in the dungeon finder's queue between two `SMSG_LFG_QUEUE_STATUS` packets.
 *
 * The packet says how long the player has already waited (`queuedTime`, whole seconds,
 * LFGHandler.cpp:464-474; the core resends it on its queue timer). Stock does not wait for the next
 * one: `GetLFGQueueStats` hands out the moment of joining on the GetTime clock and
 * `LFDSearchStatus_OnUpdate` writes `GetTime() - queuedTime` every frame (LFDFrame.lua:1132-1151).
 * The same here: a packet's count, stamped when this status object was first seen, plus the time
 * since — so the line moves every second and a fresh packet corrects it.
 */
export class LfgQueueClock {
  #status: object | undefined;
  #stampedAt = 0;

  /** Seconds in the queue at `now` (milliseconds on a monotonic clock). */
  elapsed(status: { readonly queuedSeconds: number }, now: number): number {
    if (status !== this.#status) {
      this.#status = status;
      this.#stampedAt = now;
    }
    return Math.max(0, status.queuedSeconds) + Math.max(0, now - this.#stampedAt) / 1000;
  }
}
