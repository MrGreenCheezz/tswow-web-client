/**
 * The native confirmation panels at the stock popup owner's publication edges.
 *
 * Each native panel checks `frameXmlPopupsPublished()` whenever its own show function runs, but those
 * run on packets; nothing would repaint them at the moment ownership changes. Publication hides
 * whatever native prompt is up (the stock dialog takes the same pending question on the model's
 * next look); teardown gives a question that is still pending its native prompt back, so a question
 * is never left without anyone to answer it — and never has two.
 */
import { game } from "../game/Context.js";
import { duelWindow, groupInviteWindow, guildInviteWindow } from "../ui/Dom.js";
import { showArenaWindow } from "../ui/ArenaWindow.js";
import { syncLogoutCountdownOwner } from "../ui/GameMenu.js";
import { showInteractionPrompts } from "../ui/InteractionPrompts.js";
import { showDeath } from "../ui/Npc.js";
import { showReadyCheck } from "../ui/ReadyCheck.js";
import { showTrade } from "../ui/Social.js";
import { frameXmlPopupsPublished } from "./FrameXmlPopupsController.js";

function each(steps: readonly (() => void)[]): void {
  for (const step of steps) {
    try { step(); } catch (error) { console.warn(`[FrameXML popups] native refresh: ${String(error)}`); }
  }
}

export function refreshFrameXmlPopupsNative(): void {
  const world = game.world;
  const stock = frameXmlPopupsPublished();
  each([
    // The three static prompts' text is written by their show functions on every packet, whether
    // hidden or not; only the visibility follows the owner here (their show functions also consume
    // chat lines, which a repaint must not print a second time).
    () => { groupInviteWindow.hidden = !world?.groupInvite || stock; },
    () => { duelWindow.hidden = !world?.duelRequest || stock; },
    () => { guildInviteWindow.hidden = !world?.guildInvite || stock; },
    () => showDeath(),
    () => showTrade(),
    () => showArenaWindow(),
    () => showInteractionPrompts(),
    () => showReadyCheck(),
    () => syncLogoutCountdownOwner(),
  ]);
}
