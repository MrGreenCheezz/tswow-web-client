/**
 * The window and the tab strip the developer tools are built out of (GmConsole.ts, Diagnostics.ts).
 * Both are bare DOM and need nothing else from the interface kit.
 */

/** What a runtime-built panel needs from the layout: somewhere to live, and to be made draggable. */
export interface PanelHost {
  readonly viewport: HTMLElement;
  attach(element: HTMLElement): void;
  /**
   * The other half of {@link attach}, for a panel that is thrown away rather than hidden.
   *
   * Optional because nothing needed it until module windows: every built-in panel is built once
   * and hidden from then on, so the layout's list of windows only ever grew. A module window is
   * rebuilt whenever its file changes (М6's hot reload polls every two seconds while the editor is
   * open), and a layout that kept the discarded ones would grow a list, a resize handler's worth of
   * work and a `MutationObserver` per rebuild for as long as the session lasted.
   */
  detach?(element: HTMLElement): void;
}

let panelHost: PanelHost | undefined;

/**
 * Handed the window manager once at start-up. Kept as a registration rather than an import so the
 * kit itself touches no DOM when it is loaded — otherwise nothing in it can be tested outside a
 * browser, which is most of what is worth testing here.
 */
export function usePanelHost(host: PanelHost): void {
  panelHost = host;
}

export interface PanelOptions {
  id: string;
  title: string;
  /** Extra class on the window, for panels that need their own width or layout. */
  className?: string;
  /**
   * Whether the header carries a close button. Every built-in panel wants one, so it defaults on.
   *
   * A module window is the exception the option exists for: `closeButton` is a field of the
   * studio's screen, and a definition that says `false` means a window closed by its own button or
   * by Escape — drawing a × the author did not ask for is the renderer inventing a control.
   */
  closeButton?: boolean;
  /** Called when the player closes the panel, for the panels the server has to be told about. */
  onClose?: () => void;
}

/**
 * A draggable game window, built and registered the same way the ones in the page markup are, so
 * it remembers where it was put and comes forward when clicked.
 */
export class Panel {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  readonly #title: HTMLElement;

  constructor(options: PanelOptions) {
    this.root = document.createElement("section");
    this.root.id = options.id;
    this.root.className = options.className ? `game-window ${options.className}` : "game-window";
    this.root.hidden = true;

    const header = document.createElement("header");
    this.#title = document.createElement("strong");
    this.#title.textContent = options.title;
    header.append(this.#title);
    if (options.closeButton !== false) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "window-close";
      close.setAttribute("aria-label", "Закрыть");
      close.addEventListener("click", () => {
        this.hide();
        options.onClose?.();
      });
      header.append(close);
    }

    this.body = document.createElement("div");
    this.body.className = "ui-panel-body";
    this.root.append(header, this.body);
    if (!panelHost) throw new Error("usePanelHost has not been called: no layout to build a panel in");
    panelHost.viewport.append(this.root);
    panelHost.attach(this.root);
  }

  set title(text: string) {
    this.#title.textContent = text;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }

  /**
   * Takes the panel off the screen for good, and out of the layout's list with it.
   *
   * Hiding is what a panel normally does; this is for the one that is being replaced — a module
   * window rebuilt from a changed file. The remembered *position* is not dropped: it is keyed on
   * the element id, which the replacement keeps, and that is what puts the new window back where
   * the player dragged the old one.
   */
  destroy(): void {
    panelHost?.detach?.(this.root);
    this.root.remove();
  }
}

export interface TabDefinition {
  id: string;
  title: string;
  /** A count shown beside the title on a tab that is not the active one. */
  badge?: number | undefined;
}

/**
 * One strip of tabs.
 *
 * Three windows had already hand-rolled this — the spellbook, the talent trees and the chat dock —
 * before the guild, the guild bank, the social panel and the scoreboard each wanted one too. This
 * is the same markup those three produce, with the chat dock's accessibility, in one place.
 */
export class Tabs {
  readonly root: HTMLElement;
  #tabs: readonly TabDefinition[] = [];
  #active = "";
  onSelect: ((id: string) => void) | undefined;

  constructor(className = "ui-tabs") {
    this.root = document.createElement("div");
    this.root.className = className;
    this.root.setAttribute("role", "tablist");
  }

  get active(): string {
    return this.#active;
  }

  /** Replaces the strip. An active id that no longer exists falls back to the first tab. */
  set(tabs: readonly TabDefinition[], active?: string): void {
    this.#tabs = tabs;
    const wanted = active ?? this.#active;
    this.#active = tabs.some((tab) => tab.id === wanted) ? wanted : tabs[0]?.id ?? "";
    this.draw();
  }

  select(id: string): void {
    if (id === this.#active || !this.#tabs.some((tab) => tab.id === id)) return;
    this.#active = id;
    this.draw();
    this.onSelect?.(id);
  }

  draw(): void {
    this.root.replaceChildren(...this.#tabs.map((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = tab.id === this.#active ? "ui-tab is-active" : "ui-tab";
      button.textContent = tab.title;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab.id === this.#active));
      if (tab.badge !== undefined && tab.badge > 0 && tab.id !== this.#active) {
        button.dataset["badge"] = String(tab.badge);
      }
      button.addEventListener("click", () => { this.select(tab.id); });
      return button;
    }));
  }
}
