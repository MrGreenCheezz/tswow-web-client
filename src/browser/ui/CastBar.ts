import type { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { playerCast, targetCast } from "./Dom.js";
import { ensureSpellNames, spellName } from "./SpellNames.js";
import { Bar } from "./Widgets.js";

/**
 * The cast bars, for the character and for whatever it is looking at.
 *
 * The client had none: `SMSG_SPELL_START` was one of the opcodes the world loop dropped, so a cast
 * was invisible until its result arrived. The bar is driven from `WorldClient.casts`, which holds
 * one entry per casting unit — a target's bar is the same code as the player's, asked about a
 * different guid.
 */
const bars = new Map<HTMLElement, Bar>();

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
    bar.root.hidden = true;
    return;
  }
  const progress = world.castProgress(guid, now) ?? 0;
  // The row may be one the character has never seen — a mob's spell, or one cast on it — and the
  // spellbook and the aura strip only ever ask for what this character knows or wears.
  ensureSpellNames([cast.spellId]);
  const remaining = Math.max(0, cast.duration - (now - cast.startedAt));
  bar.root.hidden = false;
  bar.set(progress, 1, `${spellName(cast.spellId)} · ${(remaining / 1000).toFixed(1)}с`);
  // A channel empties rather than fills, and reads as its own colour.
  bar.setVariant(cast.channel ? "channel" : undefined);
}

/**
 * Called once a frame. The bars are redrawn from the clock rather than from packets, because a
 * cast is a shape over time and the server sends only its ends.
 */
export function updateCastBars(now: number): void {
  const world = game.world;
  paint(playerCast, world, world?.state.selfGuid, now);
  paint(targetCast, world, world?.targetGuid, now);
}
