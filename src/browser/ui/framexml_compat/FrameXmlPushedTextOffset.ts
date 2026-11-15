/**
 * widgets9 (15.11, plan item 3.21): a Button's pushed text offset as Wow.exe 3.3.5a (12340) keeps it (read-only
 * Ghidra, .runtime/re-2026-11-15/widgets9/d1.c, d4.c, d5.c, l2.lst; widgets5/g1.c; behaviour described, no code
 * copied).
 *
 * - The Button keeps the pair as two floats in screen-diagonal units (+0x2bc, +0x2c0). Its constructor (0x00970520)
 *   writes 0.001 and −0.001 (the floats at 0x009e1134 / 0x009e2ffc).
 * - `SetPushedTextOffset(x, y)` (0x00977f60): both arguments must be numbers, else «Usage: <name>:SetPushedTextOffset
 *   (x, y)»; each UI value is divided by the screen scale × 1024 (0x0047bfe0, 0x009e300c) and multiplied by the
 *   diagonal factor (0x0047c070), each step kept as a float.
 * - `GetPushedTextOffset()` (0x00978040): the way back — scale × 1024 × stored as a float, over the diagonal factor
 *   (0x0047c050) — two numbers.
 * - The factors come from the screen's aspect (0x0047bf90): scale = 0.75 × aspect (0x009e9ee4), and the diagonal
 *   factor = aspect / √(aspect² + 1). So a stored d answers d × 768 × √(aspect² + 1): the default is ±1.28 at 4:3.
 *
 * `<PushedTextOffset>` in a Button's XML is kept the way SetPushedTextOffset keeps it — the Button's XML loader
 * itself was not read. The offset is not drawn here (a pressed button's label does not move yet); WCollections
 * reads it back to place its icon (WCollections.xml:431).
 */
import type { FrameXmlFrame } from "./FrameXmlTypes.js";

/** 0x009e1134 / 0x009e2ffc: the constructor's pair, in diagonal units. */
const DEFAULT_OFFSET: readonly [number, number] = [Math.fround(0.001), Math.fround(-0.001)];

const offsets = new WeakMap<FrameXmlFrame, readonly [number, number]>();
/** XML offsets in UI units, kept until the aspect is known at the first read. */
const declared = new WeakMap<FrameXmlFrame, readonly [number, number]>();

/** 0x0047bf90's two factors at this aspect (each a float, as the client keeps them). */
function factors(aspect: number): { readonly scale: number; readonly diagonal: number } {
  const ratio = Math.fround(Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3);
  const scale = Math.fround(0.75 * ratio);
  const inverse = Math.fround(1 / Math.sqrt(ratio * ratio + 1));
  return { scale, diagonal: Math.fround(inverse * ratio) };
}

/** UI units to the stored float (0x00977f60). */
function toStored(value: number, aspect: number): number {
  const { scale, diagonal } = factors(aspect);
  return Math.fround(diagonal * Math.fround(Math.fround(value) / (scale * 1024)));
}

/** The stored float back to UI units (0x00978040). */
function fromStored(stored: number, aspect: number): number {
  const { scale, diagonal } = factors(aspect);
  return Math.fround(scale * 1024 * stored) / diagonal;
}

/** `SetPushedTextOffset(x, y)` once its arguments are checked. */
export function frameXmlSetPushedTextOffset(frame: FrameXmlFrame, x: number, y: number, aspect: number): void {
  declared.delete(frame);
  offsets.set(frame, [toStored(x, aspect), toStored(y, aspect)]);
}

/** `<PushedTextOffset>` from a Button's XML (UI units). */
export function frameXmlDeclarePushedTextOffset(frame: FrameXmlFrame, x: number, y: number): void {
  offsets.delete(frame);
  declared.set(frame, [x, y]);
}

/** `GetPushedTextOffset()`: the pair in UI units at this aspect. */
export function frameXmlPushedTextOffset(frame: FrameXmlFrame, aspect: number): readonly [number, number] {
  const fromXml = declared.get(frame);
  if (fromXml) frameXmlSetPushedTextOffset(frame, fromXml[0], fromXml[1], aspect);
  const [x, y] = offsets.get(frame) ?? DEFAULT_OFFSET;
  return [fromStored(x, aspect), fromStored(y, aspect)];
}
