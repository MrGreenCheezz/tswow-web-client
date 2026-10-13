/**
 * Plan item 1.10 (12.10): the UI root's mouse capture — which frame a release belongs to — as Wow.exe 3.3.5a 12340
 * has it.
 *
 * Wow.exe (read-only Ghidra, .runtime/re-2026-10-11/glue-1110/a347-6.txt, a347-10.txt):
 * - The mouse-down (0x00495470, event 0xc) hands the press to the frame holding the mouse (CSimpleTop +0x7c) or, when
 *   none does, to the frame under it (+0x78, the topmost one taking the mouse), stores that frame in +0x7c and calls
 *   its OnLayerMouseDown (vtable +0xac). Nothing under the mouse: the world's handler (+0x1238) had the press.
 * - The mouse-up (0x004947a0, event 0xf) goes to +0x7c alone (vtable +0xb0, OnLayerMouseUp) wherever the pointer is,
 *   and +0x7c is let go once no button is held (the event's held-button word, `local_24`). With +0x7c empty the
 *   world's handler has the release and no frame hears of it.
 *
 * So a release over a frame that did not take the press is nobody's click and nobody's OnMouseUp. The browser
 * delivers a mouseup to whatever element is under the pointer: a press on the world, on a bag slot or on a bar
 * button, released over a unit portrait, ran the portrait's registered click (SecureUnitButton — with an item on
 * the cursor that click is DropItemOnUnit: a trade proposal, feeding the pet), and a release over the minimap after
 * turning the camera ran Minimap's OnMouseUp (a ping). A started drag's release was already spent (`#dragReleases`
 * in FrameXmlDomRenderer.ts, L1-review); this is the same rule for a press that never became a drag.
 *
 * The renderer reports each press (`press`, from a window capture listener and, for pages without one, from the
 * element listeners), the frames whose own mouse-down ran for it (`received`: OnMouseDown went there, so OnMouseUp
 * does), and asks `release` which frame owns a release. One record per press: the first caller of an event resolves
 * it, the rest of the bubbling path reads the same answer.
 */

/** What a release belongs to. */
export interface FrameXmlMouseRelease<Frame> {
  /** The frame that took the press (+0x7c); undefined when it went to the world or to nothing. */
  readonly owner: Frame | undefined;
  /** The frames whose mouse-down (OnMouseDown) ran for the press: the only ones a release reaches as OnMouseUp. */
  readonly received: ReadonlySet<Frame>;
}

const NOBODY: FrameXmlMouseRelease<never> = Object.freeze({ owner: undefined, received: new Set<never>() });

/** The mouse button's bit in `MouseEvent.buttons` (0 left, 1 middle, 2 right, 3 back, 4 forward). */
function buttonBit(event: Event): number {
  const button = (event as MouseEvent).button;
  return button === 1 ? 4 : button === 2 ? 2 : button === 3 ? 8 : button === 4 ? 16 : 1;
}

/** Buttons other than the event's own still held, when the event says (`MouseEvent.buttons`); else none. */
function otherButtonsHeld(event: Event): boolean {
  const held = (event as MouseEvent).buttons;
  return typeof held === "number" && (held & ~buttonBit(event)) !== 0;
}

export class FrameXmlMouseCapture<Frame> {
  /** The press being resolved (the mousedown event its listeners share). */
  #pressEvent: Event | undefined;
  /** A press is held: +0x7c is set (even to the world) until no button is. */
  #held = false;
  #owner: Frame | undefined;
  #received = new Set<Frame>();
  /** The release being answered and its answer, shared by every listener along its path. */
  #releaseEvent: Event | undefined;
  #release: FrameXmlMouseRelease<Frame> = NOBODY;

  /**
   * A press: `resolve` names the frame that takes it (undefined — the world, or nothing taking the mouse). While
   * another button is still held the held frame keeps it (0x00495470 reads +0x7c first). Once per event.
   */
  press(event: Event, resolve: () => Frame | undefined): void {
    if (this.#pressEvent === event) return;
    this.#pressEvent = event;
    if (this.#held && otherButtonsHeld(event)) return;
    this.#held = true;
    this.#owner = resolve();
    this.#received = new Set();
  }

  /** `frame`'s own mouse-down ran for the press (its OnMouseDown): its OnMouseUp hears the release. */
  received(event: Event, frame: Frame): void {
    if (this.#pressEvent === event && this.#held) this.#received.add(frame);
  }

  /**
   * Who a release belongs to. The first caller for an event takes it; the press ends unless another button is still
   * held (0x004947a0 keeps +0x7c while `local_24` is non-zero). Without a press there is nobody.
   */
  release(event: Event): FrameXmlMouseRelease<Frame> {
    if (this.#releaseEvent === event) return this.#release;
    this.#releaseEvent = event;
    // Not held: no owner and nobody received (both are cleared with `#held`).
    this.#release = { owner: this.#owner, received: this.#received };
    if (!otherButtonsHeld(event)) {
      this.#held = false;
      this.#owner = undefined;
      this.#received = new Set();
      this.#pressEvent = undefined;
    }
    return this.#release;
  }

  /** Forget any held press (renderer teardown, a remount). */
  reset(): void {
    this.#held = false;
    this.#owner = undefined;
    this.#received = new Set();
    this.#pressEvent = undefined;
    this.#releaseEvent = undefined;
    this.#release = NOBODY;
  }

  /**
   * Follow every press and release on the page from the window's capture phase, before any element listener —
   * presses on the world canvas included, which no frame listener sees. Answers the cleanup; a page without a
   * window (a test's bare DOM) gets nothing to clean up and the element listeners report instead.
   */
  listen(view: EventTarget | null | undefined, resolve: (event: Event) => Frame | undefined): (() => void) | undefined {
    if (typeof view?.addEventListener !== "function") return undefined;
    const down = (event: Event): void => this.press(event, () => resolve(event));
    const up = (event: Event): void => { this.release(event); };
    view.addEventListener("mousedown", down, true);
    view.addEventListener("mouseup", up, true);
    return () => {
      view.removeEventListener?.("mousedown", down, true);
      view.removeEventListener?.("mouseup", up, true);
    };
  }
}
