/**
 * DEC-B 3.11 (04.10): the stock UI's camera view functions — Wow.exe 3.3.5a (12340) registration table
 * 0xad20d0–0xad20f8: SetView 0x6039b0, SaveView 0x5ff260, ResetView 0x604c80, NextView 0x604ce0,
 * PrevView 0x604d10, FlipCameraYaw 0x5ff2c0. The camera itself is game/CameraViews.ts.
 *
 * SetView, SaveView and ResetView raise "Usage: …(viewModeIndex)" unless their first argument is a
 * number (lua_isnumber: a number or a numeric string), cut it to an integer toward zero (0x88b9c0 —
 * outside int32 it is 0x80000000) and act on 1–5 only, which the camera judges. FlipCameraYaw raises
 * "Usage: FlipCameraYaw(degrees)" the same way and adds the degrees. NextView and PrevView read
 * nothing. All six return nothing. Bindings.xml's CAMERA bodies call them, but this client runs those
 * keys as native actions (input/Actions.ts), as it does every other row (FrameXmlBinding.ts).
 */

/** What the functions call: the page's camera (game/CameraViewsLive.ts). */
export interface FrameXmlCameraViews {
  setView(index: number): unknown;
  saveView(index: number): unknown;
  resetView(index: number): unknown;
  nextView(): unknown;
  prevView(): unknown;
  flipCameraYaw(degrees: number): unknown;
}

/** The part of the world seam the functions read. */
export interface FrameXmlCameraViewsHost {
  readonly cameraViews?: FrameXmlCameraViews | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const LUA_NUMBER = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$|^\s*0[xX][0-9a-fA-F]+\s*$/;
const INT_MIN = -2147483648;

/** lua_isnumber and lua_tonumber: the number, or undefined when the argument is not one. */
function luaNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && LUA_NUMBER.test(value)) return Number(value.trim());
  return undefined;
}

/** 0x88b9c0: a double cut toward zero; NaN and anything outside int32 is 0x80000000. */
function luaInteger(value: number): number {
  const integer = Math.trunc(value);
  return Number.isFinite(integer) && integer >= INT_MIN && integer <= 2147483647 ? integer : INT_MIN;
}

function required(value: unknown, usage: string): number {
  const number = luaNumber(value);
  if (number === undefined) throw new Error(usage);
  return number;
}

type Binding = (host: FrameXmlCameraViewsHost, args: readonly unknown[]) => readonly unknown[];

function indexed(usage: string, act: (views: FrameXmlCameraViews, index: number) => unknown): Binding {
  return (host, args) => {
    const index = luaInteger(required(args[0], usage));
    const views = host.cameraViews;
    if (views) act(views, index);
    return NOTHING;
  };
}

export const FRAMEXML_CAMERA_VIEW_BINDINGS: Readonly<Record<string, Binding>> = Object.freeze({
  SetView: indexed("Usage: SetView(viewModeIndex)", (views, index) => views.setView(index)),
  SaveView: indexed("Usage: SaveView(viewModeIndex)", (views, index) => views.saveView(index)),
  ResetView: indexed("Usage: ResetView(viewModeIndex)", (views, index) => views.resetView(index)),
  NextView: (host) => {
    host.cameraViews?.nextView();
    return NOTHING;
  },
  PrevView: (host) => {
    host.cameraViews?.prevView();
    return NOTHING;
  },
  FlipCameraYaw: (host, args) => {
    const degrees = required(args[0], "Usage: FlipCameraYaw(degrees)");
    host.cameraViews?.flipCameraYaw(degrees);
    return NOTHING;
  },
});
