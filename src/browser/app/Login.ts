import { worldPanel } from "../ui/Dom.js";
import { clearWorldContext, game } from "../game/Context.js";
import { cancelItemTarget } from "../game/SpellCursor.js";
import { retireEnterWorldSession } from "./EnterWorld.js";
import { showDeath, showLoot, showTrainer, showVendor } from "../ui/Npc.js";
import { showAuctions, showDuel, showGroup, showLfg, showMail, showTrade } from "../ui/Social.js";
import { showGuild } from "../ui/Guild.js";
import { resetGuildBank } from "../ui/GuildBank.js";
import { resetCalendar } from "../ui/Calendar.js";
import { closeProfessionCraft } from "../ui/ProfessionCraft.js";
import { closeSocketing } from "../ui/Socketing.js";
import { resetSocialPanel } from "../ui/SocialPanel.js";
import { resetScoreboard } from "../ui/Scoreboard.js";
import { resetArenaWindow } from "../ui/ArenaWindow.js";
import { resetLootRolls } from "../ui/LootRolls.js";
import { resetReadyCheck } from "../ui/ReadyCheck.js";
import { resetBarberShop } from "../ui/BarberShop.js";
import { resetTotems } from "../ui/Totems.js";
import { resetChannelRoster } from "../ui/ChannelRoster.js";
import { resetGmTickets } from "../ui/GmTickets.js";
import { resetPetition } from "../ui/Petition.js";
import { clearReputation } from "../ui/Reputation.js";
import { resetAutoQuality } from "../AutoQuality.js";
import { clearBagSearch } from "../ui/Bags.js";
import { resetMacroWindow } from "../ui/Macros.js";
import { macroStores } from "../ui/MacroStore.js";
import { resetPetBar } from "../ui/PetBar.js";
import { resetLoadingScreen } from "../ui/LoadingScreen.js";
import { closeGameMenu, resetLogoutPending } from "../ui/GameMenu.js";
import { closeKeyBindingsWindow } from "../ui/KeyBindings.js";
import { closeGameWindows } from "../ui/Windows.js";
import { clearQuestLog } from "../ui/QuestLogData.js";
import { bindDeathScreenEffect, resetDeathScreenEffect } from "../ui/DeathScreenEffect.js";
import { settingsStore } from "../ui/Settings.js";
import { detachInputAccount } from "../input/InputAccountWiring.js";
import type { WorldClient } from "../../world/WorldClient.js";
import { bindPlayerHud } from "../ui/Frames.js";
import { forgetMovementState } from "../input/Movement.js";
import { frontDoorHost, type WorldExit } from "../glue/FrontDoor.js";
import type { GlueAuthMessage } from "../glue/GlueMessages.js";
import { adoptWorldConnection } from "./WorldAdoption.js";

/**
 * Everything a world owns, dropped.
 *
 * Called by every route out of a world: a completed logout, a lost connection, a failed enter and
 * asking for the login screen.
 *
 * `clearWorldContext` had no caller anywhere in `src/` before this list existed. The half of it
 * that hurt was the modules: `enterWorld` builds a fresh loader and overwrites `game.modules`, so
 * the previous session's windows stayed in the registry and the second login in one tab refused
 * every one of them as a duplicate — measured, 0 windows and «окно "proverochnyy-ekran" уже
 * зарегистрировано модулем «test»» — while `/testUI` went on toggling the first session's handle.
 *
 * Deliberately does **not** close the socket: the GlueXML screens open it and only *lend* it to the
 * world. Closing here would take a live realm connection away from the glue session that is about
 * to draw its character list over it.
 */
export function resetWorldUi(): void {
  retireEnterWorldSession();
  game.store?.detach();
  clearWorldContext();
  // A spell or item waiting for an item dies with the world (2.05): the cast cursor goes with it now,
  // not at the next question asked of it.
  cancelItemTarget();
  resetLogoutPending();
  closeGameMenu();
  closeKeyBindingsWindow();
  // Close both markup and runtime windows before the viewport is shown for a new character.
  // The world reference is already gone, so this cannot send service-close packets to the old realm.
  closeGameWindows();
  clearQuestLog();
  showLoot();
  showDeath();
  showVendor();
  showTrainer();
  showGroup();
  showTrade();
  showDuel();
  showMail();
  showGuild();
  resetGuildBank();
  resetCalendar();
  closeProfessionCraft();
  closeSocketing();
  resetSocialPanel();
  resetScoreboard();
  resetArenaWindow();
  resetLootRolls();
  resetReadyCheck();
  resetBarberShop();
  resetTotems();
  resetChannelRoster();
  resetGmTickets();
  resetPetition();
  clearReputation();
  resetAutoQuality();
  clearBagSearch();
  resetMacroWindow();
  resetPetBar();
  resetLoadingScreen();
  // The grey of death belongs to the world being left. Its own listener is already gone with the
  // store detached above, so nothing would ever take the layer down again on its own.
  resetDeathScreenEffect();
  // Pending writes go out before the world does, so a setting changed in the last second survives.
  settingsStore.detach();
  for (const store of macroStores) store.detach();
  detachInputAccount();
  showAuctions();
  showLfg();
  // The connection is gone, so the keys are dropped rather than released: a stop packet now
  // would be written to a socket that no longer has a session behind it.
  forgetMovementState();
  worldPanel.hidden = true;
  document.body.classList.remove("world-active");
}

/**
 * A live connection becomes this client's world: the GlueXML screens already hold an authenticated
 * `WorldClient` on the realm the player chose, and adopting it is what makes the world half of the
 * client work over that connection instead of opening a second one.
 */
export function adoptWorld(world: WorldClient): void {
  adoptWorldConnection(game, world, {
    bindHud: bindPlayerHud,
    // Same update path as the HUD, for the same reason: the two read the same character and must
    // never disagree about whether it is alive.
    bindDeathScreen: bindDeathScreenEffect,
    onListenerError: (error) => console.error("Панель интерфейса не пережила обновление", error),
  });
}

/**
 * Every way out of a world, in one place.
 *
 * Three callers, all of them in `EnterWorld.ts` because that is where the world's own events are
 * bound: `SMSG_LOGOUT_COMPLETE`, the read loop dying, and an enter attempt that failed. The glue
 * screens decide where the player lands (`frontDoorReturn`) and own the socket from there.
 */
export function leaveWorld(exit: WorldExit, message?: GlueAuthMessage): void {
  // Held before the reset, because `clearWorldContext` is what drops `game.world`: reaching for it
  // afterwards would find `undefined` and leave the socket open for the life of the tab.
  const world = game.world;
  resetWorldUi();
  const front = frontDoorHost();
  if (front) {
    front.returnFromWorld(exit, message);
    return;
  }
  // No glue screens are standing, so nobody else is left to close the connection.
  world?.close();
}
