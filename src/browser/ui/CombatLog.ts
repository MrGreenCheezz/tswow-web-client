import { HITINFO_CRITICAL, type AttackerState } from "../../world/CombatProtocol.js";
import { WorldClient } from "../../world/WorldClient.js";
import { recordCombatEntry } from "./ChatDock.js";
import { AVOIDED, ENVIRONMENT_NAMES, swingEntry, swingText } from "./CombatLogModel.js";
import { combatLog, swingWarning } from "./Dom.js";
import { settingOn } from "./Settings.js";
import { showFloatingText } from "./HeadOverlay.js";

export { AVOIDED, ENVIRONMENT_NAMES };

export const COMBAT_LOG_LINES = 8;

/**
 * Eight lines over the world, and how long they stay there.
 *
 * The overlay used to be shown once and never hidden again, so «Кабан: 47» hung over the landscape
 * for the rest of the session; lines only ever left by being pushed off the top. It now fades out
 * when the fight does, and the history it drops is kept by the combat tab of the chat dock.
 */
export const COMBAT_LOG_LINGER_MS = 9_000;
let lastCombatLineAt = 0;

/** One line in the combat log. Oldest lines fall off the top. */
export function pushCombatLine(text: string, kind: string): void {
  if (!settingOn("combatOverlay")) return;
  const line = document.createElement("span");
  line.className = kind;
  line.textContent = text;
  combatLog.append(line);
  while (combatLog.childElementCount > COMBAT_LOG_LINES) combatLog.firstElementChild?.remove();
  combatLog.hidden = false;
  lastCombatLineAt = performance.now();
}

/** Called once a frame: the overlay is for what is happening, not for what happened. */
export function updateCombatLog(now: number): void {
  if (combatLog.hidden || now - lastCombatLineAt < COMBAT_LOG_LINGER_MS) return;
  combatLog.replaceChildren();
  combatLog.hidden = true;
}

/**
 * One melee swing.
 *
 * Three things happen to it. The tab keeps every swing in view, because that is what a log is for.
 * The overlay keeps only the player's own and the ones landing on them: the packet is broadcast to
 * everyone who can see the fight, and in a busy place the rest would bury the two that matter. And
 * the number itself goes over the victim's head, which is the only one of the three a player
 * watching the fight rather than the log will actually read.
 */
export function logSwing(world: WorldClient, swing: AttackerState): void {
  const self = world.state.selfGuid ?? 0n;
  const written = swingText(swing, self, (guid) => world.displayName(guid));
  recordCombatEntry(swingEntry(swing, self, (guid) => world.displayName(guid), Date.now()));

  const dealt = swing.attacker === self;
  const taken = swing.victim === self;
  if (written.avoided !== undefined) {
    if (dealt || taken) pushCombatLine(written.text, written.kind);
    showFloatingText(swing.victim, "miss", 0, false, written.avoided);
    return;
  }
  if (dealt || taken) pushCombatLine(written.text, written.kind);
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
