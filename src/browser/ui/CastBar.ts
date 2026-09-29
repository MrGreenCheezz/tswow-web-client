import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { playerCast, targetCast } from "./Dom.js";
import { ensureSpellNames, spellName } from "./SpellNames.js";
import { Bar } from "./Widgets.js";
import {
  NATIVE_FOCUS_REPLACED, NATIVE_LANES_REPLACED, NATIVE_TARGET_CONTEXT_REPLACED, nativeHudReplaced,
} from "./NativeHudReplacement.js";

/**
 * The cast bars, for the character and for whatever it is looking at.
 *
 * The client had none: `SMSG_SPELL_START` was one of the opcodes the world loop dropped, so a cast
 * was invisible until its result arrived. The bar is driven from `WorldClient.casts`, which holds
 * one entry per casting unit — a target's bar is the same code as the player's, asked about a
 * different guid.
 */
const bars = new Map<HTMLElement, Bar>();
/** Cached `#focus-cast` mount: `getElementById` on every frame is a document-wide lookup. */
let focusMount: HTMLElement | null | undefined;

function resolveFocusMount(): HTMLElement | null {
  if (focusMount === undefined || (focusMount !== null && !focusMount.isConnected)) {
    focusMount = typeof document === "undefined" ? null : document.getElementById("focus-cast");
  }
  return focusMount;
}

function barFor(mount: HTMLElement): Bar {
  let bar = bars.get(mount);
  if (!bar) {
    bar = new Bar({ kind: "cast", text: true });
    bar.root.hidden = true;
    mount.append(bar.root);
    bars.set(mount, bar);
  }
  return bar;
}

function paint(mount: HTMLElement, world: WorldClient | undefined, guid: bigint | undefined, now: number): void {
  const bar = barFor(mount);
  const cast = guid === undefined ? undefined : world?.casts.get(guid);
  if (!world || guid === undefined || !cast) {
    if (!bar.root.hidden) bar.root.hidden = true;
    return;
  }
  const progress = world.castProgress(guid, now) ?? 0;
  // The row may be one the character has never seen — a mob's spell, or one cast on it — and the
  // spellbook and the aura strip only ever ask for what this character knows or wears.
  ensureSpellNames([cast.spellId]);
  const remaining = Math.max(0, cast.duration - (now - cast.startedAt));
  if (bar.root.hidden) bar.root.hidden = false;
  const interruptible = (cast as { interruptible?: boolean }).interruptible !== false;
  const lock = interruptible ? "" : " · не прерывается";
  bar.set(progress, 1, `${spellName(cast.spellId)} · ${(remaining / 1000).toFixed(1)}с${lock}`);
  // A channel empties rather than fills, and reads as its own colour. Non-interruptible casts
  // read as shielded so interrupts are not wasted on immune targets.
  bar.setVariant(cast.channel ? "channel" : interruptible ? undefined : "shielded");
}

/**
 * A bar whose native lane a stock owner has taken over (`NativeHudReplacement`) is hidden, so
 * nothing is drawn into it; the spell's name is still asked for, as the drawn bar would have asked,
 * because the stock bar and the next cast of the same spell read the same cache.
 */
function askName(world: WorldClient | undefined, guid: bigint | undefined): void {
  const cast = guid === undefined ? undefined : world?.casts.get(guid);
  if (cast) ensureSpellNames([cast.spellId]);
}

/**
 * Called once a frame. The bars are redrawn from the clock rather than from packets, because a
 * cast is a shape over time and the server sends only its ends.
 */
export function updateCastBars(now: number): void {
  const world = game.world;
  if (nativeHudReplaced(NATIVE_LANES_REPLACED)) askName(world, world?.state.selfGuid);
  else paint(playerCast, world, world?.state.selfGuid, now);
  if (nativeHudReplaced(NATIVE_TARGET_CONTEXT_REPLACED)) askName(world, world?.targetGuid);
  else paint(targetCast, world, world?.targetGuid, now);
  if (nativeHudReplaced(NATIVE_FOCUS_REPLACED)) {
    askName(world, game.focusGuid);
    return;
  }
  const focus = resolveFocusMount();
  if (focus && game.focusGuid !== undefined) paint(focus, world, game.focusGuid, now);
  else if (focus && focus.childElementCount > 0) focus.replaceChildren();
}
