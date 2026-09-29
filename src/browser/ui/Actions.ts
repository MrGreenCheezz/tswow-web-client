/**
 * UI-facing action entry point.
 *
 * Keyboard dispatch still lives under `input/Actions.ts`; this narrow re-export keeps UI routes
 * (including the FrameXML bag owner) available from the UI namespace without introducing a second
 * action implementation or a second set of listeners.
 */
export { runAction } from "../input/Actions.js";
export type { InputAction } from "../input/Bindings.js";
