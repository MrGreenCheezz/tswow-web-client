/**
 * How the world loop shares the main thread with the frame.
 *
 * The gateway forwards each TCP read of the worldserver socket as one WebSocket message, up to
 * 64 KB of packets, and `WebSocketByteStream.readExactly` answers from its buffer without waiting
 * whenever the bytes are already there. An `await` on a promise that is already settled is a
 * microtask, never a turn of the event loop — so a burst (a crowd coming into view, a city's worth
 * of movement relays and aura updates) used to be read and dispatched packet after packet inside
 * the one task that delivered the message, and the frame could not run until all of it was done.
 *
 * `PacketSlice` measures how long the loop has been working without giving the thread back, and
 * `yieldToEventLoop` gives it back: a macrotask, so the browser can draw a frame and answer input
 * before the loop reads its next packet. Nothing is reordered and nothing is dropped — the loop is
 * the socket's only reader, it simply waits before reading on, and everything that arrives in the
 * meantime stays in the stream's buffer behind the packets it has not read yet.
 */

/**
 * Continuous packet work allowed before the loop hands the thread back, in milliseconds.
 *
 * A quarter of a 60 Hz frame: enough that an ordinary message is handled in one go, small enough
 * that a burst no longer holds a frame hostage.
 */
export const PACKET_SLICE_MS = 4;

/**
 * A read that took at least this long waited for the network.
 *
 * Reading from the buffer is three settled promises and takes microseconds; a read that had to
 * wait for the next WebSocket message returned in a later task, so whatever ran before it was a
 * different slice and the budget starts again from there.
 */
export const PACKET_READ_WAIT_MS = 1;

interface YieldingScheduler {
  yield(): Promise<void>;
}

/**
 * One macrotask's pause, by the cheapest honest route the host has.
 *
 * `scheduler.yield()` (Chromium, and so the Electron build) resumes ahead of ordinary queued tasks
 * but after the frame and input the browser owes. A `MessageChannel` message is an ordinary task
 * with none of `setTimeout`'s nesting clamp. `setImmediate` is Node's own, which is where the tests
 * run; `setTimeout` is the last resort.
 */
export function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: Partial<YieldingScheduler> }).scheduler;
  if (scheduler && typeof scheduler.yield === "function") return scheduler.yield();
  const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown }).setImmediate;
  if (typeof immediate === "function") return new Promise((resolve) => { immediate(resolve); });
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
  }
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

export interface PacketSliceOptions {
  /** Continuous work allowed before `exhausted` says so. */
  readonly budgetMs?: number;
  readonly now?: () => number;
  /** How the thread is given back; the tests count the pauses through this. */
  readonly yieldToEventLoop?: () => Promise<void>;
}

/**
 * The clock of one stretch of packet work.
 *
 * It starts when the loop starts, when a read had to wait for the network, and after every pause.
 * The loop asks `exhausted` between two packets — never inside one, so a handler always runs to its
 * end in the task that started it — and pauses when the answer is yes.
 */
export class PacketSlice {
  readonly #budgetMs: number;
  readonly #now: () => number;
  readonly #yield: () => Promise<void>;
  #startedAt: number;
  #askedAt = 0;

  constructor(options: PacketSliceOptions = {}) {
    this.#budgetMs = options.budgetMs ?? PACKET_SLICE_MS;
    this.#now = options.now ?? (() => performance.now());
    this.#yield = options.yieldToEventLoop ?? yieldToEventLoop;
    this.#startedAt = this.#now();
  }

  /**
   * The two marks around one read, so the slice notices whether it waited.
   *
   * A read answered from the buffer belongs to the running slice; one that returned in a later
   * task began a new one, because the thread was free while the loop slept. Plain calls rather
   * than a wrapper around the read: the loop pays them per packet, and a closure and an extra
   * promise per packet cost more than the two clock reads.
   */
  readStarted(): void {
    this.#askedAt = this.#now();
  }

  readFinished(): void {
    const answeredAt = this.#now();
    if (answeredAt - this.#askedAt >= PACKET_READ_WAIT_MS) this.#startedAt = answeredAt;
  }

  /** True once this slice has used its budget. Asked between packets. */
  get exhausted(): boolean {
    return this.#now() - this.#startedAt >= this.#budgetMs;
  }

  /** Gives the thread back for one macrotask, then starts the next slice. */
  async pause(): Promise<void> {
    await this.#yield();
    this.#startedAt = this.#now();
  }
}

/**
 * The other half of the pump: refreshes that packets asked for, run once at the start of the next
 * frame however many packets asked.
 *
 * A burst of aura updates, name answers or item answers used to repaint the same panels once per
 * packet, inside the packet task, where nobody could see the states in between: the frame after
 * the burst shows only the last one. Queued here, a refresh runs when the render loop drains the
 * world state (`WorldView.drainWorldState`) — before the renderer draws and before the page is
 * painted — so what the player sees, and on which frame, is unchanged; only the repaints nobody
 * saw are gone. A task is queued by identity, so the same function queued twice runs once, in the
 * order it was first queued. Here rather than in the view so that a panel can queue without
 * importing the view and everything it draws.
 */
const frameTasks = new Set<() => void>();

/** Runs `task` once at the start of the next frame, however often it is queued before then. */
export function queueFrameTask(task: () => void): void {
  frameTasks.add(task);
}

/** Called once a frame by the render loop. A task queued while these run waits for the next frame. */
export function runFrameTasks(): void {
  if (frameTasks.size === 0) return;
  const tasks = [...frameTasks];
  frameTasks.clear();
  for (const task of tasks) {
    try {
      task();
    } catch (error) {
      // One panel's failure must not cost the others their refresh, nor the frame its draw.
      console.error("[webclient] a queued refresh failed", error);
    }
  }
}
