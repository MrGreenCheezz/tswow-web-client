import { game } from "../game/Context.js";
import { showWorldState } from "./WorldView.js";
import {
  attackButton, auctionFind, auctionMine, auctionSearch, bankerButton, characterToggle,
  characterWindow, chatForm,
  chatInput, clearTargetButton, deathReclaim, deathRelease, deathSpirit, diagnosticsToggle,
  diagnosticsWindow, duelAccept, duelDecline, element, gossipWindow,
  groupAccept, groupDecline, guildAccept, guildDecline, guildWindow, interactButton, inventoryToggle,
  inventoryWindow, lfgAccept, lfgDecline, lfgDungeons, lfgJoin, lfgLeave, lfgTeleport, lfgWindow,
  lootButton, lootMoney, lootWindow, mailBody, mailMoney, mailSend, mailSubject, mailTo, questWindow,
  professionsToggle, resurrectAccept, resurrectDecline, spellbookHideRanks, spellbookSearch,
  spellbookToggle, spellbookWindow, talentsToggle,
  tradeAccept, tradeCancel, tradeGold, tradeSetGold, trainerButton, trainerWindow,
  unhandledSave, vendorButton, vendorWindow,
} from "./Dom.js";
import { showTarget } from "./Frames.js";
import { anyBagWindowOpen, closeBagWindows, toggleAllBags } from "./Bags.js";
import { closeWorldMap, worldMapOpen } from "./WorldMap.js";
import { closeTrackingMenu, trackingMenuOpen } from "./Tracking.js";
import { toggleTalentsWindow } from "./Talents.js";
import { toggleProfessionsWindow } from "./Professions.js";
import { submitChat, systemLine } from "./Chat.js";
import { selectedLfgRoles } from "./Social.js";
import { interactWithTarget, lootCurrentTarget } from "./Npc.js";
import { setSpellbookSearch, spellbookSearchKeyDown } from "./Spellbook.js";
import { toggleSetting } from "./Settings.js";
import { saveUnhandledOpcodeReport, showUnhandledOpcodes } from "./Diagnostics.js";
import { closeFloating } from "./Widgets.js";
import { closeGuildWindow, guildWindowOpen } from "./Guild.js";
import { closeGuildBank, guildBankOpen } from "./GuildBank.js";
import { calendarOpen, closeCalendar } from "./Calendar.js";
import { closeSocialPanel, socialPanelOpen } from "./SocialPanel.js";
import { closeScoreboard, scoreboardOpen } from "./Scoreboard.js";
import { arenaWindowOpen, closeArenaWindow } from "./ArenaWindow.js";
import { closeLootRolls, lootRollsOpen } from "./LootRolls.js";
import { closeReadyCheck, readyCheckOpen } from "./ReadyCheck.js";
import { closeSettingsWindow, settingsWindowOpen } from "./Settings.js";
import { closeMacroWindow, macroWindowOpen } from "./Macros.js";
import { closeEscapableWindows, escapableWindowOpen } from "./WindowRegistry.js";
import { playUiSound } from "../game/GameSounds.js";
export function toggleGameWindow(window: HTMLElement): void {
  window.hidden = !window.hidden;
  // The one place every markup window is opened and shut, so the one place that has to know a
  // window makes a noise. `igMainMenuOpen` and its closing pair are the client's own.
  playUiSound(window.hidden ? "windowClose" : "windowOpen");
  // Contents of a hidden window are not kept up to date, so they are rebuilt when it opens.
  if (!window.hidden && game.world) showWorldState(game.world.state);
}

/**
 * The windows Escape closes.
 *
 * This was a nine-element array written out twice, once to ask whether anything was open and once
 * to close it, and the two could not disagree only because nobody had touched them since. Every
 * window built at run time — the bank, the guild, the calendar, the scoreboard — was missing from
 * both, so Escape walked straight past them into the game menu. A panel registers itself here
 * instead, and the list is one list.
 */
export interface EscapableWindow {
  isOpen(): boolean;
  close(): void;
}

const ESCAPABLE: EscapableWindow[] = [
  // Slice I9's windows, every one of them built at run time and therefore invisible to the old
  // hardcoded list. A roll dialog goes first: Escape should wave the dialogs away before it
  // starts closing windows behind them.
  { isOpen: lootRollsOpen, close: closeLootRolls },
  { isOpen: readyCheckOpen, close: closeReadyCheck },
  { isOpen: guildWindowOpen, close: closeGuildWindow },
  { isOpen: guildBankOpen, close: closeGuildBank },
  { isOpen: calendarOpen, close: closeCalendar },
  { isOpen: socialPanelOpen, close: closeSocialPanel },
  { isOpen: scoreboardOpen, close: closeScoreboard },
  { isOpen: arenaWindowOpen, close: closeArenaWindow },
  { isOpen: settingsWindowOpen, close: closeSettingsWindow },
  { isOpen: macroWindowOpen, close: closeMacroWindow },
  // Every module window that asked for `escClose`, as one entry. Only the ones that asked count:
  // a definition that leaves `escClose` off means a HUD overlay, and a HUD that swallowed Escape
  // would take the game menu away from the player for as long as the module was loaded.
  { isOpen: escapableWindowOpen, close: closeEscapableWindows },
];

export function registerEscapable(entry: EscapableWindow): void {
  ESCAPABLE.push(entry);
}

const MARKUP_WINDOWS = [
  characterWindow, inventoryWindow, spellbookWindow, gossipWindow, questWindow, lootWindow,
  vendorWindow, trainerWindow, diagnosticsWindow,
];

/** Whether any of the panels Escape dismisses is currently up. */
export function anyGameWindowOpen(): boolean {
  // The bank has no window in the page markup: it is open exactly while the banker's permission
  // stands, which is what `closeGameWindows` gives back.
  return anyBagWindowOpen() || worldMapOpen() || trackingMenuOpen() || game.world?.bankerGuid !== undefined
    || MARKUP_WINDOWS.some((window) => !window.hidden)
    || ESCAPABLE.some((entry) => entry.isOpen());
}

export function closeGameWindows(): void {
  if (!gossipWindow.hidden) game.world?.closeGossip();
  if (!questWindow.hidden) game.world?.closeQuest();
  if (!lootWindow.hidden) game.world?.closeLoot();
  if (!vendorWindow.hidden) game.world?.closeVendor();
  if (!trainerWindow.hidden) game.world?.closeTrainer();
  game.world?.closeBank();
  closeBagWindows();
  closeWorldMap();
  closeTrackingMenu();
  closeFloating();
  for (const window of MARKUP_WINDOWS) window.hidden = true;
  for (const entry of ESCAPABLE) if (entry.isOpen()) entry.close();
}

/** Every button in the page markup, connected to what it does. Registered once, at start-up. */
export function wirePanelButtons(): void {
  attackButton.addEventListener("click", () => {
    if (!game.world) return;
    game.world.attacking ? game.world.stopAttack() : game.world.startAttack();
    showTarget();
  });

  // The same verb the interact key and a right-click in the world run, so a door opened by mouse
  // and a door opened by key cannot drift apart.
  interactButton.addEventListener("click", interactWithTarget);

  clearTargetButton.addEventListener("click", () => {
    game.world?.selectTarget(undefined);
    showTarget();
  });

  characterToggle.addEventListener("click", () => toggleGameWindow(characterWindow));
  inventoryToggle.addEventListener("click", toggleAllBags);
  spellbookToggle.addEventListener("click", () => toggleGameWindow(spellbookWindow));
  talentsToggle.addEventListener("click", () => toggleTalentsWindow());
  professionsToggle.addEventListener("click", () => toggleProfessionsWindow());
  diagnosticsToggle.addEventListener("click", () => {
    toggleGameWindow(diagnosticsWindow);
    if (!diagnosticsWindow.hidden) showUnhandledOpcodes();
  });
  unhandledSave.addEventListener("click", saveUnhandledOpcodeReport);
  auctionFind.addEventListener("click", () => game.world?.searchAuctions({ name: auctionSearch.value.trim() }));
  auctionMine.addEventListener("click", () => game.world?.listOwnAuctions());
  lfgAccept.addEventListener("click", () => game.world?.answerLfgProposal(true));
  lfgDecline.addEventListener("click", () => game.world?.answerLfgProposal(false));
  lfgLeave.addEventListener("click", () => game.world?.leaveLfg());
  lfgTeleport.addEventListener("click", () => game.world?.teleportToDungeon(true));
  lfgJoin.addEventListener("click", () => {
    const dungeons = lfgDungeons.value.split(",").map((part) => Number(part.trim())).filter((id) => Number.isInteger(id) && id > 0);
    if (dungeons.length === 0) {
      systemLine("Укажите хотя бы один id подземелья");
      return;
    }
    game.world?.joinLfg(selectedLfgRoles(), dungeons);
  });
  guildAccept.addEventListener("click", () => game.world?.answerGuildInvite(true));
  guildDecline.addEventListener("click", () => game.world?.answerGuildInvite(false));
  mailSend.addEventListener("click", () => {
    const world = game.world;
    if (!world) return;
    world.sendMail({
      target: mailTo.value.trim(),
      subject: mailSubject.value.trim(),
      body: mailBody.value,
      money: Math.max(0, Math.floor(Number(mailMoney.value) || 0)),
    });
    mailSubject.value = "";
    mailBody.value = "";
    mailMoney.value = "0";
  });
  tradeSetGold.addEventListener("click", () => game.world?.offerTradeGold(Number(tradeGold.value) || 0));
  tradeAccept.addEventListener("click", () => game.world?.acceptTrade());
  tradeCancel.addEventListener("click", () => game.world?.cancelTrade());
  duelAccept.addEventListener("click", () => game.world?.answerDuel(true));
  duelDecline.addEventListener("click", () => game.world?.answerDuel(false));
  groupAccept.addEventListener("click", () => game.world?.answerGroupInvite(true));
  groupDecline.addEventListener("click", () => game.world?.answerGroupInvite(false));
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = chatInput.value;
    chatInput.value = "";
    chatInput.blur();
    submitChat(text);
  });
  lootButton.addEventListener("click", lootCurrentTarget);
  vendorButton.addEventListener("click", () => {
    const world = game.world;
    if (world?.targetGuid !== undefined) world.openVendor(world.targetGuid);
  });
  trainerButton.addEventListener("click", () => {
    const world = game.world;
    if (world?.targetGuid !== undefined) world.openTrainer(world.targetGuid);
  });
  bankerButton.addEventListener("click", () => {
    const world = game.world;
    if (world?.targetGuid !== undefined) world.openBank(world.targetGuid);
  });
  lootMoney.addEventListener("click", () => game.world?.takeLootMoney());
  deathRelease.addEventListener("click", () => game.world?.releaseSpirit());
  deathReclaim.addEventListener("click", () => game.world?.reclaimCorpse());
  deathSpirit.addEventListener("click", () => {
    const world = game.world;
    if (world?.targetGuid !== undefined) world.activateSpiritHealer(world.targetGuid);
  });
  resurrectAccept.addEventListener("click", () => game.world?.answerResurrect(true));
  resurrectDecline.addEventListener("click", () => game.world?.answerResurrect(false));
  spellbookSearch.addEventListener("input", () => setSpellbookSearch(spellbookSearch.value));
  // Escape empties the box and lets go of it, in that order and always — `Controls.onKeyDown`
  // leaves every key alone while the focus is in an input that is not the chat box, so without the
  // blur the press after this one has nowhere to go either. The body is next door in `Spellbook.ts`
  // because that is where the box's other two handlers already are, and where a test can call it.
  spellbookSearch.addEventListener("keydown", spellbookSearchKeyDown);
  // Through the account's blob, not into a local flag: the switch is per character and the server
  // holds it, so `applySettings` is what tells the book — and the checkbox — what it now says.
  spellbookHideRanks.addEventListener("change", () => toggleSetting("spellbookHideLowerRanks"));
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close]")) {
    button.addEventListener("click", () => {
      element<HTMLElement>(button.dataset.close!).hidden = true;
      playUiSound("windowClose");
      if (button.dataset.close === "gossip-window") game.world?.closeGossip();
      if (button.dataset.close === "loot-window") game.world?.closeLoot();
      if (button.dataset.close === "vendor-window") game.world?.closeVendor();
      if (button.dataset.close === "trade-window") game.world?.cancelTrade();
      if (button.dataset.close === "mail-window") game.world?.closeMailbox();
      if (button.dataset.close === "guild-window") guildWindow.hidden = true;
      if (button.dataset.close === "auction-window") game.world?.closeAuctionHouse();
      if (button.dataset.close === "lfg-window") lfgWindow.hidden = true;
      if (button.dataset.close === "trainer-window") game.world?.closeTrainer();
      if (button.dataset.close === "quest-window") game.world?.closeQuest();
    });
  }
}
