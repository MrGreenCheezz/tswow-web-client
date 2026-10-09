/**
 * One tooltip for the whole native interface (М-A5-1, item 4.01).
 *
 * The browser's own `title` is the wrong tool for a game: it appears after a second of stillness,
 * cannot be styled, is not shown at all on a disabled control — which is exactly where the
 * *reason* lives — never appears on a touch device and is not reached by the keyboard. This
 * module is the single element that replaces it: one `div.ui-tooltip` on the body, moved to
 * whatever is asking. `Widgets.ts` re-exports everything here, so callers import from either.
 *
 * Two kinds of asker:
 *  - a rich card (an item, a spell, an aura) attached with {@link attachTooltip} shows at once on
 *    the pointer entering, as the original's cards do;
 *  - a plain hint set with {@link setTip} (what used to be `el.title = …`) waits
 *    {@link TIP_DELAY_MS}, unless another tooltip was on screen a moment ago
 *    ({@link TIP_WARM_MS}) — running the pointer along a row of buttons does not blink.
 *
 * The tooltip goes away on the pointer leaving, a press on its owner (plain hints), the wheel, a
 * drag starting, Escape and the window losing focus. Escape is not swallowed: the original closes
 * the window under the cursor on that press, and a pointer resting on an action bar would
 * otherwise cost a second Escape for every back-out.
 *
 * The element is `role="tooltip"` and its owner carries `aria-describedby` only while it is shown.
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
   * the native box above ignores them, so a builder that fills them keeps its native shape.
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

/** How long a plain hint waits under a still pointer; the browser's own `title` waits ~1 s. */
export const TIP_DELAY_MS = 250;
/** A hint asked for this soon after another one went away shows at once. */
export const TIP_WARM_MS = 400;
/** The tooltip element's id, which its owner's `aria-describedby` names while it is shown. */
export const TOOLTIP_ID = "ui-tooltip";

let tooltipElement: HTMLElement | undefined;
/** How to build the tooltip that is on screen again, so a late answer can redraw it in place. */
let shownBy: (() => void) | undefined;
let shownTooltipHide: (() => void) | undefined;
/** The element whose `aria-describedby` points at the tooltip, and what it said before. */
let describedTarget: HTMLElement | undefined;
let describedBefore: string | null = null;
/** The cursor-mode owner of {@link showTooltipAtPoint}, what it shows and where. */
let pointKey: string | undefined;
let pointContent: TooltipContent | undefined;
let pointX = 0;
let pointY = 0;
/** The cursor card's size, measured once per drawing: a move of the same card only re-places it. */
let pointSize: { readonly width: number; readonly height: number } = { width: 0, height: 0 };
let lastHiddenAt = Number.NEGATIVE_INFINITY;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let pendingShow: (() => void) | undefined;
let globalsInstalled = false;

function visible(): boolean {
  return tooltipElement !== undefined && !tooltipElement.hidden;
}

function cancelPending(): void {
  if (pendingTimer !== undefined) clearTimeout(pendingTimer);
  pendingTimer = undefined;
  pendingShow = undefined;
}

/** Whether a hint asked for now skips its delay: one is on screen, or went away a moment ago. */
function warm(): boolean {
  return visible() || Date.now() - lastHiddenAt < TIP_WARM_MS;
}

/**
 * The page-wide reasons a tooltip goes away, installed once with the element. Capture phase, so a
 * panel that stops a wheel or a key for itself does not leave the tooltip hanging over it.
 */
function installGlobals(): void {
  if (globalsInstalled || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  globalsInstalled = true;
  const dismiss = (): void => {
    cancelPending();
    if (visible()) hideTooltip();
  };
  window.addEventListener("wheel", dismiss, { capture: true, passive: true });
  window.addEventListener("dragstart", dismiss, { capture: true });
  window.addEventListener("blur", dismiss);
  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" || event.code === "Escape") dismiss();
  }, { capture: true });
  // A list rebuilt under the pointer drops the element that owned the tooltip without a
  // `pointerleave`; the next element the pointer crosses into, if it is not inside the owner, ends
  // it. `pointerover` fires on crossings only, not on every move.
  window.addEventListener("pointerover", (event: PointerEvent) => {
    const owner = describedTarget;
    if (!owner || !visible()) return;
    const over = event.target as Node | null;
    if (owner.isConnected !== false && over && typeof owner.contains === "function" && owner.contains(over)) return;
    hideTooltip();
  }, { capture: true, passive: true });
}

function element(): HTMLElement {
  if (!tooltipElement) {
    tooltipElement = document.createElement("div");
    tooltipElement.className = "ui-tooltip";
    tooltipElement.id = TOOLTIP_ID;
    tooltipElement.setAttribute("role", "tooltip");
    tooltipElement.hidden = true;
    // On the body rather than in the panel that asked: every game window is `overflow: auto`,
    // and a tooltip inside one is clipped by it.
    document.body.append(tooltipElement);
    installGlobals();
  }
  return tooltipElement;
}

function render(shown: TooltipContent): HTMLElement {
  const box = element();
  box.className = shown.plain ? "ui-tooltip is-plain" : shown.cursor ? "ui-tooltip is-cursor" : "ui-tooltip";
  if (shown.quality !== undefined) box.dataset["quality"] = String(shown.quality);
  else delete box.dataset["quality"];
  const title = document.createElement("strong");
  title.textContent = shown.title;
  if (shown.quality !== undefined) title.dataset["quality"] = String(shown.quality);
  if (shown.titleColor && HEX_COLOUR.test(shown.titleColor)) title.style.color = shown.titleColor;
  const rows = (shown.lines ?? []).map((line) => typeof line === "string"
    ? row(line, "")
    : row(line.text, line.tone ? `ui-tooltip-${line.tone}` : "", line.runs));
  const footer = (shown.footer ?? []).map((line) => row(line, "ui-tooltip-footer"));
  box.replaceChildren(title, ...rows, ...footer);
  box.hidden = false;
  return box;
}

const HEX_COLOUR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

function describe(target: HTMLElement): void {
  if (describedTarget === target) return;
  undescribe();
  describedTarget = target;
  describedBefore = target.getAttribute?.("aria-describedby") ?? null;
  target.setAttribute?.("aria-describedby", TOOLTIP_ID);
}

function undescribe(): void {
  const target = describedTarget;
  describedTarget = undefined;
  if (!target) return;
  if (describedBefore === null) target.removeAttribute?.("aria-describedby");
  else target.setAttribute?.("aria-describedby", describedBefore);
  describedBefore = null;
}

/** Keyboard focus only: a click also focuses, and a hint must not stay up after one. */
function focusVisible(target: HTMLElement): boolean {
  try {
    return typeof target.matches === "function" && target.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Attaches a tooltip to `target`, built by `content` each time it is shown.
 *
 * Rich content (the default) shows at once; `delayed` is the plain hint's {@link TIP_DELAY_MS}
 * wait, with a press on the owner hiding it the way a browser hint goes away on a click.
 */
export function attachTooltip(
  target: HTMLElement,
  content: () => TooltipContent | undefined,
  lifecycle: { readonly onHide?: () => void; readonly delayed?: boolean } = {},
): void {
  const show = (): void => {
    if (pendingShow === show) cancelPending();
    if (shownBy !== show) hideTooltip();
    const shown = content();
    if (!shown) { hideTooltip(); return; }
    shownBy = show;
    shownTooltipHide = lifecycle.onHide;
    place(render(shown), target);
    describe(target);
  };
  const enter = (): void => {
    if (!lifecycle.delayed || warm()) { show(); return; }
    cancelPending();
    pendingShow = show;
    pendingTimer = setTimeout(show, TIP_DELAY_MS);
  };
  const leave = (): void => {
    if (pendingShow === show) cancelPending();
    if (shownBy === show) hideTooltip();
  };
  enterOf.set(target, enter);
  target.addEventListener("pointerenter", enter);
  target.addEventListener("pointerleave", leave);
  if (lifecycle.delayed) target.addEventListener("pointerdown", leave);
  // Keyboard reaches it too, which is the whole point of not using `title` — but only a keyboard
  // focus: the mouse focuses a button it clicks, and the hint would then outlive the pointer.
  target.addEventListener("focus", () => { if (focusVisible(target)) show(); });
  target.addEventListener("blur", leave);
}

/** The `pointerenter` handler of every attached target, for {@link armTip}. */
const enterOf = new WeakMap<HTMLElement, () => void>();

function row(text: string, className: string, runs?: TooltipLine["runs"]): HTMLElement {
  const line = document.createElement("div");
  if (className) line.className = className;
  if (runs) {
    for (const run of runs) {
      const span = document.createElement("span");
      span.textContent = run.text;
      if (run.color && HEX_COLOUR.test(run.color)) span.style.color = run.color;
      line.append(span);
    }
  } else line.textContent = text;
  return line;
}

function viewport(): { width: number; height: number } {
  const width = typeof window !== "undefined" && Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1280;
  const height = typeof window !== "undefined" && Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 720;
  return { width, height };
}

/** Beside the thing that asked, nudged back inside the window when it would hang off an edge. */
function place(tooltip: HTMLElement, target: HTMLElement): void {
  const at = target.getBoundingClientRect();
  const margin = 8;
  const { width: viewportWidth, height: viewportHeight } = viewport();
  const maxWidth = Math.max(160, viewportWidth - margin * 2);
  tooltip.style.maxWidth = `${Math.round(maxWidth)}px`;
  tooltip.style.maxHeight = `${Math.round(Math.max(96, viewportHeight - margin * 2))}px`;
  tooltip.style.overflowY = "auto";
  let size = tooltip.getBoundingClientRect();
  const below = at.bottom + 6;
  const belowSpace = Math.max(0, viewportHeight - below - margin);
  const aboveSpace = Math.max(0, at.top - 6 - margin);
  const available = Math.max(96, Math.max(belowSpace, aboveSpace));
  if (size.height > available) {
    tooltip.style.maxHeight = `${Math.round(available)}px`;
    size = tooltip.getBoundingClientRect();
  }
  const left = Math.max(margin, Math.min(at.left, viewportWidth - size.width - margin));
  const top = belowSpace >= size.height
    ? below
    : aboveSpace >= size.height
      ? Math.max(margin, at.top - size.height - 6)
      : margin;
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

/**
 * Down and right of a cursor point, flipped to the other side at the window's edges. `size` is the
 * card's measured size, taken by the caller once per drawing.
 */
function placeAtPoint(tooltip: HTMLElement, x: number, y: number, size: { readonly width: number; readonly height: number }): void {
  const offset = 16;
  const margin = 8;
  const { width: viewportWidth, height: viewportHeight } = viewport();
  let left = x + offset;
  if (left + size.width > viewportWidth - margin) left = x - offset - size.width;
  let top = y + offset;
  if (top + size.height > viewportHeight - margin) top = y - offset - size.height;
  tooltip.style.left = `${Math.round(Math.max(margin, left))}px`;
  tooltip.style.top = `${Math.round(Math.max(margin, top))}px`;
}

/**
 * The cursor mode: a tooltip at a screen point rather than beside an element — a unit or an
 * object in the world, which has no element to hover. `key` names the owner, so the owner's
 * {@link hideTooltipAtPoint} does not take down a tooltip someone else has put up since.
 */
export function showTooltipAtPoint(key: string, content: TooltipContent, x: number, y: number): void {
  // The same card from the same owner only moves: a hover re-picks on every pointer move, and
  // rebuilding the rows each time would be a DOM rebuild per move for a tooltip that has not changed.
  if (pointKey === key && pointContent === content && visible()) {
    if (x !== pointX || y !== pointY) {
      pointX = x;
      pointY = y;
      placeAtPoint(tooltipElement!, x, y, pointSize);
    }
    return;
  }
  cancelPending();
  if (pointKey !== key) hideTooltip();
  pointX = x;
  pointY = y;
  const redraw = (): void => {
    const tooltip = render(content);
    const { width, height } = tooltip.getBoundingClientRect();
    pointSize = { width, height };
    placeAtPoint(tooltip, pointX, pointY, pointSize);
  };
  redraw();
  undescribe();
  pointKey = key;
  pointContent = content;
  shownBy = redraw;
  shownTooltipHide = undefined;
}

/** Takes the cursor-mode tooltip down if `key` still owns it. */
export function hideTooltipAtPoint(key: string): void {
  if (pointKey === key) hideTooltip();
}

/** Hidden without waiting for a pointer to leave: a rebuilt list drops the element under it. */
export function hideTooltip(): void {
  cancelPending();
  if (tooltipElement && !tooltipElement.hidden) {
    tooltipElement.hidden = true;
    lastHiddenAt = Date.now();
  }
  shownBy = undefined;
  pointKey = undefined;
  pointContent = undefined;
  undescribe();
  const onHide = shownTooltipHide;
  shownTooltipHide = undefined;
  onHide?.();
}

/**
 * Builds the tooltip that is on screen again, for an answer that arrived after it went up.
 *
 * A tooltip is built once, on the pointer entering, out of whatever the client knew at that
 * instant — and an item's spell rows are asked for at exactly that instant, because hovering the
 * item is the only thing that ever asks for them (`ItemTooltip.itemTooltipFor`). The answer is a
 * network round trip later, by which time nobody is looking at the builder any more; without this
 * the name lands in `game.spells` and the line on screen keeps its number until the pointer
 * leaves and comes back.
 */
export function refreshTooltip(): void {
  if (visible()) shownBy?.();
}

/** What {@link setTip} accepts: a sentence, or a builder for a fuller card. */
export type TipSource = string | (() => TooltipContent | undefined);

const tips = new WeakMap<HTMLElement, TipSource>();

/** A hint sentence as a card: the first line is the title, the rest are lines under it. */
export function plainTip(text: string): TooltipContent {
  const [title = "", ...lines] = text.split("\n");
  return { title, lines, plain: true };
}

/**
 * The replacement for `el.title = text`: a delayed plain hint, or `undefined`/`""` to remove it.
 * Listeners are attached once per element; later calls only swap what it says, and a hint that is
 * on screen is redrawn in place.
 */
export function setTip(target: HTMLElement, tip: TipSource | undefined): void {
  if (tip === undefined || tip === "") {
    if (!tips.has(target)) return;
    tips.delete(target);
    if (describedTarget === target) hideTooltip();
    return;
  }
  const before = tips.get(target);
  if (before === tip) return;
  tips.set(target, tip);
  if (!enterOf.has(target)) {
    attachTooltip(target, () => {
      const source = tips.get(target);
      if (source === undefined) return undefined;
      return typeof source === "string" ? plainTip(source) : source();
    }, { delayed: true });
  } else if (describedTarget === target) refreshTooltip();
}

/**
 * What {@link setTip} last gave `target` as a sentence. The per-frame painters compare with this
 * instead of `el.title`, which reads empty once the hint has moved here and would make every frame
 * a write.
 */
export function getTip(target: HTMLElement): string | undefined {
  const source = tips.get(target);
  return typeof source === "string" ? source : undefined;
}

/**
 * Starts `target`'s hint as if the pointer had just entered it — for the `title` safety net in
 * `NativeAppShell`, which converts a hint on the pointer's way *into* an element whose
 * `pointerenter` has already gone by (the pointer entered a child of the titled element).
 */
export function armTip(target: HTMLElement): void {
  enterOf.get(target)?.();
}
