/**
 * plates12 (15.11, plan item 6.37): where the scene finds the name-plate frame host (NamePlateFrames.ts) while a
 * FrameXML world is mounted. A file of its own, importing nothing but types: SimpleScene is imported by renderer-side
 * modules, and the host's own imports (settings, the FrameXML runtime) must not follow it there.
 */
import type { PlateBox, PlateData } from "../NamePlate.js";

/** One plate the scene placed this frame: its box in the overlay's CSS pixels and what it says. */
export interface NamePlateFramePlacement {
  readonly box: PlateBox;
  readonly data: PlateData;
}

export interface NamePlateFrameHost {
  /** This frame's plates, far first and the target last, on an overlay `width` × `height` CSS pixels. */
  present(plates: readonly NamePlateFramePlacement[], width: number, height: number): void;
  /** Give every plate back. */
  clear(): void;
}

let current: NamePlateFrameHost | undefined;

/** The host the scene hands its plates to, while a FrameXML world is mounted. */
export function namePlateFrameHost(): NamePlateFrameHost | undefined {
  return current;
}

/** Register (or, with undefined, drop) the host; the previous one gives its plates back. */
export function setNamePlateFrameHost(host: NamePlateFrameHost | undefined): void {
  if (current && current !== host) current.clear();
  current = host;
}
