import type { FrameXmlFrame } from "./FrameXmlTypes.js";
import { plainFrameXmlText } from "./FrameXmlText.js";

/** The small part of RenderedFrame needed after the DOM reconciliation pass. */
export interface FrameXmlAccessibilityNode {
  readonly frame: FrameXmlFrame;
  readonly element: HTMLElement;
  readonly input?: HTMLElement;
  readonly sliderInput?: HTMLInputElement;
  readonly effectiveHidden?: boolean;
}

export interface FrameXmlAccessibilityOptions {
  /** Host-only names for fields Lua keeps on a button table (for example race/class DBC names). */
  readonly nameForFrame?: (frame: FrameXmlFrame) => string | undefined;
  /**
   * What a shown dialog (GlueDialog, StaticPopupN, a `modal` frame) does to the rest of the page.
   * "modal", the default — the login screens: everything outside it goes inert and the keyboard is
   * held inside it until it closes. "modeless" — the world: it is announced as a dialog and nothing
   * else changes, as the client's StaticPopups sit over a live game: the 3D world, the native HUD and
   * other windows keep their input, and focus stays wherever the player left it.
   */
  readonly dialogs?: "modal" | "modeless";
}

const MICRO_NAMES: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  Character: ["Персонаж", "Character"],
  Spellbook: ["Книга заклинаний", "Spellbook"],
  Talent: ["Таланты", "Talents"],
  Achievement: ["Достижения", "Achievements"],
  QuestLog: ["Журнал заданий", "Quest log"],
  Socials: ["Общение", "Social"],
  PVP: ["Игрок против игрока", "Player versus player"],
  LFD: ["Поиск подземелья", "Dungeon finder"],
  MainMenu: ["Главное меню", "Main menu"],
  Help: ["Помощь", "Help"],
});

let nextAccessibilityId = 0;

function textOf(frame: FrameXmlFrame): string {
  return plainFrameXmlText(frame.text).replace(/\s+/g, " ").trim();
}

function setAttributeIfChanged(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function enabledAttribute(frame: FrameXmlFrame, key: string): boolean {
  const value = frame.attributes[key] ?? frame.attributes[key.toLowerCase()];
  return value !== undefined && /^(?:true|1)$/i.test(value);
}

function descendants(frame: FrameXmlFrame, visit: (child: FrameXmlFrame) => boolean, limit = 500): FrameXmlFrame | undefined {
  const pending = [...frame.children];
  let examined = 0;
  while (pending.length && examined++ < limit) {
    const child = pending.shift()!;
    if (visit(child)) return child;
    // A control's caption belongs to that control, not its parent or a nearby control.
    if (child.type !== "Button" && child.type !== "CheckButton" && child.type !== "EditBox") {
      pending.unshift(...child.children);
    }
  }
  return undefined;
}

function ownTextSource(frame: FrameXmlFrame): FrameXmlFrame | undefined {
  let first: FrameXmlFrame | undefined;
  descendants(frame, (child) => {
    if (child.type !== "FontString") return false;
    first ??= child;
    if (textOf(child)) { first = child; return true; }
    return false;
  }, 80);
  return first;
}

function namedPeer(frame: FrameXmlFrame, suffix: string): FrameXmlFrame | undefined {
  const parent = frame.parent;
  if (!parent || !frame.named) return undefined;
  const wanted = `${frame.name}${suffix}`;
  return descendants(parent, (child) => child.type === "FontString" && child.name === wanted);
}

function visible(element: HTMLElement | null | undefined): boolean {
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute?.("aria-hidden") === "true"
      || current.style?.display === "none" || current.inert) return false;
  }
  return element !== undefined && element !== null;
}

function isModalFrame(frame: FrameXmlFrame): boolean {
  const name = frame.name;
  if (name === "GlueDialog" || (name.startsWith("StaticPopup") && /^StaticPopup\d+$/.test(name))) return true;
  if (enabledAttribute(frame, "modal")) return true;
  return (frame.frameStrata === "DIALOG" || frame.frameStrata === "FULLSCREEN_DIALOG")
    && frame.toplevel && enabledAttribute(frame, "enableMouse")
    && enabledAttribute(frame, "enableKeyboard");
}

/**
 * Whether `sync` does anything with this frame: a control it labels, or a frame that is a modal
 * dialog. A renderer keeps just these for `sync`'s walk (measured on the rich route: 2,684 of the
 * 19,845 drawn nodes, and the walk over all of them was 0.6 ms of every layout pass).
 */
export function frameXmlAccessibilityCares(frame: FrameXmlFrame): boolean {
  return frame.type === "EditBox" || frame.type === "Slider" || frame.type === "Button"
    || frame.type === "CheckButton" || isModalFrame(frame);
}

function inside(node: Element | null | undefined, ancestor: Element): boolean {
  for (let current = node; current; current = current.parentElement) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Add browser semantics to the already-rendered FrameXML projection. The helper never exposes a
 * DOM object to Lua and never owns a widget action: its only side effects are labels, focus and
 * background inertness while a modal frame is visible (focus and inertness with `dialogs: "modal"`).
 */
export class FrameXmlAccessibility {
  readonly #container: HTMLElement;
  readonly #id = ++nextAccessibilityId;
  readonly #nameForFrame: ((frame: FrameXmlFrame) => string | undefined) | undefined;
  readonly #labelSources = new WeakMap<FrameXmlFrame, {
    readonly source?: FrameXmlFrame;
    readonly childCount: number;
    readonly peerCount: number;
  }>();
  readonly #captionSources = new WeakMap<FrameXmlFrame, {
    readonly childCount: number;
    readonly sources: readonly FrameXmlFrame[];
  }>();
  readonly #ownedLabels = new WeakMap<HTMLElement, string>();
  readonly #fallbackNames = new WeakMap<FrameXmlFrame, { readonly peerCount: number; readonly name: string }>();
  readonly #peerLabelSources = new WeakMap<FrameXmlFrame, Map<string, FrameXmlFrame>>();
  readonly #elementIds = new WeakMap<HTMLElement, string>();
  readonly #inertBefore = new Map<HTMLElement, boolean>();
  readonly #document: Document;
  /** See `FrameXmlAccessibilityOptions.dialogs`: whether a shown dialog freezes the page. */
  readonly #modal: boolean;
  #activeModal: HTMLElement | undefined;
  /** The input of the drawn EditBox Lua last gave focus (`SetFocus`), as of the last sync. */
  #luaFocus: HTMLElement | undefined;
  #returnFocus: HTMLElement | undefined;
  #addedTabIndex = false;
  #listening = false;
  #nextElementId = 0;

  constructor(container: HTMLElement, options: FrameXmlAccessibilityOptions = {}) {
    this.#container = container;
    this.#document = container.ownerDocument;
    this.#nameForFrame = options.nameForFrame;
    this.#modal = options.dialogs !== "modeless";
  }

  #ru(): boolean {
    const lang = this.#document.documentElement?.lang || this.#container.lang || "";
    return /^ru(?:-|$)/i.test(lang);
  }

  #localized(ru: string, en: string): string {
    return this.#ru() ? ru : en;
  }

  #labelSource(frame: FrameXmlFrame): FrameXmlFrame | undefined {
    const cached = this.#labelSources.get(frame);
    if (cached && cached.childCount === frame.children.length
      && cached.peerCount === (frame.parent?.children.length ?? 0)) return cached.source;
    const own = ownTextSource(frame);
    const peer = own && textOf(own) ? undefined : namedPeer(frame, "Text");
    const source = own && textOf(own) ? own : peer ?? own;
    this.#labelSources.set(frame, {
      ...(source ? { source } : {}),
      childCount: frame.children.length,
      peerCount: frame.parent?.children.length ?? 0,
    });
    return source;
  }

  #peerLabel(frame: FrameXmlFrame, name: string): string {
    let root = frame;
    while (root.parent) root = root.parent;
    const cached = this.#peerLabelSources.get(root)?.get(name);
    if (cached) return textOf(cached);
    const peer = descendants(root, (candidate) => candidate.type === "FontString" && candidate.name === name, 2500);
    if (peer) {
      let byName = this.#peerLabelSources.get(root);
      if (!byName) { byName = new Map(); this.#peerLabelSources.set(root, byName); }
      byName.set(name, peer);
    }
    return peer ? textOf(peer) : "";
  }

  #specialName(frame: FrameXmlFrame): string {
    const micro = /^(.*?)MicroButton$/.exec(frame.name);
    if (micro && MICRO_NAMES[micro[1]!]) {
      const [ru, en] = MICRO_NAMES[micro[1]!]!;
      return this.#localized(ru, en);
    }

    if (/^CharacterCreate(?:Race|Class)Button\d+$/.test(frame.name)) {
      const isRace = frame.name.includes("RaceButton");
      const category = this.#peerLabel(frame,
        isRace ? "CharacterCreateRaceLabel" : "CharacterCreateClassLabel")
        || (isRace ? this.#localized("Раса", "Race") : this.#localized("Класс", "Class"));
      return `${category} ${frame.id || 1}`;
    }

    if (frame.name === "CharacterCreateGenderButtonMale") return this.#localized("Мужской пол", "Male");
    if (frame.name === "CharacterCreateGenderButtonFemale") return this.#localized("Женский пол", "Female");

    if (/^CharacterCustomizationButtonFrame\d+(?:Left|Right)Button$/.test(frame.name)) {
      const axis = frame.parent && ownTextSource(frame.parent);
      const label = axis ? textOf(axis) : "";
      const direction = frame.name.endsWith("LeftButton")
        ? this.#localized("предыдущий вариант", "previous option")
        : this.#localized("следующий вариант", "next option");
      return label ? `${label}: ${direction}` : direction;
    }

    if (/RotateLeft$/.test(frame.name)) return this.#localized("Повернуть влево", "Rotate left");
    if (/RotateRight$/.test(frame.name)) return this.#localized("Повернуть вправо", "Rotate right");
    if (/CloseButton$/.test(frame.name)) return this.#localized("Закрыть", "Close");
    return "";
  }

  #fallbackName(frame: FrameXmlFrame): string {
    const peerCount = frame.parent?.children.length ?? 0;
    const cached = this.#fallbackNames.get(frame);
    if (cached && cached.peerCount === peerCount) return cached.name;
    // The stable ordinal distinguishes a row of unnamed icon buttons without reading generated
    // names such as __framexml_690 aloud to the player.
    const sameType = frame.parent?.children.filter((peer) => peer.type === frame.type) ?? [];
    const ordinal = frame.id > 0 ? frame.id : Math.max(1, sameType.indexOf(frame) + 1);
    const kind = frame.type === "EditBox" ? this.#localized("Поле ввода", "Text field")
      : frame.type === "Slider" ? this.#localized("Ползунок", "Slider")
        : frame.type === "CheckButton" ? this.#localized("Флажок", "Checkbox")
          : this.#localized("Кнопка", "Button");
    const name = `${kind} ${ordinal}`;
    this.#fallbackNames.set(frame, { peerCount, name });
    return name;
  }

  #name(frame: FrameXmlFrame): string {
    // EditBox.text is the player's input, including passwords. It is never an accessible name.
    if (frame.type !== "EditBox") {
      const direct = textOf(frame);
      if (direct) return direct;
    }
    const source = this.#labelSource(frame);
    if (source) {
      const caption = textOf(source);
      if (caption) return caption;
    }
    const supplied = this.#nameForFrame?.(frame);
    if (supplied) {
      const name = plainFrameXmlText(supplied).replace(/\s+/g, " ").trim();
      if (name) return name;
    }
    return this.#specialName(frame) || this.#fallbackName(frame);
  }

  #hasNativeButtonName(frame: FrameXmlFrame): boolean {
    // The button element already contains the renderer's inline text and all visible FontStrings.
    // In particular, a character button combines name, class/level and zone. An aria-label made
    // from just the first FontString would replace that useful browser-computed aggregate.
    if (!frame.stateTextures.has("BUTTONTEXT") && !!textOf(frame)) return true;
    let cached = this.#captionSources.get(frame);
    if (!cached || cached.childCount !== frame.children.length) {
      const sources: FrameXmlFrame[] = [];
      const pending = [...frame.children];
      while (pending.length) {
        const child = pending.pop()!;
        if (child.type === "FontString") sources.push(child);
        else if (child.type !== "Button" && child.type !== "CheckButton" && child.type !== "EditBox") {
          pending.push(...child.children);
        }
      }
      cached = { childCount: frame.children.length, sources };
      this.#captionSources.set(frame, cached);
    }
    return cached.sources.some((source) => {
      if (!textOf(source)) return false;
      for (let owner: FrameXmlFrame | undefined = source; owner && owner !== frame; owner = owner.parent) {
        if (!owner.visible) return false;
      }
      return true;
    });
  }

  #setButtonName(frame: FrameXmlFrame, element: HTMLElement): void {
    const previous = this.#ownedLabels.get(element);
    const current = element.getAttribute("aria-label");
    if (this.#hasNativeButtonName(frame)) {
      if (previous !== undefined && current === previous) element.removeAttribute("aria-label");
      this.#ownedLabels.delete(element);
      return;
    }
    // A host-supplied label is already more specific than a generic FrameXML fallback.
    if (current !== null && (previous === undefined || current !== previous)) {
      this.#ownedLabels.delete(element);
      return;
    }
    const name = this.#name(frame);
    setAttributeIfChanged(element, "aria-label", name);
    this.#ownedLabels.set(element, name);
  }

  #applyControl(node: FrameXmlAccessibilityNode): void {
    const { frame, element } = node;
    if (frame.type === "EditBox" && node.input) {
      setAttributeIfChanged(node.input, "aria-label", this.#name(frame));
      if (frame.name === "AccountLoginAccountEdit") {
        setAttributeIfChanged(node.input, "autocomplete", "username");
        setAttributeIfChanged(node.input, "autocapitalize", "none");
        setAttributeIfChanged(node.input, "spellcheck", "false");
      } else if (frame.name === "AccountLoginPasswordEdit") {
        setAttributeIfChanged(node.input, "autocomplete", "current-password");
      }
    } else if (frame.type === "Slider" && node.sliderInput) {
      setAttributeIfChanged(node.sliderInput, "aria-label", this.#name(frame));
    } else if (frame.type === "Button" || frame.type === "CheckButton") {
      this.#setButtonName(frame, element);
      if (frame.type === "CheckButton") {
        setAttributeIfChanged(element, "role", "checkbox");
        setAttributeIfChanged(element, "aria-checked", String(frame.checked));
      }
    }
  }

  #isModal(frame: FrameXmlFrame): boolean {
    return isModalFrame(frame);
  }

  #domId(element: HTMLElement): string {
    const existing = element.getAttribute("id");
    if (existing) return existing;
    let generated = this.#elementIds.get(element);
    if (!generated) {
      generated = `framexml-a11y-${this.#id}-${++this.#nextElementId}`;
      this.#elementIds.set(element, generated);
    }
    element.setAttribute("id", generated);
    return generated;
  }

  #modalMessage(frame: FrameXmlFrame): FrameXmlFrame | undefined {
    const preferred = frame.name === "GlueDialog"
      ? descendants(frame, (child) => child.type === "FontString" && child.name === "GlueDialogText")
      : undefined;
    return preferred ?? descendants(frame, (child) => child.type === "FontString" && !!textOf(child));
  }

  #applyModalSemantics(node: FrameXmlAccessibilityNode,
    nodes: ReadonlyMap<FrameXmlFrame, FrameXmlAccessibilityNode>): void {
    const { frame, element } = node;
    let buttonCount = 0;
    const pending = [...frame.children];
    while (pending.length) {
      const candidate = pending.pop()!;
      const candidateNode = nodes.get(candidate);
      if (candidate.type === "Button" && candidateNode && !candidateNode.effectiveHidden) buttonCount += 1;
      pending.push(...candidate.children);
    }
    const message = this.#modalMessage(frame);
    const messageNode = message && nodes.get(message);
    const isAlert = (frame.name === "GlueDialog" && buttonCount === 1 && !!message && !!textOf(message))
      || /(?:Error|Alert)/i.test(frame.name);
    setAttributeIfChanged(element, "role", isAlert ? "alertdialog" : "dialog");
    if (this.#modal) setAttributeIfChanged(element, "aria-modal", "true");
    else element.removeAttribute("aria-modal");
    if (messageNode && !messageNode.effectiveHidden && textOf(message!)) {
      setAttributeIfChanged(element, "aria-labelledby", this.#domId(messageNode.element));
      element.removeAttribute("aria-label");
    } else {
      setAttributeIfChanged(element, "aria-label",
        textOf(frame) || this.#localized("Сообщение", "Dialog"));
      element.removeAttribute("aria-labelledby");
    }
  }

  #focusables(root: HTMLElement): HTMLElement[] {
    const result: HTMLElement[] = [];
    const pending: HTMLElement[] = [root];
    while (pending.length) {
      const item = pending.shift()!;
      if (!visible(item)) continue;
      const tag = item.tagName?.toLowerCase();
      const tabindex = Number(item.getAttribute?.("tabindex"));
      const native = tag === "button" || tag === "input" || tag === "select" || tag === "textarea";
      if ((native || (item.hasAttribute?.("tabindex") && tabindex >= 0))
        && !(item as HTMLButtonElement).disabled && item.getAttribute?.("aria-disabled") !== "true") {
        result.push(item);
      }
      pending.unshift(...Array.from(item.children) as HTMLElement[]);
    }
    return result;
  }

  #focusFirst(): void {
    const modal = this.#activeModal;
    if (!modal) return;
    // Lua's own keyboard focus comes first. `StaticPopup_Show("SET_FRIENDNOTE")` runs the dialog's
    // `OnShow`, which is `self.wideEditBox:SetFocus()` (StaticPopup.lua:1764), and the client opens
    // the note with the caret in that box. Sending focus to the first focusable instead put it on
    // `StaticPopup1Button1`, whose arrival blurred the box (`OnEditFocusLost`, HasFocus false) —
    // measured on the rich route: the typed «abc» went nowhere.
    const luaFocus = this.#luaFocus;
    if (luaFocus && inside(luaFocus, modal) && visible(luaFocus)) {
      if (this.#document.activeElement !== luaFocus) luaFocus.focus?.();
      return;
    }
    const target = this.#focusables(modal)[0];
    if (target) target.focus?.();
    else {
      if (!modal.hasAttribute?.("tabindex")) {
        modal.setAttribute("tabindex", "-1");
        this.#addedTabIndex = true;
      }
      modal.focus?.();
    }
  }

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab" || !this.#activeModal) return;
    const focusables = this.#focusables(this.#activeModal);
    if (!focusables.length) {
      event.preventDefault();
      this.#focusFirst();
      return;
    }
    const active = this.#document.activeElement as HTMLElement | null;
    const index = active ? focusables.indexOf(active) : -1;
    if (index < 0 || (!event.shiftKey && index === focusables.length - 1)
      || (event.shiftKey && index === 0)) {
      event.preventDefault();
      (event.shiftKey ? focusables[focusables.length - 1] : focusables[0])?.focus?.();
    }
  };

  readonly #onFocusIn = (event: FocusEvent): void => {
    if (!this.#activeModal || inside(event.target as Element | null, this.#activeModal)) return;
    this.#focusFirst();
  };

  #listen(enabled: boolean): void {
    if (enabled === this.#listening) return;
    this.#listening = enabled;
    if (enabled) {
      this.#document.addEventListener?.("keydown", this.#onKeyDown, true);
      this.#document.addEventListener?.("focusin", this.#onFocusIn, true);
    } else {
      this.#document.removeEventListener?.("keydown", this.#onKeyDown, true);
      this.#document.removeEventListener?.("focusin", this.#onFocusIn, true);
    }
  }

  #inertBackground(modal: HTMLElement | undefined): void {
    const wanted = new Set<HTMLElement>();
    if (modal) {
      let path: HTMLElement = modal;
      while (path.parentElement) {
        const parent = path.parentElement;
        for (const sibling of Array.from(parent.children) as HTMLElement[]) {
          if (sibling !== path) wanted.add(sibling);
        }
        if (parent === this.#document.body) break;
        path = parent;
      }
    }
    for (const [element, previous] of this.#inertBefore) {
      if (wanted.has(element)) continue;
      element.inert = previous;
      this.#inertBefore.delete(element);
    }
    for (const element of wanted) {
      if (!this.#inertBefore.has(element)) this.#inertBefore.set(element, element.inert);
      element.inert = true;
    }
  }

  #closeModal(restoreFocus: boolean): void {
    const old = this.#activeModal;
    if (old) {
      old.removeAttribute("role");
      old.removeAttribute("aria-modal");
      old.removeAttribute("aria-labelledby");
      old.removeAttribute("aria-label");
      if (this.#addedTabIndex) old.removeAttribute("tabindex");
    }
    this.#activeModal = undefined;
    this.#addedTabIndex = false;
    this.#listen(false);
    this.#inertBackground(undefined);
    if (restoreFocus && this.#returnFocus && visible(this.#returnFocus)
      && this.#returnFocus.isConnected !== false) this.#returnFocus.focus?.();
    this.#returnFocus = undefined;
  }

  /**
   * Call once after each complete renderer sync, after child nodes and their text are current.
   * `walk` is the nodes to label and to look for a modal among — every node, or just those
   * `frameXmlAccessibilityCares` about (the rest are skipped anyway); `nodes` answers lookups.
   */
  sync(nodes: ReadonlyMap<FrameXmlFrame, FrameXmlAccessibilityNode>,
    walk: Iterable<FrameXmlAccessibilityNode> = nodes.values()): void {
    let modal: FrameXmlAccessibilityNode | undefined;
    let modalRank = -1;
    let luaFocused: HTMLElement[] | undefined;
    for (const node of walk) {
      if (!node.effectiveHidden && (node.frame.type === "EditBox" || node.frame.type === "Slider"
        || node.frame.type === "Button" || node.frame.type === "CheckButton")) this.#applyControl(node);
      if (!node.effectiveHidden && node.frame.type === "EditBox" && node.frame.editBox.focused && node.input) {
        (luaFocused ??= []).push(node.input);
      }
      if (node.effectiveHidden || !this.#isModal(node.frame)) continue;
      const rank = node.frame.frameStrata === "FULLSCREEN_DIALOG" ? 2
        : node.frame.frameStrata === "DIALOG" ? 1 : 0;
      if (rank >= modalRank) { modal = node; modalRank = rank; }
    }
    // `SetFocus` does not clear a stale flag elsewhere (the chat box can still say focused), so the
    // one that counts is the box inside the modal.
    this.#luaFocus = (modal ? luaFocused?.find((input) => inside(input, modal.element)) : undefined)
      ?? luaFocused?.[0];

    if (!modal) {
      if (this.#activeModal) this.#closeModal(true);
      return;
    }
    if (modal.element !== this.#activeModal) {
      if (!this.#activeModal) {
        const active = this.#document.activeElement;
        // A modeless dialog never took the keyboard, so closing it gives nothing back.
        this.#returnFocus = this.#modal && active && typeof (active as HTMLElement).focus === "function"
          ? active as HTMLElement : undefined;
      } else {
        this.#activeModal.removeAttribute("role");
        this.#activeModal.removeAttribute("aria-modal");
        this.#activeModal.removeAttribute("aria-labelledby");
        this.#activeModal.removeAttribute("aria-label");
        if (this.#addedTabIndex) this.#activeModal.removeAttribute("tabindex");
        this.#addedTabIndex = false;
      }
      this.#activeModal = modal.element;
      if (this.#modal) {
        this.#listen(true);
        this.#inertBackground(modal.element);
      }
      this.#applyModalSemantics(modal, nodes);
      if (this.#modal) this.#focusFirst();
    } else {
      this.#applyModalSemantics(modal, nodes);
      if (this.#modal && !inside(this.#document.activeElement, modal.element)) this.#focusFirst();
    }
  }

  destroy(): void {
    this.#closeModal(true);
    this.#luaFocus = undefined;
  }
}
