/**
 * Small, deliberately DOM-free types for the FrameXML compatibility seam.
 *
 * This is not an implementation of Blizzard's Lua VM. XML is data that can be
 * loaded safely, while executable Lua is handed to an explicitly supplied
 * adapter (see LuaAddonRuntime below). Keeping that boundary explicit prevents
 * an addon from receiving the browser document, fetch, or other host globals.
 *
 * The widget vocabulary here is measured, not copied from the wiki: it is the
 * set of elements the real `Interface\GlueXML` corpus of this client actually
 * declares (70 files out of the locale patch chain, `patch-ruRU-A` plus the
 * server's own `patch-ruRU-F` login screen). Anything the corpus never spells
 * is deliberately absent so that a missing element is a loud diagnostic rather
 * than a silently half-implemented widget.
 */

export type FrameXmlWidgetType =
  | "Frame"
  | "Button"
  | "Texture"
  | "FontString"
  | "CheckButton"
  | "EditBox"
  | "ScrollFrame"
  | "Slider"
  | "StatusBar"
  | "Model"
  | "ModelFFX"
  | "SimpleHTML"
  | "MovieFrame"
  | "Cooldown"
  | "MessageFrame"
  // Added by F1, and measured the same way: these are the element names
  // `Interface\FrameXML` declares that `Interface\GlueXML` never does. See the set below.
  | "GameTooltip"
  | "ScrollingMessageFrame"
  | "PlayerModel"
  | "DressUpModel"
  | "TabardModel"
  | "Minimap"
  | "ColorSelect"
  | "QuestPOIFrame"
  | "WorldFrame";

/** The bounded line record owned by a MessageFrame/ScrollingMessageFrame. */
export interface FrameXmlMessage {
  readonly text: string;
  readonly color: FrameXmlColor;
  readonly lineID?: unknown;
  readonly accessID?: unknown;
  readonly extraData?: unknown;
  /** On the frame's `fadeClock`: when the line stops being fully shown (FrameXmlMessageFade.ts). */
  visibleUntil?: number;
  /** On the frame's `fadeClock`: when the line has faded out and is cleared. */
  fadeUntil?: number;
}

/** State that the runtime exposes for the stock scrolling message widgets. */
export interface FrameXmlMessageFrameState {
  maxLines: number;
  displayDuration: number;
  /** `fade`/`SetFading` (UI.xsd default true): whether the lines' countdowns run at all. */
  fading: boolean;
  /** `fadeDuration`/`SetFadeDuration`, seconds (default 3). */
  fadeDuration: number;
  /** `insertMode`/`SetInsertMode`: where a MessageFrame puts its newest line (default BOTTOM). */
  insertMode: "TOP" | "BOTTOM";
  /** Seconds this frame's lines have been counting; the lines' deadlines are on this clock. */
  fadeClock: number;
  /** Increments when the lines' countdowns are restarted or re-timed rather than just running. */
  fadeRevision: number;
  /** `<FontString nonspacewrap="true">` from ChatFrameTemplate. */
  nonSpaceWrap: boolean;
  messages: FrameXmlMessage[];
  /** Increments only when the message layer's contents change. */
  revision: number;
}

export interface FrameXmlRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The GameTooltip box, shared by the C-method estimate (`GlueWidgets.sizeGameTooltip`) and the
 * renderer that lays the rows out, so the width Lua reads before the next paint and the width the
 * page then draws are computed from the same rules.
 *
 * `PADDING` is the stock template's own text inset: `GameTooltipTemplate.xml` anchors
 * `$parentTextLeft1` at TOPLEFT (10, -10), and each further line TOPLEFT→BOTTOMLEFT at y = -2,
 * which is `ROW_GAP`. `COLUMN_GAP` is the least room kept between a double line's two halves.
 *
 * `WRAP_WIDTH` is the widest a tooltip may grow for a line that *wraps* (`AddLine(…, wrap)`,
 * `SetText(…, wrap)`, prose): such a line never widens the box past it, and wraps at whatever
 * width the unwrapped rows gave the box when that is wider. It is the renderer's previous prose cap
 * kept as a name, not a measurement — the 3.3.5 client's own wrap width for a prose-only tooltip
 * has not been measured against the live client.
 *
 * A wrapped line does widen the box up to that cap, on purpose. The stricter rule, where wrapped
 * lines add no width (`width: 0; min-width: 100%`) and the box is only its widest unwrapped row,
 * draws a spell tooltip as narrow as its name. Measured on the dev page for «Боевой крик» plus a
 * 92-character description: that rule gives a 102×144 box with the description 82 units wide and
 * 108 tall; this one gives 360×60, with the description on 2 lines 340 wide.
 */
export const FRAME_XML_TOOLTIP_LAYOUT = Object.freeze({
  PADDING: 10,
  ROW_GAP: 2,
  COLUMN_GAP: 8,
  MIN_WIDTH: 32,
  WRAP_WIDTH: 360,
});

/** Canonicalize widget element names as the client does (XML names are case-insensitive). */
export function canonicalFrameXmlWidgetType(value: string): FrameXmlWidgetType | undefined {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return undefined;
  for (const type of FRAME_XML_WIDGET_TYPES) {
    if (type.toLowerCase() === wanted) return type as FrameXmlWidgetType;
  }
  return undefined;
}

/** Set-compatible vocabulary whose membership test follows FrameXML's case-insensitive parser. */
class FrameXmlWidgetTypeSet extends Set<string> {
  override has(value: string): boolean {
    return super.has(value) || super.has(value.trim())
      || [...this].some((type) => type.toLowerCase() === value.trim().toLowerCase());
  }
}

/**
 * The widget vocabulary, measured across both corpora this client actually loads.
 *
 * The first fifteen are GlueXML's. The rest are FrameXML's, counted at declaration position over
 * its 133 XML files: `GameTooltip` 14, `ScrollingMessageFrame` 12, `PlayerModel` 3, `DressUpModel`
 * 2, and one each of `ColorSelect`, `Minimap`, `QuestPOIFrame`, `TabardModel`, `WorldFrame` — 36
 * declarations, of which several are `virtual="true"`, so a missing name costs the template *and*
 * every `inherits=` that names it. Measured before adding them: `GameTooltipTemplate` did not
 * register, so `_G.GameTooltip` was nil and `UIPanelTemplates.lua:138` raised on every tooltip
 * anchor it tried.
 *
 * Nothing else changes with the name present: the widget layer gives an unknown type the `Frame`
 * method table, and the DOM renderer gives it a `div`. What changes is that the declaration exists.
 */
export const FRAME_XML_WIDGET_TYPES: ReadonlySet<string> = new FrameXmlWidgetTypeSet([
  "Frame",
  "Button",
  "Texture",
  "FontString",
  "CheckButton",
  "EditBox",
  "ScrollFrame",
  "Slider",
  "StatusBar",
  "Model",
  "ModelFFX",
  "SimpleHTML",
  "MovieFrame",
  "Cooldown",
  "MessageFrame",
  "GameTooltip",
  "ScrollingMessageFrame",
  "PlayerModel",
  "DressUpModel",
  "TabardModel",
  "Minimap",
  "ColorSelect",
  "QuestPOIFrame",
  "WorldFrame",
]);

/**
 * Widget types whose 3D content this layer records but never renders (G3 owns the canvas).
 *
 * The three in-world model widgets join the two glue ones: `PlayerModel`, `DressUpModel` and
 * `TabardModel` are all `Model` subclasses in 3.3.5 and carry the same `SetModel`/`SetPosition`
 * surface, so a host that draws one draws all five.
 */
export const FRAME_XML_MODEL_TYPES: ReadonlySet<string> = new Set([
  "Model", "ModelFFX", "PlayerModel", "DressUpModel", "TabardModel",
]);

/** `<Font>` is a font *object* declaration, not a widget; it lives in its own registry. */
export const FRAME_XML_FONT_ELEMENT = "Font";

/**
 * Draw layers, lowest first. `<Layer level="...">` names one of these; textures
 * and font strings inside it stack in declaration order within the level.
 */
export const FRAME_XML_DRAW_LAYERS: readonly string[] = [
  "BACKGROUND",
  "BORDER",
  "ARTWORK",
  "OVERLAY",
  "HIGHLIGHT",
];

export interface FrameXmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly FrameXmlElement[];
  readonly text: string;
}

export interface FrameXmlParseResult {
  readonly ok: boolean;
  readonly root?: FrameXmlElement;
  readonly diagnostics: readonly string[];
}

export interface FrameXmlTemplate {
  readonly name: string;
  readonly element: FrameXmlElement;
  readonly source?: string;
}

export interface FrameXmlResolvedTemplate {
  readonly ok: boolean;
  readonly element?: FrameXmlElement;
  readonly diagnostics: readonly string[];
}

export interface FrameXmlPoint {
  readonly point: string;
  readonly relativeTo?: FrameXmlFrame;
  readonly relativePoint?: string;
  readonly x?: number;
  readonly y?: number;
}

export interface FrameXmlColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface FrameXmlTexCoords {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /**
   * The eight-number `SetTexCoord(ULx, ULy, LLx, LLy, URx, URy, LRx, LRy)` when its corners are not
   * an axis-aligned rectangle (a rotated or sheared picture: TaxiFrame's route lines, the paper
   * doll's flyout arrows). `left`…`bottom` then only repeat UL, UR and LL for older readers.
   */
  readonly corners?: readonly [number, number, number, number, number, number, number, number] | undefined;
}

export interface FrameXmlInsets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface FrameXmlGradient {
  readonly orientation: string;
  readonly min: FrameXmlColor;
  readonly max: FrameXmlColor;
}

export interface FrameXmlBackdrop {
  readonly bgFile?: string;
  readonly edgeFile?: string;
  readonly tile: boolean;
  readonly tileSize: number;
  readonly edgeSize: number;
  readonly insets: FrameXmlInsets;
}

/**
 * A resolved `<Font>` object: the flattened end of an inherits chain down to a
 * font file, a pixel height and the colour/outline decoration. Glue XML never
 * repeats these on a FontString; it names one (`inherits="GlueFontNormal"`,
 * `<NormalFont style="..."/>`) and the widget picks up everything.
 */
export interface FrameXmlFontStyle {
  readonly name: string;
  readonly file?: string;
  readonly height?: number;
  readonly outline?: string;
  readonly monochrome: boolean;
  readonly color?: FrameXmlColor;
  readonly shadowColor?: FrameXmlColor;
  readonly shadowOffsetX?: number;
  readonly shadowOffsetY?: number;
  readonly justifyH?: string;
  readonly justifyV?: string;
  readonly spacing?: number;
}

/**
 * Everything a `<Model>`/`<ModelFFX>` widget knows about its 3D content.
 *
 * G2 records; it never renders. The DOM layer emits a positioned placeholder
 * carrying these as data attributes so G3 can replace exactly that box with a
 * transparent three.js canvas without re-deriving any of the state.
 */
export interface FrameXmlModelState {
  file: string;
  /** Template entry requested by PlayerModel:SetCreature; resolved by the world host. */
  creatureEntry?: number | undefined;
  /** Explicit CreatureDisplayInfo selection requested by SetDisplayInfo. */
  displayId?: number | undefined;
  scale: number;
  fogNear?: number | undefined;
  fogFar?: number | undefined;
  fogColor?: FrameXmlColor | undefined;
  glow?: number | undefined;
  sequence?: number | undefined;
  sequenceTime?: number | undefined;
  camera?: number | undefined;
  facing?: number | undefined;
  position?: readonly [number, number, number] | undefined;
  modelScale?: number | undefined;
  /**
   * The last `SetLight` argument list, as plain numbers.
   *
   * Thirteen of them — enabled, omni, three direction components, an ambient intensity and colour,
   * a diffuse intensity and colour — which is one ambient plus one directional light and nothing
   * else. Kept as numbers rather than as lights because this file describes widget state and knows
   * nothing about a renderer; `GlueModelStage.glueModelLight` is what reads them.
   */
  light?: readonly number[] | undefined;
  /**
   * The light set a backdrop model is standing in: every `AddLight` since the last `ResetLights`.
   *
   * A different call from `SetLight` and a different shape — a *list* of thirteen-number lights,
   * because `GlueParent.lua`'s `SetLighting` adds up to three of them per background and says so
   * (`"You can add up to four lights per light set"`). The stock character screens never call
   * `SetLight` at all; this is the only thing that lights them.
   */
  lights?: readonly (readonly number[])[] | undefined;
  /**
   * Every other recorded 3D call in order, so a host can replay the ones it cares about.
   *
   * Bounded: a corpus that calls `AdvanceTime` from an OnUpdate would otherwise grow this list
   * once per frame for as long as the screen is up.
   */
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
}

/**
 * `Cooldown:SetCooldown(start, duration)` — the radial wipe over an action button.
 *
 * Both numbers are in `GetTime()` seconds, because that is the clock the corpus hands over:
 * `ActionButton_UpdateCooldown` reads `GetActionCooldown(action)` and passes the triple straight
 * into `CooldownFrame_SetTimer`, which calls `self:SetCooldown(start, duration)` with no
 * conversion of any kind (`Cooldown.lua`, the whole file — eight lines).
 *
 * `duration <= 0` means "no cooldown", which is also what `CooldownFrame_SetTimer` turns into a
 * `Hide()`; the state is kept anyway so a host can tell "never set" from "set and finished".
 */
export interface FrameXmlCooldownState {
  start: number;
  duration: number;
}

export interface FrameXmlEditBoxState {
  letters: number;
  password: boolean;
  numeric: boolean;
  multiLine: boolean;
  historyLines: number;
  focused: boolean;
  /**
   * `autoFocus` / `SetAutoFocus`: the box takes the keyboard when it is shown. True unless the XML
   * or Lua says otherwise, as in the client — the corpus writes `autoFocus="false"` 40 times and
   * `"true"` twice, and eight stock StaticPopups (CHANNEL_INVITE, JOIN_CHANNEL, NAME_CHAT, …) get
   * their caret from it alone.
   */
  autoFocus: boolean;
  highlightStart?: number | undefined;
  highlightEnd?: number | undefined;
  /** Native EditBox history is bounded by `historyLines`; this is not a chat log. */
  history: string[];
  historyIndex: number;
  cursorPosition: number;
  /** Explicit Lua caret/selection requests; browser selection changes do not advance this. */
  selectionRevision: number;
}

export interface FrameXmlSliderState {
  min: number;
  max: number;
  value: number;
  valueStep: number;
  orientation: string;
  /**
   * L5b-review: a Slider's two flags in Wow.exe (bits 2 and 4 of CSimpleSlider +0x29c): a range was
   * set (XML minValue with maxValue, or SetMinMaxValues), and a value was set while it had one (XML
   * defaultValue, or SetValue). SetMinMaxValues re-applies the value only once one was set
   * (0x0096c470). Not used for a StatusBar.
   */
  rangeSet?: boolean;
  valueSet?: boolean;
}

export interface FrameXmlStatusBarState extends FrameXmlSliderState {
  texture: string;
  color: FrameXmlColor;
}

export interface FrameXmlScrollState {
  /** Only this child's subtree scrolls; scrollbar frames and decoration stay fixed. */
  child?: FrameXmlFrame | undefined;
  horizontalScroll: number;
  verticalScroll: number;
  horizontalScrollRange: number;
  verticalScrollRange: number;
}

export type FrameXmlScriptHandler = (
  self: FrameXmlFrame,
  ...args: readonly unknown[]
) => void;

export interface LuaScriptContext {
  readonly frame: FrameXmlFrame;
  readonly event?: string;
  readonly args: readonly unknown[];
  readonly ui: FrameXmlUiApi;
}

/**
 * A widget script body about to be turned into a callable.
 *
 * `parameters` is the measured 3.3.5 signature for that script name — the glue
 * corpus writes `AccountLogin_OnKeyDown(key)` and `GlueParent_OnEvent(event,
 * ...)` in the XML body with no `function` header at all, so the body has to be
 * compiled as a function with exactly those parameter names plus a vararg.
 */
export interface FrameXmlScriptCompileRequest {
  readonly script: string;
  readonly source: string;
  readonly chunkName: string;
  readonly parameters: readonly string[];
  readonly frame: FrameXmlFrame;
}

/**
 * Adapter seam for a real sandboxed Lua 5.1-compatible runtime.
 *
 * The compatibility layer itself ships no Lua interpreter. An adapter may
 * execute a chunk only against the capability-limited `LuaScriptContext`; it
 * must not expose `window`, `document`, fetch, WebSocket, or arbitrary host
 * objects. `src/browser/glue/GlueLua.ts` installs the real fengari-backed
 * adapter for the glue screens; without one the bridge records the limitation
 * and keeps the native HUD alive instead of partially executing Lua.
 */
export interface LuaAddonRuntime {
  readonly name: string;
  readonly luaVersion: string;
  execute(source: string, context: LuaScriptContext): void;
  /**
   * Compile one XML script body once and return a reusable handler. Optional:
   * an adapter without it falls back to `execute`, which recompiles per
   * dispatch and is unusable for OnUpdate.
   */
  compileScript?(request: FrameXmlScriptCompileRequest): FrameXmlScriptHandler | undefined;
  /** Resolve `<OnClick function="Name"/>` against the adapter's globals. */
  resolveGlobalHandler?(name: string): FrameXmlScriptHandler | undefined;
  /** Give the adapter the widget it must expose to Lua as `self`. */
  bindFrame?(frame: FrameXmlFrame): void;
  /** Native animation objects are distinct from drawable child widgets. */
  bindAnimations?(frame: FrameXmlFrame, elements: readonly FrameXmlElement[]): void;
  tickAnimations?(elapsedSeconds: number): void;
  /**
   * Clear active effects when a region becomes hidden — called for every frame an OnHide reaches,
   * including through a hidden ancestor. The widget layer also drops visibility-bound state here
   * (a GameTooltip's owner), because it is the one hook every host already forwards.
   */
  hideAnimations?(frame: FrameXmlFrame): void;
  /** Drop the adapter's view of a widget that the bridge destroyed. */
  releaseFrame?(frame: FrameXmlFrame): void;
}

export interface FrameXmlDiagnostic {
  readonly scope: "xml" | "template" | "addon" | "script";
  readonly message: string;
}

export interface FrameXmlFrame {
  readonly type: FrameXmlWidgetType;
  readonly name: string;
  /**
   * Bumped by the bridge on every announced change to this frame. A renderer re-applies a frame
   * whose version it has not applied; absent (a hand-made frame) means "always re-apply".
   */
  readonly renderVersion?: number;
  /** False when the bridge invented the name; `GetName()` must then return nil. */
  readonly named: boolean;
  readonly parent?: FrameXmlFrame;
  readonly children: readonly FrameXmlFrame[];
  readonly attributes: Readonly<Record<string, string>>;
  readonly points: readonly FrameXmlPoint[];
  readonly scriptSources: ReadonlyMap<string, string>;
  readonly registeredEvents: ReadonlySet<string>;
  readonly scripts: ReadonlyMap<string, FrameXmlScriptHandler>;
  readonly visible: boolean;
  readonly text: string;
  readonly texture: string;
  readonly loaded: boolean;

  /** Draw layer of a Texture/FontString, and the sub-order inside that layer. */
  readonly drawLayer: string;
  readonly drawSubLevel: number;
  readonly texCoords?: FrameXmlTexCoords | undefined;
  readonly vertexColor?: FrameXmlColor | undefined;
  /**
   * The Texture *is* a colour: `SetTexture(r, g, b[, a])` or an XML `<Color>` child. Only then does
   * a Texture with no file paint a flat rectangle. `SetVertexColor` alone tints a picture and draws
   * nothing without one — stock TargetFrame.lua calls `self.portrait:SetVertexColor(1, 1, 1)` on
   * every update, and treating that as a fill painted the white square behind the target portrait.
   */
  readonly colorFill?: boolean;
  readonly gradient?: FrameXmlGradient | undefined;
  readonly alphaMode: string;
  readonly desaturated: boolean;
  /**
   * `Texture:SetRotation` in radians, counter-clockwise, about the texture's centre.
   *
   * The owner's login screen spins its logo with it every frame
   * (`lgzg.lua` `UpdateFrame` → `self.texture:SetRotation(angle)`), which is the whole reason it is
   * state rather than a recorded no-op.
   */
  readonly textureRotation: number;
  /**
   * The picture came from `SetPortraitToTexture`: drawn cropped to a circle, as the client renders
   * a portrait under its ring art. A plain `SetTexture` clears it.
   */
  readonly portrait?: boolean;
  /**
   * The `button..Down`/`button..Up` combinations `RegisterForClicks` armed, upper-cased.
   *
   * Empty means the 3.3.5 default, which is `LeftButtonUp` alone. The corpus arms two shapes:
   * `("LeftButtonDown", "LeftButtonUp")` on the character-select and character-create rotation
   * arrows, which have to hear the press *and* the release to spin while held, and
   * `("LeftButtonUp", "RightButtonUp")` on the options templates.
   */
  readonly clickRegistrations: ReadonlySet<string>;
  readonly dragRegistrations: ReadonlySet<string>;
  readonly clampedToScreen: boolean;
  readonly movable: boolean;
  readonly moving: boolean;
  readonly tooltipCursorAnchor?: { readonly x: number; readonly y: number } | undefined;
  /** `GameTooltip:SetMinimumWidth`, in UI units; the renderer's floor for the box. 0 when unset. */
  readonly tooltipMinimumWidth?: number;
  readonly backdrop?: FrameXmlBackdrop | undefined;
  readonly backdropColor?: FrameXmlColor | undefined;
  readonly backdropBorderColor?: FrameXmlColor | undefined;
  /** Font object name currently applied to a FontString/EditBox/Button label. */
  readonly fontObject: string;
  /**
   * A Button's `<ButtonText>` that declared no font of its own, and therefore draws in its owner's
   * state font: `<NormalFont>` while enabled, `<DisabledFont>` while disabled, `<HighlightFont>` under
   * the pointer. See `FrameXmlUiBridge.syncButtonLabelFont`.
   */
  readonly inheritsButtonFont?: boolean;
  readonly textColor?: FrameXmlColor | undefined;
  readonly justifyH: string;
  readonly justifyV: string;
  /** NORMAL/PUSHED/HIGHLIGHT/DISABLED/CHECKED/DISABLEDCHECKED sub-textures. */
  readonly stateTextures: ReadonlyMap<string, FrameXmlFrame>;
  /**
   * Which state of its owner this Texture *is*, or `""` for an ordinary layer texture.
   *
   * A button owns up to six pictures and shows one or two of them: the disabled one replaces the
   * normal one, the pushed one replaces it while held, and the highlight rides on top only under
   * the pointer. Without this the renderer had no way to tell a `<HighlightTexture>` from a
   * `<Texture>` on the HIGHLIGHT layer, so it drew all six at once — see the renderer's
   * `stateTextureVisible`, which is where the measurement of what that looked like lives.
   */
  readonly stateTexture: string;
  /** NORMAL/HIGHLIGHT/DISABLED font object names for a Button. */
  readonly stateFonts: ReadonlyMap<string, string>;
  readonly buttonState: string;
  readonly highlightLocked: boolean;
  readonly enabled: boolean;
  readonly checked: boolean;
  readonly alpha: number;
  /** Transient animation result; Stop restores the authored/base alpha. */
  readonly animationAlpha?: number | undefined;
  /** Transient local transform; authored points and SetScale remain untouched. */
  readonly animationTransform?: string | undefined;
  readonly scale: number;
  readonly frameLevel: number;
  readonly frameStrata: string;
  /**
   * `toplevel="true"`: showing this frame raises it above everything else in its strata.
   *
   * Not decoration — it is what decides which screen is in front. Every glue screen declares it
   * (`CharacterSelect`, `CharacterCreate`, `AccountLogin`, both delete dialogs), and without it a
   * frame that happens to carry a higher `frameLevel` stays over the screen that was just shown.
   */
  readonly toplevel: boolean;
  readonly id: number;
  readonly setAllPoints: boolean;
  readonly parentKey: string;
  readonly hitRectInsets?: FrameXmlInsets | undefined;
  readonly textInsets?: FrameXmlInsets | undefined;
  /**
   * The client's **secure attributes** — what `SetAttribute`/`GetAttribute` read and write.
   *
   * A different dictionary from `attributes` above, which is the XML element's own attribute list
   * (`name=`, `hidden=`, `id=`, `width=`), and the two must never be merged: the corpus writes
   * `self:SetAttribute("type", "action")` on a widget whose XML `type` attribute does not exist,
   * and `self:SetAttribute("name", …)` on frames whose XML `name` is their identity.
   *
   * Keys are normalised the way the client normalises them; see `frameXmlAttributeKey`. The value
   * is whatever the caller stored — the corpus stores strings, numbers, booleans and widgets.
   */
  readonly secureAttributes: ReadonlyMap<string, unknown>;
  readonly cooldown: FrameXmlCooldownState;
  readonly model: FrameXmlModelState;
  readonly editBox: FrameXmlEditBoxState;
  readonly messageFrame: FrameXmlMessageFrameState;
  readonly slider: FrameXmlSliderState;
  readonly statusBar: FrameXmlStatusBarState;
  readonly scroll: FrameXmlScrollState;
}

/** The capability surface intentionally contains no DOM or network methods. */
export interface FrameXmlUiApi {
  CreateFrame(
    type: string,
    name?: string,
    parent?: FrameXmlFrame,
    inherits?: string,
  ): FrameXmlFrame | undefined;
  SetScript(
    frame: FrameXmlFrame,
    script: string,
    handler: FrameXmlScriptHandler | null,
  ): boolean;
  Click(frame: FrameXmlFrame, button?: string, down?: boolean): boolean;
  /** Dispatch the scalar-only FrameXML hover callbacks; never forwards a DOM event. */
  Enter(frame: FrameXmlFrame): boolean;
  Leave(frame: FrameXmlFrame): boolean;
  RegisterEvent(frame: FrameXmlFrame, event: string): boolean;
  Show(frame: FrameXmlFrame): boolean;
  Hide(frame: FrameXmlFrame): boolean;
  SetPoint(
    frame: FrameXmlFrame,
    point: string,
    relativeTo?: FrameXmlFrame,
    relativePoint?: string,
    x?: number,
    y?: number,
  ): boolean;
  SetParent(frame: FrameXmlFrame, parent?: FrameXmlFrame): boolean;
  SetText(frame: FrameXmlFrame, text: string): boolean;
  SetTexture(frame: FrameXmlFrame, texture: string): boolean;
}

export interface FrameXmlUiBridgeOptions {
  readonly runtime?: LuaAddonRuntime;
  readonly onDiagnostic?: (diagnostic: FrameXmlDiagnostic) => void;
  /**
   * `text="MANAGE_ACCOUNT"` in XML is a GlobalString key, not a literal. The
   * corpus loads `GlueStrings.lua` first precisely so that every later XML
   * `text=` resolves; without a resolver the literal key is kept, which is
   * exactly what the real client shows for an unlocalised key.
   */
  readonly globalStringResolver?: (key: string) => string | undefined;
}

export interface FrameXmlAddonLoadResult {
  readonly ok: boolean;
  readonly roots: readonly FrameXmlFrame[];
  readonly diagnostics: readonly FrameXmlDiagnostic[];
  /** Always true: this loader has no mutation path into the native HUD. */
  readonly nativeHudUnaffected: true;
}
