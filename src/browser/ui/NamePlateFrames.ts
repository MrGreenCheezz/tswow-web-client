/**
 * plates12 (15.11, plan items 6.37 and 3.21): the name plates as real frames under the stock `WorldFrame`, where
 * Wow.exe keeps them and where add-ons look for them (`WorldFrame:GetChildren()`).
 *
 * The scene still decides which units carry a plate and where each one hangs (`SimpleScene.draw` with
 * `NamePlates.plateSource`: the V-key switches, the sight admission, the 41 yards, the name point raised by 2/3 yard, the
 * overlap rule), and still keeps the plates' click boxes. With a FrameXML world mounted it hands that list here instead
 * of painting it on its canvas: each plate becomes a frame of the pool (FrameXmlNamePlatePool.ts), drawn by the FrameXML
 * renderer with the rest of the interface (under it: WorldFrame's strata), so whatever an add-on hides, moves or adds
 * on a plate is what the player sees. Without a FrameXML world (the native HUD, a test page) nothing registers here and
 * the canvas paints the plates as before (NamePlate.ts `drawPlate`).
 */
import {
  plateColour,
  plateLevelColour,
  plateShowsElite,
  plateShowsSkull,
  type PlateData,
} from "../NamePlate.js";
import { namePlateFrameHost, setNamePlateFrameHost, type NamePlateFrameHost } from "./NamePlateFrameSlot.js";
import {
  FrameXmlNamePlatePool,
  frameXmlNamePlateState,
  type FrameXmlNamePlateEntry,
} from "./framexml_compat/FrameXmlNamePlatePool.js";
import type { FrameXmlUiBridge } from "./framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "./framexml_compat/FrameXmlTypes.js";

/** What the renderer offers the pool (FrameXmlDomRenderer). */
export interface NamePlateFrameRenderer {
  placeMovedFrames(frames: readonly FrameXmlFrame[]): number;
  stackSiblings(frames: readonly FrameXmlFrame[]): number;
}

/** 0x0061a4f0's table: what a threat status lights the flash with (the canvas's THREAT_COLOURS). */
const THREAT_FLASH: Readonly<Record<number, number>> = { 2: 0xff9900, 3: 0xff0000 };

/** `hsl(h, s%, l%)` (UnitSnapshot's colour for a class no table knows) → 0xRRGGBB. */
function hslColour(text: string): number | undefined {
  const match = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(text);
  if (!match) return undefined;
  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    return Math.round(v * 255);
  };
  return (channel(h + 1 / 3) << 16) | (channel(h) << 8) | channel(h - 1 / 3);
}

/** "#rrggbb" → 0xRRGGBB, kept: the plate colours are a handful of strings. */
const packed = new Map<string, number>();
function packColour(hex: string): number {
  let value = packed.get(hex);
  if (value === undefined) {
    value = /^#[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex.slice(1), 16) : hslColour(hex) ?? 0xffffff;
    packed.set(hex, value);
  }
  return value;
}

/** The plate frame's state from the scene's plate data, written into `entry.state` (reused, nothing allocated). */
export function fillNamePlateEntry(entry: FrameXmlNamePlateEntry, data: PlateData): void {
  const state = entry.state;
  entry.guid = data.guid;
  state.name = data.name;
  state.level = data.level;
  state.levelColour = data.level === undefined ? 0xffff00 : packColour(plateLevelColour(data.level, data.playerLevel));
  state.skull = plateShowsSkull(data);
  state.elite = plateShowsElite(data);
  state.barColour = packColour(plateColour(data));
  if (data.healthValue !== undefined && data.healthMax !== undefined && data.healthMax > 0) {
    state.health = data.healthValue;
    state.healthMax = data.healthMax;
  } else if (data.health !== undefined) {
    // Only the ratio is known: a bar of 1 holds it.
    state.health = data.health;
    state.healthMax = 1;
  } else {
    state.health = undefined;
    state.healthMax = undefined;
  }
  state.raidMark = data.raidMark;
  state.flashColour = data.threat === undefined ? undefined : THREAT_FLASH[data.threat];
  state.hovered = data.hovered === true;
  state.target = data.target;
  state.dimmed = data.dimmed === true;
  const cast = data.cast;
  state.cast = cast !== undefined;
  state.castIcon = cast?.iconPath === undefined ? undefined : cast.iconPath.replace(/\.blp$/i, "");
  state.castShielded = cast?.shielded === true;
  const seconds = cast?.seconds !== undefined && cast.seconds > 0 ? cast.seconds : 1;
  state.castMax = cast ? seconds : 0;
  state.castValue = cast ? Math.max(0, Math.min(1, cast.progress)) * seconds : 0;
}

/** The units of WorldFrame per overlay pixel: its 768 units over the screen's height, at the interface scale. */
export function worldFrameUnitsPerPixel(height: number, uiScale: number): number {
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 100;
  return height > 0 ? (768 * 100 / scale) / height : 0;
}

/** A host over one bridge's WorldFrame; `renderer` places the plates that only moved. */
export function createNamePlateFrameHost(options: {
  readonly bridge: FrameXmlUiBridge;
  readonly worldFrame: FrameXmlFrame;
  readonly renderer?: NamePlateFrameRenderer;
  readonly fontFile?: string;
  /** The interface scale in percent (the `uiScale` setting), which sizes WorldFrame's units; 100 without one. */
  readonly uiScale?: () => number;
}): NamePlateFrameHost & { readonly pool: FrameXmlNamePlatePool } {
  const renderer = options.renderer;
  const pool = new FrameXmlNamePlatePool(options.bridge, options.worldFrame, {
    ...(options.fontFile ? { fontFile: options.fontFile } : {}),
    ...(renderer ? {
      placeMoved: (frames: readonly FrameXmlFrame[]) => { renderer.placeMovedFrames(frames); },
      stack: (frames: readonly FrameXmlFrame[]) => { renderer.stackSiblings(frames); },
    } : {}),
  });
  const entries: FrameXmlNamePlateEntry[] = [];
  return {
    pool,
    present(plates, width, height) {
      const units = worldFrameUnitsPerPixel(height, options.uiScale?.() ?? 100);
      for (let index = 0; index < plates.length; index += 1) {
        const plate = plates[index]!;
        let entry = entries[index];
        if (!entry) {
          entry = { guid: 0n, x: 0, y: 0, state: frameXmlNamePlateState() };
          entries.push(entry);
        }
        fillNamePlateEntry(entry, plate.data);
        // TOP on WorldFrame's BOTTOMLEFT: the box's top middle, measured up from the bottom.
        entry.x = (plate.box.x + plate.box.width / 2) * units;
        entry.y = (height - plate.box.y) * units;
      }
      pool.present(entries, plates.length);
    },
    clear() {
      pool.clear();
    },
  };
}

/**
 * Register the plates of a mounted FrameXML world: its `WorldFrame`, its renderer, and NAMEPLATE_FONT as its
 * GlobalStrings answer it (0x0098f790 asks 0x00819d40("NAMEPLATE_FONT")). Answers the cleanup; nothing is registered
 * without a WorldFrame (a vertical without WorldFrame.xml), and the canvas keeps painting the plates.
 */
export function installNamePlateFrames(
  bridge: FrameXmlUiBridge,
  fontGlobal: unknown,
  renderer: NamePlateFrameRenderer,
  uiScale: () => number,
): () => void {
  const worldFrame = bridge.getFrame("WorldFrame");
  if (!worldFrame) return () => {};
  const host = createNamePlateFrameHost({
    bridge, worldFrame, renderer, uiScale,
    ...(typeof fontGlobal === "string" && fontGlobal.trim() ? { fontFile: fontGlobal } : {}),
  });
  setNamePlateFrameHost(host);
  return () => { if (namePlateFrameHost() === host) setNamePlateFrameHost(undefined); };
}
