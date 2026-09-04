import { game } from "../game/Context.js";
import { showWorldState } from "./WorldView.js";
import {
  attackButton, auctionFind, auctionMine, auctionSearch, bankerButton, characterToggle,
  characterWindow, chatForm,
  chatInput, clearTargetButton, deathReclaim, deathRelease, deathSpirit,
  diagnosticsWindow, duelAccept, duelDecline, element, gossipWindow,
  groupAccept, groupDecline, guildAccept, guildDecline, guildWindow, interactButton, inventoryToggle,
  inventoryWindow, lfgAccept, lfgDecline, lfgDungeons, lfgJoin, lfgLeave, lfgTeleport, lfgWindow,
  lootButton, lootMoney, lootWindow, questWindow,
  gameMenuToggle, resurrectAccept, resurrectDecline, spellbookHideRanks, spellbookSearch,
  spellbookToggle, spellbookWindow, talentsToggle,
  tradeAccept, tradeCancel, tradeGold, tradeSetGold, trainerButton, trainerWindow,
  unhandledSave, vendorButton, vendorWindow,
} from "./Dom.js";
import { closeNpcServiceWindow } from "./Npc.js";
import { showTarget } from "./Frames.js";
import { anyBagWindowOpen, closeBagWindows, toggleAllBags } from "./Bags.js";
import { closeWorldMap, worldMapOpen } from "./WorldMap.js";
import { closeTrackingMenu, trackingMenuOpen } from "./Tracking.js";
import { toggleTalentsWindow } from "./Talents.js";
import { submitChat, systemLine } from "./Chat.js";
import { closeLfgWindow, selectedLfgRoles } from "./Social.js";
import { closeMail, closeMailRead, mailOpen, mailReadOpen } from "./Mail.js";
import { interactWithTarget, lootCurrentTarget } from "./Npc.js";
import { setSpellbookSearch, spellbookSearchKeyDown } from "./Spellbook.js";
import { toggleSetting } from "./Settings.js";
import { saveUnhandledOpcodeReport } from "./Diagnostics.js";
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
import { closeProfessions, professionsOpen } from "./Professions.js";
import { closeSocketing, socketingOpen } from "./Socketing.js";
import {
  selectCharacterTab, selectedCharacterTab, type CharacterTab, wireCharacterTabs,
} from "./CharacterSheet.js";
import { toggleGameMenu } from "./GameMenu.js";
import { closeEscapableWindows, escapableWindowOpen } from "./WindowRegistry.js";
import { playUiSound } from "../game/GameSounds.js";
import {
  closeFrameXmlSpellBook,
  frameXmlSpellBookOpen,
} from "../framexml/FrameXmlSpellBookController.js";
import {
  closeFrameXmlBags,
  frameXmlBagsOpen,
  toggleFrameXmlBags,
} from "../framexml/FrameXmlBagController.js";
import {
  closeFrameXmlCharacter,
  frameXmlCharacterOpen,
} from "../framexml/FrameXmlCharacterController.js";
import {
  closeFrameXmlQuest,
  frameXmlQuestOpen,
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
import {
  closeFrameXmlMerchant,
  frameXmlMerchantOpen,
} from "../framexml/FrameXmlMerchantController.js";
import {
  closeFrameXmlTrainer,
  frameXmlTrainerOpen,
} from "../framexml/FrameXmlTrainerController.js";
export function toggleGameWindow(window: HTMLElement): void {
  window.hidden = !window.hidden;
  // The one place every markup window is opened and shut, so the one place that has to know a
  // window makes a noise. `igMainMenuOpen` and its closing pair are the client's own.
  playUiSound(window.hidden ? "windowClose" : "windowOpen");
  // Contents of a hidden window are not kept up to date, so they are rebuilt when it opens.
  if (!window.hidden && game.world) showWorldState(game.world.state);
}

/** Makes a page visible without turning a server response into an accidental close toggle. */
export function showCharacterWindow(tab: CharacterTab): void {
  selectCharacterTab(tab);
  if (characterWindow.hidden) toggleGameWindow(characterWindow);
}

/** Opens a page in the one native character window; repeating the same shortcut closes it. */
export function openCharacterWindow(tab: CharacterTab): void {
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
  // MerchantFrame owns the vendor interaction once its structural gate has published. Escape must
  // close it before the game menu, while an absent gate leaves Npc.ts as the native fallback.
  { isOpen: frameXmlMerchantOpen, close: closeFrameXmlMerchant },
  // The native trainer remains visible while Blizzard_TrainerUI is loading; its owner therefore
  // also cancels the pending intent before the native close path runs.
  { isOpen: frameXmlTrainerOpen, close: closeFrameXmlTrainer },
  { isOpen: frameXmlTalentOpen, close: closeFrameXmlTalent },
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
  gameMenuToggle.addEventListener("click", toggleGameMenu);
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
      const close = button.dataset.close!;
      const ownedByFrameXml = close === "character-window" && closeFrameXmlCharacter();
      if (close === "trainer-window") {
        const ownedByTrainer = closeFrameXmlTrainer();
        trainerWindow.hidden = true;
        if (!ownedByTrainer) game.world?.closeTrainer();
      } else if (!ownedByFrameXml) element<HTMLElement>(close).hidden = true;
      playUiSound("windowClose");
      if (button.dataset.close === "gossip-window") {
        closeNpcServiceWindow();
        game.world?.closeGossip();
      }
      if (button.dataset.close === "loot-window") game.world?.closeLoot();
      if (button.dataset.close === "vendor-window") game.world?.closeVendor();
      if (button.dataset.close === "trade-window") game.world?.cancelTrade();
      if (button.dataset.close === "mail-window") game.world?.closeMailbox();
      if (button.dataset.close === "guild-window") guildWindow.hidden = true;
      if (button.dataset.close === "auction-window") game.world?.closeAuctionHouse();
      if (button.dataset.close === "lfg-window") closeLfgWindow();
      if (button.dataset.close === "quest-window") game.world?.closeQuest();
    });
  }
}
