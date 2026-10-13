/**
 * 3.48 (13.10): the raise Wow.exe 3.3.5a 12340 runs on a press and on `Frame:Raise()` — 0x0048e9a0 → CSimpleTop
 * 0x004951a0(frame, 1) (notes .runtime/re-2026-10-11/glue-1110/a347-6.txt, a347-7.txt, 1013-q1.txt, 1013-q2.txt):
 *
 * - The frame acted on is the frame itself when it is toplevel (+0xb4 bit 1: `toplevel="true"`, SetToplevel
 *   0x0049fbb0 → 0x0048e970(1, on), IsToplevel 0x0049fc30), else its nearest toplevel ancestor (+0x94 up), else
 *   nothing at all.
 * - 0x00494d20 then walks its strata's level lists from its own level up and sets flag 0x10 when a frame there that
 *   is not one of its descendants overlaps its rectangle (0x0048ed60's intersection, not empty).
 * - With the flag, the strata's levels are packed (0x00495060) and the frame goes to the strata's level count
 *   (0x004910a0): above every frame of the strata. Without it nothing changes.
 *
 * The UI root's mouse-down (0x00495470) runs it on the frame that took the press first of all; `Raise` (0x0049fef0)
 * runs it too (a protected frame in combat goes to the blocked-action handler instead — not modelled here).
 */
import type { FrameXmlFrame, FrameXmlRect } from "./FrameXmlTypes.js";

/** What the raise reads of the bridge: the frames, who is shown, and each one's screen box (top-origin). */
export interface FrameXmlRaiseHost {
  readonly frames: Iterable<FrameXmlFrame>;
  isVisible(frame: FrameXmlFrame): boolean;
  rect(frame: FrameXmlFrame): FrameXmlRect;
}

/** The frame a raise acts on: the toplevel frame itself or its nearest toplevel ancestor; undefined for none. */
export function frameXmlRaiseTarget(frame: FrameXmlFrame | undefined): FrameXmlFrame | undefined {
  let current = frame;
  for (let depth = 0; current && depth < 64; depth += 1, current = current.parent) {
    if (current.toplevel) return current;
  }
  return undefined;
}

/**
 * The level `target` rises to — one above the highest of its strata — when a shown frame of its strata at its level or
 * above, not its descendant, overlaps it; undefined when it stays. `limit` is the renderer's top level.
 */
export function frameXmlRaiseLevel(host: FrameXmlRaiseHost, target: FrameXmlFrame, limit: number): number | undefined {
  if (!host.isVisible(target)) return undefined;
  const box = host.rect(target);
  const descends = (other: FrameXmlFrame): boolean => {
    for (let current = other.parent, depth = 0; current && depth < 64; current = current.parent, depth += 1) {
      if (current === target) return true;
    }
    return false;
  };
  let highest = target.frameLevel;
  let overlapped = false;
  for (const other of host.frames) {
    if (other === target || other.frameStrata !== target.frameStrata) continue;
    if (other.frameLevel > highest) highest = other.frameLevel;
    if (overlapped || other.frameLevel < target.frameLevel || other.type === "Texture" || other.type === "FontString") continue;
    if (descends(other) || !host.isVisible(other)) continue;
    const rect = host.rect(other);
    if (Math.max(box.left, rect.left) < Math.min(box.right, rect.right)
      && Math.max(box.top, rect.top) < Math.min(box.bottom, rect.bottom)) overlapped = true;
  }
  if (!overlapped) return undefined;
  const level = Math.min(highest + 1, limit);
  return level === target.frameLevel ? undefined : level;
}
