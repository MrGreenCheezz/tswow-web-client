/**
 * 22.10 ARC-2 S3b: the page's half of the portraits. It owns every portrait canvas the renderer used to hold —
 * the HUD rows' slot map (ui/Portraits.ts) and the stock windows' registry (FrameXML `SetPortraitTexture`) — turns
 * them into PortraitTargetData.ts inputs, and applies the renderer's canvas operations from RenderResults.ts with
 * exactly the 2D calls and dataset writes PortraitRenderer.ts made itself before.
 */

import { portraitCircleMask, type PortraitSlot, type StockPortraitSlot } from "./PortraitRenderer.js";
import type {
  PortraitClearOutput, PortraitOutput, PortraitPaintOutput, PortraitPaintRejection, PortraitTargetInput,
  PortraitTargetInputs,
} from "./PortraitTargetData.js";

/**
 * 13.10: the dataset mark of a HUD row's canvas that a stock unit frame borrowed (ui/Portraits.ts
 * `adoptPortraitCanvas`: PlayerPortrait, TargetFramePortrait, FocusFramePortrait, PetPortrait, the
 * party and ToT rows). Stock UnitFrame_Update paints those with SetPortraitTexture too, so they are
 * the same picture — black ground in the circle — and their frame art has the same transparent hole
 * under the Texture: with the HUD's transparent ground the owner saw the world through the ring
 * around the head. The native frames keep the transparent ground their styled backgrounds need.
 */
export const PORTRAIT_STOCK_GROUND = "portraitStockGround";

/** One slot's DOM output, as the page's modules set it. */
export interface PortraitTarget {
  guid: bigint | undefined;
  canvas: HTMLCanvasElement | undefined;
  /**
   * False while the canvas is off screen — its window closed. Omitted means shown, which is what
   * the HUD rows always are. A hidden target is neither rebuilt nor drawn (PortraitRenderer.ts).
   */
  visible?: boolean;
}

/**
 * Host-owned stock portrait targets, pushed to the world's PortraitRenderer with the HUD rows.
 *
 * The HUD's fixed slots arrive as one map from ui/Portraits.ts every frame. Stock window portraits
 * are claimed by FrameXML's `SetPortraitTexture` bridge instead, and must not require that module
 * (or WorldRenderer3D) to know every window's texture. A write that changes nothing does not bump
 * the version, so the renderer's per-frame cost for an unchanged set is one integer compare.
 */
export class StockPortraitTargets {
  readonly #targets = new Map<StockPortraitSlot, PortraitTarget>();
  #version = 0;

  get version(): number {
    return this.#version;
  }

  get size(): number {
    return this.#targets.size;
  }

  get(slot: StockPortraitSlot): PortraitTarget | undefined {
    return this.#targets.get(slot);
  }

  entries(): ReadonlyMap<StockPortraitSlot, PortraitTarget> {
    return this.#targets;
  }

  set(slot: StockPortraitSlot, guid: bigint | undefined, canvas: HTMLCanvasElement | undefined): void {
    const previous = this.#targets.get(slot);
    if (previous && previous.guid === guid && previous.canvas === canvas) return;
    this.#targets.set(slot, { guid, canvas });
    this.#version++;
  }

  delete(slot: StockPortraitSlot): void {
    if (this.#targets.delete(slot)) this.#version++;
  }
}

const NO_REJECTIONS: readonly PortraitPaintRejection[] = Object.freeze([]);

/** The live client's single set; tests hand a bridge their own instance. */
export const stockPortraitTargets = new StockPortraitTargets();

/**
 * Canvas ids, the pushed inputs and the operations' painter for one PortraitRenderer. The input records are
 * reused frame to frame (a frame allocates nothing for an unchanged set); the renderer copies what it keeps.
 */
export class PortraitCanvasBridge {
  readonly #stock: StockPortraitTargets;
  readonly #ids = new WeakMap<HTMLCanvasElement, number>();
  /** Id to canvas; a WeakRef so a dropped window's canvas is not kept alive by its number. */
  readonly #canvases = new Map<number, WeakRef<HTMLCanvasElement>>();
  #nextId = 1;
  /** Was PortraitRenderer `#blankCanvases`: canvases blanked and not painted since. */
  readonly #blank = new WeakSet<HTMLCanvasElement>();
  /** Was PortraitRenderer `#paintedGuids`: the guid whose picture each canvas holds from its last paint. */
  readonly #painted = new WeakMap<HTMLCanvasElement, bigint>();
  readonly #fixed = new Map<PortraitSlot, PortraitTargetInput>();
  readonly #stockInputs = new Map<StockPortraitSlot, PortraitTargetInput>();
  #rejected: PortraitPaintRejection[] = [];
  /** The record every push returns, its version and rejections rewritten in place. */
  readonly #inputs: { -readonly [K in keyof PortraitTargetInputs]: PortraitTargetInputs[K] };

  constructor(stock: StockPortraitTargets = stockPortraitTargets) {
    this.#stock = stock;
    this.#inputs = { targets: this.#fixed, stock: this.#stockInputs, stockVersion: stock.version, rejected: NO_REJECTIONS };
  }

  /** The canvas's id, made on first use and stable for its lifetime. */
  canvasId(canvas: HTMLCanvasElement): number {
    let id = this.#ids.get(canvas);
    if (id === undefined) {
      id = this.#nextId++;
      this.#ids.set(canvas, id);
      this.#canvases.set(id, new WeakRef(canvas));
      // Now and then forget the numbers of canvases that are gone (stock windows make one per claim).
      if (id % 64 === 0) for (const [known, ref] of this.#canvases) if (ref.deref() === undefined) this.#canvases.delete(known);
    }
    return id;
  }

  /**
   * This frame's inputs: the fixed slots from `targets`, the stock set from the registry, the paints refused
   * since the last call (handed over once). Read the DOM now; the renderer reads nothing of it later.
   */
  inputs(targets: ReadonlyMap<PortraitSlot, PortraitTarget>): PortraitTargetInputs {
    const fixed = this.#fixed;
    for (const slot of fixed.keys()) if (!targets.has(slot)) fixed.delete(slot);
    for (const [slot, target] of targets) fixed.set(slot, this.#input(fixed.get(slot), target));
    const stock = this.#stockInputs;
    const entries = this.#stock.entries();
    for (const slot of stock.keys()) if (!entries.has(slot)) stock.delete(slot);
    for (const [slot, target] of entries) stock.set(slot, this.#input(stock.get(slot), target));
    const inputs = this.#inputs;
    inputs.stockVersion = this.#stock.version;
    // Handed over with this push; the next one starts empty.
    inputs.rejected = this.#rejected.length > 0 ? this.#rejected : NO_REJECTIONS;
    if (this.#rejected.length > 0) this.#rejected = [];
    return inputs;
  }

  #input(record: PortraitTargetInput | undefined, target: PortraitTarget): PortraitTargetInput {
    const canvas = target.canvas;
    const next = record ?? { guid: undefined, canvas: undefined, width: 0, height: 0, stockGround: false, ready: undefined };
    next.guid = target.guid;
    next.canvas = canvas === undefined ? undefined : this.canvasId(canvas);
    next.width = canvas?.width ?? 0;
    next.height = canvas?.height ?? 0;
    if (target.visible === undefined) delete next.visible;
    else next.visible = target.visible;
    next.stockGround = canvas?.dataset[PORTRAIT_STOCK_GROUND] === "true";
    next.ready = canvas?.dataset["portraitReady"];
    return next;
  }

  /** Applies and empties the renderer's queued operations, in order. */
  drain(outputs: PortraitOutput[]): void {
    if (outputs.length === 0) return;
    // Taken first: an operation's own side effects cannot re-enter this list.
    const queued = outputs.splice(0, outputs.length);
    for (const output of queued) {
      const canvas = this.#canvases.get(output.canvas)?.deref();
      if (canvas === undefined) continue;
      if (output.kind === "clear") this.#clear(canvas, output);
      else this.#paint(canvas, output);
    }
  }

  #clear(canvas: HTMLCanvasElement, output: PortraitClearOutput): void {
    if (output.keepIfBlank && this.#blank.has(canvas) && canvas.dataset["portraitReady"] === "false") return;
    if (output.keepIfPainted !== undefined && this.#painted.get(canvas) === output.keepIfPainted) return;
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
    if (output.pending && context && canvas.width > 0 && canvas.height > 0) {
      // Colour 0 is the picture's black ground; the alpha is the same circle a readback gets.
      const mask = portraitCircleMask(canvas.width, canvas.height);
      const image = context.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < mask.length; index++) image.data[index * 4 + 3] = mask[index]!;
      context.putImageData(image, 0, 0);
    }
    canvas.dataset["portraitReady"] = "false";
    this.#blank.add(canvas);
    this.#painted.delete(canvas);
  }

  #paint(canvas: HTMLCanvasElement, output: PortraitPaintOutput): void {
    const { width, height } = output;
    // The renderer checked the size the page last pushed; the canvas may have been measured again since.
    let context: CanvasRenderingContext2D | null = null;
    try {
      if (Math.max(1, canvas.width || 96) === width && Math.max(1, canvas.height || 96) === height) {
        context = canvas.getContext("2d");
      }
      if (!context) {
        this.#reject(output);
        return;
      }
      const image = context.createImageData(width, height);
      image.data.set(output.pixels);
      context.putImageData(image, 0, 0);
    } catch {
      // An unavailable 2D canvas leaves the existing fallback intact; the renderer retries.
      this.#reject(output);
      return;
    }
    this.#blank.delete(canvas);
    this.#painted.set(canvas, output.guid);
    canvas.dataset["portraitReady"] = "true";
    canvas.dataset["portraitSlot"] = output.slot;
  }

  #reject(output: PortraitPaintOutput): void {
    this.#rejected.push({ slot: output.slot, canvas: output.canvas, guid: output.guid });
  }
}
