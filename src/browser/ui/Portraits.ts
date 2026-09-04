import {
  CHARACTER_PORTRAIT_SLOT, PAPERDOLL_PORTRAIT_SLOT, PARTY_PORTRAIT_SLOTS,
  type PortraitSlot, type PortraitTarget,
} from "../PortraitRenderer.js";
import {
  HUD_PORTRAIT_CSS_PIXELS, portraitCanvasBackingPixels, setPortraitCanvasBackingStore,
} from "../PortraitCanvas.js";
import type { WorldRenderer3D } from "../WorldRenderer3D.js";
import { game } from "../game/Context.js";
import {
  focusFrame, partyFrames, petFrame, playerIcon, targetIcon, targetOfTargetFrame, targetPanel,
} from "./Dom.js";
import type { UnitFrame } from "./UnitFrame.js";

const playerCanvas = ensureCanvas(playerIcon, "player");
const targetCanvas = ensureCanvas(targetIcon, "target");
const targets = new Map<PortraitSlot, PortraitTarget>();
let paperdollCanvas: HTMLCanvasElement | undefined;
let characterFrameCanvas: HTMLCanvasElement | undefined;

/** Stock Interface\FrameXML CharacterModelFrame dimensions, in FrameXML layout units. */
export const CHARACTER_MODEL_CSS_WIDTH = 233;
export const CHARACTER_MODEL_CSS_HEIGHT = 215;

interface CharacterPortraitAdoption {
  readonly canvas: HTMLCanvasElement;
  readonly target: HTMLElement;
  readonly styles: Readonly<Record<AdoptedStyleName, string | undefined>>;
  readonly className: string;
  readonly hidden: boolean;
  readonly dataset: Readonly<Record<string, string>>;
  readonly width: number;
  readonly height: number;
  readonly parent: HTMLElement | null;
  readonly nextSibling: Node | null;
  resizeObserver: ResizeObserver | undefined;
  cleaned: boolean;
  cleanup: () => void;
}

let activeCharacterPortraitAdoption: CharacterPortraitAdoption | undefined;

const ADOPTED_STYLE_NAMES = [
  "display", "position", "left", "right", "top", "bottom", "width", "height", "transform",
  "transformOrigin", "zIndex", "opacity", "visibility", "pointerEvents", "borderRadius",
  "backgroundColor", "overflow",
] as const;
type AdoptedStyleName = typeof ADOPTED_STYLE_NAMES[number];

interface PortraitCanvasAdoption {
  readonly slot: PortraitSlot;
  readonly canvas: HTMLCanvasElement;
  readonly target: HTMLElement;
  readonly nativeParent: HTMLElement;
  readonly nativeNextSibling: Node | null;
  readonly styles: Readonly<Record<AdoptedStyleName, string | undefined>>;
  readonly className: string;
  readonly hidden: boolean;
  readonly dataset: Readonly<Record<string, string>>;
  readonly width: number;
  readonly height: number;
  cleaned: boolean;
  cleanup: () => void;
}

interface CharacterPortraitCanvasAdoption {
  readonly canvas: HTMLCanvasElement;
  readonly target: HTMLElement;
  readonly parent: HTMLElement;
  readonly nextSibling: Node | null;
  readonly styles: Readonly<Record<AdoptedStyleName, string | undefined>>;
  readonly className: string;
  readonly hidden: boolean;
  readonly dataset: Readonly<Record<string, string>>;
  readonly width: number;
  readonly height: number;
  readonly created: boolean;
  cleaned: boolean;
  cleanup: () => void;
}

const activePortraitAdoptions = new Map<PortraitSlot, PortraitCanvasAdoption>();
const activeCharacterFramePortraitAdoption = new Map<PortraitSlot, CharacterPortraitCanvasAdoption>();

function ensureCanvas(image: HTMLImageElement, slot: PortraitSlot): HTMLCanvasElement {
  const existing = image.parentElement?.querySelector<HTMLCanvasElement>(`canvas[data-portrait-slot="${slot}"]`);
  const canvas = existing ?? document.createElement("canvas");
  if (!existing) {
    canvas.className = "portrait-canvas";
    canvas.dataset["portraitSlot"] = slot;
  }
  setPortraitCanvasBackingStore(canvas, HUD_PORTRAIT_CSS_PIXELS);
  canvas.dataset["portraitReady"] = "false";
  if (!existing) image.parentElement?.insertBefore(canvas, image);
  return canvas;
}

function readStyle(style: CSSStyleDeclaration, name: AdoptedStyleName): string | undefined {
  const value = (style as unknown as Record<string, string>)[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function writeStyle(style: CSSStyleDeclaration, name: AdoptedStyleName, value: string | undefined): void {
  const mutable = style as unknown as Record<string, string>;
  if (value !== undefined) {
    mutable[name] = value;
    return;
  }
  // CSSStyleDeclaration exposes an empty string for an absent property, while the DOM-free test
  // seam may expose `undefined`. Remove both spellings so cleanup restores the authored state in
  // either representation instead of leaving a synthetic inline declaration behind.
  if (typeof style.removeProperty === "function") {
    const cssName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    style.removeProperty(cssName);
    style.removeProperty(name);
  } else {
    delete mutable[name];
  }
}

function numericCssPixels(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/i.exec(value);
  if (!match) return undefined;
  const pixels = Number(match[1]);
  return Number.isFinite(pixels) && pixels > 0 ? pixels : undefined;
}

function restoreDataset(canvas: HTMLCanvasElement, dataset: Readonly<Record<string, string>>): void {
  const mutable = canvas.dataset as unknown as Record<string, string | undefined>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, dataset);
}

function restorePortraitCanvasAdoption(record: PortraitCanvasAdoption): void {
  if (record.cleaned) return;
  record.cleaned = true;
  if (activePortraitAdoptions.get(record.slot) === record) activePortraitAdoptions.delete(record.slot);

  for (const name of ADOPTED_STYLE_NAMES) writeStyle(record.canvas.style, name, record.styles[name]);
  record.canvas.className = record.className;
  record.canvas.hidden = record.hidden;
  restoreDataset(record.canvas, record.dataset);
  // Assigning an unchanged canvas dimension erases its pixels without invalidating the renderer's
  // same-size surface. A plain reparent must keep the last readback intact.
  if (record.canvas.width !== record.width) record.canvas.width = record.width;
  if (record.canvas.height !== record.height) record.canvas.height = record.height;

  const sibling = record.nativeNextSibling;
  if (sibling && sibling.parentNode === record.nativeParent) {
    record.nativeParent.insertBefore(record.canvas, sibling);
  } else {
    record.nativeParent.append(record.canvas);
  }
}

function restoreCharacterPortraitAdoption(record: CharacterPortraitAdoption): void {
  if (record.cleaned) return;
  record.cleaned = true;
  // The observer belongs to this adoption, not to the global portrait renderer. Disconnect before
  // restoring the old canvas dimensions so a pending callback cannot re-register a dead target.
  record.resizeObserver?.disconnect();
  record.resizeObserver = undefined;
  if (activeCharacterPortraitAdoption === record) activeCharacterPortraitAdoption = undefined;
  if (paperdollCanvas === record.canvas) paperdollCanvas = undefined;
  set("paperdoll", undefined, undefined);
  for (const name of ADOPTED_STYLE_NAMES) writeStyle(record.canvas.style, name, record.styles[name]);
  record.canvas.className = record.className;
  record.canvas.hidden = record.hidden;
  restoreDataset(record.canvas, record.dataset);
  record.canvas.width = record.width;
  record.canvas.height = record.height;
  if (record.parent && record.nextSibling?.parentNode === record.parent) {
    record.parent.insertBefore(record.canvas, record.nextSibling);
  } else if (record.parent) {
    record.parent.append(record.canvas);
  } else {
    record.canvas.remove();
  }
}

function restoreCharacterFramePortraitAdoption(record: CharacterPortraitCanvasAdoption): void {
  if (record.cleaned) return;
  record.cleaned = true;
  if (activeCharacterFramePortraitAdoption.get(CHARACTER_PORTRAIT_SLOT)?.canvas === record.canvas) {
    activeCharacterFramePortraitAdoption.delete(CHARACTER_PORTRAIT_SLOT);
  }
  if (characterFrameCanvas === record.canvas) characterFrameCanvas = undefined;
  set(CHARACTER_PORTRAIT_SLOT, undefined, undefined);
  if (record.created) {
    record.canvas.remove();
    return;
  }
  for (const name of ADOPTED_STYLE_NAMES) writeStyle(record.canvas.style, name, record.styles[name]);
  record.canvas.className = record.className;
  record.canvas.hidden = record.hidden;
  restoreDataset(record.canvas, record.dataset);
  record.canvas.width = record.width;
  record.canvas.height = record.height;
  if (record.nextSibling?.parentNode === record.parent) record.parent.insertBefore(record.canvas, record.nextSibling);
  else record.parent.append(record.canvas);
}

/**
 * Adopt a persistent 2D canvas into stock CharacterModelFrame.
 *
 * This is intentionally a DOM operation only. The canvas is registered as the paperdoll target
 * and the existing PortraitRenderer paints it through the world's renderer on dirty changes.
 */
export function adoptCharacterPortraitCanvas(
  target: HTMLElement | undefined,
  cssWidth?: number,
  cssHeight?: number,
): (() => void) | undefined {
  if (!target || (
    target.getAttribute("data-framexml-model-placeholder") !== "true"
    && target.getAttribute("data-portrait-model-placeholder") !== "true"
  )) return undefined;
  const active = activeCharacterPortraitAdoption;
  if (active?.target === target) return active.cleanup;
  active?.cleanup();

  const existing = target.querySelector<HTMLCanvasElement>(
    `canvas[data-portrait-slot="${PAPERDOLL_PORTRAIT_SLOT}"]`,
  );
  const canvas = existing ?? document.createElement("canvas");
  const parent = canvas.parentElement;
  const record = {
    canvas,
    target,
    styles: Object.fromEntries(
      ADOPTED_STYLE_NAMES.map((name) => [name, readStyle(canvas.style, name)]),
    ) as Record<AdoptedStyleName, string | undefined>,
    className: canvas.className,
    hidden: canvas.hidden,
    dataset: { ...canvas.dataset },
    width: canvas.width,
    height: canvas.height,
    parent,
    nextSibling: canvas.nextSibling,
    resizeObserver: undefined,
    cleaned: false,
    cleanup: () => {},
  } as CharacterPortraitAdoption;
  record.cleanup = () => restoreCharacterPortraitAdoption(record);

  try {
    if (!existing) target.append(canvas);
    canvas.className = "portrait-canvas portrait-canvas-paperdoll";
    canvas.dataset["portraitSlot"] = PAPERDOLL_PORTRAIT_SLOT;
    canvas.dataset["portraitReady"] = "false";
    canvas.hidden = false;
    writeStyle(canvas.style, "position", "absolute");
    writeStyle(canvas.style, "left", "0");
    writeStyle(canvas.style, "top", "0");
    writeStyle(canvas.style, "width", "100%");
    writeStyle(canvas.style, "height", "100%");
    writeStyle(canvas.style, "display", "block");
    writeStyle(canvas.style, "pointerEvents", "none");
    // Unlike HUD portraits this target is intentionally rectangular. Keep its WebGL aspect equal
    // to the authored CharacterModelFrame box rather than forcing a square backing store. The
    // gate supplies measured FrameXML dimensions when available; direct callers can still use
    // live layout/style values, with the exact stock box as a hidden-layout fallback.
    const size = characterPortraitCanvasSize(target, cssWidth, cssHeight);
    canvas.width = portraitCanvasBackingPixels(size.width);
    canvas.height = portraitCanvasBackingPixels(size.height);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (record.cleaned || !entry) return;
        // ResizeObserver's content box is the CSS box the canvas fills. `contentRect` is retained
        // as the deterministic fallback used by older browsers and the test seam.
        const box = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
        const width = positiveDimension(box?.inlineSize) ?? positiveDimension(entry.contentRect?.width);
        const height = positiveDimension(box?.blockSize) ?? positiveDimension(entry.contentRect?.height);
        const next = characterPortraitCanvasSize(target, width, height);
        const backingWidth = portraitCanvasBackingPixels(next.width);
        const backingHeight = portraitCanvasBackingPixels(next.height);
        if (canvas.width === backingWidth && canvas.height === backingHeight) return;
        canvas.width = backingWidth;
        canvas.height = backingHeight;
        // Mark the output stale and overwrite the map entry. The next shared renderer sync sees
        // this as a fresh target and performs one correctly-sized static readback.
        canvas.dataset["portraitReady"] = "false";
        set(PAPERDOLL_PORTRAIT_SLOT, game.world?.state.selfGuid, canvas);
      });
      record.resizeObserver = observer;
      observer.observe(target);
    }
  } catch (error) {
    record.cleanup();
    throw error;
  }
  activeCharacterPortraitAdoption = record;
  paperdollCanvas = canvas;
  set(PAPERDOLL_PORTRAIT_SLOT, game.world?.state.selfGuid, canvas);
  return record.cleanup;
}

/** Register the permanent native Character window as the renderer's full-body output. */
export function mountNativeCharacterPortrait(target: HTMLElement | undefined): (() => void) | undefined {
  return adoptCharacterPortraitCanvas(target, 220, 300);
}

/**
 * Adopt one small canvas over the stock `CharacterFramePortrait` Texture.
 *
 * The Texture is an `<img>` in the DOM renderer and therefore cannot own children.  Keeping the
 * authored image in place and inserting this canvas as its next sibling preserves the stock
 * FrameXML anchor/layer while giving the shared PortraitRenderer an actual output for the header
 * bust.  It is a canvas adoption, not a replacement character panel: cleanup restores the exact
 * sibling, style and dataset state and the renderer still owns all model drawing.
 */
export function adoptCharacterFramePortraitCanvas(
  target: HTMLElement | undefined,
): (() => void) | undefined {
  if (!target?.parentElement) return undefined;
  const active = activeCharacterFramePortraitAdoption.get(CHARACTER_PORTRAIT_SLOT);
  if (active?.target === target) return active.cleanup;
  active?.cleanup();

  const parent = target.parentElement;
  const existing = typeof parent.querySelector === "function"
    ? parent.querySelector<HTMLCanvasElement>(
      `canvas[data-portrait-slot="${CHARACTER_PORTRAIT_SLOT}"]`,
    )
    : undefined;
  const canvas = existing ?? document.createElement("canvas");
  const record = {
    canvas,
    target,
    parent,
    nextSibling: canvas.nextSibling,
    styles: Object.fromEntries(
      ADOPTED_STYLE_NAMES.map((name) => [name, readStyle(canvas.style, name)]),
    ) as Record<AdoptedStyleName, string | undefined>,
    className: canvas.className,
    hidden: canvas.hidden,
    dataset: { ...canvas.dataset },
    width: canvas.width,
    height: canvas.height,
    created: !existing,
    cleaned: false,
    cleanup: () => {},
  } as CharacterPortraitCanvasAdoption;
  record.cleanup = () => restoreCharacterFramePortraitAdoption(record);

  try {
    if (!existing) parent.insertBefore(canvas, target.nextSibling);
    canvas.className = "portrait-canvas portrait-canvas-character";
    canvas.dataset["portraitSlot"] = CHARACTER_PORTRAIT_SLOT;
    canvas.dataset["portraitReady"] = "false";
    canvas.hidden = false;
    for (const name of ADOPTED_STYLE_NAMES) writeStyle(canvas.style, name, readStyle(target.style, name));
    if (!readStyle(target.style, "position")) writeStyle(canvas.style, "position", "absolute");
    writeStyle(canvas.style, "display", "block");
    writeStyle(canvas.style, "pointerEvents", "none");
    // CharacterFramePortrait is authored at 60x60.  Use real layout/style pixels where available,
    // but retain that stock size while a hidden FrameXML root has no browser metrics yet.
    const width = (numericCssPixels(readStyle(target.style, "width")) ?? target.offsetWidth) || 60;
    const height = (numericCssPixels(readStyle(target.style, "height")) ?? target.offsetHeight) || 60;
    setPortraitCanvasBackingStore(canvas, Math.max(width, height));
  } catch (error) {
    record.cleanup();
    throw error;
  }
  characterFrameCanvas = canvas;
  activeCharacterFramePortraitAdoption.set(CHARACTER_PORTRAIT_SLOT, record);
  set(CHARACTER_PORTRAIT_SLOT, game.world?.state.selfGuid, canvas);
  return record.cleanup;
}

function positiveDimension(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  // A CSS percentage/calc is not a layout size. Only an explicit px style is safe here;
  // FrameXML attributes and DOM client metrics arrive as numbers through the other branches.
  const match = /^([+]?(?:\d+\.?\d*|\.\d+))px$/i.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function characterPortraitCanvasSize(
  target: HTMLElement,
  width: number | undefined,
  height: number | undefined,
): { width: number; height: number } {
  const candidate = (axis: "width" | "height", explicit: number | undefined, fallback: number): number => {
    const fromArgument = positiveDimension(explicit);
    if (fromArgument !== undefined) return fromArgument;

    const element = target as HTMLElement & { clientWidth?: number; clientHeight?: number };
    const fromClient = positiveDimension(axis === "width" ? element.clientWidth : element.clientHeight);
    if (fromClient !== undefined) return fromClient;

    const fromStyle = positiveDimension(target.style?.[axis]);
    return fromStyle ?? fallback;
  };
  return {
    width: candidate("width", width, CHARACTER_MODEL_CSS_WIDTH),
    height: candidate("height", height, CHARACTER_MODEL_CSS_HEIGHT),
  };
}

export function characterPortraitCanvas(): HTMLCanvasElement | undefined {
  return paperdollCanvas;
}

/**
 * Borrow the existing world portrait canvas for the stock FrameXML PlayerPortrait slot.
 *
 * The canvas belongs to PortraitRenderer already, so this only changes its DOM parent and CSS
 * geometry. No WebGL renderer, readback path or portrait target is created here. A returned cleanup
 * is idempotent and restores the exact native parent, sibling order, inline styles, dataset and
 * DPR-backed dimensions; this is what lets world reset and a later world reuse the same canvas.
 */
function adoptPortraitCanvas(
  slot: PortraitSlot,
  canvas: HTMLCanvasElement,
  target: HTMLElement | undefined,
): (() => void) | undefined {
  const nativeParent = canvas.parentElement;
  const targetParent = target?.parentElement;
  if (!target || !nativeParent || !targetParent || target === canvas) return undefined;
  const active = activePortraitAdoptions.get(slot);
  if (active?.target === target) return active.cleanup;
  active?.cleanup();

  const styles = Object.fromEntries(
    ADOPTED_STYLE_NAMES.map((name) => [name, readStyle(canvas.style, name)]),
  ) as Record<AdoptedStyleName, string | undefined>;
  const record = {
    slot,
    canvas,
    target,
    nativeParent,
    nativeNextSibling: canvas.nextSibling,
    styles,
    className: canvas.className,
    hidden: canvas.hidden,
    dataset: { ...canvas.dataset },
    width: canvas.width,
    height: canvas.height,
    cleaned: false,
    cleanup: () => {},
  } as PortraitCanvasAdoption;
  record.cleanup = () => restorePortraitCanvasAdoption(record);

  try {
    targetParent.insertBefore(canvas, target.nextSibling);
    for (const name of ADOPTED_STYLE_NAMES) writeStyle(canvas.style, name, readStyle(target.style, name));
    if (!readStyle(target.style, "position")) writeStyle(canvas.style, "position", "absolute");
    writeStyle(canvas.style, "display", "block");
    writeStyle(canvas.style, "pointerEvents", "none");
    if (slot === "target") {
      // The native target canvas is styled by `.unit-frame > canvas`, but adoption moves it into
      // FrameXML's TargetFrame. Keep that portrait round and transparent without changing any
      // authored anchor/size; the adoption record restores the original native styles on cleanup.
      writeStyle(canvas.style, "borderRadius", "50%");
      writeStyle(canvas.style, "backgroundColor", "transparent");
      writeStyle(canvas.style, "overflow", "hidden");
    }
    // The authored Texture can be hidden independently (notably when no target exists). The live
    // canvas must remain visible in its slot and rely on a hidden FrameXML ancestor for effective
    // visibility; its prior native hidden state is still restored by the adoption record.
    canvas.hidden = false;

    // Stock portrait slots are square. Read authored px geometry when available so the existing
    // DPR-safe canvas follows a FrameXML 64px portrait instead of retaining the native 58px slot.
    const cssWidth = numericCssPixels(readStyle(target.style, "width")) ?? target.offsetWidth;
    const cssHeight = numericCssPixels(readStyle(target.style, "height")) ?? target.offsetHeight;
    const cssPixels = Number.isFinite(cssWidth) && Number.isFinite(cssHeight)
      && (cssWidth ?? 0) > 0 && (cssHeight ?? 0) > 0
      ? Math.max(cssWidth!, cssHeight!) : undefined;
    if (cssPixels !== undefined) setPortraitCanvasBackingStore(canvas, cssPixels);
  } catch (error) {
    record.cleanup();
    throw error;
  }
  activePortraitAdoptions.set(slot, record);
  return record.cleanup;
}

export function adoptPlayerPortraitCanvas(target: HTMLElement | undefined): (() => void) | undefined {
  return adoptPortraitCanvas("player", playerCanvas, target);
}

/** Borrow the existing target portrait canvas for a stock FrameXML target portrait slot. */
export function adoptTargetPortraitCanvas(target: HTMLElement | undefined): (() => void) | undefined {
  return adoptPortraitCanvas("target", targetCanvas, target);
}

/** Borrow the existing FocusFrame portrait canvas for stock FrameXML's FocusFramePortrait Texture. */
export function adoptFocusPortraitCanvas(target: HTMLElement | undefined): (() => void) | undefined {
  const active = activePortraitAdoptions.get("focus");
  if (active && active.target === target) return active.cleanup;
  const canvas = active?.canvas
    ?? focusFrame.querySelector<HTMLCanvasElement>('canvas[data-portrait-slot="focus"]');
  return canvas ? adoptPortraitCanvas("focus", canvas, target) : undefined;
}

/** Borrow the existing target-of-target canvas for stock TargetFrameToTPortrait. */
export function adoptTargetOfTargetPortraitCanvas(
  target: HTMLElement | undefined,
): (() => void) | undefined {
  const active = activePortraitAdoptions.get("tot");
  if (active && active.target === target) return active.cleanup;
  const canvas = active?.canvas
    ?? targetOfTargetFrame.querySelector<HTMLCanvasElement>('canvas[data-portrait-slot="tot"]');
  return canvas ? adoptPortraitCanvas("tot", canvas, target) : undefined;
}

/** Borrow the existing UnitFrame pet canvas for the stock FrameXML PetPortrait slot. */
export function adoptPetPortraitCanvas(target: HTMLElement | undefined): (() => void) | undefined {
  const active = activePortraitAdoptions.get("pet");
  if (active && active.target === target) return active.cleanup;
  const canvas = active?.canvas
    ?? petFrame.querySelector<HTMLCanvasElement>('canvas[data-portrait-slot="pet"]');
  return canvas ? adoptPortraitCanvas("pet", canvas, target) : undefined;
}

/** Borrow one existing UnitFrame party canvas for its stock PartyMemberFrame portrait Texture. */
export function adoptPartyPortraitCanvas(
  index: number,
  target: HTMLElement | undefined,
): (() => void) | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= PARTY_PORTRAIT_SLOTS.length) return undefined;
  const slot = PARTY_PORTRAIT_SLOTS[index]!;
  const active = activePortraitAdoptions.get(slot);
  if (active && active.target === target) return active.cleanup;
  const canvas = active?.canvas
    ?? partyFrames.querySelector<HTMLCanvasElement>(`canvas[data-portrait-slot="${slot}"]`);
  return canvas ? adoptPortraitCanvas(slot, canvas, target) : undefined;
}

function set(slot: PortraitSlot, guid: bigint | undefined, canvas: HTMLCanvasElement | undefined): void {
  targets.set(slot, { guid, canvas });
  // A target change must expose the normal fallback immediately; the renderer will hide it again
  // only after a successful readback. The player icon's class-painting code may still hide it when
  // no class is known, so the no-guid case is the only one this helper forces on that side.
  if (slot === "player") playerIcon.hidden = guid === undefined;
  if (slot === "target") targetIcon.hidden = guid === undefined;
}

export function setPlayerPortrait(guid: bigint | undefined): void {
  set("player", guid, playerCanvas);
}

export function setTargetPortrait(guid: bigint | undefined): void {
  set("target", guid, targetCanvas);
}

export function setUnitFramePortrait(slot: "focus" | "tot" | "pet", frame: UnitFrame | undefined): void {
  set(slot, frame?.guid, frame?.portraitCanvas);
}

export function setPartyPortrait(index: number, frame: UnitFrame | undefined): void {
  if (!Number.isInteger(index) || index < 0 || index >= PARTY_PORTRAIT_SLOTS.length) return;
  set(PARTY_PORTRAIT_SLOTS[index]!, frame?.guid, frame?.portraitCanvas);
}

export function setPaperdollPortrait(guid: bigint | undefined): void {
  set(PAPERDOLL_PORTRAIT_SLOT, guid, paperdollCanvas);
}

export function setCharacterFramePortrait(guid: bigint | undefined): void {
  set(CHARACTER_PORTRAIT_SLOT, guid, characterFrameCanvas);
}

export function clearPortraitTargets(): void {
  for (const slot of [
    "player", "target", "focus", "tot", "pet", ...PARTY_PORTRAIT_SLOTS,
    PAPERDOLL_PORTRAIT_SLOT, CHARACTER_PORTRAIT_SLOT,
  ] as const) {
    set(slot, undefined, targets.get(slot)?.canvas);
  }
}

export function syncPortraitTargets(renderer: WorldRenderer3D | undefined): void {
  // Self GUID can be replaced by a world transfer while the character window remains mounted.
  // Keep the target identity current without rebuilding the canvas or renderer.
  if (paperdollCanvas) {
    const target = targets.get(PAPERDOLL_PORTRAIT_SLOT);
    const guid = game.world?.state.selfGuid;
    if (target?.guid !== guid || target?.canvas !== paperdollCanvas) {
      set(PAPERDOLL_PORTRAIT_SLOT, guid, paperdollCanvas);
    }
  }
  if (characterFrameCanvas) {
    const target = targets.get(CHARACTER_PORTRAIT_SLOT);
    const guid = game.world?.state.selfGuid;
    if (target?.guid !== guid || target?.canvas !== characterFrameCanvas) {
      set(CHARACTER_PORTRAIT_SLOT, guid, characterFrameCanvas);
    }
  }
  renderer?.setPortraitTargets(targets);
}

/** Keeps the old class/creature image visible until a real model has successfully read back. */
export function applyPortraitVisibility(): void {
  const player = targets.get("player");
  const target = targets.get("target");
  if (playerCanvas.dataset["portraitReady"] === "true") playerIcon.hidden = true;
  else playerIcon.hidden = player?.guid === undefined || playerIcon.dataset["atlas"] === undefined;
  if (targetCanvas.dataset["portraitReady"] === "true") targetIcon.hidden = true;
  else targetIcon.hidden = target?.guid === undefined || targetPanel.hidden;
}

export function portraitCanvases(): ReadonlyMap<PortraitSlot, HTMLCanvasElement> {
  const canvases = new Map<PortraitSlot, HTMLCanvasElement>([
    ["player", playerCanvas], ["target", targetCanvas],
  ]);
  if (paperdollCanvas) canvases.set(PAPERDOLL_PORTRAIT_SLOT, paperdollCanvas);
  if (characterFrameCanvas) canvases.set(CHARACTER_PORTRAIT_SLOT, characterFrameCanvas);
  for (const slot of PARTY_PORTRAIT_SLOTS) {
    const canvas = targets.get(slot)?.canvas;
    if (canvas) canvases.set(slot, canvas);
  }
  return canvases;
}
