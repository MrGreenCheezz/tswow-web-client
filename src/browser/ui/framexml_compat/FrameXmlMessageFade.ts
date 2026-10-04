/**
 * The line fade of the client's MessageFrame and ScrollingMessageFrame (WORK_PLAN 3.34).
 *
 * What Wow.exe 3.3.5a (12340) does, read from its CSimpleMessageFrame / CSimpleMessageScrollFrame
 * (notes: .runtime/re-2026-10-03/l334):
 *
 * - Every line carries two countdowns, "still shown" and "fading", started from the frame's
 *   `timeVisible` and `fadeDuration` when the line is added (0x00968210 for MessageFrame, 0x0096a9f0
 *   for ScrollingMessageFrame). The defaults are 10 and 3 seconds (constructor 0x009684f0, floats at
 *   0x00a9fef0/0x00a9fef4); the XML loader (0x00968da0) replaces them only with a value above 0, and
 *   `fade` (default true) and `insertMode` (anything but BOTTOM is TOP) are read beside them.
 * - Each frame update (0x00968a60, 0x00969e60) first counts "shown" down; when it passes 0 the line
 *   fades: its alpha byte is `round(fading / fadeDuration × 255)`, linear, replacing the line's own
 *   alpha; when "fading" passes 0 the line is cleared. A line whose two countdowns are both 0 is
 *   never touched again (it stays). Nothing counts while `SetFading(false)` — the line keeps the
 *   alpha it had — and nothing counts on a hidden frame, which gets no update.
 * - A MessageFrame's `SetTimeVisible` (0x00967db0) restarts "shown" of every line still being shown,
 *   and its `SetFadeDuration` (0x00967e00) restarts "fading" of every line that still has some. A
 *   ScrollingMessageFrame's (0x00969280, 0x009692c0) write the new value into every live line in view:
 *   a fading line given a new "shown" waits at its alpha, then fades on from where it was; a line with
 *   a 0 fade gets the new one (03.10, L5). A fading line given a 0 fade, in either frame, has both
 *   countdowns at 0 and keeps its alpha for good (`heldAlphas`).
 * - A ScrollingMessageFrame counts only while it is scrolled to the bottom, and every scroll call
 *   (`ScrollUp`/`ScrollDown`/`PageUp`/`PageDown`/`ScrollToBottom`, at a boundary too) gives the lines
 *   it shows full alpha and fresh countdowns again (0x00969410, 0x00969370): scrolling the chat brings
 *   faded lines back. Faded lines stay in its history; a MessageFrame's are gone. Only the lines in
 *   view are revived (`frameXmlReviveMessageFades`, with the renderer's measure of the layer).
 *
 * Here the countdowns are deadlines on one clock per frame (`fadeClock`), advanced by the bridge's
 * frame tick only while the frame counts, so a paused or hidden frame costs nothing and a line's
 * state is a comparison. The bridge owns the clock and removes a MessageFrame's cleared lines; the
 * renderer only turns the clock into line opacity, and only for frames with a line still changing.
 */
import type { FrameXmlFrame, FrameXmlMessage, FrameXmlMessageFrameState } from "./FrameXmlTypes.js";

/** `timeVisible` of a message frame whose XML names none (Wow.exe 0x00a9fef0). */
export const FRAME_XML_MESSAGE_TIME_VISIBLE = 10;
/** `fadeDuration` of a message frame whose XML names none (Wow.exe 0x00a9fef4). */
export const FRAME_XML_MESSAGE_FADE_DURATION = 3;

/**
 * 3.34 (L5): the alpha a line keeps while it is "shown" again after it began to fade. The client
 * writes the alpha byte only while a line fades (0x00968a60, 0x00969e60), so a line given a new
 * "shown" mid-fade — a ScrollingMessageFrame's SetTimeVisible (0x00969280) — waits at the alpha it
 * had, and one whose two countdowns are both 0 after SetFadeDuration(0) mid-fade keeps it for good.
 * Adding the line, or a scroll reviving it, gives it its own alpha again.
 */
const heldAlphas = new WeakMap<FrameXmlMessage, number>();
/** Whether any line was ever held: until then the per-line lookup is skipped. */
let anyHeld = false;

function hold(message: FrameXmlMessage, alpha: number): void {
  heldAlphas.set(message, alpha);
  anyHeld = true;
}

function heldAlpha(message: FrameXmlMessage): number | undefined {
  return anyHeld ? heldAlphas.get(message) : undefined;
}

/** Start a line's two countdowns at the frame's clock, as adding it (or a scroll's reset) does. */
export function frameXmlStampMessage(state: FrameXmlMessageFrameState, message: FrameXmlMessage): void {
  if (anyHeld) heldAlphas.delete(message);
  setCountdowns(state, message, state.displayDuration, state.fadeDuration);
}

function setCountdowns(state: FrameXmlMessageFrameState, message: FrameXmlMessage, shown: number, fading: number): void {
  if (shown <= 0 && fading <= 0) {
    // Both countdowns at 0: the update passes the line by for good.
    message.visibleUntil = Infinity;
    message.fadeUntil = Infinity;
    return;
  }
  message.visibleUntil = state.fadeClock + Math.max(0, shown);
  message.fadeUntil = message.visibleUntil + Math.max(0, fading);
}

/** The line's alpha now: its own while shown, `fading / fadeDuration` in bytes while fading, 0 cleared. */
export function frameXmlMessageAlpha(state: FrameXmlMessageFrameState, message: FrameXmlMessage): number {
  const clock = state.fadeClock;
  const shown = message.visibleUntil ?? Infinity;
  if (clock < shown) return heldAlpha(message) ?? message.color.a;
  const end = message.fadeUntil ?? Infinity;
  if (clock >= end) return 0;
  const duration = state.fadeDuration;
  if (!(duration > 0)) return 0;
  return Math.min(255, Math.round(((end - clock) / duration) * 255)) / 255;
}

/** Whether the update has cleared the line. */
export function frameXmlMessageCleared(state: FrameXmlMessageFrameState, message: FrameXmlMessage): boolean {
  return state.fadeClock >= (message.fadeUntil ?? Infinity);
}

/**
 * `SetTimeVisible`: the new value, and a fresh "shown" for every line still being shown. A
 * ScrollingMessageFrame (`scrolling`, 0x00969280) writes it into every live line instead — a fading
 * one too, which then waits at its alpha for that long and fades on from where it was, and one whose
 * countdowns are both 0, which is cleared when it runs out (3.34, L5).
 */
export function frameXmlRetimeShown(state: FrameXmlMessageFrameState, seconds: number, scrolling = false): void {
  const clock = state.fadeClock;
  for (const message of state.messages) {
    const shown = message.visibleUntil ?? Infinity;
    if (!scrolling) {
      if (!(clock < shown) || shown === Infinity) continue;
      const fading = (message.fadeUntil ?? shown) - shown;
      setCountdowns(state, message, seconds, fading);
      continue;
    }
    const end = message.fadeUntil ?? Infinity;
    if (!(clock < end)) continue;
    if (shown === Infinity) {
      // Both countdowns 0: "fading" stays 0, so the new "shown" is all the line has left.
      if (seconds > 0) {
        message.visibleUntil = clock + seconds;
        message.fadeUntil = message.visibleUntil;
      }
      continue;
    }
    // What is left of "fading": all of it while shown, the rest of it while fading.
    const fading = clock < shown ? end - shown : end - clock;
    if (!(clock < shown) && seconds > 0) hold(message, frameXmlMessageAlpha(state, message));
    message.visibleUntil = clock + seconds;
    message.fadeUntil = message.visibleUntil + fading;
  }
  state.displayDuration = seconds;
  state.fadeRevision += 1;
}

/**
 * `SetFadeDuration`: the new value, and a fresh "fading" for every line that has some left — a
 * ScrollingMessageFrame (`scrolling`, 0x009692c0) for every live line, a 0-fade one too. A fading
 * line given 0 has both countdowns at 0 and keeps the alpha it had, for good (3.34, L5).
 */
export function frameXmlRetimeFading(state: FrameXmlMessageFrameState, seconds: number, scrolling = false): void {
  const clock = state.fadeClock;
  for (const message of state.messages) {
    const shown = message.visibleUntil ?? Infinity;
    const end = message.fadeUntil ?? Infinity;
    if (!(clock < end)) continue;
    if (shown === Infinity) {
      // Both countdowns 0: a MessageFrame leaves the line alone; a ScrollingMessageFrame starts its fade.
      if (scrolling && seconds > 0) {
        if (anyHeld) heldAlphas.delete(message);
        message.visibleUntil = clock;
        message.fadeUntil = clock + seconds;
      }
      continue;
    }
    if (clock < shown) {
      // A MessageFrame keeps a 0 fade: the line is cleared when "shown" ends.
      if (!scrolling && end - shown <= 0) continue;
      message.fadeUntil = shown + seconds;
      continue;
    }
    if (seconds > 0) {
      // Fading: again from full alpha, over the new length.
      message.visibleUntil = clock;
      message.fadeUntil = clock + seconds;
    } else {
      // Its alpha at the old length, kept: the update passes a line with both countdowns at 0 by.
      hold(message, frameXmlMessageAlpha(state, message));
      message.visibleUntil = Infinity;
      message.fadeUntil = Infinity;
    }
  }
  state.fadeDuration = seconds;
  state.fadeRevision += 1;
}

/** A scroll call on a ScrollingMessageFrame: every line full alpha with fresh countdowns again. */
export function frameXmlResetMessageFades(state: FrameXmlMessageFrameState): void {
  for (const message of state.messages) frameXmlStampMessage(state, message);
  state.fadeRevision += 1;
}

/**
 * 3.34 (L5): what the renderer last measured of a ScrollingMessageFrame's line layer — how many lines
 * can be in view at most (its height over the font's, plus one cut at an edge) and whether every line
 * is in view. Absent until it has measured one; the runtime then keeps its old answers.
 */
export interface FrameXmlMessageLayout {
  readonly lines: number | undefined;
  readonly fits: boolean;
}

const layouts = new WeakMap<FrameXmlMessageFrameState, FrameXmlMessageLayout>();

/** The renderer's note, written where it reads the layer's heights anyway (no layout of its own). */
export function frameXmlNoteMessageLayout(state: FrameXmlMessageFrameState, lines: number | undefined, fits: boolean): void {
  const known = layouts.get(state);
  if (known !== undefined && known.lines === lines && known.fits === fits) return;
  layouts.set(state, { lines, fits });
}

export function frameXmlMessageLayout(state: FrameXmlMessageFrameState): FrameXmlMessageLayout | undefined {
  return layouts.get(state);
}

/**
 * A scroll call that ends with line `current` at the edge (3.34, L5). The client revives the lines
 * in its visible slots only (0x00969410; 0x00969fa0 → 0x00969370) and leaves the rest of the history
 * as it was, never drawn. Scrolled up, nothing counts down, so every line is revived as before; at
 * the bottom only the lines that can be in view are, and a line out of view that is still counting
 * is cleared — out of sight it would only fade, a style write a frame for every one of them.
 */
export function frameXmlReviveMessageFades(state: FrameXmlMessageFrameState, current: number, atBottom: boolean): void {
  const lines = layouts.get(state)?.lines;
  const count = state.messages.length;
  if (!atBottom || lines === undefined || !(lines < count)) {
    frameXmlResetMessageFades(state);
    return;
  }
  const to = Math.min(count, Math.max(0, Math.trunc(current) + 1));
  const from = Math.max(0, to - lines);
  const clock = state.fadeClock;
  for (let index = 0; index < count; index += 1) {
    const message = state.messages[index]!;
    if (index >= from && index < to) {
      frameXmlStampMessage(state, message);
    } else if ((message.visibleUntil ?? Infinity) !== Infinity && clock < (message.fadeUntil ?? Infinity)) {
      message.visibleUntil = clock;
      message.fadeUntil = clock;
    }
  }
  state.fadeRevision += 1;
}

/** `insertMode` as the loader and `SetInsertMode` read it. */
export function frameXmlInsertMode(value: string | undefined): "TOP" | "BOTTOM" | undefined {
  if (value === undefined) return undefined;
  const mode = value.trim().toUpperCase();
  if (mode === "BOTTOM") return "BOTTOM";
  return mode === "TOP" ? "TOP" : undefined;
}

/** What the bridge supplies to `FrameXmlMessageFades.tick`. */
export interface FrameXmlMessageFadeHost {
  /** Shown, with every ancestor shown: a hidden frame gets no update. */
  visible(frame: FrameXmlFrame): boolean;
  /** A MessageFrame's cleared lines were taken out of `messages`; announce the change. */
  cleared(frame: FrameXmlFrame): void;
}

/**
 * The bridge's set of message frames whose clock is running: a frame joins when a fading line is
 * added or its lines are re-timed, and leaves once nothing more can happen to its lines.
 */
export class FrameXmlMessageFades {
  readonly #frames = new Set<FrameXmlFrame>();
  /** The clock at which the frame next needs looking at; absent means "work it out". */
  readonly #due = new Map<FrameXmlFrame, number>();

  get size(): number {
    return this.#frames.size;
  }

  /** A line was added (`message`), or the lines' countdowns changed (no `message`). */
  track(frame: FrameXmlFrame, message?: FrameXmlMessage): void {
    if (!frame.messageFrame.fading) return;
    this.#frames.add(frame);
    const due = this.#due.get(frame);
    if (message === undefined || due === undefined) {
      this.#due.delete(frame);
      return;
    }
    // A MessageFrame next clears its earliest line; a ScrollingMessageFrame is done after its latest.
    const end = message.fadeUntil ?? Infinity;
    this.#due.set(frame, frame.type === "MessageFrame" ? Math.min(due, end) : Math.max(due, end));
  }

  forget(frame: FrameXmlFrame): void {
    this.#frames.delete(frame);
    this.#due.delete(frame);
  }

  /** Advance every counting frame by `elapsed` seconds; clear what has faded out. */
  tick(elapsed: number, host: FrameXmlMessageFadeHost): void {
    if (this.#frames.size === 0 || !(elapsed > 0)) return;
    for (const frame of this.#frames) {
      const state = frame.messageFrame;
      if (!state.fading || state.messages.length === 0) {
        this.forget(frame);
        continue;
      }
      if (!host.visible(frame)) continue;
      const scrolling = frame.type !== "MessageFrame";
      if (scrolling && frame.scroll.verticalScroll < frame.scroll.verticalScrollRange) continue;
      state.fadeClock += elapsed;
      let due = this.#due.get(frame);
      if (due === undefined) {
        due = this.dueOf(frame);
        this.#due.set(frame, due);
      }
      if (state.fadeClock < due) continue;
      if (scrolling) {
        // Every line has faded out; the history stays, the clock can stop.
        this.forget(frame);
        continue;
      }
      const before = state.messages.length;
      let kept = 0;
      for (const message of state.messages) {
        if (!frameXmlMessageCleared(state, message)) state.messages[kept++] = message;
      }
      state.messages.length = kept;
      this.#due.delete(frame);
      if (kept === 0) this.forget(frame);
      if (kept !== before) host.cleared(frame);
    }
  }

  private dueOf(frame: FrameXmlFrame): number {
    const state = frame.messageFrame;
    const message = frame.type === "MessageFrame";
    let due = message ? Infinity : -Infinity;
    for (const line of state.messages) {
      const end = line.fadeUntil ?? Infinity;
      due = message ? Math.min(due, end) : Math.max(due, end);
    }
    return due;
  }
}

/** Where a renderer's walk over one frame's drawn lines got to. */
export interface FrameXmlLineFadeCursor {
  /** Lines before this index are cleared and already drawn so. */
  from: number;
  /** The clock at which a drawn line next changes; Infinity when none will. */
  next: number;
}

/**
 * Draw the lines' alphas at the frame's clock: opacity while a line fades, hidden once cleared (a
 * cleared line keeps its place — the client clears the string, not the slot — and stops taking
 * the pointer, so a faded link is not clickable). Writes only what changed. Starts at `cursor.from`
 * and leaves in `cursor` the first line not yet cleared and the clock at which a drawn line next
 * changes (Infinity: none will) — written in place, so a frame's walk allocates nothing.
 */
export function frameXmlPaintLineFades(
  state: FrameXmlMessageFrameState,
  lines: ArrayLike<HTMLElement | undefined>,
  drawn: readonly FrameXmlMessage[],
  cursor: FrameXmlLineFadeCursor,
): void {
  const clock = state.fadeClock;
  let next = Infinity;
  let first = cursor.from;
  let leading = true;
  for (let index = cursor.from; index < drawn.length; index += 1) {
    const message = drawn[index]!;
    const line = lines[index];
    if (line) frameXmlPaintLineFade(line, state, message);
    const shown = message.visibleUntil ?? Infinity;
    const end = message.fadeUntil ?? Infinity;
    if (clock < shown) {
      if (shown < next) next = shown;
    } else if (clock < end) next = clock;
    if (leading && clock >= end) first = index + 1;
    else leading = false;
  }
  cursor.from = first;
  cursor.next = next;
}

/**
 * Whether the line's alpha is not its colour's own now: it fades, or it holds the alpha it had
 * (3.34, L5) — a line drawn then has to be painted, not left at its colour.
 */
export function frameXmlMessageAlphaReplaced(state: FrameXmlMessageFrameState, message: FrameXmlMessage): boolean {
  return state.fadeClock >= (message.visibleUntil ?? Infinity) || heldAlpha(message) !== undefined;
}

/** One line's opacity and visibility for its alpha now. */
export function frameXmlPaintLineFade(line: HTMLElement, state: FrameXmlMessageFrameState, message: FrameXmlMessage): void {
  const alpha = frameXmlMessageAlpha(state, message);
  const fading = frameXmlMessageAlphaReplaced(state, message);
  // While shown, the line colour carries its own alpha; fading replaces it (the client writes the
  // alpha byte), so the opacity is taken relative to the colour's.
  const own = message.color.a;
  const opacity = !fading || alpha >= own ? "" : own > 0 ? String(Math.min(1, alpha / own)) : "0";
  if (line.style.opacity !== opacity) line.style.opacity = opacity;
  const visibility = fading && alpha <= 0 ? "hidden" : "";
  if (line.style.visibility !== visibility) line.style.visibility = visibility;
}
