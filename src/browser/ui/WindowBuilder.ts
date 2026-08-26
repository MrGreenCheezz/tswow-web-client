/**
 * The built-in window editor: a panel of three panes beside the window it is editing.
 *
 * Deliberately narrower than the owner's content studio. The studio is where a screen is authored
 * and where the Lua addon is generated from it; this is for adjusting one **while looking at the
 * game** — the bar is the wrong colour against the actual health bar, the button is four pixels off
 * the frame's edge, the label reads blank because the path is misspelled. All three of those are
 * questions you cannot answer in a form, and all three are answered here in a second.
 *
 * Three decisions carry the whole file.
 *
 * * **The preview is the real renderer.** `renderWindow` draws it, `windowRegistry` holds it and the
 *   once-a-frame binding pass updates it, exactly as it would a module's own window — so what is on
 *   screen while editing is what ships, and there is no second renderer to drift. It also means the
 *   preview follows the live game: open the editor with a target selected and a `targetHealth` bar
 *   moves while you drag it.
 * * **Every edit goes through `WindowBuilderModel`.** Nothing here changes a definition; it calls a
 *   pure function and redraws from the answer. That is what lets the editor's behaviour be tested
 *   with no document at all, and it is why a refused edit costs a keystroke: the model hands the
 *   previous definition straight back.
 * * **It works with no session.** The «Окна» pane opens before login and so does this: the editor
 *   starts on `examples/module-example/ui/example.json`, which the dev server hands over as it
 *   stands, and every path through it — add, drag, export to the clipboard — runs with `game.world`
 *   undefined. Only the things that genuinely need a world (a live value beside a binding, the list
 *   of message schemas) are empty until there is one, and they say so.
 *
 * Opened from the «Окна» pane of the diagnostics window and by the action `toggleWindowBuilder`,
 * which ships **unbound**: it is registered in the same dynamic table a module's own key goes into,
 * so `tests/bindings.test.mjs`'s «every compiled-in action ships with a key, and no two share one»
 * stays honest, and the player chooses the key in the bindings window.
 */

import { game } from "../game/Context.js";
import { UI_SOUNDS } from "../game/GameSounds.js";
import { addModuleAction } from "../input/Bindings.js";
import { parseCustomMessages, type CustomMessage } from "../../world/CustomCodec.js";
import { moduleActionHost, moduleWindowHost } from "./ModuleClient.js";
import { Panel, Tabs, attachTooltip, confirmPanel, showMenu } from "./Widgets.js";
import {
  evaluate, formatExpressionValue, parseExpression, parseTemplate, type ExpressionHelpers,
} from "./WindowExpression.js";
import type { LiveWindow } from "./WindowRender.js";
import { windowRegistry } from "./WindowRegistry.js";
import {
  WIDGET_TYPES, WINDOW_BINDINGS, WINDOW_CONDITIONS, parseWindowDefinition, type WidgetType,
} from "./WindowSchema.js";
import { openParsedWindow } from "./WindowsTab.js";
import {
  ACTION_FORMS, actionForm, actionListKey, addWidget, addWidgetAction, addWidgetCondition,
  applyDefinitionText, builderTree, colorFieldText, colorFieldValue, conditionFields,
  copyWindowDefinition, definitionText, deleteWidget, draggedAnchor, draggedSize, duplicateWidget,
  emptyWindowDefinition, exportWindowDefinition, fieldWrite, fieldsFor, movableWidgets, moveWidget,
  removeListEntry, renameWidget, reparentTargets, reparentWidget, resizeWidget, screenOf,
  setListEntryField, setWidgetField, skeletonFromMessage, widgetBox, widgetId, widgetList, widgetType,
  type ActionDefaults, type BuilderField, type BuilderResult, type JsonRecord,
} from "./WindowBuilderModel.js";

/** Where the example the editor opens on lives, and the module name it is loaded under. */
const EXAMPLE_URL = "/examples/module-example/ui/example.json";
const EXAMPLE_MESSAGES_URL = "/examples/module-example/messages/example.json";
const BUILDER_MODULE = "builder";

/**
 * How close to a widget's right or bottom edge a press has to be to mean «растянуть».
 *
 * Six pixels, which is the width of the resize margin every window manager uses and is wide enough
 * to catch on a 20-pixel-high label without swallowing the middle of it.
 */
const EDGE_GRIP = 6;

/** A pointer that moved less than this is a click that selected something, not a drag. */
const DRAG_SLOP = 2;

function line(className: string, text: string): HTMLElement {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

function button(label: string, run: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", run);
  return node;
}

/**
 * The `{ru, en}` half of a field, or a plain string, as one line of text for an input.
 *
 * The studio writes localised pairs and this client reads the Russian half; a field edited here
 * keeps the pair and rewrites only that half, so an English string somebody typed in the studio
 * survives a drag in the game.
 */
function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ru = (value as Record<string, unknown>)["ru"];
    if (typeof ru === "string") return ru;
  }
  return "";
}


/** Reads one field off a widget's JSON, `anchor.x` included. */
function readField(widget: JsonRecord, key: string): unknown {
  const cut = key.indexOf(".");
  if (cut < 0) return widget[key];
  const nested = widget[key.slice(0, cut)];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)[key.slice(cut + 1)]
    : undefined;
}

/**
 * The same reading, one level into a list entry — `value.entry` of a `sendCustom`, `args.0` of a
 * `command`. The mirror of `setListEntryField`'s write, and it has to know about the array for the
 * same reason that one does: a command's arguments are read by position.
 */
function readPath(entry: JsonRecord, path: string): unknown {
  const cut = path.indexOf(".");
  if (cut < 0) return entry[path];
  const head = entry[path.slice(0, cut)];
  const leaf = path.slice(cut + 1);
  if (Array.isArray(head)) return /^[0-9]+$/.test(leaf) ? head[Number(leaf)] : undefined;
  return head && typeof head === "object" ? (head as Record<string, unknown>)[leaf] : undefined;
}

/** The narrow «= что это сейчас» beside a field. */
function liveColumn(text: string): HTMLElement {
  const column = document.createElement("em");
  column.className = "builder-live";
  column.textContent = text;
  return column;
}

/** The widget's raw JSON, found by id. */
function rawWidget(definition: JsonRecord, id: string): JsonRecord | undefined {
  const screen = screenOf(definition);
  if (!screen) return undefined;
  const look = (widget: JsonRecord): JsonRecord | undefined => {
    if (widgetId(widget) === id) return widget;
    const children = widget["children"];
    if (!Array.isArray(children)) return undefined;
    for (const child of children) {
      if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
      const found = look(child as JsonRecord);
      if (found) return found;
    }
    return undefined;
  };
  return look(screen);
}

class WindowBuilder {
  readonly #panel: Panel;
  readonly #status: HTMLElement;
  readonly #tabs = new Tabs();
  readonly #tree = document.createElement("div");
  readonly #inspector = document.createElement("div");
  readonly #json = document.createElement("textarea");
  readonly #jsonPane = document.createElement("div");

  #definition: JsonRecord;
  #module = BUILDER_MODULE;
  #file = "builder-window.json";
  #selected = "";
  #preview: LiveWindow | undefined;
  /** The schemas the «скелет из схемы» menu offers when there is no world to read them from. */
  #exampleMessages: readonly CustomMessage[] = [];

  constructor() {
    this.#definition = emptyWindowDefinition({ id: "builder-window", title: "Новое окно" });
    this.#panel = new Panel({
      id: "window-builder",
      title: "Редактор окон",
      className: "window-builder",
      onClose: () => { this.#dropPreview(); },
    });
    this.#status = line("muted", "");

    const bar = document.createElement("div");
    bar.className = "builder-actions";
    const create = button("Создать окно", () => { this.#createMenu(create); });
    const add = button("Виджет +", () => { this.#addMenu(add); });
    const remove = button("Удалить", () => { this.#confirmDelete(remove); });
    bar.append(
      create,
      add,
      button("Дублировать", () => { this.#apply(duplicateWidget(this.#definition, this.#selected, this.#context())); }),
      remove,
    );
    const exportButton = button("Экспорт", () => { void this.#export(); });
    attachTooltip(exportButton, () => ({
      title: "JSON в буфер обмена; шлюз пишет файл только при MODULE_UI_WRITE=1 и только с этой машины",
    }));
    bar.append(exportButton);

    this.#tree.className = "builder-tree";
    this.#inspector.className = "builder-inspector";
    this.#json.className = "builder-json";
    this.#json.spellcheck = false;
    this.#jsonPane.className = "builder-json-pane";
    this.#jsonPane.append(
      this.#json,
      button("Применить JSON", () => {
        this.#apply(applyDefinitionText(this.#definition, this.#json.value, this.#context()));
      }),
    );

    this.#tabs.set([
      { id: "tree", title: "Дерево" },
      { id: "fields", title: "Поля" },
      { id: "json", title: "JSON" },
    ], "tree");
    this.#tabs.onSelect = (id) => { this.#showPane(id); };

    this.#panel.body.append(bar, this.#status, this.#tabs.root, this.#tree, this.#inspector, this.#jsonPane);
    this.#showPane("tree");
  }

  #context(): { module: string } {
    return { module: this.#module };
  }

  toggle(): void {
    if (this.#panel.visible) {
      this.#panel.hide();
      this.#dropPreview();
      return;
    }
    this.#panel.show();
    // Closing takes the preview off the screen, so re-opening has to draw it again rather than
    // leaving the panel talking about a window that is not there. `#openExample` only fetches when
    // nothing has been loaded yet, which is the first press and no other.
    if (this.#selected) this.#redraw();
    else void this.#openExample();
    // Started here rather than when the menu is opened, so that «скелет из схемы» is offered on the
    // first press instead of on the second: without a world there is no registry to read schemas
    // from, and the example beside the client is what makes the road walkable before login.
    if (this.#exampleMessages.length === 0) void this.#loadExampleMessages();
  }

  /**
   * The editor's first window: the example beside the client.
   *
   * Fetched rather than compiled in, and that is the point — it is the same file a module ships and
   * the same route the loader would take, so «открыть, подвинуть, экспортировать» is the whole road
   * a real definition travels, with no server and no session in it. A machine with no dev server
   * behind it falls back to an empty frame rather than to nothing.
   */
  async #openExample(): Promise<void> {
    if (this.#selected) return;
    try {
      const response = await fetch(EXAMPLE_URL);
      if (!response.ok) throw new Error(`ответ ${response.status}`);
      const raw = await response.json() as JsonRecord;
      this.#load(raw, "example", "example.json", "Открыт examples/module-example/ui/example.json");
    } catch (error) {
      this.#load(this.#definition, BUILDER_MODULE, this.#file,
        `пример не открылся (${error instanceof Error ? error.message : String(error)}) — пустая рамка`);
    }
  }

  /** Replaces what is being edited, whole. */
  #load(definition: JsonRecord, module: string, file: string, note: string): void {
    this.#dropPreview();
    this.#definition = definition;
    this.#module = module;
    this.#file = file;
    const screen = screenOf(definition);
    this.#selected = screen ? widgetId(screen) : "";
    this.#say(note, false);
    this.#redraw();
  }

  #say(text: string, bad: boolean): void {
    this.#status.className = bad ? "error" : "muted";
    this.#status.textContent = text;
  }

  /**
   * Adds to the status line rather than replacing it.
   *
   * The redraw happens *after* the edit has said what it did, and what the redraw has to add — «the
   * id was taken, the preview is under another name» — is a second fact about the same press and
   * not a replacement for the first.
   */
  #addNote(text: string): void {
    const before = this.#status.textContent ?? "";
    this.#status.textContent = before ? `${before} · ${text}` : text;
  }

  #apply(result: BuilderResult): void {
    this.#definition = result.definition;
    this.#selected = result.selected || this.#selected;
    this.#say(result.problems.join(" · ") || "готово", !result.changed);
    this.#redraw();
  }

  #showPane(id: string): void {
    this.#tree.hidden = id !== "tree";
    this.#inspector.hidden = id !== "fields";
    this.#jsonPane.hidden = id !== "json";
  }

  /* -------------------------------------------------------------------------------------------
   * Drawing the three panes and the preview
   * ----------------------------------------------------------------------------------------- */

  #redraw(): void {
    this.#drawTree();
    this.#drawInspector();
    this.#json.value = definitionText(this.#definition);
    this.#drawPreview();
  }

  #drawTree(): void {
    const rows = builderTree(this.#definition);
    // Worked out once for the whole tree rather than once per row: asking «has this widget anywhere
    // to go?» through `reparentTargets` walks the definition again each time, measured at 1,87 мс
    // of every redraw on a 200-widget window against 0,23 for one walk.
    const movable = movableWidgets(this.#definition);
    this.#tree.replaceChildren(...rows.map((row) => {
      const node = document.createElement("div");
      node.className = row.id === this.#selected ? "builder-row is-selected" : "builder-row";
      node.style.paddingLeft = `${row.depth * 12}px`;
      node.dataset["widget"] = row.id;
      const name = button(`${row.type} · ${row.id}`, () => { this.#select(row.id); });
      name.className = "builder-row-name";
      node.append(name);
      // The one tree edit that is not a button of its own, and it appears only where the move has
      // somewhere to go. `movableWidgets` is the model's own three rules — not itself, not the
      // frame it is already in, nothing inside its own subtree — and the menu used to be filtered
      // by only the first of them, so on the two commonest window shapes there are, a flat one and
      // a root holding two frames, every «в…» opened a menu of nothing but refusals.
      if (movable.has(row.id)) {
        const into = button("в…", () => { this.#reparentMenu(into, row.id); });
        into.className = "builder-row-into";
        node.append(into);
      }
      return node;
    }));
  }

  #select(id: string): void {
    this.#selected = id;
    this.#drawTree();
    this.#drawInspector();
    this.#markSelection();
  }

  /**
   * The inspector: the fields of the widget, then what it *does*, then when it is *shown*.
   *
   * Beside every expression field, and beside the named binding, is what it evaluates to *right
   * now*, against the same published view the binding pass reads — which is the difference between
   * «{player.helth}» looking wrong and looking like every other field. A client with no world
   * publishes an empty view, so the column reads blank rather than lying.
   *
   * The two lists below the fields are the half that was missing at first, and the acceptance is
   * what named it: «дать кнопке действие-пакет» is a step of the plan's live walkthrough, and with
   * no action rows the only road to it was typing raw JSON into the third tab — which is not an
   * editor, it is a text box beside one.
   */
  #drawInspector(): void {
    const widget = rawWidget(this.#definition, this.#selected);
    if (!widget) {
      this.#inspector.replaceChildren(line("muted", "Виджет не выбран."));
      return;
    }
    const screen = screenOf(this.#definition);
    const isRoot = screen !== undefined && widgetId(screen) === this.#selected;
    const type = widgetType(widget);
    const rows: HTMLElement[] = [this.#renameRow(this.#selected)];
    const live = this.#scope();
    for (const spec of fieldsFor(type, isRoot)) {
      rows.push(this.#fieldRow(widget, spec, live));
    }
    rows.push(...this.#actionRows(type, live));
    rows.push(...this.#conditionRows(live));
    this.#inspector.replaceChildren(...rows);
  }

  /** A heading with the «+» that adds to the list under it. */
  #groupRow(title: string, add: (anchor: HTMLElement) => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "builder-group";
    const label = document.createElement("span");
    label.textContent = title;
    const plus = button("+", () => { add(plus); });
    plus.className = "builder-group-add";
    row.append(label, plus);
    return row;
  }

  /**
   * What the widget does, in the key its own type is read from.
   *
   * The key is shown in the heading — «Действия (onChange)» — because which key a type is read from
   * is the one thing about this that cannot be guessed from the screen: a list under `actions` on a
   * `DropDown` is a list nothing ever runs, and the heading is where an author reading their own
   * file afterwards learns why.
   */
  #actionRows(
    type: string,
    live: { readonly scope: Readonly<Record<string, unknown>>; readonly helpers: ExpressionHelpers },
  ): HTMLElement[] {
    const key = actionListKey(type);
    if (!key) return [];
    const rows: HTMLElement[] = [this.#groupRow(`Действия (${key})`, (anchor) => { this.#actionMenu(anchor); })];
    const entries = widgetList(this.#definition, this.#selected, key);
    if (entries.length === 0) rows.push(line("muted", "Ничего не делает."));
    for (const [index, entry] of entries.entries()) {
      const form = actionForm(entry);
      rows.push(this.#entryHead(form ? form.label : `«${String(entry["do"] ?? "?")}» — правится в JSON`, key, index));
      if (!form) continue;
      for (const spec of form.fields) {
        rows.push(this.#entryRow(entry, key, index, spec, live, this.#entryChoices(spec, form.verb)));
      }
      // `sendCustom` carries one field per field of the schema it names, and the schema is not
      // known until the message is chosen — so the rows are drawn from the registry rather than
      // from a table. Every one of them has to be set: `checkWindowActions` says so by name, and
      // the codec would refuse at the press.
      if (form.verb !== "sendCustom") continue;
      const message = this.#messages().find((known) => known.name === entry["message"]);
      if (!message) {
        rows.push(line("error", `схемы «${String(entry["message"] ?? "")}» этот клиент не знает`));
        continue;
      }
      for (const messageField of message.fields) {
        rows.push(this.#entryRow(
          entry, key, index,
          { key: `value.${messageField.name}`, label: `→ ${messageField.name}`, kind: "expression" },
          live,
        ));
      }
    }
    return rows;
  }

  /** Which menu a form's `choice` field is filled from when the table could not know. */
  #entryChoices(spec: BuilderField, verb: string): readonly string[] | undefined {
    if (spec.choices) return spec.choices;
    if (verb === "sendCustom" && spec.key === "message") {
      return this.#messages().filter((message) => message.direction !== "in").map((message) => message.name);
    }
    if (verb === "sound" && spec.key === "kit") return Object.keys(UI_SOUNDS);
    return undefined;
  }

  /** When the widget is shown, hidden, coloured or faded — the studio's eighteen conditions. */
  #conditionRows(
    live: { readonly scope: Readonly<Record<string, unknown>>; readonly helpers: ExpressionHelpers },
  ): HTMLElement[] {
    const rows: HTMLElement[] = [this.#groupRow("Условия", (anchor) => { this.#conditionMenu(anchor); })];
    const entries = widgetList(this.#definition, this.#selected, "conditions");
    if (entries.length === 0) rows.push(line("muted", "Виден всегда."));
    for (const [index, entry] of entries.entries()) {
      const when = typeof entry["when"] === "string" ? entry["when"] : "";
      const then = typeof entry["then"] === "string" ? entry["then"] : "show";
      rows.push(this.#entryHead(`${when} → ${then}`, "conditions", index));
      for (const spec of conditionFields(when, then)) {
        rows.push(this.#entryRow(entry, "conditions", index, spec, live));
      }
    }
    return rows;
  }

  /** The line that names one entry of a list and takes it away again. */
  #entryHead(title: string, key: string, index: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "builder-entry";
    const label = document.createElement("span");
    label.textContent = `${index + 1}. ${title}`;
    const drop = button("−", () => {
      this.#apply(removeListEntry(this.#definition, this.#selected, key, index, this.#context()));
    });
    drop.className = "builder-entry-drop";
    row.append(label, drop);
    return row;
  }

  #actionMenu(anchor: HTMLElement): void {
    const defaults = this.#actionDefaults();
    showMenu(anchor, "Добавить действие", ACTION_FORMS.map((form) => ({
      label: form.label,
      run: () => {
        this.#apply(addWidgetAction(this.#definition, this.#selected, form.verb, defaults, this.#context()));
      },
    })));
  }

  /**
   * What a new action starts as: this window, the widget beside it, the first outgoing schema.
   *
   * Everything here is a name the model cannot see and the editor can, and every one of them is a
   * name `checkWindowActions` would complain about if it were left empty — so a freshly added
   * action is one the author fills in rather than one they first have to repair.
   */
  #actionDefaults(): ActionDefaults {
    const rows = builderTree(this.#definition);
    const screen = screenOf(this.#definition);
    const outgoing = this.#messages().find((message) => message.direction !== "in");
    return {
      windowId: screen ? widgetId(screen) : "",
      widget: rows.find((row) => row.id !== this.#selected)?.id ?? this.#selected,
      message: outgoing?.name ?? "",
      soundKit: Object.keys(UI_SOUNDS)[0] ?? "",
    };
  }

  #conditionMenu(anchor: HTMLElement): void {
    showMenu(anchor, "Добавить условие", WINDOW_CONDITIONS.map((option) => ({
      label: option.label,
      run: () => {
        this.#apply(addWidgetCondition(this.#definition, this.#selected, option.name, this.#context()));
      },
    })));
  }

  /** One field of one list entry, written back through the model. */
  #entryRow(
    entry: JsonRecord,
    key: string,
    index: number,
    spec: BuilderField,
    live: { readonly scope: Readonly<Record<string, unknown>>; readonly helpers: ExpressionHelpers },
    choices?: readonly string[] | undefined,
  ): HTMLElement {
    const current = readPath(entry, spec.key);
    // `numbers` is on here and off for a widget's own fields: an action's values are read with
    // `WidgetReader.raw`, where a bare 5 is the number and "5" is the string — and a `u32` field of
    // a message given the string encodes nothing at all.
    return this.#controlRow(spec, current, live, choices, (value) => {
      this.#apply(setListEntryField(this.#definition, this.#selected, key, index, spec.key, value, this.#context()));
    }, true);
  }

  /**
   * What the inspector's live column evaluates against: the published view, plus this window's own
   * state, plus the helpers `spellName`/`itemName`/`loc` resolve through.
   *
   * All three, because all three are what the *renderer* evaluates against — `update` folds `state`
   * into the scope and hands the helpers along — and a column that answered differently from the
   * widget two inches away would be worse than no column at all.
   */
  #scope(): { readonly scope: Readonly<Record<string, unknown>>; readonly helpers: ExpressionHelpers } {
    const state = this.#preview?.state ?? {};
    try {
      const host = moduleActionHost();
      return { scope: { ...(host.snapshot?.() ?? {}), state }, helpers: host.helpers ?? {} };
    } catch {
      // A client between worlds, or one whose settings have not been read yet. The live column is a
      // convenience and must never be the reason the editor will not open.
      return { scope: { state }, helpers: {} };
    }
  }

  #renameRow(id: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "builder-field";
    const label = document.createElement("label");
    label.textContent = "Имя (id)";
    const input = document.createElement("input");
    input.type = "text";
    input.value = id;
    row.append(label, input, button("Переименовать", () => {
      this.#apply(renameWidget(this.#definition, id, input.value.trim(), this.#context()));
    }));
    return row;
  }

  #fieldRow(
    widget: JsonRecord,
    spec: BuilderField,
    live: { readonly scope: Readonly<Record<string, unknown>>; readonly helpers: ExpressionHelpers },
  ): HTMLElement {
    return this.#controlRow(spec, readField(widget, spec.key), live, undefined, (value) => {
      this.#apply(setWidgetField(this.#definition, this.#selected, spec.key, value, this.#context()));
    });
  }

  /**
   * One labelled control, shared by the field rows and by the rows of the two lists.
   *
   * One function and not two because the two used to be one and a half: an expression inside an
   * action was written by hand into the JSON pane, so it never got the live column, and a colour
   * had no control at all. Everything that reads or writes a value in this panel comes through
   * here, which is also why the live column can be a single decision rather than four.
   */
  #controlRow(
    spec: BuilderField,
    current: unknown,
    live: { readonly scope: Readonly<Record<string, unknown>>; readonly helpers: ExpressionHelpers },
    choices: readonly string[] | undefined,
    write: (value: unknown) => void,
    numbers = false,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "builder-field";
    const label = document.createElement("label");
    label.textContent = spec.label;
    row.append(label);

    if (spec.kind === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = current === true;
      input.addEventListener("change", () => { write(input.checked); });
      row.append(input);
      return row;
    }
    if (spec.kind === "color") {
      const input = document.createElement("input");
      input.type = "color";
      input.value = colorFieldText(current) || "#ffffff";
      input.addEventListener("change", () => { write(colorFieldValue(input.value, current)); });
      // Beside it, the way back to the client's own default: a colour control with no «take it off»
      // is a widget that can never again be the colour it was before somebody touched this row.
      const clear = button("×", () => { write(undefined); });
      clear.className = "builder-clear";
      row.append(input, clear);
      return row;
    }
    if (spec.kind === "choice") {
      const select = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "— по умолчанию —";
      const offered = choices ?? spec.choices ?? [];
      const held = typeof current === "string" ? current : "";
      // Whatever the file already holds is in the menu even when this client would not have offered
      // it: a `sendCustom` naming a schema that has not loaded yet, or a font from a newer studio,
      // would otherwise show as «— по умолчанию —» and be silently thrown away by the first
      // unrelated edit of the same row.
      const all = held && !offered.includes(held) ? [held, ...offered] : offered;
      select.append(blank, ...all.map((choice) => {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = choice;
        return option;
      }));
      select.value = held;
      select.addEventListener("change", () => { write(select.value === "" ? undefined : select.value); });
      row.append(select);
      // The one field the plan's own sentence names — «живым значением рядом с каждой привязкой» —
      // and the one that had no live column, because a named binding is resolved by the render pass
      // and not by `WindowExpression`. It is the same expression either way: `WINDOW_BINDINGS`
      // holds the source `WindowSchema` compiles the name into.
      if (spec.key === "bind") row.append(liveColumn(bindingLiveValue(select.value, live)));
      return row;
    }
    const input = document.createElement("input");
    input.type = spec.kind === "number" ? "number" : "text";
    input.value = fieldText(current);
    input.addEventListener("change", () => {
      if (spec.kind === "number") {
        const number = Number(input.value);
        write(input.value === "" || !Number.isFinite(number) ? undefined : number);
        return;
      }
      write(input.value === "" ? undefined : fieldWrite(input.value, current, numbers));
    });
    row.append(input);
    if (spec.kind === "expression") row.append(liveColumn(liveValue(fieldText(current), live)));
    return row;
  }

  /* -------------------------------------------------------------------------------------------
   * The preview, and dragging in it
   * ----------------------------------------------------------------------------------------- */

  #dropPreview(): void {
    if (!this.#preview) return;
    windowRegistry.remove(this.#preview.id);
    this.#preview = undefined;
  }

  /**
   * Draws the edited definition through the runtime renderer, in place.
   *
   * `openParsedWindow` replaces whatever held the id, and the element id is the same across a
   * rebuild — so `GameWindowManager` puts the redrawn window back exactly where it was dragged, and
   * a drag in the preview does not make the window jump to the middle of the screen on every pixel.
   *
   * **The preview never evicts somebody else's window.** «Replaces whatever held the id» is exactly
   * what `openParsedWindow` does, and `WindowRegistry.remove` *destroys* what it removes — so
   * editing a definition whose id a live module window holds would take that window off the screen
   * for good, and closing the editor afterwards would leave nothing behind. Two doors reached that:
   * the example button in the same pane registers `example-screen`, which is the file this editor
   * opens on, and the JSON pane will paste any id at all. So when the id is taken, the *preview* is
   * registered under a free name and the file keeps its own — the id in the JSON, and therefore in
   * the export, is untouched, and the status line says which name is on screen.
   */
  #drawPreview(): void {
    // Taken off first rather than replaced by id, because the JSON pane can change the window's own
    // id — and then `openParsedWindow` would register a second window and leave the first one on
    // the screen with nothing holding it.
    this.#dropPreview();
    const parsed = parseWindowDefinition(this.#definition, { module: this.#module });
    if (!parsed.window) {
      // Unreachable while every edit goes through the model's `commit`, and kept because the JSON
      // pane and a fetched file are two doors into this that the model has not been through yet.
      this.#say(`окно не рисуется: ${parsed.problems.join("; ")}`, true);
      return;
    }
    const held = windowRegistry.has(parsed.window.id);
    // A Latin suffix and not a Russian one: the id becomes an element id and goes into the
    // selectors `WindowActions.findWidget` builds, and `[A-Za-z0-9_-]` is the shape every other id
    // in this client keeps to.
    const previewId = held ? this.#freeWindowId(`${parsed.window.id}-preview`) : parsed.window.id;
    const shown = previewId === parsed.window.id ? parsed.window : { ...parsed.window, id: previewId };
    this.#preview = openParsedWindow(shown, { registry: windowRegistry, host: moduleWindowHost() });
    if (held) this.#addNote(`окно "${parsed.window.id}" уже открыто — предпросмотр показан как "${previewId}"`);
    const surface = this.#preview.element.querySelector<HTMLElement>(".wnd-root");
    if (surface) this.#armPreview(surface);
    this.#markSelection();
  }

  /**
   * Pointer handling on the preview: a press selects, a drag moves, a drag on the edge resizes.
   *
   * Clicks are swallowed on the way down while the editor is open, and that is deliberate: in
   * builder mode a button is a thing being positioned rather than a thing being pressed, and
   * dragging a «Купить» that sends a packet on every grab is not an editor.
   */
  #armPreview(surface: HTMLElement): void {
    surface.addEventListener("click", (event) => { event.stopPropagation(); event.preventDefault(); }, true);
    surface.addEventListener("pointerdown", (event) => { this.#beginDrag(surface, event); });
  }

  #beginDrag(surface: HTMLElement, event: PointerEvent): void {
    const node = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-widget]");
    // The surface itself carries the root's `data-widget`; grabbing empty space is not grabbing the
    // root, whose place belongs to the window header and to `GameWindowManager`.
    if (!node || node === surface) return;
    const id = node.dataset["widget"];
    if (!id) return;
    const box = widgetBox(this.#definition, id);
    if (!box) return;
    // `preventDefault` and *not* `stopPropagation`: the press still has to reach the panel, because
    // that is what raises a window to the top when it is clicked. What it must not do is start a
    // text selection across the whole preview.
    event.preventDefault();
    this.#select(id);

    const rect = node.getBoundingClientRect();
    // The last few pixels of an edge mean «растянуть» — but only on a widget with a middle left to
    // grab. On a 12-pixel icon every press is within six pixels of both edges, and a widget that can
    // only ever be resized is a widget that can never be moved.
    const grip = (near: number, size: number): boolean => near <= EDGE_GRIP && size > EDGE_GRIP * 2;
    const resizing = grip(rect.right - event.clientX, rect.width) || grip(rect.bottom - event.clientY, rect.height);
    const startX = event.clientX;
    const startY = event.clientY;
    // Read off the element rather than measured against the surface: a widget inside a `Frame` is
    // positioned against *that frame*, and `rect.left - surfaceRect.left` would teleport every
    // nested widget to the window's own corner the moment it was touched.
    const startLeft = Number.parseFloat(node.style.left) || 0;
    const startTop = Number.parseFloat(node.style.top) || 0;

    const onMove = (moving: PointerEvent): void => {
      const dx = moving.clientX - startX;
      const dy = moving.clientY - startY;
      // Written straight onto the element while the pointer is down: re-parsing the whole
      // definition sixty times a second to see a widget follow the mouse would be a parse per
      // pixel, and the edit that lands on release is the one that counts.
      if (resizing) {
        const size = draggedSize(box, dx, dy);
        node.style.width = `${Math.max(1, size.width)}px`;
        node.style.height = `${Math.max(1, size.height)}px`;
        return;
      }
      node.style.left = `${startLeft + dx}px`;
      node.style.top = `${startTop + dy}px`;
    };
    const onUp = (up: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const dx = up.clientX - startX;
      const dy = up.clientY - startY;
      if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) {
        // A press that did not travel is a selection, and the widget has already been selected.
        // Redrawn all the same, so the pixels the move handler wrote are taken back.
        this.#redraw();
        return;
      }
      if (resizing) {
        const size = draggedSize(box, dx, dy);
        this.#apply(resizeWidget(this.#definition, id, size.width, size.height, this.#context()));
        return;
      }
      // `draggedAnchor` and not two lines here: the flip between the screen's y and the file's is
      // the one piece of a drag that can be wrong without looking wrong, and it is asserted in a
      // test with no document in it.
      const where = draggedAnchor(box, dx, dy);
      this.#apply(moveWidget(this.#definition, id, where.x, where.y, this.#context()));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /** Puts the outline on the selected widget in the preview, and takes it off the rest. */
  #markSelection(): void {
    const root = this.#preview?.element;
    if (!root) return;
    for (const node of root.querySelectorAll<HTMLElement>("[data-widget]")) {
      node.classList.toggle("builder-selected", node.dataset["widget"] === this.#selected);
    }
  }

  /* -------------------------------------------------------------------------------------------
   * The menus
   * ----------------------------------------------------------------------------------------- */

  /**
   * Asks before a delete, and says how much goes with it.
   *
   * The one edit in here that cannot be undone by doing the opposite: adding, moving and renaming
   * are all reversible by hand, and deleting a `Frame` takes everything under it. The count is the
   * whole reason to ask — «Удалить card» and «Удалить card и 6 виджетов под ним» are different
   * questions, and the tree does not necessarily show the difference when the subtree is collapsed
   * off the bottom of the pane.
   */
  #confirmDelete(anchor: HTMLElement): void {
    const rows = builderTree(this.#definition);
    const row = rows.find((entry) => entry.id === this.#selected);
    if (!row) {
      this.#say("виджет не выбран", true);
      return;
    }
    // Everything deeper that is still under this one: the tree is a flat list in declaration order,
    // so the subtree is the run of rows after it that are deeper than it is.
    const start = rows.indexOf(row);
    let under = 0;
    while (start + under + 1 < rows.length && (rows[start + under + 1]?.depth ?? 0) > row.depth) under++;
    confirmPanel(anchor, {
      title: under > 0 ? `Удалить «${row.id}» и ${under} внутри?` : `Удалить «${row.id}»?`,
      lines: [`${row.type} · ${row.id}`],
      confirm: "Удалить",
      danger: true,
      onConfirm: () => { this.#apply(deleteWidget(this.#definition, row.id, this.#context())); },
    });
  }

  #addMenu(anchor: HTMLElement): void {
    const parent = this.#containerFor(this.#selected);
    showMenu(anchor, `Внутрь «${parent}»`, WIDGET_TYPES.map((type) => ({
      label: type,
      run: () => { this.#apply(addWidget(this.#definition, { parent, type: type as WidgetType }, this.#context())); },
    })));
  }

  /**
   * Where «добавить» puts a widget: the selection if it holds children, otherwise its parent.
   *
   * Adding into a `Text` is a refusal the model would make, and making the menu do the obvious
   * thing instead is what stops «Виджет +» from failing on the most ordinary selection there is.
   */
  #containerFor(id: string): string {
    const rows = builderTree(this.#definition);
    const row = rows.find((entry) => entry.id === id);
    if (!row) return rows[0]?.id ?? "";
    if (row.container) return row.id;
    return row.parent || rows[0]?.id || "";
  }

  #reparentMenu(anchor: HTMLElement, id: string): void {
    const targets = reparentTargets(this.#definition, id);
    showMenu(anchor, `Перенести «${id}»`, targets.map((row) => ({
      label: `${row.type} · ${row.id}`,
      run: () => { this.#apply(reparentWidget(this.#definition, id, row.id, this.#context())); },
    })));
  }

  #createMenu(anchor: HTMLElement): void {
    const windows = game.modules?.windows ?? [];
    const messages = this.#messages();
    showMenu(anchor, "Создать окно", [
      {
        label: "Пустая рамка",
        run: () => {
          const id = this.#freeWindowId("builder-window");
          this.#load(emptyWindowDefinition({ id, title: "Новое окно", updated: new Date().toISOString() }),
            BUILDER_MODULE, `${id}.json`, "Пустая рамка");
        },
      },
      {
        label: "Копия окна модуля",
        enabled: windows.length > 0,
        submenu: windows.map((entry) => ({
          label: `${entry.module}/${entry.windowId}`,
          run: () => { void this.#copyModuleWindow(entry.module, entry.file); },
        })),
      },
      {
        label: "Скелет из схемы сообщения",
        enabled: messages.length > 0,
        submenu: messages.map((message) => ({
          label: `${message.name} (${message.fields.length} полей)`,
          run: () => {
            const id = this.#freeWindowId("msg-window");
            this.#load(
              skeletonFromMessage(message, { id, updated: new Date().toISOString() }),
              BUILDER_MODULE, `${id}.json`, `Скелет по схеме «${message.name}»`,
            );
          },
        })),
      },
      { label: "Пример из examples/module-example", run: () => { this.#selected = ""; void this.#openExample(); } },
    ]);
  }

  /** An id no live window has taken, so the preview cannot evict somebody else's window. */
  #freeWindowId(stem: string): string {
    if (!windowRegistry.has(stem)) return stem;
    for (let suffix = 2; suffix < 100; suffix++) {
      if (!windowRegistry.has(`${stem}-${suffix}`)) return `${stem}-${suffix}`;
    }
    return stem;
  }

  /**
   * The message schemas the skeleton menu offers.
   *
   * The live registry when there is a world, and the example file beside the client when there is
   * not — because «сделай окно под моё сообщение» is the one path in here that would otherwise be
   * unreachable without logging in, and it is the path the whole feature exists for.
   */
  #messages(): readonly CustomMessage[] {
    const live = game.world?.customPackets.messages() ?? [];
    if (live.length > 0) return live;
    if (this.#exampleMessages.length === 0) void this.#loadExampleMessages();
    return this.#exampleMessages;
  }

  async #loadExampleMessages(): Promise<void> {
    try {
      const response = await fetch(EXAMPLE_MESSAGES_URL);
      if (!response.ok) return;
      this.#exampleMessages = parseCustomMessages(await response.json()).messages;
    } catch {
      // No dev server, or the file has moved. The menu row is simply greyed out.
    }
  }

  async #copyModuleWindow(module: string, file: string): Promise<void> {
    const origin = game.gatewayOrigin ?? "";
    try {
      const response = await fetch(`${origin}/modules/ui/${module}/${file}`);
      if (!response.ok) throw new Error(`шлюз ответил ${response.status}`);
      const raw = await response.json() as JsonRecord;
      const id = this.#freeWindowId(`${typeof raw["id"] === "string" ? raw["id"] : "window"}-copy`);
      this.#load(copyWindowDefinition(raw, { id, updated: new Date().toISOString() }),
        module, `${id}.json`, `Копия ${module}/${file}`);
    } catch (error) {
      this.#say(`копия не получилась: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  /* -------------------------------------------------------------------------------------------
   * Export
   * ----------------------------------------------------------------------------------------- */

  async #export(): Promise<void> {
    const outcome = await exportWindowDefinition(
      this.#definition,
      { module: this.#module, file: this.#file, baseUrl: game.gatewayOrigin ?? "" },
      { copy: copyToClipboard, fetch: (url, init) => fetch(url, init) },
    );
    this.#say(outcome.message, outcome.kind === "error");
  }
}

/**
 * The clipboard, with the fallback that makes it work at all.
 *
 * `navigator.clipboard` needs a secure context, and the dev server is plain `http://localhost:5173`
 * — which *is* treated as secure by every browser, but a client opened by IP address on the same
 * network is not. The textarea road is what the interface used before the API existed and it needs
 * no permission at all, so the export never fails for a reason the author cannot act on.
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Falls through to the textarea below.
  }
  const box = document.createElement("textarea");
  box.value = text;
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.append(box);
  box.select();
  const copied = document.execCommand("copy");
  box.remove();
  if (!copied) throw new Error("браузер отказал в копировании");
}

/** What an expression field evaluates to right now, for the column beside it. */
function liveValue(
  source: string,
  live: { readonly scope: Readonly<Record<string, unknown>>; readonly helpers: ExpressionHelpers },
): string {
  if (!source) return "";
  const parsed = parseTemplate(source);
  if (!parsed.ast) return `✗ ${parsed.problems.join("; ")}`;
  return `= ${formatExpressionValue(evaluate(parsed.ast, live.scope, live.helpers))}`;
}

/**
 * And what a *named* binding shows right now, which is a second lookup and not a second answer.
 *
 * `WindowSchema` compiles `bind: "playerHealth"` into `WINDOW_BINDINGS`'s own expression source and
 * evaluates that; this reads the same row of the same table, so the column beside the menu and the
 * widget two inches away are looking at one expression. `none` and an unset field have no source
 * and read blank, which is the truth: they take their value from the widget's own fields.
 */
function bindingLiveValue(
  name: string,
  live: { readonly scope: Readonly<Record<string, unknown>>; readonly helpers: ExpressionHelpers },
): string {
  const spec = WINDOW_BINDINGS.find((binding) => binding.name === name);
  const source = spec ? (spec.caption || spec.value) : "";
  if (!source) return "";
  const parsed = parseExpression(source);
  // Unreachable in a green build — `WindowSchema`'s own test walks every row of that table — and
  // the blank is what a column of a *convenience* costs when it is wrong, rather than a throw.
  if (!parsed.ast) return "";
  return `= ${formatExpressionValue(evaluate(parsed.ast, live.scope, live.helpers))}`;
}

let builder: WindowBuilder | undefined;

/** Opens the editor, or closes it. The panel is built on the first press and kept after that. */
export function toggleWindowBuilder(): void {
  builder ??= new WindowBuilder();
  builder.toggle();
}

/**
 * Offers the editor's key, unbound, in the same table a module's own key goes into.
 *
 * The module name is Russian on purpose: `validModuleName` is `[A-Za-z0-9_-]`, so no directory on
 * disk can ever be called «клиент», and `removeModuleActions` — which the loader calls with a
 * module's own name when it unloads — can therefore never take this row away with it.
 */
export function registerWindowBuilderAction(): void {
  addModuleAction({
    action: "toggleWindowBuilder",
    module: "клиент",
    group: "Разработка",
    label: "Редактор окон модулей",
    run: () => { toggleWindowBuilder(); },
  });
}
