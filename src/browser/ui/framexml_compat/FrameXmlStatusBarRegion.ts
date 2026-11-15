/**
 * plates12 (15.11, plan items 6.37 and 3.21): a StatusBar whose fill is a real Texture region, as Wow.exe's
 * CSimpleStatusBar keeps one — `GetStatusBarTexture()` answers that Texture, `GetRegions()` lists it, and add-ons
 * restyle it (`bar:GetStatusBarTexture():SetTexture(...)`, a spark anchored to its RIGHT).
 *
 * The name plate's two bars are built this way (FrameXmlNamePlateFrame.ts; the stand's recording
 * `F:\WowOracle\runs\plates-probe3.txt` lists, for every plate bar, exactly one region — the bar texture — and its path
 * `UI-TargetingFrame-BarFill`). The texture is anchored TOPLEFT/BOTTOMLEFT on its bar and as wide as the bar's value
 * makes it, its picture cut at the same fraction rather than squeezed (measured 03.11, nameplates-original.ru.md), and
 * the bar's colour is its vertex colour.
 *
 * The bar pushes onto its texture only what the bar itself changed — its value or range (the cut and the width), its
 * colour, its picture, its orientation — so what an add-on sets on the texture directly stays until the bar changes
 * that same thing, as in the original where the texture is the only place the picture lives.
 *
 * Every other StatusBar keeps the renderer's private fill (`FrameXmlDomRenderer.applyStatusBar`) and answers its texture
 * path, as before: giving all of them a region would change `GetRegions` of every stock bar, which is a wider change
 * than this item. A linked bar draws no private fill (the renderer asks `frameXmlStatusBarRegion`).
 */
import type { FrameXmlUiBridge } from "./FrameXmlRuntime.js";
import type { FrameXmlColor, FrameXmlFrame, FrameXmlTexCoords } from "./FrameXmlTypes.js";

/** What the bar last laid on its texture. */
interface Laid {
  readonly texture: FrameXmlFrame;
  fraction: number;
  length: number;
  vertical: boolean | undefined;
  colour: FrameXmlColor | undefined;
  path: string | undefined;
}

const regions = new WeakMap<FrameXmlFrame, Laid>();

/** The Texture region that is `bar`'s fill, when the bar has one. */
export function frameXmlStatusBarRegion(bar: FrameXmlFrame): FrameXmlFrame | undefined {
  return regions.get(bar)?.texture;
}

/** Make `texture` (a Texture child of `bar`) the bar's fill and lay it on the bar's state at once. */
export function linkFrameXmlStatusBarRegion(bridge: FrameXmlUiBridge, bar: FrameXmlFrame, texture: FrameXmlFrame): void {
  regions.set(bar, { texture, fraction: Number.NaN, length: Number.NaN, vertical: undefined, colour: undefined, path: undefined });
  syncFrameXmlStatusBarRegion(bridge, bar);
}

/** The fraction of the bar the value fills, 0 to 1; 0 for an empty or unset range. */
export function frameXmlStatusBarFraction(bar: FrameXmlFrame): number {
  const { min, max, value } = bar.statusBar;
  const range = max - min;
  if (!(range > 0) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, (value - min) / range));
}

/**
 * Lay the linked texture on what changed in the bar since the last call; answers whether anything was written.
 * Nothing is written, and nothing allocated, when the bar did not change.
 *
 * A new cut is announced as paint: the renderer re-places a texture whose texcoords changed, so the width written with
 * it is applied with it, and nothing but the bar's own fill moves. A new length with the same cut (the bar resized) is
 * a layout change.
 */
export function syncFrameXmlStatusBarRegion(bridge: FrameXmlUiBridge, bar: FrameXmlFrame): boolean {
  const laid = regions.get(bar);
  const texture = laid?.texture;
  if (!laid || !texture || texture.parent !== bar) return false;
  const vertical = bar.statusBar.orientation === "VERTICAL";
  let changed = false;
  if (laid.vertical !== vertical) {
    // The anchors: the bar's left edge (its bottom edge upright), whole across the other axis.
    const first = vertical ? "BOTTOMLEFT" : "TOPLEFT";
    const second = vertical ? "BOTTOMRIGHT" : "BOTTOMLEFT";
    bridge.ClearAllPoints(texture);
    bridge.SetPoint(texture, first, bar, first, 0, 0);
    bridge.SetPoint(texture, second, bar, second, 0, 0);
    laid.vertical = vertical;
    laid.fraction = Number.NaN;
    changed = true;
  }
  const fraction = frameXmlStatusBarFraction(bar);
  const along = Number(bar.attributes[vertical ? "height" : "width"]);
  const length = (Number.isFinite(along) ? along : 0) * fraction;
  if (fraction !== laid.fraction || length !== laid.length) {
    const cut = fraction !== laid.fraction;
    const next: FrameXmlTexCoords = vertical
      ? { left: 0, right: 1, top: 1 - fraction, bottom: 1 }
      : { left: 0, right: fraction, top: 0, bottom: 1 };
    bridge.update(texture, (m) => {
      if (cut) m.texCoords = next;
      m.setAttribute(vertical ? "height" : "width", String(length));
    }, cut ? "paint" : "layout");
    laid.fraction = fraction;
    laid.length = length;
    changed = true;
  }
  const colour = bar.statusBar.color;
  if (colour !== laid.colour) {
    laid.colour = colour;
    const known = texture.vertexColor;
    if (!known || known.r !== colour.r || known.g !== colour.g || known.b !== colour.b || known.a !== colour.a) {
      bridge.update(texture, (m) => { m.vertexColor = colour; }, "paint");
      changed = true;
    }
  }
  const path = bar.statusBar.texture;
  if (path !== laid.path) {
    laid.path = path;
    if (texture.texture !== path || texture.colorFill) {
      bridge.SetTexture(texture, path);
      changed = true;
    }
  }
  return changed;
}
