/**
 * The neutral in-world API — slice F2's second item.
 *
 * "Neutral" is not "empty" and it is not "plausible". It is **an empty but
 * well-typed world**: every function below answers with the value the real
 * client answers when there is genuinely nothing there — no action on the bar,
 * no copper in the bag, no unit under the cursor, no CVar registered — and with
 * the *type* the caller's next line expects. Nothing here invents a name, a
 * level, a colour or a count it cannot derive.
 *
 * The rule that decides between "answer" and "leave nil" is F1's, unchanged: a
 * stub answers nothing until a measured failure forces a typed answer, and every
 * promotion carries the failure. What F2 adds is that a *whole family* is
 * promoted at once when one member of it was forced, because half a family is
 * how the next error appears two lines further down: `GetActionBarPage` alone
 * fixes `ActionButton.lua:149` and moves the failure to `:144`, which needs
 * `GetBonusBarOffset`, which moves it to `:146`.
 *
 * Two things live here rather than in `FrameXmlBoot.ts`. The constant answers
 * are data, so the report, the test and the prose cannot drift apart. The
 * stateful families — CVars, which have to round-trip a write, and add-ons,
 * which have to answer for the modules this TOC actually glued into itself —
 * are Lua, because they hold state that would otherwise cost a host round trip
 * per call, and F1's counters are in Lua for exactly that reason.
 */

import { FRAMEXML_GETTEXT_NEUTRAL, FRAMEXML_GETTEXT_PRELUDE } from "./FrameXmlGetText.js";
import { FRAMEXML_CENSUS_REMAINDER_NEUTRAL } from "./FrameXmlCensusRemainder.js";

export type FrameXmlApiGroup =
  | "cvar" | "addon" | "actionbar" | "binding" | "money" | "chat" | "unit" | "quest"
  | "minimap" | "pvp" | "options";

/** Human-readable group titles, for the report. */
export const FRAMEXML_API_GROUP_TITLES: Readonly<Record<FrameXmlApiGroup, string>> = Object.freeze({
  cvar: "CVar",
  addon: "AddOn",
  actionbar: "панель действий",
  binding: "клавиши и привязки",
  money: "деньги и сумки",
  chat: "чат, каналы, голос",
  unit: "юниты и группа",
  quest: "журнал заданий",
  minimap: "мини-карта",
  pvp: "PvP",
  options: "настройки клиента",
});

export interface FrameXmlNeutralAnswer {
  readonly name: string;
  readonly group: FrameXmlApiGroup;
  /**
   * The constant this name answers with, or `undefined` when the Lua module
   * below implements it because the answer depends on state.
   *
   * `[]` is a deliberate value and not a missing one: it means "answers nothing,
   * on purpose", and the reason says why nothing is the truthful answer.
   */
  readonly values?: readonly unknown[];
  /** What the answer is, in one line, for the report. */
  readonly answer: string;
  /** Why this and not nil: the measured failure, or why nothing is truthful. */
  readonly reason: string;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

/**
 * The action bar.
 *
 * 830 calls and 90 of F1's 183 distinct failures sit in `ActionButton.lua`. The
 * three arithmetic ones are the whole reason this group exists: `page`,
 * `offset` and the multi-cast offset are read straight into `+`/`-` with no nil
 * guard anywhere, so a nil there is not a missing feature but a dead file.
 */
const ACTION_BAR: readonly FrameXmlNeutralAnswer[] = [
  {
    name: "GetActionBarPage", group: "actionbar", values: [1], answer: "1",
    reason: "ActionButton.lua:149, 72 raises — `(page - 1) * NUM_ACTIONBAR_BUTTONS` with page nil. "
      + "1 is the page a bar with no bonus state and no stance is on, and the same value the "
      + "corpus' own `ActionBarController` writes back.",
  },
  {
    name: "GetBonusBarOffset", group: "actionbar", values: [0], answer: "0",
    reason: "ActionButton.lua:144, 6 raises — `NUM_ACTIONBAR_PAGES + offset`. 0 is «no bonus bar».",
  },
  {
    name: "GetMultiCastBarOffset", group: "actionbar", values: [0], answer: "0",
    reason: "ActionButton.lua:146, 12 raises — same arithmetic, the totem-bar branch.",
  },
  {
    name: "HasAction", group: "actionbar", values: [false], answer: "false",
    reason: "90 calls. false is the empty slot, and it is the branch that hides the icon rather "
      + "than the one that asks for its texture.",
  },
  { name: "GetActionTexture", group: "actionbar", values: NOTHING, answer: "nil", reason: "An empty slot has no icon; the caller is behind `HasAction`." },
  { name: "GetActionText", group: "actionbar", values: NOTHING, answer: "nil", reason: "Only a macro has text; nothing is on the bar." },
  { name: "GetActionCount", group: "actionbar", values: [0], answer: "0", reason: "ActionButton.lua:239 formats it into the count label." },
  {
    name: "GetActionCooldown", group: "actionbar", values: [0, 0, 0], answer: "0, 0, 0",
    reason: "start, duration, enable — `CooldownFrame_SetTimer` multiplies all three.",
  },
  { name: "GetActionInfo", group: "actionbar", values: NOTHING, answer: "nil", reason: "No action, so no type/id/subtype." },
  { name: "IsConsumableAction", group: "actionbar", values: [false], answer: "false", reason: "180 calls, ActionButton.lua:238; the true branch reads a count." },
  { name: "IsStackableAction", group: "actionbar", values: [false], answer: "false", reason: "180 calls, the other half of the same condition." },
  { name: "IsEquippedAction", group: "actionbar", values: [false], answer: "false", reason: "90 calls, ActionButton.lua:229 — the border tint." },
  { name: "IsAttackAction", group: "actionbar", values: [false], answer: "false", reason: "The auto-attack flash." },
  { name: "IsAutoRepeatAction", group: "actionbar", values: [false], answer: "false", reason: "The auto-repeat flash." },
  { name: "IsCurrentAction", group: "actionbar", values: [false], answer: "false", reason: "The pushed state." },
  {
    name: "IsUsableAction", group: "actionbar", values: [false, false], answer: "false, false",
    reason: "isUsable, notEnoughMana — both false is «there is nothing to use», not «it failed».",
  },
  {
    name: "IsActionInRange", group: "actionbar", values: NOTHING, answer: "nil",
    reason: "nil is the client's own answer for an action with no range check, and the corpus "
      + "tests `== 0` / `== 1` explicitly, so nil takes the «no range» branch.",
  },
  { name: "HasMultiCastActionBar", group: "actionbar", values: [false], answer: "false", reason: "No totem bar." },
  { name: "HasMultiCastActionPage", group: "actionbar", values: [false], answer: "false", reason: "Same bar, per page." },
  { name: "GetPetActionInfo", group: "actionbar", values: NOTHING, answer: "nil", reason: "No pet." },
  { name: "GetPetActionCooldown", group: "actionbar", values: [0, 0, 0], answer: "0, 0, 0", reason: "Same shape as the action cooldown." },
  { name: "GetPetActionSlotUsable", group: "actionbar", values: [false], answer: "false", reason: "No pet bar." },
  { name: "IsPetAttackAction", group: "actionbar", values: [false], answer: "false", reason: "No pet bar." },
  { name: "GetNumShapeshiftForms", group: "actionbar", values: [0], answer: "0", reason: "No learned forms without a world seam." },
  { name: "GetShapeshiftFormInfo", group: "actionbar", values: NOTHING, answer: "nil", reason: "No form exists at the requested index." },
  { name: "GetShapeshiftFormCooldown", group: "actionbar", values: [0, 0, 0], answer: "0, 0, 0", reason: "No form is recovering." },
  { name: "GetComboPoints", group: "actionbar", values: [0], answer: "0", reason: "No player or combo-point target without a world seam." },
];

/**
 * Keyboard state and the binding table.
 *
 * 289 calls, almost all of them out of `RestrictedEnvironment.lua`, which builds
 * the modifier string for a secure snippet. A modifier that is nil rather than
 * false is the difference between «not held» and «unknown», and the corpus
 * concatenates the answer.
 */
const BINDINGS: readonly FrameXmlNeutralAnswer[] = [
  {
    name: "IsShiftKeyDown", group: "binding", answer: "either Shift held now",
    reason: "90 calls. The page's modifier tracker (input/Modifiers.ts) is the state; a boot with no "
      + "page — a test's — holds nothing, the old constant false.",
  },
  { name: "IsControlKeyDown", group: "binding", answer: "either Ctrl held now", reason: "90 calls; same tracker." },
  { name: "IsAltKeyDown", group: "binding", answer: "either Alt held now", reason: "90 calls; same tracker." },
  { name: "IsLeftShiftKeyDown", group: "binding", answer: "left Shift held now", reason: "RestrictedEnvironment.lua:159-162 copies the six sided checks at load." },
  { name: "IsRightShiftKeyDown", group: "binding", answer: "right Shift held now", reason: "Same list." },
  { name: "IsLeftControlKeyDown", group: "binding", answer: "left Ctrl held now", reason: "Same list." },
  { name: "IsRightControlKeyDown", group: "binding", answer: "right Ctrl held now", reason: "Same list." },
  { name: "IsLeftAltKeyDown", group: "binding", answer: "left Alt held now", reason: "Same list." },
  { name: "IsRightAltKeyDown", group: "binding", answer: "right Alt held now", reason: "Same list." },
  { name: "IsModifierKeyDown", group: "binding", answer: "any of Shift, Ctrl, Alt held now", reason: "Same list." },
  {
    name: "IsModifiedClick", group: "binding",
    answer: "the action's modified-click binding against the held keys and the click's button",
    reason: "39 static sites: chat links, dress-up, split stacks, mail and loot auto-loot all read it "
      + "(LootFrame.xml:52, MailFrame.xml:172-177). The bindings are Bindings.xml:1325-1340's "
      + "defaults; with no action it answers whether any modifier is held.",
  },
  { name: "GetModifiedClick", group: "binding", answer: "the action's binding string", reason: "InterfaceOptionsPanels.lua:134/362/453 read the auto-loot, self-cast and focus-cast keys." },
  { name: "SetModifiedClick", group: "binding", answer: "rebinds the action for the session", reason: "The same panels' dropdowns write back through it." },
  { name: "GetBindingKey", group: "binding", values: NOTHING, answer: "nil", reason: "19 calls. Nothing is bound, and the client answers nil for an unbound command." },
  { name: "GetNumBindings", group: "binding", values: [0], answer: "0", reason: "The binding list is empty; a count of 0 makes every `for` over it run zero times." },
  { name: "GetBinding", group: "binding", values: NOTHING, answer: "nil", reason: "Behind `GetNumBindings`, which is 0." },
  {
    name: "GetBindingAction", group: "binding", values: [""], answer: '""',
    reason: '12 static sites. The client answers "" for an unbound key, and the corpus compares '
      + "the result with `==` against a command name.",
  },
  {
    name: "GetBindingText", group: "binding", values: [""], answer: '""',
    reason: 'MicroButtonTooltipText concatenates it straight into a tooltip; "" is the client\'s '
      + "answer for a nil key and nil would take the whole tooltip with it.",
  },
  { name: "GetBindingFromClick", group: "binding", values: NOTHING, answer: "nil", reason: "Nothing is bound to a mouse button either." },
  { name: "GetBindingByKey", group: "binding", values: NOTHING, answer: "nil", reason: "Same table, keyed the other way." },
  {
    name: "GetCurrentBindingSet", group: "binding", values: [1], answer: "1",
    reason: "1 is ACCOUNT_BINDINGS, the set a client with no character-specific bindings is on; "
      + "`InterfaceOptionsPanels` puts the dropdown on that entry.",
  },
  { name: "SetBinding", group: "binding", values: [false], answer: "false", reason: "Nothing to write to; false is «the binding was not made»." },
  { name: "SaveBindings", group: "binding", values: NOTHING, answer: "—", reason: "No binding store to save into." },
  { name: "LoadBindings", group: "binding", values: NOTHING, answer: "—", reason: "No binding store to load from." },
];

/**
 * Money and the bags.
 *
 * `MoneyFrame.lua:19` is the second largest failure in the whole census — 55
 * raises of one line, `GetMoney() - GetCursorMoney() - GetPlayerTradeMoney()`,
 * every one of them a nil in an expression with no guard.
 */
const MONEY: readonly FrameXmlNeutralAnswer[] = [
  { name: "GetNumBankSlots", group: "money", values: [0, false], answer: "0, false", reason: "No purchased slots without a player snapshot." },
  {
    name: "GetMoney", group: "money", values: [0], answer: "0",
    reason: "MoneyFrame.lua:19, 55 raises together with GetCursorMoney. 0 copper is what a "
      + "character with no world state has.",
  },
  { name: "GetCursorMoney", group: "money", values: [0], answer: "0", reason: "Same line; nothing is on the cursor." },
  { name: "GetPlayerTradeMoney", group: "money", values: [0], answer: "0", reason: "Same line; no trade window." },
  { name: "GetTargetTradeMoney", group: "money", values: [0], answer: "0", reason: "The other side of the same frame." },
  { name: "GetSendMailMoney", group: "money", values: [0], answer: "0", reason: "MoneyTypeInfo's mail entry, same shape." },
  { name: "GetGuildBankMoney", group: "money", values: [0], answer: "0", reason: "MoneyTypeInfo's guild-bank entry, same shape." },
  { name: "GetContainerNumSlots", group: "money", values: [0], answer: "0", reason: "No bags, so every `for slot = 1, GetContainerNumSlots(bag)` runs zero times." },
  {
    name: "GetContainerNumFreeSlots", group: "money", values: [0, 0], answer: "0, 0",
    reason: "MainMenuBarBagButtons.lua:155 adds the first return into a running total; the second "
      + "is the bag family, and 0 is «normal bag».",
  },
  { name: "GetContainerItemInfo", group: "money", values: NOTHING, answer: "nil", reason: "An empty slot has no item; the caller checks the first return." },
  { name: "GetContainerItemLink", group: "money", values: NOTHING, answer: "nil", reason: "Same." },
  { name: "GetInventoryItemLink", group: "money", values: NOTHING, answer: "nil", reason: "An empty equipment slot has no item link." },
  { name: "GetContainerItemCooldown", group: "money", values: [0, 0, 0], answer: "0, 0, 0", reason: "start, duration, enable — multiplied by the cooldown frame." },
];

/**
 * Chat, channels and voice.
 *
 * Three of these answer nil *on purpose* and the corpus says so itself:
 * `ChatFrame.lua:2294` carries the comment "If PLAYER_ENTERING_WORLD hasn't been
 * called yet, this is nil", which is precisely the state this page is in.
 */
const CHAT: readonly FrameXmlNeutralAnswer[] = [
  {
    name: "BNGetNumFriends", group: "chat", values: [0, 0], answer: "0, 0",
    reason: "FriendsMicroButton:OnLoad:5 adds the Battle.net-online count to the WoW-online count; "
      + "the disconnected client returns the truthful empty tuple 0, 0.",
  },
  {
    name: "GetNumFriends", group: "chat", values: [0, 0], answer: "0, 0",
    reason: "FriendsMicroButton:OnLoad:5 adds the WoW-online count to the Battle.net-online count; "
      + "the disconnected client returns the truthful empty tuple 0, 0.",
  },
  {
    name: "GetNumDisplayChannels", group: "chat", values: [0], answer: "0",
    reason: "ChannelFrame.lua:166, 2 raises — `i <= channelCount` with the count nil.",
  },
  {
    name: "GetNumVoiceSessions", group: "chat", values: [0], answer: "0",
    reason: "ChannelFrame.lua:972 and VoiceChat.lua:253, 4 raises — «'for' limit must be a number».",
  },
  { name: "GetChannelDisplayInfo", group: "chat", values: NOTHING, answer: "nil", reason: "Behind a count of 0." },
  { name: "GetVoiceSessionInfo", group: "chat", values: NOTHING, answer: "nil", reason: "Behind a count of 0." },
  { name: "IsVoiceChatEnabled", group: "chat", values: [false], answer: "false", reason: "No voice server; false is the branch that leaves the UI alone." },
  { name: "IsVoiceChatAllowed", group: "chat", values: [false], answer: "false", reason: "Same." },
  { name: "GetChannelName", group: "chat", values: [0], answer: "0", reason: "0 is the client's «not in that channel»; the corpus compares it with `> 0`." },
  {
    name: "GetDefaultLanguage", group: "chat", values: NOTHING, answer: "nil",
    reason: "30 calls, and the corpus documents the answer itself at ChatFrame.lua:2294: «If "
      + "PLAYER_ENTERING_WORLD hasn't been called yet, this is nil». There is no world, so nil is "
      + "not a gap — it is the state.",
  },
  {
    name: "GetNumLanguages", group: "chat", values: [0], answer: "0",
    reason: "ChatFrame.lua:4356 iterates the language menu and then selects the first entry. "
      + "The neutral client has no language table, so the measured empty count keeps the loop "
      + "typed without inventing a language or label.",
  },
  {
    name: "GetChatTypeIndex", group: "chat", values: NOTHING, answer: "nil",
    reason: "73 calls, all of them ChatFrame.lua:2273 writing `value.id`. The index is a C-side "
      + "enum with no source anywhere in the corpus — ChatTypeInfo is a hash and its `pairs` order "
      + "is not one — so any number here would be invented. Measured: nil raises nothing.",
  },
  {
    name: "GetChatWindowInfo", group: "chat", values: NOTHING, answer: "nil",
    reason: "29 calls, 0 raises. Every field it returns (colour, alpha, docked, shown) is a saved "
      + "setting this client has never had, so answering means inventing a chat layout. Deferred "
      + "with its number rather than guessed — F3, once saved variables exist.",
  },
  { name: "GetChatWindowSavedPosition", group: "chat", values: NOTHING, answer: "nil", reason: "Nothing has been saved." },
  { name: "GetChatWindowSavedDimensions", group: "chat", values: NOTHING, answer: "nil", reason: "Nothing has been saved." },
  { name: "GetChatWindowMessages", group: "chat", values: NOTHING, answer: "nil", reason: "Nothing has been saved." },
  { name: "GetChatWindowChannels", group: "chat", values: NOTHING, answer: "nil", reason: "Nothing has been saved." },
  { name: "LoggingChat", group: "chat", values: [false], answer: "false", reason: "No log file." },
  { name: "LoggingCombat", group: "chat", values: [false], answer: "false", reason: "No log file." },
];

/** Minimap/PvP scalar state for the empty world. */
const MINIMAP_PVP: readonly FrameXmlNeutralAnswer[] = [
  {
    name: "GetNumTitles", group: "unit", values: [0], answer: "0",
    reason: "PaperDollFrame.lua:2604 iterates the known-title list. The neutral world has no title "
      + "rows, so the typed empty count keeps the character sheet's title selector empty.",
  },
  {
    name: "GetNumTrackingTypes", group: "minimap", values: [0], answer: "0",
    reason: "Minimap.lua:429 uses the result as the upper bound of the tracking-type loop. "
      + "The neutral world has no tracking list, so 0 is the typed empty count rather than a "
      + "fabricated tracking entry.",
  },
  {
    name: "GetNetStats", group: "minimap", values: [0, 0, 0], answer: "0, 0, 0",
    reason: "MainMenuMicroButton:OnUpdate:7 compares the third return value with a number while "
      + "rendering the optional latency indicator. The browser seam has no bandwidth/latency C "
      + "API, so a typed zero triple keeps that cosmetic branch safe without inventing world state.",
  },
  {
    name: "GetRestState", group: "actionbar", values: [0, "", 0], answer: "0, \"\", 0",
    reason: "MainMenuBar.lua:317 compares the first return numerically while the neutral world has "
      + "no rested state; 0, empty name, 0 multiplier is the typed no-rest sentinel.",
  },
  {
    name: "GetPreviousArenaSeason", group: "pvp", values: [0], answer: "0",
    reason: "PVPFrame.lua:548 adds one to the previous season while formatting the header. "
      + "The neutral seam has no arena season history; 0 is its documented unavailable-season "
      + "sentinel and keeps the stock arithmetic on the unavailable branch.",
  },
  {
    name: "GetWorldPVPQueueStatus", group: "pvp", values: ["none"], answer: '"none"',
    reason: "BattlefieldFrame.lua:323-357 counts a world-PvP queue whenever `status ~= \"none\"`; "
      + "nothing answered nil, so numberQueues became 1 and MiniMapBattlefieldFrame showed a PvP "
      + "icon with no queue (measured: IsShown()=true at 1748,170). 3.3.5 world-PvP queues are the "
      + "SMSG_BATTLEFIELD_MGR_* family, which this client does not handle, so every slot is empty.",
  },
  {
    name: "CanHearthAndResurrectFromArea", group: "pvp", values: [false], answer: "false",
    reason: "BattlefieldFrame.lua:226 and :352 keep MiniMapBattlefieldFrame shown while this is "
      + "true; it is Wintergrasp's hearth-out offer, which needs the same unhandled "
      + "SMSG_BATTLEFIELD_MGR_* state.",
  },
  {
    name: "GetNumBattlefields", group: "pvp", values: [0], answer: "0",
    reason: "BattlefieldFrame.lua:403 adds 1 for the stock «first available» row — 40 raises of "
      + "arithmetic on nil in the canned census. This client has no battlemaster instance list "
      + "(GetBattlefieldInstanceInfo is unanswered too), so zero instances is the truthful count "
      + "and leaves exactly the «first available» row.",
  },
  {
    name: "GetExpansionLevel", group: "pvp", values: [2], answer: "2",
    reason: "LFDFrame.lua:1 reads it once at file scope (`EXPANSION_LEVEL = GetExpansionLevel()`), "
      + "before any seam is attached, so it must be a load-time constant. 2 is Wrath of the Lich "
      + "King, the only expansion a build-12340 realm runs; GetAccountExpansionLevel answers the "
      + "account's own level separately.",
  },
  {
    name: "GetNumBattlegroundTypes", group: "pvp", values: [0], answer: "0",
    reason: "PVPBattlegroundFrame.lua:62/291 iterates battleground rows; the neutral world has "
      + "no battleground catalog, so zero is the typed empty count.",
  },
  {
    name: "GetPVPRankInfo", group: "pvp", values: ["", 0], answer: "\"\", 0",
    reason: "HonorFrame.lua:51/56 formats the current rank even without a player; empty rank and "
      + "zero number keep the unavailable honor owner renderable without inventing a title.",
  },
];

/** Quest-log metadata without a server-side daily-completion state. */
const QUEST: readonly FrameXmlNeutralAnswer[] = [
  {
    name: "GetDailyQuestsCompleted", group: "quest", values: [0], answer: "0",
    reason: "QuestLogFrame.lua:524 reads this value while sizing the stock quest count. The world "
      + "seam has no authoritative daily-completion field, so 0 is the documented neutral answer "
      + "and avoids fabricating a completed-quest count.",
  },
  { name: "GetNumQuestLogRewards", group: "quest", values: [0], answer: "0", reason: "The canned quest has no authoritative reward rows; 0 keeps QuestInfo_ShowRewards arithmetic typed." },
  { name: "GetNumQuestLogChoices", group: "quest", values: [0], answer: "0", reason: "The canned quest has no authoritative choice rows; 0 keeps QuestInfo_ShowRewards arithmetic typed." },
  { name: "GetQuestLogRewardInfo", group: "quest", values: NOTHING, answer: "nil", reason: "No cached quest reward item is present in the neutral world." },
  { name: "GetQuestLogChoiceInfo", group: "quest", values: NOTHING, answer: "nil", reason: "No cached quest choice item is present in the neutral world." },
  { name: "GetQuestLogRewardSpell", group: "quest", values: NOTHING, answer: "nil", reason: "No spell reward is present in the neutral quest state." },
  { name: "GetQuestLogRewardMoney", group: "quest", values: [0], answer: "0", reason: "No quest reward money is present in the neutral quest state." },
  { name: "GetQuestLogRequiredMoney", group: "quest", values: [0], answer: "0", reason: "No quest required-money field is present in the neutral quest state." },
  { name: "GetQuestLogRewardHonor", group: "quest", values: [0], answer: "0", reason: "No quest reward honor is present in the neutral quest state." },
  { name: "GetQuestLogRewardArenaPoints", group: "quest", values: [0], answer: "0", reason: "No quest reward arena points are present in the neutral quest state." },
  { name: "GetQuestLogRewardTalents", group: "quest", values: [0], answer: "0", reason: "No quest reward talents are present in the neutral quest state." },
  { name: "GetQuestLogRewardXP", group: "quest", values: [0], answer: "0", reason: "No quest reward experience is present in the neutral quest state." },
  { name: "GetQuestLogRewardTitle", group: "quest", values: NOTHING, answer: "nil", reason: "No quest reward title is present in the neutral quest state." },
  { name: "GetNumQuestLogRewardFactions", group: "quest", values: [0], answer: "0", reason: "QuestTemplate does not carry resolved faction reward rows in this client." },
  { name: "GetQuestLogRewardFactionInfo", group: "quest", values: NOTHING, answer: "nil", reason: "QuestTemplate does not carry resolved faction reward rows in this client." },
  {
    name: "GetNumQuestWatches", group: "quest", values: [0], answer: "0",
    reason: "WatchFrame.lua:799 iterates the watched quest list; no neutral quest is watched, so "
      + "zero is the typed empty count.",
  },
];

/**
 * Units and the group.
 *
 * The brief's question for this family was whether `UnitName("player")` has to
 * be synthesised for FrameXML to lay itself out. Measured: **no**. With every
 * unit query nil, the whole unit-frame layer raises twice — `UnitLevel("player")`
 * at `MainMenuBarMicroButtons.lua:39` — and nothing else. So nil stands, the two
 * raises are recorded, and a synthetic self is left to F3, where real world
 * state binds in and the answer stops being a guess.
 */
const UNITS: readonly FrameXmlNeutralAnswer[] = [
  {
    name: "GetUnitHealthModifier", group: "unit", values: [1], answer: "1",
    reason: "PetPaperDollFrame.lua:588-589 multiplies stamina's health contribution by this value even before an owned pet has arrived. The multiplicative identity is the absent-aura baseline; the server's health aura modifier is not in the current update fields, so buffed-pet tooltip gains remain unavailable.",
  },
  {
    name: "GetPetExperience", group: "unit", values: [0, 0], answer: "0, 0",
    reason: "PetPaperDollFrame.lua:629-630 passes both results to a numeric slider even before an owned pet has arrived; absent pet XP has no progress or next-level range. A live pet reads UNIT_FIELD_PETEXPERIENCE and UNIT_FIELD_PETNEXTLEVELEXP instead.",
  },
  {
    name: "GetMirrorTimerInfo", group: "unit", values: ["UNKNOWN"], answer: "UNKNOWN",
    reason: "MirrorTimer.lua:89 explicitly treats UNKNOWN as an inactive timer; an empty world has no breath/fatigue packets.",
  },
  {
    name: "GetMirrorTimerProgress", group: "unit", values: [0], answer: "0",
    reason: "An inactive mirror timer has no remaining milliseconds; the live seam supplies realm progress when present.",
  },
  {
    name: "GetSummonFriendCooldown", group: "unit", values: [0, 0], answer: "0, 0",
    reason: "UnitPopup.lua:264 always adds both values; without an eligible recruit-a-friend relationship there is no summon cooldown.",
  },
  {
    name: "CanSummonFriend", group: "unit", values: [false], answer: "false",
    reason: "This client has no recruit-a-friend relationship state or summon action; keep that menu action unavailable.",
  },
  {
    name: "UnitExists", group: "unit", values: [false], answer: "false",
    reason: "13 calls. false, not nil: `RestrictedEnvironment` concatenates the answer into a "
      + "snippet's state string.",
  },
  {
    name: "UnitName", group: "unit", values: NOTHING, answer: "nil",
    reason: "20 calls. Measured against a synthetic name first: nil costs nothing here, because "
      + "every caller is `GetUnitName`, which already answers nil for a unit that does not exist.",
  },
  { name: "UnitClass", group: "unit", values: NOTHING, answer: "nil", reason: "No unit, so no class token." },
  { name: "UnitRace", group: "unit", values: NOTHING, answer: "nil", reason: "No unit." },
  { name: "UnitSex", group: "unit", values: NOTHING, answer: "nil", reason: "No unit." },
  { name: "UnitGUID", group: "unit", values: NOTHING, answer: "nil", reason: "No unit." },
  {
    name: "UnitLevel", group: "unit", values: NOTHING, answer: "nil",
    reason: "MainMenuBarMicroButtons.lua:39, 2 raises — `playerLevel < TalentMicroButton.minLevel`. "
      + "Kept nil on purpose: a level is world state, and this is the one place in 335 files where "
      + "«there is no player» is visible. F3 territory.",
  },
  {
    name: "UnitPVPRank", group: "unit", values: [0], answer: "0",
    reason: "HonorFrame.lua:51 asks for the current rank before formatting it; rank 0 is the "
      + "client's unavailable/no-rank sentinel for a neutral player.",
  },
  { name: "UnitPVPName", group: "unit", values: NOTHING, answer: "nil", reason: "No unit." },
  { name: "UnitFactionGroup", group: "unit", values: NOTHING, answer: "nil", reason: "No unit; PVPMicroButton reads it and guards." },
  { name: "UnitClassification", group: "unit", values: NOTHING, answer: "nil", reason: "No unit." },
  { name: "UnitCreatureType", group: "unit", values: NOTHING, answer: "nil", reason: "No unit." },
  { name: "UnitCreatureFamily", group: "unit", values: NOTHING, answer: "nil", reason: "No unit." },
  { name: "UnitHealth", group: "unit", values: [0], answer: "0", reason: "The bars call SetValue with it; 0 is an empty bar, nil is an error." },
  { name: "UnitHealthMax", group: "unit", values: [0], answer: "0", reason: "9 calls; SetMinMaxValues(0, 0) is an empty bar." },
  { name: "UnitPower", group: "unit", values: [0], answer: "0", reason: "Same bar, the mana half." },
  { name: "UnitPowerMax", group: "unit", values: [0], answer: "0", reason: "10 calls, same." },
  {
    name: "UnitPowerType", group: "unit", values: [0, "MANA"], answer: "0, \"MANA\"",
    reason: "UnitFrame.lua:191 concatenates the first return into the mana-bar tooltip before the "
      + "nil guard; numeric zero plus the stock MANA token keeps the empty bar typed.",
  },
  {
    name: "GetNumSkillLines", group: "unit", values: [0], answer: "0",
    reason: "SkillFrame.lua:408 compares the skill-row index with this count; the neutral player "
      + "has no skill rows, so zero closes the loop.",
  },
  {
    name: "GetAdjustedSkillPoints", group: "unit", values: [0], answer: "0",
    reason: "SkillFrame.lua reads adjusted points while updating its empty list; zero is the "
      + "typed unavailable skill-point total.",
  },
  {
    name: "GetSpellTabInfo", group: "actionbar", values: ["", "", 0, 0, 0, 0], answer: "\"\", \"\", 0, 0, 0, 0",
    reason: "SpellBookFrame.lua:626 divides the fourth return by page size; an empty spellbook "
      + "has no tab name/texture and zero offsets/counts, keeping tab and page arithmetic typed.",
  },
  { name: "UnitXP", group: "unit", values: [0], answer: "0", reason: "MainMenuBar's experience bar calls SetValue with it." },
  { name: "UnitXPMax", group: "unit", values: [0], answer: "0", reason: "Same bar's maximum." },
  { name: "UnitIsUnit", group: "unit", values: [false], answer: "false", reason: "19 static sites; two units that do not exist are not the same unit." },
  { name: "UnitIsPlayer", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsDead", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsGhost", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsDeadOrGhost", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsCorpse", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsConnected", group: "unit", values: [false], answer: "false", reason: "17 calls; nobody is online." },
  { name: "UnitIsFriend", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsEnemy", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitCanAttack", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitCanAssist", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitCanCooperate", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitPlayerControlled", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsPVP", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsPVPFreeForAll", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsAFK", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsDND", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsSilenced", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsRaidOfficer", group: "unit", values: [false], answer: "false", reason: "No group." },
  { name: "UnitIsPartyLeader", group: "unit", values: [false], answer: "false", reason: "No group." },
  { name: "UnitIsSameServer", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitInParty", group: "unit", values: [false], answer: "false", reason: "No group." },
  { name: "UnitInRaid", group: "unit", values: [false], answer: "false", reason: "No group." },
  { name: "UnitInBattleground", group: "unit", values: [false], answer: "false", reason: "No battleground." },
  { name: "UnitAffectingCombat", group: "unit", values: [false], answer: "false", reason: "No combat." },
  { name: "UnitHasVehicleUI", group: "unit", values: [false], answer: "false", reason: "15 calls out of the secure layer; no vehicle." },
  { name: "UnitInVehicle", group: "unit", values: [false], answer: "false", reason: "No vehicle." },
  { name: "UnitVehicleSkin", group: "unit", values: NOTHING, answer: "nil", reason: "No vehicle art." },
  { name: "UnitHasMana", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitHasRelicSlot", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitIsControlling", group: "unit", values: [false], answer: "false", reason: "No unit." },
  { name: "UnitBuff", group: "unit", values: NOTHING, answer: "nil", reason: "No auras; the corpus stops its loop on the first nil." },
  { name: "UnitDebuff", group: "unit", values: NOTHING, answer: "nil", reason: "Same loop." },
  { name: "UnitAura", group: "unit", values: NOTHING, answer: "nil", reason: "Same loop." },
  { name: "UnitCastingInfo", group: "unit", values: NOTHING, answer: "nil", reason: "Nothing is casting." },
  { name: "UnitChannelInfo", group: "unit", values: NOTHING, answer: "nil", reason: "Nothing is channelling." },
  { name: "UnitThreatSituation", group: "unit", values: NOTHING, answer: "nil", reason: "7 calls; nil is «no threat information», which is the corpus' own hidden branch." },
  { name: "IsThreatWarningEnabled", group: "unit", values: [false], answer: "false", reason: "7 calls, UnitFrame.lua:437." },
  {
    name: "GetNumPartyMembers", group: "unit", values: [0], answer: "0",
    reason: "UnitPopup.lua:459, 12 raises — `GetNumPartyMembers() > 0` compares number with nil.",
  },
  { name: "GetNumRaidMembers", group: "unit", values: [0], answer: "0", reason: "The other half of the same condition." },
  {
    name: "GetNumCompanions", group: "unit", values: [0], answer: "0",
    reason: "PetPaperDollFrame.lua:52 compares the count with 0 to hide the «Питомцы» tab; nil kept tab 2 shown in a host without a seam (the live seam answers the real count).",
  },
  { name: "GetPartyMember", group: "unit", values: NOTHING, answer: "nil", reason: "Behind a count of 0." },
  { name: "GetRaidRosterInfo", group: "unit", values: NOTHING, answer: "nil", reason: "Behind a count of 0." },
  {
    name: "IsInInstance", group: "unit", answer: 'nil, "none"',
    reason: "15 calls, UnitPopup.lua:457 destructures both. The client answers exactly this pair "
      + "outside an instance (Wow.exe 0x5156a0: nil, not false), and the corpus compares the second "
      + "against string literals. In the Lua half: a constant table cannot start with nil.",
  },
  { name: "IsPartyLFG", group: "unit", values: [false], answer: "false", reason: "9 calls; no group finder." },
  { name: "IsInGuild", group: "unit", values: [false], answer: "false", reason: "No guild." },
];

/** The CVar registry, the add-on list — implemented in Lua because they hold state. */
const STATEFUL: readonly FrameXmlNeutralAnswer[] = [
  {
    name: "GetCVar", group: "cvar", answer: "the map, known client defaults, nil when unregistered",
    reason: "255 calls. The stateful map starts with the measured client default "
      + "`lastTalkedToGM = \"\"` and empty PaperDoll category preferences; every other unregistered name remains nil. What the map buys is "
      + "the round trip — `SetCVar(name, v)` then `GetCVar(name)` — which the option panels and "
      + "`PaperDollFrame` both do.",
  },
  { name: "SetCVar", group: "cvar", answer: "writes the map, returns true", reason: "47 static sites; the write is what makes the read honest." },
  { name: "RegisterCVar", group: "cvar", answer: "registers a default", reason: "0 sites in this corpus — kept so an add-on that does register one is answered correctly." },
  {
    name: "GetCVarBool", group: "cvar", answer: 'nil unregistered, else value ~= "0"',
    reason: "473 calls, almost all of them `_ERRORMESSAGE` asking for `scriptErrors`. nil for an "
      + "unregistered name is the client's answer and keeps that branch closed.",
  },
  {
    name: "GetCVarDefault", group: "cvar", answer: "the known or registered default, else nil",
    reason: "181 calls, OptionsPanelTemplates.lua:214; known session defaults are seeded, "
      + "while an unknown name remains nil until RegisterCVar supplies a default.",
  },
  { name: "GetCVarMin", group: "cvar", values: NOTHING, answer: "nil", reason: "83 calls. A range belongs to a registered CVar and there are none; the sliders guard it." },
  {
    name: "GetCVarMax", group: "cvar", values: NOTHING, answer: "nil",
    reason: "83 calls, OptionsPanelTemplates.lua:226 — the other end of the same slider range, "
      + "and unregistered for the same reason.",
  },
  {
    name: "GetNumAddOns", group: "addon", answer: "the modules this TOC glued in",
    reason: "The only add-ons this client has loaded are the server's own modules, and the TOC "
      + "records them itself in `## tsaddon-begin:` markers. Counted from there, not guessed.",
  },
  {
    name: "IsAddOnLoaded", group: "addon", answer: "true for a glued-in module, false otherwise",
    reason: "409 calls, all but a handful from `_ERRORMESSAGE` asking for Blizzard_DebugTools, "
      + "which this corpus genuinely does not contain.",
  },
  {
    name: "LoadAddOn", group: "addon", answer: 'true for a glued-in module, else false, "MISSING"',
    reason: "410 calls. UIParent.lua:238, 2 raises — `_G[\"ADDON_\"..reason]` concatenated a nil "
      + "reason; MISSING is the client's own code for an add-on that is not installed and "
      + "`ADDON_MISSING` is a real GlobalString.",
  },
  { name: "GetAddOnInfo", group: "addon", answer: "name, title, notes, enabled, loadable, reason, security", reason: "MainMenuBar's memory report walks the list by index." },
  { name: "GetAddOnMemoryUsage", group: "addon", answer: "0", reason: "This VM has no per-add-on allocator to ask." },
  { name: "UpdateAddOnMemoryUsage", group: "addon", values: NOTHING, answer: "—", reason: "Nothing to refresh." },
  { name: "GetAddOnDependencies", group: "addon", values: NOTHING, answer: "nil", reason: "A glued-in module has no declared dependencies." },
  { name: "IsAddOnLoadOnDemand", group: "addon", values: [false], answer: "false", reason: "Everything in this TOC is already loaded." },
  { name: "EnableAddOn", group: "addon", values: NOTHING, answer: "—", reason: "No add-on list to enable in." },
  { name: "DisableAddOn", group: "addon", values: NOTHING, answer: "—", reason: "StaticPopup's «disable all and reload» path." },
  { name: "EnableAllAddOns", group: "addon", values: NOTHING, answer: "—", reason: "Same path." },
  { name: "DisableAllAddOns", group: "addon", values: NOTHING, answer: "—", reason: "Same path." },
];

/**
 * Stock options panels also run their OnLoad scripts when the browser cannot
 * provide the corresponding native device or display setting.  These answers
 * are the panels' own unavailable branches, rather than invented hardware.
 */
const CLIENT_OPTIONS: readonly FrameXmlNeutralAnswer[] = [
  {
    name: "Sound_ChatSystem_GetNumInputDrivers", group: "options", values: [0], answer: "0",
    reason: "AudioOptionsPanels.lua:600 iterates the voice capture devices; this client has no voice transport or capture-device owner.",
  },
  {
    name: "Sound_ChatSystem_GetNumOutputDrivers", group: "options", values: [0], answer: "0",
    reason: "AudioOptionsPanels.lua:791 iterates voice playback devices; voice chat is unavailable.",
  },
  {
    name: "VoiceIsDisabledByClient", group: "options", values: [true], answer: "true",
    reason: "The stock voice panel hides its enable switch when the client has no voice implementation.",
  },
  {
    name: "IsVoiceChatAllowedByServer", group: "options", values: [false], answer: "false",
    reason: "No voice session can be established by this browser client; the stock panel leaves the voice category unavailable.",
  },
];

/** Every neutral answer this slice installs, in report order. */
export const FRAMEXML_NEUTRAL_API: readonly FrameXmlNeutralAnswer[] = Object.freeze([
  ...STATEFUL, ...FRAMEXML_GETTEXT_NEUTRAL, ...CLIENT_OPTIONS, ...ACTION_BAR, ...BINDINGS, ...MONEY, ...CHAT, ...QUEST, ...UNITS, ...MINIMAP_PVP,
  ...FRAMEXML_CENSUS_REMAINDER_NEUTRAL,
]);

/** The subset with a constant answer; the rest are the Lua module below. */
export const FRAMEXML_NEUTRAL_CONSTANTS: readonly FrameXmlNeutralAnswer[] = Object.freeze(
  FRAMEXML_NEUTRAL_API.filter((entry) => entry.values !== undefined),
);

/**
 * The client's default modified clicks: Bindings.xml:1325-1340, the `<ModifiedClick>` rows the
 * client loads with its key bindings (that file is not in the TOC). Action → binding.
 */
export const FRAMEXML_MODIFIED_CLICK_DEFAULTS: readonly (readonly [action: string, binding: string])[] = Object.freeze([
  ["SELFCAST", "ALT"], ["FOCUSCAST", "NONE"], ["AUTOLOOTTOGGLE", "SHIFT"], ["MAILAUTOLOOTTOGGLE", "SHIFT"],
  ["STICKYCAMERA", "CTRL"], ["CHATLINK", "SHIFT-BUTTON1"], ["DRESSUP", "CTRL-BUTTON1"],
  ["SOCKETITEM", "SHIFT-BUTTON2"], ["SPLITSTACK", "SHIFT"], ["PICKUPACTION", "SHIFT"],
  ["COMPAREITEMS", "SHIFT"], ["OPENALLBAGS", "SHIFT"], ["QUESTWATCHTOGGLE", "SHIFT"],
  ["TOKENWATCHTOGGLE", "SHIFT"], ["SHOWITEMFLYOUT", "ALT"], ["SHOWMULTICASTFLYOUT", "ALT"],
] as const);

const MODIFIED_CLICK_LUA = `{ ${FRAMEXML_MODIFIED_CLICK_DEFAULTS
  .map(([action, binding]) => `{ "${action}", "${binding}" }`).join(", ")} }`;

/**
 * The stateful half, in Lua.
 *
 * It writes into `__fxNeutralImpl`, which the boot prelude created and captured,
 * so the `_G` metamethod picks these up on first touch exactly like a constant
 * one — same counter, same first-touch traceback, same line in the census. The
 * host hands in only data: the module names the TOC recorded, and the held
 * modifiers through `__fxModifierState`.
 */
export const FRAMEXML_NEUTRAL_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local type, tostring, lower = type, tostring, string.lower

  ---------------------------------------------------------------- CVars
  -- One map, two views: what a CVar currently is, and what it was registered
  -- with. PaperDollFrame_OnEvent(VARIABLES_LOADED) explicitly tests the empty
  -- category preferences, then chooses its class-specific right-hand stats.
  -- nil would silently skip that initialization and leave both panels blank.
  -- Keep the seed narrow: unknown names still remain nil.
  local values = {
    lasttalkedtogm = "", playerstatleftdropdown = "", playerstatrightdropdown = "",
    -- InterfaceOptionsFrame.lua's own uvarInfo declares these three defaults.
    targetoftargetmode = "5", displayworldpvpobjectives = "2", combattextfloatmode = "1",
    -- 05.10-3.21 review: uvarInfo's QUEST_FADING_DISABLE default. Unset, the Objectives panel's
    -- «Мгновенное отображение полного текста» box set the uvar to nil at PLAYER_ENTERING_WORLD
    -- (BlizzardOptionsPanel_SetupControl), and QuestInfo/QuestFrame compare it with "0"/"1".
    questfadingdisable = "0",
    -- The client default: action and bag tooltips go to GameTooltip_SetDefaultAnchor (the
    -- bottom-right corner) instead of covering the bar they were opened from.
    ubertooltips = "1",
    -- Stock chat Lua consumes these selections itself. chatStyle stays read-only below: the
    -- stock edit box is owned now (FrameXmlChatApi.ts installFrameXmlStockChat), but switching
    -- to «im» was never checked against it, and chat is outside the work plan since 29.09.
    chatstyle = "classic", showtimestamps = "none",
    -- The client's own threat defaults: warn always (the four OPTION_TOOLTIP_AGGRO_WARNING_DISPLAY
    -- rows, InterfaceOptionsPanels.lua:690), no numeric percentage. Both are real options here:
    -- IsThreatWarningEnabled (FrameXmlThreat.ts) and UnitFrame.lua's ShowNumericThreat read them.
    threatwarning = "3", threatshownumeric = "0",
    -- Wow.exe registers previewTalents with "0" (0x51d9b0); the talent preview reads it (3.33).
    previewtalents = "0",
    -- Inactive facilities still need typed values for their dropdown OnLoad.
    conversationmode = "inline", camerasmoothstyle = "0",
    camerasmoothtrackingstyle = "0", voicechatmode = "0", basemip = "0",
    -- WorldMapFrame's own defaults. VARIABLES_LOADED reads worldMapOpacity through tonumber()
    -- and WorldMapFrame_SetOpacity(nil) then failed at WorldMapFrame.lua:2139, closing the map
    -- on the size-down button; questPOI unset left the objectives checkbox unchecked and
    -- showBattlefieldMinimap unset left WorldMapZoneMinimapDropDown's text empty.
    worldmapopacity = "0", miniworldmap = "0", questpoi = "1", advancedworldmap = "0",
    showbattlefieldminimap = "1",
    -- InterfaceOptionsFrame.lua:322-323's defaults; a live mount answers both from the settings
    -- rows (FrameXmlSettingsCVar.ts) before this map.
    lootundermouse = "0", autolootdefault = "0",
    -- Blizzard_TimeManager's clock and alarm (blizzard_timemanager.lua:91-92 reads alarmTime
    -- unguarded). The client ships 12-hour time for enUS; a ruRU player reads 24-hour clocks,
    -- so the military-time switch starts on here and only an enUS locale turns it back off
    -- below. Both remain ordinary SetCVar round-trips.
    showclock = "1", timemgralarmtime = "0", timemgralarmmessage = "",
    timemgralarmenabled = "0", timemgruselocaltime = "0", timemgrusemilitarytime = "1",
  }
  local defaults = {}
  for key, value in pairs(values) do defaults[key] = value end
  -- These are observations of the current browser client, not settings that
  -- the original options panel can change: voice chat is absent, and textures
  -- are loaded from their full base level.  The latter lets the stock texture
  -- slider compute its display value without claiming SetCVar can resize art.
  local readOnly = {
    conversationmode = true, camerasmoothstyle = true,
    camerasmoothtrackingstyle = true, combattextfloatmode = true, chatstyle = true,
    voicechatmode = true, basemip = true,
  }
  if type(__fxLocale) == "string" and __fxLocale ~= "" then
    values.locale = __fxLocale
    defaults.locale = __fxLocale
    readOnly.locale = true
    if __fxLocale == "enUS" then
      values.timemgrusemilitarytime = "0"
      defaults.timemgrusemilitarytime = "0"
    end
  end
  if __fxBrowserAudioOutput then
    -- Web Audio plays through the browser-selected default destination. It
    -- does not expose a list of native output drivers to this client.
    values.sound_outputdriverindex = "0"
    defaults.sound_outputdriverindex = "0"
    readOnly.sound_outputdriverindex = true
  end
  __fxCVarValues, __fxCVarDefaults = values, defaults
  -- FrameXmlCVarPersistence.ts: no CVAR_UPDATE and nothing kept for these (3.19).
  __fxCVarReadOnly = readOnly

  local function cvarKey(name)
    if type(name) ~= "string" or name == "" then return nil end
    return lower(name)
  end

  impl.RegisterCVar = function(name, value)
    local key = cvarKey(name)
    if key == nil or readOnly[key] then return end
    local text = value == nil and "" or tostring(value)
    if defaults[key] == nil then defaults[key] = text end
    if values[key] == nil then values[key] = text end
  end
  impl.SetCVar = function(name, value)
    local key = cvarKey(name)
    if key == nil or readOnly[key] then return false end
    values[key] = value == nil and "" or tostring(value)
    return true
  end
  -- The two stat-panel choices, while the player has not picked one, answer what
  -- PaperDollFrame_OnEvent(VARIABLES_LOADED) would have chosen for the class — at read
  -- time. That handler runs strupper(select(2, UnitClass("player"))), and a mount that
  -- boots before the server has sent the player's own object gets nil there: the handler
  -- stopped on it and both panels stayed blank for the session. Asked again once the
  -- class is known (every UpdatePaperdollStats reads these), the answer is the class's.
  local statPanels = { playerstatleftdropdown = true, playerstatrightdropdown = true }
  local function statPanelDefault(key)
    if key == "playerstatleftdropdown" then return "PLAYERSTAT_BASE_STATS" end
    local getClass = rawget(_G, "UnitClass")
    local _, classFile = nil, nil
    if type(getClass) == "function" then _, classFile = getClass("player") end
    classFile = type(classFile) == "string" and string.upper(classFile) or ""
    if classFile == "MAGE" or classFile == "PRIEST" or classFile == "WARLOCK" or classFile == "DRUID" then
      return "PLAYERSTAT_SPELL_COMBAT"
    elseif classFile == "HUNTER" then
      return "PLAYERSTAT_RANGED_COMBAT"
    end
    return "PLAYERSTAT_MELEE_COMBAT"
  end
  local function cvarValue(key)
    local text = values[key]
    if text == "" and statPanels[key] then return statPanelDefault(key) end
    return text
  end
  impl.GetCVar = function(name)
    local key = cvarKey(name)
    return key and cvarValue(key)
  end
  impl.GetCVarBool = function(name)
    local key = cvarKey(name)
    if key == nil then return nil end
    local text = cvarValue(key)
    if text == nil then return nil end
    return text ~= "0" and text ~= ""
  end
  impl.GetCVarDefault = function(name)
    local key = cvarKey(name)
    return key and defaults[key]
  end

  ---------------------------------------------------------------- Modifiers
  -- What is held now and the current click's button, from the page's tracker (input/Modifiers.ts)
  -- through the boot's __fxModifierState: left/right Shift, Ctrl, Alt, then the button (1 left,
  -- 2 right, 3 middle; 0 before any click). A boot with no page holds nothing.
  local modifierState = __fxModifierState
  local function held()
    if type(modifierState) ~= "function" then return false, false, false, false, false, false, 0 end
    return modifierState()
  end
  local function anyHeld()
    local ls, rs, lc, rc, la, ra = held()
    return ls or rs or lc or rc or la or ra
  end
  impl.IsShiftKeyDown = function() local ls, rs = held() return ls or rs end
  impl.IsControlKeyDown = function() local _, _, lc, rc = held() return lc or rc end
  impl.IsAltKeyDown = function() local _, _, _, _, la, ra = held() return la or ra end
  impl.IsLeftShiftKeyDown = function() return (held()) end
  impl.IsRightShiftKeyDown = function() return (select(2, held())) end
  impl.IsLeftControlKeyDown = function() return (select(3, held())) end
  impl.IsRightControlKeyDown = function() return (select(4, held())) end
  impl.IsLeftAltKeyDown = function() return (select(5, held())) end
  impl.IsRightAltKeyDown = function() return (select(6, held())) end
  impl.IsModifierKeyDown = anyHeld

  -- Bindings.xml's defaults; SetModifiedClick rebinds for the session (there is no binding store
  -- for SaveBindings). A binding holds exactly its modifiers — SHIFT is either Shift with neither
  -- Ctrl nor Alt, LSHIFT only the left one — as a key chord does (Bindings.ts chordOf), so
  -- Ctrl+Shift+click is neither CHATLINK nor DRESSUP; BUTTONn names the click's button.
  local clicks = {}
  for _, row in ipairs(${MODIFIED_CLICK_LUA}) do clicks[row[1]] = row[2] end
  local upper, gmatch, match = string.upper, string.gmatch, string.match
  local function side(want, left, right)
    if want == nil then return not left and not right end
    if want == "L" then return left end
    if want == "R" then return right end
    return left or right
  end
  local function clicked(binding)
    if type(binding) ~= "string" or binding == "" or upper(binding) == "NONE" then return false end
    local shift, ctrl, alt, button
    for token in gmatch(upper(binding), "[^%-]+") do
      local sided, key = match(token, "^([LR]?)(%u+)$")
      local want = sided ~= "" and sided or "*"
      if key == "SHIFT" then shift = want
      elseif key == "CTRL" then ctrl = want
      elseif key == "ALT" then alt = want
      else
        local number = match(token, "^BUTTON(%d+)$")
        if not number then return false end
        button = tonumber(number)
      end
    end
    local ls, rs, lc, rc, la, ra, current = held()
    return side(shift, ls, rs) and side(ctrl, lc, rc) and side(alt, la, ra)
      and (button == nil or button == current)
  end
  impl.IsModifiedClick = function(action)
    if action == nil then return anyHeld() end
    return clicked(clicks[action])
  end
  impl.GetModifiedClick = function(action) return clicks[action] end
  impl.SetModifiedClick = function(action, binding)
    if type(action) == "string" and type(binding) == "string" then clicks[action] = binding end
  end

  ---------------------------------------------------------------- AddOns
  -- The add-ons this client has are the server's own modules, and the TOC is the
  -- record of which ones it glued into itself. Everything else is absent, which
  -- is why LoadAddOn("Blizzard_DebugTools") answers false, "MISSING" rather than
  -- nothing: the corpus reads the reason and looks up ADDON_MISSING by name.
  local order = __fxAddonModules or {}
  local byName = {}
  for index = 1, #order do byName[lower(order[index])] = index end

  local function find(key)
    if type(key) == "number" then
      local name = order[key]
      if name == nil then return nil end
      return name, key
    end
    if type(key) ~= "string" then return nil end
    local index = byName[lower(key)]
    if index == nil then return nil end
    return order[index], index
  end

  impl.GetNumAddOns = function() return #order end
  impl.IsAddOnLoaded = function(key)
    if find(key) == nil then return false end
    -- loaded, finished: a module glued into the TOC ran to completion with it.
    return true, true
  end
  impl.LoadAddOn = function(key)
    if find(key) == nil then return false, "MISSING" end
    return true
  end
  impl.GetAddOnInfo = function(key)
    local name = find(key)
    if name == nil then return nil end
    -- name, title, notes, enabled, loadable, reason, security
    return name, name, "", true, true, nil, "INSECURE"
  end
  impl.GetAddOnMemoryUsage = function() return 0 end

  ---------------------------------------------------------------- IsInInstance
  -- A leading nil cannot ride the constant table (its length would be the border before it).
  impl.IsInInstance = function() return nil, "none" end
end
${FRAMEXML_GETTEXT_PRELUDE}`;
