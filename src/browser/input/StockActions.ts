/**
 * The stock commands this client answers beyond its original table (WORK_PLAN 3.11, М-A5-3).
 *
 * Bindings.xml of build 12340 has 275 commands; the native table (`CORE_ACTIONS` in Bindings.ts)
 * answered 99 of them. Each row here is one more: the WebClient action name, the Bindings.xml
 * command it is, the native window's group and label. A row is added only together with its verb
 * in `Actions.ts` — a key that can be bound but does nothing is worse than no row.
 *
 * Keys are never invented: a row's default is what `Data/<locale>/WTF/DefaultBindings.wtf` ships on
 * its command (`src/generated/stockBindings.ts`), translated to this table's chords. A stock key is
 * left off when this client cannot hold it or must not take it:
 *  - mouse buttons and the wheel (`BUTTON*`, `MOUSEWHEEL*`): the table holds keyboard chords only;
 *  - `F12`: the browser's developer tools (NativeAppShell keeps it the developer's way out);
 *  - a chord a core action already ships on (`G`, `F`, `K`, `O`, `B`, `Shift+B`): moving those is
 *    the default-layout decision 0.4g (WORK_PLAN 4.11), not this item's — until the owner rules,
 *    the core action keeps the key and the stock row ships unbound ({@link STOCK_DEFAULTS_HELD}).
 *
 * DOM-free and import-free beyond the generated table, so Bindings.ts can build on it.
 */

import { STOCK_BINDING_COMMANDS, STOCK_DEFAULT_KEYS } from "../../generated/stockBindings.js";

export interface StockActionRow {
  readonly action: string;
  /** The Bindings.xml command (`TARGETPARTYMEMBER1`). */
  readonly command: string;
  readonly group: string;
  readonly label: string;
}

/** Every stock row, in the order the native window lists them within their groups. */
export const STOCK_ACTIONS = [
  { action: "toggleSheath", command: "TOGGLESHEATH", group: "Движение", label: "Достать / убрать оружие" },
  // 5.09: held, not pressed — Movement.ts integrates them in water and in flight (HELD_ACTIONS).
  { action: "pitchUp", command: "PITCHUP", group: "Движение", label: "Наклон вверх" },
  { action: "pitchDown", command: "PITCHDOWN", group: "Движение", label: "Наклон вниз" },
  // 5.18: FollowUnit("target") (input/FollowCommand.ts); DefaultBindings.wtf ships it unbound.
  { action: "followTarget", command: "FOLLOWTARGET", group: "Движение", label: "Следовать за целью" },

  // L2 3.11: the TargetNearest* family's other modes and the history keys (game/Targeting.ts,
  // game/TargetLast.ts). Ctrl+Tab and Ctrl+Shift+Tab belong to the browser's tab switch in Chrome and
  // reach the game only in Electron; TARGETLASTHOSTILE's G is the interact key here until 0.4g.
  { action: "targetNearestFriend", command: "TARGETNEARESTFRIEND", group: "Цель", label: "Ближайший союзник" }, // L2 3.11
  { action: "targetPreviousFriend", command: "TARGETPREVIOUSFRIEND", group: "Цель", label: "Предыдущий союзник" }, // L2 3.11
  { action: "targetNearestEnemyPlayer", command: "TARGETNEARESTENEMYPLAYER", group: "Цель", label: "Ближайший игрок-противник" }, // L2 3.11
  { action: "targetPreviousEnemyPlayer", command: "TARGETPREVIOUSENEMYPLAYER", group: "Цель", label: "Предыдущий игрок-противник" }, // L2 3.11
  { action: "targetNearestFriendPlayer", command: "TARGETNEARESTFRIENDPLAYER", group: "Цель", label: "Ближайший игрок-союзник" }, // L2 3.11
  { action: "targetPreviousFriendPlayer", command: "TARGETPREVIOUSFRIENDPLAYER", group: "Цель", label: "Предыдущий игрок-союзник" }, // L2 3.11
  { action: "targetLastHostile", command: "TARGETLASTHOSTILE", group: "Цель", label: "Последний противник" }, // L2 3.11
  { action: "targetLastTarget", command: "TARGETLASTTARGET", group: "Цель", label: "Последняя цель" }, // L2 3.11
  { action: "assistTarget", command: "ASSISTTARGET", group: "Цель", label: "Цель цели (помощь)" },
  { action: "targetFocus", command: "TARGETFOCUS", group: "Цель", label: "Выбрать фокус" },
  { action: "targetMouseover", command: "TARGETMOUSEOVER", group: "Цель", label: "Выбрать под курсором" },
  { action: "targetPet", command: "TARGETPET", group: "Цель", label: "Выбрать питомца" },
  { action: "targetPartyMember1", command: "TARGETPARTYMEMBER1", group: "Цель", label: "Участник группы 1" },
  { action: "targetPartyMember2", command: "TARGETPARTYMEMBER2", group: "Цель", label: "Участник группы 2" },
  { action: "targetPartyMember3", command: "TARGETPARTYMEMBER3", group: "Цель", label: "Участник группы 3" },
  { action: "targetPartyMember4", command: "TARGETPARTYMEMBER4", group: "Цель", label: "Участник группы 4" },
  { action: "targetPartyPet1", command: "TARGETPARTYPET1", group: "Цель", label: "Питомец участника 1" },
  { action: "targetPartyPet2", command: "TARGETPARTYPET2", group: "Цель", label: "Питомец участника 2" },
  { action: "targetPartyPet3", command: "TARGETPARTYPET3", group: "Цель", label: "Питомец участника 3" },
  { action: "targetPartyPet4", command: "TARGETPARTYPET4", group: "Цель", label: "Питомец участника 4" },
  { action: "friendNamePlates", command: "FRIENDNAMEPLATES", group: "Цель", label: "Таблички союзников" },
  { action: "allNamePlates", command: "ALLNAMEPLATES", group: "Цель", label: "Все таблички" },
  { action: "startAttack", command: "STARTATTACK", group: "Цель", label: "Начать атаку" },
  { action: "stopAttack", command: "STOPATTACK", group: "Цель", label: "Прекратить атаку" },
  { action: "stopCasting", command: "STOPCASTING", group: "Цель", label: "Прервать заклинание" },

  { action: "toggleBackpack", command: "TOGGLEBACKPACK", group: "Интерфейс", label: "Рюкзак" },
  // Bindings.xml: TOGGLEBAG1 is ToggleBag(4) … TOGGLEBAG4 is ToggleBag(1) — F8 opens the fourth
  // container; the labels are the stock BINDING_NAME_TOGGLEBAGn («Сумка 1» for TOGGLEBAG1).
  { action: "toggleBag1", command: "TOGGLEBAG1", group: "Интерфейс", label: "Сумка 1" },
  { action: "toggleBag2", command: "TOGGLEBAG2", group: "Интерфейс", label: "Сумка 2" },
  { action: "toggleBag3", command: "TOGGLEBAG3", group: "Интерфейс", label: "Сумка 3" },
  { action: "toggleBag4", command: "TOGGLEBAG4", group: "Интерфейс", label: "Сумка 4" },
  { action: "toggleReputation", command: "TOGGLECHARACTER2", group: "Интерфейс", label: "Репутация" },
  { action: "toggleSocial", command: "TOGGLESOCIAL", group: "Интерфейс", label: "Общение" },
  { action: "toggleWorldStateScores", command: "TOGGLEWORLDSTATESCORES", group: "Интерфейс", label: "Счёт поля боя" },
  { action: "minimapZoomIn", command: "MINIMAPZOOMIN", group: "Интерфейс", label: "Миникарта: приблизить" },
  { action: "minimapZoomOut", command: "MINIMAPZOOMOUT", group: "Интерфейс", label: "Миникарта: отдалить" },
  { action: "toggleMinimapRotation", command: "TOGGLEMINIMAPROTATION", group: "Интерфейс", label: "Вращение миникарты" },

  { action: "previousActionPage", command: "PREVIOUSACTIONPAGE", group: "Панель команд", label: "Предыдущая страница" },
  { action: "nextActionPage", command: "NEXTACTIONPAGE", group: "Панель команд", label: "Следующая страница" },
  // BonusActionButtonDown(id) is PetActionButtonDown(id) (BonusActionBarFrame.lua:96): the pet bar.
  { action: "bonusAction1", command: "BONUSACTIONBUTTON1", group: "Панель питомца", label: "Кнопка питомца 1" },
  { action: "bonusAction2", command: "BONUSACTIONBUTTON2", group: "Панель питомца", label: "Кнопка питомца 2" },
  { action: "bonusAction3", command: "BONUSACTIONBUTTON3", group: "Панель питомца", label: "Кнопка питомца 3" },
  { action: "bonusAction4", command: "BONUSACTIONBUTTON4", group: "Панель питомца", label: "Кнопка питомца 4" },
  { action: "bonusAction5", command: "BONUSACTIONBUTTON5", group: "Панель питомца", label: "Кнопка питомца 5" },
  { action: "bonusAction6", command: "BONUSACTIONBUTTON6", group: "Панель питомца", label: "Кнопка питомца 6" },
  { action: "bonusAction7", command: "BONUSACTIONBUTTON7", group: "Панель питомца", label: "Кнопка питомца 7" },
  { action: "bonusAction8", command: "BONUSACTIONBUTTON8", group: "Панель питомца", label: "Кнопка питомца 8" },
  { action: "bonusAction9", command: "BONUSACTIONBUTTON9", group: "Панель питомца", label: "Кнопка питомца 9" },
  { action: "bonusAction10", command: "BONUSACTIONBUTTON10", group: "Панель питомца", label: "Кнопка питомца 10" },
  // ShapeshiftBar_ChangeForm(id) is CastShapeshiftForm(id) (BonusActionBarFrame.lua:194).
  { action: "shapeshift1", command: "SHAPESHIFTBUTTON1", group: "Панель стоек и форм", label: "Стойка / форма 1" },
  { action: "shapeshift2", command: "SHAPESHIFTBUTTON2", group: "Панель стоек и форм", label: "Стойка / форма 2" },
  { action: "shapeshift3", command: "SHAPESHIFTBUTTON3", group: "Панель стоек и форм", label: "Стойка / форма 3" },
  { action: "shapeshift4", command: "SHAPESHIFTBUTTON4", group: "Панель стоек и форм", label: "Стойка / форма 4" },
  { action: "shapeshift5", command: "SHAPESHIFTBUTTON5", group: "Панель стоек и форм", label: "Стойка / форма 5" },
  { action: "shapeshift6", command: "SHAPESHIFTBUTTON6", group: "Панель стоек и форм", label: "Стойка / форма 6" },
  { action: "shapeshift7", command: "SHAPESHIFTBUTTON7", group: "Панель стоек и форм", label: "Стойка / форма 7" },
  { action: "shapeshift8", command: "SHAPESHIFTBUTTON8", group: "Панель стоек и форм", label: "Стойка / форма 8" },
  { action: "shapeshift9", command: "SHAPESHIFTBUTTON9", group: "Панель стоек и форм", label: "Стойка / форма 9" },
  { action: "shapeshift10", command: "SHAPESHIFTBUTTON10", group: "Панель стоек и форм", label: "Стойка / форма 10" },

  // 11.02-input: Bindings.xml's VEHICLE section (BINDING_HEADER_VEHICLE, BINDING_NAME_VEHICLE*); verbs in
  // VehicleVerbs.ts. DefaultBindings.wtf of 12340 gives none of them a key, so they ship unbound. The two
  // aim keys are held (runOnUp): VehicleAimUpStart/Stop are PitchUpStart/Stop (Bindings.heldMovementAction).
  { action: "vehicleExit", command: "VEHICLEEXIT", group: "Управление транспортом", label: "Спрыгнуть" },
  { action: "vehiclePrevSeat", command: "VEHICLEPREVSEAT", group: "Управление транспортом", label: "Предыдущее сиденье" },
  { action: "vehicleNextSeat", command: "VEHICLENEXTSEAT", group: "Управление транспортом", label: "Следующее сиденье" },
  { action: "vehicleAimUp", command: "VEHICLEAIMUP", group: "Управление транспортом", label: "Прицел вверх" },
  { action: "vehicleAimDown", command: "VEHICLEAIMDOWN", group: "Управление транспортом", label: "Прицел вниз" },
  { action: "vehicleAimIncrement", command: "VEHICLEAIMINCREMENT", group: "Управление транспортом", label: "Приподнять прицел" },
  { action: "vehicleAimDecrement", command: "VEHICLEAIMDECREMENT", group: "Управление транспортом", label: "Опустить прицел" },
  { action: "vehicleCameraZoomIn", command: "VEHICLECAMERAZOOMIN", group: "Управление транспортом", label: "Приближение камеры" },
  { action: "vehicleCameraZoomOut", command: "VEHICLECAMERAZOOMOUT", group: "Управление транспортом", label: "Отдаление камеры" },

  // DEC-B 3.11: Bindings.xml's CAMERA section (BINDING_HEADER_CAMERA «Обзор», BINDING_NAME_*); verbs over
  // game/CameraViews.ts. DefaultBindings.wtf gives End to NEXTVIEW and Home to PREVVIEW and nothing to the
  // rest. CAMERAZOOMIN/OUT are the wheel's (MOUSEWHEELUP/DOWN), which the table does not hold.
  { action: "nextView", command: "NEXTVIEW", group: "Обзор", label: "Следующий ракурс" }, // DEC-B 3.11
  { action: "prevView", command: "PREVVIEW", group: "Обзор", label: "Предыдущий ракурс" }, // DEC-B 3.11
  { action: "setView1", command: "SETVIEW1", group: "Обзор", label: "Восстановить ракурс 1" }, // DEC-B 3.11
  { action: "setView2", command: "SETVIEW2", group: "Обзор", label: "Восстановить ракурс 2" }, // DEC-B 3.11
  { action: "setView3", command: "SETVIEW3", group: "Обзор", label: "Восстановить ракурс 3" }, // DEC-B 3.11
  { action: "setView4", command: "SETVIEW4", group: "Обзор", label: "Восстановить ракурс 4" }, // DEC-B 3.11
  { action: "setView5", command: "SETVIEW5", group: "Обзор", label: "Восстановить ракурс 5" }, // DEC-B 3.11
  { action: "saveView1", command: "SAVEVIEW1", group: "Обзор", label: "Сохранить ракурс 1" }, // DEC-B 3.11
  { action: "saveView2", command: "SAVEVIEW2", group: "Обзор", label: "Сохранить ракурс 2" }, // DEC-B 3.11
  { action: "saveView3", command: "SAVEVIEW3", group: "Обзор", label: "Сохранить ракурс 3" }, // DEC-B 3.11
  { action: "saveView4", command: "SAVEVIEW4", group: "Обзор", label: "Сохранить ракурс 4" }, // DEC-B 3.11
  { action: "saveView5", command: "SAVEVIEW5", group: "Обзор", label: "Сохранить ракурс 5" }, // DEC-B 3.11
  { action: "resetView1", command: "RESETVIEW1", group: "Обзор", label: "Сбросить ракурс 1" }, // DEC-B 3.11
  { action: "resetView2", command: "RESETVIEW2", group: "Обзор", label: "Сбросить ракурс 2" }, // DEC-B 3.11
  { action: "resetView3", command: "RESETVIEW3", group: "Обзор", label: "Сбросить ракурс 3" }, // DEC-B 3.11
  { action: "resetView4", command: "RESETVIEW4", group: "Обзор", label: "Сбросить ракурс 4" }, // DEC-B 3.11
  { action: "resetView5", command: "RESETVIEW5", group: "Обзор", label: "Сбросить ракурс 5" }, // DEC-B 3.11
  { action: "flipCameraYaw", command: "FLIPCAMERAYAW", group: "Обзор", label: "Переключение камеры" }, // DEC-B 3.11
] as const satisfies readonly StockActionRow[];

export type StockAction = (typeof STOCK_ACTIONS)[number]["action"];

const STOCK_ACTION_NAMES: ReadonlySet<string> = new Set(STOCK_ACTIONS.map((row) => row.action));

/**
 * Whether `action` is one of the rows above. In the world such a key is the game's even when its
 * verb finds nothing to do (no fifth form, an empty pet slot, no party member): Ctrl+F5, Ctrl+1 or
 * F11 must not fall through to the browser's reload, tab switch or full screen (`Controls.ts`).
 */
export function isStockAction(action: string): boolean {
  return STOCK_ACTION_NAMES.has(action);
}

/** Stock keys the table cannot hold or must leave alone, and why (see the module comment). */
export const STOCK_KEYS_LEFT_OFF: Readonly<Record<string, string>> = {
  F12: "the browser's developer tools",
};

/**
 * The stock defaults a core action holds until decision 0.4g (WORK_PLAN 4.11): command → the key
 * the core action keeps. Filled by {@link stockDefaultBindings}, read by the tests and the plan.
 */
export const STOCK_DEFAULTS_HELD = new Map<string, string>();

const MODIFIERS = [["ALT-", "Alt"], ["CTRL-", "Ctrl"], ["SHIFT-", "Shift"]] as const;
const NAMED_KEYS: Readonly<Record<string, string>> = {
  SPACE: "Space", ENTER: "Enter", TAB: "Tab", BACKSPACE: "Backspace", INSERT: "Insert", DELETE: "Delete",
  HOME: "Home", END: "End", PAGEUP: "PageUp", PAGEDOWN: "PageDown", UP: "ArrowUp", DOWN: "ArrowDown",
  LEFT: "ArrowLeft", RIGHT: "ArrowRight", NUMLOCK: "NumLock", CAPSLOCK: "CapsLock", SCROLLLOCK: "ScrollLock",
  PAUSE: "Pause", PRINTSCREEN: "PrintScreen", NUMPADDECIMAL: "NumpadDecimal", NUMPADDIVIDE: "NumpadDivide",
  NUMPADMULTIPLY: "NumpadMultiply", NUMPADMINUS: "NumpadSubtract", NUMPADPLUS: "NumpadAdd",
  "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
  ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash",
};

/**
 * A DefaultBindings.wtf key (`CTRL-SHIFT-TAB`, `SHIFT--`) as this table's chord (`Ctrl+Shift+Tab`),
 * modifiers in `chordOf`'s Ctrl, Alt, Shift order; undefined for a mouse button, the wheel, Escape
 * or a name this client has no key for. The same names `FrameXmlBinding.frameXmlKeyToChord` reads
 * (a test holds the two to each other); kept here so the input layer does not import FrameXML.
 */
export function clientKeyToChord(key: string): string | undefined {
  let rest = key.toUpperCase();
  const held = new Set<string>();
  for (let matched = true; matched;) {
    matched = false;
    for (const [prefix, name] of MODIFIERS) {
      if (rest.length > prefix.length && rest.startsWith(prefix) && !held.has(name)) {
        held.add(name);
        rest = rest.slice(prefix.length);
        matched = true;
      }
    }
  }
  let code: string | undefined;
  if (/^[A-Z]$/.test(rest)) code = `Key${rest}`;
  else if (/^[0-9]$/.test(rest)) code = `Digit${rest}`;
  else if (/^NUMPAD[0-9]$/.test(rest)) code = `Numpad${rest.slice(6)}`;
  else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(rest)) code = rest;
  else code = NAMED_KEYS[rest];
  if (!code) return undefined;
  return [...["Ctrl", "Alt", "Shift"].filter((name) => held.has(name)), code].join("+");
}

/**
 * The stock rows' defaults: up to two keyboard chords from DefaultBindings.wtf each, less the keys
 * left off and the chords `taken` (the core table's defaults). Every chord appears once.
 */
export function stockDefaultBindings(taken: ReadonlySet<string>): Record<StockAction, readonly [string, string]> {
  STOCK_DEFAULTS_HELD.clear();
  const used = new Set(taken);
  const result = {} as Record<StockAction, readonly [string, string]>;
  for (const row of STOCK_ACTIONS) {
    const chords: string[] = [];
    for (const key of STOCK_DEFAULT_KEYS[row.command] ?? []) {
      if (STOCK_KEYS_LEFT_OFF[key.toUpperCase()] !== undefined) continue;
      const chord = clientKeyToChord(key);
      if (!chord) continue;
      if (used.has(chord)) {
        if (taken.has(chord)) STOCK_DEFAULTS_HELD.set(row.command, chord);
        continue;
      }
      if (chords.length < 2) {
        chords.push(chord);
        used.add(chord);
      }
    }
    result[row.action] = [chords[0] ?? "", chords[1] ?? ""];
  }
  return result;
}

const XML_ORDER = new Map(STOCK_BINDING_COMMANDS.map((command, index) => [command.name, index]));
const XML_HEADER = new Map(STOCK_BINDING_COMMANDS.map((command) => [command.name, command.header]));

/**
 * The stock key bindings window's sections with the rows of {@link STOCK_ACTIONS} put where
 * Bindings.xml has them: each into the section of its own `header`, every section's rows in the
 * file's order (`GetBinding(i)` walks them so, and KeyBindingFrame groups by the headers). A row
 * whose section is not listed is left out here and stays a WebClient row.
 */
export function withStockRows<Action extends string>(
  sections: readonly { readonly header: string; readonly rows: readonly (readonly [command: string, action: Action])[] }[],
  extra: readonly { readonly command: string; readonly action: Action }[],
): { readonly header: string; readonly rows: readonly (readonly [command: string, action: Action])[] }[] {
  const order = (command: string): number => XML_ORDER.get(command) ?? Number.MAX_SAFE_INTEGER;
  return sections.map((section) => {
    const added = extra.filter((row) => XML_HEADER.get(row.command) === section.header)
      .map((row) => [row.command, row.action] as const);
    if (added.length === 0) return section;
    return { header: section.header, rows: [...section.rows, ...added].sort((a, b) => order(a[0]) - order(b[0])) };
  });
}
