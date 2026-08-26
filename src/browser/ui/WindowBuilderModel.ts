/**
 * The window builder's edits, as pure functions over the JSON a module actually ships.
 *
 * The overlay in `WindowBuilder.ts` is a view onto this file and holds no state of its own beyond
 * which widget is selected. Everything that changes a window — add, duplicate, delete, reparent,
 * move, resize, rename, set a field — is a function from one definition to another here, so the
 * whole of the editor's behaviour can be exercised with no document, and the overlay is left with
 * the part that genuinely needs one.
 *
 * Three rules run through all of it.
 *
 * * **The model is never left unparseable.** Every edit is handed to `parseWindowDefinition`
 *   before it is accepted, and an edit whose result has no window — or that would make the parser
 *   *drop the very widget being edited* — is refused, with the parser's own sentence as the reason.
 *   The alternative is an editor that lets an author type `{player.helth` into a field and then
 *   shows them an empty window with the reason buried in a pane they are not looking at. A refusal
 *   hands the previous definition straight back, so a refused edit costs a keystroke and not a
 *   window.
 * * **A reference is repaired, never left dangling.** An anchor may name its parent or an *earlier
 *   sibling* and nothing else — `WindowSchema` refuses the file otherwise — so deleting a widget
 *   something is anchored to, or moving one under a different parent, has to put those anchors back
 *   on the parent, and renaming one has to rewrite every mention of the old name. Without that,
 *   ordinary editing produces a file the parser refuses whole, and the editor would be the thing
 *   that wrote it.
 * * **The JSON is the truth, not a projection of it.** The editor reads and writes the module's own
 *   `content/ui/*.json` — the same bytes the studio writes and the loader fetches — rather than an
 *   internal model that is serialised on the way out. So a field this client has not been taught
 *   survives an edit untouched, and a file that came from the studio goes back to the studio.
 */

import type { CustomField, CustomMessage } from "../../world/CustomCodec.js";
import {
  ANCHOR_POINTS, BACKDROP_PRESETS, BUTTON_TEMPLATES, CONDITION_EFFECTS, CONDITION_NAMES, LAYERS,
  MODEL_UNITS, STRATAS, WIDGET_TYPES, WINDOW_BINDINGS, WINDOW_COMMANDS, WINDOW_CONDITIONS,
  WINDOW_FONT_NAMES, WINDOW_MAX_WIDGETS,
  parseWindowDefinition, walkWindowWidgets,
  type WidgetType,
} from "./WindowSchema.js";

/** A JSON object, which is what a definition and every widget in one is. */
export type JsonRecord = Record<string, unknown>;

/** Which of the twelve types may hold children. The same pair `WindowSchema` allows. */
export const BUILDER_CONTAINER_TYPES: ReadonlySet<string> = new Set(["Frame", "ScrollFrame"]);

/**
 * The smallest a widget may be dragged to.
 *
 * Zero is a widget nobody can grab again: it has no edge to catch and no body to click, and the
 * only way back would be the JSON pane. One pixel is visible and is still a mistake somebody can
 * undo with the mouse.
 */
export const MIN_WIDGET_SIZE = 1;

/** The shape a widget id may have: it becomes a `data-widget` attribute and a CSS selector. */
const WIDGET_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The one name no widget may take, because an anchor already means something by it.
 *
 * `parseAnchor` reads `relativeTo: "parent"` as the enclosing frame, so a widget called `parent` is
 * a widget nothing can ever anchor to — and, worse, renaming `a` to `parent` would rewrite every
 * `relativeTo: "a"` into `relativeTo: "parent"`, which still parses and quietly re-aims those
 * widgets at the frame instead of at each other. That is the one case where «ссылка чинится, а не
 * повисает» would have failed silently: the reference is not left dangling, it is re-pointed.
 */
const RESERVED_WIDGET_ID = "parent";

/**
 * How many rows {@link skeletonFromMessage} will lay out before it stops and says how many it left.
 *
 * Thirty-two rows is 616 px of window, which is already taller than a 720-line screen has room for
 * beside the editor's own panel. The cut is said out loud in a last row rather than made silently:
 * a skeleton that quietly stopped at the thirty-second field of a forty-field message is a window
 * whose author would go looking for the missing eight in the schema.
 */
export const SKELETON_MAX_ROWS = 32;

export interface BuilderContext {
  /** Whose module the file belongs to. It goes in front of every problem the parser reports. */
  readonly module: string;
}

/**
 * What one edit did.
 *
 * `changed: false` means the edit was refused and {@link BuilderResult.definition} is the one that
 * went in — the caller can write it back unconditionally. `problems` is the reason on a refusal and
 * the parser's own notes on a success, which is what the overlay's problem line shows either way.
 */
export interface BuilderResult {
  readonly definition: JsonRecord;
  readonly problems: readonly string[];
  readonly changed: boolean;
  /** Which widget the tree should be showing after this edit. */
  readonly selected: string;
}

/* ---------------------------------------------------------------------------------------------
 * Reading the raw tree
 * ------------------------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A deep copy, through JSON rather than `structuredClone`.
 *
 * The thing being copied is a definition that arrived as JSON and will leave as JSON, so a round
 * trip is exact — and it drops anything that could not have come out of a file (a function, a
 * `Date`, an `undefined` in an object) rather than carrying it into the copy.
 */
export function cloneDefinition(definition: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(definition)) as JsonRecord;
}

/** The window's root frame, as raw JSON. */
export function screenOf(definition: JsonRecord): JsonRecord | undefined {
  const params = definition["params"];
  if (!isRecord(params)) return undefined;
  const screen = params["screen"];
  return isRecord(screen) ? screen : undefined;
}

/** A widget's declared children, as objects: whatever in the array is not one is not a widget. */
function childArray(widget: JsonRecord): JsonRecord[] {
  const raw = widget["children"];
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

/** The live array the file holds, so a push or a splice actually lands in the definition. */
function liveChildren(widget: JsonRecord, create: boolean): unknown[] | undefined {
  const raw = widget["children"];
  if (Array.isArray(raw)) return raw;
  if (!create) return undefined;
  const made: unknown[] = [];
  widget["children"] = made;
  return made;
}

export const widgetId = (widget: JsonRecord): string =>
  typeof widget["id"] === "string" ? widget["id"] : "";

export const widgetType = (widget: JsonRecord): string =>
  typeof widget["type"] === "string" ? widget["type"] : "";

/** One widget and everything under it, in declaration order. */
export function walkRawWidgets(widget: JsonRecord): JsonRecord[] {
  const list: JsonRecord[] = [widget];
  for (const child of childArray(widget)) list.push(...walkRawWidgets(child));
  return list;
}

/** Where a widget sits: the record itself, its parent and its place among its siblings. */
interface WidgetSite {
  readonly widget: JsonRecord;
  /** Absent for the root frame, which has no parent and cannot be moved or deleted. */
  readonly parent: JsonRecord | undefined;
  readonly index: number;
}

function findSite(definition: JsonRecord, id: string): WidgetSite | undefined {
  const screen = screenOf(definition);
  if (!screen) return undefined;
  if (widgetId(screen) === id) return { widget: screen, parent: undefined, index: -1 };
  // Walked over the *live* array rather than over the filtered one, so that `index` is the index a
  // `splice` will act on. A `children` array with a stray `null` in it is a file nobody wrote by
  // hand, and it is exactly the case where a filtered index would delete the wrong widget.
  const look = (parent: JsonRecord): WidgetSite | undefined => {
    const children = liveChildren(parent, false) ?? [];
    for (const [index, child] of children.entries()) {
      if (!isRecord(child)) continue;
      if (widgetId(child) === id) return { widget: child, parent, index };
      const deeper = look(child);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return look(screen);
}

/** Whether `id` is `ancestor` or sits under it — the check that stops a drag into its own subtree. */
function within(definition: JsonRecord, ancestor: string, id: string): boolean {
  const site = findSite(definition, ancestor);
  if (!site) return false;
  return walkRawWidgets(site.widget).some((widget) => widgetId(widget) === id);
}

/** Every id the definition currently declares, root included. */
export function definitionIds(definition: JsonRecord): Set<string> {
  const screen = screenOf(definition);
  const ids = new Set<string>();
  if (!screen) return ids;
  for (const widget of walkRawWidgets(screen)) {
    const id = widgetId(widget);
    if (id) ids.add(id);
  }
  return ids;
}

/** `bar`, `bar-2`, `bar-3`: the first spelling of a name nothing in the window has taken. */
export function uniqueWidgetId(taken: ReadonlySet<string>, base: string): string {
  const stem = base.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "widget";
  // `parent` is taken by the anchor grammar rather than by a widget, so it never appears in `taken`
  // and has to be refused here as well as in `renameWidget`.
  if (stem === RESERVED_WIDGET_ID) return uniqueWidgetId(taken, `${stem}-widget`);
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${taken.size + 1}`;
}

/* ---------------------------------------------------------------------------------------------
 * The tree the overlay lists
 * ------------------------------------------------------------------------------------------- */

export interface BuilderTreeRow {
  readonly id: string;
  readonly type: string;
  readonly depth: number;
  /** Whether a new widget may be added inside this one. */
  readonly container: boolean;
  /** The parent's id; empty for the root. */
  readonly parent: string;
}

/** The widget hierarchy as a flat list, root first, in declaration order. */
export function builderTree(definition: JsonRecord): BuilderTreeRow[] {
  const screen = screenOf(definition);
  if (!screen) return [];
  const rows: BuilderTreeRow[] = [];
  const walk = (widget: JsonRecord, depth: number, parent: string): void => {
    const type = widgetType(widget);
    rows.push({ id: widgetId(widget), type, depth, container: BUILDER_CONTAINER_TYPES.has(type), parent });
    for (const child of childArray(widget)) walk(child, depth + 1, widgetId(widget));
  };
  walk(screen, 0, "");
  return rows;
}

/**
 * The containers one widget may actually be moved into — exactly the set {@link reparentWidget}
 * accepts, and no larger.
 *
 * Written here rather than filtered in the overlay because the two lists drifted apart the first
 * time: the menu offered «every container that is not this widget», which on the two commonest
 * window shapes there are — a root with a row of leaves, and a root with two frames in it — is a
 * list of nothing but refusals. Measured on `examples/module-example/ui/example.json`, the file the
 * editor opens on: every one of its seven leaves was offered one target, `root`, and `root` is the
 * parent they already sit in, so the menu answered «"say" уже лежит в "root"» seven times out of
 * seven. Three rules, all of them the model's own: not itself, not the parent it is already in,
 * and nothing inside its own subtree.
 */
export function reparentTargets(definition: JsonRecord, id: string): BuilderTreeRow[] {
  const rows = builderTree(definition);
  return targetsIn(rows, rows.findIndex((row) => row.id === id));
}

/**
 * The same three rules against a tree that has already been walked.
 *
 * `at` is the row's own index and the subtree is the run of rows after it that are deeper, because
 * `builderTree` is a flat list in declaration order — the same reading `#confirmDelete` counts a
 * subtree by. Split out so that drawing a window of two hundred widgets does not walk the whole
 * definition two hundred times over just to decide which rows get a «в…» button: measured on this
 * machine at **1,87 мс** per tree redraw that way, against **0,23** for one walk (and 0,004 мс on
 * the eight-widget example either way).
 */
function targetsIn(rows: readonly BuilderTreeRow[], at: number): BuilderTreeRow[] {
  const row = rows[at];
  // Index 0 is the root frame, which is nobody's child and goes nowhere.
  if (at <= 0 || !row) return [];
  let end = at + 1;
  while (end < rows.length && (rows[end]?.depth ?? 0) > row.depth) end++;
  const inside = new Set(rows.slice(at, end).map((entry) => entry.id));
  return rows.filter((entry) => entry.container && entry.id !== row.parent && !inside.has(entry.id));
}

/**
 * Which widgets have anywhere at all to be moved to — one answer for the whole tree.
 *
 * What the tree pane hangs the «в…» button on. A button opening a menu of nothing reads as broken,
 * and in a flat window — a root with a row of labels in it, the commonest shape there is — that was
 * every row on the pane.
 */
export function movableWidgets(definition: JsonRecord): Set<string> {
  const rows = builderTree(definition);
  const movable = new Set<string>();
  for (const [at, row] of rows.entries()) {
    if (targetsIn(rows, at).length > 0) movable.add(row.id);
  }
  return movable;
}

/** The definition as the file would hold it: two-space JSON, which is what the studio writes. */
export function definitionText(definition: JsonRecord): string {
  return `${JSON.stringify(definition, undefined, 2)}\n`;
}

/* ---------------------------------------------------------------------------------------------
 * Committing an edit
 * ------------------------------------------------------------------------------------------- */

/**
 * Hands an edited definition to the parser and accepts it only if it is still a whole window.
 *
 * `expect` names the widgets that have to still be there afterwards, which is the half a plain
 * "did it parse" check misses: `WindowSchema`'s middle level *drops* a widget whose expression will
 * not read and loads the window without it, so typing a half-written `{player.` into a label would
 * otherwise be accepted, and the label would simply vanish with the reason in another pane.
 */
function commit(
  before: JsonRecord,
  next: JsonRecord,
  context: BuilderContext,
  options: { readonly expect: readonly string[]; readonly selected: string; readonly what: string },
): BuilderResult {
  const parsed = parseWindowDefinition(next, { module: context.module });
  if (!parsed.window) {
    return {
      definition: before,
      problems: [`${options.what} отменено: ${parsed.problems.join("; ") || "определение перестало быть окном"}`],
      changed: false,
      selected: options.selected,
    };
  }
  const alive = new Set(walkWindowWidgets(parsed.window.screen).map((widget) => widget.id));
  const lost = options.expect.filter((id) => !alive.has(id));
  if (lost.length > 0) {
    return {
      definition: before,
      problems: [
        `${options.what} отменено: виджет ${lost.map((id) => `"${id}"`).join(", ")} после правки не рисуется`
        + `${parsed.problems.length ? ` — ${parsed.problems.join("; ")}` : ""}`,
      ],
      changed: false,
      selected: options.selected,
    };
  }
  return { definition: next, problems: parsed.problems, changed: true, selected: options.selected };
}

/** A refusal that never reached the parser: the edit is impossible on its own terms. */
function refuse(definition: JsonRecord, selected: string, text: string): BuilderResult {
  return { definition, problems: [text], changed: false, selected };
}

/* ---------------------------------------------------------------------------------------------
 * References: anchors and the actions that name a widget
 * ------------------------------------------------------------------------------------------- */

/**
 * Rewrites every mention of a widget id, wherever in the file it is written.
 *
 * Four spellings, and all four are references to a widget by name: an anchor's `relativeTo`, the
 * `widget` of a `show`/`hide`/`toggleWidget` action, the studio's own `target` on its «показать/
 * скрыть» button action, and the studio's `valueFrom` on «отправить пакет», which names the input
 * whose value goes into the packet. Missing any one of them turns a rename into a button that
 * quietly stops working, which is exactly the failure the load-time checks exist to prevent.
 */
function renameReferences(node: unknown, map: ReadonlyMap<string, string>): void {
  if (Array.isArray(node)) {
    for (const entry of node) renameReferences(entry, map);
    return;
  }
  if (!isRecord(node)) return;
  const swap = (key: string): void => {
    const value = node[key];
    if (typeof value !== "string") return;
    const renamed = map.get(value);
    if (renamed !== undefined) node[key] = renamed;
  };
  swap("relativeTo");
  const verb = node["do"];
  if (verb === "show" || verb === "hide" || verb === "toggleWidget") swap("widget");
  if (node["type"] === "toggleWidget") swap("target");
  if (node["type"] === "sendPacket") swap("valueFrom");
  for (const value of Object.values(node)) renameReferences(value, map);
}

/**
 * Puts every anchor back on something it may legally name, and says which ones moved.
 *
 * The rule is `WindowSchema`'s: `parent`, or an id declared *earlier among the same children*.
 * Deleting a widget and moving one under a different parent both break that for somebody, and the
 * parser's answer to a broken anchor is to refuse the whole file — so the repair has to happen in
 * the same edit rather than being reported afterwards.
 */
function repairAnchors(widget: JsonRecord, moved: string[]): void {
  const children = childArray(widget);
  const earlier: string[] = [];
  for (const child of children) {
    const anchor = child["anchor"];
    if (isRecord(anchor)) {
      const to = anchor["relativeTo"];
      if (typeof to === "string" && to !== "" && to !== "parent" && !earlier.includes(to)) {
        anchor["relativeTo"] = "parent";
        moved.push(widgetId(child));
      }
    }
    earlier.push(widgetId(child));
    repairAnchors(child, moved);
  }
}

/** The `anchor` object of one widget, made if the file has none. */
function anchorOf(widget: JsonRecord): JsonRecord {
  const raw = widget["anchor"];
  if (isRecord(raw)) return raw;
  const made: JsonRecord = { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: 0 };
  widget["anchor"] = made;
  return made;
}

/** Where a widget currently sits and how big it is — what a drag starts from. */
export interface WidgetBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a widget lands after the pointer has travelled `dx`, `dy` **screen** pixels.
 *
 * The whole of the difference between the two coordinate systems, and the mirror of the single
 * `- y` in `WindowRender.anchorBox`: the screen's y grows downward and the file's grows upward, so
 * dragging *down* makes `y` smaller. It is a function rather than two lines inside the pointer
 * handler because it is the one piece of the drag that can be wrong without looking wrong — a
 * widget that follows the mouse while the button is held and then jumps to the mirror position on
 * release is exactly what the missing minus looks like.
 */
export function draggedAnchor(box: WidgetBox, dx: number, dy: number): { readonly x: number; readonly y: number } {
  return { x: box.x + dx, y: box.y - dy };
}

/** And how big it becomes when its bottom-right corner is dragged by the same two numbers. */
export function draggedSize(box: WidgetBox, dx: number, dy: number): { readonly width: number; readonly height: number } {
  return { width: box.width + dx, height: box.height + dy };
}

export function widgetBox(definition: JsonRecord, id: string): WidgetBox | undefined {
  const site = findSite(definition, id);
  if (!site) return undefined;
  const anchor = site.widget["anchor"];
  const number = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    x: isRecord(anchor) ? number(anchor["x"], 0) : 0,
    y: isRecord(anchor) ? number(anchor["y"], 0) : 0,
    width: number(site.widget["width"], 100),
    height: number(site.widget["height"], 20),
  };
}

/* ---------------------------------------------------------------------------------------------
 * The twelve types, with the fields the inspector offers for each
 * ------------------------------------------------------------------------------------------- */

export type BuilderFieldKind = "text" | "number" | "boolean" | "choice" | "expression" | "color";

export interface BuilderField {
  /** The key in the widget's JSON. `anchor.point` reaches one level in. */
  readonly key: string;
  readonly label: string;
  readonly kind: BuilderFieldKind;
  /** For `choice`, the whole of what may be written there. Taken from `WindowSchema`'s tables. */
  readonly choices?: readonly string[] | undefined;
}

const field = (key: string, label: string, kind: BuilderFieldKind, choices?: readonly string[]): BuilderField =>
  choices === undefined ? { key, label, kind } : { key, label, kind, choices };

/**
 * A colour as `#rrggbb`, out of the four `0..1` channels a definition writes.
 *
 * `WidgetReader.rgba` reads an array of three or four numbers and nothing else, so a colour cannot
 * be a text field spelled the way CSS spells one — and it is worth having as a field at all because
 * «полоса не того цвета рядом с настоящей полосой здоровья» is the first case this whole editor
 * exists for, written at the top of `WindowBuilder.ts`. The fourth channel never appears in the
 * input: alpha has a field of its own on every widget, and a hex form that silently threw the
 * file's own transparency away on the first edit would be worse than no control.
 */
export function colorFieldText(value: unknown): string {
  if (!Array.isArray(value) || value.length < 3) return "";
  const channel = (index: number): string => {
    const raw = value[index];
    const number = typeof raw === "number" && Number.isFinite(raw) ? raw : 1;
    return Math.round(Math.min(1, Math.max(0, number)) * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** And back, keeping whatever fourth channel the file already carried. */
export function colorFieldValue(text: string, existing: unknown): unknown {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(text.trim());
  if (!match) return undefined;
  const hex = match[1] ?? "";
  const channel = (at: number): number => Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  const alpha = Array.isArray(existing) && typeof existing[3] === "number" && Number.isFinite(existing[3])
    ? existing[3]
    : 1;
  return [channel(0), channel(2), channel(4), alpha];
}

/**
 * What one typed line becomes in the file: a localised pair, a number, or a string.
 *
 * Three answers because the file has three shapes behind what looks like one control, and getting
 * it wrong is invisible until the packet lands. A field the studio wrote as `{ru, en}` keeps that
 * shape and only its Russian half is rewritten, so English somebody typed in the studio survives a
 * drag in the game. `numbers` is on for the rows of an *action*, where `WidgetReader.raw` reads a
 * bare `5` as the number five and `"5"` as the **string** «5» — which a `u32` field of a message
 * then encodes as nothing at all. It is off for a widget's own fields, because `localised` is the
 * mirror of that: an `EditBox` whose `text` was written as a number reads as empty.
 */
export function fieldWrite(text: string, existing: unknown, numbers: boolean): unknown {
  if (isRecord(existing) && typeof existing["ru"] === "string") return { ...existing, ru: text };
  if (numbers && text.trim() !== "") {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

/** Every widget has these: the box, where it hangs and whether it is drawn at all. */
export const COMMON_FIELDS: readonly BuilderField[] = [
  field("name", "Подпись (для студии)", "text"),
  field("width", "Ширина", "number"),
  field("height", "Высота", "number"),
  field("anchor.point", "Точка виджета", "choice", ANCHOR_POINTS),
  field("anchor.relativePoint", "Точка цели", "choice", ANCHOR_POINTS),
  field("anchor.x", "Смещение X", "number"),
  field("anchor.y", "Смещение Y (вверх)", "number"),
  // Free text and not a menu, because the set of legal answers is «parent» plus the ids declared
  // *before* this one among the same children, which is a different list for every widget. A wrong
  // answer is caught the same way every other one is: the parser refuses the file, `commit` refuses
  // the edit, and the field goes back to what it held.
  field("anchor.relativeTo", "Якорь к (parent или старший брат)", "text"),
  field("hidden", "Скрыт", "boolean"),
  field("alpha", "Прозрачность", "number"),
  field("className", "Класс CSS", "text"),
  field("slot", "Слот встроенного окна", "text"),
];

/** And the root frame carries the window's own: the strata, the title, the close button. */
export const SCREEN_FIELDS: readonly BuilderField[] = [
  field("title", "Заголовок", "expression"),
  field("strata", "Страта", "choice", STRATAS),
  field("closeButton", "Кнопка закрытия", "boolean"),
  field("escClose", "Закрывать по Escape", "boolean"),
  field("titleTexture", "Текстура заголовка", "boolean"),
  field("movable", "Перетаскивается", "boolean"),
];

const BACKDROP_NAMES = BACKDROP_PRESETS.map((preset) => preset.name);
/**
 * The named bindings, split the way the studio splits them.
 *
 * Six of the twelve have no number behind them — a name, a level, a zone, a clock — and
 * `WindowSchema` refuses one of those on a `StatusBar` by name. Offering all twelve on both would
 * make the inspector a menu of which every second row is a refusal.
 */
const BAR_BINDINGS = WINDOW_BINDINGS.filter((binding) => binding.forBar).map((binding) => binding.name);
const TEXT_BINDINGS = WINDOW_BINDINGS.filter((binding) => binding.forText).map((binding) => binding.name);

/**
 * The per-type fields, one row per thing `WindowSchema.buildWidget` actually reads — except for the
 * handful written down in {@link WIDGET_FIELDS_OMITTED}, each with its reason.
 *
 * The vocabularies are the schema's own arrays rather than copies of them, so the day the studio
 * grows a nineteenth font object the inspector offers it without a second edit. Two tests walk this
 * table in the two directions, and it needed both: the first asserts every key offered here
 * *changes the parsed window*, so a control that moves nothing is caught rather than found by an
 * author; the second asserts every key the parser *reads* is either offered here or on the omitted
 * list — which is what caught this table claiming to be complete while it silently had no row for
 * `actions`, `conditions` or a colour.
 */
export const WIDGET_FIELDS: Readonly<Record<WidgetType, readonly BuilderField[]>> = {
  Frame: [
    field("backdrop", "Фон", "choice", BACKDROP_NAMES),
    field("backdropColor", "Цвет фона", "color"),
    field("borderColor", "Цвет рамки", "color"),
    field("mouse", "Ловит мышь", "boolean"),
    field("movable", "Перетаскивается", "boolean"),
  ],
  Texture: [
    field("texture", "Путь текстуры", "expression"),
    field("color", "Цвет", "color"),
    field("layer", "Слой", "choice", LAYERS),
    field("solid", "Залить цветом", "boolean"),
  ],
  Text: [
    field("text", "Текст", "expression"),
    field("bind", "Привязка", "choice", TEXT_BINDINGS),
    field("color", "Цвет", "color"),
    field("font", "Шрифт", "choice", WINDOW_FONT_NAMES),
    field("size", "Кегль (0 — из шрифта)", "number"),
    field("justifyH", "По горизонтали", "choice", ["LEFT", "CENTER", "RIGHT"]),
    field("justifyV", "По вертикали", "choice", ["TOP", "MIDDLE", "BOTTOM"]),
    field("wrap", "Переносить строки", "boolean"),
    field("shadow", "Тень", "boolean"),
    field("outline", "Обводка", "choice", ["OUTLINE", "THICKOUTLINE"]),
  ],
  Button: [
    field("text", "Надпись", "expression"),
    field("tooltip", "Подсказка", "expression"),
    field("enabled", "Доступна", "expression"),
    field("template", "Шаблон", "choice", BUTTON_TEMPLATES),
    field("textures.normal", "Своя картинка", "text"),
    field("textures.pushed", "…нажатая", "text"),
    field("textures.highlight", "…под курсором", "text"),
    field("textures.disabled", "…недоступная", "text"),
  ],
  CheckButton: [
    field("text", "Надпись", "expression"),
    field("checked", "Отмечен", "expression"),
    field("state", "Ключ состояния", "text"),
    field("font", "Шрифт", "choice", WINDOW_FONT_NAMES),
  ],
  EditBox: [
    field("text", "Начальный текст", "expression"),
    field("numeric", "Только числа", "boolean"),
    field("multiline", "Много строк", "boolean"),
    field("autoFocus", "Курсор при открытии", "boolean"),
    field("maxLetters", "Предел символов", "number"),
    field("state", "Ключ состояния", "text"),
    field("font", "Шрифт", "choice", WINDOW_FONT_NAMES),
    field("template", "Шаблон", "text"),
  ],
  StatusBar: [
    field("bind", "Привязка", "choice", BAR_BINDINGS),
    field("value", "Значение", "expression"),
    field("max", "Максимум", "expression"),
    field("min", "Минимум", "expression"),
    field("showText", "Писать число", "boolean"),
    field("texture", "Текстура полосы", "text"),
    field("color", "Цвет полосы", "color"),
    field("background", "Цвет подложки", "color"),
    field("font", "Шрифт", "choice", WINDOW_FONT_NAMES),
  ],
  Slider: [
    field("label", "Подпись", "expression"),
    field("min", "Минимум", "number"),
    field("max", "Максимум", "number"),
    field("step", "Шаг", "number"),
    field("value", "Значение", "expression"),
    field("showValue", "Показывать число", "boolean"),
    field("state", "Ключ состояния", "text"),
  ],
  ScrollFrame: [
    field("contentHeight", "Высота содержимого", "number"),
  ],
  ItemButton: [
    field("icon", "Иконка", "expression"),
    field("itemId", "Предмет", "expression"),
    field("spellId", "Заклинание", "expression"),
    field("count", "Количество", "expression"),
    field("tooltip", "Подсказка предмета", "boolean"),
  ],
  DropDown: [
    field("label", "Подпись", "expression"),
    field("options", "Варианты", "expression"),
    field("selected", "Выбран", "expression"),
    field("state", "Ключ состояния", "text"),
  ],
  Model: [
    field("unit", "Юнит", "choice", MODEL_UNITS),
    field("creature", "Существо", "expression"),
    field("rotation", "Поворот", "number"),
  ],
};

/** What the inspector shows for one widget: its type's own fields, then the common ones. */
export function fieldsFor(type: string, isRoot: boolean): readonly BuilderField[] {
  const own = (WIDGET_FIELDS as Readonly<Record<string, readonly BuilderField[]>>)[type] ?? [];
  return isRoot ? [...own, ...SCREEN_FIELDS, ...COMMON_FIELDS] : [...own, ...COMMON_FIELDS];
}

/**
 * The keys `buildWidget` reads that the field rows deliberately do not offer, each with its reason.
 *
 * Written down rather than left to be noticed, because «инспектор полей из той же таблицы» is a
 * claim about completeness and an unrecorded gap is the same thing as a wrong claim. The test walks
 * every key the parser reads for every type — by handing the parse a `Proxy` that records what it
 * asked for — and requires each one to be either in the table above or in this list.
 */
export const WIDGET_FIELDS_OMITTED: Readonly<Record<string, string>> = {
  id: "имя виджета — «Переименовать», потому что оно правит и все ссылки на него",
  type: "тип задаётся при добавлении: сменить его — это удалить и добавить заново",
  children: "дерево, а не поле",
  conditions: "свой редактор ниже: когда показывать, прятать, красить",
  actions: "свой редактор ниже: что делает нажатие",
  action: "студийная запись одного действия; редактор пишет список, разборщик читает оба",
  onChange: "тот же редактор действий — им отвечают ползунок, флажок и список",
  onEnter: "тот же редактор действий — им отвечает поле ввода на Enter",
  repeat: "повторитель списка: «over», «as» и «limit» — форма, а не поле",
  inherits: "шаблон FrameXML, которого в этом клиенте нет: разборщик отказывает вслух",
  texCoords: "обрезка текстуры четырьмя числами — её место в студии, где видно саму картинку",
};

/* ---------------------------------------------------------------------------------------------
 * The two lists a widget carries: what it does, and when it is shown
 * ------------------------------------------------------------------------------------------- */

/**
 * Which JSON key holds each type's action list. Six types have one; the other six have none.
 *
 * The key is not the same for all six because `buildWidget` reads a different one for each kind of
 * thing that happens: a `Button` is pressed (`actions`, and the studio's own single `action` beside
 * it), a `Slider`, a `CheckButton`'s box and a `DropDown` are *changed*, an `EditBox` is submitted.
 * Written down once here so the editor writes into the key the parser will read rather than into
 * the one that reads best — an `actions` list on a `DropDown` is a list nothing ever runs.
 */
export const ACTION_LIST_KEY: Readonly<Record<string, string>> = {
  Button: "actions",
  CheckButton: "actions",
  ItemButton: "actions",
  EditBox: "onEnter",
  Slider: "onChange",
  DropDown: "onChange",
};

/** The key a type's actions go under, or empty for the six types that run nothing. */
export function actionListKey(type: string): string {
  return ACTION_LIST_KEY[type] ?? "";
}

/** Every key this file will edit a list under. Nothing else may be written through these. */
const LIST_KEYS: ReadonlySet<string> = new Set([...Object.values(ACTION_LIST_KEY), "conditions"]);

/**
 * What a new action starts as, so that «добавить» puts something on screen that already works.
 *
 * All four are names the *editor* can see and the model cannot: which window is being edited, which
 * widget is beside this one, which message schemas the client has loaded and which sound kits it
 * ships. A default of `""` for any of them is an action `checkWindowActions` immediately complains
 * about, which reads as the editor having produced a broken file rather than as a form waiting to
 * be filled in.
 */
export interface ActionDefaults {
  readonly windowId: string;
  readonly widget: string;
  readonly message: string;
  readonly soundKit: string;
}

export interface ActionForm {
  /** The `"do"` this writes. */
  readonly verb: string;
  readonly label: string;
  /** The rows the inspector draws for it. `value.<поле>` and `args.<n>` reach one level in. */
  readonly fields: readonly BuilderField[];
  readonly make: (defaults: ActionDefaults) => JsonRecord;
}

/**
 * The action verbs the editor writes, out of the fourteen `parseAction` reads.
 *
 * Twelve of the fourteen, and the two left out are left out on purpose. `sendCustomRaw` is a list
 * of typed fields with an opcode of its own, and the parser's own sentence says what to do instead
 * — «declare a message under "messages" and use sendCustom for anything with a shape» — so
 * offering it in a form would be offering the road the parser argues against. `if` carries two
 * whole action lists inside it, which is a tree inside a row: it stays a thing to write in the JSON
 * pane, where it reads as what it is.
 *
 * `chat` is first because it is the one action that proves the whole chain with no server behind it
 * — press the button, watch the words land in the chat box — and `sendCustom` is the one the plan's
 * acceptance names.
 */
export const ACTION_FORMS: readonly ActionForm[] = [
  {
    verb: "chat", label: "сказать в чат",
    fields: [field("text", "Текст", "expression")],
    make: () => ({ do: "chat", text: { ru: "Привет", en: "" } }),
  },
  {
    verb: "sendCustom", label: "отправить пакет",
    // No `choices` written here: the schemas are whatever the module declared and whatever the
    // world has loaded, so the inspector fills the menu from the registry it can see.
    fields: [field("message", "Сообщение", "choice")],
    make: (defaults) => ({ do: "sendCustom", message: defaults.message, value: {} }),
  },
  {
    verb: "open", label: "открыть окно",
    fields: [field("window", "Окно", "text")],
    make: (defaults) => ({ do: "open", window: defaults.windowId }),
  },
  {
    verb: "toggle", label: "открыть/закрыть окно",
    fields: [field("window", "Окно", "text")],
    make: (defaults) => ({ do: "toggle", window: defaults.windowId }),
  },
  {
    verb: "close", label: "закрыть окно",
    fields: [field("window", "Окно (пусто — это же)", "text")],
    make: () => ({ do: "close", window: "" }),
  },
  {
    verb: "show", label: "показать виджет",
    fields: [field("widget", "Виджет", "text")],
    make: (defaults) => ({ do: "show", widget: defaults.widget }),
  },
  {
    verb: "hide", label: "спрятать виджет",
    fields: [field("widget", "Виджет", "text")],
    make: (defaults) => ({ do: "hide", widget: defaults.widget }),
  },
  {
    verb: "toggleWidget", label: "показать/спрятать виджет",
    fields: [field("widget", "Виджет", "text")],
    make: (defaults) => ({ do: "toggleWidget", widget: defaults.widget }),
  },
  {
    verb: "setState", label: "записать состояние",
    fields: [field("key", "Ключ", "text"), field("value", "Значение", "expression")],
    make: () => ({ do: "setState", key: "flag", value: 1 }),
  },
  {
    verb: "command", label: "команда клиента",
    fields: [
      field("name", "Команда", "choice", WINDOW_COMMANDS),
      field("args.0", "Аргумент 1", "expression"),
      field("args.1", "Аргумент 2", "expression"),
      field("args.2", "Аргумент 3", "expression"),
    ],
    make: () => ({ do: "command", name: "selectTarget", args: [] }),
  },
  {
    verb: "macro", label: "макрос",
    fields: [field("body", "Строки макроса", "expression")],
    make: () => ({ do: "macro", body: { ru: "", en: "" } }),
  },
  {
    verb: "sound", label: "звук",
    // Filled from `UI_SOUNDS` by the inspector, for the same reason `sendCustom`'s menu is.
    fields: [field("kit", "Набор", "choice")],
    make: (defaults) => ({ do: "sound", kit: defaults.soundKit }),
  },
];

const ACTION_FORM_BY_VERB = new Map(ACTION_FORMS.map((form) => [form.verb, form]));

/** The form for one action already in the file, by its own `"do"`. */
export function actionForm(entry: JsonRecord): ActionForm | undefined {
  const verb = entry["do"];
  return typeof verb === "string" ? ACTION_FORM_BY_VERB.get(verb) : undefined;
}

/**
 * The rows one condition needs, which depend on the condition it is.
 *
 * Not a fixed table like the widget fields, because `parseConditions` reads `value` as a **number**
 * for seventeen of the eighteen and as an **expression** for `expr` — a single row would write a
 * string where a number was wanted and the condition would quietly fall back to the studio's own
 * default. And a `then` of `color` or `alpha` carries a value the other two effects have no use
 * for, so the row appears when it means something and not before.
 */
export function conditionFields(when: string, then: string): readonly BuilderField[] {
  const rows: BuilderField[] = [
    field("when", "Когда", "choice", CONDITION_NAMES),
    field("then", "Тогда", "choice", CONDITION_EFFECTS),
  ];
  const spec = WINDOW_CONDITIONS.find((option) => option.name === when);
  if (when === "expr") rows.push(field("value", "Выражение", "expression"));
  else if (spec?.number !== undefined) rows.push(field("value", "Порог", "number"));
  if (spec?.text) rows.push(field("text", "Имя", "text"));
  if (then === "color") rows.push(field("color", "Цвет", "color"));
  if (then === "alpha") rows.push(field("alpha", "Прозрачность", "number"));
  return rows;
}

/** A new condition of one kind, with the studio's own default threshold already in it. */
export function newConditionJson(when: string): JsonRecord {
  const spec = WINDOW_CONDITIONS.find((option) => option.name === when);
  const entry: JsonRecord = { when, then: "show" };
  if (when === "expr") entry["value"] = "player.combat";
  else if (spec?.number !== undefined) entry["value"] = spec.number;
  if (spec?.text) entry["text"] = "";
  return entry;
}

/** The records one list key holds on one widget, in file order. Empty when there is no such list. */
export function widgetList(definition: JsonRecord, id: string, key: string): readonly JsonRecord[] {
  const site = findSite(definition, id);
  if (!site) return [];
  const raw = site.widget[key];
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

/** The live array, made if the widget has none, so a push actually lands in the definition. */
function liveList(widget: JsonRecord, key: string): unknown[] {
  const raw = widget[key];
  if (Array.isArray(raw)) return raw;
  const made: unknown[] = [];
  widget[key] = made;
  return made;
}

/**
 * Puts a new action on a widget, in the key that widget's type is actually read from.
 *
 * Refused rather than written into a key nobody reads when the type runs nothing at all: a `Text`
 * with an `actions` array beside it is a file that looks like it does something, which is the exact
 * failure this whole editor is against.
 */
export function addWidgetAction(
  definition: JsonRecord,
  id: string,
  verb: string,
  defaults: ActionDefaults,
  context: BuilderContext,
): BuilderResult {
  const form = ACTION_FORM_BY_VERB.get(verb);
  if (!form) return refuse(definition, id, `действия "${verb}" этот редактор не пишет`);
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  const key = actionListKey(widgetType(site.widget));
  if (!key) {
    return refuse(definition, id,
      `${widgetType(site.widget)} ничего не запускает — действия носят ${Object.keys(ACTION_LIST_KEY).join(", ")}`);
  }
  liveList(site.widget, key).push(form.make(defaults));
  return commit(definition, next, context, { expect: [id], selected: id, what: `действие «${form.label}»` });
}

/** And a new condition, which every one of the twelve types carries. */
export function addWidgetCondition(
  definition: JsonRecord,
  id: string,
  when: string,
  context: BuilderContext,
): BuilderResult {
  if (!(CONDITION_NAMES as readonly string[]).includes(when)) {
    return refuse(definition, id, `условия "${when}" этот клиент не знает`);
  }
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  liveList(site.widget, "conditions").push(newConditionJson(when));
  return commit(definition, next, context, { expect: [id], selected: id, what: `условие «${when}»` });
}

/** Takes one entry out of a widget's action or condition list. */
export function removeListEntry(
  definition: JsonRecord,
  id: string,
  key: string,
  index: number,
  context: BuilderContext,
): BuilderResult {
  if (!LIST_KEYS.has(key)) return refuse(definition, id, `список "${key}" этот редактор не правит`);
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  const list = site.widget[key];
  if (!Array.isArray(list) || index < 0 || index >= list.length) {
    return refuse(definition, id, `в "${key}" нет записи №${index + 1}`);
  }
  list.splice(index, 1);
  // The empty array is taken out with the last entry: the studio writes no key at all for a widget
  // that does nothing, and a file that came from the studio has to go back looking like one.
  if (list.length === 0) delete site.widget[key];
  return commit(definition, next, context, { expect: [id], selected: id, what: `запись ${index + 1} из "${key}"` });
}

/**
 * Writes one field of one entry, reaching one level in for `sendCustom`'s values and an argument.
 *
 * `value.entry` is a key of the object `sendCustom` sends; `args.0` is a slot of the array a
 * `command` is called with. Clearing an argument **truncates** rather than leaving a hole, because
 * the codec and every command read the array by position: `args` of `[1, undefined, 3]` would send
 * the third value as the second.
 */
export function setListEntryField(
  definition: JsonRecord,
  id: string,
  key: string,
  index: number,
  path: string,
  value: unknown,
  context: BuilderContext,
): BuilderResult {
  if (!LIST_KEYS.has(key)) return refuse(definition, id, `список "${key}" этот редактор не правит`);
  if (path === "do") return refuse(definition, id, "род действия не правится: удалите запись и добавьте нужную");
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  const list = site.widget[key];
  const entry = Array.isArray(list) ? list[index] : undefined;
  if (!isRecord(entry)) return refuse(definition, id, `в "${key}" нет записи №${index + 1}`);

  const cut = path.indexOf(".");
  if (cut < 0) {
    if (value === undefined) delete entry[path];
    else entry[path] = value;
  } else {
    const head = path.slice(0, cut);
    const leaf = path.slice(cut + 1);
    const slot = /^[0-9]+$/.test(leaf) ? Number(leaf) : -1;
    if (slot >= 0) {
      const args = Array.isArray(entry[head]) ? entry[head] as unknown[] : (entry[head] = [] as unknown[]);
      if (value === undefined) args.length = Math.min(args.length, slot);
      else {
        while (args.length < slot) args.push(0);
        args[slot] = value;
      }
    } else {
      const nested = isRecord(entry[head]) ? entry[head] as JsonRecord : (entry[head] = {} as JsonRecord);
      if (value === undefined) delete nested[leaf];
      else nested[leaf] = value;
    }
  }
  return commit(definition, next, context, { expect: [id], selected: id, what: `поле "${path}"` });
}

/**
 * A new widget of one type, with the defaults the studio would have given it.
 *
 * Every one of them is drawable as it stands: a Texture points at the client's own question mark
 * rather than at nothing, a DropDown carries two choices, a StatusBar shows half of a hundred. A
 * widget that appears as an invisible box is a widget an author cannot find again, and «add» has to
 * put something on the screen or it reads as having done nothing.
 */
export function newWidgetJson(type: WidgetType, id: string): JsonRecord {
  const base: JsonRecord = {
    id,
    type,
    name: "",
    width: 120,
    height: 20,
    anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 8, y: -8 },
    conditions: [],
  };
  switch (type) {
    case "Frame":
      return { ...base, width: 160, height: 100, backdrop: "tooltip", mouse: false, movable: false, children: [] };
    case "Texture":
      return { ...base, width: 32, height: 32, texture: "Interface\\Icons\\INV_Misc_QuestionMark", layer: "ARTWORK", solid: false };
    case "Text":
      return { ...base, text: { ru: "Текст", en: "" }, font: "GameFontNormal", justifyH: "LEFT" };
    case "Button":
      return { ...base, width: 100, height: 22, text: { ru: "Кнопка", en: "" }, template: "UIPanelButtonTemplate" };
    case "CheckButton":
      return { ...base, text: { ru: "Флажок", en: "" }, checked: false };
    case "EditBox":
      return { ...base, text: "", numeric: false, multiline: false };
    case "StatusBar":
      return { ...base, width: 160, height: 18, value: 50, min: 0, max: 100, showText: true };
    case "Slider":
      return { ...base, width: 160, min: 0, max: 100, step: 1, value: 50, showValue: true };
    case "ScrollFrame":
      return { ...base, width: 160, height: 100, contentHeight: 200, children: [] };
    case "ItemButton":
      return { ...base, width: 36, height: 36, icon: 0, itemId: 0, spellId: 0, count: 0, tooltip: true };
    case "DropDown":
      return { ...base, width: 160, options: "Первый\nВторой", selected: 1 };
    case "Model":
      return { ...base, width: 120, height: 140, unit: "player", creature: 0, rotation: 0 };
  }
}

/* ---------------------------------------------------------------------------------------------
 * The edits
 * ------------------------------------------------------------------------------------------- */

/** Puts a new widget of one type inside a container. */
export function addWidget(
  definition: JsonRecord,
  options: { readonly parent: string; readonly type: WidgetType },
  context: BuilderContext,
): BuilderResult {
  if (!(WIDGET_TYPES as readonly string[]).includes(options.type)) {
    return refuse(definition, options.parent, `тип "${options.type}" этот клиент не рисует`);
  }
  const next = cloneDefinition(definition);
  const site = findSite(next, options.parent);
  if (!site) return refuse(definition, options.parent, `виджета "${options.parent}" в окне нет`);
  if (!BUILDER_CONTAINER_TYPES.has(widgetType(site.widget))) {
    return refuse(definition, options.parent,
      `${widgetType(site.widget)} не держит детей — вложить можно во Frame или ScrollFrame`);
  }
  const taken = definitionIds(next);
  if (taken.size >= WINDOW_MAX_WIDGETS) {
    return refuse(definition, options.parent, `в окне уже ${taken.size} виджетов, предел ${WINDOW_MAX_WIDGETS}`);
  }
  const id = uniqueWidgetId(taken, options.type.toLowerCase());
  const children = liveChildren(site.widget, true);
  children?.push(newWidgetJson(options.type, id));
  return commit(definition, next, context, { expect: [id], selected: id, what: `добавление ${options.type}` });
}

/**
 * A copy of one widget and everything under it, placed beside the original.
 *
 * Offset by eight pixels rather than laid exactly on top, because a copy that lands under its
 * original is a copy nobody can see: the whole of «дублировать» would read as having done nothing,
 * and the author's first move is to drag it anyway.
 */
export function duplicateWidget(definition: JsonRecord, id: string, context: BuilderContext): BuilderResult {
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  if (!site.parent) return refuse(definition, id, "корневую рамку не дублируют — это «Создать окно» → «копия окна»");

  const taken = definitionIds(next);
  const copy = cloneDefinition(site.widget);
  const map = new Map<string, string>();
  for (const widget of walkRawWidgets(copy)) {
    const old = widgetId(widget);
    if (!old) continue;
    const fresh = uniqueWidgetId(taken, old);
    taken.add(fresh);
    map.set(old, fresh);
    widget["id"] = fresh;
  }
  // The ids first, then every reference to them *inside the copy alone*: an anchor in the original
  // subtree still means the original, and a button in the copy that showed a widget of the copy has
  // to go on meaning the copy's.
  renameReferences(copy, map);
  const anchor = anchorOf(copy);
  const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  anchor["x"] = number(anchor["x"]) + 8;
  anchor["y"] = number(anchor["y"]) - 8;

  const children = liveChildren(site.parent, true);
  children?.splice(site.index + 1, 0, copy);
  const fresh = widgetId(copy);
  return commit(definition, next, context, { expect: [fresh], selected: fresh, what: `дублирование "${id}"` });
}

/** Takes a widget and its subtree out, and puts back whatever was anchored to any of them. */
export function deleteWidget(definition: JsonRecord, id: string, context: BuilderContext): BuilderResult {
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  if (!site.parent) return refuse(definition, id, "корневую рамку не удаляют: без неё окна нет");

  const children = liveChildren(site.parent, false);
  children?.splice(site.index, 1);
  const screen = screenOf(next);
  const moved: string[] = [];
  // The anchors, and only the anchors. An action that named the deleted widget is left exactly as
  // the author wrote it — `modules:check` and the loader both say so by name — because rewriting a
  // button's behaviour is not what «удалить» asked for, while an anchor pointing at nothing is a
  // file the parser refuses whole.
  if (screen) repairAnchors(screen, moved);
  const parentId = widgetId(site.parent);
  const result = commit(definition, next, context, { expect: [], selected: parentId, what: `удаление "${id}"` });
  return moved.length === 0 || !result.changed
    ? result
    : {
        ...result,
        problems: [
          ...result.problems,
          `якорь ${moved.map((name) => `"${name}"`).join(", ")} указывал на удалённое — перевешен на родителя`,
        ],
      };
}

/** Moves a widget and its subtree under a different container. */
export function reparentWidget(
  definition: JsonRecord,
  id: string,
  parentId: string,
  context: BuilderContext,
): BuilderResult {
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  if (!site.parent) return refuse(definition, id, "корневая рамка ни во что не вкладывается");
  if (widgetId(site.parent) === parentId) return refuse(definition, id, `"${id}" уже лежит в "${parentId}"`);
  if (within(next, id, parentId)) {
    return refuse(definition, id, `"${parentId}" лежит внутри "${id}" — виджет нельзя вложить в самого себя`);
  }
  const host = findSite(next, parentId);
  if (!host) return refuse(definition, id, `виджета "${parentId}" в окне нет`);
  if (!BUILDER_CONTAINER_TYPES.has(widgetType(host.widget))) {
    return refuse(definition, id, `${widgetType(host.widget)} не держит детей — вложить можно во Frame или ScrollFrame`);
  }

  const from = liveChildren(site.parent, false);
  from?.splice(site.index, 1);
  liveChildren(host.widget, true)?.push(site.widget);
  const screen = screenOf(next);
  const moved: string[] = [];
  if (screen) repairAnchors(screen, moved);
  const result = commit(definition, next, context, { expect: [id], selected: id, what: `перенос "${id}"` });
  return moved.length === 0 || !result.changed
    ? result
    : {
        ...result,
        problems: [
          ...result.problems,
          `якорь ${moved.map((name) => `"${name}"`).join(", ")} потерял свою цель при переносе — перевешен на родителя`,
        ],
      };
}

/** Writes an anchor's `x`/`y`, which is what a drag in the preview produces. */
export function moveWidget(definition: JsonRecord, id: string, x: number, y: number, context: BuilderContext): BuilderResult {
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  const anchor = anchorOf(site.widget);
  anchor["x"] = Math.round(Number.isFinite(x) ? x : 0);
  anchor["y"] = Math.round(Number.isFinite(y) ? y : 0);
  return commit(definition, next, context, { expect: [id], selected: id, what: `сдвиг "${id}"` });
}

/** Writes `width`/`height`, which is what dragging an edge in the preview produces. */
export function resizeWidget(
  definition: JsonRecord,
  id: string,
  width: number,
  height: number,
  context: BuilderContext,
): BuilderResult {
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  const size = (value: number, fallback: number): number =>
    Math.max(MIN_WIDGET_SIZE, Math.round(Number.isFinite(value) ? value : fallback));
  site.widget["width"] = size(width, MIN_WIDGET_SIZE);
  site.widget["height"] = size(height, MIN_WIDGET_SIZE);
  return commit(definition, next, context, { expect: [id], selected: id, what: `размер "${id}"` });
}

/**
 * Writes one field of one widget, and refuses the write when the parser stops drawing the widget.
 *
 * `undefined` deletes the key, which is how a choice goes back to the studio's own default rather
 * than being pinned to whatever the menu happened to show first.
 */
export function setWidgetField(
  definition: JsonRecord,
  id: string,
  key: string,
  value: unknown,
  context: BuilderContext,
): BuilderResult {
  if (key === "id" || key === "type" || key === "children") {
    return refuse(definition, id, `поле "${key}" правится не здесь: id — «переименовать», type и children — деревом`);
  }
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  const cut = key.indexOf(".");
  // One level in, for the two fields that have one: `anchor.x` and a button's `textures.normal`.
  // The anchor is made through `anchorOf` rather than as an empty object, because a half-written
  // anchor is a widget the parser drops — every other key is a plain record the studio may or may
  // not have written, and an absent one means the widget simply has none yet.
  const head = cut < 0 ? "" : key.slice(0, cut);
  const nested = (): JsonRecord => {
    if (head === "anchor") return anchorOf(site.widget);
    const raw = site.widget[head];
    if (isRecord(raw)) return raw;
    const made: JsonRecord = {};
    site.widget[head] = made;
    return made;
  };
  const target = cut < 0 ? site.widget : nested();
  const leaf = cut < 0 ? key : key.slice(cut + 1);
  if (value === undefined) delete target[leaf];
  else target[leaf] = value;
  return commit(definition, next, context, { expect: [id], selected: id, what: `поле "${key}"` });
}

/**
 * Renames a widget and every reference to it: anchors, and the actions that name one.
 *
 * What is deliberately *not* rewritten is an expression that spells the id out by hand. An input
 * with no `state` of its own publishes under `state.<its id>`, so a label reading
 * `{state.qty}` goes blank when `qty` is renamed — and the fix would be to re-serialise the parsed
 * expression back into the file, which throws away the author's own spacing and comments in every
 * other expression in the window at the same time. `modules:check` and the loader say nothing about
 * it either, because an unknown path is `undefined` by design; what says it is the inspector's live
 * column, which reads blank the moment it happens.
 */
export function renameWidget(definition: JsonRecord, id: string, fresh: string, context: BuilderContext): BuilderResult {
  if (id === fresh) return refuse(definition, id, "имя не изменилось");
  if (!WIDGET_ID_SHAPE.test(fresh)) {
    return refuse(definition, id, `"${fresh}" — не имя виджета: буквы, цифры, "_" и "-", первый символ буква или цифра`);
  }
  if (fresh === RESERVED_WIDGET_ID) {
    // Refused for the same reason a taken name is, and it is not in `definitionIds` to be caught
    // that way: `parent` is taken by the anchor grammar. The rename would parse, and every anchor
    // that named this widget would silently start meaning the enclosing frame.
    return refuse(definition, id, `имя "${RESERVED_WIDGET_ID}" занято якорями: так виджет называет свою рамку`);
  }
  if (definitionIds(definition).has(fresh)) return refuse(definition, id, `имя "${fresh}" в этом окне уже занято`);
  const next = cloneDefinition(definition);
  const site = findSite(next, id);
  if (!site) return refuse(definition, id, `виджета "${id}" в окне нет`);
  site.widget["id"] = fresh;
  renameReferences(next, new Map([[id, fresh]]));
  return commit(definition, next, context, { expect: [fresh], selected: fresh, what: `переименование "${id}"` });
}

/**
 * Takes the whole definition from text, which is what the JSON pane's «применить» does.
 *
 * The same commit every other edit goes through, so hand-written JSON cannot get past the parser
 * where a menu could not — and a file pasted from the studio is checked before it replaces
 * anything, rather than after the preview has gone blank.
 */
export function applyDefinitionText(before: JsonRecord, text: string, context: BuilderContext): BuilderResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return refuse(before, "", `JSON не читается: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) return refuse(before, "", "определение окна — это объект JSON");
  const screen = screenOf(parsed);
  return commit(before, parsed, context, {
    expect: [],
    selected: screen ? widgetId(screen) : "",
    what: "правка JSON",
  });
}

/* ---------------------------------------------------------------------------------------------
 * Three ways to start a window
 * ------------------------------------------------------------------------------------------- */

export interface NewWindowOptions {
  readonly id: string;
  readonly title?: string | undefined;
  /** The studio writes an ISO timestamp; taken as an argument so this stays a pure function. */
  readonly updated?: string | undefined;
}

/** An empty frame in the middle of the screen — the shortest thing that is a whole window. */
export function emptyWindowDefinition(options: NewWindowOptions): JsonRecord {
  const title = options.title ?? options.id;
  const definition: JsonRecord = {
    kind: "addon",
    id: options.id,
    name: { ru: title, en: "" },
    enabled: true,
    format: 1,
    params: {
      screen: {
        id: "root",
        type: "Frame",
        name: "",
        width: 320,
        height: 200,
        anchor: { point: "CENTER", relativeTo: "parent", relativePoint: "CENTER", x: 0, y: 0 },
        backdrop: "dialog",
        strata: "DIALOG",
        movable: true,
        mouse: true,
        hidden: false,
        closeButton: true,
        escClose: true,
        title: { ru: title, en: "" },
        children: [],
        events: [],
      },
      packets: { enabled: false, opcodeIn: 0, opcodeOut: 0 },
    },
  };
  if (options.updated) definition["updated"] = options.updated;
  return definition;
}

/**
 * A copy of a window that already exists, under a new id.
 *
 * Three things are dropped rather than copied, and all three for the same reason: **a copy may not
 * claim what the original already holds.** The `/команда` and the key binding, because the chat
 * table and the bindings table each refuse the second claimant and name it; and the window's own
 * inline `messages`, because a custom opcode may be claimed once, `CustomPacketRegistry.define`
 * refuses the copy's, and М9 turns that into a build failure — one whose sentence names the
 * *original* file, the one the author did not touch. Measured before it was fixed: a copy of a
 * window declaring `shop.Buy` at opcode 4001 made the check print
 * `shop/ui/shop.json: … shop.Buy is already defined by module "shop/shop-copy"` and exit 1.
 *
 * Everything else is kept, the screen included: «копия окна» exists for starting from a screen that
 * already works, and a copy arriving with its widgets stripped would be an empty frame with extra
 * steps.
 */
export function copyWindowDefinition(source: JsonRecord, options: NewWindowOptions): JsonRecord {
  const copy = cloneDefinition(source);
  copy["id"] = options.id;
  const title = options.title ?? options.id;
  copy["name"] = { ru: title, en: "" };
  if (options.updated) copy["updated"] = options.updated;
  const params = copy["params"];
  if (isRecord(params)) {
    delete params["slash"];
    delete params["binding"];
    delete params["messages"];
  }
  return copy;
}

/** One row of the skeleton: what to label it and which path it reads. */
interface SkeletonRow {
  readonly label: string;
  readonly path: string;
}

/**
 * Every leaf of a message, as the path an expression reaches it by.
 *
 * `nested` is flattened because that is what the codec does — the fields go inline, with nothing
 * around them — and an `array` is shown at its first slot, because a row per capacity would be a
 * window of eight identical lines for a message that usually carries one.
 */
function messageRows(fields: readonly CustomField[], prefix: string): SkeletonRow[] {
  const rows: SkeletonRow[] = [];
  for (const entry of fields) {
    const path = prefix ? `${prefix}.${entry.name}` : entry.name;
    if (entry.type.kind === "nested") {
      rows.push(...messageRows(entry.type.fields, path));
      continue;
    }
    if (entry.type.kind === "array") {
      // An array of records is the two rules at once: the first slot, and then the record's own
      // leaves inline. A single row reading `{msg.X.list[0]}` would put an object where the format
      // has no words for one, which is a blank line and not a value.
      if (entry.type.of.kind === "nested") {
        rows.push(...messageRows(entry.type.of.fields, `${path}[0]`));
        continue;
      }
      rows.push({ label: `${entry.name}[0]`, path: `${path}[0]` });
      continue;
    }
    rows.push({ label: entry.name, path });
  }
  return rows;
}

/**
 * A window that shows one message, one row per field.
 *
 * The shortest road from «мой лайвскрипт это шлёт» to «я это вижу»: the schema already says what
 * the fields are called and `msg.<имя>.<поле>` is where the last decoded value of each of them
 * lives, so the window can be written out rather than laid out by hand. `u64` and `i64` decode to
 * `bigint`, which `formatExpressionValue` has no words for, so those go through `fmt` — otherwise
 * the row an author most wants to see (a guid) would be the one that reads blank.
 */
export function skeletonFromMessage(message: CustomMessage, options: NewWindowOptions): JsonRecord {
  const title = options.title ?? message.name;
  const definition = emptyWindowDefinition({ ...options, title });
  const screen = screenOf(definition);
  if (!screen) return definition;

  // Which paths decode to a `bigint`, so that exactly those rows go through `fmt`. An array is
  // walked at `[0]` and by the same rule as everything else — `CustomCodec.decodeField` reads each
  // element of an `array of u64` with `reader.u64()`, so an array of guids is a row that reads
  // blank without this, which is precisely the row `fmt` exists for.
  const bigints = new Set<string>();
  const collect = (fields: readonly CustomField[], prefix: string): void => {
    for (const entry of fields) {
      const path = prefix ? `${prefix}.${entry.name}` : entry.name;
      const of = entry.type.kind === "array" ? entry.type.of : entry.type;
      const at = entry.type.kind === "array" ? `${path}[0]` : path;
      if (of.kind === "nested") collect(of.fields, at);
      else if (of.kind === "u64" || of.kind === "i64") bigints.add(at);
    }
  };
  collect(message.fields, "");

  const all = messageRows(message.fields, "");
  const rows = all.slice(0, SKELETON_MAX_ROWS);
  const children: JsonRecord[] = [];
  const taken = new Set<string>(["root"]);
  for (const [index, row] of rows.entries()) {
    const stem = uniqueWidgetId(taken, row.label.replace(/[^A-Za-z0-9_-]/g, "-") || `field-${index + 1}`);
    taken.add(stem);
    const valueId = uniqueWidgetId(taken, `${stem}-value`);
    taken.add(valueId);
    const top = -12 - index * 18;
    const source = `msg.${message.name}.${row.path}`;
    children.push({
      id: stem,
      type: "Text",
      name: "",
      width: 130,
      height: 16,
      text: `${row.label}:`,
      font: "GameFontHighlightSmall",
      justifyH: "LEFT",
      anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 12, y: top },
      conditions: [],
    });
    children.push({
      id: valueId,
      type: "Text",
      name: "",
      width: 160,
      height: 16,
      text: bigints.has(row.path) ? `{fmt(${source})}` : `{${source}}`,
      font: "GameFontNormalSmall",
      justifyH: "LEFT",
      anchor: { point: "TOPLEFT", relativeTo: stem, relativePoint: "TOPRIGHT", x: 6, y: 0 },
      conditions: [],
    });
  }
  // The cut, written into the window itself. `skeletonFromMessage` has no channel to report on —
  // it returns a definition and nothing else — and the honest place to say «здесь не всё» is the
  // screen the author is about to look at.
  const cut = all.length - rows.length;
  if (cut > 0) {
    children.push({
      id: uniqueWidgetId(taken, "skeleton-cut"),
      type: "Text",
      name: "",
      width: 300,
      height: 16,
      text: `…и ещё ${cut} пол(я/ей) — допишите строки сами`,
      font: "GameFontDisableSmall",
      justifyH: "LEFT",
      anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 12, y: -12 - rows.length * 18 },
      conditions: [],
    });
  }

  screen["children"] = children;
  screen["height"] = Math.max(80, 40 + (rows.length + (cut > 0 ? 1 : 0)) * 18);
  screen["width"] = 330;
  return definition;
}

/* ---------------------------------------------------------------------------------------------
 * Export
 * ------------------------------------------------------------------------------------------- */

export type ExportKind = "written" | "clipboard" | "refused" | "error";

export interface ExportOutcome {
  readonly kind: ExportKind;
  /** Whether the JSON reached the clipboard, whichever way the caller managed that. */
  readonly copied: boolean;
  /** Whether the gateway wrote the file. */
  readonly written: boolean;
  readonly message: string;
  /** The bytes the export was made of, so a caller can show or count them. */
  readonly text: string;
}

export interface ExportTarget {
  readonly module: string;
  /** The filename under `content/ui/`, extension included. */
  readonly file: string;
  /** The gateway's own origin. Empty means there is nowhere to PUT, and the clipboard is all. */
  readonly baseUrl: string;
}

export interface ExportIo {
  /** Puts the text on the clipboard. Anything thrown is caught and reported, never propagated. */
  copy?: ((text: string) => Promise<void> | void) | undefined;
  /** The `fetch` to PUT with. Absent means the file is not offered to the gateway at all. */
  fetch?: ((url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    readonly status: number;
    readonly ok: boolean;
  }>) | undefined;
}

/**
 * The two halves of «экспорт»: always the clipboard, and the gateway only when it is switched on.
 *
 * A download is deliberately not offered as a third. The gateway warns at start-up that it is an
 * unauthenticated pipe, which is the reason `MODULE_UI_WRITE` is off by default — and a 405 is a
 * fact about that switch rather than a failure, so it is reported in the words that name the switch
 * instead of as an error. The clipboard is what always works: the author pastes the file into the
 * module themselves, which is the road that needs nothing turned on at all.
 */
export async function exportWindowDefinition(
  definition: JsonRecord,
  target: ExportTarget,
  io: ExportIo = {},
): Promise<ExportOutcome> {
  const text = definitionText(definition);
  let copied = false;
  let copyProblem = "";
  if (io.copy) {
    try {
      await io.copy(text);
      copied = true;
    } catch (error) {
      copyProblem = error instanceof Error ? error.message : String(error);
    }
  }
  const clipboard = copied ? "JSON в буфере обмена" : `буфер обмена недоступен${copyProblem ? ` (${copyProblem})` : ""}`;

  if (!target.baseUrl || !io.fetch) {
    return { kind: copied ? "clipboard" : "error", copied, written: false, text, message: `${clipboard}; шлюз не спрошен` };
  }
  const url = `${target.baseUrl}/modules/ui/${target.module}/${target.file}`;
  try {
    const response = await io.fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: text,
    });
    if (response.status === 405) {
      return {
        kind: "refused", copied, written: false, text,
        message: `${clipboard}. Шлюз не пишет файлы: запустите его с MODULE_UI_WRITE=1 и с этой же машины`
          + " — иначе вставьте JSON в модуль сами.",
      };
    }
    if (!response.ok) {
      return { kind: "error", copied, written: false, text, message: `${clipboard}; шлюз ответил ${response.status}` };
    }
    return {
      kind: "written", copied, written: true, text,
      message: `${clipboard}; записано в data/ui/${target.module}/ui/${target.file}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "error", copied, written: false, text, message: `${clipboard}; шлюз недоступен: ${reason}` };
  }
}
