/**
 * Which native HUD lanes a stock FrameXML owner has taken over.
 *
 * The world mount (`FrameXmlWorldMount.ts`) publishes each replacement as a class on `<body>` once
 * its stock owner has passed its gates, and its stylesheet hides the native lane under that class;
 * the class is taken off again when the owner is torn down. A native lane under one of these is on
 * no one's screen, so the per-frame work that only keeps it painted — cooldown sweeps, cast bars,
 * countdown labels — is skipped while the class stands. The lanes are drawn from the world's state
 * on every frame, so the first frame after the class is removed paints them current again.
 *
 * The class is the one signal, read where it is published, rather than a flag kept beside it: a
 * copy could drift from the stylesheet that actually hides the lane.
 */

/** PlayerFrame, CastingBarFrame, BuffFrame and the action bars: `#player-hud`, `#player-cast`, `#player-auras`, `#action-bar*`. */
export const NATIVE_LANES_REPLACED = "framexml-world-replaces-native";
/** The target's spell bar and aura strip: `#target-cast`, `#target-auras`. */
export const NATIVE_TARGET_CONTEXT_REPLACED = "framexml-world-replaces-target-context";
/** FocusFrame: `#focus-frame`, with its cast bar. */
export const NATIVE_FOCUS_REPLACED = "framexml-world-replaces-focus";
/** MirrorTimer1-3: `#mirror-timers`. */
export const NATIVE_MIRROR_TIMERS_REPLACED = "framexml-world-replaces-mirror-timers";

/** Whether the native lane published under `className` is hidden behind its stock owner. */
export function nativeHudReplaced(className: string): boolean {
  return typeof document !== "undefined" && document.body?.classList.contains(className) === true;
}
