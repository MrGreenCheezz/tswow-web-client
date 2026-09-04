/**
 * One table of action to key, and the only place a key code appears.
 *
 * Every binding this client had was an `event.code === "KeyB"` inside a handler, which is how
 * eleven actions were reached and why none of them could be changed. Collecting them here is
 * cheaper now than assembling them out of twenty files later, and it is what makes a bindings
 * window forty lines rather than a rewrite.
 *
 * There is no DOM here and no game state: a chord is a string, a binding is a pair of strings,
 * and everything that acts on one lives in `Actions.ts`. That is what lets this be tested.
 */

/** Everything the keyboard can ask for. The order is the order the bindings window lists them. */
export const INPUT_ACTIONS = [
  { action: "moveForward", group: "Движение", label: "Вперёд" },
  { action: "moveBackward", group: "Движение", label: "Назад" },
  { action: "turnLeft", group: "Движение", label: "Поворот влево" },
  { action: "turnRight", group: "Движение", label: "Поворот вправо" },
  { action: "strafeLeft", group: "Движение", label: "Шаг влево" },
  { action: "strafeRight", group: "Движение", label: "Шаг вправо" },
  { action: "jump", group: "Движение", label: "Прыжок" },
  { action: "toggleAutoRun", group: "Движение", label: "Автобег" },
  { action: "toggleWalkRun", group: "Движение", label: "Ходьба / бег" },
  { action: "sitOrStand", group: "Движение", label: "Сесть / встать" },

  { action: "targetNearestEnemy", group: "Цель", label: "Ближайший враг" },
  { action: "targetPreviousEnemy", group: "Цель", label: "Предыдущий враг" },
  { action: "targetSelf", group: "Цель", label: "Выбрать себя" },
  { action: "setFocus", group: "Цель", label: "Фокус" },
  { action: "interact", group: "Цель", label: "Взаимодействовать" },
  { action: "toggleNamePlates", group: "Цель", label: "Таблички над врагами" },
  { action: "attackTarget", group: "Цель", label: "Атака" },

  { action: "toggleCharacter", group: "Интерфейс", label: "Лист персонажа" },
  { action: "toggleBags", group: "Интерфейс", label: "Сумки" },
  { action: "toggleKeyring", group: "Интерфейс", label: "Брелок" },
  { action: "toggleSpellbook", group: "Интерфейс", label: "Книга заклинаний" },
  { action: "togglePvp", group: "Интерфейс", label: "PvP" },
  { action: "toggleTalents", group: "Интерфейс", label: "Таланты" },
  { action: "toggleProfessions", group: "Интерфейс", label: "Навыки" },
  { action: "toggleQuestLog", group: "Интерфейс", label: "Журнал заданий" },
  { action: "toggleWorldMap", group: "Интерфейс", label: "Карта мира" },
  { action: "toggleDiagnostics", group: "Интерфейс", label: "Диагностика" },
  { action: "toggleKeyBindings", group: "Интерфейс", label: "Привязки клавиш" },
  { action: "openChat", group: "Интерфейс", label: "Чат" },

  { action: "action1", group: "Панель команд", label: "Слот 1" },
  { action: "action2", group: "Панель команд", label: "Слот 2" },
  { action: "action3", group: "Панель команд", label: "Слот 3" },
  { action: "action4", group: "Панель команд", label: "Слот 4" },
  { action: "action5", group: "Панель команд", label: "Слот 5" },
  { action: "action6", group: "Панель команд", label: "Слот 6" },
  { action: "action7", group: "Панель команд", label: "Слот 7" },
  { action: "action8", group: "Панель команд", label: "Слот 8" },
  { action: "action9", group: "Панель команд", label: "Слот 9" },
  { action: "action10", group: "Панель команд", label: "Слот 10" },
  { action: "action11", group: "Панель команд", label: "Слот 11" },
  { action: "action12", group: "Панель команд", label: "Слот 12" },
  { action: "actionPage1", group: "Панель команд", label: "Страница 1" },
  { action: "actionPage2", group: "Панель команд", label: "Страница 2" },
  { action: "actionPage3", group: "Панель команд", label: "Страница 3" },
  { action: "actionPage4", group: "Панель команд", label: "Страница 4" },
  { action: "actionPage5", group: "Панель команд", label: "Страница 5" },
  { action: "actionPage6", group: "Панель команд", label: "Страница 6" },

  /* The four bars the original client stacks beside the main one. No defaults, as it ships
     them: 1 through = belong to the main bar and the rest are the player's to choose. Without
     these the extra bars exist but cannot be reached from the keyboard at all. */
  { action: "bottomLeftAction1", group: "Панель: Нижняя левая", label: "Слот 1" },
  { action: "bottomLeftAction2", group: "Панель: Нижняя левая", label: "Слот 2" },
  { action: "bottomLeftAction3", group: "Панель: Нижняя левая", label: "Слот 3" },
  { action: "bottomLeftAction4", group: "Панель: Нижняя левая", label: "Слот 4" },
  { action: "bottomLeftAction5", group: "Панель: Нижняя левая", label: "Слот 5" },
  { action: "bottomLeftAction6", group: "Панель: Нижняя левая", label: "Слот 6" },
  { action: "bottomLeftAction7", group: "Панель: Нижняя левая", label: "Слот 7" },
  { action: "bottomLeftAction8", group: "Панель: Нижняя левая", label: "Слот 8" },
  { action: "bottomLeftAction9", group: "Панель: Нижняя левая", label: "Слот 9" },
  { action: "bottomLeftAction10", group: "Панель: Нижняя левая", label: "Слот 10" },
  { action: "bottomLeftAction11", group: "Панель: Нижняя левая", label: "Слот 11" },
  { action: "bottomLeftAction12", group: "Панель: Нижняя левая", label: "Слот 12" },

  { action: "bottomRightAction1", group: "Панель: Нижняя правая", label: "Слот 1" },
  { action: "bottomRightAction2", group: "Панель: Нижняя правая", label: "Слот 2" },
  { action: "bottomRightAction3", group: "Панель: Нижняя правая", label: "Слот 3" },
  { action: "bottomRightAction4", group: "Панель: Нижняя правая", label: "Слот 4" },
  { action: "bottomRightAction5", group: "Панель: Нижняя правая", label: "Слот 5" },
  { action: "bottomRightAction6", group: "Панель: Нижняя правая", label: "Слот 6" },
  { action: "bottomRightAction7", group: "Панель: Нижняя правая", label: "Слот 7" },
  { action: "bottomRightAction8", group: "Панель: Нижняя правая", label: "Слот 8" },
  { action: "bottomRightAction9", group: "Панель: Нижняя правая", label: "Слот 9" },
  { action: "bottomRightAction10", group: "Панель: Нижняя правая", label: "Слот 10" },
  { action: "bottomRightAction11", group: "Панель: Нижняя правая", label: "Слот 11" },
  { action: "bottomRightAction12", group: "Панель: Нижняя правая", label: "Слот 12" },

  { action: "rightAction1", group: "Панель: Правая", label: "Слот 1" },
  { action: "rightAction2", group: "Панель: Правая", label: "Слот 2" },
  { action: "rightAction3", group: "Панель: Правая", label: "Слот 3" },
  { action: "rightAction4", group: "Панель: Правая", label: "Слот 4" },
  { action: "rightAction5", group: "Панель: Правая", label: "Слот 5" },
  { action: "rightAction6", group: "Панель: Правая", label: "Слот 6" },
  { action: "rightAction7", group: "Панель: Правая", label: "Слот 7" },
  { action: "rightAction8", group: "Панель: Правая", label: "Слот 8" },
  { action: "rightAction9", group: "Панель: Правая", label: "Слот 9" },
  { action: "rightAction10", group: "Панель: Правая", label: "Слот 10" },
  { action: "rightAction11", group: "Панель: Правая", label: "Слот 11" },
  { action: "rightAction12", group: "Панель: Правая", label: "Слот 12" },

  { action: "right2Action1", group: "Панель: Правая вторая", label: "Слот 1" },
  { action: "right2Action2", group: "Панель: Правая вторая", label: "Слот 2" },
  { action: "right2Action3", group: "Панель: Правая вторая", label: "Слот 3" },
  { action: "right2Action4", group: "Панель: Правая вторая", label: "Слот 4" },
  { action: "right2Action5", group: "Панель: Правая вторая", label: "Слот 5" },
  { action: "right2Action6", group: "Панель: Правая вторая", label: "Слот 6" },
  { action: "right2Action7", group: "Панель: Правая вторая", label: "Слот 7" },
  { action: "right2Action8", group: "Панель: Правая вторая", label: "Слот 8" },
  { action: "right2Action9", group: "Панель: Правая вторая", label: "Слот 9" },
  { action: "right2Action10", group: "Панель: Правая вторая", label: "Слот 10" },
  { action: "right2Action11", group: "Панель: Правая вторая", label: "Слот 11" },
  { action: "right2Action12", group: "Панель: Правая вторая", label: "Слот 12" },
] as const;

export type InputAction = (typeof INPUT_ACTIONS)[number]["action"];

/** Primary and secondary, as the original client's bindings window has. An empty string is unbound. */
export type BindingPair = readonly [string, string];

/**
 * What a fresh installation gets. These are the 3.3.5 client's own defaults wherever it has one,
 * which is the point of the slice: the keys a player already knows have to be the keys.
 *
 * Two are not. The quest log keeps `L`, and looting moved onto the interact action, because the
 * original client has no loot key at all — it loots by clicking the corpse, which this client now
 * does too. Diagnostics and the bindings window are this client's own and have no original.
 */
export const DEFAULT_BINDINGS: Readonly<Record<InputAction, BindingPair>> = {
  moveForward: ["KeyW", "ArrowUp"],
  moveBackward: ["KeyS", "ArrowDown"],
  turnLeft: ["KeyA", "ArrowLeft"],
  turnRight: ["KeyD", "ArrowRight"],
  strafeLeft: ["KeyQ", ""],
  strafeRight: ["KeyE", ""],
  jump: ["Space", ""],
  toggleAutoRun: ["NumLock", ""],
  toggleWalkRun: ["Slash", ""],
  sitOrStand: ["KeyX", ""],

  targetNearestEnemy: ["Tab", ""],
  targetPreviousEnemy: ["Shift+Tab", ""],
  targetSelf: ["F1", ""],
  setFocus: ["KeyF", ""],
  interact: ["KeyG", ""],
  // `V` is the original client's key for enemy name plates, and it is free here.
  toggleNamePlates: ["KeyV", ""],
  attackTarget: ["KeyT", ""],

  toggleCharacter: ["KeyC", ""],
  toggleBags: ["KeyB", ""],
  // The original client has no key for the keyring at all — it is a button beside the bag bar.
  // `Shift+B` is what it uses for "open every bag", and the bag key here already does that.
  toggleKeyring: ["Shift+KeyB", ""],
  toggleSpellbook: ["KeyP", ""],
  // This is the stock TOGGLECHARACTER4 route (H); FrameXML owns the PvP summary when mounted.
  togglePvp: ["KeyH", ""],
  // `N` is the original client's talent key. Skills have none there at all — they are a tab of
  // the character window — and `K` is already this client's bindings window, so the skills window
  // takes the nearest free key rather than shipping unreachable, which the bindings test forbids.
  toggleTalents: ["KeyN", ""],
  toggleProfessions: ["KeyJ", ""],
  toggleQuestLog: ["KeyL", ""],
  toggleWorldMap: ["KeyM", ""],
  toggleDiagnostics: ["KeyO", ""],
  toggleKeyBindings: ["KeyK", ""],
  openChat: ["Enter", "NumpadEnter"],

  action1: ["Digit1", ""],
  action2: ["Digit2", ""],
  action3: ["Digit3", ""],
  action4: ["Digit4", ""],
  action5: ["Digit5", ""],
  action6: ["Digit6", ""],
  action7: ["Digit7", ""],
  action8: ["Digit8", ""],
  action9: ["Digit9", ""],
  action10: ["Digit0", ""],
  action11: ["Minus", ""],
  action12: ["Equal", ""],
  actionPage1: ["Shift+Digit1", ""],
  actionPage2: ["Shift+Digit2", ""],
  actionPage3: ["Shift+Digit3", ""],
  actionPage4: ["Shift+Digit4", ""],
  actionPage5: ["Shift+Digit5", ""],
  actionPage6: ["Shift+Digit6", ""],

  // Unbound on purpose. The original client ships these empty too — the bar exists, the keys are
  // the player's choice — and the bindings test only forbids an action that is unreachable *and*
  // has no way to be bound.
  bottomLeftAction1: ["", ""],
  bottomLeftAction2: ["", ""],
  bottomLeftAction3: ["", ""],
  bottomLeftAction4: ["", ""],
  bottomLeftAction5: ["", ""],
  bottomLeftAction6: ["", ""],
  bottomLeftAction7: ["", ""],
  bottomLeftAction8: ["", ""],
  bottomLeftAction9: ["", ""],
  bottomLeftAction10: ["", ""],
  bottomLeftAction11: ["", ""],
  bottomLeftAction12: ["", ""],
  bottomRightAction1: ["", ""],
  bottomRightAction2: ["", ""],
  bottomRightAction3: ["", ""],
  bottomRightAction4: ["", ""],
  bottomRightAction5: ["", ""],
  bottomRightAction6: ["", ""],
  bottomRightAction7: ["", ""],
  bottomRightAction8: ["", ""],
  bottomRightAction9: ["", ""],
  bottomRightAction10: ["", ""],
  bottomRightAction11: ["", ""],
  bottomRightAction12: ["", ""],
  rightAction1: ["", ""],
  rightAction2: ["", ""],
  rightAction3: ["", ""],
  rightAction4: ["", ""],
  rightAction5: ["", ""],
  rightAction6: ["", ""],
  rightAction7: ["", ""],
  rightAction8: ["", ""],
  rightAction9: ["", ""],
  rightAction10: ["", ""],
  rightAction11: ["", ""],
  rightAction12: ["", ""],
  right2Action1: ["", ""],
  right2Action2: ["", ""],
  right2Action3: ["", ""],
  right2Action4: ["", ""],
  right2Action5: ["", ""],
  right2Action6: ["", ""],
  right2Action7: ["", ""],
  right2Action8: ["", ""],
  right2Action9: ["", ""],
  right2Action10: ["", ""],
  right2Action11: ["", ""],
  right2Action12: ["", ""],
};

/**
 * The bar's slots and pages in order, so the bar can ask what key a slot wears without spelling
 * out the names — and so a rebound slot writes the new key in its own corner.
 */
/**
 * The four extra bars' slots, in the same order as `EXTRA_ACTION_BARS`.
 *
 * No defaults, exactly as the original client ships them: the main bar owns 1 through =, and the
 * keys for the rest are the player's to choose. They are here so that the bindings window offers
 * them at all, which is the half that was missing — a bar with no reachable keys is a mouse-only
 * bar.
 */
export const EXTRA_ACTION_BAR_SLOTS: Readonly<Record<string, readonly InputAction[]>> = {
  bottomLeft: ["bottomLeftAction1", "bottomLeftAction2", "bottomLeftAction3", "bottomLeftAction4", "bottomLeftAction5", "bottomLeftAction6", "bottomLeftAction7", "bottomLeftAction8", "bottomLeftAction9", "bottomLeftAction10", "bottomLeftAction11", "bottomLeftAction12"],
  bottomRight: ["bottomRightAction1", "bottomRightAction2", "bottomRightAction3", "bottomRightAction4", "bottomRightAction5", "bottomRightAction6", "bottomRightAction7", "bottomRightAction8", "bottomRightAction9", "bottomRightAction10", "bottomRightAction11", "bottomRightAction12"],
  right: ["rightAction1", "rightAction2", "rightAction3", "rightAction4", "rightAction5", "rightAction6", "rightAction7", "rightAction8", "rightAction9", "rightAction10", "rightAction11", "rightAction12"],
  right2: ["right2Action1", "right2Action2", "right2Action3", "right2Action4", "right2Action5", "right2Action6", "right2Action7", "right2Action8", "right2Action9", "right2Action10", "right2Action11", "right2Action12"],
};

export const ACTION_BAR_SLOTS: readonly InputAction[] = [
  "action1", "action2", "action3", "action4", "action5", "action6",
  "action7", "action8", "action9", "action10", "action11", "action12",
];
export const ACTION_BAR_PAGES: readonly InputAction[] = [
  "actionPage1", "actionPage2", "actionPage3", "actionPage4", "actionPage5", "actionPage6",
];

/**
 * The actions that are held rather than pressed. They are the ones the render loop integrates and
 * the ones a key release has to undo, and telling them apart from the rest is what stops a
 * released `B` from also stopping the character.
 */
export const HELD_ACTIONS: ReadonlySet<InputAction> = new Set<InputAction>([
  "moveForward", "moveBackward", "turnLeft", "turnRight", "strafeLeft", "strafeRight",
  // Both of these mean one thing pressed and another held. Jump is a jump on the ground and a
  // rise while held in water or in the air; the sit key is a sit on the ground and a descent in
  // both of those. That is how the original client binds them, and it is why they are held rather
  // than pressed: the verb still runs on the way down, the holding is what the physics reads.
  "jump", "sitOrStand",
]);

/**
 * Holding this turns a turn into a strafe, as the original client does. It is a rule and not a
 * binding: `Shift+A` is not a second way to spell "strafe left", it is what `A` means while shift
 * is down, and the player can go on rebinding `A` without ever meeting it.
 */
export function strafeInsteadOfTurn(action: InputAction): InputAction {
  if (action === "turnLeft") return "strafeLeft";
  if (action === "turnRight") return "strafeRight";
  return action;
}

const MODIFIER_CODES = ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"];

/**
 * How a key press is spelled.
 *
 * The modifier order is fixed so the same press always spells itself the same way, and a modifier
 * pressed on its own spells nothing at all: `Shift` held while turning must not resolve to some
 * action of its own, and it must not be bindable to one either.
 */
export function chordOf(event: { code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): string {
  if (MODIFIER_CODES.includes(event.code)) return "";
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.code);
  return parts.join("+");
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  Space: "Пробел", Escape: "Esc", Enter: "Enter", Tab: "Tab", Backquote: "`",
  Minus: "-", Equal: "=", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  NumLock: "Num Lock", CapsLock: "Caps Lock", Insert: "Ins", Delete: "Del",
  Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
};

/** How a chord is written in the bindings window: `Digit1` is a key called 1, not "Digit1". */
export function describeChord(chord: string): string {
  if (!chord) return "—";
  return chord.split("+").map((part) => {
    if (part.startsWith("Key")) return part.slice(3);
    if (part.startsWith("Digit")) return part.slice(5);
    if (part.startsWith("Numpad")) return `Num ${part.slice(6)}`;
    return KEY_NAMES[part] ?? part;
  }).join("+");
}

/**
 * Where the table is kept between sessions. Injectable so the tests can hold one without a
 * browser; `localStorage` throws rather than being absent in a few privacy modes, so having no
 * storage at all is a supported state and not an error.
 */
export interface BindingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "webclient.keybindings.v1";
/**
 * Where the keys for *module* actions are kept, and why it is a second blob.
 *
 * {@link loadBindings} reads the first one over the defaults and keeps only the rows it recognises,
 * which is right for a table whose actions are compiled in. A module action's row is not compiled
 * in — it appears when a module loads and goes when it unloads — so the same rule would throw the
 * player's choice away every time the file happened not to be loaded when the table was read.
 * Keeping the two apart means a module can be unloaded and loaded again with its key still on it.
 */
const MODULE_STORAGE_KEY = "webclient.keybindings.modules.v1";

let storage: BindingStorage | undefined = (() => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
})();

let bindings: Record<InputAction, BindingPair> = { ...DEFAULT_BINDINGS };
/** Chord to action name — compiled-in or a module's, which is why the value is a bare string. */
let byChord = new Map<string, string>();

/**
 * One action a loaded module offers, in its own dynamic table beside {@link INPUT_ACTIONS}.
 *
 * Separate for one reason worth stating: `tests/bindings.test.mjs` asserts that every action ships
 * with a key and that no two ship with the same one, and that rule is only honest about the actions
 * this client compiles in. A module's action ships **unbound** — the player chooses — so putting it
 * in the same list would either break the invariant or invent a default key on a keyboard that has
 * none free.
 */
export interface ModuleAction {
  /** Unique across modules; the loader builds it as `module:<модуль>:<binding>`. */
  readonly action: string;
  readonly module: string;
  /** Which group the bindings window lists it under. «Модули» for everything the loader adds. */
  readonly group: string;
  readonly label: string;
  run(): void;
}

const CORE_ACTIONS: ReadonlySet<string> = new Set<string>(INPUT_ACTIONS.map((entry) => entry.action));
const moduleTable = new Map<string, ModuleAction>();
let moduleBindings: Record<string, BindingPair> = {};

function reindex(): void {
  byChord = new Map();
  for (const { action } of INPUT_ACTIONS) {
    for (const chord of bindings[action]) {
      // First writer wins, so a table that somehow holds a duplicate resolves to the action listed
      // first rather than silently preferring whichever was declared last.
      if (chord && !byChord.has(chord)) byChord.set(chord, action);
    }
  }
  // After the compiled-in ones, so a module cannot take a key off an action the player never
  // rebound. Stealing is still possible — it is what {@link bindKey} does — but it takes a
  // deliberate press in the bindings window rather than a line in a definition file.
  for (const [action, pair] of Object.entries(moduleBindings)) {
    if (!moduleTable.has(action)) continue;
    for (const chord of pair) if (chord && !byChord.has(chord)) byChord.set(chord, action);
  }
}

/**
 * Reads the saved table over the defaults.
 *
 * Merged rather than replaced: a table saved before an action existed would otherwise leave that
 * action unbound for good, which is how a player loses a key by upgrading.
 */
export function loadBindings(): void {
  bindings = { ...DEFAULT_BINDINGS };
  const saved = readStored(STORAGE_KEY);
  if (saved) {
    for (const { action } of INPUT_ACTIONS) {
      const pair = saved[action];
      if (!Array.isArray(pair)) continue;
      bindings[action] = [typeof pair[0] === "string" ? pair[0] : "", typeof pair[1] === "string" ? pair[1] : ""];
    }
  }
  // Kept whole rather than filtered against the modules loaded right now: the key belongs to the
  // action a module *will* offer again, and dropping it here would mean losing it by logging in
  // before that module's file had been read.
  moduleBindings = {};
  for (const [action, pair] of Object.entries(readStored(MODULE_STORAGE_KEY) ?? {})) {
    if (!Array.isArray(pair)) continue;
    moduleBindings[action] = [typeof pair[0] === "string" ? pair[0] : "", typeof pair[1] === "string" ? pair[1] : ""];
  }
  reindex();
}

function readStored(key: string): Record<string, unknown> | undefined {
  try {
    const raw = storage?.getItem(key);
    const saved: unknown = raw ? JSON.parse(raw) : undefined;
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function persist(): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(bindings));
    storage?.setItem(MODULE_STORAGE_KEY, JSON.stringify(moduleBindings));
  } catch {
    // A full or refused store loses the change on the next reload and nothing else: the session
    // it was made in still has it.
  }
}

loadBindings();

/** Swaps the store the table is kept in, and reloads from it. This is what the tests use. */
export function useBindingStorage(replacement: BindingStorage | undefined): void {
  storage = replacement;
  loadBindings();
}

export function bindingsOf(action: InputAction): BindingPair {
  return bindings[action];
}

/** The keys on any action, compiled-in or a module's. A name nothing offers is two empty slots. */
export function keysOf(action: string): BindingPair {
  if (CORE_ACTIONS.has(action)) return bindings[action as InputAction];
  return moduleBindings[action] ?? ["", ""];
}

/** Which compiled-in action a key press means, or undefined when nothing is bound to it. */
export function actionFor(chord: string): InputAction | undefined {
  const action = chord ? byChord.get(chord) : undefined;
  return action !== undefined && CORE_ACTIONS.has(action) ? action as InputAction : undefined;
}

/** Which module action a key press means, or undefined when it means a compiled-in one or none. */
export function moduleActionFor(chord: string): ModuleAction | undefined {
  const action = chord ? byChord.get(chord) : undefined;
  return action === undefined ? undefined : moduleTable.get(action);
}

/** Every module action on offer, in the order they were added. */
export function moduleActions(): readonly ModuleAction[] {
  return [...moduleTable.values()];
}

/**
 * Offers one module action, **unbound**.
 *
 * Unbound and never defaulted: the definition file names a key it would like — `params.binding` —
 * and that name is a *label*, not a claim on the keyboard. A module that could bind itself would
 * take a key off the player on the first login after it was installed, and the player would have no
 * way of knowing which module took it.
 */
export function addModuleAction(entry: ModuleAction): void {
  moduleTable.set(entry.action, entry);
  reindex();
}

/** Drops every action one module offered, and answers how many that was. */
export function removeModuleActions(module: string): number {
  let dropped = 0;
  for (const [action, entry] of [...moduleTable]) {
    if (entry.module !== module) continue;
    moduleTable.delete(action);
    dropped++;
  }
  // `moduleBindings` is deliberately left alone: the key the player put on this action is theirs,
  // and a module being unloaded is not them changing their mind. `reindex` stops answering for it,
  // so the key is free while the module is gone and back on it when the module returns.
  if (dropped) reindex();
  return dropped;
}

/**
 * Puts a chord on an action, taking it off whatever held it.
 *
 * Stealing rather than refusing is the original client's behaviour and the right one: a player
 * who has pressed the key has already decided, and a refusal leaves them hunting for which of
 * forty rows is in the way.
 */
export function bindAction(action: InputAction, slot: 0 | 1, chord: string): void {
  bindKey(action, slot, chord);
}

/**
 * Puts a chord on any action, compiled-in or a module's, taking it off whatever held it.
 *
 * The steal walks both tables, which is the whole reason there is one function and not two: a chord
 * left on a compiled-in action *and* on a module's would resolve to whichever `reindex` reached
 * first, and the bindings window would print it on two rows with nothing to say which of them the
 * keyboard obeys.
 */
export function bindKey(action: string, slot: 0 | 1, chord: string): void {
  if (chord) {
    for (const entry of INPUT_ACTIONS) {
      const pair = bindings[entry.action];
      if (pair[0] !== chord && pair[1] !== chord) continue;
      bindings[entry.action] = [pair[0] === chord ? "" : pair[0], pair[1] === chord ? "" : pair[1]];
    }
    for (const [name, pair] of Object.entries(moduleBindings)) {
      if (pair[0] !== chord && pair[1] !== chord) continue;
      moduleBindings[name] = [pair[0] === chord ? "" : pair[0], pair[1] === chord ? "" : pair[1]];
    }
  }
  if (CORE_ACTIONS.has(action)) {
    const pair = bindings[action as InputAction];
    bindings[action as InputAction] = slot === 0 ? [chord, pair[1]] : [pair[0], chord];
  } else {
    const pair = moduleBindings[action] ?? ["", ""];
    moduleBindings[action] = slot === 0 ? [chord, pair[1]] : [pair[0], chord];
  }
  reindex();
  persist();
}

export function resetBindings(): void {
  bindings = { ...DEFAULT_BINDINGS };
  // The module rows go back to unbound too: «вернуть стандартные» means every key on that screen,
  // and a module's key left standing would be the one row the button did not answer for.
  moduleBindings = {};
  reindex();
  persist();
}
