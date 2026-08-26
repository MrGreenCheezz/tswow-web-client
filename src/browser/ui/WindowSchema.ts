/**
 * The window definition format: what a module's `content/ui/*.json` may say, and what it means.
 *
 * The format is not invented here. A sibling content-studio checkout — the owner's authoring tool
 * — already writes these files, and its live example
 * the active test module's `content/ui/proverochnyy-ekran.json` (18 August) is the
 * acceptance fixture: it parses with zero problems, unchanged. The vocabulary below is therefore
 * *read from* `shared/ui-model.mjs` rather than paraphrased, and every table cites the line it came
 * from — twelve widget types (`:221-270`), nine anchor points (`:9`), eight stratas (`:15`), five
 * layers (`:16`), eighteen font objects (`:19-38`), nine backdrops (`:49-94`), twelve named
 * bindings (`:152-165`), eighteen conditions (`:168-187`) times four effects (`:188-193`),
 * twenty-one events (`:196-218`) and nine button actions (`:139-149`). When one of those tables
 * changes in the studio, the diff here is a line, not a design.
 *
 * The additions this client makes are all optional, so nothing the studio writes today needs
 * touching: `bind: "{expr}"`, `repeat`, `slot`, `messages`, `state`, `css`, `binding`, `format`,
 * and an action *list* in the `{do: …}` spelling of the plan's B.5 beside the studio's flat
 * `{type: …}` pair. The studio's nine button actions map onto that list one for one, except
 * `custom` — "your own Lua handler" — which is refused by name, because this client has no Lua and
 * an action that silently does nothing is worse for the author than a sentence saying why.
 *
 * ## What refuses the window and what only loses a widget
 *
 * A parse gives back either a whole window or none: there is no half-built window, because the
 * caller (М6's loader) registers what it gets, and a screen missing the frame everything anchors to
 * is a pile of widgets in the top-left corner.
 *
 * * **Fatal — no window comes back.** The file is not a window (`kind`, `id`, `format`, a missing
 *   or non-`Frame` root), two widgets share an id, an anchor names something that is not its parent
 *   or an earlier sibling, or a message schema is unsound. Each of those makes the *whole* tree
 *   ambiguous: a duplicate id makes "which widget does this anchor mean" unanswerable, and a
 *   message with a hole in it decodes every later field from the wrong offset (`CustomCodec.ts`).
 *   The same level catches a fault in the **root frame** or in the window's own fields — its
 *   `title`, an action on one of its `events`, its `name`, a starting value under `params.state` —
 *   because the rule below is "drop the widget that holds it" and there is nothing smaller to drop
 *   than the root.
 * * **The widget is dropped, named, and the window still loads.** An unknown widget type, a widget
 *   whose own fields are the wrong shape, an expression that does not parse — including one inside
 *   one of its actions, because a button that is drawn and can never do anything is harder to
 *   notice than a button that is not there. One broken row of a list is not a reason to hide the
 *   whole window from the player. A widget anchored to one that was dropped is named too, and
 *   falls back to its parent.
 * * **Noted, and the window loads unchanged.** An unknown binding, condition, effect, font,
 *   backdrop, strata, layer or model unit name falls back to the studio's own default; a `custom`
 *   action is dropped from the list; an opcode outside `1..0xffff` falls back to the screen's own;
 *   a character a slash command cannot carry is stripped and the kept spelling is quoted. М9's
 *   `modules:check` turns *any* recorded problem into a build failure, so "noted" means "the player
 *   still gets a window and the author still gets told".
 */

import {
  parseCustomMessages,
  type CustomFieldType,
  type CustomMessage,
} from "../../world/CustomCodec.js";
import {
  isExpressionSource,
  literalNode,
  parseExpression,
  parseTemplate,
  pathNode,
  type BinaryOperator,
  type ExpressionFunction,
  type ExprNode,
} from "./WindowExpression.js";

/* ---------------------------------------------------------------------------------------------
 * The studio's vocabulary, read from shared/ui-model.mjs
 * ------------------------------------------------------------------------------------------- */

/** `ui-model.mjs:9`. WoW's own nine, and the studio uses the client's spelling. */
export const ANCHOR_POINTS = [
  "TOPLEFT", "TOP", "TOPRIGHT", "LEFT", "CENTER", "RIGHT", "BOTTOMLEFT", "BOTTOM", "BOTTOMRIGHT",
] as const;
export type AnchorPoint = (typeof ANCHOR_POINTS)[number];

/** `ui-model.mjs:15`. М5 maps these onto the z-index bands `GameWindows.ts` already uses. */
export const STRATAS = [
  "BACKGROUND", "LOW", "MEDIUM", "HIGH", "DIALOG", "FULLSCREEN", "FULLSCREEN_DIALOG", "TOOLTIP",
] as const;
export type StrataName = (typeof STRATAS)[number];

/** `ui-model.mjs:16`. Sibling ordering inside one frame, not a separate surface. */
export const LAYERS = ["BACKGROUND", "BORDER", "ARTWORK", "OVERLAY", "HIGHLIGHT"] as const;
export type LayerName = (typeof LAYERS)[number];

/** `ui-model.mjs:221-270`, in the studio's declaration order. */
export const WIDGET_TYPES = [
  "Frame", "Texture", "Text", "Button", "CheckButton", "EditBox",
  "StatusBar", "Slider", "ScrollFrame", "ItemButton", "DropDown", "Model",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** Which of the twelve may hold children (`ui-model.mjs:222`, `:255`). */
const CONTAINER_TYPES: ReadonlySet<string> = new Set(["Frame", "ScrollFrame"]);

export interface FontObject {
  readonly name: string;
  readonly size: number;
  /** The studio's preview colour, 0..1 per channel (`ui-model.mjs:19-38`). */
  readonly color: readonly [number, number, number];
  readonly font: keyof typeof FONT_FILES;
}

/**
 * `ui-model.mjs:19-38` — the client's own eighteen font objects, with the size and colour the
 * studio previews them at. Carried whole rather than as bare names because М5 has to turn each
 * into CSS and this is the measurement, not a guess.
 */
export const FONT_OBJECTS: readonly FontObject[] = [
  { name: "GameFontNormal", size: 12, color: [1, 0.82, 0], font: "FRIZQT" },
  { name: "GameFontHighlight", size: 12, color: [1, 1, 1], font: "FRIZQT" },
  { name: "GameFontDisable", size: 12, color: [0.5, 0.5, 0.5], font: "FRIZQT" },
  { name: "GameFontGreen", size: 12, color: [0.1, 1, 0.1], font: "FRIZQT" },
  { name: "GameFontRed", size: 12, color: [1, 0.1, 0.1], font: "FRIZQT" },
  { name: "GameFontNormalSmall", size: 10, color: [1, 0.82, 0], font: "FRIZQT" },
  { name: "GameFontHighlightSmall", size: 10, color: [1, 1, 1], font: "FRIZQT" },
  { name: "GameFontDisableSmall", size: 10, color: [0.5, 0.5, 0.5], font: "FRIZQT" },
  { name: "GameFontNormalLarge", size: 16, color: [1, 0.82, 0], font: "FRIZQT" },
  { name: "GameFontHighlightLarge", size: 16, color: [1, 1, 1], font: "FRIZQT" },
  { name: "GameFontNormalHuge", size: 20, color: [1, 0.82, 0], font: "FRIZQT" },
  { name: "NumberFontNormal", size: 14, color: [1, 1, 1], font: "ARIALN" },
  { name: "NumberFontNormalSmall", size: 12, color: [1, 1, 1], font: "ARIALN" },
  { name: "GameTooltipText", size: 12, color: [1, 1, 1], font: "FRIZQT" },
  { name: "GameTooltipHeaderText", size: 14, color: [1, 1, 1], font: "FRIZQT" },
  { name: "QuestFontNormalSmall", size: 12, color: [0.19, 0.12, 0.05], font: "FRIZQT" },
  { name: "QuestTitleFont", size: 18, color: [0, 0, 0], font: "MORPHEUS" },
  { name: "SystemFont_Shadow_Med1", size: 12, color: [1, 1, 1], font: "FRIZQT" },
];

/**
 * The font names a definition may write: the eighteen above, and `ChatFontNormal`.
 *
 * The nineteenth is not an invention. `ui-model.mjs:245` gives every EditBox `font:
 * "ChatFontNormal"` by default, and `ui-model.mjs:19-38` — the list the studio's own font menu is
 * built from (`web/designer.mjs:785`) — does not contain it. It is a real client font object all
 * the same: the addon generator passes whatever the field holds straight to `SetFontObject`
 * (`addon.mjs:342`), where the *client* resolves it. So refusing it would refuse every input box
 * the studio has ever saved, and leaving the field unchecked would let `GameFontNromal` reach М5
 * untouched. Both halves of that pair are deliberate.
 */
export const WINDOW_FONT_NAMES: readonly string[] = [
  ...FONT_OBJECTS.map((font) => font.name),
  "ChatFontNormal",
];

/** `ui-model.mjs:41-46`. The Cyrillic variant is second, and it is the one this realm needs. */
export const FONT_FILES = {
  FRIZQT: ["Fonts\\FRIZQT__.TTF", "Fonts\\FRIZQT___CYR.TTF"],
  ARIALN: ["Fonts\\ARIALN.TTF"],
  MORPHEUS: ["Fonts\\MORPHEUS.TTF", "Fonts\\MORPHEUS_CYR.TTF"],
  SKURRI: ["Fonts\\skurri.TTF", "Fonts\\SKURRI_CYR.TTF"],
} as const;

export interface BackdropInsets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface BackdropPreset {
  readonly name: string;
  readonly bgFile: string;
  readonly edgeFile: string;
  readonly tile: boolean;
  readonly tileSize: number;
  readonly edgeSize: number;
  readonly insets: BackdropInsets;
}

const NO_INSETS: BackdropInsets = { left: 0, right: 0, top: 0, bottom: 0 };
const DIALOG_INSETS: BackdropInsets = { left: 11, right: 12, top: 12, bottom: 11 };
const TOOLTIP_INSETS: BackdropInsets = { left: 4, right: 4, top: 4, bottom: 4 };

/**
 * `ui-model.mjs:49-94` — the nine `SetBackdrop` presets, with the texture paths the client ships.
 *
 * `custom` keeps its place in the list because the studio offers it; a definition choosing it also
 * carries `backdropCustom`, which is read below.
 */
export const BACKDROP_PRESETS: readonly BackdropPreset[] = [
  { name: "none", bgFile: "", edgeFile: "", tile: false, tileSize: 0, edgeSize: 0, insets: NO_INSETS },
  {
    name: "dialog",
    bgFile: "Interface\\DialogFrame\\UI-DialogBox-Background",
    edgeFile: "Interface\\DialogFrame\\UI-DialogBox-Border",
    tile: true, tileSize: 32, edgeSize: 32, insets: DIALOG_INSETS,
  },
  {
    name: "dialogGold",
    bgFile: "Interface\\DialogFrame\\UI-DialogBox-Gold-Background",
    edgeFile: "Interface\\DialogFrame\\UI-DialogBox-Gold-Border",
    tile: true, tileSize: 32, edgeSize: 32, insets: DIALOG_INSETS,
  },
  {
    name: "tooltip",
    bgFile: "Interface\\Tooltips\\UI-Tooltip-Background",
    edgeFile: "Interface\\Tooltips\\UI-Tooltip-Border",
    tile: true, tileSize: 16, edgeSize: 16, insets: TOOLTIP_INSETS,
  },
  {
    name: "tooltipThin",
    bgFile: "Interface\\Tooltips\\UI-Tooltip-Background",
    edgeFile: "Interface\\Tooltips\\UI-Tooltip-Border",
    tile: true, tileSize: 16, edgeSize: 12, insets: { left: 3, right: 3, top: 3, bottom: 3 },
  },
  {
    name: "parchment",
    bgFile: "Interface\\AchievementFrame\\UI-Achievement-Parchment-Horizontal",
    edgeFile: "Interface\\DialogFrame\\UI-DialogBox-Border",
    tile: false, tileSize: 0, edgeSize: 32, insets: DIALOG_INSETS,
  },
  {
    name: "chat",
    bgFile: "Interface\\ChatFrame\\ChatFrameBackground",
    edgeFile: "Interface\\Tooltips\\UI-Tooltip-Border",
    tile: true, tileSize: 16, edgeSize: 16, insets: TOOLTIP_INSETS,
  },
  {
    name: "solid",
    bgFile: "Interface\\ChatFrame\\ChatFrameBackground",
    edgeFile: "",
    tile: true, tileSize: 16, edgeSize: 0, insets: NO_INSETS,
  },
  {
    name: "custom",
    bgFile: "", edgeFile: "",
    tile: true, tileSize: 32, edgeSize: 32, insets: { left: 8, right: 8, top: 8, bottom: 8 },
  },
];

/** `ui-model.mjs:97-104`. Not validated — the studio allows "custom" and any inherited template. */
export const BUTTON_TEMPLATES = [
  "UIPanelButtonTemplate", "UIPanelButtonTemplate2", "OptionsButtonTemplate",
  "GameMenuButtonTemplate", "UIPanelCloseButton", "custom",
] as const;

/** `ui-model.mjs:196-218` — the twenty-one game events the studio offers on a screen. */
export const WINDOW_EVENTS = [
  "PLAYER_ENTERING_WORLD", "PLAYER_LOGIN", "PLAYER_TARGET_CHANGED", "PLAYER_REGEN_DISABLED",
  "PLAYER_REGEN_ENABLED", "PLAYER_LEVEL_UP", "PLAYER_MONEY", "PLAYER_XP_UPDATE", "UNIT_HEALTH",
  "UNIT_AURA", "BAG_UPDATE", "ZONE_CHANGED_NEW_AREA", "CHAT_MSG_SAY", "CHAT_MSG_WHISPER",
  "QUEST_ACCEPTED", "QUEST_LOG_UPDATE", "LOOT_OPENED", "MERCHANT_SHOW", "GOSSIP_SHOW",
  "SPELL_UPDATE_COOLDOWN", "UPDATE_MOUSEOVER_UNIT",
] as const;

/** `ui-model.mjs:139-149` — the nine actions a button may carry without any code. */
export const STUDIO_BUTTON_ACTIONS = [
  "custom", "close", "toggleWidget", "showScreen", "chat", "castSpell", "useItem", "macro", "sendPacket",
] as const;
export type StudioButtonAction = (typeof STUDIO_BUTTON_ACTIONS)[number];

/**
 * The roots of the published game-state view an expression may read.
 *
 * Written down here rather than in М6 because it is the *contract* the tables below depend on: the
 * eighteen conditions and twelve bindings compile to paths under these roots, and the test walks
 * them to prove no table entry names a view nobody publishes. М6 fills them in.
 */
export const WINDOW_STATE_ROOTS = [
  "player", "target", "focus", "pet", "party", "raid", "boss", "arena",
  "bag", "quest", "aura", "msg", "state", "setting", "world",
  /**
   * The slot a patch's widget was drawn into (М7), which the renderer folds in rather than the view.
   *
   * `slot.name` and whatever the built-in declared beside it: `slot.questId` on a quest card,
   * `slot.bag` on a bag window. It is a root like `state` — supplied where the subtree is built and
   * absent from `buildWindowSnapshot`, which is why a widget outside a slot reads it as blank.
   */
  "slot",
] as const;

/**
 * Commands an action may name.
 *
 * An explicit table, never reflection: `WorldClient` has 275 public methods and `close()` and
 * `deleteCharacter` are two of them. М6 binds each name to an implementation and asserts at test
 * time that it exists, so a rename disarms the build rather than one module.
 *
 * Counted on this machine against the built client: 277 own properties on the prototype, of which
 * 275 are methods, one is a getter and one is the constructor. М4 wrote 267 here from an earlier
 * build; М6's table is what made the number worth taking again.
 *
 * `castSpellByName` and `useItemByName` are here because the studio's `castSpell`/`useItem` button
 * actions carry a spell or item *name* typed by a designer, not an id.
 */
export const WINDOW_COMMANDS = [
  "castSpell", "castSpellByName", "cancelAura", "selectTarget", "setFocus", "startAttack",
  "stopAttack", "interact", "useItem", "useItemByName", "equipItem", "destroyItem", "sellItem",
  "buyFromVendor", "acceptQuest", "abandonQuest", "chooseQuestReward", "openVendor", "openTrainer",
  "openBank", "requestName", "queryQuest", "sendTextEmote", "setStandState", "joinLfg", "leaveLfg",
  "inviteToGroup", "leaveGroup", "setRaidTarget", "pingMinimap", "commandPet", "requestLogout",
] as const;
export type WindowCommand = (typeof WINDOW_COMMANDS)[number];

/* ---------------------------------------------------------------------------------------------
 * Named bindings — ui-model.mjs:152-165
 * ------------------------------------------------------------------------------------------- */

export type BindingName =
  | "none" | "playerHealth" | "playerPower" | "targetHealth" | "targetPower" | "playerXP"
  | "playerName" | "playerLevel" | "targetName" | "zone" | "money" | "time";

export interface BindingSpec {
  readonly name: BindingName;
  /** The studio's own label, so a menu built from this table reads the same in both tools. */
  readonly label: string;
  /** `bar` and `text` in `BINDING_OPTIONS`: which widgets this binding is offered for. */
  readonly forBar: boolean;
  readonly forText: boolean;
  /** Expression sources. Empty means the binding leaves that part of the widget alone. */
  readonly value: string;
  readonly max: string;
  readonly caption: string;
}

/**
 * The studio's twelve, verbatim in name and label, each with the expression it means here.
 *
 * The studio's generator writes Lua for each of these (`server/codegen/addon.mjs:647-679`); this
 * client has one evaluator, so each becomes an expression instead and there is no second code path
 * to keep in step. Two of them need a word:
 *
 * * `zone` is `subzone or zone` because the studio's Lua is
 *   `GetSubZoneText() != "" ? GetSubZoneText() : GetZoneText()` and `or` short-circuits on the
 *   empty string in exactly the same way.
 * * `time` reads `world.clock`, a preformatted `ЧЧ:ММ` — the string `formatGameTime`
 *   (`GameTimeProtocol.ts:57`) already produces. The addon generator shows the *real* clock with
 *   `date("%H:%M")`; this client shows the *game's*, which runs sixty times faster, so a seconds
 *   field on it would jump a minute every real second and `time(...)` would be the wrong tool.
 */
export const WINDOW_BINDINGS: readonly BindingSpec[] = [
  { name: "none", label: "— нет (значение из настроек) —", forBar: true, forText: true, value: "", max: "", caption: "" },
  {
    name: "playerHealth", label: "Здоровье игрока", forBar: true, forText: true,
    value: "player.health", max: "player.maxHealth",
    caption: 'fmt(player.health) + " / " + fmt(player.maxHealth)',
  },
  {
    name: "playerPower", label: "Ресурс игрока (мана/ярость/энергия)", forBar: true, forText: true,
    value: "player.power", max: "player.maxPower",
    caption: 'fmt(player.power) + " / " + fmt(player.maxPower)',
  },
  {
    name: "targetHealth", label: "Здоровье цели", forBar: true, forText: true,
    value: "target.health", max: "target.maxHealth",
    caption: 'target.exists ? fmt(target.health) + " / " + fmt(target.maxHealth) : "—"',
  },
  {
    name: "targetPower", label: "Ресурс цели", forBar: true, forText: true,
    value: "target.power", max: "target.maxPower",
    caption: 'target.exists ? fmt(target.power) + " / " + fmt(target.maxPower) : "—"',
  },
  {
    name: "playerXP", label: "Опыт игрока", forBar: true, forText: true,
    value: "player.xp", max: "player.maxXp",
    caption: 'fmt(player.xp) + " / " + fmt(player.maxXp)',
  },
  { name: "playerName", label: "Имя игрока", forBar: false, forText: true, value: "", max: "", caption: "player.name" },
  { name: "playerLevel", label: "Уровень игрока", forBar: false, forText: true, value: "", max: "", caption: "fmt(player.level)" },
  { name: "targetName", label: "Имя цели", forBar: false, forText: true, value: "", max: "", caption: 'target.exists ? target.name : "—"' },
  { name: "zone", label: "Зона / подзона", forBar: false, forText: true, value: "", max: "", caption: "world.subzone or world.zone" },
  { name: "money", label: "Деньги (с монетами)", forBar: false, forText: true, value: "", max: "", caption: "money(player.money)" },
  { name: "time", label: "Время (часы:минуты)", forBar: false, forText: true, value: "", max: "", caption: "world.clock" },
];

const BINDING_BY_NAME = new Map(WINDOW_BINDINGS.map((binding) => [binding.name, binding]));

/* ---------------------------------------------------------------------------------------------
 * Conditions — ui-model.mjs:168-193
 * ------------------------------------------------------------------------------------------- */

export type ConditionName =
  | "inCombat" | "outOfCombat" | "hasTarget" | "noTarget" | "targetHostile"
  | "healthBelow" | "healthAbove" | "powerBelow" | "targetHealthBelow"
  | "hasBuff" | "hasDebuff" | "inZone" | "mounted" | "resting" | "dead"
  | "inGroup" | "inRaid" | "inInstance"
  /** This client's addition: any expression at all. */
  | "expr";

/** `ui-model.mjs:188-193` — show, hide, colour, alpha, and nothing else. */
export const CONDITION_EFFECTS = ["show", "hide", "color", "alpha"] as const;
export type ConditionEffect = (typeof CONDITION_EFFECTS)[number];

const bin = (op: BinaryOperator, left: ExprNode, right: ExprNode): ExprNode => ({ node: "binary", op, left, right });
const call = (name: ExpressionFunction, ...args: ExprNode[]): ExprNode => ({ node: "call", name, args });
const notNode = (operand: ExprNode): ExprNode => ({ node: "unary", op: "not", operand });
const named = (root: string, key: string, name: string): ExprNode =>
  ({ node: "path", root, steps: [{ key }, { key: name }] });

interface ConditionSpec {
  readonly name: ConditionName;
  readonly label: string;
  /** `number: true` in `CONDITION_WHEN`, and the default the studio's generator uses. */
  readonly number: number | undefined;
  /** `text: true` in `CONDITION_WHEN`. */
  readonly text: boolean;
  readonly build: (value: number, text: string) => ExprNode;
}

/**
 * The studio's eighteen, each as one expression over the published view.
 *
 * The studio's generator writes a TypeScript test for each (`addon.mjs:1060-1080`); the shape is
 * kept, the calls are replaced by paths. Two of them need the view to publish a *map* rather than
 * a list: `hasBuff`/`hasDebuff` ask whether an aura with a given name is on the player, and the
 * grammar has no `find`, so `player.buff[<name>]` is the honest spelling and М6 publishes
 * `player.buff` and `player.debuff` keyed by name. The parametrised defaults (30, 70, 30, 20) are
 * the generator's own, so a condition saved with an empty number means the same thing in both
 * tools.
 */
const CONDITION_SPECS: readonly ConditionSpec[] = [
  { name: "inCombat", label: "игрок в бою", number: undefined, text: false, build: () => pathNode("player", "combat") },
  { name: "outOfCombat", label: "игрок вне боя", number: undefined, text: false, build: () => notNode(pathNode("player", "combat")) },
  { name: "hasTarget", label: "есть цель", number: undefined, text: false, build: () => pathNode("target", "exists") },
  { name: "noTarget", label: "нет цели", number: undefined, text: false, build: () => notNode(pathNode("target", "exists")) },
  {
    name: "targetHostile", label: "цель враждебна", number: undefined, text: false,
    build: () => bin("and", pathNode("target", "exists"), pathNode("target", "hostile")),
  },
  {
    name: "healthBelow", label: "здоровье игрока ниже, %", number: 30, text: false,
    build: (value) => bin("<", call("pct", pathNode("player", "health"), pathNode("player", "maxHealth")), literalNode(value)),
  },
  {
    name: "healthAbove", label: "здоровье игрока выше, %", number: 70, text: false,
    build: (value) => bin(">", call("pct", pathNode("player", "health"), pathNode("player", "maxHealth")), literalNode(value)),
  },
  {
    name: "powerBelow", label: "ресурс игрока ниже, %", number: 30, text: false,
    build: (value) => bin("<", call("pct", pathNode("player", "power"), pathNode("player", "maxPower")), literalNode(value)),
  },
  {
    name: "targetHealthBelow", label: "здоровье цели ниже, %", number: 20, text: false,
    build: (value) => bin(
      "and",
      pathNode("target", "exists"),
      bin("<", call("pct", pathNode("target", "health"), pathNode("target", "maxHealth")), literalNode(value)),
    ),
  },
  {
    name: "hasBuff", label: "на игроке есть бафф (название)", number: undefined, text: true,
    build: (_value, text) => named("player", "buff", text),
  },
  {
    name: "hasDebuff", label: "на игроке есть дебафф (название)", number: undefined, text: true,
    build: (_value, text) => named("player", "debuff", text),
  },
  {
    name: "inZone", label: "зона называется", number: undefined, text: true,
    build: (_value, text) => bin(
      "or",
      bin("==", pathNode("world", "zone"), literalNode(text)),
      bin("==", pathNode("world", "subzone"), literalNode(text)),
    ),
  },
  { name: "mounted", label: "игрок верхом", number: undefined, text: false, build: () => pathNode("player", "mounted") },
  { name: "resting", label: "игрок отдыхает (город/таверна)", number: undefined, text: false, build: () => pathNode("player", "resting") },
  { name: "dead", label: "игрок мёртв", number: undefined, text: false, build: () => pathNode("player", "dead") },
  { name: "inGroup", label: "в группе", number: undefined, text: false, build: () => pathNode("world", "inGroup") },
  { name: "inRaid", label: "в рейде", number: undefined, text: false, build: () => pathNode("world", "inRaid") },
  { name: "inInstance", label: "в подземелье/рейде (инстанс)", number: undefined, text: false, build: () => pathNode("world", "inInstance") },
];

const CONDITION_BY_NAME = new Map(CONDITION_SPECS.map((spec) => [spec.name, spec]));

export interface ConditionOption {
  readonly name: ConditionName;
  readonly label: string;
  /** The default the studio's generator uses when the number is left blank; `undefined` = no number. */
  readonly number: number | undefined;
  readonly text: boolean;
}

/** The eighteen, without the compiler behind them — for the module checker and М8's menu. */
export const WINDOW_CONDITIONS: readonly ConditionOption[] =
  CONDITION_SPECS.map(({ name, label, number, text }) => ({ name, label, number, text }));

export const CONDITION_NAMES: readonly ConditionName[] = WINDOW_CONDITIONS.map((option) => option.name);

/* ---------------------------------------------------------------------------------------------
 * Limits
 * ------------------------------------------------------------------------------------------- */

/** How many widgets one definition may declare. A screen is not a document. */
export const WINDOW_MAX_WIDGETS = 1000;
/** How deep the tree may nest, so the recursive walk here and in М5 cannot overflow the stack. */
export const WINDOW_MAX_DEPTH = 32;
/** The ceiling on `repeat.limit`: a raid is 40, a bag is 36, and a runaway list is a frozen frame. */
export const WINDOW_MAX_REPEAT = 200;
/** `repeat` without a `limit` of its own. */
const REPEAT_DEFAULT_LIMIT = 100;
/** The gateway will not serve a module file bigger than this (М6), so refusing here says so first. */
export const WINDOW_MAX_CSS = 256 * 1024;

/* ---------------------------------------------------------------------------------------------
 * The parsed shapes
 * ------------------------------------------------------------------------------------------- */

/** Four numbers: a colour's channels, or a texture's (left, right, top, bottom) coordinates. */
export type Rgba = readonly [number, number, number, number];

export interface Anchor {
  readonly point: AnchorPoint;
  /** `"parent"` or the id of an **earlier** sibling. Never anything else — that is a refusal. */
  readonly relativeTo: string;
  readonly relativePoint: AnchorPoint;
  /** WoW coordinates: y grows upward. М5 flips it once, at the edge. */
  readonly x: number;
  readonly y: number;
}

export interface ParsedCondition {
  readonly when: ConditionName;
  readonly then: ConditionEffect;
  /** The compiled test; truthy means the effect applies. */
  readonly test: ExprNode;
  readonly color: Rgba | undefined;
  readonly alpha: number | undefined;
}

export interface ParsedRepeat {
  /** Evaluates to the list this subtree is drawn once per element of. */
  readonly over: ExprNode;
  /** The name each element is published under inside the subtree. */
  readonly as: string;
  readonly limit: number;
}

export interface ParsedEvent {
  readonly event: string;
  readonly actions: readonly WindowAction[];
}

export type WindowAction =
  /** `window: ""` means this window. */
  | { readonly do: "open" | "close" | "toggle"; readonly window: string }
  | { readonly do: "show" | "hide" | "toggleWidget"; readonly widget: string }
  | { readonly do: "setState"; readonly key: string; readonly value: ExprNode }
  | { readonly do: "chat"; readonly text: ExprNode }
  | { readonly do: "macro"; readonly body: ExprNode }
  | { readonly do: "command"; readonly name: WindowCommand; readonly args: readonly ExprNode[] }
  | { readonly do: "sendCustom"; readonly message: string; readonly value: Readonly<Record<string, ExprNode>> }
  | {
      readonly do: "sendCustomRaw";
      readonly opcode: ExprNode;
      readonly fields: readonly { readonly type: CustomFieldType; readonly value: ExprNode }[];
    }
  | { readonly do: "sound"; readonly kit: string }
  | { readonly do: "if"; readonly when: ExprNode; readonly then: readonly WindowAction[]; readonly otherwise: readonly WindowAction[] };

export interface WidgetCommon {
  readonly id: string;
  readonly type: WidgetType;
  /** The global frame name the Lua generator would use. Carried for parity; unused here. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly anchor: Anchor;
  readonly hidden: boolean;
  readonly alpha: number;
  readonly conditions: readonly ParsedCondition[];
  readonly repeat: ParsedRepeat | undefined;
  /** Which named slot of a built-in window this subtree fills (М7). */
  readonly slot: string | undefined;
  /** An extra class name, so a module's own CSS can reach this node. */
  readonly className: string | undefined;
  readonly children: readonly ParsedWidget[];
}

export interface FrameWidget extends WidgetCommon {
  readonly type: "Frame";
  readonly backdrop: BackdropPreset;
  readonly backdropColor: Rgba;
  readonly borderColor: Rgba;
  readonly mouse: boolean;
  readonly movable: boolean;
}

export interface TextureWidget extends WidgetCommon {
  readonly type: "Texture";
  readonly texture: ExprNode;
  readonly texCoords: Rgba;
  readonly color: Rgba;
  readonly layer: LayerName;
  readonly solid: boolean;
}

export interface TextWidget extends WidgetCommon {
  readonly type: "Text";
  readonly text: ExprNode;
  readonly font: string;
  /** 0 means "the font object's own size" (`addon.mjs:160`). */
  readonly size: number;
  readonly color: Rgba | undefined;
  readonly justifyH: "LEFT" | "CENTER" | "RIGHT";
  readonly justifyV: "TOP" | "MIDDLE" | "BOTTOM";
  readonly outline: string;
  readonly shadow: boolean;
  readonly wrap: boolean;
  readonly bind: BindingName | undefined;
}

export interface ButtonTextures {
  readonly normal: string;
  readonly pushed: string;
  readonly highlight: string;
  readonly disabled: string;
}

export interface ButtonWidget extends WidgetCommon {
  readonly type: "Button";
  readonly text: ExprNode;
  readonly template: string;
  readonly tooltip: ExprNode;
  readonly textures: ButtonTextures;
  readonly enabled: ExprNode;
  readonly actions: readonly WindowAction[];
}

export interface CheckButtonWidget extends WidgetCommon {
  readonly type: "CheckButton";
  readonly text: ExprNode;
  readonly checked: ExprNode;
  readonly font: string;
  readonly state: string;
  readonly onChange: readonly WindowAction[];
}

export interface EditBoxWidget extends WidgetCommon {
  readonly type: "EditBox";
  readonly text: ExprNode;
  readonly numeric: boolean;
  readonly maxLetters: number;
  readonly multiline: boolean;
  readonly autoFocus: boolean;
  readonly font: string;
  readonly template: string;
  readonly state: string;
  /**
   * What М5 publishes under `state.<state>`: a number for a `numeric` box, the text for any other.
   *
   * Written into the parse rather than left to be inferred, because it is a contract with two
   * readers and both of them are strict. `compare` refuses to order a string against a number
   * (`WindowExpression.ts`), so `{state.qty > 10}` on a box that publishes "17" is false forever;
   * and `encodeField` refuses anything but a number for an `f64` (`CustomCodec.ts:270`), so the
   * studio's own «отправить пакет» would throw at the moment the button is pressed. The studio
   * settles it the same way in Lua — `Number(ui.X.GetText()) || 0` (`addon.mjs:191`) — and this
   * grammar has no `num()` to write that with, so the coercion belongs where the value is
   * published.
   */
  readonly stateKind: "number" | "text";
  readonly onEnter: readonly WindowAction[];
}

export interface StatusBarWidget extends WidgetCommon {
  readonly type: "StatusBar";
  readonly texture: string;
  readonly color: Rgba;
  readonly background: Rgba;
  readonly min: ExprNode;
  readonly max: ExprNode;
  readonly value: ExprNode;
  readonly showText: boolean;
  /** What the bar's own label says, once `bind` or an expression has filled it in. */
  readonly caption: ExprNode;
  readonly font: string;
  readonly bind: BindingName | undefined;
}

export interface SliderWidget extends WidgetCommon {
  readonly type: "Slider";
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: ExprNode;
  readonly label: ExprNode;
  readonly showValue: boolean;
  readonly state: string;
  readonly onChange: readonly WindowAction[];
}

export interface ScrollFrameWidget extends WidgetCommon {
  readonly type: "ScrollFrame";
  readonly contentHeight: number;
}

export interface ItemButtonWidget extends WidgetCommon {
  readonly type: "ItemButton";
  readonly icon: ExprNode;
  readonly itemId: ExprNode;
  readonly spellId: ExprNode;
  readonly count: ExprNode;
  readonly tooltip: boolean;
  readonly actions: readonly WindowAction[];
}

export interface DropDownWidget extends WidgetCommon {
  readonly type: "DropDown";
  /** A newline-separated string, or an expression evaluating to a list. */
  readonly options: ExprNode;
  readonly selected: ExprNode;
  readonly label: ExprNode;
  readonly state: string;
  readonly onChange: readonly WindowAction[];
}

/**
 * Whose model a `Model` widget shows.
 *
 * The studio's own menu offers four (`web/designer.mjs:873`: player, target, pet, focus) and B.3
 * adds `none` for a widget that shows a `creature` id and no unit at all. Checked like every other
 * enumerated field, because `unit: "nonsense"` used to reach М5 with nothing said, and М5 has no
 * better answer for it than an empty box.
 */
export const MODEL_UNITS = ["player", "target", "focus", "pet", "none"] as const;
export type ModelUnit = (typeof MODEL_UNITS)[number];

export interface ModelWidget extends WidgetCommon {
  readonly type: "Model";
  readonly unit: ModelUnit;
  readonly creature: ExprNode;
  readonly rotation: number;
}

export type ParsedWidget =
  | FrameWidget | TextureWidget | TextWidget | ButtonWidget | CheckButtonWidget | EditBoxWidget
  | StatusBarWidget | SliderWidget | ScrollFrameWidget | ItemButtonWidget | DropDownWidget | ModelWidget;

export interface ScreenRoot extends FrameWidget {
  readonly strata: StrataName;
  readonly closeButton: boolean;
  readonly escClose: boolean;
  readonly title: ExprNode;
  readonly titleTexture: boolean;
  readonly events: readonly ParsedEvent[];
}

/** The studio's shorthand for "this screen talks to a livescript" (`addon.mjs:1169-1192`). */
export interface WindowPackets {
  readonly enabled: boolean;
  readonly opcodeIn: number;
  readonly opcodeOut: number;
}

export interface ParsedWindow {
  readonly id: string;
  readonly module: string;
  readonly name: ExprNode;
  readonly enabled: boolean;
  readonly format: 1;
  readonly screen: ScreenRoot;
  /** Without the leading slash, lowercase, safe characters only. Empty when the file has none. */
  readonly slash: string;
  /** A key this window offers to bind itself to. Offered **unbound**; the player chooses. */
  readonly binding: string;
  readonly packets: WindowPackets;
  readonly messages: readonly CustomMessage[];
  readonly state: Readonly<Record<string, ExprNode>>;
  readonly css: string;
  readonly updated: string;
}

export interface WindowParse {
  /** Absent when a fatal problem was found. There is no partially built window. */
  readonly window?: ParsedWindow;
  readonly problems: readonly string[];
}

/* ---------------------------------------------------------------------------------------------
 * Reading
 * ------------------------------------------------------------------------------------------- */

interface ParseContext {
  readonly module: string;
  readonly windowId: string;
  readonly problems: string[];
  readonly ids: Set<string>;
  /** The opcode a studio `sendPacket` action falls back to (`addon.mjs:189`). */
  defaultOpcode: number;
  fatal: boolean;
  widgets: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const DEFAULT_WHITE: Rgba = [1, 1, 1, 1];
const DEFAULT_TEXCOORDS: Rgba = [0, 1, 0, 1];

function fatal(context: ParseContext, where: string, text: string): void {
  context.problems.push(`${where}: ${text}`);
  context.fatal = true;
}

function note(context: ParseContext, where: string, text: string): void {
  context.problems.push(`${where}: ${text}`);
}

/** One widget's fields, with a `bad` flag: a fault drops the widget, it does not throw. */
class WidgetReader {
  bad = false;
  readonly #parent: WidgetReader | undefined;

  constructor(
    readonly record: Record<string, unknown>,
    readonly where: string,
    readonly context: ParseContext,
    parent?: WidgetReader,
  ) {
    this.#parent = parent;
  }

  /**
   * A fault anywhere inside a widget is a fault of the widget.
   *
   * An action's `text` and a widget's `text` are read by different readers, and without this the
   * first would leave a button standing that can never do anything while the second dropped its
   * label — one rule in the header, two behaviours in the code.
   */
  markBad(): void {
    this.bad = true;
    this.#parent?.markBad();
  }

  fault(text: string): void {
    note(this.context, this.where, text);
    this.markBad();
  }

  note(text: string): void {
    note(this.context, this.where, text);
  }

  number(key: string, fallback: number): number {
    const value = this.record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.record[key];
    return typeof value === "boolean" ? value : fallback;
  }

  string(key: string, fallback: string): string {
    const value = this.record[key];
    return typeof value === "string" ? value : fallback;
  }

  /** A member of a fixed list, or the studio's own default with a note naming what was written. */
  choice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const value = this.record[key];
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    this.note(`"${key}" is "${String(value)}", which this client does not know; using "${fallback}"`);
    return fallback;
  }

  rgba(key: string, fallback: Rgba | undefined): Rgba | undefined {
    const value = this.record[key];
    if (!Array.isArray(value) || value.length < 3) return fallback;
    const channel = (index: number, missing: number): number => {
      const raw = value[index];
      return typeof raw === "number" && Number.isFinite(raw) ? raw : missing;
    };
    return [channel(0, 1), channel(1, 1), channel(2, 1), channel(3, 1)];
  }

  /**
   * A value that may be text, an expression, or text with expressions in it.
   *
   * A parse problem drops the widget rather than falling back to the literal: a bar still drawing
   * its design-time preview of 65 because `{player.helth}` was misspelled is a window that looks
   * like it works.
   */
  value(key: string, fallback: ExprNode): ExprNode {
    return this.raw(this.record[key], key, fallback);
  }

  /** The same reading, for a value that has no key of its own — an element of `args`, say. */
  raw(raw: unknown, label: string, fallback: ExprNode): ExprNode {
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw === "number") return literalNode(Number.isFinite(raw) ? raw : 0);
    if (typeof raw === "boolean") return literalNode(raw);
    if (typeof raw !== "string") {
      this.fault(`"${label}" must be a number, a boolean or a string`);
      return fallback;
    }
    const parsed = parseTemplate(raw);
    if (!parsed.ast) {
      this.fault(`"${label}": ${parsed.problems.join("; ")}`);
      return fallback;
    }
    return parsed.ast;
  }

  /**
   * A `{ru, en}` pair, or a plain string.
   *
   * The Russian half wins. This client's interface is Russian throughout — the generated
   * `GLOBAL_STRINGS` are the realm's own ruRU table — and the studio keeps the English half only
   * for the `tr(ru, en)` its Lua generator emits.
   */
  localised(key: string, fallback: string): ExprNode {
    const raw = this.record[key];
    if (typeof raw === "string") return this.value(key, literalNode(fallback));
    if (!isRecord(raw)) return literalNode(fallback);
    const ru = typeof raw["ru"] === "string" ? raw["ru"] : "";
    const en = typeof raw["en"] === "string" ? raw["en"] : "";
    const text = ru || en || fallback;
    const parsed = parseTemplate(text);
    if (!parsed.ast) {
      this.fault(`"${key}": ${parsed.problems.join("; ")}`);
      return literalNode(fallback);
    }
    return parsed.ast;
  }
}

/**
 * Reads `over`, which is never literal text.
 *
 * Both `"party"` and `"{party}"` are accepted, because a modder who has just learned that a value
 * needs braces will write them here too, and refusing one spelling of an unambiguous field teaches
 * nothing.
 */
function parseListSource(raw: string): { readonly ast?: ExprNode; readonly problems: readonly string[] } {
  const trimmed = raw.trim();
  return isExpressionSource(trimmed) ? parseExpression(trimmed.slice(1, -1)) : parseExpression(trimmed);
}

function parseAnchor(reader: WidgetReader, earlier: readonly string[], siblings: readonly string[]): Anchor {
  const raw = reader.record["anchor"];
  const anchor = isRecord(raw) ? new WidgetReader(raw, reader.where, reader.context) : undefined;
  const point = anchor ? anchor.choice("point", ANCHOR_POINTS, "CENTER") : "CENTER";
  const relativePoint = anchor ? anchor.choice("relativePoint", ANCHOR_POINTS, point) : point;
  const relativeTo = anchor ? anchor.string("relativeTo", "parent") : "parent";
  const x = anchor ? anchor.number("x", 0) : 0;
  const y = anchor ? anchor.number("y", 0) : 0;

  if (relativeTo !== "" && relativeTo !== "parent" && !earlier.includes(relativeTo)) {
    // Refused rather than reordered. The studio's generator sorts children so a later anchor
    // resolves (`addon.mjs:57-81`), but sibling order is also draw order inside a layer — reordering
    // to satisfy an anchor would change what covers what, and the WebClient and the Lua addon would
    // stop agreeing about the same file. One drag in the studio fixes it; a silent reorder does not.
    fatal(
      reader.context,
      reader.where,
      siblings.includes(relativeTo)
        ? `the anchor points at "${relativeTo}", which is declared later among the same children;`
          + " an anchor may only name its parent or an earlier sibling"
        : `the anchor points at "${relativeTo}", which is not its parent and not one of its siblings`,
    );
  }
  return { point, relativeTo: relativeTo === "" ? "parent" : relativeTo, relativePoint, x, y };
}

function parseConditions(reader: WidgetReader): ParsedCondition[] {
  const raw = reader.record["conditions"];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    reader.note('"conditions" must be an array');
    return [];
  }
  const conditions: ParsedCondition[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      reader.note(`conditions[${index}] must be an object`);
      continue;
    }
    const inner = new WidgetReader(entry, `${reader.where}.conditions[${index}]`, reader.context);
    const when = inner.string("when", "");
    const then = inner.choice("then", CONDITION_EFFECTS, "show");
    const color = inner.rgba("color", undefined);
    const alphaRaw = entry["alpha"];
    const alpha = typeof alphaRaw === "number" && Number.isFinite(alphaRaw) ? alphaRaw : undefined;

    let test: ExprNode | undefined;
    if (when === "expr") {
      const source = inner.string("value", "");
      const parsed = parseListSource(source);
      if (!parsed.ast) {
        inner.note(`the condition's expression could not be read: ${parsed.problems.join("; ")}`);
        continue;
      }
      test = parsed.ast;
    } else {
      const spec = CONDITION_BY_NAME.get(when as ConditionName);
      if (!spec) {
        inner.note(`"${when}" is not one of the conditions this client knows (${CONDITION_NAMES.join(", ")})`);
        continue;
      }
      test = spec.build(inner.number("value", spec.number ?? 0), inner.string("text", ""));
    }
    conditions.push({ when: when as ConditionName, then, test, color, alpha });
  }
  return conditions;
}

/* ---------------------------------------------------------------------------------------------
 * Actions
 * ------------------------------------------------------------------------------------------- */

const RAW_FIELD_KINDS: ReadonlySet<string> =
  new Set(["u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64", "string", "cstring"]);

/**
 * An opcode a file may write down: a whole number a `uint16` can hold, above zero.
 *
 * Everything downstream already says so and only this door was open. The studio refuses anything
 * but a positive number (`addon.mjs:189`), `parsePackets` bounds the screen's own two to
 * `0..0xffff`, and М1 throws `RangeError("Custom opcode -5 is not a uint16")` at
 * `CustomPacket.ts:197-199` — which is a throw when the player presses the button, in a client
 * that had already loaded the window. Zero is not an opcode either: it is the studio's "not set".
 */
function boundedOpcode(value: number): number | undefined {
  return Number.isInteger(value) && value > 0 && value <= 0xffff ? value : undefined;
}

function parseActionList(raw: unknown, reader: WidgetReader, key: string): WindowAction[] {
  if (raw === undefined || raw === null) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  const actions: WindowAction[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      reader.note(`${key}[${index}] must be an object`);
      continue;
    }
    const action = typeof entry["do"] === "string"
      ? parseAction(entry, reader, `${key}[${index}]`)
      : mapStudioAction(entry, reader, `${key}[${index}]`);
    if (action) actions.push(action);
  }
  return actions;
}

function parseAction(entry: Record<string, unknown>, reader: WidgetReader, where: string): WindowAction | undefined {
  const inner = new WidgetReader(entry, `${reader.where}.${where}`, reader.context, reader);
  const verb = inner.string("do", "");
  switch (verb) {
    case "open":
    case "close":
    case "toggle":
      return { do: verb, window: inner.string("window", "") };
    case "show":
    case "hide":
    case "toggleWidget": {
      const widget = inner.string("widget", "");
      if (!widget) {
        inner.note(`"${verb}" needs a "widget"`);
        return undefined;
      }
      return { do: verb, widget };
    }
    case "setState": {
      const stateKey = inner.string("key", "");
      if (!stateKey) {
        inner.note('"setState" needs a "key"');
        return undefined;
      }
      return { do: "setState", key: stateKey, value: inner.value("value", literalNode("")) };
    }
    case "chat":
      return { do: "chat", text: inner.localised("text", "") };
    case "macro":
      return { do: "macro", body: inner.localised("body", "") };
    case "command": {
      const name = inner.string("name", "");
      if (!(WINDOW_COMMANDS as readonly string[]).includes(name)) {
        inner.note(`"${name}" is not one of the commands a window may call (${WINDOW_COMMANDS.join(", ")})`);
        return undefined;
      }
      const rawArgs = entry["args"];
      const args = Array.isArray(rawArgs)
        ? rawArgs.map((value, index) => inner.raw(value, `args[${index}]`, literalNode("")))
        : [];
      return { do: "command", name: name as WindowCommand, args };
    }
    case "sendCustom": {
      const message = inner.string("message", "");
      if (!message) {
        inner.note('"sendCustom" needs the name of a message');
        return undefined;
      }
      const rawValue = entry["value"];
      const value: Record<string, ExprNode> = {};
      if (isRecord(rawValue)) {
        const values = new WidgetReader(rawValue, inner.where, reader.context, inner);
        for (const field of Object.keys(rawValue)) value[field] = values.value(field, literalNode(0));
      }
      return { do: "sendCustom", message, value };
    }
    case "sendCustomRaw": {
      const rawFields = entry["fields"];
      const fields: { type: CustomFieldType; value: ExprNode }[] = [];
      if (Array.isArray(rawFields)) {
        for (const [index, field] of rawFields.entries()) {
          if (!isRecord(field)) {
            inner.note(`fields[${index}] must be an object`);
            continue;
          }
          const kind = typeof field["type"] === "string" ? field["type"] : "";
          if (!RAW_FIELD_KINDS.has(kind)) {
            inner.note(
              `fields[${index}]: "${kind}" is not a raw field type;`
              + " declare a message under \"messages\" and use sendCustom for anything with a shape",
            );
            continue;
          }
          const values = new WidgetReader(field, inner.where, reader.context, inner);
          fields.push({ type: { kind } as CustomFieldType, value: values.value("value", literalNode(0)) });
        }
      }
      if (fields.length === 0) {
        // The worldserver reads a frame carrying only its six-byte header as NO_HEADER and kicks
        // (`CustomCodec.ts`, `CustomPacketBuffer.cpp:24-27`). Said here, the author hears it at load
        // time rather than through a disconnect the first time the button is pressed.
        inner.note('"sendCustomRaw" with no fields would send an empty body, which the worldserver kicks for');
        return undefined;
      }
      // A literal opcode is bounded here; one written as an expression can only be bounded by М6,
      // when there is a value to bound. The screen's own default has already been through
      // `parsePackets`.
      const written = entry["opcode"];
      let opcode = inner.value("opcode", literalNode(reader.context.defaultOpcode));
      if (typeof written === "number" && boundedOpcode(written) === undefined) {
        inner.note(
          `"opcode" is ${written}, which is not a whole number from 1 to ${0xffff};`
          + " using the screen's own outbound opcode instead",
        );
        opcode = literalNode(reader.context.defaultOpcode);
      }
      if (opcode.node === "number" && opcode.value === 0) {
        inner.note('"sendCustomRaw" has opcode 0 — set one on the screen ("packets") or on the action');
        return undefined;
      }
      return { do: "sendCustomRaw", opcode, fields };
    }
    case "sound": {
      const kit = inner.string("kit", "");
      if (!kit) {
        inner.note('"sound" needs a "kit"');
        return undefined;
      }
      return { do: "sound", kit };
    }
    case "if": {
      const when = inner.value("when", literalNode(false));
      return {
        do: "if",
        when,
        then: parseActionList(entry["then"], reader, `${where}.then`),
        otherwise: parseActionList(entry["else"], reader, `${where}.else`),
      };
    }
    default:
      inner.note(`"${verb}" is not an action this client has`);
      return undefined;
  }
}

/**
 * The studio's nine, mapped one for one.
 *
 * `custom` is the only refusal, and it is an honest one: the studio's own label for it is «Свой код
 * (обработчик в файле логики)», the file of logic is Lua, and this client has no Lua interpreter
 * and will not grow one. Saying so names the button; silently doing nothing would leave the author
 * looking for a bug in their handler.
 */
function mapStudioAction(entry: Record<string, unknown>, reader: WidgetReader, where: string): WindowAction | undefined {
  const inner = new WidgetReader(entry, `${reader.where}.${where}`, reader.context, reader);
  const type = inner.string("type", "");
  switch (type as StudioButtonAction) {
    case "custom":
      inner.note(
        'the action «Свой код» (custom) needs a Lua handler, and this client has no Lua;'
        + ' give the button an action list ("do": …) instead — the button is drawn, but it does nothing',
      );
      return undefined;
    case "close":
      return { do: "close", window: "" };
    case "toggleWidget": {
      const target = inner.string("target", "");
      if (!target) {
        inner.note("the action «показать/скрыть» has no widget chosen");
        return undefined;
      }
      return { do: "toggleWidget", widget: target };
    }
    case "showScreen": {
      const screen = inner.string("screen", "");
      if (!screen) {
        inner.note("the action «открыть экран» has no screen chosen");
        return undefined;
      }
      return { do: "toggle", window: screen };
    }
    case "chat":
      return { do: "chat", text: inner.localised("text", "") };
    case "castSpell":
      return { do: "command", name: "castSpellByName", args: [inner.localised("spell", "")] };
    case "useItem":
      return { do: "command", name: "useItemByName", args: [inner.localised("item", "")] };
    case "macro":
      return { do: "macro", body: inner.localised("macro", "") };
    case "sendPacket": {
      // The generated Lua is `CreateCustomPacket(op, 0); packet.WriteDouble(v); packet.Send()`
      // (`addon.mjs:188-196`) — one f64 and nothing else, which is exactly one raw field.
      const written = inner.number("opcode", 0);
      if (written !== 0 && boundedOpcode(written) === undefined) {
        inner.note(
          `the action «отправить пакет» has opcode ${written}, which is not a whole number from 1 to ${0xffff};`
          + " using the screen's own outbound opcode instead",
        );
      }
      const opcode = boundedOpcode(written) ?? reader.context.defaultOpcode;
      if (!opcode) {
        inner.note("the action «отправить пакет» has opcode 0 — set it on the screen or on the action");
        return undefined;
      }
      const valueFrom = inner.string("valueFrom", "");
      const value = valueFrom
        // The studio reads the named widget's text and wraps it in `Number(…) || 0`. Here an input
        // publishes under `state.<its id>` unless it named a `state` key of its own, so the path is
        // the id — and an input marked «только числа» publishes a number, which is the half of the
        // coercion this grammar cannot spell. `checkPacketInputs` says so when it is missing.
        ? pathNode("state", valueFrom)
        : literalNode(inner.number("value", 0));
      return { do: "sendCustomRaw", opcode: literalNode(opcode), fields: [{ type: { kind: "f64" }, value }] };
    }
    default:
      inner.note(`"${type}" is not one of the studio's button actions (${STUDIO_BUTTON_ACTIONS.join(", ")})`);
      return undefined;
  }
}

/* ---------------------------------------------------------------------------------------------
 * Widgets
 * ------------------------------------------------------------------------------------------- */

function backdropOf(reader: WidgetReader): BackdropPreset {
  const name = reader.choice("backdrop", BACKDROP_PRESETS.map((preset) => preset.name), "none");
  const preset = BACKDROP_PRESETS.find((entry) => entry.name === name) ?? (BACKDROP_PRESETS[0] as BackdropPreset);
  if (name !== "custom") return preset;
  const raw = reader.record["backdropCustom"];
  if (!isRecord(raw)) return preset;
  const custom = new WidgetReader(raw, reader.where, reader.context);
  // The insets are edited too — the studio seeds them (`web/designer.mjs:739`) and offers «Отступ
  // слева/справа» and «Отступ сверху/снизу» (`:743`), and its generator merges the whole object
  // into `SetBackdrop` (`addon.mjs:139`). Dropped here, a file with 20-pixel insets drew an 8-pixel
  // border in this client and a 20-pixel one in the Lua addon: the same divergence that a forward
  // anchor is refused for, arriving quietly instead.
  const inner = isRecord(raw["insets"]) ? new WidgetReader(raw["insets"], reader.where, reader.context) : undefined;
  return {
    ...preset,
    bgFile: custom.string("bgFile", preset.bgFile),
    edgeFile: custom.string("edgeFile", preset.edgeFile),
    tile: custom.boolean("tile", preset.tile),
    tileSize: custom.number("tileSize", preset.tileSize),
    edgeSize: custom.number("edgeSize", preset.edgeSize),
    insets: inner
      ? {
          left: inner.number("left", preset.insets.left),
          right: inner.number("right", preset.insets.right),
          top: inner.number("top", preset.insets.top),
          bottom: inner.number("bottom", preset.insets.bottom),
        }
      : preset.insets,
  };
}

/** A binding name, checked against the role the widget can actually play. */
function bindingOf(reader: WidgetReader, role: "bar" | "text"): BindingSpec | undefined {
  const raw = reader.record["bind"];
  if (typeof raw !== "string" || raw === "" || raw === "none") return undefined;
  if (isExpressionSource(raw)) return undefined; // handled by the caller as an expression
  const spec = BINDING_BY_NAME.get(raw as BindingName);
  if (!spec) {
    reader.note(
      `"bind" is "${raw}", which is neither one of the twelve bindings`
      + ` (${WINDOW_BINDINGS.map((binding) => binding.name).join(", ")}) nor an expression in braces`,
    );
    return undefined;
  }
  if (role === "bar" && !spec.forBar) {
    reader.note(`the binding "${raw}" has no number behind it, so a StatusBar cannot follow it`);
    return undefined;
  }
  return spec;
}

/** The expression a `bind: "{…}"` holds, when that is what it holds. */
function bindExpression(reader: WidgetReader): ExprNode | undefined {
  const raw = reader.record["bind"];
  if (typeof raw !== "string" || !isExpressionSource(raw)) return undefined;
  const parsed = parseExpression(raw.trim().slice(1, -1));
  if (!parsed.ast) {
    reader.fault(`"bind": ${parsed.problems.join("; ")}`);
    return undefined;
  }
  return parsed.ast;
}

function bindingNode(source: string, reader: WidgetReader, fallback: ExprNode): ExprNode {
  if (!source) return fallback;
  const parsed = parseExpression(source);
  if (!parsed.ast) {
    // A table in this file, not anything the module wrote. The test walks every entry so this is
    // unreachable in a green build; the fallback keeps a typo from taking the window down with it.
    reader.note(`the binding's own expression "${source}" could not be read`);
    return fallback;
  }
  return parsed.ast;
}

function stateKeyOf(reader: WidgetReader, id: string): string {
  // An input with no `state` of its own still has to be readable: the studio's `valueFrom` names a
  // widget id and expects its value, and `state.<id>` is where М5 publishes it. What kind of value
  // that is — a number or the text — is `EditBoxWidget.stateKind`, and it is a contract, not a
  // detail: see the field's own comment.
  return reader.string("state", "") || id;
}

function parseRepeat(reader: WidgetReader): ParsedRepeat | undefined {
  const raw = reader.record["repeat"];
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    reader.note('"repeat" must be an object with "over" and "as"');
    return undefined;
  }
  const inner = new WidgetReader(raw, reader.where, reader.context);
  const over = inner.string("over", "");
  const as = inner.string("as", "");
  if (!over || !as) {
    reader.fault('"repeat" needs both "over" (a list) and "as" (the name each element takes)');
    return undefined;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(as)) {
    reader.fault(`"repeat.as" is "${as}", which is not a name an expression can spell`);
    return undefined;
  }
  if ((WINDOW_STATE_ROOTS as readonly string[]).includes(as)) {
    reader.note(`"repeat.as" is "${as}", which hides the published "${as}" inside this subtree`);
  }
  const parsed = parseListSource(over);
  if (!parsed.ast) {
    reader.fault(`"repeat.over": ${parsed.problems.join("; ")}`);
    return undefined;
  }
  const wanted = inner.number("limit", REPEAT_DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(WINDOW_MAX_REPEAT, Math.floor(wanted)));
  if (limit !== wanted) reader.note(`"repeat.limit" is ${wanted}; using ${limit} (the ceiling is ${WINDOW_MAX_REPEAT})`);
  return { over: parsed.ast, as, limit };
}

function parseWidget(
  raw: unknown,
  context: ParseContext,
  parentWhere: string,
  earlier: readonly string[],
  siblings: readonly string[],
  depth: number,
): ParsedWidget | undefined {
  if (!isRecord(raw)) {
    note(context, parentWhere, "a widget must be an object");
    return undefined;
  }
  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  const where = `${context.module}/${context.windowId}.${id || "?"}`;
  if (!id) {
    note(context, parentWhere, "a widget has no id");
    return undefined;
  }
  if (context.ids.has(id)) {
    // Fatal: with two "gold-text" widgets, an anchor naming one of them means nothing, and the
    // studio's own generator only warns and then emits the second under a different variable —
    // which is how a widget disappears from a screen without a word.
    fatal(context, where, `the id "${id}" is used by two widgets in this window`);
    return undefined;
  }
  context.ids.add(id);

  if (++context.widgets > WINDOW_MAX_WIDGETS) {
    fatal(context, where, `the window declares more than ${WINDOW_MAX_WIDGETS} widgets`);
    return undefined;
  }
  if (depth > WINDOW_MAX_DEPTH) {
    fatal(context, where, `the widget tree nests deeper than ${WINDOW_MAX_DEPTH}`);
    return undefined;
  }

  const reader = new WidgetReader(raw, where, context);
  const type = reader.string("type", "");
  if (!(WIDGET_TYPES as readonly string[]).includes(type)) {
    // Dropped, not fatal: an author trying a widget from a newer studio still gets the rest of
    // their window, and the reason names both the type and the widget.
    note(context, where, `the type "${type}" is not one this client draws (${WIDGET_TYPES.join(", ")}); the widget is left out`);
    return undefined;
  }

  // The studio's escape hatch into FrameXML: `inherits` names a Lua template whose parts the addon
  // then reaches through `_G` (`web/designer.mjs:681-683`). There is no FrameXML here and no global
  // frame namespace on purpose, so the field is refused out loud rather than dropped in silence —
  // otherwise a portrait frame that came for free in the addon is simply missing here.
  const inherits = reader.string("inherits", "");
  if (inherits) {
    note(context, where, `"inherits" names the FrameXML template «${inherits}», and this client has no FrameXML;`
      + " draw the parts you need as widgets, or ask for a slot in a built-in window");
  }

  const anchor = parseAnchor(reader, earlier, siblings);
  const conditions = parseConditions(reader);
  const repeated = parseRepeat(reader);
  const common = {
    id,
    name: reader.string("name", ""),
    width: reader.number("width", 100),
    height: reader.number("height", 20),
    anchor,
    hidden: reader.boolean("hidden", false),
    alpha: reader.number("alpha", 1),
    conditions,
    repeat: repeated,
    slot: reader.string("slot", "") || undefined,
    className: reader.string("className", "") || undefined,
  };

  const children = CONTAINER_TYPES.has(type)
    ? parseChildren(raw["children"], context, where, depth + 1)
    : [];
  if (!CONTAINER_TYPES.has(type) && Array.isArray(raw["children"]) && raw["children"].length > 0) {
    note(context, where, `a ${type} holds no children; ${raw["children"].length} were left out`);
  }

  const widget = buildWidget(type as WidgetType, reader, { ...common, children });
  return reader.bad ? undefined : widget;
}

type CommonFields = Omit<WidgetCommon, "type">;

function buildWidget(type: WidgetType, reader: WidgetReader, common: CommonFields): ParsedWidget {
  switch (type) {
    case "Frame":
      return {
        ...common, type,
        backdrop: backdropOf(reader),
        backdropColor: reader.rgba("backdropColor", DEFAULT_WHITE) ?? DEFAULT_WHITE,
        borderColor: reader.rgba("borderColor", DEFAULT_WHITE) ?? DEFAULT_WHITE,
        mouse: reader.boolean("mouse", false),
        movable: reader.boolean("movable", false),
      };
    case "Texture":
      return {
        ...common, type,
        texture: reader.value("texture", literalNode("")),
        texCoords: reader.rgba("texCoords", DEFAULT_TEXCOORDS) ?? DEFAULT_TEXCOORDS,
        color: reader.rgba("color", DEFAULT_WHITE) ?? DEFAULT_WHITE,
        layer: reader.choice("layer", LAYERS, "ARTWORK"),
        solid: reader.boolean("solid", false),
      };
    case "Text": {
      const binding = bindingOf(reader, "text");
      const expression = bindExpression(reader);
      const literal = reader.localised("text", "");
      return {
        ...common, type,
        text: expression ?? (binding ? bindingNode(binding.caption, reader, literal) : literal),
        font: reader.choice("font", WINDOW_FONT_NAMES, "GameFontNormal"),
        size: reader.number("size", 0),
        color: reader.rgba("color", undefined),
        justifyH: reader.choice("justifyH", ["LEFT", "CENTER", "RIGHT"] as const, "CENTER"),
        justifyV: reader.choice("justifyV", ["TOP", "MIDDLE", "BOTTOM"] as const, "MIDDLE"),
        outline: reader.string("outline", ""),
        shadow: reader.boolean("shadow", true),
        wrap: reader.boolean("wrap", true),
        bind: binding?.name,
      };
    }
    case "Button": {
      const textures = isRecord(reader.record["textures"])
        ? new WidgetReader(reader.record["textures"], reader.where, reader.context)
        : undefined;
      return {
        ...common, type,
        text: reader.localised("text", ""),
        template: reader.string("template", "UIPanelButtonTemplate"),
        tooltip: reader.localised("tooltip", ""),
        textures: {
          normal: textures?.string("normal", "") ?? "",
          pushed: textures?.string("pushed", "") ?? "",
          highlight: textures?.string("highlight", "") ?? "",
          disabled: textures?.string("disabled", "") ?? "",
        },
        enabled: reader.value("enabled", literalNode(true)),
        actions: collectActions(reader, "action"),
      };
    }
    case "CheckButton":
      return {
        ...common, type,
        text: reader.localised("text", ""),
        checked: reader.value("checked", literalNode(false)),
        font: reader.choice("font", WINDOW_FONT_NAMES, "GameFontNormalSmall"),
        state: stateKeyOf(reader, common.id),
        onChange: collectActions(reader, "action"),
      };
    case "EditBox": {
      const numeric = reader.boolean("numeric", false);
      return {
        ...common, type,
        text: reader.localised("text", ""),
        numeric,
        maxLetters: reader.number("maxLetters", 0),
        multiline: reader.boolean("multiline", false),
        autoFocus: reader.boolean("autoFocus", false),
        font: reader.choice("font", WINDOW_FONT_NAMES, "ChatFontNormal"),
        template: reader.string("template", "InputBoxTemplate"),
        state: stateKeyOf(reader, common.id),
        stateKind: numeric ? "number" : "text",
        onEnter: parseActionList(reader.record["onEnter"], reader, "onEnter"),
      };
    }
    case "StatusBar": {
      const binding = bindingOf(reader, "bar");
      const expression = bindExpression(reader);
      const value = reader.value("value", literalNode(0));
      const max = reader.value("max", literalNode(100));
      return {
        ...common, type,
        texture: reader.string("texture", "Interface\\TargetingFrame\\UI-StatusBar"),
        color: reader.rgba("color", [0.2, 0.8, 0.2, 1]) ?? [0.2, 0.8, 0.2, 1],
        background: reader.rgba("background", [0, 0, 0, 0.5]) ?? [0, 0, 0, 0.5],
        min: reader.value("min", literalNode(0)),
        max: binding ? bindingNode(binding.max, reader, max) : max,
        value: expression ?? (binding ? bindingNode(binding.value, reader, value) : value),
        showText: reader.boolean("showText", true),
        caption: binding ? bindingNode(binding.caption, reader, literalNode("")) : literalNode(""),
        font: reader.choice("font", WINDOW_FONT_NAMES, "GameFontHighlightSmall"),
        bind: binding?.name,
      };
    }
    case "Slider":
      return {
        ...common, type,
        min: reader.number("min", 0),
        max: reader.number("max", 100),
        step: reader.number("step", 1) || 1,
        value: reader.value("value", literalNode(0)),
        label: reader.localised("label", ""),
        showValue: reader.boolean("showValue", true),
        state: stateKeyOf(reader, common.id),
        onChange: parseActionList(reader.record["onChange"], reader, "onChange"),
      };
    case "ScrollFrame":
      return { ...common, type, contentHeight: reader.number("contentHeight", common.height) };
    case "ItemButton":
      return {
        ...common, type,
        icon: reader.value("icon", literalNode("")),
        itemId: reader.value("itemId", literalNode(0)),
        spellId: reader.value("spellId", literalNode(0)),
        count: reader.value("count", literalNode(0)),
        tooltip: reader.boolean("tooltip", true),
        actions: collectActions(reader, "action"),
      };
    case "DropDown":
      return {
        ...common, type,
        options: parseOptions(reader),
        selected: reader.value("selected", literalNode(1)),
        label: reader.localised("label", ""),
        state: stateKeyOf(reader, common.id),
        onChange: parseActionList(reader.record["onChange"], reader, "onChange"),
      };
    case "Model":
      return {
        ...common, type,
        unit: reader.choice("unit", MODEL_UNITS, "player"),
        creature: reader.value("creature", literalNode(0)),
        rotation: reader.number("rotation", 0),
      };
  }
}

/** `{"list": "{quest}"}` for a list from the game, or the studio's newline-separated string. */
function parseOptions(reader: WidgetReader): ExprNode {
  const raw = reader.record["options"];
  if (isRecord(raw) && typeof raw["list"] === "string") {
    const parsed = parseListSource(raw["list"]);
    if (!parsed.ast) {
      reader.fault(`"options.list": ${parsed.problems.join("; ")}`);
      return literalNode("");
    }
    return parsed.ast;
  }
  return reader.value("options", literalNode(""));
}

/** A single studio `action` object, or the new list under `actions`, or both. */
function collectActions(reader: WidgetReader, studioKey: string): WindowAction[] {
  const list = parseActionList(reader.record["actions"], reader, "actions");
  const studio = parseActionList(reader.record[studioKey], reader, studioKey);
  return [...studio, ...list];
}

function parseChildren(raw: unknown, context: ParseContext, where: string, depth: number): ParsedWidget[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    note(context, where, '"children" must be an array');
    return [];
  }
  const siblings = raw.map((entry) => (isRecord(entry) && typeof entry["id"] === "string" ? entry["id"] : ""));
  const children: ParsedWidget[] = [];
  for (const [index, entry] of raw.entries()) {
    const child = parseWidget(entry, context, where, siblings.slice(0, index), siblings, depth);
    if (child) children.push(child);
  }

  // The second half of dropping a widget. `parseAnchor` checks `relativeTo` against the ids the
  // *file* declares, and a widget that was then dropped — an unknown type, a broken expression —
  // leaves whoever anchored to it pointing at nothing. One problem was recorded, for the drop; this
  // is the consequence, and without it М5 has to place the orphan somewhere with no idea why.
  const alive = new Set(children.map((child) => child.id));
  return children.map((child) => {
    const to = child.anchor.relativeTo;
    if (to === "parent" || alive.has(to)) return child;
    note(
      context,
      `${context.module}/${context.windowId}.${child.id}`,
      `the anchor points at "${to}", which was left out of the window above; anchoring to the parent instead`,
    );
    // The cast is the spread of a discriminated union: the copy is the same widget with one nested
    // field replaced, but TypeScript widens `type` across the twelve members when it spreads.
    return { ...child, anchor: { ...child.anchor, relativeTo: "parent" } } as ParsedWidget;
  });
}

/* ---------------------------------------------------------------------------------------------
 * The file
 * ------------------------------------------------------------------------------------------- */

/**
 * What may stay in a `slash` command or a `binding` name.
 *
 * Letters — **any** alphabet's letters — digits, `_` and `-`. The realm is Russian, the studio is
 * Russian, and `/магазин` is the first thing a real file will ask for; nothing downstream objects,
 * because `submitChat` takes whatever follows the slash, lowercases it and looks it up
 * (`Chat.ts:363-390`), Cyrillic included. An ASCII-only filter turned «магазин» into the empty
 * string and «shop-магазин» into a *different, working-looking* `/shop-`, both without a word.
 * Whatever is still dropped — spaces, punctuation, a slash in the middle — is named, so that the
 * author and М9's `modules:check` both see it.
 */
const SLASH_SAFE = /[^\p{L}\p{N}_-]/gu;
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Strips what a command name may not carry, and says so when anything was stripped. */
function sanitised(reader: WidgetReader, key: string, written: string): string {
  const kept = written.replace(SLASH_SAFE, "");
  if (kept !== written) {
    reader.note(`"${key}" is «${written}», and this client keeps «${kept}»: letters, digits, "_" and "-" only`);
  }
  return kept;
}

function parseScreen(raw: unknown, params: Record<string, unknown>, context: ParseContext): ScreenRoot | undefined {
  if (!isRecord(raw)) {
    // The studio saves two things under `kind: "addon"`, told apart by `params.mode`
    // (`server/addon.mjs:38`): a screen of its own, and a set of edits to the client's own frames.
    // The second is a real thing a modder made, so it deserves better than "screen is missing".
    fatal(context, `${context.module}/${context.windowId}`, params["mode"] === "blizzard"
      ? 'this file edits the client\'s own frames ("mode": "blizzard"), which the WebClient reaches through'
        + " named slots and patch files, not through a window definition"
      : '"params.screen" is missing: a window needs a root frame');
    return undefined;
  }
  const type = typeof raw["type"] === "string" ? raw["type"] : "";
  if (type !== "Frame") {
    fatal(
      context,
      `${context.module}/${context.windowId}`,
      `the root of a window has to be a Frame, and this one is "${type}"`,
    );
    return undefined;
  }
  const widget = parseWidget(raw, context, `${context.module}/${context.windowId}`, [], [], 0);
  if (!widget || widget.type !== "Frame") return undefined;

  const reader = new WidgetReader(raw, `${context.module}/${context.windowId}.${widget.id}`, context);
  const screen: ScreenRoot = {
    ...widget,
    strata: reader.choice("strata", STRATAS, "DIALOG"),
    closeButton: reader.boolean("closeButton", false),
    escClose: reader.boolean("escClose", false),
    title: reader.localised("title", ""),
    titleTexture: reader.boolean("titleTexture", false),
    events: parseEvents(raw["events"], reader),
  };
  // The root plays by the same rule as every other widget: an expression that will not parse drops
  // the widget that holds it. The root is the one widget with nothing smaller to drop, so the same
  // fault refuses the window — and it is said out loud, because a title that would not parse used
  // to leave the window standing, and an unparsable `chat` on `PLAYER_LOGIN` used to leave behind
  // an action that posted an empty line every time the event fired.
  if (reader.bad) {
    fatal(context, reader.where, "the fault above is in the root frame's own fields, and there is no root to drop:"
      + " a window without its root frame is a pile of widgets in the corner, so the window is refused");
    return undefined;
  }
  checkPacketInputs(screen, context);
  return screen;
}

/**
 * Says so when «отправить пакет» reads a box that does not publish a number.
 *
 * The one cross-widget check in this file, and it earns its place: the studio's action carries the
 * *id* of an input, this client publishes that input's value under `state.<id>`, and `encodeField`
 * refuses anything but a number for an `f64` (`CustomCodec.ts:270`). Without this the author hears
 * about it as a throw the first time the button is pressed — the exact failure the opcode check two
 * screens up exists to prevent. A `state` key that is no input at all is left alone: the window's
 * own `params.state` holds numbers as often as not, and М6 is what fills it.
 */
function checkPacketInputs(screen: ScreenRoot, context: ParseContext): void {
  const widgets = walkWindowWidgets(screen);
  const inputs = new Map<string, EditBoxWidget>();
  for (const widget of widgets) if (widget.type === "EditBox") inputs.set(widget.state, widget);
  if (inputs.size === 0) return;

  const look = (actions: readonly WindowAction[], where: string): void => {
    for (const action of actions) {
      if (action.do === "if") {
        look(action.then, where);
        look(action.otherwise, where);
        continue;
      }
      if (action.do !== "sendCustomRaw") continue;
      for (const field of action.fields) {
        // Only the numeric kinds: `string` and `cstring` want the text and get it.
        if (field.type.kind === "string" || field.type.kind === "cstring") continue;
        const value = field.value;
        if (value.node !== "path" || value.root !== "state" || value.steps.length !== 1) continue;
        const step = value.steps[0];
        if (!step || !("key" in step)) continue;
        const input = inputs.get(step.key);
        if (!input || input.stateKind === "number") continue;
        note(
          context,
          where,
          `the packet reads "${step.key}", and that box publishes text, not a number;`
          + ` tick «только числа» on «${input.id}» or the field will not encode`,
        );
      }
    }
  };

  const here = (id: string): string => `${context.module}/${context.windowId}.${id}`;
  for (const widget of widgets) look(widgetActions(widget), here(widget.id));
  for (const event of screen.events) look(event.actions, here(screen.id));
}

/**
 * Every action list a widget can carry, whatever its type calls it.
 *
 * Exported for М6's loader, which checks the same lists against the registry — «open of a window
 * nobody defines» and «sendCustom of a message with a field missing» are refusals at load, and a
 * second walk written beside this one would be the thing that forgets a widget type.
 */
export function widgetActions(widget: ParsedWidget): readonly WindowAction[] {
  switch (widget.type) {
    case "Button":
    case "ItemButton":
      return widget.actions;
    case "CheckButton":
    case "Slider":
    case "DropDown":
      return widget.onChange;
    case "EditBox":
      return widget.onEnter;
    default:
      return [];
  }
}

function parseEvents(raw: unknown, reader: WidgetReader): ParsedEvent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    reader.note('"events" must be an array');
    return [];
  }
  const events: ParsedEvent[] = [];
  for (const [index, entry] of raw.entries()) {
    // The studio writes bare names and filters them with /^[A-Z0-9_]+$/ (`addon.mjs:505`); B.3
    // proposes `{event, do}`. Both are read, because the first is what exists on disk today.
    const name = typeof entry === "string" ? entry : isRecord(entry) && typeof entry["event"] === "string" ? entry["event"] : "";
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      reader.note(`events[${index}] is not the name of a game event`);
      continue;
    }
    const actions = isRecord(entry) ? parseActionList(entry["do"], reader, `events[${index}].do`) : [];
    events.push({ event: name, actions });
  }
  return events;
}

function parseState(raw: unknown, reader: WidgetReader): Record<string, ExprNode> {
  if (!isRecord(raw)) return {};
  // Parented, so that a starting value that will not parse reaches the caller's `bad` flag. The
  // window's own state belongs to no widget, so there is nothing to drop but the window.
  const values = new WidgetReader(raw, reader.where, reader.context, reader);
  const state: Record<string, ExprNode> = {};
  for (const key of Object.keys(raw)) state[key] = values.value(key, literalNode(""));
  return state;
}

function parsePackets(raw: unknown): WindowPackets {
  if (!isRecord(raw)) return { enabled: false, opcodeIn: 0, opcodeOut: 0 };
  const opcode = (value: unknown): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff ? value : 0;
  return {
    enabled: raw["enabled"] === true,
    opcodeIn: opcode(raw["opcodeIn"]),
    opcodeOut: opcode(raw["opcodeOut"]),
  };
}

/**
 * Reads one `content/ui/*.json` into a window, or into the reasons it is not one.
 *
 * @param raw the parsed JSON, exactly as the file holds it
 * @param options `module` is the module the file came from; it goes in front of every problem, so
 *   a modder with two modules loaded can tell whose file is complaining.
 */
export function parseWindowDefinition(raw: unknown, options: { readonly module: string }): WindowParse {
  const module = options.module || "?";
  const problems: string[] = [];
  if (!isRecord(raw)) return { problems: [`${module}: a window definition must be a JSON object`] };

  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  const context: ParseContext = {
    module,
    windowId: id || "?",
    problems,
    ids: new Set<string>(),
    defaultOpcode: 0,
    fatal: false,
    widgets: 0,
  };
  const where = `${module}/${context.windowId}`;

  const kind = typeof raw["kind"] === "string" ? raw["kind"] : "";
  if (kind !== "addon") {
    // Both kinds are named because this is where a file that is neither lands: the loader sends
    // `kind: "patch"` to `parseWindowPatch` and everything else here, so the sentence has to say
    // what the two words are rather than only the one this parser wanted.
    fatal(context, where, `"kind" is "${kind}", and this client reads files of kind "addon" (окно) or "patch" (правка)`);
  }
  if (!ID_SHAPE.test(id)) {
    fatal(context, where, `"id" is "${id}", which is not a name a file and a route can carry (letters, digits, "-" and "_")`);
  }
  const format = raw["format"];
  if (format !== undefined && format !== 1) {
    // The version is the escape hatch for a shape the studio does not write yet. Refusing an
    // unknown one is the point of having it: a newer file quietly half-read is worse than absent.
    fatal(context, where, `"format" is ${JSON.stringify(format)}, and this client reads format 1`);
  }

  const params = isRecord(raw["params"]) ? raw["params"] : undefined;
  if (!params) fatal(context, where, '"params" is missing');

  const top = new WidgetReader(raw, where, context);
  const name = top.localised("name", id);
  const enabled = raw["enabled"] !== false;
  const updated = typeof raw["updated"] === "string" ? raw["updated"] : "";

  const paramReader = new WidgetReader(params ?? {}, where, context);
  const packets = parsePackets(params?.["packets"]);
  context.defaultOpcode = packets.opcodeOut;

  const messageSource = params?.["messages"];
  const messages: CustomMessage[] = [];
  if (messageSource !== undefined && messageSource !== null) {
    const parsed = parseCustomMessages(messageSource);
    for (const problem of parsed.problems) {
      // Fatal by the codec's own rule: a schema with a hole decodes every field after the hole from
      // the wrong offset, and this window is the thing that would show those numbers.
      fatal(context, where, `"messages": ${problem}`);
    }
    messages.push(...parsed.messages);
  }

  const slash = sanitised(paramReader, "slash", paramReader.string("slash", "").replace(/^\/+/, "")).toLowerCase();
  const binding = sanitised(paramReader, "binding", paramReader.string("binding", ""));
  const css = paramReader.string("css", "");
  // Bytes, measured as bytes. `String.length` counts UTF-16 code units, and the ceiling it is
  // compared against is the gateway's, which counts the file's real size (`ModuleIndex.ts:90`) — so
  // a 400 KB Cyrillic stylesheet passed here and would have been refused by the route that serves
  // it, with a message quoting a number that was never bytes.
  const cssBytes = new TextEncoder().encode(css).length;
  if (cssBytes > WINDOW_MAX_CSS) {
    fatal(context, where, `"css" is ${cssBytes} bytes, over the ${WINDOW_MAX_CSS} a module file may be`);
  }
  const state = parseState(params?.["state"], paramReader);
  // Neither the window's own name nor its starting state belongs to a widget, so the rule that
  // drops a widget over an expression it cannot read has nothing to drop here but the window.
  if (top.bad || paramReader.bad) {
    fatal(context, where, "the fault above is in the window's own fields, not in any one widget, so the window is refused");
  }

  const screen = params ? parseScreen(params["screen"], params, context) : undefined;
  if (!screen) return { problems };
  if (context.fatal) return { problems };

  const window: ParsedWindow = {
    id, module, name, enabled, format: 1, screen, slash, binding, packets, messages, state, css, updated,
  };
  return { window, problems };
}

/* ---------------------------------------------------------------------------------------------
 * Patches — М7
 * ------------------------------------------------------------------------------------------- */

/** One widget a patch adds, and the named slot of a built-in window it goes into. */
export interface ParsedPatchAdd {
  readonly slot: string;
  readonly widget: ParsedWidget;
}

/**
 * A set of edits to the windows this client wrote itself.
 *
 * The second kind of file under `content/ui/`, told apart from a window by `kind` and by nothing
 * else — see {@link moduleUiKind}. Everything it can do is named: hide a slot, put a widget in one,
 * add a class to a window, and bring a stylesheet for that class. There is no way to reach a node
 * the built-ins have not offered.
 */
export interface ParsedPatch {
  readonly id: string;
  readonly module: string;
  readonly enabled: boolean;
  readonly format: 1;
  /** Which built-in window this patch is about. Says what it is; the slot names say what it does. */
  readonly target: string;
  readonly hide: readonly string[];
  readonly add: readonly ParsedPatchAdd[];
  /** Window id → the class names to put on it. */
  readonly classes: Readonly<Record<string, string>>;
  readonly css: string;
  readonly updated: string;
}

export interface PatchParse {
  readonly patch?: ParsedPatch;
  readonly problems: readonly string[];
}

/**
 * Which of the two things a `content/ui/*.json` is, without parsing it.
 *
 * The gateway's index lists every json under `ui/` and says nothing about what is in one, so the
 * loader has to look. `""` for anything else, which the window parser then refuses by name — the
 * message an author needs is «kind is "screen", and this client reads "addon" or "patch"», and it
 * is `parseWindowDefinition` that already writes it.
 */
export function moduleUiKind(raw: unknown): "addon" | "patch" | "" {
  if (!isRecord(raw)) return "";
  const kind = raw["kind"];
  return kind === "addon" || kind === "patch" ? kind : "";
}

/**
 * Reads one patch file, or the reasons it is not one.
 *
 * The three levels are the window parser's, applied to a smaller thing. Fatal — no patch comes
 * back — is anything that makes the *set* of edits ambiguous: the wrong `kind`, an id a route
 * cannot carry, a `format` from a newer studio, a missing `target`, a `class` map that is not one.
 * A single bad widget under `add` is dropped and named, exactly as a bad widget in a window is,
 * because the other edits are still a thing the author asked for. And a patch that does nothing at
 * all is loaded with a word: `modules:check` (М9) turns any recorded problem into a build failure,
 * so «noted» still reaches the author.
 *
 * What is *not* checked here is whether the slots it names exist: that answer belongs to the
 * client's own slot table and the loader makes it, so that this file stays free of the interface.
 */
export function parseWindowPatch(raw: unknown, options: { readonly module: string }): PatchParse {
  const module = options.module || "?";
  const problems: string[] = [];
  if (!isRecord(raw)) return { problems: [`${module}: a patch file must be a JSON object`] };

  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  const context: ParseContext = {
    module,
    windowId: id || "?",
    problems,
    ids: new Set<string>(),
    // A patch has no `packets` block of its own, so `sendCustomRaw` with no opcode is refused by
    // the same line that refuses one in a window with no outbound opcode.
    defaultOpcode: 0,
    fatal: false,
    widgets: 0,
  };
  const where = `${module}/${context.windowId}`;

  if (raw["kind"] !== "patch") {
    fatal(context, where, `"kind" is "${String(raw["kind"] ?? "")}", and this client reads patches of kind "patch"`);
  }
  if (!ID_SHAPE.test(id)) {
    fatal(context, where, `"id" is "${id}", which is not a name a file and a route can carry (letters, digits, "-" and "_")`);
  }
  const format = raw["format"];
  if (format !== undefined && format !== 1) {
    fatal(context, where, `"format" is ${JSON.stringify(format)}, and this client reads format 1`);
  }

  const target = typeof raw["target"] === "string" ? raw["target"] : "";
  if (!target) fatal(context, where, '"target" is missing: a patch says which built-in window it edits');

  const reader = new WidgetReader(raw, where, context);
  const hide = parsePatchNames(raw["hide"], reader, "hide");
  const add = parsePatchAdds(raw["add"], context, where);
  const classes = parsePatchClasses(raw["class"], reader);
  const css = reader.string("css", "");
  const cssBytes = new TextEncoder().encode(css).length;
  if (cssBytes > WINDOW_MAX_CSS) {
    fatal(context, where, `"css" is ${cssBytes} bytes, over the ${WINDOW_MAX_CSS} a module file may be`);
  }
  if (reader.bad) {
    fatal(context, where, "the fault above is in the patch's own fields, and a patch has no widget to drop instead");
  }
  if (context.fatal) return { problems };

  if (hide.length === 0 && add.length === 0 && Object.keys(classes).length === 0 && !css) {
    note(context, where, "the patch changes nothing: it names no slot to hide, no widget to add and no class to set");
  }

  const patch: ParsedPatch = {
    id,
    module,
    enabled: raw["enabled"] !== false,
    format: 1,
    target,
    hide,
    add,
    classes,
    css,
    updated: typeof raw["updated"] === "string" ? raw["updated"] : "",
  };
  return { patch, problems };
}

/** `hide: [...]`: a list of slot names, with anything that is not a string named and dropped. */
function parsePatchNames(raw: unknown, reader: WidgetReader, key: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    reader.note(`"${key}" must be an array of slot names`);
    return [];
  }
  const names: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || !entry) {
      reader.note(`${key}[${index}] is not the name of a slot`);
      continue;
    }
    if (names.includes(entry)) {
      reader.note(`${key} names "${entry}" twice`);
      continue;
    }
    names.push(entry);
  }
  return names;
}

function parsePatchAdds(raw: unknown, context: ParseContext, where: string): ParsedPatchAdd[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    note(context, where, '"add" must be an array of {slot, widget}');
    return [];
  }
  const adds: ParsedPatchAdd[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      note(context, where, `add[${index}] must be an object with "slot" and "widget"`);
      continue;
    }
    const slot = typeof entry["slot"] === "string" ? entry["slot"] : "";
    if (!slot) {
      note(context, where, `add[${index}] has no "slot": a widget has to say where it goes`);
      continue;
    }
    // The same reader every widget in a window goes through, with no siblings and no earlier
    // widget to anchor to — a slot holds one subtree, and `parseAnchor` refuses anything but
    // "parent" as a result. Ids are unique across the whole patch: an action naming a widget has
    // to have one answer, and the runtime finds one by `data-widget` inside the subtree.
    const widget = parseWidget(entry["widget"], context, `${where}.add[${index}]`, [], [], 0);
    if (!widget) continue;
    adds.push({ slot, widget });
  }
  return adds;
}

function parsePatchClasses(raw: unknown, reader: WidgetReader): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    reader.fault('"class" must be an object of {"<окно>": "<класс>"}');
    return {};
  }
  const classes: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !value.trim()) {
      reader.note(`class["${id}"] is not a class name`);
      continue;
    }
    // Letters, digits, `_` and `-`, because the name is written straight into a class attribute and
    // read back out of a stylesheet. A `.` or a space in it would be two classes wearing one name,
    // and a `"` would be a way out of the attribute.
    const kept = value.trim().split(/\s+/).filter((name) => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name));
    if (kept.length === 0) {
      reader.note(`class["${id}"] is «${value}», and none of it is a class name a stylesheet can carry`);
      continue;
    }
    if (kept.join(" ") !== value.trim()) {
      reader.note(`class["${id}"] is «${value}», and this client keeps «${kept.join(" ")}»`);
    }
    classes[id] = kept.join(" ");
  }
  return classes;
}

/** Every widget a patch adds, across all of its slots, in declaration order. */
export function patchWidgets(patch: ParsedPatch): ParsedWidget[] {
  return patch.add.flatMap((entry) => walkWindowWidgets(entry.widget));
}

/* ---------------------------------------------------------------------------------------------
 * Walking a parsed window
 * ------------------------------------------------------------------------------------------- */

/** Every widget of a window, root first, in declaration order. */
export function walkWindowWidgets(root: ParsedWidget): ParsedWidget[] {
  const list: ParsedWidget[] = [];
  const walk = (widget: ParsedWidget): void => {
    list.push(widget);
    for (const child of widget.children) walk(child);
  };
  walk(root);
  return list;
}
