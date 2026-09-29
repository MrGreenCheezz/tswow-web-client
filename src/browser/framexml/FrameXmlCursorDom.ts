/**
 * The page side of the FrameXML cursor (FrameXmlCursor.ts): the held thing's picture at the
 * pointer, and the ways of letting go that are not a FrameXML frame's own script.
 *
 * * A press on the world — anything that is not a drawn FrameXML frame or a native control — lets
 *   go, with either button. The client asks before destroying a bag item dropped on the world
 *   (DELETE_ITEM); this client never deletes on a drop: `ClearCursor` returns the item to its bag,
 *   and an action lifted off a bar is gone, as it is in the client.
 * * Escape lets go before it closes any window, and the key goes no further.
 *
 * A press on a frame is the frame's: an action button places (UseAction), a bag slot swaps, a
 * window's own background keeps the cursor as the client's does.
 */

import type { FrameXmlCursorModel } from "./FrameXmlCursor.js";

export interface FrameXmlCursorPictureSink {
  setCursorPicture(texture: string | undefined): void;
}

/** A press whose target is not interface: the world canvas, or bare page with no control on it. */
export function frameXmlCursorWorldTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  if (element.closest("[data-framexml-name]")) return false;
  return element.closest("input, textarea, select, button, a, [contenteditable=''], [contenteditable='true']") === null;
}

/** Wire the picture and the let-go input; returns the cleanup. */
export function installFrameXmlCursorDom(
  doc: Document,
  cursor: FrameXmlCursorModel,
  pictures: FrameXmlCursorPictureSink,
): () => void {
  const unsubscribe = cursor.onPicture((texture) => pictures.setCursorPicture(texture));
  pictures.setCursorPicture(cursor.picture());
  const press = (event: Event): void => {
    if (!frameXmlCursorWorldTarget(event.target) || !cursor.occupied()) return;
    cursor.clear();
  };
  const key = (event: Event): void => {
    if ((event as KeyboardEvent).key !== "Escape" || !cursor.occupied()) return;
    cursor.clear();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  doc.addEventListener("mousedown", press, true);
  doc.addEventListener("keydown", key, true);
  return () => {
    unsubscribe();
    doc.removeEventListener("mousedown", press, true);
    doc.removeEventListener("keydown", key, true);
    pictures.setCursorPicture(undefined);
  };
}
