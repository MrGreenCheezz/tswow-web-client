/**
 * Stock KeyBindingFrame (Blizzard_BindingUI, load-on-demand) as the key binding window: its gate,
 * its lazy owner and the keyboard it needs.
 *
 * KeyBindingFrame is `enableKeyboard="true"` with `<OnKeyDown function="KeyBindingFrame_OnKeyDown"/>`:
 * in the client every key goes to it while it is shown, and nothing reaches the world. The browser
 * mount has no keyboard dispatch to frames, so {@link installFrameXmlKeyBindingKeyboard} is that
 * dispatch for this one frame: a capture-phase `keydown` on the window (it runs before
 * `Controls.ts`, which listens in the bubble phase) swallows the press and fires OnKeyDown with the
 * client's key name (`frameXmlKeyName`). KeyBindingFrame_OnKeyDown builds `SHIFT-`/`CTRL-`/`ALT-`
 * from IsShiftKeyDown/IsControlKeyDown/IsAltKeyDown, so for the length of that one call they answer
 * the press's own modifiers. The page's modifier tracker (input/Modifiers.ts) gives the same answer
 * once its own capture listener has seen the press; this does not depend on which listener the
 * window registered first.
 *
 * Two departures, both because this client cannot do what the stock code would ask:
 * - Escape with a command selected deselects it (as a second click on the same slot does) instead
 *   of binding ESCAPE, which here is the game menu and cannot move. Escape with nothing selected is
 *   stock: GetBindingFromClick answers TOGGLEGAMEMENU, the changes are dropped and the menu returns.
 * - The «Для этого персонажа» box is hidden: there is one binding set (GetCurrentBindingSet answers
 *   ACCOUNT_BINDINGS), and a box that switched to a character set would save to the same table.
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import { frameXmlKeyName } from "./FrameXmlBinding.js";
import {
  createFrameXmlLodWindowOwner, frameXmlLodChild, frameXmlLodSilentProbe,
  type FrameXmlLodWindowOwner,
} from "./FrameXmlMacroBindingLod.js";

export const FRAMEXML_BINDING_ADDON = "Blizzard_BindingUI";

/** KEY_BINDINGS_DISPLAYED in Blizzard_BindingUI.lua. */
const BINDING_ROWS = 17;

const BINDING_CHILDREN: readonly (readonly [name: string, type: string, clickable: boolean])[] = [
  ["KeyBindingFrameScrollFrame", "ScrollFrame", false],
  ["KeyBindingFrameCharacterButton", "CheckButton", true],
  ["KeyBindingFrameDefaultButton", "Button", true],
  ["KeyBindingFrameCancelButton", "Button", true],
  ["KeyBindingFrameOkayButton", "Button", true],
  ["KeyBindingFrameUnbindButton", "Button", true],
];

const KEY_HOST = "__fxWebClientBindingKey";
const FIRE_HOST = "__fxWebClientBindingFire";

/**
 * Structural, rendered and behavioural proof that stock KeyBindingFrame can be the binding window.
 *
 * KeyBindingFrame must be the named keyboard-enabled Button under UIParent with its stock
 * OnKeyDown/OnShow/OnHide; its 17 rows (header, description, two key buttons with OnClick), scroll
 * frame, character box and the four command buttons must be rendered inside it; the seam must carry
 * a binding table with rows. Then one silent Show/Hide (sound, the menu OnHide reopens and the bag
 * greying silenced) must lay out the first rows as Bindings.xml's: row 1 the MOVEMENT header, row
 * 2 MOVEFORWARD's label, with no Lua error or bridge diagnostic. Ends hidden.
 */
export function frameXmlBindingGate(
  seam: Pick<FrameXmlWorldSeam, "keyBindings">,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): FrameXmlFrame | undefined {
  try {
    if (!seam.keyBindings || seam.keyBindings.count() < 2) return undefined;
    const root = boot.bridge.getFrame("KeyBindingFrame");
    const uiParent = boot.bridge.getFrame("UIParent");
    const element = root ? renderer.elementFor(root) : undefined;
    if (!root || root.type !== "Button" || !uiParent || root.parent !== uiParent || !element
      || element.getAttribute("data-framexml-name") !== "KeyBindingFrame"
      || !["OnLoad", "OnShow", "OnHide", "OnKeyDown", "OnClick"].every((script) => boot.bridge.hasScript(root, script))) {
      return undefined;
    }
    const child = (name: string, type: string, clickable = false): boolean => {
      const frame = frameXmlLodChild(boot, renderer, root, element, name, type);
      return frame !== undefined && (!clickable || boot.bridge.hasScript(frame, "OnClick"));
    };
    for (let index = 1; index <= BINDING_ROWS; index += 1) {
      const row = `KeyBindingFrameBinding${index}`;
      if (!child(row, "Frame") || !child(`${row}Key1Button`, "Button", true) || !child(`${row}Key2Button`, "Button", true)) {
        return undefined;
      }
      if (!boot.bridge.getFrame(`${row}Description`) || !boot.bridge.getFrame(`${row}Header`)) return undefined;
    }
    for (const [name, type, clickable] of BINDING_CHILDREN) if (!child(name, type, clickable)) return undefined;
    const probe = frameXmlLodSilentProbe(boot, "webclient/binding-gate",
      ["PlaySound", "ShowUIPanel", "Disable_BagButtons"], `
      KeyBindingFrame.mode = 1
      KeyBindingFrame:Show()
      local shown = KeyBindingFrame:IsShown() and 1 or 0
      local header = KeyBindingFrameBinding1Header:GetText()
      local label = KeyBindingFrameBinding2Description:GetText()
      KeyBindingFrame:Hide()
      return shown, KeyBindingFrame:IsShown() and 1 or 0,
        header == BINDING_HEADER_MOVEMENT and 1 or 0, label == BINDING_NAME_MOVEFORWARD and 1 or 0
    `, 4);
    if (!probe || probe[0] !== 1 || probe[1] !== 0 || probe[2] !== 1 || probe[3] !== 1) return undefined;
    return boot.bridge.isVisible(root) ? undefined : root;
  } catch {
    return undefined;
  }
}

/** Lua half of the keyboard: Escape-deselect, and the modifier answers around one OnKeyDown. */
const KEYBOARD_SOURCE = `
${KEY_HOST} = function(key, shift, ctrl, alt)
  local frame = KeyBindingFrame
  if not frame or not frame:IsShown() then return end
  if key == "ESCAPE" and frame.selected then
    KeyBindingFrame_SetSelected(nil)
    KeyBindingFrameOutputText:SetText("")
    KeyBindingFrame_Update()
    return
  end
  local isShift, isCtrl, isAlt = IsShiftKeyDown, IsControlKeyDown, IsAltKeyDown
  IsShiftKeyDown = function() return shift end
  IsControlKeyDown = function() return ctrl end
  IsAltKeyDown = function() return alt end
  local ok, message = pcall(${FIRE_HOST}, key)
  IsShiftKeyDown, IsControlKeyDown, IsAltKeyDown = isShift, isCtrl, isAlt
  if not ok then error(message, 0) end
end
`;

/**
 * Keys of this client's table with no KEY_ string, which GetBindingText would print by their bare
 * names. NumpadEnter is held apart from Enter here (the client has one ENTER); it and the keypad's
 * `=` and `,` are spelled the way the client spells the keypad's other keys, from KEY_NUMPAD0
 * («Enter (цифр. кл.)», «= (цифр. кл.)»). The ISO key beside the left Shift (INTLBACKSLASH,
 * FrameXmlBinding.ts) is KEY_BACKSLASH marked «(ISO)», apart from the main backslash.
 */
const NUMPAD_ENTER_SOURCE = `
local function keypad(name, key)
  if rawget(_G, name) == nil and type(rawget(_G, "KEY_NUMPAD0")) == "string"
    and type(key) == "string" and string.find(KEY_NUMPAD0, "0", 1, true) then
    _G[name] = (string.gsub(KEY_NUMPAD0, "0", function() return key end, 1))
  end
end
keypad("KEY_NUMPADENTER", rawget(_G, "KEY_ENTER"))
keypad("KEY_NUMPADEQUAL", "=")
keypad("KEY_NUMPADCOMMA", ",")
if rawget(_G, "KEY_INTLBACKSLASH") == nil and type(rawget(_G, "KEY_BACKSLASH")) == "string" then
  KEY_INTLBACKSLASH = KEY_BACKSLASH .. " (ISO)"
end
`;

/** The host close: the Cancel button's own script, without its OnHide reopening the game menu. */
const HOST_CLOSE_SOURCE = `
local show = ShowUIPanel
ShowUIPanel = function(frame, ...) if frame ~= GameMenuFrame then return show(frame, ...) end end
local ok, message = pcall(function() KeyBindingFrameCancelButton:Click() end)
ShowUIPanel = show
if not ok then error(message, 0) end
`;

export function createLazyFrameXmlBindingOwner(
  seam: Pick<FrameXmlWorldSeam, "keyBindings">,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  openNative: () => void,
  onFailure?: () => void,
): FrameXmlLodWindowOwner {
  return createFrameXmlLodWindowOwner(boot, renderer, {
    addon: FRAMEXML_BINDING_ADDON,
    gate: (gateBoot, gateRenderer) => frameXmlBindingGate(seam, gateBoot, gateRenderer),
    adopt: (adoptBoot, root, adoptRenderer) => {
      adoptBoot.vm.executeReported(
        `KeyBindingFrameCharacterButton:Hide()\nKeyBindingFrameScrollFrame:EnableMouse(false)\n${NUMPAD_ENTER_SOURCE}\n${KEYBOARD_SOURCE}`,
        "@webclient/binding-adopt");
      forwardFrameXmlBindingWheel(adoptBoot, root, adoptRenderer);
    },
    // GameMenuButtonKeybindings' own script, less the Lua LoadAddOn the host has already done.
    showSource: "KeyBindingFrame.mode = 1\nShowUIPanel(KeyBindingFrame)",
    hideSource: HOST_CLOSE_SOURCE,
    onFailure: (wanted) => {
      onFailure?.();
      console.warn("[FrameXML bindings] stock KeyBindingFrame failed to load, gate or open; the native window stays");
      if (wanted) openNative();
    },
  });
}

/**
 * The list's clicks and its wheel, which the page cannot hand to two different elements.
 *
 * KeyBindingFrameScrollFrame (a FauxScrollFrame) lies over the 17 rows it scrolls. In the client it
 * takes only the wheel — no EnableMouse, just OnMouseWheel — so a click reaches the key button
 * under it. The renderer gives any frame with OnMouseWheel the pointer, and in the page the pointer
 * is one thing: measured on the RICH route, `elementsFromPoint` over KeyBindingFrameBinding2Key1Button
 * put the scroll frame's viewport on top and the click selected nothing. So the scroll frame is
 * EnableMouse(false) here and the wheel over its box is handed to its own OnMouseWheel — which,
 * stock, scrolls the list, or binds MOUSEWHEELUP/DOWN when a key is waiting (refused, see
 * FrameXmlBinding.ts).
 */
function forwardFrameXmlBindingWheel(boot: FrameXmlBoot, root: FrameXmlFrame, renderer: FrameXmlDomRenderer): void {
  const scroll = boot.bridge.getFrame("KeyBindingFrameScrollFrame");
  const rootElement = renderer.elementFor(root);
  const scrollElement = scroll ? renderer.elementFor(scroll) : undefined;
  if (!scroll || !rootElement || !scrollElement) return;
  rootElement.addEventListener("wheel", (event) => {
    const wheel = event as WheelEvent;
    if (!boot.bridge.isVisible(scroll) || !Number.isFinite(wheel.deltaY) || wheel.deltaY === 0) return;
    const box = scrollElement.getBoundingClientRect();
    if (wheel.clientX < box.left || wheel.clientX > box.right || wheel.clientY < box.top || wheel.clientY > box.bottom) return;
    wheel.preventDefault();
    wheel.stopPropagation();
    boot.bridge.fireScript(scroll, "OnMouseWheel", wheel.deltaY < 0 ? 1 : -1);
  }, { passive: false });
}

function typingInto(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

/**
 * The keyboard for a shown KeyBindingFrame. `target` is the window (tests pass their own).
 * Returns the cleanup.
 */
export function installFrameXmlKeyBindingKeyboard(
  boot: FrameXmlBoot,
  target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined" ? undefined : window,
): () => void {
  const frame = (): FrameXmlFrame | undefined => boot.bridge.getFrame("KeyBindingFrame");
  let firing: { key: string; shift: boolean; ctrl: boolean; alt: boolean } | undefined;
  // UIParent.lua's GetBindingFromClick, which KeyBindingFrame_OnKeyDown asks about the press,
  // reads the same three shadowed globals, so the press's modifiers reach it too.
  boot.vm.registerGlobal(FIRE_HOST, () => {
    const root = frame();
    if (root && firing) boot.bridge.fireScript(root, "OnKeyDown", firing.key);
    return [];
  });
  const onKeyDown = (event: KeyboardEvent): void => {
    const root = frame();
    if (!root || !boot.bridge.isVisible(root) || typingInto(event.target)) return;
    // The frame has the keyboard: nothing below it — movement, the bars, the Escape chain — sees
    // the press, as in the client.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const run = boot.vm.globalFunction(KEY_HOST);
    if (!run) return;
    firing = { key: frameXmlKeyName(event.code), shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey };
    try {
      boot.bridge.runInMutationBatch(() => {
        boot.vm.call(run, [firing!.key, firing!.shift, firing!.ctrl, firing!.alt], 0);
      });
    } finally {
      firing = undefined;
      boot.vm.release(run);
    }
  };
  target?.addEventListener("keydown", onKeyDown as EventListener, true);
  return () => {
    target?.removeEventListener("keydown", onKeyDown as EventListener, true);
  };
}
