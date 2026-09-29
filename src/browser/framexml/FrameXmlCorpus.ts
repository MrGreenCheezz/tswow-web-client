import type { GlueLoadCheckpoint } from "../glue/GlueLoadScheduler.js";
import {
  normalizeGluePath,
  parseGlueToc,
  resolveGluePath,
  type GlueFileProvider,
} from "../glue/GlueLoader.js";
import { frameXmlAttribute, parseFrameXml } from "../ui/framexml_compat/FrameXmlParser.js";
import {
  FRAME_XML_FONT_ELEMENT,
  FRAME_XML_WIDGET_TYPES,
  type FrameXmlElement,
} from "../ui/framexml_compat/FrameXmlTypes.js";
import { frameXmlInlineScripts, type FrameXmlLuaChunk } from "./FrameXmlStubPlan.js";
import { frameXmlMailCorpusSource } from "./FrameXmlMailCorpus.js";

/**
 * The corpus, read once and held.
 *
 * Two things need every byte of `Interface\FrameXML` before a single chunk runs: the stub plan,
 * which is derived from the text, and the loader, which then executes it. Fetching 334 files twice
 * over HTTP is the difference between a page that opens and a page that is still opening, so this
 * is a `GlueFileProvider` that caches — the loader is handed *this*, and the scan below is what
 * warms it.
 *
 * It is also where "how big is the in-world interface" is answered, which is the first number the
 * slice owes: bytes, files, and the split between what Blizzard shipped and what this server's own
 * modules folded into the same TOC.
 */

export type FrameXmlFileKind = "toc" | "lua" | "xml";

export interface FrameXmlCorpusFile {
  readonly path: string;
  readonly kind: FrameXmlFileKind;
  /** UTF-8 length of the served text. */
  readonly bytes: number;
  /** True when the path sits under a `tsaddons/` directory, i.e. is this server's, not Blizzard's. */
  readonly addon: boolean;
}

export interface FrameXmlCorpusScan {
  readonly toc: string;
  /** TOC entries in document order, before Include/Script expansion. */
  readonly tocEntries: number;
  /** Every file the walk reached, in the order the loader will reach them. */
  readonly files: readonly FrameXmlCorpusFile[];
  /** Referenced but absent or zero-byte; the real client skips these too. */
  readonly missing: readonly string[];
  /** Lua text to derive the stub plan from: every `.lua` file and every inline `<Script>` body. */
  readonly chunks: readonly FrameXmlLuaChunk[];
  /** XML files the parser refused outright, with its reason. */
  readonly unparsable: readonly { readonly file: string; readonly reason: string }[];
  /**
   * Widget declarations whose element name is not a type this layer knows.
   *
   * This is the grammar gap, measured before anything is added to close it: a declaration the
   * bridge drops is a frame that never exists, and a `virtual="true"` one is a template every
   * `inherits=` in the corpus then misses.
   *
   * "Declaration position" is exact rather than a guess about names: a widget is declared as a
   * child of `<Ui>`, of a `<Frames>` block, or of a `<ScrollChild>`. Everything else inside a
   * widget — `<Anchors>`, `<Size>`, `<Layers>`, the `<On*>` handlers — is that widget's own
   * grammar and is not counted here.
   */
  readonly unknownDeclarations: ReadonlyMap<string, number>;
  /**
   * Every font object the corpus declares, in declaration order.
   *
   * Needed *before* the first chunk runs, for the same reason the stub plan is:
   * `GameFontNormal` is read by files in the middle of the TOC and the bridge
   * only flattens its font objects at the end of it, so the Lua side has to know
   * which names are font objects up front and resolve each one on first touch.
   *
   * Both spellings count, because the client publishes both as globals with the
   * same API: `<Font name="GameFontNormal">` and the virtual `<FontString>`
   * that inherits from it (`GameFontHighlightSmallLeft`, and 270 reads of it).
   */
  readonly fontObjects: readonly string[];
  /**
   * Server modules the TOC glued into itself, from its own `## tsaddon-begin:`
   * markers — the only addons this client has actually loaded.
   */
  readonly addonModules: readonly string[];
}

/** Where the in-world interface lives in the MPQ chain. */
export const FRAMEXML_TOC_PATH = "interface/framexml/framexml.toc";

const UTF8 = new TextEncoder();

function isAddonPath(path: string): boolean {
  return path.includes("/tsaddons/");
}

/** The elements whose children are themselves widget declarations. */
const DECLARATION_CONTAINERS: ReadonlySet<string> = new Set(["Frames", "ScrollChild"]);

/**
 * Count one declaration and recurse into the blocks that hold more of them.
 *
 * A name that is neither a widget type nor `<Font>` is a hole in this layer's grammar, and every
 * such declaration — plus everything nested inside it — is lost. Counting it at the point of
 * declaration is what makes "adding `GameTooltip` unlocks N frames" a number instead of a guess.
 */
function countDeclarations(element: FrameXmlElement, unknown: Map<string, number>): void {
  const known = FRAME_XML_WIDGET_TYPES.has(element.name) || element.name === FRAME_XML_FONT_ELEMENT;
  if (!known) {
    unknown.set(element.name, (unknown.get(element.name) ?? 0) + 1);
    return;
  }
  for (const child of element.children) {
    if (!DECLARATION_CONTAINERS.has(child.name)) continue;
    for (const nested of child.children) countDeclarations(nested, unknown);
  }
}

/**
 * Collect the Lua written inside `<Scripts>` blocks.
 *
 * F1 fed the stub plan every `.lua` file and every top-level `<Script>` body,
 * and that missed a whole category of the corpus' own Lua: the `<OnLoad>`,
 * `<OnClick>`, `<OnEvent>`… bodies, which is where an XML-declared widget does
 * most of its work. Measured, the omission is not cosmetic — it is why
 * `GetActionBarToggles`, `GetRefreshRates`, `GetGamma`, `GetTerrainMip`,
 * `GetMultisampleFormats` and `SetWhoToUI` were counted as globals the corpus
 * only *reads* (so: left nil, correctly, by the plan's own rule) when in fact it
 * calls every one of them, and each raised «attempt to call a nil value».
 *
 * A handler written as `<OnLoad function="Foo"/>` has no body and is skipped;
 * its `Foo` is a global the plan already sees at its definition.
 */
export function frameXmlHandlerScripts(root: FrameXmlElement, file: string): FrameXmlLuaChunk[] {
  const chunks: FrameXmlLuaChunk[] = [];
  const walk = (element: FrameXmlElement): void => {
    if (element.name === "Scripts") {
      for (const handler of element.children) {
        if (handler.text.trim().length === 0) continue;
        chunks.push({ file: `${file}:${handler.name}[${chunks.length}]`, source: handler.text });
      }
      return;
    }
    for (const child of element.children) walk(child);
  };
  walk(root);
  return chunks;
}

/**
 * Collect every font-object declaration in one parsed document.
 *
 * A whole-tree walk rather than a declaration-position one: `<Font>` blocks sit
 * at the top of `Fonts.xml`, but the virtual `<FontString>`s that make up most
 * of the set are written both at top level (`FontStyles.xml`) and inside
 * `<Layers>` of a template that other files then name.
 */
function collectFontObjects(element: FrameXmlElement, into: Set<string>): void {
  const name = frameXmlAttribute(element, "name")?.trim();
  if (name) {
    // The registry's own rule, kept: a named `<Font>` is a global object whether
    // or not it says virtual; a `<FontString>` is one only when it is a template.
    const isFont = element.name === FRAME_XML_FONT_ELEMENT;
    const isVirtualFontString = element.name === "FontString"
      && /^(?:true|1|yes)$/i.test(frameXmlAttribute(element, "virtual")?.trim() ?? "");
    if (isFont || isVirtualFontString) into.add(name);
  }
  for (const child of element.children) collectFontObjects(child, into);
}

/** `## tsaddon-begin: name` — the TOC's own record of which modules it glued in. */
export function frameXmlAddonModules(toc: string): readonly string[] {
  const names = new Set<string>();
  const pattern = /^\s*##\s*tsaddon-begin(?:\s*:\s*(\S+))?\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(toc)) !== null) {
    const name = match[1]?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

export interface FrameXmlCorpusOptions {
  readonly checkpoint?: GlueLoadCheckpoint;
  /** Guards a cyclic Include chain; the loader has its own, this one bounds the *scan*. */
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_FILES = 1024;
const DEFAULT_MAX_DEPTH = 16;
/** How many `/client/file` requests are allowed to be outstanding at once. */
const PREFETCH_CONCURRENCY = 8;

export class FrameXmlCorpus implements GlueFileProvider {
  readonly #source: GlueFileProvider;
  readonly #cache = new Map<string, string | undefined>();
  readonly #inFlight = new Map<string, Promise<string | undefined>>();
  readonly #options: FrameXmlCorpusOptions;
  #bytesRead = 0;
  #requests = 0;

  constructor(source: GlueFileProvider, options: FrameXmlCorpusOptions = {}) {
    this.#source = source;
    this.#options = options;
  }

  /** UTF-8 bytes served out of the underlying provider, i.e. what actually crossed the wire. */
  get bytesRead(): number {
    return this.#bytesRead;
  }

  /** Distinct paths asked of the underlying provider. */
  get requests(): number {
    return this.#requests;
  }

  async read(path: string): Promise<string | undefined> {
    const key = normalizeGluePath(path);
    if (this.#cache.has(key)) return this.#cache.get(key);
    const inFlight = this.#inFlight.get(key);
    if (inFlight) return await inFlight;
    const request = (async (): Promise<string | undefined> => {
      this.#requests += 1;
      try {
        const source = await this.#source.read(key);
        this.#cache.set(key, source);
        if (source !== undefined) this.#bytesRead += UTF8.encode(source).byteLength;
        return source;
      } finally {
        // Also on a throw, so a failed read is retried rather than remembered as a rejection.
        this.#inFlight.delete(key);
      }
    })();
    this.#inFlight.set(key, request);
    return await request;
  }

  /**
   * Warm the cache for a batch of paths, a few at a time.
   *
   * The walk below is inherently serial — an XML file has to be parsed before its `Include`s are
   * known — and over HTTP that costs one round trip per file, in order. Measured in this browser
   * against the live gateway: **118,922 ms** for the 335-file scan, against 166 ms for the same walk
   * in node off the local MPQ chain. So every set of paths that *is* known at once — the TOC's own
   * 210 entries, and each XML file's own references — is fetched together instead.
   *
   * Bounded rather than unbounded: 335 simultaneous requests would queue in the browser's own
   * connection pool anyway and would take the gateway's MPQ chain with them.
   */
  async prefetch(paths: readonly string[], concurrency = PREFETCH_CONCURRENCY): Promise<void> {
    const pending = paths.filter((path) => !this.#cache.has(normalizeGluePath(path)));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const path = pending[next++];
        if (path === undefined) return;
        try {
          await this.read(path);
        } catch {
          // A failed prefetch is not an error here: the walk asks again and reports it properly.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  }

  /**
   * Walk the TOC the way the loader will, reading only.
   *
   * The traversal has to agree with `GlueLoader`'s exactly — same TOC parse, same `..` resolution,
   * same Include/Script expansion, same "zero bytes means absent" rule — or the plan would be
   * derived from a different corpus than the one that runs. It uses that module's own exported
   * primitives for all four, so the only thing written twice is the recursion, and the reason it is
   * written twice is that the loader executes as it walks and this must not.
   */
  async scan(tocPath = FRAMEXML_TOC_PATH): Promise<FrameXmlCorpusScan> {
    const maxFiles = this.#options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxDepth = this.#options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const files: FrameXmlCorpusFile[] = [];
    const missing: string[] = [];
    const chunks: FrameXmlLuaChunk[] = [];
    const unparsable: { file: string; reason: string }[] = [];
    const unknown = new Map<string, number>();
    const fontObjects = new Set<string>();
    const seen = new Set<string>();

    const path = normalizeGluePath(tocPath);
    const tocSource = await this.read(path);
    if (tocSource === undefined) {
      return {
        toc: path, tocEntries: 0, files, missing: [path], chunks, unparsable,
        unknownDeclarations: unknown, fontObjects: [], addonModules: [],
      };
    }
    files.push({ path, kind: "toc", bytes: UTF8.encode(tocSource).byteLength, addon: false });
    const directory = path.slice(0, path.lastIndexOf("/") + 1);
    const entries = parseGlueToc(tocSource, directory);
    // Everything the TOC names is known before the first file is opened, so none of it has to wait
    // for the file in front of it. Measured: 210 of the 335 files.
    await this.prefetch(entries.map((entry) => entry.path));

    const record = (file: string, kind: FrameXmlFileKind, source: string): void => {
      files.push({
        path: file, kind, bytes: UTF8.encode(source).byteLength, addon: isAddonPath(file),
      });
    };

    const visitLua = async (file: string): Promise<void> => {
      if (seen.has(file) || files.length >= maxFiles) return;
      seen.add(file);
      const source = await this.read(file);
      await this.#options.checkpoint?.();
      if (source === undefined || source === "") {
        missing.push(file);
        return;
      }
      record(file, "lua", source);
      chunks.push({ file, source });
    };

    const visitXml = async (file: string, depth: number): Promise<void> => {
      if (seen.has(file) || depth > maxDepth || files.length >= maxFiles) return;
      seen.add(file);
      const source = await this.read(file);
      await this.#options.checkpoint?.();
      if (source === undefined || source === "") {
        missing.push(file);
        return;
      }
      record(file, "xml", source);
      for (const [index, body] of frameXmlInlineScripts(source).entries()) {
        chunks.push({ file: `${file}:Script[${index}]`, source: body });
      }
      const parsed = parseFrameXml(source);
      if (!parsed.root) {
        unparsable.push({ file, reason: parsed.diagnostics.join("; ") || "no root element" });
        return;
      }
      collectFontObjects(parsed.root, fontObjects);
      chunks.push(...frameXmlHandlerScripts(parsed.root, file));
      const base = file.slice(0, file.lastIndexOf("/") + 1);
      const children = parsed.root.name === "Ui" ? parsed.root.children : [parsed.root];
      // This file's own references are all known now, so they are fetched together; only the next
      // level down has to wait for a parse.
      await this.prefetch(children
        .filter((child) => child.name === "Include" || child.name === "Script")
        .map((child) => {
          const reference = frameXmlAttribute(child, "file");
          return reference ? resolveGluePath(base, reference) : undefined;
        })
        .filter((resolved): resolved is string => resolved !== undefined));
      for (const child of children) {
        if (child.name === "Include") {
          const reference = frameXmlAttribute(child, "file");
          const resolved = reference ? resolveGluePath(base, reference) : undefined;
          if (resolved) await visitXml(resolved, depth + 1);
          continue;
        }
        if (child.name === "Script") {
          const reference = frameXmlAttribute(child, "file");
          const resolved = reference ? resolveGluePath(base, reference) : undefined;
          if (resolved) await visitLua(resolved);
          continue;
        }
        countDeclarations(child, unknown);
      }
    };

    for (const entry of entries) {
      if (entry.kind === "lua") await visitLua(entry.path);
      else await visitXml(entry.path, 0);
    }
    return {
      toc: path,
      tocEntries: entries.length,
      files,
      missing,
      chunks,
      unparsable,
      unknownDeclarations: new Map(
        [...unknown].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
      ),
      fontObjects: [...fontObjects],
      addonModules: frameXmlAddonModules(tocSource),
    };
  }
}

/**
 * The action-bar + minimap + player/target-frame + aura + chat + spellbook + Character/PaperDoll
 * + bags + QuestLog + SkillFrame + map/calendar/world-state vertical's dependency TOC.
 *
 * Slice F3's third item asked whether `FrameXML.toc` can be cut to a dependency subset for
 * `MainMenuBar` without Lua errors. The subset now includes the original world map, calendar
 * clock and world-state indicators. MPQ regression tests measure its dependency closure and
 * retain the exact source order and interaction contracts as executable evidence.
 *
 * The order is the real TOC's own, because the corpus depends on it: `GlobalStrings.lua` first,
 * `Constants.lua` before anything that reads `PI`, the fonts before the templates that inherit
 * them, `BasicControls.xml` before every widget template, `SecureTemplates.xml` before the
 * `SecureActionButtonTemplate` the action buttons inherit. `MoneyFrame.lua` and `MoneyFrame.xml`
 * occupy their stock slots after `AnimTimerFrame.xml`; they provide the `SmallMoneyFrameTemplate`
 * child that `ContainerFrame.xml` shows for the backpack. `ItemButtonTemplate.xml` occupies its
 * stock slot after `SecureHandlerTemplates.xml` and reaches its relative `ItemButtonTemplate.lua`.
 * `HybridScrollFrame.lua`/`.xml` occupy their stock slots after `ItemButtonTemplate.xml` and before
 * `GameMenuFrame.xml`, supplying the real HybridScrollFrame/HybridScrollBar templates that
 * QuestLog inherits. `Minimap.xml` occupies its stock slot after `MainMenuBar.xml` and before
 * `Cooldown.xml`, and its relative `Minimap.lua` is reached by
 * the corpus loader. `MoneyInputFrame.lua`/`.xml` follow the money display template in their
 * stock slots: StaticPopup inherits `MoneyInputFrameTemplate` even for dialogs without a money
 * input, and its stock show path hides that concrete child unconditionally. `BuffFrame.xml`
 * follows `MultiActionBars.xml` and reaches its relative
 * `BuffFrame.lua`; the player-frame tail follows the same order: `UnitFrame.xml` defines the
 * shared Lua helpers before `PlayerFrame.xml`.
 *
 * Not every entry of the full TOC is here: 32 of its 139 stock entries (the TSWoW blocks aside) are
 * not. Eight are `FRAMEXML_OPTIONS_TOC` below, loaded into the running VM on the options windows'
 * first open. Most of the other 24 wait for an owner of their own in the work plan — for example
 * `DurabilityFrame.xml` (3.06), `MultiCastActionBarFrame.xml` (3.07), `CoinPickupFrame.xml` (3.09),
 * `VehicleMenuBar.xml` and `AnimationSystem.lua` (11.02) — and two are out for a measured reason:
 *
 * * `Localization.xml` — not for a raise: measured at its stock slot after `FontStyles.xml` over the
 *   canned seam it costs +2 files, +968 B, 0 widgets and 0 Lua errors, since UIParent calls its
 *   `LocalizeFrames()` on VARIABLES_LOADED, long after `PlayerFrame.xml` created the
 *   `PlayerHitIndicator` it re-anchors. It waits for an answer to that function's
 *   `SetEuropeanNumbers(true)` (plan item 3.09), which would otherwise be a new unanswered C API.
 * * `WorldFrame.xml` — the Three.js world viewport owns rendering and input; the stock world
 *   widget is not an additional browser surface. Its popup positioning is owned by the DOM host.
 *
 * The chat additions are kept to the stock concrete chat cluster: `AutoComplete.xml` follows
 * `TextStatusBar.xml`, and `HistoryKeeper.lua`, `ChatFrame.xml` and `FloatingChatFrame.xml` follow
 * `UnitFrame.xml` before `PlayerFrame.xml`. This creates `ChatFrame1` and `ChatFrame1EditBox` while
 * keeping configuration/social surfaces (`ChatConfigFrame.xml`, `BNConversations.xml`) outside
 * the slice. `ChannelFrame.xml` is included because `VoiceChat.xml`'s stock toggle owns the
 * `ChannelFrameAutoJoin` child; this is a real FrameXML dependency, not a host placeholder.
 * `UIDropDownMenu.xml` is retained immediately before
 * `UIPanelTemplates.lua`, because the static Player/Party/Target/Pet path reaches dropdown child
 * widgets through that owner. Likewise `VoiceChat.xml` and `ReadyCheck.xml` are retained immediately
 * before `PlayerFrame.xml`: their static speaker/ready-check children are touched during the stock
 * player and party OnLoad path, and omitting either leaves a nil child at load time. `PartyFrame.xml`
 * remains the stock owner of PetFrame's party-debuff template and its four party roots are a measured
 * part of this vertical, not synthetic host widgets. `SpellBookFrame.xml` is the bounded interactive
 * window tail; `UIMenu.xml` and `OptionsPanelTemplates.xml` are retained at their stock positions
 * because ChatFrame's menu and SpellBook's rank filter are concrete owners of their referenced
 * frames. `ColorPickerFrame.xml` is likewise retained for PartyMemberBackground's stock opacity
 * slider. The bags tail
 * keeps the smallest truthful interactive closure: `ItemButtonTemplate.xml` plus `ContainerFrame.xml`,
 * `MoneyFrame.lua`/`.xml`, `GameMenuFrame.xml`, and `MainMenuBarBagButtons.xml` plus its relative Lua.
 * The container XML creates the thirteen concrete `ContainerFrame1..13` roots, each with its
 * thirty-six item buttons; the button XML creates the stock backpack, four carried-bag buttons, and
 * keyring button. The focused MPQ bridge test drives the real backpack click with the existing
 * inventory seam. BankFrame is also loaded for container anchors while its actions remain native.
 * QuestLog then occupies the five stock TOC entries between `PaperDollFrame.xml` and the bags
 * tail; their five relative scripts and `QuestFrameTemplates.xml` are resolved by the same loader
 * rule. The real HybridScrollFrame pair is in the vertical at its earlier stock position rather
 * than replaced by a structural compatibility object.
 */
export const FRAMEXML_VERTICAL_TOC: readonly string[] = Object.freeze([
  "GlobalStrings.lua",
  "Constants.lua",
  "Fonts.xml",
  "FontStyles.xml",
  "BasicControls.xml",
  "UIParent.xml",
  "AnimTimerFrame.xml",
  "MoneyFrame.lua",
  "MoneyFrame.xml",
  "MoneyInputFrame.lua",
  "MoneyInputFrame.xml",
  "GameTooltip.xml",
  "UIMenu.xml",
  "UIDropDownMenu.xml",
  "UIPanelTemplates.lua",
  "UIPanelTemplates.xml",
  "SecureTemplates.xml",
  "SecureHandlerTemplates.xml",
  "ItemButtonTemplate.xml",
  "HybridScrollFrame.lua",
  "HybridScrollFrame.xml",
  "GameMenuFrame.xml",
  "CharacterFrameTemplates.xml",
  "TextStatusBar.lua",
  "TextStatusBar.xml",
  "UIErrorsFrame.xml",
  "AutoComplete.xml",
  // StaticPopup is a stock dependency of the on-demand Blizzard_TrainerUI module. Keep it in the
  // vertical at its retail position so its StaticPopupDialogs table exists before Trainer Lua runs.
  "StaticPopup.xml",
  "OptionsPanelTemplates.xml",
  // The realm's breath/fatigue snapshots drive the original three mirror bars and their Lua.
  "MirrorTimer.xml",
  // Stock TOC line 49. ContainerFrameItemButton_OnClick hides StackSplitFrame after every
  // UseContainerItem; with the real frame loaded (+2 files, +8,205 B, +23 widgets, 0 Lua errors,
  // measured) the bag gate no longer aliases it to GameMenuFrame, which frees the stock menu to show.
  "StackSplitFrame.xml",
  // Stock TOC lines 50-51: the zone and sub-zone banners (ZoneTextFrame, SubZoneTextFrame) over
  // FadingFrame.lua's fade, driven by the seam's ZONE_CHANGED/ZONE_CHANGED_NEW_AREA and its
  // GetZoneText/GetSubZoneText/GetZonePVPInfo; no native banner duplicates them. ZoneText.xml's third
  // root, AutoFollowStatus, stays hidden until FollowUnit's AUTOFOLLOW_BEGIN/END exist (plan item 5.18).
  // FadingFrame first: ZoneText_OnLoad calls FadingFrame_OnLoad. Measured over the canned seam: +4 files
  // (FadingFrame.xml/.lua, ZoneText.xml/.lua), +9,692 B, +8 widgets, 0 new Lua errors
  // (tests/framexml-zonetext-vertical.test.mjs); kept in the addonsOnly mode too — the four new
  // entries of slice A2-1 together cost +69 to +112 ms of a ~3.6 s Node boot (median of 7
  // alternating runs, twice), inside its ±300 ms spread.
  "FadingFrame.xml",
  "ZoneText.xml",
  "BattlefieldFrame.xml",
  "MainMenuBar.xml",
  // The stock row is loaded directly after its MainMenuBar owner. FrameXmlWorldMount hides all
  // ten buttons before session exercise, installs host-owned callbacks, and reveals them only
  // after the complete row/native replacement gate passes.
  "MainMenuBarMicroButtons.xml",
  // UIParent_ManageFramePositions (also called by the stance bar) anchors this stock alert.
  "TutorialFrame.xml",
  "Minimap.xml",
  "GameTime.xml",
  "Cooldown.xml",
  "ActionButtonTemplate.xml",
  "ActionBarFrame.xml",
  "MultiActionBars.xml",
  "BuffFrame.xml",
  // Stock TOC line 64: CombatFeedback.lua's hit indicator over the Player/Target/Pet portraits
  // (CombatFeedback_Initialize/_OnCombatEvent/_OnUpdate, the UNIT_COMBAT handlers of PlayerFrame,
  // TargetFrame and PetFrame) and LowHealthFrame. FrameXmlHudMechanics.ts fires UNIT_COMBAT from
  // the world's combat packets. Measured over the canned seam together with TotemFrame.xml below:
  // +4 files, +15,025 B, +35 widgets, 0 new Lua errors.
  "CombatFeedback.xml",
  "CastingBarFrame.xml",
  // Stock TOC line 66: UnitPopup, the unit menus. FriendsFrame's rows and chat's player links open
  // FriendsDropDown, whose only initializer is UnitPopup_ShowMenu (FriendsFrame.lua:177-190) — the
  // one stock way to whisper, invite, set a note or remove a friend. The Player/Target/Party frames'
  // dropdowns use the same function. No frame of its own. Measured over the canned seam: +2 files,
  // +64,100 B, +22 widgets (DropDownList buttons 20 → 22, with their parts: the unit frames'
  // load-time menu initializers now add entries), 0 new Lua errors.
  "UnitPopup.xml",
  "UnitFrame.xml",
  "HistoryKeeper.lua",
  "ChatFrame.xml",
  "FloatingChatFrame.xml",
  "VoiceChat.xml",
  "ReadyCheck.xml",
  "PlayerFrame.xml",
  "PartyFrame.xml",
  "TargetFrame.xml",
  // Stock TOC line 78: the totem bar under PlayerFrame (TotemFrame, TotemFrameTotem1-4), whose
  // TotemFrame_Update PetFrame.lua already called into nil. GetTotemInfo/GetTotemTimeLeft/
  // DestroyTotem and PLAYER_TOTEM_UPDATE are FrameXmlHudMechanics.ts's. Measured with
  // CombatFeedback.xml above.
  "TotemFrame.xml",
  "PetFrame.xml",
  "SpellBookFrame.xml",
  "CharacterFrame.xml",
  // Stock TOC line 83: the 3.3.5 equipment manager's Lua — the EquipmentManager frame
  // (WEAR_EQUIPMENT_SET, the bag-space table) and the packed-location helpers PaperDollFrame's
  // item flyout and GearManagerDialog call (EquipmentManager_UnpackLocation, _EquipSet). No XML
  // of its own; without it the gear manager's buttons raise on every click (FrameXmlEquipmentSets.ts).
  "EquipmentManager.lua",
  "PaperDollFrame.xml",
  // Stock TOC line 85: the «Питомцы» tab (CharacterFrame tab 2) — the pet page and the Companions
  // and Mounts sub-tabs. Its C API is FrameXmlCompanions.ts; stock PetPaperDollFrame_UpdateIsAvailable
  // now owns the tab's visibility, evaluated once after the session events (FrameXmlBoot.ts).
  // Measured over the canned seam: +2 files (PetPaperDollFrame.xml/.lua), +57,168 B. The tab's
  // geometry and visibility are pinned by tests/framexml-custom-class-vertical.test.mjs (B13), the
  // companion C API by tests/framexml-companions.test.mjs, and the Companions/Mounts sub-tabs,
  // their CompanionButtons and the summon button's CallCompanion/DismissCompanion by
  // tests/framexml-pet-companions-vertical.test.mjs.
  "PetPaperDollFrame.xml",
  // SkillFrame is the first concrete optional CharacterFrame tab in this bounded closure. Its
  // relative SkillFrame.lua is reached by the loader rule. OptionsPanelTemplates.xml is retained
  // above for the SpellBook rank filter; the stock SkillSortButton remains commented out in this
  // client build and does not widen the closure by itself.
  "SkillFrame.xml",
  "ReputationFrame.xml",
  // HonorFrame is a stock CharacterFrame child at TOC position 88, not a CharacterFrame tab.
  // Its XML Include reaches HonorFrameTemplates.xml and its relative script reaches HonorFrame.lua.
  "HonorFrame.xml",
  "QuestFrame.xml",
  "QuestPOI.xml",
  "WatchFrame.xml",
  "QuestLogFrame.xml",
  "QuestInfo.xml",
  "MerchantFrame.xml",
  // Stock TOC line 95: TradeFrame and its fourteen item slots (FrameXmlTrade.ts/FrameXmlTradeOwner.ts).
  // Its templates are all in the vertical already (ItemButtonTemplate, MoneyInputFrame).
  "TradeFrame.xml",
  "ContainerFrame.xml",
  // Stock TOC line 97: LootFrame, LootButton1-4, GroupLootDropDown and GroupLootFrame1-4, the loot
  // window and group-loot rolls (FrameXmlLoot.ts/FrameXmlLootOwner.ts). Measured over the canned
  // seam: +2 files (LootFrame.xml/.lua), +29,279 B, +174 widgets, 0 new Lua errors.
  "LootFrame.xml",
  // Stock TOC lines 98-99: the book/letter reader and the flight map (FrameXmlItemText.ts,
  // FrameXmlTaxi.ts; owners FrameXmlItemTextOwner.ts/FrameXmlTaxiOwner.ts). Both roots are hidden.
  // Measured over the canned seam: ItemText +2 files, +13,306 B, +48 widgets; Taxi +2 files,
  // +12,260 B, +13 widgets (its node buttons are created on the first map); 0 new Lua errors.
  "ItemTextFrame.xml",
  "TaxiFrame.xml",
  // Container anchors used by UIParent's stance layout query this concrete stock frame; since the
  // NPC lane it is also the bank window once FrameXmlBankOwner.ts's gate publishes it.
  "BankFrame.xml",
  // Stock TOC lines 101-102: FriendsFrame (Friends/Ignore, Who, Guild tabs, AddFriendFrame,
  // FriendsFriendsFrame) and RaidFrame, the Raid tab (FrameXmlFriends.ts/FrameXmlFriendsOwner.ts).
  // RaidFrame is required: FriendsFrame_ShowSubFrame shows/hides `_G.RaidFrame` unconditionally.
  // ChannelFrame.xml below declares parent="FriendsFrame" — the Chat tab — so it must follow them.
  // All three roots are hidden. Measured over the canned seam: +4 files, +330,685 B, +2,179 widgets,
  // 0 new Lua errors.
  "FriendsFrame.xml",
  "RaidFrame.xml",
  "ChannelFrame.xml",
  // The stance layout calls ShowPetActionBar from this stock dependency. Its commands retain
  // their native owner until the original pet action API is connected.
  "PetActionBarFrame.xml",
  "BonusActionBarFrame.xml",
  "MainMenuBarBagButtons.xml",
  "WorldMapFrame.xml",
  // Root-level add-ons commonly hook the stock hyperlink tooltip objects during their top-level
  // Lua execution. ItemRef.xml is their native owner and sits at line 110 of the 3.3.5a TOC, so it
  // must exist before enabled add-ons run rather than being replaced with host-created stand-ins.
  "ItemRef.xml",
  "ComboFrame.xml",
  // Stock TOC lines 112-114: the tabard designer, the guild charter vendor and the charter window
  // (FrameXmlTabard.ts, FrameXmlRegistrar.ts, FrameXmlPetition.ts; owners in the matching *Owner.ts).
  // All three roots are hidden `left` panels, opened only by their own events. Measured over the
  // canned seam with ArenaRegistrarFrame below: +8 files, +89,548 B, +450 widgets, 0 new Lua errors.
  "TabardFrame.xml",
  "GuildRegistrarFrame.xml",
  "PetitionFrame.xml",
  "ColorPickerFrame.xml",
  // Stock TOC line 118: GossipFrame, the NPC conversation (FrameXmlGossip.ts/FrameXmlGossipOwner.ts);
  // its confirm/code dialogs are StaticPopup.xml's. Hidden root. Measured over the canned seam:
  // +2 files, +25,730 B, +168 widgets (32 title buttons), 0 new Lua errors.
  "GossipFrame.xml",
  // Stock TOC line 119 (after GossipFrame, 118): MailFrame, OpenMailFrame and StationeryPopupFrame
  // (FrameXmlMail.ts/FrameXmlMailOwner.ts). Its tab template is FriendsFrame.xml's, served by
  // FrameXmlMailCorpus.ts while FriendsFrame.xml is outside this vertical.
  "MailFrame.xml",
  // Stock TOC line 120 (after MailFrame, 119): PetStableFrame, the hunter's stable (FrameXmlStable.ts/
  // FrameXmlStableOwner.ts); its purchase dialog is StaticPopup.xml's. Hidden root. Measured over the
  // canned seam: +2 files, +20,218 B, +94 widgets, 0 new Lua errors.
  "PetStable.xml",
  "WorldStateFrame.xml",
  // Stock TOC line 123: DressUpFrame, the dressing room behind Ctrl+click's DressUpItemLink
  // (FrameXmlDressUp.ts/FrameXmlDressUpMount.ts). Hidden root. Blizzard_AuctionDressUp.lua captures
  // this file's DressUpItemLink at its load, so it has to be in the boot vertical, before the LoD add-on.
  "DressUpFrame.xml",
  // The battleground closure keeps the retail order: BattlefieldFrame supplies shared queue
  // templates, PVPFrame owns the parent/honor page, and PVPBattlegroundFrame is the second tab.
  // ArenaFrame follows PVPBattlegroundFrame in the retail TOC and is the one stock owner of the
  // battlemaster arena queue page. ArenaRegistrarFrame (stock TOC 129) follows it: the arena charter
  // vendor and PVPBannerFrame, over the charter packets (FrameXmlRegistrar.ts, FrameXmlRegistrarOwner.ts).
  // Trainer templates are a stock dependency of Blizzard_TrainerUI and precede PVP in FrameXML.toc.
  "ClassTrainerFrameTemplates.xml",
  "PVPFrame.xml",
  "PVPBattlegroundFrame.xml",
  "ArenaFrame.xml",
  "ArenaRegistrarFrame.xml",
  // The stock dungeon finder, stock TOC 130-132, after ArenaRegistrarFrame (129).
  // LFGFrame.xml owns the shared role/choice templates and LFGEventFrame; LFDFrame.xml the finder,
  // its ready/role-check popups and LFDSearchStatus (parented to Minimap.xml's MiniMapLFGFrame).
  // LFRFrame.xml is loaded but never routed — TrinityCore 3.3.5 has no raid-browser protocol — because
  // LFGFrame.lua touches LFRParentFrame and its role buttons unconditionally: without it the load
  // raises «global 'LFRParentFrame'». Measured over the canned seam: +6 files, +188,270 B,
  // +1,024 widgets, 0 new Lua errors.
  "LFGFrame.xml",
  "LFDFrame.xml",
  "LFRFrame.xml",
  // Stock TOC line 138: the death knight's six runes under PlayerFrame (FrameXmlRunes.ts answers
  // GetRuneType/GetRuneCooldown and fires RUNE_POWER_UPDATE/RUNE_TYPE_UPDATE). Not optional, in the
  // addonsOnly mode either: UnitFrame_SetUnit (UnitFrame.lua:64-77) calls RuneFrame:SetScale for a
  // death knight's PlayerFrame and PetFrame unconditionally, so without the file PLAYER_ENTERING_WORLD
  // raised and PlayerFrame_ToPlayerArt stopped at its first line. RuneFrame_OnLoad hides it for
  // every other class. Measured over the canned seam as a death knight: +2 files, +10,620 B,
  // +43 widgets, one Lua error fewer (that raise); as the canned warrior 0 new Lua errors
  // (tests/framexml-rune-vertical.test.mjs).
  "RuneFrame.xml",
  // Stock TOC line 139: EasyMenu/EasyMenu_Initialize, the menu-table front of UIDropDownMenu.lua that
  // Blizzard_CombatLog.xml:85 and third-party add-ons open their menus with. Lua only. Measured over
  // the canned seam: +1 file, +1,009 B, 0 widgets, 0 new Lua errors (tests/framexml-easymenu-vertical.test.mjs).
  "EasyMenu.lua",
  // CharacterFrame.lua toggles this real player-frame child while the character sheet is shown.
  // It is a stock XML dependency, not a synthetic placeholder; retain its late retail TOC slot.
  "AlternatePowerBar.xml",
]);

/**
 * The options chain: stock TOC lines 37-45 without OptionsPanelTemplates.xml (line 39), which the
 * vertical carries for SpellBook's rank filter. It is not load-on-demand in 3.3.5, but nothing in
 * the HUD needs its frames, so FrameXmlOptionsOwner.ts loads it into the running VM on the first
 * open of «Изображение», «Звук» or «Интерфейс» instead of at boot.
 *
 * Measured at boot over the MPQ vertical and the canned seam (Node, median of 5 alternating runs):
 * +17 files, +410,196 B, +2,479 widgets, 0 new Lua errors, 2,201 → 2,539 ms (+338 ms, +15.4 %) —
 * before the browser's 17 extra requests and the first sync's DOM for those widgets. Loaded late,
 * the same files add nothing to the boot; the first open pays once: 419 ms in Node (median of 5,
 * with the «WebClient» category), 0.8-0.9 s on the rich route with no task over 143 ms.
 */
export const FRAMEXML_OPTIONS_TOC: readonly string[] = Object.freeze([
  "Sound.lua",
  "OptionsFrameTemplates.xml",
  "VideoOptionsFrame.xml",
  "VideoOptionsPanels.xml",
  "AudioOptionsFrame.xml",
  "AudioOptionsPanels.xml",
  "InterfaceOptionsFrame.xml",
  "InterfaceOptionsPanels.xml",
]);

/**
 * A provider that answers a synthetic TOC listing a chosen subset of the real one.
 *
 * The same trick `singleFileTocProvider` uses and for the same reason: the loader is handed a real
 * TOC that happens to be short, so `Include`, `Script` and `..` resolution all keep working and the
 * stub plan is derived from exactly the files that will run.
 */
export function subsetTocProvider(
  source: GlueFileProvider,
  entries: readonly string[],
  tocPath = "interface/framexml/__subset.toc",
): { readonly provider: GlueFileProvider; readonly toc: string } {
  const key = normalizeGluePath(tocPath);
  const body = `## Interface: 30300\n${entries.join("\n")}\n`;
  const files = frameXmlMailCorpusSource(source, entries);
  return {
    toc: key,
    provider: {
      async read(path: string): Promise<string | undefined> {
        if (normalizeGluePath(path) === key) return body;
        return await files.read(path);
      },
    },
  };
}

type TsAddonMarker = { readonly kind: "begin" | "end"; readonly name: string };

function tsAddonMarker(line: string): TsAddonMarker | undefined {
  const lib = /^\s*##\s*tsaddon-(begin|end)-lib\s*$/i.exec(line);
  if (lib) return { kind: lib[1]!.toLowerCase() as "begin" | "end", name: "__lib__" };
  const module = /^\s*##\s*tsaddon-(begin|end)\s*:\s*(\S+)\s*$/i.exec(line);
  if (!module) return undefined;
  return { kind: module[1]!.toLowerCase() as "begin" | "end", name: module[2]!.toLowerCase() };
}

/**
 * Copy the complete generated TSWoW blocks out of the winning FrameXML TOC.
 *
 * A production subset still has to execute the server's shared Lua runtime and module entries in
 * their authored order.  Keeping the marker lines matters too: FrameXmlAddonRuntime derives its
 * already-loaded module list from them.  A truncated or mismatched block is discarded rather than
 * executing half a generated module.
 */
export function frameXmlTsAddonBlocks(toc: string): readonly {
  readonly name: string;
  readonly lines: readonly string[];
}[] {
  const result: { readonly name: string; readonly lines: readonly string[] }[] = [];
  let current: { readonly name: string; readonly lines: string[] } | undefined;
  for (const line of toc.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const marker = tsAddonMarker(line);
    if (!current) {
      if (marker?.kind === "begin") current = { name: marker.name, lines: [line] };
      continue;
    }
    if (marker?.kind === "begin") {
      // A generated TOC should never nest blocks. Restarting here prevents a broken first block
      // from swallowing every valid module that follows it.
      current = { name: marker.name, lines: [line] };
      continue;
    }
    current.lines.push(line);
    if (marker?.kind !== "end") continue;
    if (marker.name === current.name) result.push(current);
    current = undefined;
  }
  return result;
}

export function frameXmlTsAddonTocLines(toc: string): readonly string[] {
  return frameXmlTsAddonBlocks(toc).flatMap((block) => block.lines);
}

/**
 * The measured stock vertical plus every complete TSWoW block from the active, winning TOC.
 *
 * The source provider is the gateway's MPQ overlay, so reading FRAMEXML_TOC_PATH here observes the
 * same locale/base precedence as every file the generated block names.  The body is memoized: scan
 * and load both request the synthetic TOC, but the winning TOC needs only one gateway read.
 */
export function subsetWithActiveTsAddonsTocProvider(
  source: GlueFileProvider,
  entries: readonly string[],
  tocPath = "interface/framexml/__subset-with-tsaddons.toc",
): { readonly provider: GlueFileProvider; readonly toc: string } {
  const key = normalizeGluePath(tocPath);
  let body: Promise<string> | undefined;
  const build = async (): Promise<string> => {
    const activeToc = await source.read(FRAMEXML_TOC_PATH);
    const addonLines = activeToc ? frameXmlTsAddonTocLines(activeToc) : [];
    const lines = ["## Interface: 30300", ...entries, ...addonLines];
    return `${lines.join("\n")}\n`;
  };
  const files = frameXmlMailCorpusSource(source, entries);
  return {
    toc: key,
    provider: {
      async read(path: string): Promise<string | undefined> {
        if (normalizeGluePath(path) === key) return await (body ??= build());
        return await files.read(path);
      },
    },
  };
}

/**
 * A provider that answers one synthetic TOC naming a single file.
 *
 * `?file=UIParent.lua` is how a later slice iterates on one subtree without paying for the other
 * 333 files, and the cheapest honest way to get there is to hand the real loader a real TOC that
 * happens to have one line in it. Everything else falls through to the corpus, so the file's own
 * `Include`s and `Script`s still resolve.
 */
export function singleFileTocProvider(
  source: GlueFileProvider,
  file: string,
  tocPath = "interface/framexml/__single.toc",
): { readonly provider: GlueFileProvider; readonly toc: string } {
  const key = normalizeGluePath(tocPath);
  const directory = key.slice(0, key.lastIndexOf("/") + 1);
  const normalized = normalizeGluePath(file);
  // Two spellings are accepted: a bare name (`UIParent.lua`), which resolves beside the synthetic
  // TOC, and a full interface path (`Interface\SharedXML\Foo.lua`), which has to climb back out of
  // `interface/framexml/` first. Both are written as a TOC *reference* and resolved by the loader's
  // own `..` rule, so a path that would escape the interface tree is refused there rather than
  // being smuggled in through a file this module made up.
  const relative = (normalized.startsWith("interface/") ? `../../${normalized}` : normalized)
    .replaceAll("/", "\\");
  const line = resolveGluePath(directory, relative) ? relative : "";
  return {
    toc: key,
    provider: {
      async read(path: string): Promise<string | undefined> {
        if (normalizeGluePath(path) === key) return line ? `${line}\n` : "";
        return await source.read(path);
      },
    },
  };
}
