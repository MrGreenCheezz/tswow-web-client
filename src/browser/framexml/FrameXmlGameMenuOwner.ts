/**
 * Stock GameMenuFrame as the game menu: its host C APIs, the adapters for buttons whose stock
 * target is not loaded, the WebClient extras, the gate and the published owner.
 *
 * GameMenuFrame.xml has been in the vertical since the bag slice, hidden: it was the VM-local
 * alias for absent InterfaceOptionsFrame/StackSplitFrame. StackSplitFrame.xml now loads at its
 * stock slot and the bag gate aliases InterfaceOptionsFrame to a dedicated hidden frame, so the
 * menu is free to be shown. Probe (framexml.html, canned seam): ShowUIPanel(GameMenuFrame) → 0
 * errors, 195×240, MacOptions hidden (IsMacClient answers nil); the stock Options, Sound, UIOptions
 * and Keybindings clicks raise «global 'VideoOptionsFrame'/'KeyBindingFrame'» because those frames
 * are not loaded, which is why five buttons are re-scripted to the native windows below.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import {
  frameXmlNativeTargeting,
  runFrameXmlNativeEscape,
  type FrameXmlGameMenuOwner,
  type FrameXmlNativeEscapeStep,
} from "./FrameXmlGameMenuController.js";
import { FRAMEXML_SEAM_NAMES } from "./FrameXmlWorldSeam.js";
import { openFrameXmlOptions, type FrameXmlOptionsWindow } from "./FrameXmlOptionsController.js";

/** The eight buttons the stock menu shows on a non-Mac client (GameMenuFrame.xml), top to bottom. */
export const FRAMEXML_GAME_MENU_STOCK_BUTTONS = Object.freeze([
  "GameMenuButtonOptions", "GameMenuButtonSoundOptions", "GameMenuButtonUIOptions",
  "GameMenuButtonKeybindings", "GameMenuButtonMacros", "GameMenuButtonLogout",
  "GameMenuButtonQuit", "GameMenuButtonContinue",
] as const);

/** What the re-scripted and extra buttons do; each is a native owner of this client. */
export type FrameXmlGameMenuAction =
  | "video" | "sound" | "interface" | "keybindings" | "macros" | "diagnostics" | "resetLayout"
  /** The two menu branches of stock ToggleGameMenu (below); the host toggle decides stock or native. */
  | "toggle";

export type FrameXmlGameMenuActions = Readonly<Record<FrameXmlGameMenuAction, () => unknown>>;

/**
 * Stock buttons whose target frame is not in this vertical at boot, and the window each opens.
 * VideoOptionsFrame/AudioOptionsFrame/InterfaceOptionsFrame (TOC 37-45) load on their first open
 * (FrameXmlOptionsOwner.ts): the three adapters ask that route first, with the stock buttons'
 * own `ShowUIPanel` + `lastFrame = GameMenuFrame`, and fall back to the native settings sections.
 *
 * Keybindings and Macros keep theirs for good: their stock scripts call KeyBindingFrame_LoadUI and
 * ShowMacroFrame, and a Lua LoadAddOn is only a status view here (the load is the host's async
 * `boot.loadAddon`). The host actions open the stock KeyBindingFrame and MacroFrame through their
 * routes once published (FrameXmlBindingController.ts, FrameXmlMacroController.ts: the first open
 * loads the add-on), and the native windows otherwise.
 */
const ADAPTED_BUTTONS: readonly (readonly [button: string, action: FrameXmlGameMenuAction])[] = [
  ["GameMenuButtonOptions", "video"],
  ["GameMenuButtonSoundOptions", "sound"],
  ["GameMenuButtonUIOptions", "interface"],
  ["GameMenuButtonKeybindings", "keybindings"],
  ["GameMenuButtonMacros", "macros"],
];

/** The stock options frame each of the first three adapted buttons opens (FrameXmlOptionsController.ts). */
const STOCK_OPTIONS: Partial<Record<FrameXmlGameMenuAction, FrameXmlOptionsWindow>> = {
  video: "video", sound: "audio", interface: "interface",
};

/** WebClient's own entries, stock GameMenuButtonTemplate buttons between Quit and Continue. */
export const FRAMEXML_GAME_MENU_EXTRAS: readonly {
  readonly name: string; readonly text: string; readonly action: FrameXmlGameMenuAction;
}[] = Object.freeze([
  Object.freeze({ name: "GameMenuButtonWebClientDiagnostics", text: "Диагностика", action: "diagnostics" as const }),
  Object.freeze({ name: "GameMenuButtonWebClientResetLayout", text: "Сбросить раскладку окон", action: "resetLayout" as const }),
]);

const HOST_GLOBAL = "__fxWebClientGameMenu";
const ESCAPE_GLOBAL = "__fxWebClientEscape";

const ESCAPE_STEPS: ReadonlySet<string> = new Set<FrameXmlNativeEscapeStep>([
  "popups", "stopCasting", "stopTargeting", "windows", "clearTarget",
]);

/**
 * The C functions stock ToggleGameMenu asks between CloseMenus and CloseAllWindows, each bound to
 * the native state it stands for (Controls.ts registers the steps). Stock also calls them from
 * /stopcasting and /cleartarget (ChatFrame.lua:1065, :1207), the STOPCASTING binding, the secure
 * "stop" action and a unit frame's right click (SpellStopTargeting behind `SpellIsTargeting()`,
 * SecureTemplates.lua:396-400, :564-567) and the secure "target" action's unit "none" (ClearTarget,
 * :406); nothing bound them before, so each answered nil from the stub floor. A name the world seam
 * binds is left to the seam.
 */
const ESCAPE_C_APIS: readonly (readonly [name: string, step: FrameXmlNativeEscapeStep])[] = [
  ["SpellStopCasting", "stopCasting"],
  ["SpellStopTargeting", "stopTargeting"],
  ["ClearTarget", "clearTarget"],
];

/**
 * `SpellIsTargeting()`, the query in front of `SpellStopTargeting` in stock's secure code: 1 while
 * the reticle or the item-target cursor (game/SpellCursor.ts) is up. Unbound, it answered nil from
 * the stub floor, so the "stop" action and a unit frame's right click never reached the reticle
 * (measured over the MPQ corpus: a type="stop" click left it armed at spell 116). Bound, the
 * "target" action's `SpellIsTargeting()` branch calls `SpellTargetUnit` (FrameXmlItemTargeting.ts),
 * which a point or an item cursor answers with nothing (Wow.exe 0x0080bc80): a left click on a
 * unit frame meanwhile selects nobody and keeps the cursor, as the world canvas does (Controls.ts).
 */
const TARGETING_C_API = "SpellIsTargeting";

/**
 * Stock ToggleGameMenu (UIParent.lua:2868-2903) — what Escape runs in the client — in its own order,
 * with two kinds of change and no others:
 *
 * - a frame this vertical does not load is skipped where stock would index nil: HelpFrame, the
 *   Video/Audio options, TimeManagerFrame, MultiCastFlyoutFrame, OpacityFrame (InterfaceOptionsFrame
 *   is the bag gate's hidden stand-in until the options chain loads). Each branch works as stock once
 *   its file joins the TOC or, for the three options frames, once their first open has loaded them;
 * - this client's own state takes the place stock gives its counterpart: the native CAMP countdown
 *   right after `StaticPopup_EscapePressed`, the native windows on the same press as
 *   `CloseAllWindows`, and the menu itself through the host toggle (GameMenu.ts), which is stock's
 *   `PlaySound` + `Show/HideUIPanel(GameMenuFrame)` once published and the native Panel before.
 *
 * So one press dismisses one thing: a popup, the open menu, ChatMenu/EmoteMenu/LanguageMenu and the
 * dropdowns (`CloseMenus`, whose VoiceMacroMenu is ChatMenu's child), a cast, the reticle, every
 * window, then the target; only a press with nothing left opens the menu. Before this the native
 * chain closed windows and target together and never reached `CloseMenus`, so ChatMenu stayed open
 * on Escape (measured on framexml.html, wave 2). Measured on the index.html route through the page's
 * own keydown listener: a StaticPopup, the menu, ChatMenu, a cast (CMSG_CANCEL_CAST), the reticle,
 * SpellBookFrame with ItemRefTooltip, then the target went one per press, the ninth press opened
 * the menu, with 0 Lua errors; one press costs 0.29 ms median in Node over the MPQ corpus.
 */
const TOGGLE_GAME_MENU_SOURCE = `
local escape = ${ESCAPE_GLOBAL}
local function shown(frame)
  return type(frame) == "table" and type(frame.IsShown) == "function" and frame:IsShown() and true or false
end
local function closeAllWindows()
  local stock = securecall("CloseAllWindows")
  local own = escape("windows")
  return stock or own
end
ToggleGameMenu = function()
  if ( not UIParent:IsShown() ) then
    UIParent:Show();
    SetUIVisibility(true);
  elseif ( securecall("StaticPopup_EscapePressed") ) then
  elseif ( escape("popups") ) then
  elseif ( GameMenuFrame:IsShown() ) then
    host("toggle");
  elseif ( shown(HelpFrame) ) then
    if ( HelpFrame.back and HelpFrame.back.Click ) then
      HelpFrame.back:Click();
    end
  elseif ( shown(VideoOptionsFrame) and VideoOptionsFrameCancel ) then
    VideoOptionsFrameCancel:Click();
  elseif ( shown(AudioOptionsFrame) and AudioOptionsFrameCancel ) then
    AudioOptionsFrameCancel:Click();
  elseif ( shown(InterfaceOptionsFrame) and InterfaceOptionsFrameCancel ) then
    InterfaceOptionsFrameCancel:Click();
  elseif ( shown(TimeManagerFrame) and TimeManagerCloseButton ) then
    TimeManagerCloseButton:Click();
  elseif ( shown(MultiCastFlyoutFrame) and MultiCastFlyoutFrame_Hide ) then
    MultiCastFlyoutFrame_Hide(MultiCastFlyoutFrame, true);
  elseif ( FCFDockOverflow_CloseLists and securecall("FCFDockOverflow_CloseLists") ) then
  elseif ( securecall("CloseMenus") ) then
  elseif ( CloseCalendarMenus and securecall("CloseCalendarMenus") ) then
  elseif ( SpellStopCasting() ) then
  elseif ( SpellStopTargeting() ) then
  elseif ( closeAllWindows() ) then
  elseif ( ClearTarget() and (not UnitIsCharmed("player")) ) then
  elseif ( shown(OpacityFrame) ) then
    OpacityFrame:Hide();
  else
    host("toggle");
  end
end
`;

/**
 * Re-script the five adapted buttons, create the extras and re-anchor Continue below them.
 *
 * Run after `boot.load()` so TSWoW add-on buttons already exist. tswow-store's GameMenuButton
 * (Components/GameMenu.lua) prepends its own 144×21 button and re-anchors every default button
 * from GameMenuFrame's TOP on a 23 px step; the extras follow whichever layout is live: the stock
 * 1 px gap (22 px per button) after a stock-anchored Quit, the store's 23 px step after its own.
 * Continue keeps its stock 16 px gap below the last extra and the frame grows by one step per extra.
 */
export function installFrameXmlGameMenuButtons(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  actions: FrameXmlGameMenuActions,
): boolean {
  if (!boot.bridge.getFrame("GameMenuFrame")) return false;
  boot.vm.registerGlobal(HOST_GLOBAL, (args) => {
    const action = String(args[0] ?? "") as FrameXmlGameMenuAction;
    // The stock options frames first, as the stock buttons open them, returning to this menu on
    // close; the native settings window only while they are unpublished or failed to load.
    const window = STOCK_OPTIONS[action];
    if (window && openFrameXmlOptions(window, true)) return [];
    const run = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : undefined;
    try { void run?.(); } catch (error) { console.warn(`[FrameXML menu] ${action}: ${String(error)}`); }
    return [];
  });
  boot.vm.registerGlobal(ESCAPE_GLOBAL, (args) => {
    const step = String(args[0] ?? "");
    return ESCAPE_STEPS.has(step) && runFrameXmlNativeEscape(step as FrameXmlNativeEscapeStep) ? [true] : [];
  });
  const reserved = new Set(FRAMEXML_SEAM_NAMES);
  for (const [name, step] of ESCAPE_C_APIS) {
    if (!reserved.has(name)) boot.vm.registerGlobal(name, () => runFrameXmlNativeEscape(step) ? [1] : []);
  }
  if (!reserved.has(TARGETING_C_API)) boot.vm.registerGlobal(TARGETING_C_API, () => frameXmlNativeTargeting() ? [1] : []);
  const adapted = ADAPTED_BUTTONS
    .map(([button, action]) => `adapt(${button}, ${JSON.stringify(action)})`).join("\n  ");
  const extras = FRAMEXML_GAME_MENU_EXTRAS
    .map((extra) => `{ ${JSON.stringify(extra.name)}, ${JSON.stringify(extra.text)}, ${JSON.stringify(extra.action)} }`)
    .join(", ");
  const result = boot.vm.execute(`
local host = ${HOST_GLOBAL}
local function adapt(button, action)
  if not button then error("missing stock game-menu button for " .. action) end
  button:SetScript("OnClick", function()
    PlaySound("igMainMenuOption")
    HideUIPanel(GameMenuFrame)
    host(action)
  end)
end
do
  ${adapted}
  local _, relativeTo = GameMenuButtonQuit:GetPoint(1)
  local storeLayout = relativeTo == GameMenuFrame
  local gap = storeLayout and 2 or 1
  local previous = GameMenuButtonQuit
  local added = 0
  for _, spec in ipairs({ ${extras} }) do
    local button = _G[spec[1]] or CreateFrame("Button", spec[1], GameMenuFrame, "GameMenuButtonTemplate")
    button:SetText(spec[2])
    -- «Сбросить раскладку окон» is wider than the 144 px template in GameFontHighlight; the
    -- template's own small variant keeps it inside the button art instead of spilling over it.
    local label = button:GetFontString()
    if label and label:GetStringWidth() > button:GetWidth() - 12 then
      button:SetNormalFontObject(GameFontHighlightSmall)
      button:SetHighlightFontObject(GameFontHighlightSmall)
    end
    button:ClearAllPoints()
    button:SetPoint("TOP", previous, "BOTTOM", 0, -gap)
    local action = spec[3]
    button:SetScript("OnClick", function()
      PlaySound("igMainMenuOption")
      HideUIPanel(GameMenuFrame)
      host(action)
    end)
    button:Show()
    previous = button
    added = added + 1
  end
  GameMenuButtonContinue:ClearAllPoints()
  GameMenuButtonContinue:SetPoint("TOP", previous, "BOTTOM", 0, -16)
  GameMenuFrame:SetHeight(GameMenuFrame:GetHeight() + added * (previous:GetHeight() + gap))
end
${TOGGLE_GAME_MENU_SOURCE}
`, "@webclient/game-menu");
  if (!result.ok) console.warn(`[FrameXML menu] stock buttons were not adapted: ${result.error}`);
  return result.ok;
}

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  let current: FrameXmlFrame | undefined = frame;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function elementDescendsFrom(element: HTMLElement, ancestor: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentElement;
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

/**
 * Run `code` (a Lua function body returning values) with PlaySound silenced, so a mount-time
 * probe of a stock window does not play its open/close sounds. Answers undefined on a Lua failure.
 */
export function frameXmlSilentProbe(
  boot: Pick<FrameXmlBoot, "vm">,
  chunk: string,
  code: string,
  results: number,
): readonly unknown[] | undefined {
  const probe = boot.vm.compileFunction(`
local playSound = PlaySound
PlaySound = function() end
local results = { pcall(function() ${code} end) }
PlaySound = playSound
if not results[1] then error(results[2], 0) end
return select(2, table.unpack(results, 1, ${results + 1}))
`, chunk, []);
  if (!probe) return undefined;
  try {
    const errors = boot.vm.errors.length;
    const values = boot.vm.call(probe, [], results);
    return boot.vm.errors.length === errors ? values : undefined;
  } finally {
    boot.vm.release(probe);
  }
}

/**
 * Structural, rendered and transactional proof that the stock menu can be the game menu.
 *
 * GameMenuFrame must be the named Frame under UIParent with its stock OnShow/OnHide, every stock
 * button and extra a rendered Button inside its DOM with an OnClick; then one silent
 * ShowUIPanel/HideUIPanel pair must show and hide it with no new Lua error or bridge diagnostic.
 * The menu ends hidden.
 */
export function frameXmlGameMenuGate(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): { readonly frame: FrameXmlFrame } | undefined {
  try {
    const frame = boot.bridge.getFrame("GameMenuFrame");
    if (!frame || frame.type !== "Frame" || frame.parent?.name !== "UIParent" || frame.visible) return undefined;
    const frameElement = renderer.elementFor(frame);
    if (!renderedFrameElement(frameElement, frame)
      || !boot.bridge.hasScript(frame, "OnShow") || !boot.bridge.hasScript(frame, "OnHide")) return undefined;
    for (const name of [...FRAMEXML_GAME_MENU_STOCK_BUTTONS, ...FRAMEXML_GAME_MENU_EXTRAS.map((extra) => extra.name)]) {
      const button = boot.bridge.getFrame(name);
      const element = button ? renderer.elementFor(button) : undefined;
      if (!button || button.type !== "Button" || !frameDescendsFrom(button, frame)
        || !renderedFrameElement(element, button) || !elementDescendsFrom(element, frameElement)
        || !boot.bridge.hasScript(button, "OnClick")) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = frameXmlSilentProbe(boot, "webclient/game-menu-gate", `
      ShowUIPanel(GameMenuFrame)
      local shown = GameMenuFrame:IsShown() and 1 or 0
      HideUIPanel(GameMenuFrame)
      return shown, GameMenuFrame:IsShown() and 1 or 0
    `, 2);
    if (!probe || probe[0] !== 1 || probe[1] !== 0 || frame.visible
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { frame };
  } catch {
    return undefined;
  }
}

/**
 * The published owner: stock ToggleGameMenu's two menu branches (UIParent.lua:2873-2875,
 * :2899-2901) for show/hide, and the whole chain for Escape. The native countdown panel stands in
 * for the stock CAMP popup — nothing fires PLAYER_CAMPING here — so a pending logout disables
 * Logout and Quit the way GameMenuButtonLogout's OnShow does while CAMP is visible.
 */
export function createFrameXmlGameMenuOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
  logoutPending: () => boolean,
): FrameXmlGameMenuOwner {
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    show: () => {
      boot.vm.executeReported(`PlaySound("igMainMenuOpen") ShowUIPanel(GameMenuFrame)`, "@webclient/game-menu-show");
      if (logoutPending()) {
        boot.vm.executeReported("GameMenuButtonLogout:Disable() GameMenuButtonQuit:Disable()", "@webclient/game-menu-camp");
      }
    },
    hide: () => {
      if (!boot.bridge.isVisible(frame)) return;
      boot.vm.executeReported(`PlaySound("igMainMenuQuit") HideUIPanel(GameMenuFrame)`, "@webclient/game-menu-hide");
    },
    // The global, as the client's TOGGLEGAMEMENU binding calls it (Bindings.xml:663), so an add-on's
    // hooksecurefunc on it runs for the Escape key too. One batch: CloseAllWindows hides many frames.
    escape: () => {
      boot.bridge.runInMutationBatch(() => {
        boot.vm.executeReported("ToggleGameMenu()", "@webclient/game-menu-escape");
      });
    },
  };
}
