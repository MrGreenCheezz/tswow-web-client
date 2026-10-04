import type { InputAction } from "../input/Bindings.js";
import { CAMERA_OR_SELECT_OR_MOVE, TURN_OR_ACTION } from "../input/MovementCommands.js";
import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";

/**
 * L8 5.09: the stock movement C API — what Bindings.xml's MOVEMENT bodies call with `keystate` (MOVEFORWARD runs
 * MoveForwardStart on the press and MoveForwardStop on the release) — over the same held machinery a key uses
 * (`FrameXmlBindingModel.hold`/`mouseButton` → input/MovementCommands.ts → input/Controls.ts → input/Movement.ts).
 *
 * The 3.3.5a list is Wow.exe's own registration table (12340, 0x00ad1938…0x00ad1ad4; Ghidra read-only,
 * .runtime/re-2026-10-04/l8-movement/g1.c): JumpOrAscendStart 0x005fbf80, AscendStop 0x005fc0a0, DescendStop
 * 0x005fc140, ToggleRun 0x005faae0, ToggleAutoRun 0x005fc190, Move{Forward,Backward}{Start,Stop} 0x005fc200…
 * 0x005fc2e0, Turn{Left,Right} 0x005fc320…0x005fc3f0, Strafe{Left,Right} 0x005fc440…0x005fc520, PitchUp/Down
 * 0x005fc8e0/0x005fc570/0x005fc920/0x005fc5c0 (VehicleAimUp/Down{Start,Stop} are the same four), TurnOrAction
 * 0x005fc610/0x005fc680, CameraOrSelectOrMove 0x005fc6c0/0x005fc730, MoveAndSteer 0x005fc780/0x005fc830,
 * SetMouselookOverrideBinding 0x005fd550, Mouselook 0x005fcc10/0x005fc890, IsMouselooking 0x005f9dd0; and in the
 * general table SitStandOrDescendStart 0x0051b1d0 (0x00ac8568). 3.3.5a has no ToggleWalk and no ToggleMouseMove.
 *
 * What each does there, and here:
 * - A Start sets its bit of the input word and dispatches only when the bit was clear (0x005fa170); a Stop
 *   clears it whoever set it (0x005fa450). Here: `hold(action, true)` holds the command as its key would (a
 *   second Start is no new edge), `hold(action, false)` stops it whoever held it — the key included.
 * - JumpOrAscendStart: the ascend bit, and on the ground a jump (0x0072eb80) — here the held `jump`, which
 *   the physics jumps on and rises with in water and the air, as the Space key does. SitStandOrDescendStart:
 *   the descend bit (0x005fc0f0) and, unless flying, sit or stand (0x006dcb40) — here the held `sitOrStand`
 *   with its verb, as the X key does.
 * - ToggleAutoRun flips the autorun bit (0x1000); ToggleRun flips walking (0x0071ae50) for a living mover —
 *   here the TOGGLEAUTORUN and TOGGLERUN rows' verbs, as their keys do.
 * - TurnOrAction (and Mouselook) is the right button's bit, CameraOrSelectOrMove the left's, MoveAndSteer both
 *   (left first): both down run forward (0x005fae70), the right one makes the turn keys strafe (0x005fafb0) and
 *   the character steer. Here they count as those buttons for exactly that (`Controls`, `mouseButton`).
 *   IsMouselooking answers 1 while the right button or its Lua bit is down (0x005f9dd0: bits 0x2000001).
 *
 * Not modelled (open, WORK_PLAN 5.09): every one of these is a protected function in Wow.exe — 0x005191c0(0)
 * refuses it (0x00513530, ADDON_ACTION_BLOCKED) when the caller is tainted; this client models no taint, so an
 * add-on's call runs as a key binding's would. The click on release — TurnOrActionStop/CameraOrSelectOrMoveStop
 * with an unmoved mouse interact with or select what is under the cursor (0x005fa450 → 0x004f7880(4/1));
 * CameraOrSelectOrMoveStop's sticky argument (0x00604850); mouse movement turning the character while
 * TurnOrAction/Mouselook is held without a button (it needs the pointer lock a page cannot take outside a
 * gesture); SetMouselookOverrideBinding (its usual keys are mouse buttons, which the table does not hold) — not
 * answered. The movement keys also cancel a channel that breaks on moving (0x005faa40); the native keys do not
 * either, the server cancels it.
 */

const NOTHING: readonly unknown[] = Object.freeze([]);

/** A held command's Start (`true`) or Stop (`false`). */
function held(action: InputAction, down: boolean): FrameXmlSeamBinding {
  return (seam) => {
    seam.keyBindings?.hold(action, down);
    return NOTHING;
  };
}

/** A mouse command's bits going down or up, in order. */
function buttons(down: boolean, ...bits: readonly number[]): FrameXmlSeamBinding {
  return (seam) => {
    for (const bit of bits) seam.keyBindings?.mouseButton(bit, down);
    return NOTHING;
  };
}

/** A pressed row's verb (RunBinding's, as its key runs it). */
function verb(command: string): FrameXmlSeamBinding {
  return (seam) => {
    seam.keyBindings?.run(command, "down");
    return NOTHING;
  };
}

export const FRAMEXML_MOVEMENT_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  JumpOrAscendStart: held("jump", true),
  AscendStop: held("jump", false),
  SitStandOrDescendStart: held("sitOrStand", true),
  DescendStop: held("sitOrStand", false),
  ToggleRun: verb("TOGGLERUN"),
  ToggleAutoRun: verb("TOGGLEAUTORUN"),
  MoveForwardStart: held("moveForward", true),
  MoveForwardStop: held("moveForward", false),
  MoveBackwardStart: held("moveBackward", true),
  MoveBackwardStop: held("moveBackward", false),
  TurnLeftStart: held("turnLeft", true),
  TurnLeftStop: held("turnLeft", false),
  TurnRightStart: held("turnRight", true),
  TurnRightStop: held("turnRight", false),
  StrafeLeftStart: held("strafeLeft", true),
  StrafeLeftStop: held("strafeLeft", false),
  StrafeRightStart: held("strafeRight", true),
  StrafeRightStop: held("strafeRight", false),
  PitchUpStart: held("pitchUp", true),
  PitchUpStop: held("pitchUp", false),
  PitchDownStart: held("pitchDown", true),
  PitchDownStop: held("pitchDown", false),
  // The same four functions under their second names; FrameXmlVehicleAim.ts answers them first while the vehicle
  // tables are loaded and falls back to these.
  VehicleAimUpStart: held("pitchUp", true),
  VehicleAimUpStop: held("pitchUp", false),
  VehicleAimDownStart: held("pitchDown", true),
  VehicleAimDownStop: held("pitchDown", false),
  TurnOrActionStart: buttons(true, TURN_OR_ACTION),
  TurnOrActionStop: buttons(false, TURN_OR_ACTION),
  CameraOrSelectOrMoveStart: buttons(true, CAMERA_OR_SELECT_OR_MOVE),
  CameraOrSelectOrMoveStop: buttons(false, CAMERA_OR_SELECT_OR_MOVE),
  MoveAndSteerStart: buttons(true, CAMERA_OR_SELECT_OR_MOVE, TURN_OR_ACTION),
  MoveAndSteerStop: buttons(false, CAMERA_OR_SELECT_OR_MOVE, TURN_OR_ACTION),
  MouselookStart: buttons(true, TURN_OR_ACTION),
  MouselookStop: buttons(false, TURN_OR_ACTION),
  IsMouselooking: (seam) => (seam.keyBindings?.mouselooking() === true ? [1] : NOTHING),
});

/** The names this file answers, in the registration table's order. */
export const FRAMEXML_MOVEMENT_NAMES: readonly string[] = Object.freeze(Object.keys(FRAMEXML_MOVEMENT_BINDINGS));
