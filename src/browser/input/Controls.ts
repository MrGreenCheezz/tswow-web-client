import { GO_FLAG_NOT_SELECTABLE, interactiveGameObjectType } from "../../world/GameObjectProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { game } from "../game/Context.js";
import { gameObjectType } from "../SimpleScene.js";
import { chatInput, worldCanvas } from "../ui/Dom.js";
import { anyGameWindowOpen, closeGameWindows } from "../ui/Windows.js";
import { showTarget } from "../ui/Frames.js";
import { interactWithGuid } from "../ui/Npc.js";
import { CAMERA_PITCH_LIMIT, cameraLookPerPixel, zoomedDistance } from "../game/CameraRig.js"; // 3.11: was also advanceCameraFollow
import { cameraYawOffFlip } from "../game/CameraViews.js"; // DEC-B 3.11
import { cameraViews } from "../game/CameraViews.js"; // 3.11
import { cameraFollow, type CameraFollowHost } from "../game/CameraFollow.js"; // 3.11
import { cameraMaxDistance, settingOn, settings } from "../ui/Settings.js";
import { settingNumber } from "../ui/SettingsModel.js";
import { canAttackUnit, dropTabList, inSightFromCamera, reactionTo } from "../game/Targeting.js"; // 1.10: dropTabList
import { setHoveredTarget } from "../game/HoverTarget.js";
import { gatherPlan } from "../game/CreatureGather.js";
import { cancelGiftWrap, giftWrapPending, observeGiftWrap } from "../game/GiftWrap.js"; // L1-review: cancelGiftWrap
import { groundTargetInRange } from "../game/GroundTargetPreview.js";
import { repair } from "../Repair.js";
import type { WorldClient } from "../../world/WorldClient.js";
import {
  CURSOR, REPAIR_CURSOR_FILE, castCursorForBody, cursorCss, onCursorPicture, useCursorPictures, worldObjectCursor,
  type CursorRules, type CursorWorld,
} from "./Cursors.js";
import { cancelLogoutCountdown, gameMenuOpen, logoutCountdownOpen, toggleGameMenu } from "../ui/GameMenu.js";
import {
  escapeFrameXmlGameMenu, registerFrameXmlNativeEscape, type FrameXmlNativeEscape,
} from "../framexml/FrameXmlGameMenuController.js";
import {
  closeFrameXmlPopups, frameXmlPopupsDropCursorItem, frameXmlPopupsOpen,
} from "../framexml/FrameXmlPopupsController.js";
import { escapeFrameXmlAddonDialogs } from "../framexml/FrameXmlTsAddonPresentation.js";
import { stopFrameXmlTradeSkillTargeting } from "../framexml/FrameXmlTradeSkillController.js";
import { keyBindingsOpen, toggleKeyBindingsWindow } from "../ui/KeyBindings.js";
import { notice } from "../ui/Notices.js";
import {
  cancelGroundTarget, groundPointInRange, groundTargetRange, pendingGroundTarget,
  pendingGroundTargetItem, resolveGroundTarget,
} from "../game/GroundTarget.js";
import { recordGroundTargetPointer } from "../game/GroundTargetPreview.js";
import { cancelItemTarget, observeItemTarget, pendingItemTarget, targetGameObjectWithCursor } from "../game/SpellCursor.js";
import { hideTooltipAtPoint, showTooltipAtPoint, type TooltipContent } from "../ui/Tooltip.js";
import { unitTooltipContent, unitTooltipFacts, unitTooltipKey } from "../ui/UnitTooltip.js";
import { NATIVE_LANES_REPLACED, nativeHudReplaced } from "../ui/NativeHudReplacement.js";
import { runAction } from "./Actions.js";
import { onFollowChange } from "./Follow.js";
import { runEscapeChain, type EscapeStep } from "./EscapeChain.js";
import { isStockAction } from "./StockActions.js";
import {
  HELD_ACTIONS, actionFor, chordOf, moduleActionFor, overrideFor, strafeInsteadOfTurn, type InputAction,
} from "./Bindings.js";
import type { DirectBindingEdge } from "./Bindings.js"; // 13.10
import {
  beginHeld, endHeld, flushFacing, normalizeAngle, releaseAllInput, resetCharacterMotion,
  setMouseRun, setSteering, turnCharacterBy,
} from "./Movement.js"; // 3.11: forwardAxis and strafeAxis were the old follow's
import { movementInputWord } from "./Movement.js"; // 3.11
import { aimMoverPitchBy, moverRefusesStrafe } from "./Movement.js"; // 11.02-GF3
import { vehicleCamera } from "../game/VehicleCamera.js"; // 11.02-GF3
import { heldMovementAction } from "./Bindings.js"; // L8 5.09
import { CAMERA_OR_SELECT_OR_MOVE, TURN_OR_ACTION, registerMovementCommandInput } from "./MovementCommands.js"; // L8 5.09
import type { MouseCommandHow } from "./MovementCommands.js"; // 3.11/5.09
import { MOUSE_CLICK_INTERACT, MOUSE_CLICK_NONE, MOUSE_CLICK_SELECT, MouseCommandClick } from "./MouseCommandClick.js"; // 5.09

/**
 * Keyboard, mouse and camera.
 *
 * Nothing here knows what an action does or which key runs it: an event becomes a chord, the
 * table turns the chord into an action, and `Actions` runs it. Escape is the one key this file
 * still spells out, because it is not an action but a chain — it backs out of one thing at a
 * time and there is nothing for a player to rebind about that.
 */

/**
 * Which held action each physical key started.
 *
 * Keyed by `event.code` and not by action, because that is what a key release gives us — and
 * because the action can change under the key: holding shift turns `A` from a turn into a strafe
 * while it is still down, the way the original client does.
 */
const heldByCode = new Map<string, { base: InputAction; current: InputAction }>();
/** L8 5.09: the code a Lua call (input/MovementCommands.ts) holds a command under — no key sends it. */
const LUA_HOLD = "Lua:";
/** L8 5.09: TurnOrAction (1, the right button's) and CameraOrSelectOrMove (2, the left's) held from Lua. */
let luaButtons = 0;
/** L8 5.09: the Lua right button turned the character to the camera, so its release reports the facing. */
let luaTurned = false;
/**
 * L8-review 5.09: the keys a Lua Stop let go while they were still down: until their keyup the strafe modifier does
 * not start them again (Wow.exe 0x005fafb0 makes strafes only of turn bits that are set; the Stop cleared it).
 */
const stoppedHolds = new WeakSet<object>();

/** Text fields own the keyboard while they have focus, except for the way out of them. */
function typingInto(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

/** The `<input>` the FrameXML renderer builds inside an EditBox, marked `data-framexml-input`. */
function isFrameXmlInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.getAttribute("data-framexml-input") === "true";
}

/**
 * The action a press means.
 *
 * Modifiers are matched exactly, so `Shift+1` reaches the page switch rather than slot one. The
 * single exception is the movement keys (5.15): a held action's key still means that action with
 * Shift, Ctrl or Alt down when the chord has no binding of its own — shift is the strafe modifier
 * rather than part of the binding, and running on with Ctrl or Alt held is what the original client
 * does. Only held actions fall back: `Ctrl+1` is not action button 1. Meta is never ignored.
 */
export function resolveKeyAction(
  event: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
): InputAction | undefined {
  const exact = actionFor(chordOf(event));
  if (exact !== undefined) return exact;
  if (!event.shiftKey && !event.ctrlKey && !event.altKey) return undefined;
  const bare = actionFor(chordOf({ code: event.code }));
  return bare !== undefined && HELD_ACTIONS.has(bare) ? bare : undefined;
}

/**
 * A cast this far past its own end is not being cast any more: its SPELL_GO or failure was missed,
 * and Escape must not spend every press cancelling it instead of reaching the menu.
 */
const STALE_CAST_GRACE_MS = 1000;

/**
 * Casts this client already asked the server to cancel, so each is cancelled once. `world.casts`
 * keeps the entry until SMSG_SPELL_FAILURE or the zero MSG_CHANNEL_UPDATE comes back (WorldClient.ts,
 * `cancelSpellCast` only sends): without this a second Escape inside one round trip sent a second
 * CMSG_CANCEL_CAST, which the server drops (SpellHandler.cpp:423, nothing is being cast any more),
 * and spent the press instead of reaching the reticle. Keyed by the entry object, which
 * `#beginCast` creates per cast and channel/delay updates only mutate.
 */
const cancelledCasts = new WeakSet<object>();

/**
 * This client's pieces of Escape, for the stock chain once the stock game menu owns it (stock
 * ToggleGameMenu, FrameXmlGameMenuOwner.ts): each stands where stock puts its counterpart and
 * answers whether it dismissed anything.
 */
const NATIVE_ESCAPE: FrameXmlNativeEscape = {
  // The countdown stands in for the stock CAMP popup, whose hideOnEscape cancels the logout.
  popups: () => {
    if (!logoutCountdownOpen()) return false;
    cancelLogoutCountdown();
    return true;
  },
  // SpellStopCasting: the client cancels the player's own cast or channel on Escape. The one
  // CMSG_CANCEL_CAST with the spell's id interrupts either (TrinityCore SpellHandler.cpp:418-425,
  // Unit::InterruptNonMeleeSpells, Unit.cpp:3444-3456).
  stopCasting: () => {
    const world = game.world;
    const self = world?.state.selfGuid;
    const cast = self === undefined ? undefined : world?.casts?.get(self);
    if (!world || !cast || cast.duration <= 0 || cancelledCasts.has(cast)
      || performance.now() - cast.startedAt > cast.duration + STALE_CAST_GRACE_MS) return false;
    cancelledCasts.add(cast);
    world.cancelSpellCast();
    return true;
  },
  // SpellStopTargeting: the ground-target reticle, or the cursor waiting for an item (SpellCursor.ts).
  stopTargeting: () => {
    if (cancelItemTarget()) {
      clearHoverCursor();
      return true;
    }
    if (pendingGroundTarget() === undefined) return false;
    cancelGroundTarget();
    clearHoverCursor();
    return true;
  },
  // SpellIsTargeting: the same two, asked without dismissing them.
  isTargeting: () => pendingGroundTarget() !== undefined || pendingItemTarget() !== undefined,
  // Beside CloseAllWindows, on the same press: the bindings window and every escapable window.
  windows: () => {
    const world = game.world;
    const open = keyBindingsOpen() || (world !== undefined && anyGameWindowOpen());
    if (keyBindingsOpen()) toggleKeyBindingsWindow();
    if (world) {
      if (world.loot) world.closeLoot();
      closeGameWindows();
    }
    return open;
  },
  clearTarget: () => {
    const world = game.world;
    if (world?.targetGuid === undefined) {
      // 1.10 (12.10): ClearTarget 0x525fc0 zeroes the Tab list's mark (0x00bd08cc) first, with or
      // without a selection, and answers nil without one: the clear of nothing drops the list only.
      dropTabList();
      return false;
    }
    world.selectTarget(undefined);
    // The target is gone and this press is spent whatever the native frame's repaint does; a throw
    // here must not read as "nothing cleared" and let the same press open the menu.
    try { showTarget(); } catch (error) { console.error("[Escape] target frame repaint failed", error); }
    return true;
  },
};

/**
 * The native HUD's Escape before the stock game menu owns it: stock ToggleGameMenu's order
 * (UIParent.lua:2868-2903), one step per press, with {@link NATIVE_ESCAPE} in its stock places.
 * Before 4.04 one press closed every window, dropped the target and the menu together and never
 * stopped a cast; the original backs out of one thing at a time and stops the cast first.
 */
const NATIVE_BACK_OUT: readonly EscapeStep[] = [
  // StaticPopup_EscapePressed (UIParent.lua:2872): a stock dialog a TSWoW module raised over the
  // native HUD, the published stock popups, and the native logout countdown standing in for CAMP.
  () => escapeFrameXmlAddonDialogs(),
  () => frameXmlPopupsOpen() && closeFrameXmlPopups(),
  () => NATIVE_ESCAPE.popups(),
  // GameMenuFrame shown → hidden.
  () => {
    if (!gameMenuOpen()) return false;
    toggleGameMenu();
    return true;
  },
  // The option frames come next in stock; the bindings window is this client's one, and it is the
  // one window that can be open with no world behind it.
  () => {
    if (!keyBindingsOpen()) return false;
    toggleKeyBindingsWindow();
    return true;
  },
  // CloseMenus: a floating menu (Widgets.openFloating) takes Escape itself in the capture phase.
  () => NATIVE_ESCAPE.stopCasting(),
  () => NATIVE_ESCAPE.stopTargeting(),
  () => game.world !== undefined && NATIVE_ESCAPE.windows(),
  () => NATIVE_ESCAPE.clearTarget(),
  // Nothing left to dismiss: the menu.
  () => {
    if (!game.world) return false;
    toggleGameMenu();
    return true;
  },
];

/**
 * Escape, which is a chain and not a binding: one thing dismissed per press, and the menu only
 * when there is nothing left. Once the stock game menu is published the chain is stock
 * ToggleGameMenu's (FrameXmlGameMenuController.ts); before that it is {@link NATIVE_BACK_OUT}.
 */
function backOut(): void {
  // L1-review (2.05 E): waiting wrapping paper goes first, before any window (Wow.exe 0x0051fa50 →
  // 0x00519280 → 0x006cef80); the native bags arm it (ui/NativeGiftWrap.ts). FrameXmlCursorDom does this
  // for the stock UI before the press reaches here.
  if (cancelGiftWrap()) return;
  if (escapeFrameXmlGameMenu()) return;
  runEscapeChain(NATIVE_BACK_OUT);
}

/** Whether a Shift key is down: with the right button, what turns the turn keys into strafes. */
let shiftHeld = false;

/**
 * Re-reads every held key against the strafe modifier — Shift, or the right mouse button (5.14:
 * Wow.exe 0x005fafb0 counts the turn keys as strafes while the steer button is down) — and starts
 * or stops what changed.
 */
function refreshStrafeModifier(): void {
  // 11.02-GF3: not for a NO_STRAFE mover, whose turn keys go on turning under the steer
  // (Wow.exe 0x005fb0b0 → 0x0074b9a0, MovementFlags2 & NO_STRAFE; Movement.moverRefusesStrafe).
  const strafing = (shiftHeld || drag.right || (luaButtons & TURN_OR_ACTION) !== 0) && !moverRefusesStrafe(); // L8 5.09: `|| luaButtons & TURN_OR_ACTION`
  for (const entry of heldByCode.values()) {
    if (stoppedHolds.has(entry)) continue; // L8-review 5.09: a Stop let it go until its keyup
    const wanted = strafing ? strafeInsteadOfTurn(entry.base) : entry.base;
    if (wanted === entry.current) continue;
    endHeld(entry.current);
    entry.current = wanted;
    beginHeld(wanted);
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (typingInto(event.target)) {
    // Escape leaves the chat box so movement keys work again without reaching for the mouse.
    if (event.code === "Escape" && event.target === chatInput) {
      chatInput.value = "";
      chatInput.blur();
      event.preventDefault();
      return;
    }
    // A FrameXML edit box's own `keydown` listener sits on the input and has already fired the
    // widget's `OnEscapePressed` by the time the press bubbles here — `ChatEdit_OnEscapePressed`
    // for the stock chat, which clears and hides it. That script is the whole meaning of the
    // press: running the native back-out chain as well closed windows and dropped the target on
    // the same key that was only meant to leave the chat. A box whose script kept its focus loses
    // it here, the way a client edit box does, so movement keys work again. In the world only: the
    // GlueXML login boxes are the same renderer's inputs, and there Escape runs `AccountLogin_Exit`
    // (a no-op here) and the field has to keep the caret, as it did before this branch existed.
    if (event.code === "Escape" && game.world && isFrameXmlInput(event.target)) {
      if (document.activeElement === event.target) (event.target as HTMLElement).blur();
      event.preventDefault();
      return;
    }
    if (event.code !== "Escape" || event.defaultPrevented) return;
    // A search field may handle Escape itself (clear its query, then blur). Do not also dismiss
    // its window on that same press. Other focused fields pass through the usual Escape chain.
    if (document.activeElement !== event.target) {
      event.preventDefault();
      return;
    }
    if (!game.world && !keyBindingsOpen()) return;
    (event.target as HTMLElement).blur();
    if (!event.repeat) backOut();
    event.preventDefault();
    return;
  }
  if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
    shiftHeld = true;
    refreshStrafeModifier();
    return;
  }
  if (event.code === "Escape") {
    // Held down, Escape is one press: the OS autorepeat must not toggle the menu open and shut
    // thirty times a second, and the client's TOGGLEGAMEMENU binding fires on the press alone.
    if (!event.repeat) backOut();
    event.preventDefault();
    return;
  }

  // A frame's override binding (SetOverrideBinding*, 3.11) takes its key before the table does.
  // One map lookup, and none at all while no override is set.
  const override = overrideFor(chordOf(event));
  // L2 3.11: an override standing for a held table action (MOVEFORWARD, JUMP…) is held below like the
  // table's own key — the client runs such a runOnUp binding with keystate "down" and "up".
  const overrideHeld = override?.action !== undefined && HELD_ACTIONS.has(override.action) ? override.action : undefined;
  if (override && overrideHeld === undefined) { // L2 3.11: `&& overrideHeld === undefined`
    if (!event.repeat && !pressDirect(event.code, override)) override.run(); // 13.10: `!pressDirect(…) &&`
    event.preventDefault();
    return;
  }

  const action = overrideHeld ?? resolveKeyAction(event); // L2 3.11: `overrideHeld ??`
  // 5.09: MOVEANDSTEER — MoveAndSteerStart on the press, MoveAndSteerStop on the release (Bindings.xml, runOnUp).
  if (action === "moveAndSteer") {
    if (!event.repeat && game.world && !moveAndSteerKeys.has(event.code)) {
      moveAndSteerKeys.add(event.code);
      holdButton(CAMERA_OR_SELECT_OR_MOVE, true);
      holdButton(TURN_OR_ACTION, true);
    }
    event.preventDefault();
    return;
  }
  if (action === undefined) {
    // A module's own action, which lives in a separate dynamic table and is never held: a
    // definition file offers a verb, and a verb is pressed. Asked after the compiled-in table, so
    // a module can never answer for a key that already means something else.
    const fromModule = moduleActionFor(chordOf(event));
    if (!fromModule) return;
    if (!event.repeat && !pressDirect(event.code, fromModule)) fromModule.run(); // 13.10: `!pressDirect(…) &&`
    event.preventDefault();
    return;
  }

  if (HELD_ACTIONS.has(action)) {
    // 5.15: a key pressed before the server hands over control is held all the same; Movement
    // sends it on the first frame movement is ready (the core drops MSG_MOVE_* before
    // CMSG_SET_ACTIVE_MOVER, MovementHandler.cpp:275-279, so nothing may go out earlier).
    if (!game.world || heldByCode.has(event.code)) return;
    // 11.02-GF3: `&& !moverRefusesStrafe()` — a NO_STRAFE mover's turn keys turn under the steer (refreshStrafeModifier).
    const current = (event.shiftKey || drag.right || (luaButtons & TURN_OR_ACTION) !== 0) && !moverRefusesStrafe() ? strafeInsteadOfTurn(action) : action; // L8 5.09: `|| luaButtons & TURN_OR_ACTION`
    heldByCode.set(event.code, { base: action, current });
    beginHeld(current);
    // A held action may still have a verb on the way down — sitting down is one — and the ones
    // that do not simply answer that they did nothing. Not under the loading screen: a sit key
    // held through it must not sit the character down when the world appears.
    if (game.world.movementReady) runAction(current);
    event.preventDefault();
    return;
  }
  // A repeat is a key the player is leaning on, not a second press: the action bar would fire
  // thirty times a second and every one of those is a packet.
  if (event.repeat) {
    event.preventDefault();
    return;
  }
  // A stock key (3.11) stays the game's in the world even when its verb found nothing to do:
  // Ctrl+F5 with no fifth form is not the browser's hard reload (StockActions.isStockAction).
  if (runAction(action) || (game.world !== undefined && isStockAction(action))) event.preventDefault();
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
    shiftHeld = false;
    refreshStrafeModifier();
    return;
  }
  // 5.09: MoveAndSteerStop (0x005fc830): the left command, then the right.
  if (moveAndSteerKeys.delete(event.code)) {
    holdButton(CAMERA_OR_SELECT_OR_MOVE, false);
    holdButton(TURN_OR_ACTION, false);
    event.preventDefault();
    return;
  }
  // 13.10: a direct SPELL/ITEM/MACRO/CLICK binding's release — the one its press found (Wow.exe 0x004f6b70).
  const direct = directByCode.get(event.code);
  if (direct) {
    directByCode.delete(event.code);
    // An edit box that has the keyboard takes the release (0x004f6b70 asks the frames first, 0x0048fbf0).
    if (!typingInto(event.target)) direct(false);
    event.preventDefault();
    return;
  }
  const entry = heldByCode.get(event.code);
  if (!entry) {
    releaseUnrecordedKey(event); // 5.09
    return;
  }
  heldByCode.delete(event.code);
  endHeld(entry.current);
  if (heldByCode.size !== 0) dropLuaHolds(entry.base); // L8-review 5.09
  event.preventDefault();
}

/** 5.09: the keys holding MOVEANDSTEER, by `event.code`. */
const moveAndSteerKeys = new Set<string>();

/**
 * 13.10: the keys down on a direct SPELL/ITEM/MACRO/CLICK binding, by `event.code`, with the binding their press found
 * (Bindings.DirectBindingEdge): Wow.exe's key press (0x004f6ae0) keeps the command in the key's slot and its release
 * (0x004f6b70) runs that slot with keystate up, so a modifier let go first does not change what the release runs.
 */
const directByCode = new Map<string, DirectBindingEdge>();

/**
 * 13.10: a key's press on a direct binding: its down edge now (nothing for SPELL, ITEM, MACRO; the button's mouse-down
 * for CLICK), its release kept for the key's keyup. False for any other binding, which runs on the press as before.
 * The autorepeat never reaches here (the callers skip `event.repeat`): a held key is one press, one release.
 */
function pressDirect(code: string, binding: { readonly edge?: DirectBindingEdge | undefined }): boolean {
  const edge = binding.edge;
  if (!edge) return false;
  directByCode.set(code, edge);
  edge(true);
  return true;
}

/**
 * 5.09: a key let go whose press this table never saw (pressed in an edit box, before the world, before its binding
 * changed). Wow.exe's key-up (0x004f6b70) runs the key's binding as it stands now when no press was recorded for it
 * (0x0055e2c0 → 0x00563150 with keystate "up"), so a held command's Stop still lands: MoveForwardStop clears the bit
 * whoever set it — a RunBinding or MoveForwardStart from Lua included (0x005fa450). Not while an edit box has the
 * keyboard. Was: nothing.
 * 13.10: a direct SPELL/ITEM/MACRO/CLICK binding's release is not run from here, though 0x004f6b70 would run it: the
 * stock frames that take the keyboard here (CoinPickupFrame, KeyBindingFrame) take a key's press but not its release,
 * which Wow.exe's frames take as well (0x0048fbf0), so a digit typed into the money box would cast on its release.
 */
function releaseUnrecordedKey(event: KeyboardEvent): void {
  if (!game.world || typingInto(event.target)) return;
  const override = overrideFor(chordOf(event));
  const action = override?.action ?? resolveKeyAction(event);
  if (action === "moveAndSteer") {
    holdButton(CAMERA_OR_SELECT_OR_MOVE, false);
    holdButton(TURN_OR_ACTION, false);
    return;
  }
  if (action === undefined || !HELD_ACTIONS.has(action)) return;
  holdCommand(action, false);
}

/**
 * L8-review 5.09: a key's release is its Stop, which clears the command's bit whoever set it (Wow.exe 0x005fa450), so
 * a Lua hold of the same command goes with it rather than lingering for the strafe modifier to start again.
 */
function dropLuaHolds(action: InputAction): void {
  const bit = heldMovementAction(action);
  for (const [code, held] of heldByCode) {
    if (code.startsWith(LUA_HOLD) && heldMovementAction(held.base) === bit) heldByCode.delete(code);
  }
}

/**
 * How far the pointer may travel before the drag takes the pointer lock (5.14). 13.10: only the lock's — whether the
 * release clicks is Wow.exe's rule (0x005f9600, MouseCommandClick.ts; was `drag.moved <= DRAG_THRESHOLD`, 3 px).
 */
const LOCK_THRESHOLD = 3;

/**
 * The gesture in progress.
 *
 * Read out of `event.buttons` rather than counted from `pointerdown` and `pointerup`, because a
 * mouse does not send those for a second button: the spec fires `pointerdown` only when no other
 * button is already down and `pointerup` only when the last one comes up, and everything in
 * between arrives as `pointermove`. Counting presses would mean the right button never registers
 * while the left is held, which is exactly the gesture that has to run forward.
 *
 * 13.10: a press that was part of a two-button run is no click when it comes up alone — the commands' click mode says
 * so (MouseCommandClick.ts; was `seen`, every button the gesture had used).
 */
const drag = { left: false, right: false, moved: 0, lockRequested: false, lockRefused: false, turned: false };

/**
 * 11.10: the buttons held down while the pointer is over the world that were pressed somewhere else.
 *
 * The owner's report (live check 11.10): dragging a spell from one stock action button to another
 * jerked the camera and hid the cursor. The press lands on the button (ActionButton's OnDragStart →
 * PickupAction, ActionBarFrame.xml), whose `mousedown` the FrameXML host takes; the canvas hears no
 * `pointerdown`. But the pointer crosses the canvas in the gaps between the buttons, and a
 * `pointermove` there carries `buttons` = 1 — which `syncButtons` read as the left button going down
 * on the world: the next move turned the camera and asked for the pointer lock, and the lock took the
 * cursor away from the drop. A press the interface took is the interface's until it comes up — the
 * stock button sees its OnDragStart through to the OnReceiveDrag it is dropped on — and the camera's
 * gesture is the one a press on the world starts.
 *
 * A move reports a press with its `button` (0, 1, 2…); a move that pressed nothing has −1. So a
 * button already down on a move that pressed nothing, with no gesture running, went down elsewhere —
 * or belongs to a gesture this file already abandoned — and stays out of every gesture until it comes
 * up. A press on the world still arrives as a `pointerdown` or as a chorded move with its own
 * `button`, and starts the gesture as before.
 */
let foreignButtons = 0;

/**
 * 5.14: the pointer is locked to the world for the length of a drag past the click threshold, as the
 * original hides the cursor while the mouse turns the camera; it comes back where it was when the
 * last button comes up. Only past the threshold, so a click keeps its cursor. The request rides the
 * pointerdown's user activation; a page that refuses it keeps the old captured drag.
 */
function requestDragPointerLock(): void {
  // Asked once per gesture: a refusal (no user activation left, a page without the API) is not
  // retried on every move of the same drag.
  if (drag.lockRequested || drag.lockRefused) return;
  const lock = (worldCanvas as { requestPointerLock?: () => unknown }).requestPointerLock;
  if (typeof lock !== "function") return;
  drag.lockRequested = true;
  try {
    const pending = lock.call(worldCanvas);
    // Chrome answers with a promise; a refusal there is an unlock, not an exception.
    if (pending && typeof (pending as Promise<unknown>).catch === "function") {
      (pending as Promise<unknown>).catch(() => {
        drag.lockRequested = false;
        drag.lockRefused = true;
      });
    }
  } catch {
    drag.lockRequested = false;
    drag.lockRefused = true;
  }
}

function releaseDragPointerLock(): void {
  if (!drag.lockRequested) return;
  drag.lockRequested = false;
  if (typeof document === "undefined" || document.pointerLockElement !== worldCanvas) return;
  try { document.exitPointerLock?.(); } catch { /* already gone */ }
}

/** True while the drag holds the pointer lock (or is waiting for it). */
function dragPointerLocked(): boolean {
  return drag.lockRequested && (drag.left || drag.right);
}

/**
 * The wheel, from the default orbit down into the character's own eyes and back out.
 *
 * The arithmetic is `zoomedDistance` and lives with the rest of the camera rig, where it can be
 * rolled without a canvas to roll it over; what belongs here is that the wheel writes `distance`
 * and nothing else. `zoom` follows it — measured, inside a hundredth of a yard after 0.383 s — and
 * `view` follows `zoom` once the walls have spoken. A notch that wrote the drawn distance directly
 * is what made every one of them a jump of its whole 2.5572 yards.
 */
function zoomCamera(step: number): void {
  // 11.02-GF3: `zoomedDistance` with a vehicle seat's bounds in force (VehicleCamera.ts: 50 yards with
  // ENABLE_VEHICLE_ZOOM, a seat's own floor and ceiling); exactly `zoomedDistance` outside one.
  game.camera.distance = vehicleCamera.zoom(game.camera.distance, step, cameraMaxDistance());
}

/**
 * Who a click selects, once the world has had its say.
 *
 * `pick` works on flat boxes and knows nothing about what stands between the camera and the body
 * whose box was hit — so a click through a tavern wall selected whoever was inside it. One ray per
 * click settles that, and the ray goes out here rather than after `selectTarget`, because
 * `selectTarget` puts `CMSG_SET_SELECTION` on the wire the moment it is called.
 *
 * Takes the two numbers rather than the event, because the hover's tail pass runs off a timer with
 * no event of its own — only the point the pointer stopped at.
 */
function pickAt(point: { clientX: number; clientY: number }): bigint | undefined {
  const bounds = worldCanvas.getBoundingClientRect();
  const guid = game.scene?.pick(point.clientX - bounds.left, point.clientY - bounds.top);
  if (guid === undefined) return undefined;
  const object = game.world?.state.objects.get(guid);
  if (object?.typeId === 5 && !interactiveGameObjectType(gameObjectType(object))) return undefined;
  return inSightFromCamera(guid) ? guid : undefined;
}

/**
 * Resolves a reticle click into a cast destination and sends it.
 *
 * Sky and unloaded ground resolve to nothing and leave the reticle armed rather than sending a
 * cast at nowhere. Range is checked client-side only to save the round trip; the server still
 * owns the verdict and may refuse a point this client accepted.
 */
function confirmGroundTargetAt(
  event: { clientX: number; clientY: number }, world: NonNullable<typeof game.world>, spellId: number, // 5.09: was PointerEvent
): void {
  const metadata = game.spells.get(spellId);
  const bounds = worldCanvas.getBoundingClientRect();
  const range = metadata ? groundTargetRange(metadata.rangeMax ?? 0) : undefined;
  const point = resolveGroundTarget(
    event.clientX - bounds.left, event.clientY - bounds.top,
    bounds.width, bounds.height, range ?? 100,
  );
  if (!point) {
    notice("Не удалось выбрать точку — кликните по земле, а не по небу", "info");
    return;
  }
  if (range !== undefined) {
    const self = world.state.selfGuid === undefined
      ? undefined : world.state.objects.get(world.state.selfGuid);
    if (self?.position && !groundPointInRange(point, self.position, range)) {
      notice(pendingGroundTargetItem() ? "Слишком далеко для этого предмета" : "Слишком далеко для выбранного заклинания");
      return;
    }
  }
  const item = pendingGroundTargetItem();
  const cooldown = metadata ? Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime) : 0;
  cancelGroundTarget();
  clearHoverCursor();
  if (item) {
    world.useItemAt(item.bag, item.slot, item.guid, point);
    return;
  }
  world.castSpellAt(spellId, point, cooldown, metadata?.cooldownStartedOnEvent ?? false);
}

/**
 * 5.17: what the hover cursor reads outside the world object — factions, the spellbook, the loot
 * settings, the lock table. One object for the session; every member reads the live state.
 */
const CURSOR_RULES: CursorRules = {
  reaction: (object) => reactionTo(object),
  canAttack: (object) => canAttackUnit(object),
  // 0x00513700: autoLootDefault, flipped while AUTOLOOTTOGGLE (Shift, the stock default) is held.
  autoLoot: () => settingOn("autoLoot") !== shiftHeld,
  gatherSpell: (object) => {
    const world = game.world;
    const plan = world ? gatherPlan(world as WorldClient, object) : undefined;
    return plan && "spellId" in plan ? plan.spellId : undefined;
  },
  spellRange: (spellId) => game.spells.get(spellId)?.rangeMax,
  lockCase: (lockId) => game.locks?.casesOf(lockId)[0],
  lockTypeCursor: (lockType) => game.locks?.lockTypeCursor(lockType), // 05.10-5.17: /dbc/locks?v=1
};

/** 5.17: the cursor a mode puts under everything with no cursor of its own (Wow.exe 0x00616270). */
function baseCursorName(): string {
  if (repair.active) return REPAIR_CURSOR_FILE;
  // 0x006d67e0: waiting gift-wrapping paper makes the cast glove the base cursor.
  if (giftWrapPending()) return CURSOR.cast;
  return CURSOR.point;
}
/** The body class style.css draws the cast cursor over the item slots for (SpellCursor.ts). */
const ITEM_TARGET_CURSOR_CLASS = "spell-item-cursor";
/** 5.17: the same cast cursor while gift-wrapping paper waits for its item (GiftWrap.ts, 0x006d67e0). */
const GIFT_WRAP_CURSOR_CLASS = "gift-wrap-cursor";

/**
 * How often the cursor is allowed to ask the scene what is under it.
 *
 * `pick` walks every hit box the last frame pushed, and a mouse moved across the window delivers a
 * `pointermove` per compositor frame or more. Sixteen milliseconds is one frame at 60 Hz: fast
 * enough that the cursor changes as the pointer crosses the body, slow enough that a drag across
 * the screen is one pick per drawn frame rather than one per event.
 */
const HOVER_INTERVAL = 16;
/** Re-pick a stationary GO while the player/camera moves so range and occlusion cannot go stale. */
const HOVER_WORLD_REFRESH = 100;

let hoveredAt = 0;
/** What `worldCanvas.style.cursor` was last written, so an unchanged frame writes nothing. */
let hoverCursor = "";
/** 5.17: the cursor file the last hover chose ("Attack", "UnableSpeak"…), for the pictures and the tests. */
let hoverCursorFile = "";

/** 5.17: the cursor file the last hover pass chose. */
export function hoverCursorName(): string {
  return hoverCursorFile;
}

/** Writes the canvas cursor for a file name, only when it changed. */
function showCursorFile(file: string): void {
  hoverCursorFile = file;
  const wanted = cursorCss(file);
  if (wanted === hoverCursor) return;
  hoverCursor = wanted;
  worldCanvas.style.cursor = wanted;
}
/** The trailing pass, if one is armed. It carries the point it will pick at in its closure. */
let hoverTailTimer: ReturnType<typeof setTimeout> | undefined;
let hoverWorldTimer: ReturnType<typeof setTimeout> | undefined;
/** The name card beside the pointer for an actionable game object, kept while the name is the same. */
let worldObjectTooltip: { readonly name: string; readonly content: TooltipContent } | undefined;
/** The cursor-mode owners of the shared tooltip (ui/Tooltip.ts) for an object and for a unit. */
const OBJECT_TIP = "world-object";
const UNIT_TIP = "world-unit";
/** The unit card on screen and the facts it was built from, so an unchanged unit is not rebuilt. */
let unitTip: { readonly guid: bigint; readonly key: string; readonly content: TooltipContent } | undefined;
/** The unit under the pointer whose native card is being kept current (4.04). */
let hoveredTipUnit: WorldObjectState | undefined;
/** The concrete GO spawn under the last sampled pointer position. */
let hoveredGameObject: WorldObjectState | undefined;
let hoveredPoint: { clientX: number; clientY: number } | undefined;
let pendingHoveredTemplate: {
  world: NonNullable<typeof game.world>;
  object: WorldObjectState;
  entry: number;
} | undefined;

/**
 * The cursor over whatever the pointer is on.
 *
 * There was no hover at all before this: `pick` ran only from `releaseButtons`, so nothing on the
 * screen answered the pointer until a button had already been pressed, and a body that still held
 * loot looked exactly like one that did not. The bag is the strongest signal the original client
 * has, and it costs one pick per drawn frame.
 *
 * 5.17: the answer is the original's own (Cursors.ts, Wow.exe 0x004F8190): the cursor a unit or a
 * game object asks for — Attack, Speak, Pickup or LootAll over a body with loot, the gathering one
 * over a skinnable body, the greyed twin out of range — drawn from the client's pictures, and the
 * mode's base cursor (Point; Repair while repairing; the cast glove while wrapping paper waits)
 * over everything else. A spent body that is neither lootable nor skinnable answers the default,
 * as in the client; its click still sends the loot request (see `isLootable`).
 *
 * Throttled at both edges. The leading edge is what keeps a drag across the screen to one pick per
 * drawn frame; the trailing one is what makes the gesture end where the pointer did. Without it the
 * last `pointermove` of a flick — the one that arrives less than 16 ms after the one before and is
 * followed by nothing, because the hand has stopped — was simply dropped, and the cursor stayed
 * whatever the previous sample had made it until the mouse moved again.
 */
function updateHoverCursor(event: PointerEvent): void {
  // A held button is a camera drag, and the drag has its own cursor — but `.camera-dragging` is a
  // class rule (`style.css:125`) and an inline `style.cursor` outranks any class, so the hover
  // cursor has to come *off* for the length of the drag rather than merely stop being rewritten.
  if (drag.left || drag.right) {
    clearHoverCursor();
    return;
  }
  cancelHoverTail();
  const wait = HOVER_INTERVAL - (performance.now() - hoveredAt);
  if (wait > 0) {
    // The trailing pick has not resolved this pointer position yet. Do not cast at the previous
    // unit if a mouseover macro is pressed in this short interval.
    setHoveredTarget(undefined, undefined);
    const { clientX, clientY } = event;
    hoverTailTimer = setTimeout(() => {
      hoverTailTimer = undefined;
      applyHoverCursor({ clientX, clientY });
    }, wait);
    return;
  }
  applyHoverCursor(event);
}

/**
 * One pick, and the cursor it means.
 *
 * The corpse is asked about by the bit and nothing else, the same predicate the plate and the
 * minimap dot use — but as *indication*. The click is not gated on it, so the worst a stale bit
 * costs here is a bag that is a hand.
 */
function applyHoverCursor(point: { clientX: number; clientY: number }): void {
  // A button may have gone down since a tail pass was armed — `pointerdown` moves nothing and so
  // never reaches `updateHoverCursor`. The drag owns the cursor for as long as it lasts.
  if (drag.left || drag.right) return;
  // The armed reticle owns the cursor: the cast glove over everything, greyed while the reticle's
  // point is out of range (Wow.exe 0x004F66C0: Cast, or UnableCast for a point the spell refuses),
  // with no pick spent on a gesture whose click is already spoken for. The cursor waiting for an
  // item greys the glove over the world (0x004FA040/0x004F8190: nothing there takes the spell),
  // except over a game object a lock spell can open (TARGET_FLAG_GAMEOBJECT_ITEM).
  const reticle = pendingGroundTarget() !== undefined;
  const itemTarget = reticle ? undefined : pendingItemTarget();
  if (reticle || itemTarget !== undefined) {
    setHoveredTarget(undefined, undefined);
    hoveredAt = performance.now();
    hoveredTipUnit = undefined;
    clearWorldObjectTooltip();
    clearUnitTooltip();
    let able = reticle && groundTargetInRange() === true;
    if (itemTarget?.orObject === true) {
      const guid = pickAt(point);
      able = guid !== undefined && game.world?.state.objects.get(guid)?.typeId === 5;
    }
    showCursorFile(able ? CURSOR.cast : CURSOR.unableCast);
    return;
  }
  hoveredAt = performance.now();
  const guid = pickAt(point);
  const object = guid === undefined ? undefined : game.world?.state.objects.get(guid);
  setHoveredTarget(game.world, object);
  hoveredGameObject = object?.typeId === 5 ? object : undefined;
  // The stock HUD draws its own GameTooltip:SetUnit("mouseover") card (FrameXmlWorldMouseover.ts),
  // so the native one is only for the native HUD.
  hoveredTipUnit = object && (object.typeId === 3 || object.typeId === 4) && game.world
    && !nativeHudReplaced(NATIVE_LANES_REPLACED) ? object : undefined;
  hoveredPoint = { clientX: point.clientX, clientY: point.clientY };
  if (pendingHoveredTemplate?.object !== hoveredGameObject) pendingHoveredTemplate = undefined;
  const objectName = object?.typeId === 5 ? gameObjectHoverName(object) : undefined;
  // 5.17: the original's own choice (Cursors.ts, Wow.exe 0x004F8190), or the mode's base cursor.
  const world = game.world;
  const file = world && object && (object.typeId !== 5 || objectName !== undefined)
    ? worldObjectCursor(world as unknown as CursorWorld, object, object.typeId === 5 ? gameObjectType(object) : 0, CURSOR_RULES)
    : "";
  if (objectName) showWorldObjectTooltip(objectName, point);
  else clearWorldObjectTooltip();
  const unitCard = hoveredTipUnit && game.world ? unitHoverCard(game.world, hoveredTipUnit) : undefined;
  if (unitCard) showTooltipAtPoint(UNIT_TIP, unitCard, point.clientX, point.clientY);
  else clearUnitTooltip();
  // A stationary pointer is re-picked so range, occlusion and the unit's level, death or late
  // template answer reach the cursor and the card without the mouse moving.
  if (hoveredGameObject || hoveredTipUnit) scheduleHoverWorldRefresh();
  else cancelHoverWorldRefresh();
  showCursorFile(file || baseCursorName());
}

/** Drops a tail pass that is about to answer about a point the pointer has already left. */
function cancelHoverTail(): void {
  if (hoverTailTimer === undefined) return;
  clearTimeout(hoverTailTimer);
  hoverTailTimer = undefined;
}

function scheduleHoverWorldRefresh(): void {
  cancelHoverWorldRefresh();
  if ((!hoveredGameObject && !hoveredTipUnit) || !hoveredPoint || drag.left || drag.right) return;
  hoverWorldTimer = setTimeout(() => {
    hoverWorldTimer = undefined;
    if (hoveredPoint) applyHoverCursor(hoveredPoint);
  }, HOVER_WORLD_REFRESH);
}

function cancelHoverWorldRefresh(): void {
  if (hoverWorldTimer === undefined) return;
  clearTimeout(hoverWorldTimer);
  hoverWorldTimer = undefined;
}

/**
 * Back to the stylesheet's own cursor — `crosshair` (`style.css:124`), not the page default.
 * Called when a drag starts, when the pointer leaves the canvas, and when the window loses focus.
 *
 * The tail is cancelled before the early return rather than after it: a pointer that has left the
 * canvas with the cursor already `crosshair` still has a pending pick aimed at wherever it was,
 * and that pick would write a bag onto a canvas the pointer is no longer over.
 */
function clearHoverCursor(): void {
  hoverCursorFile = "";
  setHoveredTarget(undefined, undefined);
  cancelHoverTail();
  cancelHoverWorldRefresh();
  hoveredGameObject = undefined;
  hoveredTipUnit = undefined;
  hoveredPoint = undefined;
  pendingHoveredTemplate = undefined;
  clearWorldObjectTooltip();
  clearUnitTooltip();
  if (hoverCursor === "") return;
  hoverCursor = "";
  worldCanvas.style.cursor = "";
}

function gameObjectHoverName(object: import("../../world/WorldState.js").WorldObjectState): string | undefined {
  const world = game.world;
  const type = gameObjectType(object);
  if (!world || !interactiveGameObjectType(type)) return undefined;
  // NOT_SELECTABLE is the flag that says "no tooltip": everything else names itself. Distance
  // is deliberately not asked here — the original client shows the name at any range and lets
  // the server refuse the click, so a quest giver across the room still introduces itself.
  const flags = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0;
  if ((flags & GO_FLAG_NOT_SELECTABLE) !== 0) return undefined;
  const entry = object.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  if (entry <= 0) return undefined;
  const template = world.gameObjectTemplate(entry, object.guid);
  if (!template) {
    waitForHoveredGameObjectTemplate(world, object, entry);
    return undefined;
  }
  if (template.type !== type || template.iconName === "Point") return undefined;
  return template.name.trim() || "Объект";
}

function waitForHoveredGameObjectTemplate(
  world: NonNullable<typeof game.world>,
  object: WorldObjectState,
  entry: number,
): void {
  const held = pendingHoveredTemplate;
  if (held?.world === world && held.object === object && held.entry === entry) return;
  const intent = { world, object, entry };
  pendingHoveredTemplate = intent;
  void world.waitForGameObjectTemplate(entry, object.guid).then((template) => {
    if (pendingHoveredTemplate !== intent) return;
    pendingHoveredTemplate = undefined;
    if (game.world !== world || hoveredGameObject !== object || !hoveredPoint) return;
    const current = world.state.objects.get(object.guid);
    // A real answer repaints a stationary pointer. A vanished/reused spawn also repicks so a stale
    // hand cannot survive UPDATE_OUT_OF_RANGE; a mere timeout does not start another ten-second wait.
    if (template || current !== object) applyHoverCursor(hoveredPoint);
  });
}

/** The object's name beside the cursor, in the shared tooltip (ui/Tooltip.ts cursor mode). */
function showWorldObjectTooltip(name: string, point: { clientX: number; clientY: number }): void {
  if (worldObjectTooltip?.name !== name) worldObjectTooltip = { name, content: { title: name, cursor: true } };
  showTooltipAtPoint(OBJECT_TIP, worldObjectTooltip.content, point.clientX, point.clientY);
}

function clearWorldObjectTooltip(): void {
  if (!worldObjectTooltip) return;
  worldObjectTooltip = undefined;
  hideTooltipAtPoint(OBJECT_TIP);
}

/**
 * The unit's card (ui/UnitTooltip.ts), rebuilt only when what it says has changed; undefined while
 * the unit's name is still on its way (the refresh asks again).
 */
function unitHoverCard(world: NonNullable<typeof game.world>, object: WorldObjectState): TooltipContent | undefined {
  const facts = unitTooltipFacts(world, object, {
    // Until the faction table has landed every reaction would read neutral: the name stays white.
    reaction: (unit) => (game.factions?.ready === true ? reactionTo(unit) : undefined),
    canAttack: canAttackUnit,
    spellRow: (id) => game.spells.get(id),
  });
  if (!facts) return undefined;
  const key = unitTooltipKey(facts);
  if (unitTip?.guid !== object.guid || unitTip.key !== key) {
    unitTip = { guid: object.guid, key, content: unitTooltipContent(facts) };
  }
  return unitTip.content;
}

function clearUnitTooltip(): void {
  if (!unitTip) return;
  unitTip = undefined;
  hideTooltipAtPoint(UNIT_TIP);
}

/**
 * Takes the button state from the event and reports what has just been let go of.
 *
 * Everything about a gesture is derived here — which buttons are down, whether the two-button run
 * is on, and where the gesture started — so no listener has to keep its own idea of it.
 */
function syncButtons(event: PointerEvent): { releasedLeft: boolean; releasedRight: boolean; click: number } {
  const bitsBefore = cameraButtonBits(); // 13.10
  // 11.10: a button let go of is nobody's any more; one already held on a move that pressed nothing
  // while no gesture runs went down somewhere else (see `foreignButtons`) and is not read below.
  foreignButtons &= event.buttons;
  if (!drag.left && !drag.right && !(event.button >= 0)) foreignButtons |= event.buttons & 3;
  const held = event.buttons & ~foreignButtons; // 11.10: was `event.buttons` in the two lines below
  const left = (held & 1) !== 0;
  const right = (held & 2) !== 0;
  const releasedLeft = drag.left && !left;
  const releasedRight = drag.right && !right;
  // L8-review 5.09: a button's release is its Stop for whoever set the bit (Wow.exe 0x005fa450): the Lua command on
  // it goes too, and the turn it made is reported with the release's (releaseButtons).
  if (luaButtons !== 0 && (releasedLeft || releasedRight)) {
    if (releasedRight && (luaButtons & TURN_OR_ACTION) !== 0 && luaTurned) drag.turned = true;
    if (releasedRight) luaTurned = false;
    luaButtons &= ~((releasedLeft ? CAMERA_OR_SELECT_OR_MOVE : 0) | (releasedRight ? TURN_OR_ACTION : 0));
  }
  // A gesture starts when the first button goes down and lasts until the last one comes up, so a
  // drag that picked up a second button on the way is still one gesture.
  if (!drag.left && !drag.right && (left || right)) {
    drag.moved = 0;
    drag.turned = false;
    drag.lockRefused = false;
  }
  const wasDragging = drag.left || drag.right;
  const wasRight = drag.right;
  // 5.14: the right button going down turns the character to where the camera looks, and the
  // camera's offset is spent doing it — the view does not jump. A stun holds the facing (5.11),
  // and the camera keeps its offset.
  // DEC-B 3.11: by the yaw without FlipCameraYaw's part, which stays (Wow.exe 0x6023d0 turns by camera+0x11c);
  // was `game.camera.yaw !== 0 && turnCharacterBy(game.camera.yaw)` and `yaw = 0` — the same without a flip.
  if (right && !wasRight && cameraYawOffFlip(game.camera) !== 0 && turnCharacterBy(cameraYawOffFlip(game.camera))) {
    game.camera.yaw = game.camera.flipYaw ?? 0;
    drag.turned = true;
  }
  drag.left = left;
  drag.right = right;
  const click = pageButtonEdges(bitsBefore, cameraButtonBits(), eventTime(event)); // 13.10
  // 3.11: the last mouse command let go (game/CameraFollow.ts): the left with CameraOrSelectOrMoveStop(
  // IsModifiedClick("STICKYCAMERA")) — Ctrl by default (Bindings.xml) — the right with TurnOrActionStop(), never sticky.
  if (wasDragging && !left && !right && luaButtons === 0) cameraButtonsLetGo = releasedLeft && event.ctrlKey === true;
  // L8 5.09: a mouse command held from Lua counts as its button (was `left && right`, `right`).
  setMouseRun((left || (luaButtons & CAMERA_OR_SELECT_OR_MOVE) !== 0) && (right || (luaButtons & TURN_OR_ACTION) !== 0));
  // 5.10: the right button (alone or with the left) steers — the character's pitch is the camera's.
  setSteering(right || (luaButtons & TURN_OR_ACTION) !== 0);
  // 5.14: A and D strafe while the right button is down, and turn again when it comes up.
  if (right !== wasRight) refreshStrafeModifier();
  // The last button up ends the lock, and the cursor comes back where the drag started.
  if (!left && !right) releaseDragPointerLock();
  // Written only when it changes: this runs on every mouse move over the canvas, and a class
  // written per move is a style recalculation per move.
  if (wasDragging !== (left || right)) worldCanvas.classList.toggle("camera-dragging", left || right);
  return { releasedLeft, releasedRight, click };
}

/** 13.10: the two command bits in the order an event's edges are taken — TurnOrAction (1), CameraOrSelectOrMove (2). */
const COMMAND_BITS = [TURN_OR_ACTION, CAMERA_OR_SELECT_OR_MOVE] as const;

/**
 * 13.10: the page's own buttons through the commands' click (MouseCommandClick.ts), as Wow.exe has one rule for both.
 * The left and right buttons are BUTTON1 and BUTTON2, whose stock bindings are CameraOrSelectOrMove and TurnOrAction
 * (Bindings.xml); the world's mouse-button press and release (0x004f6c10, 0x004f6c90) run them through 0x00563150 as
 * any key's binding, so their bits are set and cleared by 0x005fa170 and 0x005fa450 and the release clicks by
 * 0x005f9600 — a press is a drag once held 800 ms, or moved 8 on an axis and held 200 ms. `before` and `after` are
 * {@link cameraButtonBits} around the event (a Lua command on the same bit counted: its bit already set is no new
 * press, 0x005fa170 returns early); the releases are taken before the presses. Answers the click a release made, or
 * none. Was: a click for a press that moved at most 3 px (`drag.moved`, both axes summed) and never shared the gesture
 * with the other button (`drag.seen`), however long it was held.
 */
function pageButtonEdges(before: number, after: number, now: number): number {
  if (before === after) return MOUSE_CLICK_NONE;
  let bits = before;
  let click = MOUSE_CLICK_NONE;
  for (const bit of COMMAND_BITS) {
    if ((before & bit) === 0 || (after & bit) !== 0) continue;
    const made = mouseClick.up(bits, bits & ~bit, now, false);
    bits &= ~bit;
    if (made !== MOUSE_CLICK_NONE) click = made;
  }
  for (const bit of COMMAND_BITS) {
    if ((before & bit) !== 0 || (after & bit) === 0) continue;
    mouseClick.down(bit, bits, bits | bit, now, false);
    bits |= bit;
  }
  return click;
}

/**
 * 13.10: when an input event happened, on the clock the Lua commands' edges read (`performance.now()`): the event's own
 * stamp where it has one (Wow.exe 0x005fa450 is handed the event's time, `param_3`).
 */
function eventTime(event: { timeStamp?: number }): number {
  const stamp = event.timeStamp;
  return typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0 ? stamp : performance.now();
}

function releaseButtons(event: PointerEvent): void {
  const { releasedLeft, releasedRight, click } = syncButtons(event);
  if (!releasedLeft && !releasedRight) return;
  // The camera has stopped; tell the server where the character ended up facing, since a turn on
  // the spot sends nothing else.
  // 13.10: any move under the right button turned the character (`drag.moved > 0`, was `> DRAG_THRESHOLD`, 3 px).
  if (releasedRight && (drag.moved > 0 || drag.turned)) flushFacing();
  // 5.09: the click itself is `worldClick`, which the Lua mouse commands' release runs too (was inline here, with
  // `releasedLeft && clicked(1)` and `releasedRight && clicked(2)` where it reads `left` and `right`).
  // 13.10: the commands' click (pageButtonEdges): CameraOrSelectOrMove's selects, TurnOrAction's interacts (was
  // `releasedLeft && clicked(1), releasedRight && clicked(2)`).
  worldClick(event, click === MOUSE_CLICK_SELECT, click === MOUSE_CLICK_INTERACT);
}

/**
 * A click on the world at `point`: `left` selects or drops the target, `right` selects and interacts — the world click
 * Wow.exe 0x004f7880(1) and (4) is, for the page's own buttons and (5.09) the Lua mouse commands' release.
 */
function worldClick(point: { clientX: number; clientY: number }, left: boolean, right: boolean): void {
  if (!left && !right) return;
  const world = game.world;
  // A right click on the world is SpellStopTargeting, as in the client: a waiting enchant (stock
  // TradeSkillFrame's DoTradeSkill cursor) is dropped and the click selects and opens nothing.
  // Asked before the reticle below, in the seam's SpellStopTargeting order; drags stay the camera's.
  if (right && stopFrameXmlTradeSkillTargeting()) return;
  // L1-review (2.05 E): … and waiting wrapping paper goes too (0x0051fb00 → 0x00519280), the click
  // selecting nothing, as the item cursor's right click below.
  if (right && cancelGiftWrap()) return;
  if (!world) return;

  // A spell or item waiting for an item (SpellCursor.ts): a right click drops it. A left click on a
  // unit or object is offered to the pending spell, which takes nothing but an item, so it selects
  // nothing and the cursor stays (Wow.exe 0x00524bf0: 0x007fd620 → 0x0080bc80, then return). A left
  // click on bare ground is the ordinary ground click (0x00527360: 0x0080c340 takes no point for an
  // ITEM-only mask) and drops the target as it always does here; the cursor stays. Drags stay the
  // camera's.
  if (pendingItemTarget(world) !== undefined) {
    if (right) {
      cancelItemTarget();
      clearHoverCursor();
      return;
    }
    if (left) {
      const picked = pickAt(point);
      // «Взлом замка» and the keys (TARGET_FLAG_GAMEOBJECT_ITEM in the mask) take a chest: the spell
      // goes at it and the cursor comes down (0x0080bc80); any other cursor ignores the object.
      if (picked !== undefined && targetGameObjectWithCursor(picked, world).kind === "sent") {
        clearHoverCursor();
        return;
      }
      if (picked !== undefined) return;
    }
  }

  // The reticle owns both clicks while it is armed: left chooses the landing point, right
  // cancels. Drags still belong to the camera, so only unmoved presses divert here.
  const pendingSpell = pendingGroundTarget();
  if (pendingSpell !== undefined) {
    if (right) {
      cancelGroundTarget();
      clearHoverCursor();
      return;
    }
    if (left) {
      confirmGroundTargetAt(point, world, pendingSpell);
      return;
    }
  }

  // The left button picks a target or drops it; the right one picks and then interacts, which is
  // the gesture the original client leans on hardest.
  if (left) {
    // An item on the stock bag cursor dropped on the world asks DELETE_ITEM_CONFIRM, as the client
    // does for an item let go outside every frame; that click selects nothing.
    if (frameXmlPopupsDropCursorItem()) return;
    const picked = pickAt(point);
    // 5.14: deselectOnClick off («Фиксация на цели»): bare ground keeps the target.
    if (picked === undefined && !settingOn("deselectOnClick")) return;
    world.selectTarget(picked);
    showTarget();
    return;
  }
  if (right) {
    const guid = pickAt(point);
    if (guid === undefined) return;
    const object = world.state.objects.get(guid);
    if (object?.typeId !== 5) {
      world.selectTarget(guid);
      showTarget();
    }
    interactWithGuid(guid);
  }
}

/** Ends the gesture without acting on it: the buttons are gone, not released. */
function abandonGesture(): void {
  releaseDragPointerLock();
  if (!drag.left && !drag.right) return;
  const wasRight = drag.right;
  drag.left = false;
  drag.right = false;
  // 13.10: the buttons went without a release, so nothing clicks (was `drag.seen = 0`).
  mouseClick.reset();
  // L8 5.09: what Lua still holds stays held (was `false`, `false`).
  setMouseRun(luaButtons === (TURN_OR_ACTION | CAMERA_OR_SELECT_OR_MOVE));
  setSteering((luaButtons & TURN_OR_ACTION) !== 0);
  if (wasRight) refreshStrafeModifier();
  worldCanvas.classList.remove("camera-dragging");
}

function wireMouse(): void {
  // The original client owns the right button: it never opens a browser menu anywhere. The
  // canvas and a few widgets already swallow `contextmenu` one by one, but every other surface
  // (panels, bars, dialogs) still popped the browser menu on right click. One document-level
  // handler covers them all; editable fields keep theirs so chat/input menus (paste, spellcheck)
  // keep working.
  document.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) {
      return;
    }
    event.preventDefault();
  });

  worldCanvas.addEventListener("contextmenu", (event) => event.preventDefault());

  worldCanvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 2) return;
    // A tap is a press with no useful move before it; the reticle gets its position from here so
    // touch shows the rings from the first contact.
    recordGroundTargetPointer(event.clientX, event.clientY);
    worldCanvas.setPointerCapture(event.pointerId);
    syncButtons(event);
    setHoveredTarget(undefined, undefined);
    event.preventDefault();
  });

  worldCanvas.addEventListener("pointermove", (event) => {
    recordGroundTargetPointer(event.clientX, event.clientY);
    // 5.09: where the pointer is for a Lua command's click, unless a lock holds it (the cursor stays where it was).
    if (typeof document === "undefined" || document.pointerLockElement !== worldCanvas) {
      lastPointer ??= { clientX: 0, clientY: 0 };
      lastPointer.clientX = event.clientX;
      lastPointer.clientY = event.clientY;
    }
    // A chorded press or release arrives as a move, so the buttons are re-read on every one.
    const wasDragging = drag.left || drag.right;
    releaseButtons(event);
    // 5.09: a Lua mouse command (TurnOrAction, Mouselook, CameraOrSelectOrMove) with no page button down: the mouse
    // turns the camera as under the button (Wow.exe 0x005fba60 asks the input word, not the buttons) and counts for the
    // release's click (MouseCommandClick.ts); no hover while it does.
    const luaLook = luaButtons !== 0 && !drag.left && !drag.right;
    if (luaLook) {
      mouseClick.moved(event.movementX, event.movementY);
      clearHoverCursor();
    } else {
      updateHoverCursor(event);
      if (!wasDragging || (!drag.left && !drag.right)) return;
      drag.moved += Math.abs(event.movementX) + Math.abs(event.movementY);
      // 13.10: the buttons' moves count for their release's click as the Lua commands' do (0x005fba60: |dx|, |dy|).
      mouseClick.moved(event.movementX, event.movementY);
      // 5.14: past the lock threshold the drag hides the cursor and keeps the pointer.
      if (drag.moved > LOCK_THRESHOLD) requestDragPointerLock(); // 13.10: LOCK_THRESHOLD (was DRAG_THRESHOLD)
    }
    // 5.09: the right button, or the Lua right command without a page button (was `drag.right` below).
    const steer = drag.right || (luaLook && (luaButtons & TURN_OR_ACTION) !== 0);
    const camera = game.camera;
    // One sensitivity for both axes, as the reference client has (`camera_controller.hpp:342`),
    // scaled by the stock mouseSpeed and cameraYawMoveSpeed (5.14, CameraRig.cameraLookPerPixel);
    // mouseInvertPitch turns the vertical over.
    const values = settings();
    const perPixel = cameraLookPerPixel(settingNumber(values, "mouseSpeedPercent"), settingNumber(values, "mouseLookSpeed"));
    const vertical = settingOn("mouseInvertPitch") ? -event.movementY : event.movementY;
    // 11.02-GF3: a vehicle that aims with the steering drag takes its vertical as its own pitch and the
    // camera keeps its tilt (Movement.aimMoverPitchBy, Wow.exe 0x005fba60); everything else as before.
    if (!(steer && aimMoverPitchBy(-vertical * perPixel))) {
      camera.pitch = Math.max(-CAMERA_PITCH_LIMIT,
        Math.min(CAMERA_PITCH_LIMIT, camera.pitch - vertical * perPixel));
    }
    if (steer) {
      // The right button turns the character and the camera comes home behind it, so the offset
      // goes back to zero rather than being carried around at the player's back.
      // 5.11: under a stun the facing is held, so the drag turns the camera as the left one does.
      if (turnCharacterBy(-event.movementX * perPixel)) {
        if (luaLook) luaTurned = true; // 5.09: the Lua command's release reports the facing (holdButton)
        camera.yaw = camera.flipYaw ?? 0; // DEC-B 3.11: home is the flip (was 0)
        return;
      }
    }
    // The left button looks around without the character noticing.
    camera.yaw = normalizeAngle(camera.yaw - event.movementX * perPixel);
  });

  worldCanvas.addEventListener("pointerup", releaseButtons);
  // A pointer that has left the canvas is over the interface, which owns its own cursor: leaving
  // the bag written on the canvas would put it back the moment the pointer returned, over
  // whatever now happens to be there.
  worldCanvas.addEventListener("pointerleave", () => {
    clearHoverCursor();
    // 5.09: over the interface nothing in the world is under the cursor for a Lua command's click (was clearHoverCursor
    // alone as the listener).
    if (luaButtons === 0) lastPointer = undefined;
  });
  for (const name of ["pointercancel", "lostpointercapture"] as const) {
    // Neither means the player let go of anything, so the gesture is abandoned rather than
    // finished: no target is picked and no facing is sent. `lostpointercapture` also arrives
    // right after every ordinary release, when there is nothing left to abandon — and when the
    // pointer lock (5.14) takes the pointer over from the capture, which is the drag going on.
    worldCanvas.addEventListener(name, () => {
      if (name === "lostpointercapture" && dragPointerLocked()) return;
      abandonGesture();
    });
  }
  // 5.14: a lock lost under a held button (Escape, Alt-Tab) ends the gesture; a refused one leaves
  // the captured drag as it was.
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement === worldCanvas || !dragPointerLocked()) return;
    drag.lockRequested = false;
    abandonGesture();
  });
  document.addEventListener("pointerlockerror", () => {
    drag.lockRequested = false;
    drag.lockRefused = true;
  });

  worldCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    zoomCamera(step);
  }, { passive: false });
}

/**
 * 3.11: the last mouse command let go since the frame's follow ran, with CameraOrSelectOrMoveStop's sticky argument
 * (game/CameraFollow.ts); undefined while none was.
 */
let cameraButtonsLetGo: boolean | undefined;

/** 3.11: the right button (or TurnOrAction/Mouselook) and the left (CameraOrSelectOrMove) as input word bits 1 and 2. */
function cameraButtonBits(): number {
  return (drag.right || (luaButtons & TURN_OR_ACTION) !== 0 ? 1 : 0)
    | (drag.left || (luaButtons & CAMERA_OR_SELECT_OR_MOVE) !== 0 ? 2 : 0);
}

/**
 * 3.11: the camera coming back behind the character (cameraSmoothStyle) as Wow.exe 0x00602760 does it — on the edges
 * of the input word, not as a pull every frame (game/CameraFollow.ts) — once a frame from the render loop, before the
 * views' glide. `subject` undefined: a view that is not the player's to turn; the edges are taken, nothing glides.
 * Was (5.14) `advanceCameraAutoFollow(elapsed)`, a pull at cameraYawSmoothSpeed while the character moved.
 */
export function advanceCameraAutoFollow(now: number, subject: CameraFollowHost["subject"]): void {
  const word = movementInputWord() | cameraButtonBits();
  const letGo = cameraButtonsLetGo;
  if (!cameraFollow.pending(word, letGo)) return;
  cameraButtonsLetGo = undefined;
  let host: CameraFollowHost | undefined;
  if (subject !== undefined) {
    const values = settings();
    const yaw = settingNumber(values, "cameraYawSmoothSpeed");
    // cameraPitchSmoothSpeed is the stock slider's quarter of the yaw's (InterfaceOptionsPanels.xml), as the views take it.
    host = { style: settingNumber(values, "cameraSmoothStyle"), yawSpeed: yaw, pitchSpeed: yaw / 4, subject };
  }
  cameraFollow.input(word, letGo, game.camera, now, cameraViews, host);
}

/**
 * L8 5.09: a held command from Lua (input/MovementCommands.ts) — MoveForwardStart/Stop and the rest, RunBinding with a
 * keystate. Down holds it as its key would, under a code no key sends; a second Start, or a Start while its key is down,
 * is no new edge (Wow.exe 0x005fa170 dispatches only a bit that was clear). Up stops it whoever holds it — the key too
 * (0x005fa450 clears the bit for every holder); the key's entry stays until its keyup, which then stops nothing, and its
 * autorepeat does not start it again.
 */
function holdCommand(action: InputAction, down: boolean): void {
  if (!HELD_ACTIONS.has(action)) {
    if (down) runAction(action);
    return;
  }
  const bit = heldMovementAction(action);
  if (!down) {
    for (const [code, entry] of heldByCode) {
      if (heldMovementAction(entry.base) !== bit) continue;
      if (code.startsWith(LUA_HOLD)) heldByCode.delete(code);
      else stoppedHolds.add(entry); // L8-review 5.09
      endHeld(entry.current);
    }
    endHeld(action);
    return;
  }
  if (!game.world) return;
  for (const entry of heldByCode.values()) {
    if (heldMovementAction(entry.base) !== bit) continue;
    // L8-review 5.09: a key a Stop let go is taken up as the strafe modifier stands now.
    if (stoppedHolds.delete(entry)) {
      entry.current = (shiftHeld || drag.right || (luaButtons & TURN_OR_ACTION) !== 0) && !moverRefusesStrafe()
        ? strafeInsteadOfTurn(entry.base) : entry.base;
    }
    // Already held: no edge, but the command is held again if something let it go behind the table's back.
    beginHeld(entry.current);
    return;
  }
  const strafing = (shiftHeld || drag.right || (luaButtons & TURN_OR_ACTION) !== 0) && !moverRefusesStrafe();
  const current = strafing ? strafeInsteadOfTurn(action) : action;
  heldByCode.set(LUA_HOLD + action, { base: action, current });
  beginHeld(current);
  // The verb on the way down, as the key's (the sit of SitStandOrDescendStart); not under the loading screen.
  if (game.world.movementReady) runAction(current);
}

/**
 * L8 5.09: TurnOrAction/Mouselook (1) and CameraOrSelectOrMove (2) from Lua count as the right and left buttons for
 * what the buttons do to movement (Wow.exe 0x005fae70, 0x005fafb0): both run forward, the right one steers, turns the
 * turn keys into strafes and, going down, turns the character to the camera as the button's press does (syncButtons).
 */
function holdButton(bit: number, down: boolean, how?: MouseCommandHow): void { // 3.11/5.09: `how`
  if (bit !== TURN_OR_ACTION && bit !== CAMERA_OR_SELECT_OR_MOVE) return;
  const before = luaButtons;
  const after = down ? before | bit : before & ~bit;
  if (after === before || (down && !game.world)) {
    // 5.09: MouselookStart/Stop set the click mode to none whether or not the bit moves (0x005fcc10, 0x005fc890).
    if (how?.mouselook) mouseClick.reset();
    return;
  }
  // 5.09: the click bookkeeping over the two command bits, the page's own buttons counted (MouseCommandClick.ts).
  const bitsBefore = cameraButtonBits();
  luaButtons = after;
  const bitsAfter = cameraButtonBits();
  const now = performance.now();
  if (down) mouseClick.down(bit, bitsBefore, bitsAfter, now, how?.mouselook === true);
  // 3.11: the last mouse command let go: CameraOrSelectOrMoveStop's argument (0x005fc730 → 0x005fa450 → 0x00604850).
  if (!down && after === 0 && !drag.left && !drag.right) cameraButtonsLetGo = bit === CAMERA_OR_SELECT_OR_MOVE && how?.sticky === true;
  // 5.09: the mouse turns the camera under a Lua command without a button (Wow.exe 0x005fba60 reads the input word, not
  // the buttons); the cursor is held as the drag holds it, if the page lets it (a key's press is a user activation).
  if (before === 0 && !drag.left && !drag.right) requestLuaPointerLock();
  if (after === 0) releaseLuaPointerLock();
  const rightBefore = drag.right || (before & TURN_OR_ACTION) !== 0;
  const right = drag.right || (after & TURN_OR_ACTION) !== 0;
  // DEC-B 3.11: without FlipCameraYaw's part, as the button's press (syncButtons).
  if (right && !rightBefore && cameraYawOffFlip(game.camera) !== 0 && turnCharacterBy(cameraYawOffFlip(game.camera))) {
    game.camera.yaw = game.camera.flipYaw ?? 0;
    luaTurned = true;
  }
  setMouseRun((drag.left || (after & CAMERA_OR_SELECT_OR_MOVE) !== 0) && right);
  setSteering(right);
  if (right !== rightBefore) refreshStrafeModifier();
  // As the button's release (releaseButtons): the facing the turn left the character with.
  if (!right && rightBefore && luaTurned) {
    luaTurned = false;
    flushFacing();
  }
  // 5.09: the release's click (0x005fa450 → 0x005f9600 → 0x004f7880): select or interact under the cursor.
  if (!down) {
    const click = mouseClick.up(bitsBefore, bitsAfter, now, how?.mouselook === true);
    if (click !== MOUSE_CLICK_NONE && lastPointer) worldClick(lastPointer, click === MOUSE_CLICK_SELECT, click === MOUSE_CLICK_INTERACT);
  }
}

/**
 * 5.09: MouseCommandClick.ts over the Lua mouse commands. 13.10: and over the page's own buttons (pageButtonEdges) — one
 * click over the two command bits whoever sets them, as Wow.exe keeps one at input+0x18 (was `luaClick`, the Lua
 * commands' alone).
 */
const mouseClick = new MouseCommandClick();
/** 5.09: where the pointer last was over the world, for the Lua commands' click (the cursor stays put under the lock). */
let lastPointer: { clientX: number; clientY: number } | undefined;
/** 5.09: the pointer lock a Lua command asked for. */
let luaLockRequested = false;

/** 5.09: the pointer held for a Lua mouse command, as requestDragPointerLock holds it for the drag; a refusal is kept. */
function requestLuaPointerLock(): void {
  const lock = (worldCanvas as { requestPointerLock?: () => unknown }).requestPointerLock;
  if (typeof lock !== "function" || luaLockRequested) return;
  luaLockRequested = true;
  try {
    const pending = lock.call(worldCanvas);
    if (pending && typeof (pending as Promise<unknown>).catch === "function") {
      (pending as Promise<unknown>).catch(() => { luaLockRequested = false; });
    }
  } catch {
    luaLockRequested = false;
  }
}

function releaseLuaPointerLock(): void {
  if (!luaLockRequested) return;
  luaLockRequested = false;
  if (drag.left || drag.right || typeof document === "undefined" || document.pointerLockElement !== worldCanvas) return;
  try { document.exitPointerLock?.(); } catch { /* already gone */ }
}

/** L8 5.09: the Lua commands go back to nothing (focus lost, the world changed). */
function forgetLuaButtons(): void {
  // L8-review 5.09: the Lua right button's steering goes with it (the blur's abandonGesture skips it with no button down).
  if ((luaButtons & TURN_OR_ACTION) !== 0) setSteering(drag.right);
  luaButtons = 0;
  luaTurned = false;
  mouseClick.reset(); // 5.09 (13.10: was luaClick)
  releaseLuaPointerLock(); // 5.09
  moveAndSteerKeys.clear(); // 5.09
}

/** L8 5.09: the live input the stock movement C API reaches (input/MovementCommands.ts), registered by wireControls. */
const MOVEMENT_COMMANDS = {
  hold: holdCommand,
  button: holdButton,
  mouselooking: (): boolean => drag.right || (luaButtons & TURN_OR_ACTION) !== 0,
};

/** Keyboard, mouse and camera. Registered once, at start-up. */
export function wireControls(): void {
  registerFrameXmlNativeEscape(NATIVE_ESCAPE);
  registerMovementCommandInput(MOVEMENT_COMMANDS); // L8 5.09
  // The cast cursor over the windows while a spell or item waits for an item (style.css).
  // 5.17: arming asks for the cast glove's picture, which the body-class cursors read too.
  observeItemTarget((armed) => {
    document.body?.classList?.toggle(ITEM_TARGET_CURSOR_CLASS, armed);
    if (armed) castCursorForBody();
  });
  observeGiftWrap((armed) => {
    document.body?.classList?.toggle(GIFT_WRAP_CURSOR_CLASS, armed);
    if (armed) castCursorForBody();
    // The base cursor under the pointer changes with it.
    if (hoverCursorFile !== "" && !drag.left && !drag.right && hoveredPoint) applyHoverCursor(hoveredPoint);
  });
  // 5.17: the client's cursor pictures through the gateway's `/texture` route, asked for as each is
  // first wanted; a stationary pointer is redrawn when its picture lands.
  useCursorPictures((path) => {
    const origin = game.gatewayOrigin;
    if (!origin) return undefined;
    const url = new URL("/texture", origin);
    url.searchParams.set("path", path);
    return url.href;
  });
  onCursorPicture(() => {
    if (hoverCursorFile !== "" && !drag.left && !drag.right) showCursorFile(hoverCursorFile);
  });
  // 5.18: the native HUD's AutoFollowStatus — the stock one is ZoneText.lua's, on the seam's events.
  let followedName = "";
  onFollowChange((change) => {
    if (change.kind === "begin") followedName = change.name;
    if (nativeHudReplaced(NATIVE_LANES_REPLACED)) return;
    notice(change.kind === "begin" ? `Вы следуете за: ${followedName}.` : `Вы прекратили следовать за: ${followedName}.`, "info");
  });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => {
    // A key held while alt-tabbing never gets its release, and a character that never hears about
    // it runs off a cliff.
    heldByCode.clear();
    directByCode.clear(); // 13.10: a release that never came casts nothing
    shiftHeld = false;
    forgetLuaButtons(); // L8 5.09
    abandonGesture();
    clearHoverCursor();
    releaseAllInput();
  });
  wireMouse();
}

/**
 * Drops every key the client thinks is down, and the arc it was in the middle of.
 *
 * Called when the world changes under the player. A teleport out of a fall would otherwise land
 * the character on another continent still holding a fall clock, and be charged for it.
 */
export function clearHeldKeys(): void {
  heldByCode.clear();
  directByCode.clear(); // 13.10
  // L8 5.09: the Lua mouse commands go too; the buttons still physically down keep steering.
  if (luaButtons !== 0) {
    forgetLuaButtons();
    setSteering(drag.right);
  }
  clearHoverCursor();
  releaseAllInput();
  resetCharacterMotion();
}
