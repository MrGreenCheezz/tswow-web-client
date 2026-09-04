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

export type FrameXmlApiGroup =
  | "cvar" | "addon" | "actionbar" | "binding" | "money" | "chat" | "unit" | "quest"
  | "minimap" | "pvp";

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
  { name: "IsShiftKeyDown", group: "binding", values: [false], answer: "false", reason: "90 calls; nothing is held on a page nobody is typing into." },
  { name: "IsControlKeyDown", group: "binding", values: [false], answer: "false", reason: "90 calls." },
  { name: "IsAltKeyDown", group: "binding", values: [false], answer: "false", reason: "90 calls." },
  { name: "IsModifiedClick", group: "binding", values: [false], answer: "false", reason: "39 static sites; a modified click needs a binding, and none is registered." },
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
  { name: "GetPartyMember", group: "unit", values: NOTHING, answer: "nil", reason: "Behind a count of 0." },
  { name: "GetRaidRosterInfo", group: "unit", values: NOTHING, answer: "nil", reason: "Behind a count of 0." },
  {
    name: "IsInInstance", group: "unit", values: [false, "none"], answer: 'false, "none"',
    reason: "15 calls, UnitPopup.lua:457 destructures both. The client answers exactly this pair "
      + "outside an instance, and the corpus compares the second against string literals.",
  },
  { name: "IsPartyLFG", group: "unit", values: [false], answer: "false", reason: "9 calls; no group finder." },
  { name: "IsInGuild", group: "unit", values: [false], answer: "false", reason: "No guild." },
];

/** The CVar registry, the add-on list — implemented in Lua because they hold state. */
const STATEFUL: readonly FrameXmlNeutralAnswer[] = [
  {
    name: "GetCVar", group: "cvar", answer: "the map, known client defaults, nil when unregistered",
    reason: "255 calls. The stateful map starts with the measured client default "
      + "`lastTalkedToGM = \"\"`; every other unregistered name remains nil. What the map buys is "
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
    reason: "181 calls, OptionsPanelTemplates.lua:214; the measured `lastTalkedToGM` default is "
      + "seeded, while an unknown name remains nil until RegisterCVar supplies a default.",
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

/** Every neutral answer this slice installs, in report order. */
export const FRAMEXML_NEUTRAL_API: readonly FrameXmlNeutralAnswer[] = Object.freeze([
  ...STATEFUL, ...ACTION_BAR, ...BINDINGS, ...MONEY, ...CHAT, ...QUEST, ...UNITS, ...MINIMAP_PVP,
]);

/** The subset with a constant answer; the rest are the Lua module below. */
export const FRAMEXML_NEUTRAL_CONSTANTS: readonly FrameXmlNeutralAnswer[] = Object.freeze(
  FRAMEXML_NEUTRAL_API.filter((entry) => entry.values !== undefined),
);

/**
 * The stateful half, in Lua.
 *
 * It writes into `__fxNeutralImpl`, which the boot prelude created and captured,
 * so the `_G` metamethod picks these up on first touch exactly like a constant
 * one — same counter, same first-touch traceback, same line in the census. The
 * host hands in only data: the module names the TOC recorded.
 */
export const FRAMEXML_NEUTRAL_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local type, tostring, lower = type, tostring, string.lower

  ---------------------------------------------------------------- CVars
  -- One map, two views: what a CVar currently is, and what it was registered
  -- with. The real client publishes this known session default before FrameXML
  -- enters PLAYER_ENTERING_WORLD. Keep the seed narrow: unknown names remain
  -- nil instead of becoming a table of plausible values nobody measured.
  local values = { lastTalkedToGM = "" }
  local defaults = { lastTalkedToGM = "" }
  __fxCVarValues, __fxCVarDefaults = values, defaults

  impl.RegisterCVar = function(name, value)
    if type(name) ~= "string" or name == "" then return end
    local text = value == nil and "" or tostring(value)
    if defaults[name] == nil then defaults[name] = text end
    if values[name] == nil then values[name] = text end
  end
  impl.SetCVar = function(name, value)
    if type(name) ~= "string" or name == "" then return false end
    values[name] = value == nil and "" or tostring(value)
    return true
  end
  impl.GetCVar = function(name)
    if type(name) ~= "string" then return nil end
    return values[name]
  end
  impl.GetCVarBool = function(name)
    if type(name) ~= "string" then return nil end
    local text = values[name]
    if text == nil then return nil end
    return text ~= "0" and text ~= ""
  end
  impl.GetCVarDefault = function(name)
    if type(name) ~= "string" then return nil end
    return defaults[name]
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
end
`;
