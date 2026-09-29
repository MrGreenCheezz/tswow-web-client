/**
 * The ownership seam between the stock CalendarFrame (load-on-demand Blizzard_Calendar) and the native
 * `#calendar-window`.
 *
 * `ui/Calendar.ts`'s toggle/open/close ask here first, so GameTimeFrame (the clock's calendar button,
 * stock ToggleCalendar), `/calendar`, the native game menu's «Календарь» and the HUD's calendar button
 * reach the stock window once the world mount has published its owner, and the native Panel otherwise.
 * Every answer is false while nothing usable is published — before the mount, after teardown, and
 * after a failed load or gate.
 */

import { FrameXmlLodWindowRoute, type FrameXmlLodWindowOwner } from "./FrameXmlMacroBindingLod.js";

/** The published owner; FrameXmlCalendarOwner.ts's also says when its add-on is in place. */
export interface FrameXmlCalendarRouteOwner extends FrameXmlLodWindowOwner {
  /** Loaded, gated and adopted: CalendarFrame_OnEvent now shows every CALENDAR_UPDATE_ERROR. */
  readonly loaded?: boolean;
}

const route = new FrameXmlLodWindowRoute();
let current: FrameXmlCalendarRouteOwner | undefined;

export function publishFrameXmlCalendar(owner: FrameXmlCalendarRouteOwner): () => void {
  const unpublish = route.publish(owner);
  current = owner;
  return () => {
    if (current === owner) current = undefined;
    unpublish();
  };
}

export function frameXmlCalendarPublished(): boolean {
  return route.published();
}

/**
 * Whether a calendar command's error is the stock window's to show: its loaded add-on raises the
 * CALENDAR_ERROR popup for it whether CalendarFrame is shown or not (Blizzard_Calendar.lua:1115).
 */
export function frameXmlCalendarOwnsErrors(): boolean {
  try { return route.published() && current?.loaded === true; } catch { return false; }
}

export function frameXmlCalendarOpen(): boolean {
  return route.isOpen();
}

/** Toggle the stock window; false tells the caller to use the native one. */
export function toggleFrameXmlCalendar(): boolean {
  return route.toggle();
}

/** Open (or keep open) the stock window; false tells the caller to use the native one. */
export function openFrameXmlCalendar(): boolean {
  return route.open();
}

/** Close the stock window; false when it was not open. */
export function closeFrameXmlCalendar(): boolean {
  return route.close();
}
