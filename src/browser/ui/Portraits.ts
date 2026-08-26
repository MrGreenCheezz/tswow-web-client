import type { PortraitSlot, PortraitTarget } from "../PortraitRenderer.js";
import {
  HUD_PORTRAIT_CSS_PIXELS, setPortraitCanvasBackingStore,
} from "../PortraitCanvas.js";
import type { WorldRenderer3D } from "../WorldRenderer3D.js";
import { playerIcon, targetIcon, targetPanel } from "./Dom.js";
import type { UnitFrame } from "./UnitFrame.js";

const playerCanvas = ensureCanvas(playerIcon, "player");
const targetCanvas = ensureCanvas(targetIcon, "target");
const targets = new Map<PortraitSlot, PortraitTarget>();

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

export function clearPortraitTargets(): void {
  for (const slot of ["player", "target", "focus", "tot", "pet"] as const) set(slot, undefined, targets.get(slot)?.canvas);
}

export function syncPortraitTargets(renderer: WorldRenderer3D | undefined): void {
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
  return new Map([
    ["player", playerCanvas], ["target", targetCanvas],
  ] as const);
}
