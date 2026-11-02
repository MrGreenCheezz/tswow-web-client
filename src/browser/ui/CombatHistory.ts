/**
 * The combat lines this client recorded: the packet handlers write here, and whoever shows them
 * listens. The stock chat's combat window fills from it (FrameXmlChatApi.ts).
 */

import { pushCombatEntry, type CombatLogEntry } from "./CombatLogModel.js";

/** The combat log's own history, which is not chat and does not live in the chat backlog. */
const combatEntries: CombatLogEntry[] = [];

/** Everyone who shows the combat lines: the stock chat's combat window, the native dock's tab. */
const combatEntryListeners = new Set<(entry: CombatLogEntry) => void>();

/**
 * Subscribes to every combat line as it is recorded; answers the unsubscribe.
 *
 * The native combat tab lives in `#chat-log`, which the stock chat hides, so this is the one feed a
 * stock `ChatFrame2` can be filled from without a second copy of the combat packet handlers.
 */
export function onCombatEntry(listener: (entry: CombatLogEntry) => void): () => void {
  combatEntryListeners.add(listener);
  return () => { combatEntryListeners.delete(listener); };
}

/** The combat history, oldest first, for a mirror that starts late. */
export function combatHistory(): readonly CombatLogEntry[] {
  return combatEntries;
}

/** One line of combat, kept in the history and handed to everyone who shows it. */
export function recordCombatEntry(entry: CombatLogEntry): void {
  pushCombatEntry(combatEntries, entry);
  for (const listener of combatEntryListeners) {
    try {
      listener(entry);
    } catch (error) {
      console.warn("[chat] a combat line mirror failed", error);
    }
  }
}

/** The history is one character's; a new world starts it again. */
export function resetCombatHistory(): void {
  combatEntries.length = 0;
}
