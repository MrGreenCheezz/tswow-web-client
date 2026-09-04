import { isLootable } from "../../world/Fields.js";
import { GO_FLAG_NOT_SELECTABLE, interactionDistance, interactiveGameObjectType } from "../../world/GameObjectProtocol.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { game } from "../game/Context.js";
import { gameObjectType } from "../SimpleScene.js";
import { chatInput, worldCanvas } from "../ui/Dom.js";
import { anyGameWindowOpen, closeGameWindows } from "../ui/Windows.js";
import { showTarget } from "../ui/Frames.js";
import { interactWithGuid } from "../ui/Npc.js";
import { CAMERA_LOOK_SENSITIVITY, CAMERA_PITCH_LIMIT, zoomedDistance } from "../game/CameraRig.js";
import { cameraMaxDistance } from "../ui/Settings.js";
import { inSightFromCamera } from "../game/Targeting.js";
import { gameMenuOpen, toggleGameMenu } from "../ui/GameMenu.js";
import { keyBindingsOpen, toggleKeyBindingsWindow } from "../ui/KeyBindings.js";
import { runAction } from "./Actions.js";
import {
  HELD_ACTIONS, actionFor, chordOf, moduleActionFor, strafeInsteadOfTurn, type InputAction,
} from "./Bindings.js";
import {
  beginHeld, endHeld, flushFacing, normalizeAngle, releaseAllInput, resetCharacterMotion,
  setMouseRun, turnCharacterBy,
} from "./Movement.js";

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

/** Text fields own the keyboard while they have focus, except for the way out of them. */
function typingInto(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

/**
 * The action a press means.
 *
 * Modifiers are matched exactly, so `Shift+1` reaches the page switch rather than slot one. The
 * single exception is the movement keys, where shift is the strafe modifier rather than part of
 * the binding: `A` with shift held has to still be the key the player bound to turning.
 */
function resolve(event: KeyboardEvent): InputAction | undefined {
  const exact = actionFor(chordOf(event));
  if (exact !== undefined) return exact;
  if (!event.shiftKey) return undefined;
  const bare = actionFor(chordOf({ code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: false }));
  return bare !== undefined && HELD_ACTIONS.has(bare) ? bare : undefined;
}

/**
 * Escape, which is a chain and not a binding: an open window first, then the target, and only
 * when there is nothing left to dismiss does it offer the menu.
 */
function backOut(): void {
  // The bindings window is not one of the panels a world owns, so it backs out first and on its
  // own — and it is the one window that can be open with no world behind it.
  if (keyBindingsOpen()) {
    toggleKeyBindingsWindow();
    return;
  }
  const world = game.world;
  if (!world) return;
  const dismissed = anyGameWindowOpen() || world.targetGuid !== undefined || gameMenuOpen();
  if (world.loot) world.closeLoot();
  closeGameWindows();
  world.selectTarget(undefined);
  showTarget();
  if (gameMenuOpen()) toggleGameMenu();
  else if (!dismissed) toggleGameMenu();
}

/** Re-reads every held key against the current shift state, and starts or stops what changed. */
function refreshStrafeModifier(shift: boolean): void {
  for (const entry of heldByCode.values()) {
    const wanted = shift ? strafeInsteadOfTurn(entry.base) : entry.base;
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
    }
    return;
  }
  if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
    refreshStrafeModifier(true);
    return;
  }
  if (event.code === "Escape") {
    backOut();
    event.preventDefault();
    return;
  }

  const action = resolve(event);
  if (action === undefined) {
    // A module's own action, which lives in a separate dynamic table and is never held: a
    // definition file offers a verb, and a verb is pressed. Asked after the compiled-in table, so
    // a module can never answer for a key that already means something else.
    const fromModule = moduleActionFor(chordOf(event));
    if (!fromModule) return;
    if (!event.repeat) fromModule.run();
    event.preventDefault();
    return;
  }

  if (HELD_ACTIONS.has(action)) {
    if (!game.world?.movementReady || heldByCode.has(event.code)) return;
    const current = event.shiftKey ? strafeInsteadOfTurn(action) : action;
    heldByCode.set(event.code, { base: action, current });
    beginHeld(current);
    // A held action may still have a verb on the way down — sitting down is one — and the ones
    // that do not simply answer that they did nothing.
    runAction(current);
    event.preventDefault();
    return;
  }
  // A repeat is a key the player is leaning on, not a second press: the action bar would fire
  // thirty times a second and every one of those is a packet.
  if (event.repeat) {
    event.preventDefault();
    return;
  }
  if (runAction(action)) event.preventDefault();
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
    refreshStrafeModifier(false);
    return;
  }
  const entry = heldByCode.get(event.code);
  if (!entry) return;
  heldByCode.delete(event.code);
  endHeld(entry.current);
  event.preventDefault();
}

/** How far the pointer may travel before a press stops being a click and becomes a drag. */
const DRAG_THRESHOLD = 3;

/**
 * The gesture in progress.
 *
 * Read out of `event.buttons` rather than counted from `pointerdown` and `pointerup`, because a
 * mouse does not send those for a second button: the spec fires `pointerdown` only when no other
 * button is already down and `pointerup` only when the last one comes up, and everything in
 * between arrives as `pointermove`. Counting presses would mean the right button never registers
 * while the left is held, which is exactly the gesture that has to run forward.
 *
 * `seen` is every button the gesture has used, so a press that was part of a two-button run does
 * not also count as a click when it comes up alone.
 */
const drag = { left: false, right: false, moved: 0, seen: 0 };

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
  game.camera.distance = zoomedDistance(game.camera.distance, step, cameraMaxDistance());
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
 * The bag the original client puts under the cursor over a lootable body.
 *
 * A data URI rather than a file: it is 24 pixels of one shape, and a `url()` cursor that has to be
 * fetched shows nothing at all for the length of the fetch — the frame the cursor crosses a corpse
 * is the frame the answer is wanted. The keyword after it is the fallback a browser that refuses
 * the image falls back to, which is why `pointer` is spelled out rather than left to `auto`.
 */
const LOOT_CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
  + '<path d="M8 7h8l4 13H4z" fill="#d8a94a" stroke="#2a1d08" stroke-width="2" stroke-linejoin="round"/>'
  + '<path d="M6 7h12" stroke="#2a1d08" stroke-width="2" stroke-linecap="round"/>'
  + "</svg>";
const LOOT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(LOOT_CURSOR_SVG)}") 12 12, pointer`;

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
/** The trailing pass, if one is armed. It carries the point it will pick at in its closure. */
let hoverTailTimer: ReturnType<typeof setTimeout> | undefined;
let hoverWorldTimer: ReturnType<typeof setTimeout> | undefined;
/** The original-style name card beside the pointer for an actionable game object. */
let worldObjectTooltip: HTMLDivElement | undefined;
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
 * Three answers and no more. A body the server still marks lootable gets the bag; anything else
 * `pick` returns gets `pointer`, and that includes a corpse somebody has already emptied — `pick`
 * only ever answers with something the click can act on, so the hand means «this is clickable» and
 * the bag means «and there is loot on it». A spent body is still a body: `#pushUnitHit` gives it a
 * box, a right click still sends the loot request, and the target frame still offers «Обыскать»
 * with a working click, all of which is on purpose, because the bit is per viewer and arrives a
 * packet late under a group's round-robin (see `isLootable`). Giving it the bare ground's
 * `crosshair` was the one place in this file where the cursor contradicted the click. Empty ground
 * is the third answer and leaves the cursor to the stylesheet's own `crosshair`.
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
  hoveredAt = performance.now();
  const guid = pickAt(point);
  const object = guid === undefined ? undefined : game.world?.state.objects.get(guid);
  hoveredGameObject = object?.typeId === 5 ? object : undefined;
  hoveredPoint = { clientX: point.clientX, clientY: point.clientY };
  if (pendingHoveredTemplate?.object !== hoveredGameObject) pendingHoveredTemplate = undefined;
  const objectName = object?.typeId === 5 ? gameObjectHoverName(object) : undefined;
  const wanted = !object || (object.typeId === 5 && objectName === undefined) ? ""
    : isWorldObjectDead(object) && isLootable(object) ? LOOT_CURSOR
      : "pointer";
  if (objectName) showWorldObjectTooltip(objectName, point);
  else clearWorldObjectTooltip();
  if (hoveredGameObject) scheduleHoverWorldRefresh();
  else cancelHoverWorldRefresh();
  if (wanted === hoverCursor) return;
  hoverCursor = wanted;
  worldCanvas.style.cursor = wanted;
}

/** Drops a tail pass that is about to answer about a point the pointer has already left. */
function cancelHoverTail(): void {
  if (hoverTailTimer === undefined) return;
  clearTimeout(hoverTailTimer);
  hoverTailTimer = undefined;
}

function scheduleHoverWorldRefresh(): void {
  cancelHoverWorldRefresh();
  if (!hoveredGameObject || !hoveredPoint || drag.left || drag.right) return;
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
  cancelHoverTail();
  cancelHoverWorldRefresh();
  hoveredGameObject = undefined;
  hoveredPoint = undefined;
  pendingHoveredTemplate = undefined;
  clearWorldObjectTooltip();
  if (hoverCursor === "") return;
  hoverCursor = "";
  worldCanvas.style.cursor = "";
}

function gameObjectHoverName(object: import("../../world/WorldState.js").WorldObjectState): string | undefined {
  const world = game.world;
  const type = gameObjectType(object);
  if (!world || !interactiveGameObjectType(type)) return undefined;
  const flags = object.fields.get(UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset) ?? 0;
  if ((flags & GO_FLAG_NOT_SELECTABLE) !== 0) return undefined;
  const self = world.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  if (!self?.position || !object.position) return undefined;
  const distance = Math.hypot(
    object.position.x - self.position.x,
    object.position.y - self.position.y,
    object.position.z - self.position.z,
  );
  if (distance > interactionDistance(type)) return undefined;
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

function showWorldObjectTooltip(name: string, point: { clientX: number; clientY: number }): void {
  if (!worldObjectTooltip) {
    worldObjectTooltip = document.createElement("div");
    worldObjectTooltip.className = "ui-tooltip world-object-tooltip";
    worldObjectTooltip.setAttribute("role", "tooltip");
    document.body.append(worldObjectTooltip);
  }
  const title = document.createElement("strong");
  title.textContent = name;
  worldObjectTooltip.replaceChildren(title);
  worldObjectTooltip.style.left = `${Math.max(8,
    Math.min(point.clientX + 16, window.innerWidth - worldObjectTooltip.offsetWidth - 8))}px`;
  worldObjectTooltip.style.top = `${Math.max(8,
    Math.min(point.clientY + 18, window.innerHeight - worldObjectTooltip.offsetHeight - 8))}px`;
}

function clearWorldObjectTooltip(): void {
  worldObjectTooltip?.remove();
  worldObjectTooltip = undefined;
}

/**
 * Takes the button state from the event and reports what has just been let go of.
 *
 * Everything about a gesture is derived here — which buttons are down, whether the two-button run
 * is on, and where the gesture started — so no listener has to keep its own idea of it.
 */
function syncButtons(event: PointerEvent): { releasedLeft: boolean; releasedRight: boolean } {
  const left = (event.buttons & 1) !== 0;
  const right = (event.buttons & 2) !== 0;
  const releasedLeft = drag.left && !left;
  const releasedRight = drag.right && !right;
  // A gesture starts when the first button goes down and lasts until the last one comes up, so a
  // drag that picked up a second button on the way is still one gesture.
  if (!drag.left && !drag.right && (left || right)) {
    drag.moved = 0;
    drag.seen = 0;
  }
  drag.seen |= (left ? 1 : 0) | (right ? 2 : 0);
  const wasDragging = drag.left || drag.right;
  drag.left = left;
  drag.right = right;
  setMouseRun(left && right);
  // Written only when it changes: this runs on every mouse move over the canvas, and a class
  // written per move is a style recalculation per move.
  if (wasDragging !== (left || right)) worldCanvas.classList.toggle("camera-dragging", left || right);
  return { releasedLeft, releasedRight };
}

/** A press that never moved and never shared the gesture with the other button is a click. */
function clicked(button: 1 | 2): boolean {
  return drag.moved <= DRAG_THRESHOLD && drag.seen === button;
}

function releaseButtons(event: PointerEvent): void {
  const { releasedLeft, releasedRight } = syncButtons(event);
  if (!releasedLeft && !releasedRight) return;
  const world = game.world;
  // The camera has stopped; tell the server where the character ended up facing, since a turn on
  // the spot sends nothing else.
  if (releasedRight && drag.moved > DRAG_THRESHOLD) flushFacing();
  if (!world) return;

  // The left button picks a target or drops it; the right one picks and then interacts, which is
  // the gesture the original client leans on hardest.
  if (releasedLeft && clicked(1)) {
    world.selectTarget(pickAt(event));
    showTarget();
    return;
  }
  if (releasedRight && clicked(2)) {
    const guid = pickAt(event);
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
  if (!drag.left && !drag.right) return;
  drag.left = false;
  drag.right = false;
  drag.seen = 0;
  setMouseRun(false);
  worldCanvas.classList.remove("camera-dragging");
}

function wireMouse(): void {
  worldCanvas.addEventListener("contextmenu", (event) => event.preventDefault());

  worldCanvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.button !== 2) return;
    worldCanvas.setPointerCapture(event.pointerId);
    syncButtons(event);
    event.preventDefault();
  });

  worldCanvas.addEventListener("pointermove", (event) => {
    // A chorded press or release arrives as a move, so the buttons are re-read on every one.
    const wasDragging = drag.left || drag.right;
    releaseButtons(event);
    updateHoverCursor(event);
    if (!wasDragging || (!drag.left && !drag.right)) return;
    drag.moved += Math.abs(event.movementX) + Math.abs(event.movementY);
    const camera = game.camera;
    // One sensitivity for both axes, as the reference client has (`camera_controller.hpp:342`).
    // They used to be 0.006 across and 0.004 up — a drag along the diagonal turned the view half
    // as far again as it lifted it, and there was nothing behind the ratio.
    camera.pitch = Math.max(-CAMERA_PITCH_LIMIT,
      Math.min(CAMERA_PITCH_LIMIT, camera.pitch - event.movementY * CAMERA_LOOK_SENSITIVITY));
    if (drag.right) {
      // The right button turns the character and the camera comes home behind it, so the offset
      // goes back to zero rather than being carried around at the player's back.
      turnCharacterBy(-event.movementX * CAMERA_LOOK_SENSITIVITY);
      camera.yaw = 0;
      return;
    }
    // The left button looks around without the character noticing.
    camera.yaw = normalizeAngle(camera.yaw - event.movementX * CAMERA_LOOK_SENSITIVITY);
  });

  worldCanvas.addEventListener("pointerup", releaseButtons);
  // A pointer that has left the canvas is over the interface, which owns its own cursor: leaving
  // the bag written on the canvas would put it back the moment the pointer returned, over
  // whatever now happens to be there.
  worldCanvas.addEventListener("pointerleave", clearHoverCursor);
  for (const name of ["pointercancel", "lostpointercapture"] as const) {
    // Neither means the player let go of anything, so the gesture is abandoned rather than
    // finished: no target is picked and no facing is sent. `lostpointercapture` also arrives
    // right after every ordinary release, when there is nothing left to abandon.
    worldCanvas.addEventListener(name, abandonGesture);
  }

  worldCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
    zoomCamera(step);
  }, { passive: false });
}

/** Keyboard, mouse and camera. Registered once, at start-up. */
export function wireControls(): void {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => {
    // A key held while alt-tabbing never gets its release, and a character that never hears about
    // it runs off a cliff.
    heldByCode.clear();
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
  clearHoverCursor();
  releaseAllInput();
  resetCharacterMotion();
}
