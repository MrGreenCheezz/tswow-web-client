/**
 * The pieces every panel is built out of.
 *
 * The interface still owes 125 features, and each one written from bare `document.createElement`
 * is another private idea of what a bar, a slot or a tooltip looks like. Twenty private ideas is
 * the "rough" that cannot be polished afterwards: there is no one place to change. These are that
 * one place, and they are deliberately small — a bar is a div with a width, not a component
 * framework.
 */

import { setIconSource } from "./IconImage.js";
import { attachTooltip, setTip } from "./Tooltip.js";
import type { TooltipContent } from "./TooltipTypes.js";

// The tooltip lives in its own module (4.01); every name the panels imported from here still is.
export {
  TIP_DELAY_MS, TIP_WARM_MS, TOOLTIP_ID, armTip, attachTooltip, getTip, hideTooltip, hideTooltipAtPoint, plainTip,
  refreshTooltip, setTip, showTooltipAtPoint,
} from "./Tooltip.js";

// The windows that go in stage 6 of 4.17, and the tests that drive them, still take these from here.
export { Panel, Tabs, usePanelHost } from "./ToolWidgets.js";

/** How full a bar is, clamped, with an unknown or absent maximum reading as empty rather than NaN. */
export function fillFraction(value: number | undefined, maximum: number | undefined): number {
  if (value === undefined || maximum === undefined || maximum <= 0) return 0;
  return Math.max(0, Math.min(1, value / maximum));
}

/** How much of a cooldown is still to run, from 1 at the moment it starts to 0 when it ends. */
export function cooldownFraction(now: number, startedAt: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - (now - startedAt) / duration));
}

/**
 * The cooldown store exposes an end time, not its original start time.  When the authored
 * duration is known, the remaining/end-time pair is enough to draw the same sweep in every panel;
 * keeping this conversion here prevents each button from inventing a slightly different formula.
 */
export function cooldownFractionFromRemaining(remaining: number, duration: number): number {
  if (!Number.isFinite(remaining) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(1, remaining / duration));
}

/** Short, readable countdown text used over both action icons and spellbook entries. */
export function cooldownLabel(remaining: number): string {
  if (!Number.isFinite(remaining) || remaining <= 0) return "";
  const seconds = remaining / 1000;
  return seconds >= 10 ? `${Math.ceil(seconds)}с` : seconds.toFixed(1);
}

/** The longest of the spell's own, category and global-recovery durations. */
export function cooldownDuration(...durations: readonly (number | undefined)[]): number {
  return Math.max(0, ...durations.filter((duration): duration is number => Number.isFinite(duration)));
}

export interface CooldownWindow {
  startedAt: number;
  duration: number;
}

export interface CooldownView {
  remaining: number;
  duration: number;
  fraction: number;
}

/**
 * Chooses the longer own/global lock and gives both action bars and the book one presentation.
 * `ownWindow` is authoritative when WorldClient has one; the duration arguments cover the short
 * interval before metadata or a server snapshot arrives.
 */
export function cooldownView(
  now: number,
  ownRemaining: number,
  ownDuration: number,
  globalRemaining = 0,
  globalDuration = 0,
  ownWindow?: CooldownWindow,
): CooldownView {
  const own = Number.isFinite(ownRemaining) ? Math.max(0, ownRemaining) : 0;
  const global = Number.isFinite(globalRemaining) ? Math.max(0, globalRemaining) : 0;
  const remaining = Math.max(own, global);
  const ownWins = own >= global;
  const duration = ownWins && own > 0
    ? ownWindow ? Math.max(ownWindow.duration, own) : Math.max(ownDuration, own)
    : Math.max(globalDuration, global);
  const fraction = remaining <= 0 ? 0
    : ownWins && own > 0 && ownWindow
      ? cooldownFraction(now, ownWindow.startedAt, ownWindow.duration)
      : cooldownFractionFromRemaining(remaining, duration);
  return { remaining, duration, fraction };
}

/** Stack sizes on an item slot: one is not written, and four figures do not fit. */
export function stackLabel(count: number): string {
  if (count <= 1) return "";
  return count >= 1000 ? `${Math.floor(count / 1000)}k` : String(count);
}

export function textLine(label: string, value: string): HTMLElement {
  const line = document.createElement("div");
  line.className = "ui-line";
  const name = document.createElement("span");
  name.className = "ui-line-label";
  name.textContent = label;
  const text = document.createElement("span");
  text.textContent = value;
  line.append(name, text);
  return line;
}

export interface BarOptions {
  /** Named for the stylesheet: `health`, `power`, `cast`, `experience`. */
  kind?: string;
  /** Draws the value over the fill. Off for the thin bars that only show a proportion. */
  text?: boolean;
}

/** A proportion drawn as a filled track, which is what most of a game interface is. */
export class Bar {
  readonly root: HTMLElement;
  readonly #fill: HTMLElement;
  readonly #text: HTMLElement | undefined;
  /** Last values written, so per-frame refreshes compare instead of forcing style/layout. */
  #lastWidth: string | undefined;
  #lastText: string | undefined;
  #lastVariant: string | undefined;

  constructor(options: BarOptions = {}) {
    this.root = document.createElement("div");
    this.root.className = options.kind ? `ui-bar ui-bar-${options.kind}` : "ui-bar";
    this.#fill = document.createElement("span");
    this.root.append(this.#fill);
    if (options.text) {
      // Said in the class list as well as in the DOM, because the one thing the stylesheet has to
      // know about a bar it cannot see inside is whether there is a number in it. A track shorter
      // than its own type puts the baseline past the bottom edge — 10.88px of text in the skills
      // window's 8px bar, and in the party frames' 9px one — so `.ui-bar-text` carries the floor.
      this.root.classList.add("ui-bar-text");
      this.#text = document.createElement("em");
      this.root.append(this.#text);
    }
  }

  set(value: number | undefined, maximum: number | undefined, text?: string): void {
    const width = `${fillFraction(value, maximum) * 100}%`;
    if (width !== this.#lastWidth) {
      this.#lastWidth = width;
      this.#fill.style.width = width;
    }
    if (this.#text) {
      const label = text ?? (value === undefined ? "" : `${value}/${maximum ?? "?"}`);
      if (label !== this.#lastText) {
        this.#lastText = label;
        this.#text.textContent = label;
      }
    }
  }

  /** A bar whose colour depends on what it holds — a power type, a reaction, a quality. */
  setVariant(variant: string | undefined): void {
    if (variant === this.#lastVariant) return;
    this.#lastVariant = variant;
    if (variant === undefined) delete this.#fill.dataset["variant"];
    else this.#fill.dataset["variant"] = variant;
  }
}

export interface SlotContent {
  /** Nothing at all: an empty bag slot, an unlearned action. */
  empty?: boolean;
  icon?: string;
  count?: number;
  /** Item quality 0-6, or a rank, read by the stylesheet for the border. */
  quality?: number;
  label?: string;
  title?: string;
  disabled?: boolean;
  /**
   * The real tooltip, when the slot has one to give. `title` is the browser's own, which this file
   * argues against a hundred lines below and which the guild bank was still the last user of.
   */
  tooltip?: (() => TooltipContent | undefined) | undefined;
}

/**
 * A grid of square slots: bags, the bank, an action bar, a loot window, a trade offer. Rendering is
 * by whole content rather than by mutation, because every one of those is a list that the server
 * replaces wholesale.
 */
export class SlotGrid {
  readonly root: HTMLElement;
  #onSlot: ((index: number, event: MouseEvent) => void) | undefined;

  constructor(options: { columns?: number; className?: string } = {}) {
    this.root = document.createElement("div");
    this.root.className = options.className ? `ui-slots ${options.className}` : "ui-slots";
    if (options.columns) this.root.style.gridTemplateColumns = `repeat(${options.columns}, var(--ui-slot-size, 38px))`;
    this.root.addEventListener("click", (event) => {
      const slot = (event.target as HTMLElement).closest<HTMLElement>("[data-slot]");
      if (slot?.dataset["slot"]) this.#onSlot?.(Number(slot.dataset["slot"]), event);
    });
  }

  onSlot(handler: (index: number, event: MouseEvent) => void): void {
    this.#onSlot = handler;
  }

  render(slots: readonly SlotContent[]): void {
    const children = slots.map((content, index) => {
      const slot = document.createElement("button");
      slot.type = "button";
      slot.className = "ui-slot";
      slot.dataset["slot"] = String(index);
      if (content.empty) slot.classList.add("ui-slot-empty");
      if (content.disabled) slot.disabled = true;
      if (content.quality !== undefined) slot.dataset["quality"] = String(content.quality);
      // A filled slot's only children are an `<img alt="">` and, above one, the stack count, so
      // without a name of its own the button reads as «20» or as nothing at all. `title` used to
      // be that name, and a slot that now carries a real tooltip stopped setting it — which left
      // the guild bank, the only caller passing both, with unnamed buttons. `aria-label` carries
      // the name either way, the way `ItemSlots.ts:337` does for the bags and the paper doll.
      if (content.title) slot.setAttribute("aria-label", content.title);
      if (content.tooltip) attachTooltip(slot, content.tooltip);
      else if (content.title) setTip(slot, content.title);
      if (content.icon) {
        const icon = document.createElement("img");
        setIconSource(icon, content.icon);
        icon.alt = "";
        slot.append(icon);
      } else if (content.label) {
        const label = document.createElement("span");
        label.className = "ui-slot-label";
        label.textContent = content.label;
        slot.append(label);
      }
      const count = content.count ?? 0;
      if (stackLabel(count)) {
        const badge = document.createElement("em");
        badge.className = "ui-slot-count";
        badge.textContent = stackLabel(count);
        slot.append(badge);
      }
      return slot;
    });
    this.root.replaceChildren(...children);
  }
}

/**
 * An icon that can be pressed and can be on cooldown. The sweep is a conic gradient rather than a
 * canvas: it costs one custom property per frame and no draw calls of its own.
 */
export class IconButton {
  readonly root: HTMLButtonElement;
  readonly #sweep: HTMLElement;
  readonly #cooldown: HTMLElement;
  /** Last values written to the DOM, so a 60 Hz frame is a comparison and not a style recalc. */
  #lastSweep: string | undefined;
  #lastCooling: boolean | undefined;
  #lastLabel: string | undefined;
  #lastHidden: boolean | undefined;
  #lastUsable: boolean | undefined;

  constructor(options: {
    icon?: string | undefined;
    label?: string | undefined;
    key?: string | undefined;
    title?: string | undefined;
    onClick?: ((event: MouseEvent) => void) | undefined;
  }) {
    this.root = document.createElement("button");
    this.root.type = "button";
    this.root.className = "ui-icon-button";
    if (options.title) setTip(this.root, options.title);
    if (options.icon) {
      const icon = document.createElement("img");
      setIconSource(icon, options.icon);
      icon.alt = "";
      this.root.append(icon);
    }
    if (options.label) {
      const label = document.createElement("span");
      label.textContent = options.label;
      this.root.append(label);
    }
    if (options.key) {
      const key = document.createElement("span");
      key.className = "ui-icon-key";
      key.textContent = options.key;
      this.root.append(key);
    }
    this.#sweep = document.createElement("i");
    this.#sweep.className = "ui-icon-sweep";
    this.#cooldown = document.createElement("span");
    this.#cooldown.className = "ui-icon-cooldown";
    this.#cooldown.hidden = true;
    this.root.append(this.#sweep, this.#cooldown);
    if (options.onClick) this.root.addEventListener("click", options.onClick);
  }

  /**
   * Re-dresses the button in place. An action slot changes what it holds far more often than it
   * appears or disappears, and rebuilding it would drop the listener with it.
   */
  setContent(content: {
    icon?: string | undefined;
    label?: string | undefined;
    /** A key/chord rendered as a corner overlay while the icon remains visible. */
    key?: string | undefined;
    title?: string | undefined;
  }): void {
    setTip(this.root, content.title);
    for (const child of [...this.root.children]) if (child !== this.#sweep && child !== this.#cooldown) child.remove();
    if (content.icon) {
      const icon = document.createElement("img");
      setIconSource(icon, content.icon);
      icon.alt = "";
      this.root.prepend(icon);
    }
    if (content.label) {
      const label = document.createElement("span");
      label.textContent = content.label;
      this.root.prepend(label);
    }
    if (content.key) {
      const key = document.createElement("span");
      key.className = "ui-icon-key";
      key.textContent = content.key;
      this.root.prepend(key);
    }
  }

  /** Call once a frame while a cooldown runs; `remaining` of 0 clears it. */
  setCooldown(remaining: number, label = ""): void {
    // The sweep is a conic-gradient custom property: writing it every frame forces a style
    // recalc and repaint of the button even when the visible degree did not move. Quantize to
    // whole degrees and skip unchanged writes; a 1.5 s GCD still steps every frame while a
    // 10-minute cooldown writes a handful of times over its whole run.
    const degrees = `${Math.round(Math.max(0, Math.min(1, remaining)) * 360)}deg`;
    if (degrees !== this.#lastSweep) {
      this.#lastSweep = degrees;
      this.#sweep.style.setProperty("--sweep", degrees);
    }
    const cooling = remaining > 0;
    if (cooling !== this.#lastCooling) {
      this.#lastCooling = cooling;
      this.root.classList.toggle("ui-on-cooldown", cooling);
    }
    if (label !== this.#lastLabel) {
      this.#lastLabel = label;
      this.#cooldown.textContent = label;
    }
    const hidden = !label || !cooling;
    if (hidden !== this.#lastHidden) {
      this.#lastHidden = hidden;
      this.#cooldown.hidden = hidden;
    }
  }

  setUsable(usable: boolean, reason?: string): void {
    if (usable !== this.#lastUsable) {
      this.#lastUsable = usable;
      this.root.classList.toggle("ui-unusable", !usable);
    }
    if (reason !== undefined) setTip(this.root, reason);
  }
}

/* --- Floating boxes: menus and confirmations -------------------------------------------------
   Every game window is `overflow: auto`, so a box built inside one is clipped by it — that is why
   the tooltip mounts on the body, and why the item menu on the bottom row of a bag used to be cut
   in half. One implementation, on the body, clamped to the viewport, for all of them. */

/** The one floating box on screen. A second call replaces the first rather than stacking. */
let floatingBox: HTMLElement | undefined;
let floatingDismiss: (() => void) | undefined;

export function closeFloating(): void {
  floatingBox?.remove();
  floatingBox = undefined;
  if (floatingDismiss) {
    const dismiss = floatingDismiss;
    floatingDismiss = undefined;
    dismiss();
  }
}

/**
 * Puts a box beside the thing that opened it, nudged back inside the viewport when it would hang
 * off an edge, and closes it on the next click anywhere else or on Escape.
 */
/**
 * Where the pointer was last seen, as the fallback anchor for a box whose opener has gone.
 *
 * The panels redraw by rebuilding, so the element a menu was opened from can be detached by the
 * time the menu measures it — and a detached node's rectangle is all zeros, which throws the box
 * into the top-left corner. The cursor is where the player is looking, so it is the right stand-in.
 */
export const lastPointer = { x: 0, y: 0 };
// Guarded on the method rather than on `document`: the widget tests build panels against a stub
// that has `createElement` and nothing else.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("pointermove", (event) => {
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
  }, { passive: true });
}

export function openFloating(box: HTMLElement, anchor: HTMLElement, onDismiss?: () => void): void {
  closeFloating();
  box.style.position = "fixed";
  box.style.visibility = "hidden";
  box.addEventListener("click", (event) => event.stopPropagation());
  document.body.append(box);
  floatingBox = box;
  floatingDismiss = onDismiss;

  // A node that has been detached — the panels rebuild themselves — measures as all zeros, and the
  // box lands in the top-left corner instead of beside what opened it.
  const at = anchor.isConnected
    ? anchor.getBoundingClientRect()
    : { left: lastPointer.x, top: lastPointer.y, right: lastPointer.x, bottom: lastPointer.y, width: 0, height: 0 };
  const size = box.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(at.left, window.innerWidth - size.width - margin));
  const below = at.bottom + 4;
  const top = below + size.height + margin <= window.innerHeight
    ? below
    : Math.max(margin, at.top - size.height - 4);
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  box.style.visibility = "visible";

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    window.removeEventListener("keydown", onKey, true);
    closeFloating();
  };
  window.addEventListener("keydown", onKey, true);
  window.setTimeout(() => window.addEventListener("click", closeFloating, { once: true }), 0);
}

export interface MenuItem {
  label: string;
  run?: (() => void) | undefined;
  /** A greyed row that says why it cannot be used, rather than a row that is simply missing. */
  enabled?: boolean | undefined;
  /** Kicks, disbands and deletions, coloured so they do not look like the rest. */
  danger?: boolean | undefined;
  /** Opens a second level instead of doing something. */
  submenu?: readonly MenuItem[] | undefined;
}

/**
 * A right-click menu.
 *
 * The interface had none: a unit frame had a click and nothing else, and every action a player
 * expects to reach by right-clicking a name — promote, kick, mark, invite — had nowhere to live.
 */
export function showMenu(anchor: HTMLElement, title: string, items: readonly MenuItem[]): void {
  const menu = document.createElement("div");
  menu.className = "ui-menu";
  if (title) {
    const heading = document.createElement("strong");
    heading.textContent = title;
    menu.append(heading);
  }
  for (const item of items) menu.append(menuRow(anchor, item));
  openFloating(menu, anchor);
}

function menuRow(anchor: HTMLElement, item: MenuItem): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = item.submenu ? `${item.label} ▸` : item.label;
  if (item.danger) button.className = "ui-menu-danger";
  button.disabled = item.enabled === false;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (item.submenu) {
      showMenu(anchor, item.label, item.submenu);
      return;
    }
    closeFloating();
    item.run?.();
  });
  return button;
}

export interface ConfirmOptions {
  title: string;
  lines?: readonly string[] | undefined;
  /** What the accepting button says. «Да» is rarely the clearest word for it. */
  confirm?: string | undefined;
  danger?: boolean | undefined;
  onConfirm: () => void;
}

/**
 * Asking before something irreversible.
 *
 * This replaces `window.confirm`, which is a white system dialog in the middle of a game, and the
 * four places that asked nothing at all: abandoning a quest, deleting an equipment set, cancelling
 * an auction — which forfeits the deposit — and buying a bank slot, which spent gold on one click
 * and never named the price.
 */
export function confirmPanel(anchor: HTMLElement, options: ConfirmOptions): void {
  const box = document.createElement("div");
  box.className = "ui-menu ui-confirm";
  const heading = document.createElement("strong");
  heading.textContent = options.title;
  box.append(heading);
  for (const line of options.lines ?? []) {
    const row = document.createElement("p");
    row.textContent = line;
    box.append(row);
  }
  const actions = document.createElement("div");
  actions.className = "ui-confirm-actions";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.textContent = options.confirm ?? "Подтвердить";
  if (options.danger) accept.className = "ui-menu-danger";
  accept.addEventListener("click", (event) => {
    event.stopPropagation();
    closeFloating();
    options.onConfirm();
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Отмена";
  cancel.addEventListener("click", (event) => {
    event.stopPropagation();
    closeFloating();
  });
  actions.append(accept, cancel);
  box.append(actions);
  openFloating(box, anchor);
}

export interface QuantityOptions {
  title: string;
  /** The largest number the field accepts; the smallest is 1. */
  max: number;
  /** The line under the field for the current number: a total price, for one. */
  describe?: ((units: number) => string) | undefined;
  confirm?: string | undefined;
  onConfirm: (units: number) => void;
}

/** A typed number clamped to 1..max; anything that is not a number is 1. */
export function clampQuantity(value: string | number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(Math.max(1, Math.trunc(max)), Math.trunc(parsed)));
}

/**
 * How many (4.07): the stock stack split frame's job — a number field with ↑/↓, Enter to accept and
 * Escape to close (the floating box's own), and a line that follows the number.
 */
export function quantityPanel(anchor: HTMLElement, options: QuantityOptions): void {
  const box = document.createElement("div");
  box.className = "ui-menu ui-confirm ui-quantity";
  const heading = document.createElement("strong");
  heading.textContent = options.title;
  const field = document.createElement("input");
  field.type = "number";
  field.min = "1";
  field.max = String(Math.max(1, Math.trunc(options.max)));
  field.step = "1";
  field.value = "1";
  field.setAttribute("aria-label", options.title);
  const line = document.createElement("p");
  const units = (): number => clampQuantity(field.value, options.max);
  const describe = (): void => { line.textContent = options.describe?.(units()) ?? ""; };
  describe();
  const accept = (): void => {
    const count = units();
    closeFloating();
    options.onConfirm(count);
  };
  field.addEventListener("input", describe);
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      accept();
    }
  });
  const actions = document.createElement("div");
  actions.className = "ui-confirm-actions";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.textContent = options.confirm ?? "Принять";
  ok.addEventListener("click", (event) => {
    event.stopPropagation();
    accept();
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Отмена";
  cancel.addEventListener("click", (event) => {
    event.stopPropagation();
    closeFloating();
  });
  actions.append(ok, cancel);
  box.append(heading, field, line, actions);
  openFloating(box, anchor);
  field.focus();
  field.select?.();
}
