/**
 * 22.10 ARC-2 S5: the frame codec — one frame of the world as the renderer reads it, encoded on the main thread and
 * applied to a mirror on the renderer's side. Split by side: FrameInput.ts (the message), FrameInputEncoder.ts (main),
 * FrameInputDecoder.ts (renderer); the pushed records in RenderTablesBridge.ts; the same-thread trial in
 * RenderBridgeLoopback.ts.
 */

export * from "./FrameInput.js";
export { FrameInputEncoder, type FrameArgValues } from "./FrameInputEncoder.js";
export { FrameInputDecoder, MirrorWorld } from "./FrameInputDecoder.js";
export { structuredSize } from "./StructuredSize.js";
