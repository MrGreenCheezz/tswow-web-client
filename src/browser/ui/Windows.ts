import { game } from "../game/Context.js";
import { tradeGoldToCopper } from "../../world/TradeProtocol.js";
import { LFG_ROLE_DAMAGE, LFG_ROLE_HEALER, LFG_ROLE_TANK } from "../../world/LfgProtocol.js";
import { showWorldState } from "./WorldView.js";
import {
  attackButton, auctionBids, auctionFind, auctionMine, auctionSearch, auctionWindow, bankerButton, characterToggle,
  characterWindow, chatForm,
  chatInput, clearTargetButton, deathReclaim, deathRelease, deathSpirit,
  diagnosticsWindow, duelAccept, duelDecline, element, gossipWindow,
  groupAccept, groupDecline, guildAccept, guildDecline, interactButton, inventoryToggle,
  inventoryWindow, lfgAccept, lfgDecline, lfgJoin, lfgLeave, lfgTeleport, lfgToggle, lfgWindow,
  lootAll, lootButton, lootMoney, lootWindow, questWindow,
  gameMenuToggle, resurrectAccept, resurrectDecline, spellbookHideRanks, spellbookSearch,
  spellbookToggle, spellbookWindow, talentsToggle,
  tradeAccept, tradeCancel, tradeGold, tradeSetGold, tradeWindow, trainerButton, trainerWindow,
  unhandledSave, vendorButton, vendorWindow,
} from "./Dom.js";
import { closeNpcServiceWindow } from "./Npc.js";
import { showTarget } from "./Frames.js";
import { anyBagWindowOpen, closeBagWindows, toggleAllBags } from "./Bags.js";
import { closeWorldMap, worldMapOpen } from "./WorldMap.js";
import { closeTrackingMenu, trackingMenuOpen } from "./Tracking.js";
import { toggleTalentsWindow } from "./Talents.js";
import { submitChat, systemLine } from "./Chat.js";
import { changeAuctionOwnerPage, closeLfgWindow, lfgWindowOpen, selectedLfgDungeons, selectedLfgRoles, setAuctionOwnerPage, setAuctionTab, toggleLfgWindow } from "./Social.js";
import { closeMail, closeMailRead, mailOpen, mailReadOpen } from "./Mail.js";
import { interactWithTarget, lootCurrentTarget } from "./Npc.js";
import { setSpellbookSearch, showSpells, spellbookSearchKeyDown } from "./Spellbook.js";
import { toggleSetting } from "./Settings.js";
import { saveUnhandledOpcodeReport } from "./Diagnostics.js";
import { closeFloating } from "./Widgets.js";
import { closeGuildWindow, guildWindowOpen } from "./Guild.js";
import { closeGuildBank, guildBankOpen } from "./GuildBank.js";
import { calendarOpen, closeCalendar } from "./Calendar.js";
import { closeGmTickets, gmTicketsOpen } from "./GmTickets.js";
import { closePetition, petitionOpen } from "./Petition.js";
import { closeSocialPanel, socialPanelOpen } from "./SocialPanel.js";
import { closeScoreboard, scoreboardOpen } from "./Scoreboard.js";
import { closeReputation, reputationOpen } from "./Reputation.js";
import { arenaWindowOpen, closeArenaWindow } from "./ArenaWindow.js";
import { closeLootRolls, lootRollsOpen } from "./LootRolls.js";
import { closeQuestLog, questLogOpen, toggleQuestLog } from "./QuestLog.js";
import { barberOpen, closeBarberShop } from "./BarberShop.js";
import { channelRosterOpen, closeChannelRoster } from "./ChannelRoster.js";
import { toggleSocialPanel } from "./SocialPanel.js";
import { toggleWorldMap } from "./WorldMap.js";
import { toggleCalendar } from "./Calendar.js";
import { closeReadyCheck, readyCheckOpen } from "./ReadyCheck.js";
import { closeSettingsWindow, settingsWindowOpen } from "./Settings.js";
import { closeMacroWindow, macroWindowOpen } from "./Macros.js";
import { closeProfessions, professionsOpen } from "./Professions.js";
import { closeSocketing, socketingOpen } from "./Socketing.js";
import {
  selectCharacterTab, selectedCharacterTab, type CharacterTab, wireCharacterTabs,
} from "./CharacterSheet.js";
import { cancelLogoutCountdown, logoutCountdownOpen, toggleGameMenu } from "./GameMenu.js";
import { closeFrameXmlPopups, frameXmlPopupsOpen } from "../framexml/FrameXmlPopupsController.js";
import { closeEscapableWindows, escapableWindowOpen } from "./WindowRegistry.js";
import { playUiSound } from "../game/GameSounds.js";
import {
  closeFrameXmlSpellBook,
  frameXmlSpellBookOpen,
  toggleFrameXmlSpellBook,
} from "../framexml/FrameXmlSpellBookController.js";
import {
  closeFrameXmlBags,
  frameXmlBagsOpen,
  toggleFrameXmlBags,
} from "../framexml/FrameXmlBagController.js";
import {
  closeFrameXmlCharacter,
  frameXmlCharacterOpen,
  toggleFrameXmlCharacter,
  toggleFrameXmlCharacterTab,
} from "../framexml/FrameXmlCharacterController.js";
import {
  closeFrameXmlQuest,
  frameXmlQuestOpen,
  toggleFrameXmlQuest,
} from "../framexml/FrameXmlQuestController.js";
import {
  closeFrameXmlTalent,
  frameXmlTalentOpen,
  toggleFrameXmlTalent,
} from "../framexml/FrameXmlTalentController.js";
import {
  closeFrameXmlPvp,
  frameXmlPvpOpen,
} from "../framexml/FrameXmlPvpController.js";
import { closeFrameXmlLfd, frameXmlLfdOpen } from "../framexml/FrameXmlLfdController.js";
import { closeFrameXmlFriends, frameXmlFriendsOpen } from "../framexml/FrameXmlFriendsController.js";
import { closeFrameXmlLoot, frameXmlLootOpen } from "../framexml/FrameXmlLootController.js";
import { closeFrameXmlMail, frameXmlMailOpen } from "../framexml/FrameXmlMailController.js";
import { closeFrameXmlTrade, frameXmlTradeOpen } from "../framexml/FrameXmlTradeController.js";
import { closeFrameXmlAuction, frameXmlAuctionOpen } from "../framexml/FrameXmlAuctionController.js";
import {
  closeFrameXmlMerchant,
  frameXmlMerchantOpen,
} from "../framexml/FrameXmlMerchantController.js";
import {
  closeFrameXmlTrainer,
  frameXmlTrainerOpen,
} from "../framexml/FrameXmlTrainerController.js";
import { closeFrameXmlTradeSkill, frameXmlTradeSkillOpen } from "../framexml/FrameXmlTradeSkillController.js";
export function toggleGameWindow(window: HTMLElement): void {
  if (window === spellbookWindow && toggleFrameXmlSpellBook()) return;
  window.hidden = !window.hidden;
  // The one place every markup window is opened and shut, so the one place that has to know a
  // window makes a noise. `igMainMenuOpen` and its closing pair are the client's own.
  playUiSound(window.hidden ? "windowClose" : "windowOpen");
  // Contents of a hidden window are not kept up to date, so they are rebuilt when it opens.
  if (!window.hidden && game.world) {
    showWorldState(game.world.state);
    // A spell learned while the book was shut must not wait for another event to show up: the open
    // is the repaint the player asked for. Every route into this window goes through here.
    if (window === spellbookWindow) showSpells();
  }
}

/** Makes a page visible without turning a server response into an accidental close toggle. */
export function showCharacterWindow(tab: CharacterTab): void {
  selectCharacterTab(tab);
  if (characterWindow.hidden) toggleGameWindow(characterWindow);
}

/**
 * Opens a page in the one native character window; repeating the same shortcut closes it.
 *
 * A published stock CharacterFrame owns its own pages through stock ToggleCharacter, with the
 * stock bindings' open/switch/close behaviour: «sheet» (C) is the paper doll, «skills» (J) is
 * SkillFrame on tab 4. Without that owner, skills keep the stock spellbook's skill-line tabs and
 * then the native pane. Stock ReputationFrame (tab 3) is reached through its tab only: no native
 * binding opens reputation directly.
 */
export function openCharacterWindow(tab: CharacterTab): void {
  if (tab === "sheet" && toggleFrameXmlCharacter()) return;
  if (tab === "skills" && (toggleFrameXmlCharacterTab("SkillFrame") || toggleFrameXmlSpellBook())) return;
  if (!characterWindow.hidden && selectedCharacterTab() === tab) {
    toggleGameWindow(characterWindow);
    return;
  }
  showCharacterWindow(tab);
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
  // The stock CAMP popup cancels the server countdown when dismissed with Escape.
  { isOpen: logoutCountdownOpen, close: cancelLogoutCountdown },
  // The published stock StaticPopups: StaticPopup_EscapePressed runs each escapable dialog's own
  // cancel (DeclineGroup, CancelTrade, CAMP's CancelLogout …); inert while the natives own them.
  { isOpen: frameXmlPopupsOpen, close: closeFrameXmlPopups },
  // Slice I9's windows, every one of them built at run time and therefore invisible to the old
  // hardcoded list. A roll dialog goes first: Escape should wave the dialogs away before it
  // starts closing windows behind them.
  { isOpen: lootRollsOpen, close: closeLootRolls },
  { isOpen: readyCheckOpen, close: closeReadyCheck },
  { isOpen: guildWindowOpen, close: closeGuildWindow },
  { isOpen: questLogOpen, close: closeQuestLog },
  { isOpen: barberOpen, close: closeBarberShop },
  { isOpen: channelRosterOpen, close: closeChannelRoster },
  { isOpen: guildBankOpen, close: closeGuildBank },
  { isOpen: calendarOpen, close: closeCalendar },
  { isOpen: gmTicketsOpen, close: closeGmTickets },
  { isOpen: petitionOpen, close: closePetition },
  { isOpen: socialPanelOpen, close: closeSocialPanel },
  { isOpen: lfgWindowOpen, close: closeLfgWindow },
  { isOpen: scoreboardOpen, close: closeScoreboard },
  { isOpen: reputationOpen, close: closeReputation },
  { isOpen: arenaWindowOpen, close: closeArenaWindow },
  { isOpen: settingsWindowOpen, close: closeSettingsWindow },
  { isOpen: macroWindowOpen, close: closeMacroWindow },
  { isOpen: professionsOpen, close: closeProfessions },
  { isOpen: mailReadOpen, close: closeMailRead },
  { isOpen: mailOpen, close: closeMail },
  { isOpen: socketingOpen, close: closeSocketing },
  // These three stock-controller entries stay available to isolated FrameXML diagnostics, but the
  // production world mount does not publish them. They are inert while the native C/P/N windows own
  // their routes and still provide correct Escape behavior if a diagnostic publishes an owner.
  { isOpen: frameXmlSpellBookOpen, close: closeFrameXmlSpellBook },
  // The stock ContainerFrame owner is published only after its roots and first real open pass.
  // Before that point this entry is inert and Bags.ts remains the native fallback.
  { isOpen: frameXmlBagsOpen, close: closeFrameXmlBags },
  { isOpen: frameXmlCharacterOpen, close: closeFrameXmlCharacter },
  // QuestLogFrame follows the same ownership rule: before a successful mount
  // this stable entry is inert and the native quest log remains untouched.
  { isOpen: frameXmlQuestOpen, close: closeFrameXmlQuest },
  // PvP's stock summary is distinct from the native arena invite surface. Keep one stable
  // entry so the first Escape closes PVPParentFrame before the game menu gets a chance to open.
  { isOpen: frameXmlPvpOpen, close: closeFrameXmlPvp },
  // The stock dungeon finder (LFDParentFrame) once published; inert while the native #lfg-window
  // (the entry above) owns the route.
  { isOpen: frameXmlLfdOpen, close: closeFrameXmlLfd },
  // The stock FriendsFrame (Friends, Who, Guild, Chat, Raid tabs) once published; inert while the
  // native social and guild windows (entries above) own the routes.
  { isOpen: frameXmlFriendsOpen, close: closeFrameXmlFriends },
  // The stock LootFrame once published: its close is LootCloseButton's own HideUIPanel, whose
  // OnHide releases the corpse. Stock GroupLootFrames are not Escape-closable, as in the client.
  { isOpen: frameXmlLootOpen, close: closeFrameXmlLoot },
  // Stock MailFrame/OpenMailFrame and TradeFrame once published: their close is HideUIPanel, whose
  // OnHide closes the mailbox (CloseMail) or cancels the trade (CloseTrade), as in the client.
  { isOpen: frameXmlMailOpen, close: closeFrameXmlMail },
  { isOpen: frameXmlTradeOpen, close: closeFrameXmlTrade },
  // Stock AuctionFrame once Blizzard_AuctionUI has loaded: HideUIPanel, whose OnHide calls
  // CloseAuctionHouse. While the add-on loads the native #auction-window (MARKUP_WINDOWS) owns it.
  { isOpen: frameXmlAuctionOpen, close: closeFrameXmlAuction },
  // MerchantFrame owns the vendor interaction once its structural gate has published. Escape must
  // close it before the game menu, while an absent gate leaves Npc.ts as the native fallback.
  { isOpen: frameXmlMerchantOpen, close: closeFrameXmlMerchant },
  // The native trainer remains visible while Blizzard_TrainerUI is loading; its owner therefore
  // also cancels the pending intent before the native close path runs.
  { isOpen: frameXmlTrainerOpen, close: closeFrameXmlTrainer },
  { isOpen: frameXmlTalentOpen, close: closeFrameXmlTalent },
  // The stock TradeSkillFrame (Blizzard_TradeSkillUI) once published: a waiting enchant is dropped,
  // and HideUIPanel's OnHide runs CloseTradeSkill. While it loads, the native craft window's entry
  // above closes the visible fallback.
  { isOpen: frameXmlTradeSkillOpen, close: closeFrameXmlTradeSkill },
  // Every module window that asked for `escClose`, as one entry. Only the ones that asked count:
  // a definition that leaves `escClose` off means a HUD overlay, and a HUD that swallowed Escape
  // would take the game menu away from the player for as long as the module was loaded.
  { isOpen: escapableWindowOpen, close: closeEscapableWindows },
];

export function registerEscapable(entry: EscapableWindow): () => void {
  ESCAPABLE.push(entry);
  return () => {
    const index = ESCAPABLE.indexOf(entry);
    if (index >= 0) ESCAPABLE.splice(index, 1);
  };
}

const MARKUP_WINDOWS = [
  characterWindow, inventoryWindow, spellbookWindow, gossipWindow, questWindow, lootWindow,
  auctionWindow, tradeWindow,
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
  if (!gossipWindow.hidden) {
    closeNpcServiceWindow();
    game.world?.closeGossip();
  }
  if (!questWindow.hidden) game.world?.closeQuest();
  if (!lootWindow.hidden) game.world?.closeLoot();
  if (!vendorWindow.hidden) game.world?.closeVendor();
  if (!auctionWindow.hidden) game.world?.closeAuctionHouse();
  if (!tradeWindow.hidden) game.world?.cancelTrade();
  // A pending supported trainer is still owned by the stock controller even though its native
  // fallback is visible. Let that owner cancel the request and call CloseTrainer exactly once;
  // only an inert/type-2 owner falls through to the native world close path.
  if (frameXmlTrainerOpen()) closeFrameXmlTrainer();
  else if (!trainerWindow.hidden) game.world?.closeTrainer();
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
  wireCharacterTabs();
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

  characterToggle.addEventListener("click", () => {
    openCharacterWindow("sheet");
  });
  inventoryToggle.addEventListener("click", () => {
    if (!toggleFrameXmlBags()) toggleAllBags();
  });
  spellbookToggle.addEventListener("click", () => {
    toggleGameWindow(spellbookWindow);
  });
  talentsToggle.addEventListener("click", () => {
    if (!toggleFrameXmlTalent()) toggleTalentsWindow();
  });
  lfgToggle.addEventListener("click", () => toggleLfgWindow());
  // The journal, social panel, world map and calendar had no mouse entry point at all: only
  // hotkeys and slash commands. The windows were ready; only the buttons were missing.
  document.getElementById("quest-toggle")?.addEventListener("click", () => {
    if (!toggleFrameXmlQuest()) toggleQuestLog();
  });
  document.getElementById("social-toggle")?.addEventListener("click", () => toggleSocialPanel());
  document.getElementById("worldmap-toggle")?.addEventListener("click", () => toggleWorldMap());
  document.getElementById("calendar-toggle")?.addEventListener("click", () => toggleCalendar());
  gameMenuToggle.addEventListener("click", toggleGameMenu);
  unhandledSave.addEventListener("click", saveUnhandledOpcodeReport);
  // Auction search state lives here so filters, pagination and pending-sales work without
  // waiting on a Dom.ts regeneration: the inputs are read directly by id.
  let auctionPage = 0;
  let auctionTab: "search" | "own" | "bids" = "search";
  const auctionFilters = (): Record<string, unknown> => {
    const byId = (id: string): HTMLInputElement | HTMLSelectElement | null =>
      document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    const levelMin = Math.max(0, Math.floor(Number((byId("auction-level-min") as HTMLInputElement)?.value) || 0));
    const levelMax = Math.max(0, Math.floor(Number((byId("auction-level-max") as HTMLInputElement)?.value) || 0));
    const quality = Number((byId("auction-quality") as HTMLSelectElement)?.value ?? "-1");
    const usableOnly = (byId("auction-usable") as HTMLInputElement)?.checked === true;
    const pageLabel = document.getElementById("auction-page");
    if (pageLabel) pageLabel.textContent = `Стр. ${auctionPage}`;
    return {
      name: auctionSearch.value.trim(),
      ...(levelMin > 0 ? { levelMin } : {}),
      ...(levelMax > 0 ? { levelMax } : {}),
      ...(Number.isInteger(quality) && quality >= 0 ? { quality } : {}),
      ...(usableOnly ? { usableOnly: true } : {}),
    };
  };
  auctionFind.addEventListener("click", () => {
    auctionTab = "search"; setAuctionTab("search"); auctionPage = 0;
    game.world?.searchAuctions({ ...auctionFilters(), page: 0 } as Parameters<NonNullable<typeof game.world.searchAuctions>>[0]);
  });
  auctionMine.addEventListener("click", () => { auctionTab = "own"; setAuctionTab("own"); setAuctionOwnerPage(0); game.world?.listOwnAuctions(); });
  auctionBids.addEventListener("click", () => { auctionTab = "bids"; setAuctionTab("bids"); refreshBidderList(); });
  document.getElementById("auction-pending")?.addEventListener("click", () => game.world?.requestPendingSales());
  // The bids list has no server pages (`BuildListBidderItems` answers whole), so its
  // arrows refresh rather than turn.
  const refreshBidderList = (): void => {
    const pageLabel = document.getElementById("auction-page");
    if (pageLabel) pageLabel.textContent = "Стр. 0";
    game.world?.listBidderAuctions();
  };
  document.getElementById("auction-prev")?.addEventListener("click", () => {
    if (auctionTab === "own") changeAuctionOwnerPage(-1);
    else if (auctionTab === "bids") refreshBidderList();
    else { auctionPage = Math.max(0, auctionPage - 1); game.world?.searchAuctions({ ...auctionFilters(), page: auctionPage } as Parameters<NonNullable<typeof game.world.searchAuctions>>[0]); }
  });
  document.getElementById("auction-next")?.addEventListener("click", () => {
    if (auctionTab === "own") changeAuctionOwnerPage(1);
    else if (auctionTab === "bids") refreshBidderList();
    else { auctionPage += 1; game.world?.searchAuctions({ ...auctionFilters(), page: auctionPage } as Parameters<NonNullable<typeof game.world.searchAuctions>>[0]); }
  });
  lfgAccept.addEventListener("click", () => game.world?.answerLfgProposal(true));
  lfgDecline.addEventListener("click", () => game.world?.answerLfgProposal(false));
  lfgLeave.addEventListener("click", () => game.world?.leaveLfg());
  lfgTeleport.addEventListener("click", () => game.world?.teleportToDungeon(true));
  lfgJoin.addEventListener("click", () => {
    const roles = selectedLfgRoles();
    if ((roles & (LFG_ROLE_TANK | LFG_ROLE_HEALER | LFG_ROLE_DAMAGE)) === 0) {
      systemLine("Выберите роль: танк, лекарь или урон");
      return;
    }
    const dungeons = selectedLfgDungeons();
    if (dungeons.length === 0) {
      systemLine("Отметьте подземелье в каталоге или укажите хотя бы один ID вручную");
      return;
    }
    game.world?.joinLfg(roles, dungeons);
  });
  guildAccept.addEventListener("click", () => game.world?.answerGuildInvite(true));
  guildDecline.addEventListener("click", () => game.world?.answerGuildInvite(false));
  tradeSetGold.addEventListener("click", () => game.world?.offerTradeGold(tradeGoldToCopper(Number(tradeGold.value))));
  tradeAccept.addEventListener("click", () => {
    const world = game.world;
    if (world?.tradePending) world.beginTrade();
    else world?.acceptTrade();
  });
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
  lootAll.addEventListener("click", () => game.world?.takeAllLoot());
  deathRelease.addEventListener("click", () => game.world?.releaseSpirit());
  deathReclaim.addEventListener("click", () => game.world?.reclaimCorpse());
  deathSpirit.addEventListener("click", () => {
    const world = game.world;
    if (world?.targetGuid !== undefined) world.activateSpiritHealer(world.targetGuid);
  });
  resurrectAccept.addEventListener("click", () => game.world?.answerResurrect(true));
  resurrectDecline.addEventListener("click", () => game.world?.answerResurrect(false));
  spellbookSearch.addEventListener("input", () => setSpellbookSearch(spellbookSearch.value));
  // The spellbook's first Escape clears and blurs its search; the shared Escape handler sees the
  // blur and leaves this press to the field. A later Escape can close the book.
  spellbookSearch.addEventListener("keydown", spellbookSearchKeyDown);
  // Through the account's blob, not into a local flag: the switch is per character and the server
  // holds it, so `applySettings` is what tells the book — and the checkbox — what it now says.
  spellbookHideRanks.addEventListener("change", () => toggleSetting("spellbookHideLowerRanks"));
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close]")) {
    button.addEventListener("click", () => {
      const close = button.dataset.close!;
      const ownedByFrameXml = close === "character-window" && closeFrameXmlCharacter();
      if (close === "trainer-window") {
        const ownedByTrainer = closeFrameXmlTrainer();
        trainerWindow.hidden = true;
        if (!ownedByTrainer) game.world?.closeTrainer();
      } else if (close === "guild-window") closeGuildWindow();
      else if (!ownedByFrameXml) element<HTMLElement>(close).hidden = true;
      playUiSound("windowClose");
      if (button.dataset.close === "gossip-window") {
        closeNpcServiceWindow();
        game.world?.closeGossip();
      }
      if (button.dataset.close === "loot-window") game.world?.closeLoot();
      if (button.dataset.close === "vendor-window") game.world?.closeVendor();
      if (button.dataset.close === "trade-window") game.world?.cancelTrade();
      if (button.dataset.close === "mail-window") game.world?.closeMailbox();
      if (button.dataset.close === "auction-window") game.world?.closeAuctionHouse();
      if (button.dataset.close === "lfg-window") closeLfgWindow();
      if (button.dataset.close === "quest-window") game.world?.closeQuest();
    });
  }
}
