/**
 * What a tooltip says, without any tooltip: the builders (ItemTooltip.ts, UnitTooltip.ts) fill these,
 * and the stock `GameTooltip` (`setGameTooltipContent`) and the box in Tooltip.ts draw them.
 */

/**
 * What a tooltip line *is*, which is what decides its colour.
 *
 * An item tooltip is not a list of equal sentences: a stat is green, a requirement the character
 * does not meet is red, an item's spell is cyan and its flavour text is gold, and the reference
 * client draws each of those with its own colour in the same order this client now prints them
 * (`wowee/src/ui/item_tooltip.cpp:339`, `:358`, `:381`, `:598`). The stylesheet reads the class;
 * the builder decides the tone.
 */
export type TooltipTone = "stat" | "unmet" | "spell" | "flavour" | "gold" | "muted" | "description";

export interface TooltipLine {
  text: string;
  tone?: TooltipTone | undefined;
  /** Parsed Lua colour runs; text is still rendered through textContent. */
  runs?: readonly { readonly text: string; readonly color?: string | undefined }[] | undefined;
  /**
   * The fields below are read only by the stock FrameXML `GameTooltip` (`setGameTooltipContent`);
   * the box in Tooltip.ts ignores them, so a builder that fills them keeps its native shape.
   *
   * `right` is the right half of a double line, the original's `AddDoubleLine` row: slot | armour
   * type, damage | speed, cost | range, cast time | cooldown.
   */
  right?: string | undefined;
  /** The exact 3.3.5 colour, `#rrggbb`, over the tone's; the stock grey has no tone. */
  color?: string | undefined;
  /** The right half's colour, `#rrggbb`; white when absent. */
  rightColor?: string | undefined;
  /** `AddLine(text, r, g, b, true)`: the original wraps «Use:» text and descriptions. */
  wrap?: boolean | undefined;
  /**
   * A price. A stock tooltip draws the row with the corpus' own `SetTooltipMoney` — `label`, then
   * the coins — when it can, and keeps `text`, the same price in words, as the row when it cannot.
   */
  money?: { readonly copper: number; readonly label: string } | undefined;
}

/**
 * How content built before everything it names arrived asks to be drawn again.
 *
 * `watch` calls `redraw` once, with the rebuilt content, when a late answer lands (an item row, a
 * spell's words, the enchantment table), and returns the cancel. A tooltip that has moved on says
 * so to its own redraw; a rebuilt content that still waits carries a `refresh` of its own.
 */
export interface TooltipRefresh {
  readonly watch: (redraw: (next: TooltipContent) => void) => () => void;
}

export interface TooltipContent {
  title: string;
  /** Item quality 0-6, read by the stylesheet for the title's colour. */
  quality?: number | undefined;
  /**
   * A bare string is a plain line, which is what every caller but the item builder wants; the
   * union rather than a widening to `TooltipLine` alone so that the twelve panels that pass a
   * literal array of sentences — a confirmation, a keybinding chord, a talent's rank — keep saying
   * exactly what they said.
   */
  lines?: readonly (string | TooltipLine)[] | undefined;
  /** Dimmer trailing lines: what the thing is for, what a click will do. */
  footer?: readonly string[] | undefined;
  /** The title row's right half: a spell's rank, grey in the original (stock tooltip only). */
  titleRight?: string | undefined;
  /** Present while the content is missing a late answer; see {@link TooltipRefresh}. */
  refresh?: TooltipRefresh | undefined;
  /** The title's own colour, `#rrggbb`, over the default gold (a hint's white, a class colour). */
  titleColor?: string | undefined;
  /** A one-line hint rather than a card: narrow, white, no header weight (`.ui-tooltip.is-plain`). */
  plain?: boolean | undefined;
  /**
   * A card beside the cursor over the world — a unit's or an object's (4.04): sized to its words
   * like the original's tooltip rather than to an item card (`.ui-tooltip.is-cursor`).
   */
  cursor?: boolean | undefined;
}
