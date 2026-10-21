/**
 * 22.10 ARC-2 S3b: the portraits' traffic between the page and the world renderer, as plain data.
 *
 * The page keeps every portrait canvas (ui/Portraits.ts, framexml/FrameXmlPortraits.ts) and names each by a
 * number (PortraitCanvasBridge.ts). The renderer gets, per slot, that number and what it used to read off the
 * canvas — the backing-store size, the stock-ground mark, the ready flag — and hands back an ordered list of
 * canvas operations in RenderResults.ts: blank this canvas, put these pixels on it. Structured-clonable: Maps of
 * strings to plain records, numbers, bigints, strings and one Uint8ClampedArray per paint.
 */

import type { PortraitSlot, StockPortraitSlot } from "./PortraitRenderer.js";

/** One slot's output as the page saw it when it pushed the targets (`syncPortraitTargets`). */
export interface PortraitTargetInput {
  guid: bigint | undefined;
  /** The page's id of the canvas (PortraitCanvasBridge.ts); undefined without one. */
  canvas: number | undefined;
  /** `canvas.width`/`canvas.height` as they were, 0 included (the renderer keeps its `|| 96`). */
  width: number;
  height: number;
  /** Was `PortraitTarget.visible`: false while the window is closed; omitted means shown. */
  visible?: boolean;
  /** Was `canvas.dataset[PORTRAIT_STOCK_GROUND] === "true"`. */
  stockGround: boolean;
  /** Was `canvas.dataset.portraitReady`, any value (an adoption cleanup may restore "native-state"). */
  ready: string | undefined;
}

/** A paint the page could not put on its canvas: the canvas changed size meanwhile, or has no 2D context. */
export interface PortraitPaintRejection {
  slot: PortraitSlot;
  canvas: number;
  guid: bigint;
}

export interface PortraitTargetInputs {
  /** The fixed slots (`ALL_PORTRAIT_SLOTS`); a slot missing here has no target. */
  targets: ReadonlyMap<PortraitSlot, PortraitTargetInput>;
  /** The stock window set (`StockPortraitTargets`) and its version; the renderer re-reads it on a new version. */
  stock: ReadonlyMap<StockPortraitSlot, PortraitTargetInput>;
  stockVersion: number;
  /** Paints refused since the last push; the renderer marks those surfaces dirty, as its own failed paint did. */
  rejected: readonly PortraitPaintRejection[];
}

/**
 * Blank a canvas: `clearRect`, then — `pending` — the black disc of a stock picture still loading, and
 * `portraitReady = "false"`. `keepIfBlank`: skipped when the page's last operation on that canvas was a blank and
 * its flag still says "false" (the old `#blankCanvases` test). `keepIfPainted`: skipped when the canvas's last paint
 * was that guid (a stock window reopened on the same unit).
 */
export interface PortraitClearOutput {
  kind: "clear";
  canvas: number;
  pending: boolean;
  keepIfBlank: boolean;
  keepIfPainted: bigint | undefined;
}

/** Put a finished readback on a canvas: rows top-down, display sRGB, alpha as painted. */
export interface PortraitPaintOutput {
  kind: "paint";
  canvas: number;
  slot: PortraitSlot;
  guid: bigint;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export type PortraitOutput = PortraitClearOutput | PortraitPaintOutput;

export const NO_PORTRAIT_TARGET_INPUTS: PortraitTargetInputs = Object.freeze({
  targets: new Map(), stock: new Map(), stockVersion: 0, rejected: Object.freeze([]),
});

function cloneInput(input: PortraitTargetInput): PortraitTargetInput {
  return { ...input };
}

/** A copy the pusher may not mutate afterwards (the bridge reuses its records frame to frame). */
export function clonePortraitTargetInputs(inputs: PortraitTargetInputs): PortraitTargetInputs {
  const targets = new Map<PortraitSlot, PortraitTargetInput>();
  for (const [slot, input] of inputs.targets) targets.set(slot, cloneInput(input));
  const stock = new Map<StockPortraitSlot, PortraitTargetInput>();
  for (const [slot, input] of inputs.stock) stock.set(slot, cloneInput(input));
  return { targets, stock, stockVersion: inputs.stockVersion, rejected: inputs.rejected.map((entry) => ({ ...entry })) };
}
