import { HITINFO_CRITICAL, type AttackerState } from "../../world/CombatProtocol.js";
import { WorldClient } from "../../world/WorldClient.js";
import { recordCombatEntry } from "./ChatDock.js";
import { AVOIDED, ENVIRONMENT_NAMES, swingEntry, swingText } from "./CombatLogModel.js";
import { swingWarning } from "./Dom.js";
import { showFloatingText } from "./HeadOverlay.js";

export { AVOIDED, ENVIRONMENT_NAMES };

/** Adds a status line to the combat history owned by the chat's «Бой» tab. */
export function pushCombatLine(text: string, kind: string): void {
  recordCombatEntry({ at: Date.now(), text, kind, casterGuid: 0n, targetGuid: 0n, spellId: 0 });
}

/** Kept as a harmless compatibility seam until the render loop drops its old per-frame call. */
export function updateCombatLog(_now: number): void {}

/**
 * One melee swing.
 *
 * Two things happen to it. The chat tab keeps every swing, because that is what a log is for. The
 * number itself goes over the relevant unit's head; there is no second scrolling overlay competing
 * with the unit frames and aura rows.
 */
export function logSwing(world: WorldClient, swing: AttackerState): void {
  const self = world.state.selfGuid ?? 0n;
  const written = swingText(swing, self, (guid) => world.displayName(guid));
  recordCombatEntry(swingEntry(swing, self, (guid) => world.displayName(guid), Date.now()));

  const taken = swing.victim === self;
  if (written.avoided !== undefined) {
    showFloatingText(swing.victim, "miss", 0, false, written.avoided);
    return;
  }
  showFloatingText(swing.victim, taken ? "taken" : "damage", swing.damage,
    (swing.hitInfo & HITINFO_CRITICAL) !== 0);
}

/**
 * The standing complaint about the current swing, if there is one.
 *
 * Kept visible rather than flashed once, because the server latches it: "out of range" is sent
 * the first time and never again, and nothing at all is sent when the player closes the distance.
 */
export function showSwingWarning(world: WorldClient): void {
  swingWarning.textContent = world.swingWarning ?? "";
  swingWarning.hidden = world.swingWarning === undefined;
}
