/**
 * Turning a parsed window definition into a window on the screen.
 *
 * The shell is the kit's own `Panel` (`Widgets.ts`), so a module window is the same
 * `<section class="game-window">` every built-in window is: `GameWindowManager` gives it the
 * cascade on first show, the drag handle, the raise-on-click and — the part that matters for М6's
 * hot reload — a remembered position keyed on the element id, so a window rebuilt from a changed
 * file comes back exactly where the player dragged it.
 *
 * Three things decide the design, and each of them is a departure from how the rest of this
 * interface draws:
 *
 * * **Coordinates are WoW's, flipped once.** `SetPoint(point, relativeTo, relativePoint, x, y)`
 *   with y growing *upward* is what the studio writes and what the Lua addon generated from the
 *   same file will feed the real client. Every widget carries its own width and height, so the
 *   whole layout is arithmetic — no measuring, no reflow — and the single `- y` in
 *   {@link anchorBox} is the entire flip. Doing it anywhere else means doing it twice.
 * * **`update` mutates, it does not rebuild.** Every panel in this client draws by whole content
 *   (`SlotGrid.render` says so out loud), and that is right for a list the server replaces. It is
 *   wrong for a window whose bar follows the player's health sixty times a second: rebuilding
 *   drops the element under the pointer, restarts every tooltip and makes a text selection
 *   impossible. So each bound value keeps its last result and writes nothing when it has not
 *   changed. That is also what makes the once-a-frame pass cheap enough to leave running.
 * * **Nothing an author writes becomes code.** The definition arrives as inert data from
 *   `WindowSchema`/`WindowExpression`; this file evaluates it and writes strings into `textContent`
 *   and numbers into `style`. Action lists are carried and handed to
 *   {@link WindowRenderHost.runActions} — `WindowActions.ts` in the client, absent in a test, and
 *   then a press is counted and refused out loud rather than doing nothing quietly.
 *
 * What this slice does **not** draw: a `Model` widget is a labelled placeholder box. The 3D
 * portrait needs a second renderer view hung on the character, which is a slice of its own.
 */

import { setIconSource } from "./IconImage.js";
import { Bar, Panel, attachTooltip, stackLabel } from "./Widgets.js";
import {
  evaluate, expressionRoots, formatExpressionValue,
  type ExprNode, type ExpressionHelpers, type ExpressionScope,
} from "./WindowExpression.js";
import type { RegisteredWindow } from "./WindowRegistry.js";
import {
  FONT_OBJECTS, LAYERS,
  type Anchor, type AnchorPoint, type LayerName, type ParsedCondition, type ParsedWidget,
  type ParsedWindow, type Rgba, type StrataName, type WindowAction,
} from "./WindowSchema.js";

/* ---------------------------------------------------------------------------------------------
 * The seam
 * ------------------------------------------------------------------------------------------- */

/** Which widget of which window asked for something to happen. */
export interface WindowActionContext {
  readonly window: string;
  readonly module: string;
  readonly widget: string;
  /** The window's own state, which `setState` writes and expressions read as `state.<key>`. */
  readonly state: Record<string, unknown>;
  /**
   * The `repeat` loop variables in scope at this widget, when it sits inside one.
   *
   * A press is not a frame. The row a repeated widget was drawn from lives in the scope
   * {@link updateRepeat} folds and nowhere else, so a button repeated over the raid has to be told
   * which row the player clicked — otherwise `selectTarget("{row.guid}")` evaluates to `undefined`,
   * and `WorldClient.selectTarget(undefined)` sends guid 0, which *clears* the target. Silently:
   * every other failure in `WindowActions` is refused out loud, and this one looked like a working
   * button.
   */
  readonly row?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The slot this widget was drawn into, when it came from a patch file (М7).
   *
   * `{name, …parameters}` — `slot.questId` on a quest card, `slot.bag` on a bag window — folded
   * into the scope a press runs against for the same reason {@link WindowActionContext.row} is: the
   * button on the card the player clicked has to be able to say *which* card, and a patch's whole
   * point is that its widget is drawn once per place the built-in declared.
   */
  readonly slot?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Where `show`/`hide`/`toggleWidget` look for a widget by id.
   *
   * A window's widgets are found through the registry, by the window's id. A patch has no window,
   * so it hands over the subtree it drew instead — without it those three verbs would answer
   * «виджета нет» for a widget that is on the screen.
   */
  readonly root?: HTMLElement | undefined;
}

export interface WindowRenderHost {
  /**
   * Runs an action list. `WindowActions.runWindowActions` in the client.
   *
   * Optional rather than required so that this file can be built and tested with no chat, no
   * world client and no sound — the three things every action eventually reaches.
   */
  runActions?: ((actions: readonly WindowAction[], context: WindowActionContext) => void) | undefined;
  /**
   * A path in the client archives turned into a URL the page may ask for.
   *
   * Absent in a test, and then no picture is fetched at all. In the page it is the gateway's
   * `/texture?path=…`, which an `<img src>` cannot reach on its own — the gateway refuses a request
   * with no `Origin` header and a browser sends none for an image load — so every picture here
   * goes through `setIconSource`, which fetches the bytes and hands over a blob URL. That trap is
   * written up in `IconImage.ts`; this is the second place that would have fallen into it.
   */
  textureUrl?: ((path: string) => string) | undefined;
  /**
   * Told when a picture this window asked for did not arrive.
   *
   * Nothing was ever told. `setIconSource` turns a failed fetch into an `error` event on the
   * `<img>`, `textureImage` attaches no listener, so a window whose every picture answered 400 had
   * an empty `problems` list, a status line reading «модули: окон 1» and a `modules:check` that
   * printed "No problems" and exited 0 — while the two requests it had just made were both 400s.
   * That silence is what hid {@link textureAssetPath}'s bug for as long as module windows have
   * existed, so the two ship together.
   */
  onTextureProblem?: ((problem: TextureProblem) => void) | undefined;
  /** `spellName`, `itemName` and `loc` for the expression evaluator. */
  helpers?: ExpressionHelpers | undefined;
  /** The viewport the window opens in, when the caller knows it: the root anchor needs a box. */
  viewport?: { readonly width: number; readonly height: number } | undefined;
  /** Told when the player presses the window's own close button. */
  onClose?: ((id: string) => void) | undefined;
}

/** One picture a window asked for and did not get. */
export interface TextureProblem {
  /** Which module's file named it; empty for a window rendered outside the loader. */
  readonly module: string;
  /** Which window in that file. */
  readonly windowId: string;
  /** The path as the definition writes it, before {@link textureAssetPath} has had it. */
  readonly path: string;
  /** The address that was actually asked for, so the sentence can be pasted into a browser. */
  readonly url: string;
  /** What the gateway answered, or 0 when the request got no answer at all. */
  readonly status: number;
}

/** What one binding pass cost, for the diagnostics tab and for the budget test. */
export interface WindowUpdateStats {
  /** How many expressions were evaluated. */
  evaluated: number;
  /** How many of them had moved since the last pass and were written to the DOM. */
  changed: number;
}

export interface LiveWindow extends RegisteredWindow {
  /** The `<section class="game-window">` the panel built. */
  readonly element: HTMLElement;
  /** The window's own state: `params.state`, plus whatever its inputs publish. */
  readonly state: Record<string, unknown>;
  /** The last pass's counters, so the diagnostics tab can print what a frame costs. */
  readonly stats: WindowUpdateStats;
  /** How many times a widget of this window asked for its actions to run, and how many ran. */
  readonly actionPresses: { asked: number; ran: number };
}

/* ---------------------------------------------------------------------------------------------
 * WoW geometry
 * ------------------------------------------------------------------------------------------- */

/** How far along a box's width each anchor point sits. */
const ANCHOR_X: Readonly<Record<AnchorPoint, number>> = {
  TOPLEFT: 0, LEFT: 0, BOTTOMLEFT: 0,
  TOP: 0.5, CENTER: 0.5, BOTTOM: 0.5,
  TOPRIGHT: 1, RIGHT: 1, BOTTOMRIGHT: 1,
};

/** How far *down* a box each anchor point sits — already in CSS's direction. */
const ANCHOR_Y: Readonly<Record<AnchorPoint, number>> = {
  TOPLEFT: 0, TOP: 0, TOPRIGHT: 0,
  LEFT: 0.5, CENTER: 0.5, RIGHT: 0.5,
  BOTTOMLEFT: 1, BOTTOM: 1, BOTTOMRIGHT: 1,
};

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One `SetPoint` turned into a CSS box inside the parent.
 *
 * `relativeTo` is either the parent's own box or an earlier sibling's — the schema has already
 * refused anything else, so there is no lookup that can fail here. The whole y flip is the `- y`
 * on the third line: WoW's y grows upward, CSS's `top` grows downward, and `y: -24` therefore
 * means twenty-four pixels *down* from the anchor.
 */
export function anchorBox(anchor: Anchor, size: { width: number; height: number }, relative: Box): Box {
  const left = relative.left + ANCHOR_X[anchor.relativePoint] * relative.width
    + anchor.x - ANCHOR_X[anchor.point] * size.width;
  const top = relative.top + ANCHOR_Y[anchor.relativePoint] * relative.height
    - anchor.y - ANCHOR_Y[anchor.point] * size.height;
  return { left, top, width: size.width, height: size.height };
}

/**
 * The eight stratas laid into the eight z-index steps between the chat log and the windows.
 *
 * The chat log sits at 20 and `GameWindowManager` starts raising windows at 30 (`GameWindows.ts:4`),
 * so 22–29 is the whole of the room there is: a module window is always above the chat and always
 * below a built-in window the player has just clicked. That is deliberate rather than a shortage of
 * numbers — the manager raises whatever is clicked to a number above every band, so the strata
 * decides the order of windows *nobody has touched yet*, and one click makes the player's choice
 * win. Handing a module a band above the manager's counter would let a definition file put itself
 * permanently over the game menu.
 */
const STRATA_Z: Readonly<Record<StrataName, number>> = {
  BACKGROUND: 22, LOW: 23, MEDIUM: 24, HIGH: 25,
  DIALOG: 26, FULLSCREEN: 27, FULLSCREEN_DIALOG: 28, TOOLTIP: 29,
};

/** Where the element id a window remembers its place under comes from. */
export function windowElementId(module: string, id: string): string {
  const safe = (text: string): string => text.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "x";
  return `module-window-${safe(module)}-${safe(id)}`;
}

const rgba = (color: Rgba): string =>
  `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${color[3]})`;

const FONT_BY_NAME = new Map(FONT_OBJECTS.map((font) => [font.name, font]));

/* ---------------------------------------------------------------------------------------------
 * The bound-value bookkeeping
 * ------------------------------------------------------------------------------------------- */

/**
 * "Nothing has been written yet", told apart from every value an expression can produce.
 *
 * `undefined` will not do: an unknown path evaluates to `undefined`, and a label bound to one has
 * to be cleared on the first pass rather than left holding whatever the markup started with.
 */
const UNSET = Symbol("unset");

interface Bound {
  readonly expr: ExprNode;
  readonly apply: (value: unknown) => void;
  last: unknown;
}

/**
 * "This fold has never been written", told apart from every fold {@link applyConditions} can make.
 *
 * Every real fold carries two `|` separators, so an empty string cannot collide with one. It is
 * both the starting value and what {@link updateRepeat} writes back when a row's liveness changes
 * under a fold that would otherwise decline to look again.
 */
const UNAPPLIED = "";

interface ConditionState {
  readonly list: readonly ParsedCondition[];
  /**
   * What the widget looks like with no condition firing: the base every pass starts from.
   *
   * Read off the element the body actually built rather than from the schema's defaults, and that
   * is the difference between a red label staying red and turning beige the first time any
   * condition on it is asked. `applyFont` writes a Text's own colour into `style.color` at build
   * time and a Texture writes its tint into `style.opacity`; a base of `""`/`1` would be written
   * straight over both on the first pass — and by *any* condition, `show` and `hide` included,
   * because the fold that decides whether to write at all carries all three values together.
   */
  readonly baseHidden: boolean;
  readonly baseAlpha: number;
  readonly baseColor: string;
  /**
   * Whether the conditions decide this node's visibility at all.
   *
   * False for the root frame, and that is the whole reason the flag exists: a window's `hidden` is
   * the *player's* — they opened it, or pressed Escape, or clicked the close button — so a root
   * with a `color` condition and no `show`/`hide` one must not be re-opened sixty times a second
   * by a base that says "visible". A `show`/`hide` condition on the root still wins when it fires;
   * silence leaves the window where the player put it.
   */
  readonly ownsVisibility: boolean;
  /** The last fold that was written, as one comparable string. */
  applied: string;
}

interface RepeatState {
  readonly over: ExprNode;
  readonly as: string;
  readonly limit: number;
  readonly build: () => RenderNode;
  readonly instances: RenderNode[];
}

/**
 * One row's loop variable, as the subtree built for that row sees it.
 *
 * It exists because a row template is built once and read twice, in two different ways:
 *
 * * {@link noteRoots} skips a name that is a loop variable — `{item.name}` inside
 *   `repeat over {raid} as item` reads the row, not a published root called `item`.
 * * {@link bindAction} folds the chain into the scope a press runs against, which is the only way
 *   an action on a repeated widget can know which row it is on. See {@link WindowActionContext.row}.
 *
 * `value` is rewritten by {@link updateRepeat} on every pass, so a press reads exactly the row the
 * last frame drew this widget from.
 */
interface RepeatRow {
  readonly as: string;
  value: unknown;
  /** The enclosing row, for a `repeat` inside a `repeat`. */
  readonly outer: RepeatRow | undefined;
}

interface RenderNode {
  readonly element: HTMLElement;
  readonly bindings: Bound[];
  readonly conditions: ConditionState | undefined;
  readonly children: RenderNode[];
  readonly repeat: RepeatState | undefined;
  /** The row this node is a copy for, when it is one of a `repeat`'s instances or under one. */
  readonly row: RepeatRow | undefined;
  /** The `hidden` the file asked for, which a repeat row has to fall back to when it comes back. */
  readonly baseHidden: boolean;
  /**
   * Whether the list a `repeat` walks currently reaches this row. Always true for everything else.
   *
   * Liveness and a `hide` condition are two different questions written on the same `hidden`, and
   * this is the field that keeps them apart: {@link updateRepeat} owns liveness, the conditions own
   * the rest, and a change in either has to make the other look again.
   */
  live: boolean;
}

/* ---------------------------------------------------------------------------------------------
 * Building
 * ------------------------------------------------------------------------------------------- */

interface BuildContext {
  readonly module: string;
  readonly windowId: string;
  readonly host: WindowRenderHost;
  readonly helpers: ExpressionHelpers;
  readonly state: Record<string, unknown>;
  readonly presses: { asked: number; ran: number };
  /**
   * Which roots of the published view this window's update pass will read.
   *
   * Filled here rather than derived from the definition, and that is the safety property: every
   * expression the pass evaluates goes through {@link noteRoots} on its way into a `Bound`, a
   * condition or a `repeat`, so a field added to a widget type cannot be bound without its root
   * being registered. Getting this wrong the other way — a root nobody declares — would leave a
   * binding reading `undefined` for ever, with nothing on screen to say why.
   *
   * Action lists are deliberately not counted: they run on a press rather than on a frame, and
   * `WindowActions` builds a whole snapshot for one.
   *
   * Collected while the window is *built*, which is what {@link buildRepeat} builds its first row
   * for: everything a window will ever evaluate has to be known by the time `renderWindow` returns,
   * because `WindowRegistry` unions the sets when the window is registered.
   */
  readonly roots: Set<string>;
  /** The `repeat` row this subtree is a copy for, when it is inside one. */
  readonly row: RepeatRow | undefined;
  /** A patch subtree's slot, published to every press under it. Absent inside a window. */
  readonly slot?: Readonly<Record<string, unknown>> | undefined;
  /**
   * The subtree's own root element, filled in once it exists.
   *
   * A box rather than the element, because {@link bindAction} runs while the tree is still being
   * built and the root is what `buildNode` is in the middle of returning.
   */
  readonly rootRef?: { element: HTMLElement | undefined } | undefined;
}

/** Registers the roots one expression reads, so the snapshot builder knows to assemble them. */
function noteRoots(context: BuildContext, expr: ExprNode): void {
  for (const root of expressionRoots(expr)) {
    // A loop variable is not a root of the published view. `{item.name}` under
    // `repeat over {raid} as item` reads the row the update pass folds in, so counting `item` here
    // would put a name nothing publishes into the window's declared roots and into the union the
    // snapshot builder is handed.
    if (loopVariable(context.row, root)) continue;
    context.roots.add(root);
  }
}

/** Whether a name is one of the `repeat` variables in scope at this point of the tree. */
function loopVariable(row: RepeatRow | undefined, name: string): boolean {
  for (let entry = row; entry; entry = entry.outer) if (entry.as === name) return true;
  return false;
}

/**
 * The loop variables in scope at one widget, as one object a press can evaluate against.
 *
 * Outermost first, so a nested `repeat` that reuses a name shadows the outer one — the same way
 * round {@link updateRepeat} writes them into the update scope.
 */
function rowScope(row: RepeatRow): Record<string, unknown> {
  const chain: RepeatRow[] = [];
  for (let entry: RepeatRow | undefined = row; entry; entry = entry.outer) chain.unshift(entry);
  const scope: Record<string, unknown> = {};
  for (const entry of chain) scope[entry.as] = entry.value;
  return scope;
}

function makeElement(tag: string, className: string, context: BuildContext, widget: ParsedWidget): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  // Both attributes on every node the renderer makes: `data-module` is what a module's own CSS is
  // scoped by (М6 prefixes every rule with it, so `body { display: none }` in a module stylesheet
  // cannot reach the client), and `data-widget` is how the builder overlay (М8) and a `hide`
  // action find one widget again.
  element.dataset["module"] = context.module;
  element.dataset["widget"] = widget.id;
  return element;
}

function positionElement(element: HTMLElement, box: Box): void {
  element.style.position = "absolute";
  element.style.left = `${box.left}px`;
  element.style.top = `${box.top}px`;
  element.style.width = `${box.width}px`;
  element.style.height = `${box.height}px`;
}

/** A texture path in an `<img>` that fills the box, cropped to the widget's `texCoords`. */
function textureImage(path: string, texCoords: Rgba, context: BuildContext): HTMLElement {
  const image = document.createElement("img");
  image.className = "wnd-texture-image";
  (image as HTMLImageElement).alt = "";
  const [left, right, top, bottom] = texCoords;
  // `texCoords` is (left, right, top, bottom) in 0..1 of the source picture. A crop is the image
  // blown up by 1/width inside a box that hides the rest — the same arithmetic the class-icon
  // atlas already uses (`Frames.ts`), written in percentages so it survives any box size. An empty
  // or inverted rectangle falls back to the whole picture: a widget with `texCoords: [1, 1, 0, 0]`
  // would otherwise divide by zero and take its `<img>` off to infinity.
  const width = right > left ? right - left : 1;
  const height = bottom > top ? bottom - top : 1;
  const originX = right > left ? left : 0;
  const originY = bottom > top ? top : 0;
  image.style.position = "absolute";
  image.style.width = `${100 / width}%`;
  image.style.height = `${100 / height}%`;
  image.style.left = `${(-originX / width) * 100}%`;
  image.style.top = `${(-originY / height) * 100}%`;
  showTexture(image as HTMLImageElement, path, context);
  return image;
}

/**
 * The path a window's picture is actually asked for by: WoW spells them without an extension.
 *
 * A window definition writes what Lua writes — `Interface\DialogFrame\UI-DialogBox-Background` —
 * because that is what the game's own interface code says and what the studio's picker offers.
 * `/texture` wants a file, and `validAssetPath(value, {extensions:["blp"]})` refuses a name with
 * no extension, so every such request was a 400. Measured on the live gateway: all thirteen
 * non-empty file strings in `BACKDROP_PRESETS` answer 400 as written and 200 with `.blp` appended
 * (100 B to 216,915 B) — no module window has ever had a background, and the owner's own
 * `proverochnyy-ekran.json` asks for `Interface\CharacterFrame\TemporaryPortrait` the same way.
 *
 * Normalising here rather than in the route is deliberate and it is an ordering, not a taste. The
 * generator behind `/texture` carried its own narrower path class until this same slice, so
 * relaxing the route first would have turned each of those 400s into a 500 with three retries
 * behind it. This is the renderer's one choke point for a picture — both backdrop images and every
 * author-written `Texture` come through here — and it leaves the gateway's validator strict.
 *
 * Only a *last segment* with no dot is completed: `…\Foo.blp` is left alone, so is `…\Foo.tga`,
 * and so is a directory with a dot in it (`Interface\Icons.old\Foo` gets `.blp` on `Foo`).
 */
export function textureAssetPath(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const name = path.slice(cut + 1);
  return name === "" || name.includes(".") ? path : `${path}.blp`;
}

/**
 * Points one `<img>` at a texture path, or takes it off screen when there is no path.
 *
 * The empty case is not `setIconSource`'s to catch: it short-circuits on a falsy *URL*, and
 * `textureUrl("")` is `…/texture?path=` — a real address, a real request and a real 4xx. Worse, a
 * failed fetch only fires `error`, so `src` keeps whatever picture was there before: a texture
 * bound to `{icon(target.displayId)}` would go on showing the last target's icon after the player
 * cleared their target. Hidden rather than blanked, because an `<img>` with no source draws the
 * browser's broken-image mark.
 *
 * The path the problem names is the one the *author wrote*, not the completed one: they have a
 * file to go and look at, and «`…\TemporaryPortrait.blp` is a 404» would send them looking for a
 * name their file does not contain.
 */
function showTexture(image: HTMLImageElement, path: string, context: BuildContext): void {
  image.hidden = path === "";
  if (path === "") return;
  const url = context.host.textureUrl?.(textureAssetPath(path)) ?? "";
  setIconSource(image, url, (status) => {
    context.host.onTextureProblem?.({
      module: context.module, windowId: context.windowId, path, url, status,
    });
  });
}

function applyFont(element: HTMLElement, fontName: string, size: number, color: Rgba | undefined): void {
  const font = FONT_BY_NAME.get(fontName);
  element.dataset["font"] = fontName;
  const points = size > 0 ? size : font?.size ?? 12;
  element.style.fontSize = `${points}px`;
  if (color) element.style.color = rgba(color);
  else if (font) element.style.color = rgba([font.color[0], font.color[1], font.color[2], 1]);
}

const JUSTIFY_H: Readonly<Record<string, string>> = { LEFT: "flex-start", CENTER: "center", RIGHT: "flex-end" };
const JUSTIFY_V: Readonly<Record<string, string>> = { TOP: "flex-start", MIDDLE: "center", BOTTOM: "flex-end" };

/** The layer a widget draws in. Only a Texture names one; everything else is a control. */
function layerOf(widget: ParsedWidget): LayerName {
  return widget.type === "Texture" ? widget.layer : "ARTWORK";
}

function runWidgetActions(
  actions: readonly WindowAction[],
  widget: ParsedWidget,
  context: BuildContext,
): void {
  if (actions.length === 0) return;
  context.presses.asked++;
  const run = context.host.runActions;
  if (!run) return;
  run(actions, {
    window: context.windowId, module: context.module, widget: widget.id, state: context.state,
    // The row the widget was drawn from, read *now* rather than at build time: the same instance
    // is reused as the list under it moves, and the press means the row that is on screen.
    row: context.row ? rowScope(context.row) : undefined,
    slot: context.slot,
    root: context.rootRef?.element,
  });
  context.presses.ran++;
}

function bindAction(
  element: HTMLElement,
  event: string,
  actions: readonly WindowAction[],
  widget: ParsedWidget,
  context: BuildContext,
): void {
  if (actions.length === 0) return;
  element.addEventListener(event, () => {
    runWidgetActions(actions, widget, context);
  });
}

/**
 * Builds one widget and everything under it.
 *
 * `box` is where it goes, already resolved against its parent or its earlier sibling by
 * {@link buildSiblings} — the only two things a `relativeTo` may name, and the schema has already
 * refused anything else, so nothing here can fail to place a widget.
 */
function buildNode(widget: ParsedWidget, box: Box, context: BuildContext): RenderNode {
  const bindings: Bound[] = [];
  const element = buildBody(widget, context, bindings);
  positionElement(element, box);
  // Split rather than assigned: `classList.add` throws on a name with a space in it, and
  // `"shop-row important"` is exactly what an author writes when they mean two classes.
  for (const name of (widget.className ?? "").split(/\s+/)) if (name) element.classList.add(name);
  if (widget.slot) element.dataset["slot"] = widget.slot;
  element.dataset["layer"] = layerOf(widget);
  if (widget.alpha !== 1) element.style.opacity = String(widget.alpha);
  element.hidden = widget.hidden;

  const children = widget.type === "Frame" || widget.type === "ScrollFrame"
    ? buildChildren(widget, element, context)
    : [];

  for (const condition of widget.conditions) noteRoots(context, condition.test);
  const node: RenderNode = {
    element,
    bindings,
    conditions: widget.conditions.length === 0 ? undefined : {
      list: widget.conditions,
      baseHidden: widget.hidden,
      baseAlpha: builtAlpha(element, widget.alpha),
      baseColor: element.style.color ?? "",
      ownsVisibility: true,
      applied: UNAPPLIED,
    },
    children,
    repeat: undefined,
    row: context.row,
    baseHidden: widget.hidden,
    live: true,
  };
  return node;
}

/**
 * The opacity the widget was built with, or its own `alpha` when nothing wrote one.
 *
 * `style.opacity` is a string, and the two empty answers are different in the two documents this
 * code runs in: a browser gives `""` for a property nobody set and the test's document gives
 * `undefined`. Both are falsy and both mean "the widget kept its own alpha"; `Number("")` is 0,
 * which would make every conditioned widget invisible, so the falsy check has to come first.
 */
function builtAlpha(element: HTMLElement, fallback: number): number {
  const written = element.style.opacity;
  const parsed = written ? Number(written) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A widget that carries `repeat`, as a container plus up to `limit` copies of the subtree.
 *
 * The copies are built as the list grows and kept when it shrinks — hidden, not thrown away —
 * because a list that oscillates between three and four rows would otherwise rebuild a subtree
 * every other frame, which is the whole thing this renderer exists not to do. The instances stack
 * downward by the template's own height, which is what a list of rows is; a `repeat` on a widget
 * that wants a different arrangement is what a `Frame` with its own children is for.
 */
function buildRepeat(
  widget: ParsedWidget,
  box: Box,
  context: BuildContext,
  repeat: NonNullable<ParsedWidget["repeat"]>,
): RenderNode {
  const container = document.createElement("div");
  container.className = "wnd-repeat";
  container.dataset["module"] = context.module;
  container.dataset["widget"] = widget.id;
  positionElement(container, box);
  // The rows below the first hang out of the container's own height on purpose: the box the
  // definition gives is one row, and a list of eight is eight of them.
  container.style.overflow = "visible";

  noteRoots(context, repeat.over);
  const instances: RenderNode[] = [];
  const build = (): RenderNode => {
    const index = instances.length;
    // Each row gets its own loop-variable holder, chained to whatever `repeat` encloses this one.
    const row: RepeatRow = { as: repeat.as, value: undefined, outer: context.row };
    const inner: BuildContext = { ...context, row };
    const node = buildNode(widget, { left: 0, top: index * box.height, width: box.width, height: box.height }, inner);
    // Built dead. The row is shown by the same liveness transition every later row goes through,
    // so a template that also carries a `hide` condition is asked once before it is ever seen.
    node.live = false;
    node.element.hidden = true;
    container.append(node.element);
    return node;
  };
  // The first row is built now rather than on the first pass that finds something to put in it, and
  // that is not a head start: a template's expressions register their roots as they are bound, and
  // `WindowRegistry` unions a window's roots when it is *registered*. A row built later added its
  // roots to a set the snapshot builder had already been given, so a label reading
  // `{aura[0].name}` inside a `repeat` — and every other gated root — stayed blank for the rest of
  // the session, with the supplier never called and nothing on screen to say why. It costs one
  // hidden subtree per `repeat` on a window nobody has data for yet.
  instances.push(build());
  return {
    element: container,
    bindings: [],
    conditions: undefined,
    children: [],
    repeat: { over: repeat.over, as: repeat.as, limit: repeat.limit, build, instances },
    row: context.row,
    baseHidden: false,
    live: true,
  };
}

function buildChildren(widget: ParsedWidget, host: HTMLElement, context: BuildContext): RenderNode[] {
  const surface = widget.type === "ScrollFrame" ? (host.children[0] as HTMLElement | undefined) ?? host : host;
  const inner = widget.type === "ScrollFrame"
    ? { width: widget.width, height: widget.contentHeight }
    : { width: widget.width, height: widget.height };
  return buildSiblings(widget.children, surface, inner, context);
}

/**
 * One row of siblings: laid out in declaration order, inserted in layer order.
 *
 * The two orders are different on purpose. An anchor may name an *earlier sibling*, so the boxes
 * have to be computed in the order the file declares them; what covers what is the `layer`, so the
 * nodes are appended sorted by it. Sorting the boxes instead would change which anchors resolve,
 * and appending in declaration order would put a `BACKGROUND` texture over the text on top of it.
 */
function buildSiblings(
  widgets: readonly ParsedWidget[],
  host: HTMLElement,
  parentSize: { width: number; height: number },
  context: BuildContext,
): RenderNode[] {
  const boxes = new Map<string, Box>();
  const parentBox: Box = { left: 0, top: 0, width: parentSize.width, height: parentSize.height };
  const built: { node: RenderNode; layer: number; order: number }[] = [];
  for (const [order, widget] of widgets.entries()) {
    const relative = widget.anchor.relativeTo === "parent"
      ? parentBox
      : boxes.get(widget.anchor.relativeTo) ?? parentBox;
    const box = anchorBox(widget.anchor, { width: widget.width, height: widget.height }, relative);
    boxes.set(widget.id, box);
    const node = widget.repeat
      ? buildRepeat(widget, box, context, widget.repeat)
      : buildNode(widget, box, context);
    built.push({ node, layer: LAYERS.indexOf(layerOf(widget)), order });
  }
  const ordered = [...built].sort((left, right) => left.layer - right.layer || left.order - right.order);
  for (const entry of ordered) host.append(entry.node.element);
  // Kept in declaration order for the update walk: the pass reads no sibling of its own, and
  // declaration order is what a problem message names.
  return built.map((entry) => entry.node);
}

/* ---------------------------------------------------------------------------------------------
 * The twelve widget types
 * ------------------------------------------------------------------------------------------- */

function buildBody(widget: ParsedWidget, context: BuildContext, bindings: Bound[]): HTMLElement {
  const bind = (expr: ExprNode, apply: (value: unknown) => void): void => {
    noteRoots(context, expr);
    bindings.push({ expr, apply, last: UNSET });
  };

  switch (widget.type) {
    case "Frame": {
      const element = makeElement("div", "wnd-frame", context, widget);
      element.dataset["backdrop"] = widget.backdrop.name;
      if (widget.backdrop.bgFile) {
        const backdrop = textureImage(widget.backdrop.bgFile, [0, 1, 0, 1], context);
        backdrop.className = "wnd-backdrop";
        const inset = widget.backdrop.insets;
        // WoW's backdrop insets pull the *background* in from the frame's edge and leave the
        // border art in the margin they free; they do not move the frame's children. Written as
        // `inset` so the same four numbers mean the same thing here as in `SetBackdrop`.
        backdrop.style.left = `${inset.left}px`;
        backdrop.style.top = `${inset.top}px`;
        backdrop.style.width = `calc(100% - ${inset.left + inset.right}px)`;
        backdrop.style.height = `calc(100% - ${inset.top + inset.bottom}px)`;
        element.append(backdrop);
      }
      element.style.backgroundColor = rgba([
        widget.backdropColor[0], widget.backdropColor[1], widget.backdropColor[2],
        widget.backdrop.bgFile ? 0 : widget.backdropColor[3] * 0.35,
      ]);
      if (widget.backdrop.edgeSize > 0) {
        // The edge is a colour, not a nine-slice of `edgeFile`. Slicing a BLP border into nine
        // pieces is real work with no visible payoff until М8 lets an author see it; the colour
        // keeps a frame's outline where the definition says it is and says so here rather than
        // pretending the art is drawn.
        element.style.border = `1px solid ${rgba(widget.borderColor)}`;
      }
      if (widget.mouse) element.dataset["mouse"] = "true";
      if (widget.movable) element.dataset["movable"] = "true";
      return element;
    }

    case "Texture": {
      const element = makeElement("div", "wnd-texture", context, widget);
      element.style.overflow = "hidden";
      const path = staticText(widget.texture);
      if (widget.solid) {
        // `solid` is the studio's «залить цветом»: the colour is the picture, and there is no file.
        element.style.backgroundColor = rgba(widget.color);
        return element;
      }
      // A texture with no path at all stays an empty box rather than a white one: the colour on a
      // Texture tints its picture, and a widget whose picture has not been chosen yet must not
      // paint a white rectangle over what is behind it.
      if (path === "") return element;
      element.style.opacity = String(widget.color[3]);
      if (path !== undefined) {
        element.append(textureImage(path, widget.texCoords, context));
        return element;
      }
      // The path is an expression — `{icon(target.displayId)}` and the like — so the image is
      // built once and re-pointed whenever the value moves.
      const image = textureImage("", widget.texCoords, context);
      element.append(image);
      bind(widget.texture, (value) => {
        showTexture(image as HTMLImageElement, formatExpressionValue(value), context);
      });
      return element;
    }

    case "Text": {
      const element = makeElement("div", "wnd-text", context, widget);
      applyFont(element, widget.font, widget.size, widget.color);
      element.style.display = "flex";
      element.style.justifyContent = JUSTIFY_H[widget.justifyH] ?? "center";
      element.style.alignItems = JUSTIFY_V[widget.justifyV] ?? "center";
      element.style.whiteSpace = widget.wrap ? "normal" : "nowrap";
      if (widget.outline) element.dataset["outline"] = widget.outline;
      if (!widget.shadow) element.dataset["shadow"] = "off";
      bind(widget.text, (value) => { element.textContent = formatExpressionValue(value); });
      return element;
    }

    case "Button": {
      const element = makeElement("button", "wnd-button", context, widget) as HTMLButtonElement;
      element.type = "button";
      element.dataset["template"] = widget.template;
      bind(widget.text, (value) => { element.textContent = formatExpressionValue(value); });
      bind(widget.enabled, (value) => { element.disabled = !value; });
      let tooltip = "";
      bind(widget.tooltip, (value) => { tooltip = formatExpressionValue(value); });
      attachTooltip(element, () => (tooltip ? { title: tooltip } : undefined));
      bindAction(element, "click", widget.actions, widget, context);
      return element;
    }

    case "CheckButton": {
      const element = makeElement("label", "wnd-check", context, widget);
      const input = document.createElement("input");
      (input as HTMLInputElement).type = "checkbox";
      const label = document.createElement("span");
      applyFont(label, widget.font, 0, undefined);
      element.append(input, label);
      bind(widget.text, (value) => { label.textContent = formatExpressionValue(value); });
      bind(widget.checked, (value) => {
        (input as HTMLInputElement).checked = Boolean(value);
        // Seeded here, exactly as the EditBox, the Slider and the DropDown seed theirs. Without it
        // `{state.<key>}` reads `undefined` until the player clicks the box, so a label beside a
        // box that starts checked would read empty while the box beside it reads on.
        context.state[widget.state] = Boolean(value);
      });
      input.addEventListener("change", () => {
        context.state[widget.state] = (input as HTMLInputElement).checked;
      });
      bindAction(input, "change", widget.onChange, widget, context);
      return element;
    }

    case "EditBox": {
      const element = makeElement("div", "wnd-edit", context, widget);
      const input = document.createElement(widget.multiline ? "textarea" : "input");
      if (!widget.multiline) (input as HTMLInputElement).type = widget.numeric ? "number" : "text";
      if (widget.maxLetters > 0) (input as HTMLInputElement).maxLength = widget.maxLetters;
      applyFont(input, widget.font, 0, undefined);
      element.append(input);
      let dirty = false;
      // The `text` expression seeds the box and then stops writing to it. A binding that kept
      // writing would delete what the player is typing on the first frame the value moved, and an
      // input that fights its own player is worse than one that has to be reopened to reset.
      bind(widget.text, (value) => {
        if (dirty) return;
        (input as HTMLInputElement).value = formatExpressionValue(value);
        context.state[widget.state] = readInput(input as HTMLInputElement, widget.numeric);
      });
      input.addEventListener("input", () => {
        dirty = true;
        context.state[widget.state] = readInput(input as HTMLInputElement, widget.numeric);
      });
      // `change` also fires when a changed field loses focus. Only an explicit Enter runs onEnter;
      // a multiline box without onEnter keeps the browser's normal newline behavior.
      if (widget.onEnter.length > 0) {
        input.addEventListener("keydown", (event) => {
          const key = event as KeyboardEvent;
          if (key.key !== "Enter" || key.isComposing) return;
          event.preventDefault();
          if (key.repeat) return;
          runWidgetActions(widget.onEnter, widget, context);
        });
      }
      return element;
    }

    case "StatusBar": {
      const element = makeElement("div", "wnd-bar", context, widget);
      const bar = new Bar({ text: widget.showText });
      bar.root.style.setProperty("--ui-bar-color", rgba(widget.color));
      bar.root.style.setProperty("--ui-bar-background", rgba(widget.background));
      applyFont(bar.root, widget.font, 0, undefined);
      element.append(bar.root);
      // The bar takes all three at once, so each of the three bindings updates its own slot here
      // and then redraws. That is still one write per changed value: `Bar.set` writes a width and
      // a string, and both are cheap next to evaluating the expression that produced them.
      const current: { value: number | undefined; max: number | undefined; caption: string | undefined } =
        { value: undefined, max: undefined, caption: undefined };
      const redraw = (): void => { bar.set(current.value, current.max, current.caption); };
      bind(widget.value, (value) => { current.value = numberOrUndefined(value); redraw(); });
      bind(widget.max, (value) => { current.max = numberOrUndefined(value); redraw(); });
      bind(widget.caption, (value) => {
        const text = formatExpressionValue(value);
        current.caption = text === "" ? undefined : text;
        redraw();
      });
      return element;
    }

    case "Slider": {
      const element = makeElement("div", "wnd-slider", context, widget);
      const label = document.createElement("span");
      const input = document.createElement("input");
      (input as HTMLInputElement).type = "range";
      (input as HTMLInputElement).min = String(widget.min);
      (input as HTMLInputElement).max = String(widget.max);
      (input as HTMLInputElement).step = String(widget.step);
      const readout = document.createElement("em");
      readout.hidden = !widget.showValue;
      element.append(label, input, readout);
      bind(widget.label, (value) => { label.textContent = formatExpressionValue(value); });
      bind(widget.value, (value) => {
        const number = numberOrUndefined(value) ?? widget.min;
        (input as HTMLInputElement).value = String(number);
        readout.textContent = String(number);
        context.state[widget.state] = number;
      });
      input.addEventListener("input", () => {
        const number = Number((input as HTMLInputElement).value);
        context.state[widget.state] = Number.isFinite(number) ? number : widget.min;
        readout.textContent = (input as HTMLInputElement).value;
      });
      bindAction(input, "change", widget.onChange, widget, context);
      return element;
    }

    case "ScrollFrame": {
      const element = makeElement("div", "wnd-scroll", context, widget);
      element.style.overflow = "auto";
      const content = document.createElement("div");
      content.className = "wnd-scroll-content";
      content.style.position = "relative";
      content.style.width = `${widget.width}px`;
      content.style.height = `${widget.contentHeight}px`;
      element.append(content);
      return element;
    }

    case "ItemButton": {
      // The kit's `SlotGrid` draws exactly this cell, and it is not used here for one reason:
      // `SlotGrid.render` replaces its children wholesale, which is right for a bag the server
      // resends and wrong for a slot whose count changes every second. The markup and the classes
      // are its own, so one stylesheet rule still covers both.
      const element = makeElement("button", "ui-slot wnd-item", context, widget) as HTMLButtonElement;
      element.type = "button";
      const icon = document.createElement("img");
      (icon as HTMLImageElement).alt = "";
      const count = document.createElement("em");
      count.className = "ui-slot-count";
      element.append(icon, count);
      bind(widget.icon, (value) => {
        const source = iconSource(value);
        icon.hidden = source === "";
        setIconSource(icon as HTMLImageElement, source);
      });
      bind(widget.count, (value) => {
        // `stackLabel`, not `String`: `.ui-slot-count` is a .66 rem badge pinned to the corner of a
        // slot, and it is sized for the «20k» the bags write there — five figures spill out of it.
        // The markup is `SlotGrid`'s, so the number in it has to be written `SlotGrid`'s way too.
        count.textContent = stackLabel(numberOrUndefined(value) ?? 0);
      });
      let itemId = 0;
      let spellId = 0;
      bind(widget.itemId, (value) => { itemId = numberOrUndefined(value) ?? 0; element.dataset["item"] = String(itemId); });
      bind(widget.spellId, (value) => { spellId = numberOrUndefined(value) ?? 0; element.dataset["spell"] = String(spellId); });
      if (widget.tooltip) {
        attachTooltip(element, () => {
          const name = itemId > 0
            ? context.helpers.itemName?.(itemId)
            : spellId > 0 ? context.helpers.spellName?.(spellId) : undefined;
          if (name) return { title: name };
          if (itemId > 0) return { title: `Предмет ${itemId}` };
          return spellId > 0 ? { title: `Заклинание ${spellId}` } : undefined;
        });
      }
      bindAction(element, "click", widget.actions, widget, context);
      return element;
    }

    case "DropDown": {
      const element = makeElement("div", "wnd-dropdown", context, widget);
      const label = document.createElement("span");
      const select = document.createElement("select");
      element.append(label, select);
      bind(widget.label, (value) => { label.textContent = formatExpressionValue(value); });
      bind(widget.options, (value) => {
        select.replaceChildren(...optionList(value).map((text, index) => {
          const option = document.createElement("option");
          option.value = String(index + 1);
          option.textContent = text;
          return option;
        }));
      });
      bind(widget.selected, (value) => {
        const number = numberOrUndefined(value) ?? 1;
        (select as HTMLSelectElement).value = String(number);
        context.state[widget.state] = number;
      });
      select.addEventListener("change", () => {
        const number = Number((select as HTMLSelectElement).value);
        context.state[widget.state] = Number.isFinite(number) ? number : 1;
      });
      bindAction(select, "change", widget.onChange, widget, context);
      return element;
    }

    case "Model": {
      // A placeholder, and it says which model it stands for rather than being an empty box: the
      // author has to be able to tell "the portrait is not drawn yet" from "my `unit` is wrong".
      // The 3D view belongs to a slice of its own; nothing here pretends otherwise.
      const element = makeElement("div", "wnd-model", context, widget);
      element.dataset["unit"] = widget.unit;
      const caption = document.createElement("span");
      element.append(caption);
      bind(widget.creature, (value) => {
        const creature = numberOrUndefined(value) ?? 0;
        caption.textContent = creature > 0
          ? `Модель существа ${creature} (3D-портрет ещё не рисуется)`
          : `Модель: ${MODEL_UNIT_LABELS[widget.unit] ?? widget.unit} (3D-портрет ещё не рисуется)`;
      });
      return element;
    }
  }
}

const MODEL_UNIT_LABELS: Readonly<Record<string, string>> = {
  player: "игрок", target: "цель", focus: "фокус", pet: "питомец", none: "нет юнита",
};

function readInput(input: HTMLInputElement, numeric: boolean): string | number {
  if (!numeric) return input.value;
  const number = Number(input.value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A picture for an `ItemButton`: a path the icon table already resolved, or an icon id. */
function iconSource(value: unknown): string {
  if (typeof value === "string") return value;
  const number = numberOrUndefined(value);
  return number !== undefined && number > 0 ? `/icons/${Math.floor(number)}.png` : "";
}

/** The studio writes a drop-down's choices as one newline-separated string; a list is М6's. */
function optionList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => formatExpressionValue(entry));
  const text = formatExpressionValue(value);
  return text === "" ? [] : text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** The text of an expression that is a plain string, or `undefined` when it is not one. */
function staticText(expr: ExprNode): string | undefined {
  return expr.node === "string" ? expr.value : undefined;
}

/* ---------------------------------------------------------------------------------------------
 * Updating
 * ------------------------------------------------------------------------------------------- */

function applyConditions(node: RenderNode, scope: ExpressionScope, helpers: ExpressionHelpers, stats: WindowUpdateStats): void {
  const state = node.conditions;
  if (!state) return;
  let hidden: boolean | undefined = state.ownsVisibility ? state.baseHidden : undefined;
  let alpha = state.baseAlpha;
  let color = state.baseColor;
  for (const condition of state.list) {
    stats.evaluated++;
    if (!evaluate(condition.test, scope, helpers)) continue;
    // Order is the file's. A widget with `show` then `hide` on two conditions that both hold is
    // hidden, and one written the other way round is shown — the author reads their own list top
    // to bottom and so does this.
    if (condition.then === "show") hidden = false;
    else if (condition.then === "hide") hidden = true;
    else if (condition.then === "color" && condition.color) color = rgba(condition.color);
    else if (condition.then === "alpha" && condition.alpha !== undefined) alpha = condition.alpha;
  }
  const fold = `${hidden === undefined ? "-" : hidden ? 1 : 0}|${alpha}|${color}`;
  if (fold === state.applied) return;
  state.applied = fold;
  if (hidden !== undefined) node.element.hidden = hidden;
  node.element.style.opacity = String(alpha);
  // Cleared rather than left behind: a colour condition that stops holding has to give the widget
  // its own colour back, and `style.color = ""` is how the stylesheet takes it over again.
  node.element.style.color = color;
  stats.changed++;
}

function updateNode(node: RenderNode, scope: ExpressionScope, helpers: ExpressionHelpers, stats: WindowUpdateStats): void {
  applyConditions(node, scope, helpers, stats);
  for (const bound of node.bindings) {
    const value = evaluate(bound.expr, scope, helpers);
    stats.evaluated++;
    if (Object.is(value, bound.last)) continue;
    bound.last = value;
    bound.apply(value);
    stats.changed++;
  }
  const repeat = node.repeat;
  if (repeat) {
    updateRepeat(repeat, scope, helpers, stats);
    return;
  }
  for (const child of node.children) updateNode(child, scope, helpers, stats);
}

function updateRepeat(repeat: RepeatState, scope: ExpressionScope, helpers: ExpressionHelpers, stats: WindowUpdateStats): void {
  stats.evaluated++;
  const list = evaluate(repeat.over, scope, helpers);
  const items: readonly unknown[] = Array.isArray(list) ? list : [];
  const wanted = Math.min(items.length, repeat.limit);
  while (repeat.instances.length < wanted) repeat.instances.push(repeat.build());
  // One scope for the whole row rather than one per instance: evaluation is synchronous, so the
  // element under `as` can be replaced between instances and nothing can observe the reuse.
  const inner: Record<string, unknown> = { ...scope };
  for (const [index, instance] of repeat.instances.entries()) {
    const live = index < wanted;
    // Liveness and the row's conditions both decide `hidden`, and the loser used to be whichever
    // wrote first: this line put the row back on screen and `applyConditions` then declined to
    // rewrite, because its own fold had not moved — so a `hide` condition on a repeated widget held
    // for exactly one frame and never again. The fold is invalidated instead, and a live row is
    // left for the conditions to place; a dead one is hidden here, since nothing will update it.
    if (instance.live !== live) {
      instance.live = live;
      if (instance.conditions) instance.conditions.applied = UNAPPLIED;
      if (!live || !instance.conditions) {
        instance.element.hidden = !live || instance.baseHidden;
        stats.changed++;
      }
    }
    if (!live) continue;
    inner[repeat.as] = items[index];
    // The same value on the row's own holder, where a press will look for it: the scope above is
    // gone by the time anybody clicks.
    if (instance.row) instance.row.value = items[index];
    updateNode(instance, inner, helpers, stats);
  }
}

/* ---------------------------------------------------------------------------------------------
 * The window
 * ------------------------------------------------------------------------------------------- */

/**
 * Draws one parsed definition and hands back the live window.
 *
 * The same definition rendered twice gives two identical trees — nothing here reads a clock, a
 * random number or anything about the page — which is what makes М6's hot reload a matter of
 * building the new one and destroying the old.
 */
export function renderWindow(definition: ParsedWindow, host: WindowRenderHost = {}): LiveWindow {
  const screen = definition.screen;
  const helpers = host.helpers ?? {};
  const state: Record<string, unknown> = {};
  const presses = { asked: 0, ran: 0 };
  const roots = new Set<string>();
  const context: BuildContext = {
    module: definition.module, windowId: definition.id, host, helpers, state, presses, roots,
    row: undefined,
  };
  // The window's own starting state, evaluated once against an empty scope: `params.state` is
  // where a definition puts its defaults, and a default that reads the world would be a value
  // from whichever frame the window happened to be built on.
  for (const [key, expr] of Object.entries(definition.state)) state[key] = evaluate(expr, {}, helpers);

  const elementId = windowElementId(definition.module, definition.id);
  const panel = new Panel({
    id: elementId,
    title: "",
    className: "module-window",
    closeButton: screen.closeButton,
    onClose: () => host.onClose?.(definition.id),
  });
  panel.root.dataset["module"] = definition.module;
  panel.root.dataset["window"] = definition.id;
  panel.root.dataset["strata"] = screen.strata;
  panel.root.style.zIndex = String(STRATA_Z[screen.strata]);
  if (screen.titleTexture) panel.root.classList.add("wnd-title-texture");
  if (!screen.movable) panel.root.dataset["movable"] = "false";

  // The window's own place, when the caller knows how big the viewport is. `GameWindowManager`
  // reads the element's rectangle the first time it is shown and cascades from there, so writing
  // the studio's anchor into `left`/`top` here is exactly the seed the manager expects — and from
  // the first drag onward the player's own position is what it remembers.
  const viewport = host.viewport;
  if (viewport) {
    const box = anchorBox(screen.anchor, { width: screen.width, height: screen.height },
      { left: 0, top: 0, width: viewport.width, height: viewport.height });
    panel.root.style.left = `${Math.round(box.left)}px`;
    panel.root.style.top = `${Math.round(box.top)}px`;
    panel.root.style.right = "auto";
    panel.root.style.bottom = "auto";
  }

  const surface = document.createElement("div");
  surface.className = "wnd-root";
  surface.dataset["module"] = definition.module;
  surface.dataset["widget"] = screen.id;
  surface.style.position = "relative";
  surface.style.width = `${screen.width}px`;
  surface.style.height = `${screen.height}px`;
  if (screen.backdrop.bgFile) {
    const backdrop = textureImage(screen.backdrop.bgFile, [0, 1, 0, 1], context);
    backdrop.className = "wnd-backdrop";
    surface.append(backdrop);
  }
  panel.body.append(surface);

  const bindings: Bound[] = [];
  noteRoots(context, screen.title);
  bindings.push({
    expr: screen.title,
    apply: (value) => { panel.title = formatExpressionValue(value) || definition.id; },
    last: UNSET,
  });
  for (const condition of screen.conditions) noteRoots(context, condition.test);
  const children = buildSiblings(screen.children, surface, { width: screen.width, height: screen.height }, context);
  const root: RenderNode = {
    element: panel.root,
    bindings,
    conditions: screen.conditions.length === 0 ? undefined : {
      list: screen.conditions,
      baseHidden: false,
      baseAlpha: builtAlpha(panel.root, screen.alpha),
      baseColor: panel.root.style.color ?? "",
      ownsVisibility: false,
      applied: UNAPPLIED,
    },
    children,
    repeat: undefined,
    row: undefined,
    baseHidden: false,
    live: true,
  };

  const stats: WindowUpdateStats = { evaluated: 0, changed: 0 };
  let destroyed = false;
  /**
   * The snapshot the window was last drawn against.
   *
   * Kept because a window that is opened between two frames has to be drawn *now*: while it was
   * closed the pass skipped everything under the root, so every bound value is one frame stale and
   * the first thing the player sees would be the blanks the window was built with.
   */
  let lastSnapshot: ExpressionScope = {};

  const live: LiveWindow = {
    id: definition.id,
    module: definition.module,
    definition,
    escClose: screen.escClose,
    roots,
    element: panel.root,
    state,
    stats,
    actionPresses: presses,
    visible: () => panel.visible,
    show(): void {
      panel.show();
      this.update(lastSnapshot);
    },
    hide: () => { panel.hide(); },
    update(snapshot: ExpressionScope): void {
      if (destroyed) return;
      lastSnapshot = snapshot;
      stats.evaluated = 0;
      stats.changed = 0;
      // The window's own state rides along under `state.<key>` so that an input can be read back
      // by the same expressions that read the world.
      const scope: ExpressionScope = { ...snapshot, state };
      // A closed window still evaluates the conditions on its root, because one of them may be
      // what opens it — `{do: hide}` on `outOfCombat` is how a definition writes a HUD that comes
      // and goes. Everything under the root costs nothing while it is not on screen, which is what
      // makes twenty registered windows affordable.
      applyConditions(root, scope, helpers, stats);
      if (!panel.visible) return;
      for (const bound of root.bindings) {
        const value = evaluate(bound.expr, scope, helpers);
        stats.evaluated++;
        if (Object.is(value, bound.last)) continue;
        bound.last = value;
        bound.apply(value);
        stats.changed++;
      }
      for (const child of children) updateNode(child, scope, helpers, stats);
    },
    destroy(): void {
      destroyed = true;
      // The panel's own `destroy`, not a bare `remove`: the layout keeps a list of its windows and
      // a `hidden` watcher on each, and a window that is rebuilt every time its file changes would
      // otherwise leave one of each behind for the life of the session.
      panel.destroy();
    },
  };

  // One pass against an empty view before anything else, so that the window starts from "nothing
  // is known" rather than from whatever the markup happened to hold — and so that a `show`/`hide`
  // condition on the root has been asked once before the first frame.
  //
  // `hidden` on the root frame is the studio's «окно закрыто при входе» — the owner's own screen
  // says so — and `Panel` starts hidden anyway, so the flag only decides whether the window is
  // opened now. `show` redraws from the last snapshot, so a window opened later is never a frame
  // behind the rest of the interface.
  live.update({});
  if (!screen.hidden) live.show();
  return live;
}

/* ---------------------------------------------------------------------------------------------
 * One widget in a built-in window's slot — М7
 * ------------------------------------------------------------------------------------------- */

/** Which slot a patch's widget landed in, as the widget's own expressions read it. */
export interface SlotWidgetView {
  readonly name: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface LiveSlotWidget {
  readonly element: HTMLElement;
  readonly roots: ReadonlySet<string>;
  readonly stats: WindowUpdateStats;
  readonly actionPresses: { asked: number; ran: number };
  update(snapshot: ExpressionScope): void;
  destroy(): void;
}

/**
 * Draws one patch widget into one place of a built-in window.
 *
 * Everything below the top of the subtree is the same WoW geometry a window is: a `Frame` has a
 * width and a height of its own, so its children are anchored inside it by the same arithmetic and
 * the same single flip. The top itself is different, and deliberately: it is laid out **in the
 * slot's own flow**, `position: relative` with the anchor's `x`/`-y` as an offset. A slot is a row
 * of buttons (`.frame-actions`, `.minimap-controls`, `.spellbook-tabs`) or a column of blocks
 * (`.character-stats`), so a module's button belongs *in* that row beside the client's own; pinning
 * it absolutely inside a host whose size nothing has measured would put it in a corner, and
 * measuring the host would make where a button lands depend on when the panel was last laid out.
 *
 * The subtree carries `data-module`, exactly as a module window's nodes do, so the module's own
 * scoped stylesheet can reach it and nothing else can.
 */
export function renderSlotWidget(
  widget: ParsedWidget,
  where: {
    readonly module: string;
    readonly patch: string;
    readonly slot: SlotWidgetView;
    /**
     * The counters to add this subtree's presses to.
     *
     * Shared by every copy of one patch's widget, because a slot's copies come and go — a quest
     * card is rebuilt on every counter the server moves — and a per-copy counter would take the
     * record of what the player pressed away with the card.
     */
    readonly presses?: { asked: number; ran: number } | undefined;
  },
  host: WindowRenderHost = {},
): LiveSlotWidget {
  const helpers = host.helpers ?? {};
  const state: Record<string, unknown> = {};
  const presses = where.presses ?? { asked: 0, ran: 0 };
  const roots = new Set<string>();
  const slotScope: Record<string, unknown> = { name: where.slot.name, ...where.slot.params };
  const rootRef: { element: HTMLElement | undefined } = { element: undefined };
  const context: BuildContext = {
    module: where.module, windowId: where.patch, host, helpers, state, presses, roots,
    row: undefined, slot: slotScope, rootRef,
  };
  const node = buildNode(widget, { left: 0, top: 0, width: widget.width, height: widget.height }, context);
  rootRef.element = node.element;
  node.element.style.position = "relative";
  node.element.style.left = `${widget.anchor.x}px`;
  node.element.style.top = `${-widget.anchor.y}px`;

  const stats: WindowUpdateStats = { evaluated: 0, changed: 0 };
  let destroyed = false;
  const live: LiveSlotWidget = {
    element: node.element,
    roots,
    stats,
    actionPresses: presses,
    update(snapshot: ExpressionScope): void {
      if (destroyed) return;
      stats.evaluated = 0;
      stats.changed = 0;
      updateNode(node, { ...snapshot, state, slot: slotScope }, helpers, stats);
    },
    destroy(): void {
      destroyed = true;
      node.element.remove();
    },
  };
  // One pass against an empty view before the node is ever appended, so a label starts blank rather
  // than holding whatever the build wrote into it.
  live.update({});
  return live;
}
