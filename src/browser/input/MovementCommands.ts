import type { InputAction } from "./Bindings.js";

/**
 * L8 5.09: the stock movement C API and RunBinding's held commands, between the Lua side
 * (framexml/FrameXmlMovementApi.ts, framexml/FrameXmlBinding.ts) and the keyboard's own held machinery
 * (input/Controls.ts registers itself here), so the FrameXML layer does not import the DOM-bound input code.
 *
 * Wow.exe 3.3.5a 12340 (Ghidra, read-only; .runtime/re-2026-10-04/l8-movement/g1.c; registration table
 * 0x00ad1938…0x00ad1ad4, SitStandOrDescendStart at 0x00ac8568): every Start sets one bit of the input word
 * ([0x00c24954]+4) through 0x005fa170, which does nothing for a bit already set, and every Stop clears it
 * through 0x005fa450 whoever set it — the key, the Lua call or a binding body; the movement dispatcher
 * 0x005fbbc0 then sends what changed. The bits: forward 0x10, backward 0x20, strafe left 0x40 and right
 * 0x80, turn left 0x100 and right 0x200, pitch up 0x400 and down 0x800, autorun 0x1000, ascend 0x2000,
 * descend 0x4000, and the two mouse commands: TurnOrAction (the right button, also Mouselook) 0x1 and
 * CameraOrSelectOrMove (the left) 0x2 — both down is forward (0x005fae70), the first one turns the turn bits
 * into strafes (0x005fafb0) and is what IsMouselooking reports (0x005f9dd0, with 0x2000000).
 */
export interface MovementCommandInput {
  /** A held command (`Bindings.HELD_ACTIONS`) going down or up, as its key would. */
  hold(action: InputAction, down: boolean): void;
  /** One of the two mouse commands ({@link TURN_OR_ACTION}, {@link CAMERA_OR_SELECT_OR_MOVE}) going down or up. */
  button(bit: number, down: boolean): void;
  /** IsMouselooking: the right button, or TurnOrAction/Mouselook held from Lua. */
  mouselooking(): boolean;
}

/** TurnOrActionStart/Stop, MouselookStart/Stop: bit 0x1 of the input word. */
export const TURN_OR_ACTION = 1;
/** CameraOrSelectOrMoveStart/Stop: bit 0x2. */
export const CAMERA_OR_SELECT_OR_MOVE = 2;

let input: MovementCommandInput | undefined;

/** Controls.wireControls registers the live input; tests register a stand-in. */
export function registerMovementCommandInput(next: MovementCommandInput | undefined): void {
  input = next;
}

export function movementCommandInput(): MovementCommandInput | undefined {
  return input;
}
