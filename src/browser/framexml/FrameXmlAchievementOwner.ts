/**
 * Stock AchievementFrame as the achievement window: the gate and the lazy, load-on-demand owner.
 * The C API is FrameXmlAchievement.ts; the mount's wiring (micro button, Escape, the gateway
 * catalog) is FrameXmlAchievementMount.ts.
 *
 * Blizzard_AchievementUI is load-on-demand, and the first open of a session — the micro button,
 * a Lua `ToggleAchievementFrame`, a toast for an achievement just earned, «Сравнить достижения» —
 * loads it through the host path the trainer and auction windows use: the catalog first (the
 * add-on's summary bars read `GetCategoryInfo` in their OnLoad), then AlertFrames.xml, then
 * `boot.loadAddon` → `renderer.addRoots` → `renderer.sync` → gate → `model.owned`. Lua's LoadAddOn is
 * only a status view here, so stock's own `AchievementFrame_LoadUI` callers are routed to this
 * owner. Nothing is read at boot.
 *
 * AlertFrames.xml is the stock owner of the achievement toast (AchievementAlertFrameTemplate,
 * AchievementAlertFrame_ShowAlert, and AlertFrame, which answers ACHIEVEMENT_EARNED) and sits in
 * the retail FrameXML.toc, but outside this bounded vertical; its toast calls
 * AchievementShield_SetPoints from the add-on, so the two load together. Its other alert
 * (DungeonCompletionAlertFrame1, LFG_COMPLETION_REWARD) stays inert: nothing fires that event
 * (FrameXmlLfd.ts keeps the dungeon reward on its native prompt).
 *
 * There is no native achievement window. A failed load or gate leaves the stock frames hidden and
 * the owner failed for the session; the micro button goes back to disabled. A catalog the gateway
 * does not serve yet only refuses that attempt: nothing is loaded, and the next open asks again.
 */
import { GlueLoader, normalizeGluePath, type GlueFileProvider } from "../glue/GlueLoader.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlAchievementModel } from "./FrameXmlAchievement.js";
import type { FrameXmlAchievementOwner } from "./FrameXmlAchievementController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export const FRAMEXML_ACHIEVEMENT_ADDON = "Blizzard_AchievementUI";
/** A one-line TOC naming the stock AlertFrames.xml, read through the boot's own corpus. */
const ALERT_FRAMES_TOC = "interface/framexml/webclient-alertframes.toc";

/** Named stock frames the window needs: widget type, the ancestor it lives in, its scripts. */
const ACHIEVEMENT_FRAMES: readonly (readonly [name: string, type: string, ancestor: string, scripts: readonly string[]])[] = [
  ["AchievementFrame", "Frame", "UIParent", ["OnShow", "OnHide"]],
  ["AchievementFrameCloseButton", "Button", "AchievementFrame", ["OnClick"]],
  ["AchievementFrameTab1", "Button", "AchievementFrame", ["OnClick"]],
  ["AchievementFrameTab2", "Button", "AchievementFrame", ["OnClick"]],
  ["AchievementFrameHeaderPoints", "FontString", "AchievementFrame", []],
  ["AchievementFrameCategories", "Frame", "AchievementFrame", ["OnEvent"]],
  ["AchievementFrameCategoriesContainer", "ScrollFrame", "AchievementFrameCategories", []],
  ["AchievementFrameCategoriesContainerButton1", "Button", "AchievementFrameCategoriesContainer", ["OnClick"]],
  ["AchievementFrameCategoriesContainerButton2", "Button", "AchievementFrameCategoriesContainer", ["OnClick"]],
  ["AchievementFrameAchievements", "Frame", "AchievementFrame", ["OnEvent"]],
  ["AchievementFrameAchievementsContainer", "ScrollFrame", "AchievementFrameAchievements", []],
  ["AchievementFrameAchievementsContainerButton1", "Button", "AchievementFrameAchievementsContainer", ["OnClick"]],
  ["AchievementFrameStats", "Frame", "AchievementFrame", ["OnEvent"]],
  ["AchievementFrameStatsContainer", "ScrollFrame", "AchievementFrameStats", []],
  ["AchievementFrameStatsContainerButton1", "Button", "AchievementFrameStatsContainer", ["OnClick"]],
  ["AchievementFrameSummary", "Frame", "AchievementFrame", ["OnShow"]],
  ["AchievementFrameSummaryCategoriesStatusBar", "StatusBar", "AchievementFrameSummary", []],
  ["AchievementFrameComparison", "Frame", "AchievementFrame", ["OnEvent", "OnShow", "OnHide"]],
  ["AchievementFrameFilterDropDown", "Frame", "AchievementFrame", []],
];

/** The registrations the model's events reach (Blizzard_AchievementUI.lua:635-637, :1633, :2306-2307). */
const ACHIEVEMENT_EVENTS: readonly (readonly [frame: string, events: readonly string[]])[] = [
  ["AchievementFrameAchievements", ["ACHIEVEMENT_EARNED", "CRITERIA_UPDATE", "TRACKED_ACHIEVEMENT_UPDATE"]],
  ["AchievementFrameStats", ["CRITERIA_UPDATE"]],
  ["AchievementFrameComparison", ["ACHIEVEMENT_EARNED", "INSPECT_ACHIEVEMENT_READY"]],
];

/** A unit token stock's own callers pass (UnitPopup's menus): letters and a small index. */
const UNIT_TOKEN = /^[a-z]{1,16}\d{0,2}$/;

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  for (let current: FrameXmlFrame | undefined = frame; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function dataAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) return value;
  const key = name.slice(5).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
  return element.dataset?.[key] ?? null;
}

function renderedFrameElement(element: HTMLElement | undefined, frame: FrameXmlFrame): element is HTMLElement {
  return !!element && dataAttribute(element, "data-framexml-name") === frame.name
    && dataAttribute(element, "data-framexml-type") === frame.type;
}

export interface FrameXmlAlertFramesResult {
  readonly ok: boolean;
  readonly roots: readonly FrameXmlFrame[];
  readonly loaded: readonly string[];
  readonly message?: string;
}

/**
 * Load the stock AlertFrames.xml (and its AlertFrames.lua) into the booted VM, once; a vertical
 * that already carries it answers at once. Read through `boot.corpus`, the boot's own cached
 * provider, under a one-line TOC so GlueLoader's Include/Script resolution is the corpus's.
 */
export async function loadFrameXmlAlertFrames(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "corpus">,
): Promise<FrameXmlAlertFramesResult> {
  if (boot.bridge.getFrame("AlertFrame")) return { ok: true, roots: [], loaded: [] };
  const provider: GlueFileProvider = {
    read: (path) => normalizeGluePath(path) === ALERT_FRAMES_TOC ? Promise.resolve("AlertFrames.xml\n") : boot.corpus.read(path),
  };
  const loader = new GlueLoader({ vm: boot.vm, bridge: boot.bridge, provider, maxFiles: 8, maxDepth: 4 });
  const result = await loader.load(ALERT_FRAMES_TOC);
  const problem = result.missing[0] !== undefined ? `missing ${result.missing[0]}`
    : result.diagnostics[0] ? `${result.diagnostics[0].file}: ${result.diagnostics[0].message}`
      : boot.bridge.getFrame("AlertFrame") ? undefined : "AlertFrame was not created";
  return problem === undefined
    ? { ok: true, roots: result.roots, loaded: result.loaded }
    : { ok: false, roots: result.roots, loaded: result.loaded, message: problem };
}

/**
 * Take every stock achievement frame off the screen after a failed gate or load: stock's own
 * HideUIPanel first (it frees UIParent's doublewide slot, and only hides a frame the gate's pass
 * showed outside the panel manager, UIParent.lua:1602-1640), the bridge if that fails too.
 */
function hideStockAchievementFrames(boot: Pick<FrameXmlBoot, "vm" | "bridge">): void {
  try {
    frameXmlSilentProbe(boot, "webclient/achievement-aside", `
      if type(AchievementFrame) == "table" and AchievementFrame:IsShown() then HideUIPanel(AchievementFrame) end
      return 1
    `, 1);
  } catch { /* the bridge below */ }
  for (const name of ["AchievementFrame", "AchievementAlertFrame1", "AchievementAlertFrame2"]) {
    const frame = boot.bridge.getFrame(name);
    if (frame?.visible) boot.bridge.Hide(frame);
  }
}

export interface FrameXmlAchievementGateResult {
  readonly frame: FrameXmlFrame;
}

/**
 * Structural, rendered and transactional proof that the loaded Blizzard_AchievementUI can be the
 * achievement window.
 *
 * Every named control must be the stock widget inside AchievementFrame with its scripts, the
 * HybridScrollFrame buttons the add-on's ADDON_LOADED created must exist, AchievementFrame and its
 * first rows must be rendered, and the registrations the model fires must be in place. Then one
 * silent pass opens the window the micro button's way (the summary) outside UIParent's panel
 * manager, visits Statistics, returns, opens the first real category and closes again; any new Lua
 * error or bridge diagnostic, or a page that did not switch, fails it. The pass leaves the window
 * as a first open finds it (`wasShown` cleared, the summary selected, every category collapsed) and
 * every other panel as it was.
 */
export function frameXmlAchievementGate(
  seam: { readonly achievement?: FrameXmlAchievementModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
  /** Told which check refused, for the owner's warning. */
  refused: (reason: string) => void = () => {},
): FrameXmlAchievementGateResult | undefined {
  let passStarted = false;
  const refuse = (reason: string): undefined => { refused(reason); return undefined; };
  try {
    if (!seam.achievement?.catalog) return refuse("no catalog");
    const frames = new Map<string, FrameXmlFrame>();
    const lookup = (name: string): FrameXmlFrame | undefined => frames.get(name) ?? boot.bridge.getFrame(name);
    for (const [name, type, ancestorName, scripts] of ACHIEVEMENT_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      const ancestor = lookup(ancestorName);
      if (!frame || !ancestor || frame.type !== type || frame === ancestor || !frameDescendsFrom(frame, ancestor)
        || !scripts.every((script) => boot.bridge.hasScript(frame, script))) return refuse(`${name} is not the stock ${type}`);
      frames.set(name, frame);
    }
    const root = frames.get("AchievementFrame")!;
    if (root.parent?.name !== "UIParent" || root.visible) return refuse("AchievementFrame is not a hidden UIParent child");
    // Frames the XML itself creates (AchievementFrameAchievements' OnLoad makes its rows while the
    // tree is instantiated). The category rows are made on ADDON_LOADED, after the renderer may have
    // parked the hidden window; it draws them on the first show (measured on the RICH route: before
    // the first show AchievementFrameCategoriesContainerButton1 had no element, its siblings did).
    for (const name of ["AchievementFrame", "AchievementFrameTab1", "AchievementFrameCategoriesContainer",
      "AchievementFrameAchievementsContainerButton1"]) {
      const frame = frames.get(name)!;
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return refuse(`${name} is not rendered`);
    }
    for (const [name, events] of ACHIEVEMENT_EVENTS) {
      const frame = frames.get(name);
      if (!frame || !events.every((event) => frame.registeredEvents.has(event))) return refuse(`${name} misses its events`);
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    passStarted = true;
    // AchievementFrame_ToggleAchievementFrame's body with the frame's own Show/Hide in place of
    // ShowUIPanel/HideUIPanel: the window is UIParent's doublewide panel (Blizzard_AchievementUI.lua:1),
    // and the panel manager would close the player's open left/centre panels for it — a quest dialog,
    // a merchant — or refuse it outright under a fullscreen or centre one (the world map, the game
    // menu, the scoreboard; UIParent.lua:1341-1365). A load no player asked for (a toast) must do
    // neither. OnShow/OnHide still run.
    const probe = frameXmlSilentProbe(boot, "webclient/achievement-gate", `
      AchievementFrameComparison:Hide()
      AchievementFrameTab_OnClick = AchievementFrameBaseTab_OnClick
      AchievementFrame:Show()
      AchievementFrameTab_OnClick(1)
      local shown = (AchievementFrame:IsShown() and AchievementFrameSummary:IsShown()) and 1 or 0
      AchievementFrameTab_OnClick(2)
      local stats = (AchievementFrameStats:IsShown() and not AchievementFrameSummary:IsShown()) and 1 or 0
      AchievementFrameTab_OnClick(1)
      AchievementCategoryButton_OnClick(AchievementFrameCategoriesContainerButton2)
      local list = (AchievementFrameAchievements:IsShown() and not AchievementFrameSummary:IsShown()) and 1 or 0
      AchievementCategoryButton_OnClick(AchievementFrameCategoriesContainerButton1)
      AchievementFrame:Hide()
      AchievementFrame.wasShown = nil
      return shown, stats, list, AchievementFrame:IsShown() and 1 or 0
    `, 4);
    const [opened, stats, list, stillShown] = (probe ?? []).map((value) => Number(value));
    if (!probe || opened !== 1 || stats !== 1 || list !== 1 || stillShown !== 0 || root.visible
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) {
      hideStockAchievementFrames(boot);
      return refuse(`the silent pass answered ${JSON.stringify(probe ?? null)}, ${boot.errorCount - errors} Lua error(s), `
        + `${boot.bridge.diagnostics.length - diagnostics} diagnostic(s)`);
    }
    return { frame: root };
  } catch (error) {
    if (passStarted) {
      try { hideStockAchievementFrames(boot); } catch { /* the owner's failure path hides it too */ }
    }
    return refuse(String(error));
  }
}

/**
 * AchievementAlertFrameTemplate's icon frame inherits AchievementIconFrameTemplate and declares its
 * four textures again under the same `$parent` names (AlertFrames.xml:289-345). The client creates
 * both and the global names the later one; the bridge reports each re-declaration. Measured: these
 * four diagnostics per toast frame, and nothing else.
 */
const ALERT_ICON_REDECLARATION = /^duplicate FrameXML frame name "AchievementAlertFrame\d+Icon(?:Backfill|Bling|Texture|Overlay)"/;

/**
 * The toast's proof: AlertFrame answers ACHIEVEMENT_EARNED, and one silent AchievementAlertFrame_ShowAlert
 * for a catalog achievement shows AchievementAlertFrame1 with no new Lua error and no bridge diagnostic
 * beyond the template's own re-declared icon textures; the toast is hidden again at once. False leaves
 * AlertFrame unregistered, so the window keeps working without toasts.
 */
export function frameXmlAchievementAlertGate(
  seam: { readonly achievement?: FrameXmlAchievementModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
): boolean {
  const alert = boot.bridge.getFrame("AlertFrame");
  const sample = seam.achievement?.catalog?.achievements.keys().next().value;
  let passed = false;
  try {
    if (alert && alert.registeredEvents.has("ACHIEVEMENT_EARNED") && typeof sample === "number") {
      const errors = boot.errorCount;
      const diagnostics = boot.bridge.diagnostics.length;
      const probe = frameXmlSilentProbe(boot, "webclient/achievement-alert-gate", `
        if type(AchievementAlertFrame_ShowAlert) ~= "function" or type(AchievementShield_SetPoints) ~= "function" then return 0 end
        AchievementAlertFrame_ShowAlert(${sample})
        local frame = AchievementAlertFrame1
        local shown = (frame and frame:IsShown()) and 1 or 0
        if frame then frame:Hide() end
        return shown
      `, 1);
      const unexpected = boot.bridge.diagnostics.slice(diagnostics)
        .filter((diagnostic) => !ALERT_ICON_REDECLARATION.test(diagnostic.message));
      passed = Number(probe?.[0]) === 1 && boot.errorCount === errors && unexpected.length === 0
        && boot.bridge.getFrame("AchievementAlertFrame1")?.visible === false;
    }
  } catch {
    passed = false;
  }
  if (!passed && alert) {
    try { frameXmlSilentProbe(boot, "webclient/achievement-alert-off", `AlertFrame:UnregisterEvent("ACHIEVEMENT_EARNED") return 1`, 1); }
    catch { /* nothing registered, nothing to drop */ }
    const toast = boot.bridge.getFrame("AchievementAlertFrame1");
    if (toast?.visible) boot.bridge.Hide(toast);
  }
  return passed;
}

/**
 * Three in-lane adapters, each for a gap outside this lane that the stock window runs into:
 *
 * - The add-on anchors its panes and its objectives by name with a `$parent` prefix at run time —
 *   `AchievementFrameAchievements:SetPoint("TOPLEFT", "$parentCategories", "TOPRIGHT", 22, 0)` in the
 *   category scroll bar's Show/Hide (Blizzard_AchievementUI.lua:228-246), `objectives:SetPoint("TOP",
 *   "$parentHiddenDescription", …)` for the selected row (:1137-1165) — which the client resolves
 *   against the frame's parent's name. The widget binder looks the literal string up (GlueWidgets.ts
 *   anchorTarget) and, finding nothing, anchors to the parent: measured on the RICH route, the
 *   achievement list drew to the right of AchievementFrame instead of inside it. Those four frames
 *   resolve the prefix themselves, and the panes are re-anchored once; retire it once SetPoint does.
 * - AchievementProgressBarTemplate's OnLoad ends `self:GetStatusBarTexture():SetDrawLayer("BORDER")`
 *   (Blizzard_AchievementUI.xml:588), and the widget binder answers GetStatusBarTexture with the
 *   bar's texture path, not its Texture region (GlueWidgets.ts). Measured before this: «attempt to
 *   call a nil value (method 'SetDrawLayer')» once per progress bar created. While the answer is not
 *   a region, AchievementButton_GetProgressBar creates its bars with that one call answered by a
 *   sink, so the fill keeps its default layer; retire it once GetStatusBarTexture returns the region.
 * - WatchFrame reads `WATCHFRAME_FILTER_TYPE = tonumber(GetCVar("trackerFilter"))` on VARIABLES_LOADED
 *   (WatchFrame.lua:280), and this client answers nothing for that CVar, so the tracker's filter is
 *   nil and no tracked achievement is ever listed (WatchFrame.lua:637). The client registers
 *   trackerFilter with the default 7 (Wow.exe's CVar table: achievements, completed quests, other
 *   zones). Only the achievement bit is set here while the filter is still unset — the quest bits
 *   stay as they are measured today; the full default belongs to the CVar owner.
 */
export function installFrameXmlAchievementAdapters(boot: Pick<FrameXmlBoot, "vm">): boolean {
  const installed = frameXmlSilentProbe(boot, "webclient/achievement-adapters", `
    if type(AchievementButton_GetProgressBar) ~= "function" or type(AchievementFrameSummaryCategoriesStatusBar) ~= "table" then return 0 end
    local statusBars = getmetatable(AchievementFrameSummaryCategoriesStatusBar).__index
    if type(statusBars) == "table" and type(AchievementFrameSummaryCategoriesStatusBar:GetStatusBarTexture()) ~= "table" then
      local original = AchievementButton_GetProgressBar
      local sink = { SetDrawLayer = function() end }
      AchievementButton_GetProgressBar = function(index)
        if _G["AchievementFrameProgressBar" .. index] then return original(index) end
        local get = statusBars.GetStatusBarTexture
        statusBars.GetStatusBarTexture = function() return sink end
        local ok, frame = pcall(original, index)
        statusBars.GetStatusBarTexture = get
        if not ok then error(frame, 0) end
        return frame
      end
    end
    if WATCHFRAME_FILTER_TYPE == nil and type(WATCHFRAME_FILTER_ACHIEVEMENTS) == "number" then
      WATCHFRAME_FILTER_TYPE = WATCHFRAME_FILTER_ACHIEVEMENTS
    end
    local panes = { AchievementFrameAchievements, AchievementFrameStats, AchievementFrameComparison, AchievementFrameAchievementsObjectives }
    for _, frame in ipairs(panes) do
      if type(frame) ~= "table" then return 0 end
      local setPoint = frame.SetPoint
      frame.SetPoint = function(self, point, relative, ...)
        if type(relative) == "string" and relative:sub(1, 7) == "$parent" then
          local parent = self:GetParent()
          local name = parent and parent:GetName()
          relative = (name and _G[name .. relative:sub(8)]) or parent
        end
        return setPoint(self, point, relative, ...)
      end
    end
    local bar = AchievementFrameCategoriesContainerScrollBar
    if bar:IsShown() then bar:Show() else bar:Hide() end
    return 1
  `, 1);
  return Number(installed?.[0]) === 1;
}

/** What stock's own Lua entry points ask the host for (installed by the mount, before any load). */
export interface FrameXmlAchievementHostActions {
  toggle(stats: boolean): void;
  load(): void;
  compare(unit: string): void;
}

/**
 * Stock's LoD callers, routed to the owner: `ToggleAchievementFrame` (UIParent.lua:351, keeping
 * its own CanShowAchievementUI/HasCompletedAnyAchievement refusal), `AchievementFrame_LoadUI`
 * (UIParent.lua:304; a Lua LoadAddOn is only a status view here) and `InspectAchievements`
 * (UIParent.lua:346, UnitPopup's «Сравнить достижения»). Unbound, each would dereference an
 * AchievementFrame that no Lua call can load.
 */
export function installFrameXmlAchievementHostGlobals(
  boot: Pick<FrameXmlBoot, "vm">,
  actions: FrameXmlAchievementHostActions,
): void {
  boot.vm.registerGlobal("__fxAchievementToggle", (args) => { actions.toggle(args[0] !== undefined && args[0] !== null && args[0] !== false); return []; });
  boot.vm.registerGlobal("__fxAchievementLoad", () => { actions.load(); return []; });
  boot.vm.registerGlobal("__fxAchievementCompare", (args) => {
    if (typeof args[0] === "string") actions.compare(args[0]);
    return [];
  });
  boot.vm.execute(`
    ToggleAchievementFrame = function(stats)
      if ( not CanShowAchievementUI() or not HasCompletedAnyAchievement() ) then return end
      __fxAchievementToggle(stats)
    end
    AchievementFrame_LoadUI = function() __fxAchievementLoad() end
    InspectAchievements = function(unit) __fxAchievementCompare(unit) end
  `, "@webclient/achievement-owner");
}

/**
 * ItemRefTooltip:SetHyperlink for an `achievement:` link — the chat line's (ChatFrame's click reaches
 * SetItemRef, which falls through to ItemRefTooltip:SetHyperlink, ItemRef.lua) — as a per-frame Lua
 * field, while the widget binder draws only item and spell links (GlueWidgets.ts setGameTooltipLink):
 * measured before this, a click showed nothing. The widget method is asked first, so a binder that
 * learns achievement links wins and this retires itself. The client draws this tooltip in C++ (its
 * strings ACHIEVEMENT_TOOLTIP_COMPLETE / _IN_PROGRESS have no Lua caller); the layout here is stock's
 * own mini-achievement tooltip (Blizzard_AchievementUI.xml:401-414: the name, the description in white,
 * `|cff00ff00 - ` done / `|cff808080 - ` open criteria) with the link's own completion line, not a
 * measured copy of the client's. The link's fields are read, not the model's progress: a link is the
 * sender's snapshot. `player(guidHex)` names the link's player: `true` for this player, else the name.
 */
export function installFrameXmlAchievementLinkTooltip(
  boot: Pick<FrameXmlBoot, "vm">,
  player: (guid: string) => true | string | undefined,
): boolean {
  boot.vm.registerGlobal("__fxAchievementLinkPlayer", (args) => {
    const answer = typeof args[0] === "string" ? player(args[0]) : undefined;
    return answer === true ? [true] : answer === undefined ? [false] : [false, answer];
  });
  const installed = frameXmlSilentProbe(boot, "webclient/achievement-link", `
    if type(ItemRefTooltip) ~= "table" or type(ItemRefTooltip.SetHyperlink) ~= "function" then return 0 end
    if rawget(ItemRefTooltip, "__webclientAchievementLink") then return 1 end
    local base = ItemRefTooltip.SetHyperlink
    ItemRefTooltip.SetHyperlink = function(self, link, ...)
      if type(link) ~= "string" or strsub(link, 1, 12) ~= "achievement:" then return base(self, link, ...) end
      if base(self, link, ...) then return true end
      local id, guid, done, month, day, year = strsplit(":", strsub(link, 13))
      local masks = { select(7, strsplit(":", strsub(link, 13))) }
      local achievementID = tonumber(id) or 0
      local _, name, _, _, _, _, _, description, flags = GetAchievementInfo(achievementID)
      if not name then self:Hide() return false end
      if not self:IsShown() then self:SetOwner(UIParent, "ANCHOR_PRESERVE") end
      self:ClearLines()
      self:AddLine(name)
      if description and description ~= "" then self:AddLine(description, 1, 1, 1, 1) end
      local isSelf, who = __fxAchievementLinkPlayer(guid or "")
      if isSelf then who = UnitName("player") end
      if done == "1" then
        if who then self:AddLine(format(ACHIEVEMENT_TOOLTIP_COMPLETE, who, tonumber(month) or 0, tonumber(day) or 0, tonumber(year) or 0), GREEN_FONT_COLOR.r, GREEN_FONT_COLOR.g, GREEN_FONT_COLOR.b, 1) end
      else
        if who then self:AddLine(format(ACHIEVEMENT_TOOLTIP_IN_PROGRESS, who), NORMAL_FONT_COLOR.r, NORMAL_FONT_COLOR.g, NORMAL_FONT_COLOR.b, 1) end
        if bit.band(flags or 0, ACHIEVEMENT_FLAGS_HAS_PROGRESS_BAR) == 0 then
          for index = 1, math.min(GetAchievementNumCriteria(achievementID), 128) do
            local criterion = GetAchievementCriteriaInfo(achievementID, index)
            local mask = tonumber(masks[math.floor((index - 1) / 32) + 1]) or 0
            local met = math.floor(mask / 2 ^ ((index - 1) % 32)) % 2 == 1
            if criterion and criterion ~= "" then self:AddLine((met and "|cff00ff00 - " or "|cff808080 - ") .. criterion) end
          end
        end
      end
      self:Show()
      return true
    end
    rawset(ItemRefTooltip, "__webclientAchievementLink", true)
    return 1
  `, 1);
  return Number(installed?.[0]) === 1;
}

export interface FrameXmlLazyAchievementOwner extends FrameXmlAchievementOwner {
  /** Start the load with nothing to show after it (a toast's, a Lua AchievementFrame_LoadUI). */
  begin(): void;
  /** «Сравнить достижения» for a unit: AchievementFrame_DisplayComparison, loading first. */
  compare(unit: string): boolean;
  /** Teardown: hide the stock window. */
  hide(): void;
  /** Settles when the current load attempt has finished (tests, the preview). */
  readonly settled: Promise<void>;
  readonly loaded: boolean;
  readonly failed: boolean;
  /** Why the owner failed, for the micro button's title. */
  readonly failure: string | undefined;
}

type PendingIntent = { readonly kind: "toggle"; readonly stats: boolean } | { readonly kind: "compare"; readonly unit: string };

export interface FrameXmlAchievementOwnerHooks {
  /** The owner gave up for the session; `requested` when a player's action was waiting on the load. */
  onFailure?(reason: string, requested: boolean): void;
  /** This attempt found no catalog and loaded nothing; the next one retries. */
  onRefused?(reason: string, requested: boolean): void;
  /** The gate passed: stock owns the window (the micro button can follow HasCompletedAnyAchievement). */
  onLoaded?(): void;
}

/**
 * The lazy owner. The first toggle, toast or comparison starts the load; the intent the player
 * asked for last runs once the gate has passed (a second press while it loads cancels the first).
 */
export function createLazyFrameXmlAchievementOwner(
  seam: { readonly achievement?: FrameXmlAchievementModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "loadAddon" | "corpus">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
  hooks: FrameXmlAchievementOwnerHooks = {},
): FrameXmlLazyAchievementOwner {
  const model = seam.achievement;
  let frame: FrameXmlFrame | undefined;
  let pending: Promise<void> | undefined;
  let settled: Promise<void> = Promise.resolve();
  let failure: string | undefined = model ? undefined : "no achievement model";
  let disposed = false;
  let intent: PendingIntent | undefined;
  const loadRequest = (): void => owner.begin();
  const fail = (reason: string): void => {
    if (disposed || failure !== undefined) return;
    failure = reason;
    const requested = intent !== undefined;
    intent = undefined;
    if (model) {
      if (model.onLoadRequest === loadRequest) model.onLoadRequest = undefined;
      model.owned = false;
      model.available = false;
    }
    try { hideStockAchievementFrames(boot); } catch { /* a torn VM shows nothing */ }
    hooks.onFailure?.(reason, requested);
  };
  // The catalog is the gateway's, and the gateway may not serve it yet (a running gateway older than
  // the route answers 404 until it is restarted): this attempt is refused, nothing was loaded, and the
  // next toggle or toast asks again. The toasts that waited for it are dropped, not replayed later.
  const refuse = (reason: string): void => {
    if (disposed) return;
    const requested = intent !== undefined;
    intent = undefined;
    model?.discardQueuedEarned();
    hooks.onRefused?.(reason, requested);
  };
  const run = (next: PendingIntent): void => {
    if (next.kind === "toggle") {
      boot.vm.executeReported(`AchievementFrame_ToggleAchievementFrame(${next.stats ? "true" : ""})`, "@webclient/achievement-toggle");
    } else {
      boot.vm.executeReported(`AchievementFrame_DisplayComparison("${next.unit}")`, "@webclient/achievement-compare");
    }
  };
  const load = async (): Promise<void> => {
    try {
      if (!model) { fail("no achievement model"); return; }
      // The add-on's summary bars read GetCategoryInfo in their OnLoad: the catalog comes first.
      const catalog = await model.loadCatalog();
      if (disposed) return;
      if (!catalog) {
        const source = model.catalogSource as { failure?: string } | undefined;
        refuse(`achievement catalog: ${source?.failure ?? "unavailable"}`);
        return;
      }
      const alerts = await loadFrameXmlAlertFrames(boot);
      if (disposed) return;
      const result = await boot.loadAddon(FRAMEXML_ACHIEVEMENT_ADDON);
      if (disposed) return;
      if (!result.ok) { fail(`${FRAMEXML_ACHIEVEMENT_ADDON}: ${result.message ?? result.status}`); return; }
      renderer.addRoots([...alerts.roots, ...result.roots]);
      // AchievementFrame is UIParent's child, so its roots are only the objectives frame: reconcile.
      renderer.sync();
      if (!installFrameXmlAchievementAdapters(boot)) { fail("the stock AchievementButton_GetProgressBar is missing"); return; }
      let refusal = "";
      const gate = frameXmlAchievementGate(seam, boot, renderer, (reason) => { refusal = reason; });
      if (!gate) { fail(`the stock AchievementFrame tree did not pass its gate: ${refusal}`); return; }
      frame = gate.frame;
      if (!alerts.ok || !frameXmlAchievementAlertGate(seam, boot)) {
        console.warn(`[FrameXML achievements] the achievement toast is off: ${alerts.message ?? "its gate failed"}`);
      }
      // The edge: the ACHIEVEMENT_EARNED a toast was waiting for, then what the player asked for.
      model.owned = true;
      hooks.onLoaded?.();
      const next = intent;
      intent = undefined;
      if (next) run(next);
    } catch (error) {
      fail(`${FRAMEXML_ACHIEVEMENT_ADDON}: ${String(error)}`);
    }
  };
  const start = (): void => {
    if (disposed || failure !== undefined || pending || frame) return;
    pending = load().finally(() => { pending = undefined; });
    settled = pending;
  };
  const request = (next: PendingIntent): boolean => {
    if (disposed || failure !== undefined) return false;
    if (frame) {
      run(next);
      return true;
    }
    // A second press of the same toggle while the add-on loads takes the first one back.
    intent = intent?.kind === "toggle" && next.kind === "toggle" && intent.stats === next.stats ? undefined : next;
    start();
    return true;
  };
  const owner: FrameXmlLazyAchievementOwner = {
    get loaded() { return frame !== undefined && failure === undefined; },
    get failed() { return failure !== undefined; },
    get failure() { return failure; },
    get settled() { return settled; },
    begin: start,
    isOpen: () => !disposed && failure === undefined && frame !== undefined && boot.bridge.isVisible(frame),
    toggle: (stats = false) => request({ kind: "toggle", stats }),
    compare: (unit) => {
      const token = unit.trim().toLowerCase();
      return UNIT_TOKEN.test(token) ? request({ kind: "compare", unit: token }) : false;
    },
    close: () => {
      if (disposed || failure !== undefined) return false;
      if (frame && boot.bridge.isVisible(frame)) {
        boot.vm.executeReported("HideUIPanel(AchievementFrame)", "@webclient/achievement-close");
        return true;
      }
      if (intent) {
        intent = undefined;
        return true;
      }
      return false;
    },
    hide: () => {
      if (frame && boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(AchievementFrame)", "@webclient/achievement-hide");
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      intent = undefined;
      if (model) {
        if (model.onLoadRequest === loadRequest) model.onLoadRequest = undefined;
        model.owned = false;
        model.available = false;
      }
    },
  };
  if (model && failure === undefined) {
    model.onLoadRequest = loadRequest;
    model.available = true;
  }
  return owner;
}
