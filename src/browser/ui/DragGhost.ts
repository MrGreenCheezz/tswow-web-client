/**
 * What hangs under the cursor while something is dragged out of a native window (WORK_PLAN 4.02).
 *
 * Without `setDragImage` the browser draws a translucent snapshot of the whole source — frame,
 * key label, cooldown text and all — which is a web page's drag, not the game's. The original
 * client puts the thing's icon on the cursor. {@link beginIconDrag} builds that icon once per drag:
 * a 36×36 box with the source's own picture (the same URL its button already shows, so the image
 * is in the browser's list of available images and draws at once), the stack count and the
 * quality border; a source without a picture gets its first letter. The box sits off screen for
 * the one task `setDragImage` needs it painted and is removed on the next.
 *
 * `NativeAppShell` still decides whether a drag may start at all (`draggable="true"` only).
 */

/** What the ghost shows: the picture, or the letter when there is none. */
export interface DragGhostSpec {
  readonly icon?: string | undefined;
  readonly count?: string | undefined;
  readonly quality?: number | undefined;
  readonly label?: string | undefined;
}

export const DRAG_GHOST_SIZE = 36;
const HALF = DRAG_GHOST_SIZE / 2;

/** Read from the source as it is drawn: its first picture, its stack count, its quality. */
export function dragGhostSpec(source: Element): DragGhostSpec {
  const image = source.querySelector?.("img") as HTMLImageElement | null | undefined;
  const icon = image ? image.currentSrc || image.getAttribute("src") || undefined : undefined;
  const countText = source.querySelector?.(".stack-count, .ui-slot-count")?.textContent?.trim();
  // The bags mark it as a class (`item-slot quality-N`), the slot grids as `data-quality`.
  const qualityText = (source as HTMLElement).dataset?.["quality"]
    ?? /(?:^|\s)quality-(\d+)(?:\s|$)/.exec(typeof source.className === "string" ? source.className : "")?.[1];
  const quality = qualityText === undefined || qualityText === "" ? undefined : Number(qualityText);
  const label = (source.textContent ?? "").trim().charAt(0) || undefined;
  return {
    icon,
    count: countText ? countText : undefined,
    quality: quality !== undefined && Number.isInteger(quality) ? quality : undefined,
    label,
  };
}

/**
 * Hands the drag its icon. `spec` overrides what is read from `source` (a macro's letter, a
 * picture the source does not draw). Does nothing without a `dataTransfer` that can take an image.
 */
export function beginIconDrag(event: DragEvent, source: Element, spec?: DragGhostSpec): void {
  const transfer = event.dataTransfer;
  if (!transfer || typeof transfer.setDragImage !== "function") return;
  const shown = { ...dragGhostSpec(source), ...spec };
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  if (shown.quality !== undefined) ghost.dataset["quality"] = String(shown.quality);
  if (shown.icon) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = shown.icon;
    ghost.append(image);
  } else {
    const letter = document.createElement("span");
    letter.className = "drag-ghost-label";
    letter.textContent = shown.label || "?";
    ghost.append(letter);
  }
  if (shown.count) {
    const count = document.createElement("span");
    count.className = "drag-ghost-count";
    count.textContent = shown.count;
    ghost.append(count);
  }
  document.body.append(ghost);
  try {
    transfer.setDragImage(ghost, HALF, HALF);
  } finally {
    // Painted for this task only: the browser has taken its bitmap by the next one.
    setTimeout(() => ghost.remove(), 0);
  }
}
