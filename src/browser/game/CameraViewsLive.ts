import { game } from "./Context.js";
import { cameraViews, type CameraViewMotion } from "./CameraViews.js";

/**
 * DEC-B 3.11 (04.10): the camera views (CameraViews.ts) on the page's one camera, for the native keys
 * (input/Actions.ts) and the stock UI's Lua (framexml/FrameXmlCameraViews.ts through LiveWorldSeam).
 *
 * DOM-free, as LiveWorldSeam's graph has to stay: the settings a switch reads — cameraYawSmoothSpeed,
 * the pitch at a quarter of it (the stock slider's cameraPitchSmoothSpeed = value/4, Wow.exe's 180 and
 * 45), and the wheel's ceiling of the moment — come from {@link useCameraViewMotion}, which the input
 * layer sets (input/Actions.ts). Until then, Wow.exe's defaults and the CVars' 50 yards.
 */

const DEFAULT_MOTION: CameraViewMotion = Object.freeze({ yawSpeed: 180, pitchSpeed: 45, ceiling: 50 });
let motion: () => CameraViewMotion = () => DEFAULT_MOTION;

/** Where a switch reads its speeds and ceiling from. */
export function useCameraViewMotion(source: () => CameraViewMotion): void {
  motion = source;
}

/** The six functions, each answering whether the camera switched (FlipCameraYaw always turns). */
export const liveCameraViews = Object.freeze({
  setView: (index: number): boolean => cameraViews.setView(index, game.camera, performance.now(), motion()),
  saveView: (index: number): boolean => cameraViews.saveView(index, game.camera),
  resetView: (index: number): boolean => cameraViews.resetView(index, game.camera, performance.now(), motion()),
  nextView: (): boolean => cameraViews.nextView(game.camera, performance.now(), motion()),
  prevView: (): boolean => cameraViews.prevView(game.camera, performance.now(), motion()),
  flipCameraYaw: (degrees: number): void => cameraViews.flipCameraYaw(degrees, game.camera),
});
