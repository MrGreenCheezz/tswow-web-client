/**
 * The grey of being dead — the original client's `ffxDeath`, as a layer instead of as a pass.
 *
 * In 3.3.5a dying drains the colour out of the world: the scene goes cold blue-grey, dims, and the
 * corners darken, while the interface over it keeps its gold and its red. Nothing here did that.
 * A character who died looked exactly like a character standing still, and the only sign of it was
 * the `#death-window` panel appearing in the corner — which is a list of buttons, not the thing
 * that makes a graveyard run feel like one.
 *
 * **Why a DOM layer rather than a render pass.** The obvious implementation is a full-screen
 * desaturate at the end of `WorldRenderer3D.draw()`, and it is the wrong one for this client:
 * the sky pass and the world pass both go straight to the default framebuffer, so a post pass
 * means an offscreen render target, and rendering to a target silently drops the custom tone
 * shoulder three.js injects through `ShaderChunk` (it compiles `NoToneMapping` for RTs). It would
 * also put a mutation inside the exact code path the formal benchmark reads back and hashes.
 * `backdrop-filter` on an element above the canvases gives true desaturation of whatever the
 * renderer just drew, costs the renderer nothing, is exactly reversible, and leaves every
 * readback, screenshot and frame hash of `#world-3d-canvas` byte-identical to the living case.
 *
 * **Why the layer is unmounted when alive.** A `backdrop-filter` element is not free merely
 * because it is transparent: it makes the content behind it a backdrop root, which is a
 * compositing decision the browser keeps for as long as the element is in the tree. Being alive is
 * the 99% case, so the layer is built on the first death and taken back out of the document once
 * it has finished fading — the living client is left with the same DOM it had before this file
 * existed.
 *
 * Reference for the look: wowee draws one flat quad, `rgba(0.30, 0.35, 0.42, 0.45)`, over the
 * finished world pass for its ghost state. A flat tint alone cannot desaturate — a red tabard
 * under it is still red, just darker — so the tint here is kept lighter and the desaturation is
 * done by the filter, which is what the original effect actually is.
 */

import { readField } from "../../world/Fields.js";
import { isWorldObjectDead, type WorldObjectState } from "../../world/WorldState.js";
import { SELF, type WorldStore } from "../../world/WorldStore.js";
import { PLAYER_FLAGS_GHOST } from "./WindowBindings.js";

/**
 * How long the fade takes, in milliseconds. Must match the `transition` in `.death-screen`: the
 * layer is removed from the document by this timer, and a value shorter than the transition would
 * cut the fade off half way.
 */
const FADE_MS = 650;

let layer: HTMLElement | undefined;
/** What the last decision was, so an unchanged one costs nothing at all. */
let active = false;
let enterFrame = 0;
let exitTimer = 0;

/**
 * Whether the world should be grey, from the two facts that decide it.
 *
 * Both halves are needed and neither is enough. Health reaches zero the moment the killing blow
 * lands, before any flag moves; `PLAYER_FLAGS_GHOST` is what survives releasing the spirit, when
 * the spirit body is alive with full health and the world must stay grey all the way back to the
 * corpse. The original greys for both states, and this is the whole decision, kept pure so it can
 * be checked without a document.
 */
export function deathScreenActive(healthDead: boolean, playerFlags: number): boolean {
  return healthDead || (playerFlags & PLAYER_FLAGS_GHOST) !== 0;
}

/**
 * The layer, made on demand and put where the stacking order needs it.
 *
 * Directly after `#world-canvas` rather than at the end of the viewport, because z-index 2 is
 * shared with `#world-canvas` and with `.head-overlay`, and among equal z-indices the later
 * sibling wins. Sitting between them is exactly right: above both canvases, so the world is what
 * gets desaturated, and below the speech bubbles and the floating damage numbers, which are
 * interface and stay in colour the way the original's do.
 */
function mount(): HTMLElement | undefined {
  const viewport = document.getElementById("world-viewport");
  if (!viewport) return undefined;
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "death-screen";
    layer.className = "death-screen";
    // Decorative and inert: `#world-canvas` under it owns click-to-target and the camera drag, and
    // a dead character can still turn the camera and click a spirit healer.
    layer.setAttribute("aria-hidden", "true");
  }
  if (layer.isConnected) return layer;
  const canvas = document.getElementById("world-canvas");
  if (canvas?.parentElement === viewport) canvas.after(layer);
  else viewport.append(layer);
  return layer;
}

function cancelPending(): void {
  if (enterFrame !== 0) cancelAnimationFrame(enterFrame);
  if (exitTimer !== 0) window.clearTimeout(exitTimer);
  enterFrame = 0;
  exitTimer = 0;
}

function fadeIn(): void {
  cancelPending();
  const node = mount();
  if (!node || node.classList.contains("is-active")) return;
  // One frame between "in the document" and "opaque". A transition needs a previous computed
  // opacity to move away from, and an element inserted in this same tick has none — setting both
  // at once would snap the grey on. Dying again while the fade-out is still running finds the node
  // already mounted mid-opacity, which is a perfectly good place to transition back from.
  enterFrame = requestAnimationFrame(() => {
    enterFrame = 0;
    node.classList.add("is-active");
  });
}

function fadeOut(): void {
  cancelPending();
  const node = layer;
  if (!node?.isConnected) return;
  // Mounted but never made opaque — a death undone inside a single frame, or a world left between
  // the mount and the frame that was going to start the fade. There is nothing to fade out, and a
  // `backdrop-filter` element has no business sitting in the document for another 650ms.
  if (!node.classList.contains("is-active")) {
    node.remove();
    return;
  }
  node.classList.remove("is-active");
  exitTimer = window.setTimeout(() => {
    exitTimer = 0;
    node.remove();
  }, FADE_MS);
}

/** Applies a decision, and does nothing when it is the decision already on screen. */
function setDeathScreen(on: boolean): void {
  if (on === active) return;
  active = on;
  if (on) fadeIn();
  else fadeOut();
}

/**
 * The character as the store last saw it, turned into the state of the layer.
 *
 * `world-active` is the gate rather than a convenience: the layer lives inside `#world-panel` and
 * therefore cannot be seen from the glue screens, but a grey wash that outlives its world is worth
 * refusing twice, and this is the same class every other world-only surface is fenced by.
 */
function refresh(self: WorldObjectState | undefined): void {
  const inWorld = document.body.classList.contains("world-active");
  const dead = inWorld && self !== undefined
    && deathScreenActive(isWorldObjectDead(self), readField(self, "PLAYER_FLAGS") ?? 0);
  setDeathScreen(dead);
}

/**
 * Follows the controlled character for the life of one world connection.
 *
 * `object(SELF, …)` and not a poll: it fires on the frame in which any field of the character
 * changed, which covers every way into and out of this state — the killing blow writes
 * `UNIT_FIELD_HEALTH`, releasing the spirit writes `PLAYER_FLAGS`, a resurrect writes health back,
 * and reclaiming the corpse clears the flag. It also fires when the character object is replaced,
 * so logging in already dead greys the screen without waiting for anything to happen.
 */
export function bindDeathScreenEffect(store: WorldStore): void {
  store.object(SELF, (self) => refresh(self));
}

/**
 * Everything this file owns, dropped — no fade.
 *
 * A world being left is not a resurrection: the panel is about to be hidden and the login screen
 * shown, and half a second of grey fading out over a form is a bug rather than an effect.
 */
export function resetDeathScreenEffect(): void {
  cancelPending();
  active = false;
  layer?.remove();
  layer = undefined;
}
