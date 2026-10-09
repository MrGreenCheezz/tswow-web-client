/**
 * Stable, redistributable facade for class-icon coordinates generated from the user's dataset.
 * Real coordinates live only in the ignored local implementation.
 */
import * as implementation from "./client-data/classIcons.js";

/** Left, right, top and bottom edges of one cell, each a fraction of the whole sheet. */
export interface ClassIconCell {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const CLASS_ICON_DATA_AVAILABLE: boolean = implementation.CLASS_ICON_DATA_AVAILABLE;
export const CLASS_ICON_TCOORDS: Readonly<Record<string, ClassIconCell>> =
  implementation.CLASS_ICON_TCOORDS;
/**
 * `RAID_CLASS_COLORS` of the dataset's Constants.lua as `#rrggbb`, by `ChrClasses.Filename` (9.05).
 * Empty in a redistributable copy without local client data.
 */
export const CLASS_COLOR_DATA: Readonly<Record<string, string>> = implementation.CLASS_COLOR_DATA;
/** `CLASS_SORT_ORDER` of the same file; `MAX_CLASSES` is its length. */
export const CLASS_SORT_ORDER_DATA: readonly string[] = implementation.CLASS_SORT_ORDER_DATA;
