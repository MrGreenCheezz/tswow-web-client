/**
 * 3.21 (widgets7, 15.11): `Frame:StartSizing(point)` with a real resize, as Wow.exe 3.3.5a (12340) does it (read-only
 * Ghidra; notes .runtime/re-2026-11-15/widgets5/g1.c, widgets7/w1.c, w2.c, and re-2026-10-11/glue-1110/a347-*.txt).
 *
 * - The bounds: `SetMinResize`/`SetMaxResize` (0x004a0520/0x004a06e0) and the XML `<ResizeBounds>` with its
 *   `<minResize>`/`<maxResize>` dimensions (the frame loader 0x004932c0) write the same four floats (+0x64 … +0x70);
 *   0 means no bound. The layout frame's constructor (0x00489980) zeroes them.
 * - StartSizing (0x004a0b10): a frame without `resizable` (+0xb4 bit 0x200) raises «Frame <name> is not resizable».
 *   The point is a case-insensitive name of the point table (0x00814ed0 over 0x00a43f78: TOPLEFT 0, TOP 1, TOPRIGHT
 *   2, LEFT 3, CENTER 4, RIGHT 5, BOTTOMLEFT 6, BOTTOM 7, BOTTOMRIGHT 8); no argument or an unknown name keeps
 *   BOTTOMRIGHT. Nothing starts while the frame manager already moves or sizes a frame (+0xd0c); otherwise it
 *   starts sizing mode 3 from the press point (0x00494060), which fails for a frame without a rectangle
 *   (0x0048a5f0's check — a hidden frame here).
 * - Each pointer move (0x004945a0 → 0x00493ce0) hands the frame the whole delta since the last move — the last point
 *   advances by the full delta even when a bound swallowed part of it, so the grip and the cursor part company
 *   at a bound — and 0x0048abd0 changes the size by the side the point names, clamped by the bounds, then anchors
 *   the frame's TOPLEFT to the screen's TOPLEFT where it now is (0x0048a5f0) and sets its width and height. A
 *   side that moves the frame's top or left edge (TOPLEFT, TOP, TOPRIGHT's top, LEFT, BOTTOMLEFT's left) also
 *   moves that corner by what the bound let through; CENTER and anything else move the frame by the delta.
 * - StopMovingOrSizing (0x004a0c20) ends it only on the frame being sized (0x00493a10). A release does not end a
 *   sizing (0x004947a0 ends modes 1 and 2 only): the stock chat grip and AceGUI's sizers call StopMovingOrSizing
 *   from OnMouseUp.
 *
 * Here the moves are the renderer's pointer moves during the press that started the sizing (FrameXmlDomRenderer);
 * a sizing left running after the release does not follow the bare cursor as Wow.exe's does.
 */
import type { FrameXmlFrame } from "./FrameXmlTypes.js";

export interface FrameXmlResizeBounds { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number }

const NO_BOUNDS: Readonly<FrameXmlResizeBounds> = Object.freeze({ minWidth: 0, minHeight: 0, maxWidth: 0, maxHeight: 0 });
const resizeBounds = new WeakMap<FrameXmlFrame, FrameXmlResizeBounds>();

/** A frame's resize bounds (0, 0, 0, 0 when never set). */
export function frameXmlResizeBounds(frame: FrameXmlFrame): Readonly<FrameXmlResizeBounds> {
  return resizeBounds.get(frame) ?? NO_BOUNDS;
}

/** SetMinResize/SetMaxResize and `<ResizeBounds>`: one pair, the other kept. */
export function frameXmlSetResizeBounds(frame: FrameXmlFrame, which: "min" | "max", width: number, height: number): void {
  let bounds = resizeBounds.get(frame);
  if (!bounds) {
    bounds = { ...NO_BOUNDS };
    resizeBounds.set(frame, bounds);
  }
  if (which === "min") { bounds.minWidth = width; bounds.minHeight = height; } else { bounds.maxWidth = width; bounds.maxHeight = height; }
}

/** The point table at 0x00a43f78 (value by name). */
const POINTS: Readonly<Record<string, number>> = Object.freeze({
  TOPLEFT: 0, TOP: 1, TOPRIGHT: 2, LEFT: 3, CENTER: 4, RIGHT: 5, BOTTOMLEFT: 6, BOTTOM: 7, BOTTOMRIGHT: 8,
});

/** StartSizing's point argument: a known name (any case) or BOTTOMRIGHT (8). */
export function frameXmlSizingPoint(value: unknown): number {
  if (typeof value !== "string") return POINTS["BOTTOMRIGHT"]!;
  return POINTS[value.toUpperCase()] ?? POINTS["BOTTOMRIGHT"]!;
}

/** The frame manager's one sizing slot (+0xd0c with mode 3), per bridge. */
interface SizingSlot { readonly frame: FrameXmlFrame; readonly point: number }
const slots = new WeakMap<object, SizingSlot>();

export function frameXmlSizingOf(owner: object): SizingSlot | undefined {
  return slots.get(owner);
}

export function frameXmlBeginSizing(owner: object, frame: FrameXmlFrame, point: number): void {
  slots.set(owner, { frame, point });
}

/** StopMovingOrSizing on `frame`: the slot is cleared only when it is that frame's. */
export function frameXmlEndSizing(owner: object, frame: FrameXmlFrame): void {
  if (slots.get(owner)?.frame === frame) slots.delete(owner);
}

export interface FrameXmlSizeStep {
  readonly width: number;
  readonly height: number;
  /** How far the frame's TOPLEFT moves, in the frame's units, x right and y up. */
  readonly moveX: number;
  readonly moveY: number;
}

/**
 * One move of 0x0048abd0: `dx`, `dy` are the cursor's delta in the frame's units (x right, y up), `width`/`height`
 * the frame's size before it.
 */
export function frameXmlSizeStep(
  point: number, width: number, height: number, dx: number, dy: number, bounds: Readonly<FrameXmlResizeBounds>,
): FrameXmlSizeStep {
  const { minWidth, minHeight, maxWidth, maxHeight } = bounds;
  // The edge that moves with the cursor's x away from a fixed right edge (left side): the corner moves by what the
  // bounds let through.
  const leftEdge = (): { width: number; moveX: number } => {
    let next = width - dx;
    let moveX = dx;
    if (minWidth !== 0 && next < minWidth) { moveX -= minWidth - next; next = minWidth; }
    if (maxWidth !== 0 && next > maxWidth) { moveX += next - maxWidth; next = maxWidth; }
    return { width: next, moveX };
  };
  const rightEdge = (): number => {
    let next = width + dx;
    if (minWidth !== 0 && next < minWidth) next = minWidth;
    if (maxWidth !== 0 && next > maxWidth) next = maxWidth;
    return next;
  };
  const topEdge = (): { height: number; moveY: number } => {
    let next = height + dy;
    let moveY = dy;
    if (minHeight !== 0 && next < minHeight) { moveY += minHeight - next; next = minHeight; }
    if (maxHeight !== 0 && next > maxHeight) { moveY -= next - maxHeight; next = maxHeight; }
    return { height: next, moveY };
  };
  const bottomEdge = (): number => {
    let next = height - dy;
    if (minHeight !== 0 && next < minHeight) next = minHeight;
    if (maxHeight !== 0 && next > maxHeight) next = maxHeight;
    return next;
  };
  switch (point) {
    case 0: { const x = leftEdge(); const y = topEdge(); return { width: x.width, height: y.height, moveX: x.moveX, moveY: y.moveY }; }
    case 1: { const y = topEdge(); return { width, height: y.height, moveX: 0, moveY: y.moveY }; }
    case 2: { const y = topEdge(); return { width: rightEdge(), height: y.height, moveX: 0, moveY: y.moveY }; }
    case 3: { const x = leftEdge(); return { width: x.width, height, moveX: x.moveX, moveY: 0 }; }
    case 5: return { width: rightEdge(), height, moveX: 0, moveY: 0 };
    case 6: { const x = leftEdge(); return { width: x.width, height: bottomEdge(), moveX: x.moveX, moveY: 0 }; }
    case 7: return { width, height: bottomEdge(), moveX: 0, moveY: 0 };
    case 8: return { width: rightEdge(), height: bottomEdge(), moveX: 0, moveY: 0 };
    default: return { width, height, moveX: dx, moveY: dy };
  }
}
