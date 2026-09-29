/**
 * Stock Blizzard_GlyphUI as the «Символы» tab of the stock PlayerTalentFrame: the preloads, the gate
 * and the load-on-demand extension the lazy talent owner (FrameXmlWorldMount.ts
 * `createLazyFrameXmlTalentOwner`) runs around its own Blizzard_TalentUI load. The C API is
 * FrameXmlGlyph.ts.
 *
 * GlyphFrame is not a window of its own. Its ADDON_LOADED handler parents it to PlayerTalentFrame
 * once both add-ons are loaded (Blizzard_GlyphUI.lua:324-334), and the talent frame's fourth tab shows
 * it through `PlayerTalentFrame_ShowGlyphFrame` (Blizzard_TalentUI.lua:201-219, :371-377). Every
 * stock path begins with `GlyphFrame_LoadUI()` = `UIParentLoadAddOn("Blizzard_GlyphUI")`
 * (UIParent.lua:316-318), and Lua's LoadAddOn is only a status view in this host (FrameXmlBoot.ts):
 * called before the files are here it would put «Ошибка загрузки (Blizzard_GlyphUI)» in the
 * script-error dialog. So the add-on is loaded by the host right after Blizzard_TalentUI passed its
 * gate and before the talent frame is first shown, and three UIParent entry points are taken over
 * at publication:
 * * `GlyphFrame_LoadUI` stays stock once the add-on is loaded and is silent before;
 * * `ToggleGlyphFrame` (the TOGGLEINSCRIPTION binding, Bindings.xml) and `OpenGlyphFrame` (USE_GLYPH,
 *   UIParent.lua:1053-1054) keep the stock level check (UIParent.lua:370-390) and then ask the host,
 *   which shows the talent frame through the talent controller — loading both add-ons on the first
 *   request — and runs stock `GlyphFrame_Toggle`/`GlyphFrame_Open` (Blizzard_GlyphUI.lua:33-45).
 *
 * Two stock FrameXML files the add-ons expect and the bounded vertical does not carry are run before
 * Blizzard_TalentUI, each only when nothing has defined it: TalentFrameBase.lua/TalentFrameTemplates.xml
 * (stock TOC 136-137, the preload FrameXmlInspectOwner.ts already owns; without it Blizzard_TalentUI
 * raises «'for' limit must be a number» at :253) and SparkleFrame.xml (stock TOC 27; without it
 * GlyphFrame_OnLoad raises «attempt to index a nil value (global 'SparkleFrame')» at :304 and never
 * registers its events). Measured over the client MPQ on the vertical (tests/framexml-glyph-vertical
 * .test.mjs): no new Lua error from either preload or from Blizzard_GlyphUI.
 *
 * A failed load or gate demotes the glyph tab for good: the add-on's frame is hidden, unregistered and
 * taken out of `_G.GlyphFrame` (every stock path guards on it), the UIParent hooks stay silent, and a
 * glyph item is used again as any other item. The talent owner is never failed by the glyph tab.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { GlueLoader } from "../glue/GlueLoader.js";
import { subsetTocProvider } from "./FrameXmlCorpus.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import { installFrameXmlInspectPreload } from "./FrameXmlInspectOwner.js";
import { frameXmlTalentOpen, toggleFrameXmlTalent } from "./FrameXmlTalentController.js";
import { FRAMEXML_GLYPH_SOCKETS, type FrameXmlGlyphModel } from "./FrameXmlGlyph.js";

export const FRAMEXML_GLYPH_ADDON = "Blizzard_GlyphUI";
const SPARKLE_TOC = "interface/framexml/__webclient_sparkle.toc";
/** The host global the three UIParent hooks call. */
const REQUEST_GLOBAL = "__webclientGlyphRequest";
/** What the hooks replace, kept for dispose. */
const SAVED_GLOBAL = "__webclientGlyphBefore";

/**
 * What the lazy stock talent owner runs around its Blizzard_TalentUI load: a dependent LoD add-on
 * hosted inside PlayerTalentFrame. None of the three may throw into the talent owner.
 */
export interface FrameXmlTalentLodExtension {
  /** Before `loadAddon("Blizzard_TalentUI")`. */
  beforeLoad?(): Promise<void>;
  /** After the talent gate passed and before the first show. */
  afterLoad?(): Promise<void>;
  /** After each show through the stock toggle. */
  afterShow?(): void;
  dispose?(): void;
}

type GlyphBoot = Pick<FrameXmlBoot,
  "vm" | "bridge" | "corpus" | "errorCount" | "loadAddon" | "isAddonLoaded">;
type GlyphRenderer = Pick<FrameXmlDomRenderer, "addRoots" | "sync" | "elementFor">;
export type FrameXmlGlyphIntent = "toggle" | "open";
export type FrameXmlGlyphState = "idle" | "loading" | "ready" | "failed" | "disposed";

export interface FrameXmlGlyphExtension extends FrameXmlTalentLodExtension {
  readonly state: FrameXmlGlyphState;
  /** The hooks' entry: show the glyph tab (loading both add-ons first when needed). */
  request(intent: FrameXmlGlyphIntent): void;
}

export interface FrameXmlGlyphExtensionOptions {
  readonly seam: { readonly glyphs?: FrameXmlGlyphModel | undefined };
  readonly boot: GlyphBoot;
  readonly renderer: GlyphRenderer;
  /** Told once, with the reason, when the glyph tab is demoted. */
  readonly onFailure?: (reason: string) => void;
}

function hasGlobalFunction(boot: Pick<FrameXmlBoot, "vm">, name: string): boolean {
  const ref = boot.vm.globalFunction(name);
  if (!ref) return false;
  boot.vm.release(ref);
  return true;
}

function descendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  for (let current: FrameXmlFrame | undefined = frame; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function renderedFrameElement(element: HTMLElement | undefined, frame: FrameXmlFrame): boolean {
  return !!element && element.getAttribute("data-framexml-name") === frame.name
    && element.getAttribute("data-framexml-type") === frame.type;
}

/** Run stock SparkleFrame.xml (and its SparkleFrame.lua) unless something already defined it. */
export async function installFrameXmlSparklePreload(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "corpus" | "errorCount">,
): Promise<boolean> {
  const present = frameXmlSilentProbe(boot, "webclient/glyph-sparkle-probe",
    `return (rawget(_G, "SparkleFrame") ~= nil and rawget(_G, "SparkleDimensions") ~= nil) and 1 or 0`, 1);
  if (Number(present?.[0]) === 1) return true;
  const errors = boot.errorCount;
  const { provider, toc } = subsetTocProvider(boot.corpus, ["SparkleFrame.xml"], SPARKLE_TOC);
  const loader = new GlueLoader({ vm: boot.vm, bridge: boot.bridge, provider, maxFiles: 4, maxDepth: 2 });
  const result = await loader.load(toc);
  return result.missing.length === 0 && result.diagnostics.length === 0 && boot.errorCount === errors;
}

/**
 * Structural and transactional proof that the loaded add-on can be the talent frame's glyph tab:
 * GlyphFrame parented to PlayerTalentFrame (its ADDON_LOADED ran), its six sockets with their stock
 * ids and scripts, the registrations the model's events reach, the stock functions the tab and the
 * hooks call, PlayerTalentFrame rendered; then one silent `GlyphFrame_Update()` over the seam with no
 * new Lua error or bridge diagnostic.
 */
export function frameXmlGlyphGate(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlFrame | undefined {
  try {
    const talent = boot.bridge.getFrame("PlayerTalentFrame");
    const frame = boot.bridge.getFrame("GlyphFrame");
    if (!talent || !frame || frame.type !== "Frame" || frame.parent !== talent) return undefined;
    if (!renderedFrameElement(renderer.elementFor(talent), talent)) return undefined;
    for (const script of ["OnShow", "OnEvent", "OnUpdate"]) if (!boot.bridge.hasScript(frame, script)) return undefined;
    for (const event of ["GLYPH_ADDED", "GLYPH_REMOVED", "GLYPH_UPDATED", "USE_GLYPH", "PLAYER_LEVEL_UP"]) {
      if (!frame.registeredEvents.has(event)) return undefined;
    }
    for (let socket = 1; socket <= FRAMEXML_GLYPH_SOCKETS; socket++) {
      const button = boot.bridge.getFrame(`GlyphFrameGlyph${socket}`);
      if (!button || button.type !== "Button" || !descendsFrom(button, frame)
        || !["OnClick", "OnEnter", "OnLeave", "OnShow"].every((script) => boot.bridge.hasScript(button, script))) {
        return undefined;
      }
    }
    for (const name of ["GlyphFrame_Update", "GlyphFrame_Toggle", "GlyphFrame_Open", "GlyphFrameGlyph_UpdateSlot",
      "PlayerTalentFrame_ShowGlyphFrame", "PlayerTalentFrame_ToggleGlyphFrame"]) {
      if (!hasGlobalFunction(boot, name)) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = frameXmlSilentProbe(boot, "webclient/glyph-gate", `
      for index = 1, NUM_GLYPH_SLOTS do
        if _G["GlyphFrameGlyph" .. index]:GetID() ~= index then return 0 end
      end
      GlyphFrame_Update()
      return 1
    `, 1);
    if (Number(probe?.[0]) !== 1 || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) {
      return undefined;
    }
    return frame;
  } catch {
    return undefined;
  }
}

/**
 * `GameTooltip:SetGlyph(socket, talentGroup)` (GlyphFrameGlyph_OnEnter, Blizzard_GlyphUI.lua:269) as a
 * per-frame field when the widget layer has no method of its own: a locked socket names its level
 * (GLYPH_LOCKED, GLYPH_SLOT_TOOLTIP<n>), an empty one says how to fill it (GLYPH_EMPTY,
 * GLYPH_EMPTY_DESC), a filled one is the glyph spell's own tooltip plus, on the active group, the
 * shift-right-click line (GLYPH_SLOT_REMOVE_TOOLTIP). The kind is MAJOR_GLYPH/MINOR_GLYPH. Every string
 * is GlobalStrings.lua's. True when the field is (or already was) installed.
 */
export function installFrameXmlGlyphTooltip(boot: Pick<FrameXmlBoot, "vm">): boolean {
  const probe = frameXmlSilentProbe(boot, "webclient/glyph-tooltip", `
    if type(GameTooltip) ~= "table" then return 0 end
    if rawget(GameTooltip, "__webclientSetGlyph") then return 1 end
    if rawget(GameTooltip, "SetGlyph") ~= nil then return 0 end
    local function color(value, fallback) return value or fallback end
    local white = { r = 1, g = 1, b = 1 }
    GameTooltip.SetGlyph = function(self, socket, group)
      local enabled, glyphType, spell = GetGlyphSocketInfo(socket, group)
      if enabled == nil then self:Hide() return end
      local kind = (glyphType == 2 and MINOR_GLYPH) or (glyphType == 1 and MAJOR_GLYPH) or nil
      local high = color(HIGHLIGHT_FONT_COLOR, white)
      local normal = color(NORMAL_FONT_COLOR, white)
      if not enabled then
        self:SetText(GLYPH_LOCKED, high.r, high.g, high.b)
        if kind then self:AddLine(kind, normal.r, normal.g, normal.b) end
        local requirement = _G["GLYPH_SLOT_TOOLTIP" .. tostring(socket)]
        local red = color(RED_FONT_COLOR, white)
        if requirement then self:AddLine(requirement, red.r, red.g, red.b) end
      elseif not spell then
        self:SetText(GLYPH_EMPTY, high.r, high.g, high.b)
        if kind then self:AddLine(kind, normal.r, normal.g, normal.b) end
        self:AddLine(GLYPH_EMPTY_DESC, normal.r, normal.g, normal.b, 1)
      else
        local link = GetSpellLink(spell)
        if link then
          self:SetHyperlink(link)
        else
          local name = GetSpellInfo(spell)
          if not name then self:Hide() return end
          self:SetText(name, high.r, high.g, high.b)
          if kind then self:AddLine(kind, normal.r, normal.g, normal.b) end
        end
        if group == nil or group == GetActiveTalentGroup() then
          local green = color(GREEN_FONT_COLOR, white)
          self:AddLine(GLYPH_SLOT_REMOVE_TOOLTIP, green.r, green.g, green.b, 1)
        end
      end
      self:Show()
    end
    rawset(GameTooltip, "__webclientSetGlyph", true)
    return 1
  `, 1);
  return Number(probe?.[0]) === 1;
}

/**
 * The glyph tab's lazy extension of the stock talent owner (module doc). Undefined when the seam has
 * no glyph model or the UIParent entry points are not there to take over.
 */
export function createFrameXmlGlyphExtension(options: FrameXmlGlyphExtensionOptions): FrameXmlGlyphExtension | undefined {
  const { seam, boot, renderer } = options;
  const model = seam.glyphs;
  if (!model) return undefined;
  let state: FrameXmlGlyphState = "idle";
  let wanted: FrameXmlGlyphIntent | undefined;

  const run = (name: string): void => {
    const ref = boot.vm.globalFunction(name);
    if (!ref) return;
    try { boot.vm.call(ref, [], 0); } finally { boot.vm.release(ref); }
  };
  const refresh = (): void => {
    if (state !== "ready") return;
    frameXmlSilentProbe(boot, "webclient/glyph-refresh", `if GlyphFrame and GlyphFrame:IsVisible() then GlyphFrame_Update() end`, 0);
  };
  const fail = (reason: string): void => {
    if (state === "failed" || state === "disposed") return;
    state = "failed";
    wanted = undefined;
    model.owned = false;
    model.cancelTargeting();
    model.onCatalog = undefined;
    frameXmlSilentProbe(boot, "webclient/glyph-demote", `
      local frame = rawget(_G, "GlyphFrame")
      if frame then frame:Hide() frame:UnregisterAllEvents() rawset(_G, "GlyphFrame", nil) end
    `, 0);
    try { options.onFailure?.(reason); } catch { /* reporting only */ }
  };
  // Whatever the tab or a hook asked for, once both add-ons are here: the talent frame through its
  // controller (the stock toggle, FrameXmlWorldMount.ts), then the stock glyph entry on top of it.
  const show = (intent: FrameXmlGlyphIntent): void => {
    if (!frameXmlTalentOpen()) toggleFrameXmlTalent();
    if (!frameXmlTalentOpen()) return;
    run(intent === "open" ? "GlyphFrame_Open" : "GlyphFrame_Toggle");
  };

  boot.vm.registerGlobal(REQUEST_GLOBAL, (args) => {
    const intent: FrameXmlGlyphIntent = args[0] === "open" ? "open" : "toggle";
    // Never inside the key binding or the USE_GLYPH dispatch that called it.
    queueMicrotask(() => {
      try { extension.request(intent); } catch (error) { console.warn(`[FrameXML glyphs] ${String(error)}`); }
    });
    return [];
  });
  const hooked = frameXmlSilentProbe(boot, "webclient/glyph-hooks", `
    if type(ToggleGlyphFrame) ~= "function" or type(OpenGlyphFrame) ~= "function"
      or type(GlyphFrame_LoadUI) ~= "function" then return 0 end
    local request = ${REQUEST_GLOBAL}
    local load = GlyphFrame_LoadUI
    ${SAVED_GLOBAL} = { toggle = ToggleGlyphFrame, open = OpenGlyphFrame, load = load }
    GlyphFrame_LoadUI = function(...)
      if IsAddOnLoaded("${FRAMEXML_GLYPH_ADDON}") and rawget(_G, "GlyphFrame") then return load(...) end
    end
    ToggleGlyphFrame = function()
      if UnitLevel("player") < SHOW_INSCRIPTION_LEVEL then return end
      request("toggle")
    end
    OpenGlyphFrame = function()
      if UnitLevel("player") < SHOW_INSCRIPTION_LEVEL then return end
      request("open")
    end
    return 1
  `, 1);
  if (Number(hooked?.[0]) !== 1) return undefined;
  model.owned = true;
  model.onCatalog = refresh;
  // The glyph tables now, so a glyph item used before the first talent-frame open is already known.
  void model.prepare();

  const extension: FrameXmlGlyphExtension = {
    get state() { return state; },
    beforeLoad: async () => {
      if (state !== "idle") return;
      try {
        // Both are shared stock FrameXML; a failure here is the glyph tab's, never the talent owner's.
        if (!await installFrameXmlInspectPreload(boot)) fail("TalentFrameBase.lua/TalentFrameTemplates.xml could not be run");
        else if (!await installFrameXmlSparklePreload(boot)) fail("SparkleFrame.xml could not be run");
      } catch (error) {
        fail(`preload failed: ${String(error)}`);
      }
    },
    afterLoad: async () => {
      if (state !== "idle") return;
      state = "loading";
      try {
        const result = await boot.loadAddon(FRAMEXML_GLYPH_ADDON);
        if (state !== "loading") return;
        if (!result.ok) { fail(`${FRAMEXML_GLYPH_ADDON}: ${result.message ?? result.status}`); return; }
        // GlyphFrame is PlayerTalentFrame's now (its ADDON_LOADED ran inside loadAddon); only what is
        // still parentless would draw at the top level.
        renderer.addRoots(result.roots.filter((root) => root.parent === undefined));
        renderer.sync();
        if (!frameXmlGlyphGate(boot, renderer)) { fail(`${FRAMEXML_GLYPH_ADDON} did not pass its gate`); return; }
        installFrameXmlGlyphTooltip(boot);
        state = "ready";
      } catch (error) {
        fail(`${FRAMEXML_GLYPH_ADDON} failed: ${String(error)}`);
      }
    },
    afterShow: () => {
      const intent = wanted;
      wanted = undefined;
      if (intent && state === "ready") run(intent === "open" ? "GlyphFrame_Open" : "GlyphFrame_Toggle");
    },
    request: (intent) => {
      if (state === "ready") { show(intent); return; }
      if (state !== "idle" && state !== "loading") return;
      // The first request loads Blizzard_TalentUI (and, after its gate, this add-on) through the
      // talent owner; its first show then runs the wanted glyph entry (afterShow).
      wanted = intent;
      if (!frameXmlTalentOpen()) toggleFrameXmlTalent();
    },
    dispose: () => {
      if (state === "disposed") return;
      state = "disposed";
      wanted = undefined;
      model.owned = false;
      model.cancelTargeting();
      model.onCatalog = undefined;
      frameXmlSilentProbe(boot, "webclient/glyph-restore", `
        local saved = ${SAVED_GLOBAL}
        if type(saved) ~= "table" then return end
        ToggleGlyphFrame, OpenGlyphFrame, GlyphFrame_LoadUI = saved.toggle, saved.open, saved.load
        ${SAVED_GLOBAL} = nil
      `, 0);
    },
  };
  return extension;
}
