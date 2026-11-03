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

/**
 * 4.18: what a walk over everything visible outside the stock stage found with a target selected.
 *
 * The client's own buttons beside the portrait (⚔, talk, loot, trade, train, bank, duel): the stock
 * TargetFrame has no such row, the right click and the action bars answer all of them. A module's
 * button in the `target-frame/actions` slot is not `.frame-action` and stays.
 *
 * `#raid-frames`: stock draws no raid grid unless the player pulls one out of the raid tab, so this one
 * has no stock owner to wait for. Empty, it still took clicks off the world in a strip 560 by 8 px over
 * the chat; in a raid it would paint the old grid over the stock interface.
 *
 * `#target-rail`: what is left of it paints nothing, yet took the clicks in its 258 by 26 px box.
 */
export const NATIVE_LEFTOVERS_CSS = `body.${NATIVE_LANES_REPLACED} #target-actions > .frame-action,
body.${NATIVE_LANES_REPLACED} #raid-frames { display: none !important; }
body.${NATIVE_LANES_REPLACED} #target-rail { pointer-events: none; }
body.${NATIVE_LANES_REPLACED} #target-actions > * { pointer-events: auto; }`;

/** Whether the native lane published under `className` is hidden behind its stock owner. */
export function nativeHudReplaced(className: string): boolean {
  return typeof document !== "undefined" && document.body?.classList.contains(className) === true;
}
