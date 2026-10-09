/**
 * L2 1.10: the live `TargetNearest*`/`TargetLast*` (FrameXmlTargetNearest.ts) — the browser game's
 * own Tab list and the world client's target history (game/Targeting.ts), the same ones the native
 * keys use, so a /targetfriend from a macro and Ctrl+Tab step one list.
 */
import { targetLastUnit, targetNearestUnit } from "../game/Targeting.js";
import type { FrameXmlTargetNearest } from "./FrameXmlTargetNearest.js";

const live: FrameXmlTargetNearest = {
  nearest(mode, reverse) {
    targetNearestUnit(mode, reverse);
  },
  last(kind) {
    targetLastUnit(kind);
  },
};

export const FRAMEXML_LIVE_TARGET_NEAREST: FrameXmlTargetNearest = Object.freeze(live);
