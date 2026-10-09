/**
 * The macro window, and the thing that runs one.
 *
 * A body runs its lines, in order, through the one macro runner (macro/MacroRunner.ts); conditions
 * choose what each line does when it runs, and the cast guard what one press may send. The
 * complete body is validated before any line runs, including macros restored from account data.
 * With the stock chat installed and able to evaluate conditions, the lines go through stock
 * `ChatEdit_ParseText` as in the client (FrameXmlChatApi.ts); otherwise through this client's chat.
 *
 * The two halves are stored in two different account-data slots, shared and per character, which
 * is why there are two stores and one merged list.
 */

import { AccountStore } from "../AccountStore.js";
import { GLOBAL_MACROS_CACHE, PER_CHARACTER_MACROS_CACHE } from "../../world/SessionProtocol.js";
import type { FrameXmlMacroStore } from "../framexml/FrameXmlMacro.js";
import {
  closeFrameXmlMacro, frameXmlMacroOpen, openFrameXmlMacro, toggleFrameXmlMacro,
} from "../framexml/FrameXmlMacroController.js";
import {
  installMacroLineExecutor, macroBodyLines, macroLineExecutor, runMacroLines, stopMacro,
} from "../macro/MacroRunner.js";
import { submitChat } from "./Chat.js";
import { nativeMacroContext } from "./CombatCommands.js";
import { notice } from "./Notices.js";
import {
  MACRO_BODY_LIMIT, MACRO_NAME_LIMIT, MACROS_PER_ROW, evaluateMacroOptions, findMacro, installMacroOptionErrorSink,
  isAccountMacro, macroIndexes, macroOptions, macroProblems, macrosForSet, nativeMacroEdit, nextFreeMacro, parseMacros,
  putMacro, removeMacro, serialiseMacros, trimMacroName, type Macro,
} from "./MacroModel.js";
import { setTip, Panel, Tabs, confirmPanel } from "./Widgets.js";
import { macroActionDragPayload } from "./ActionDrag.js";
import { beginIconDrag } from "./DragGhost.js";

const accountMacros = new AccountStore<Macro[]>({
  slot: GLOBAL_MACROS_CACHE,
  mirrorKey: "webclient.macros.account.v1",
  fallback: () => [],
  parse: parseMacros,
  serialise: serialiseMacros,
});

const characterMacros = new AccountStore<Macro[]>({
  slot: PER_CHARACTER_MACROS_CACHE,
  mirrorKey: "webclient.macros.character.v1",
  fallback: () => [],
  parse: parseMacros,
  serialise: serialiseMacros,
});

export const macroStores = [accountMacros, characterMacros];

/** Every macro this character can see, both halves together. */
export function allMacros(): Macro[] {
  return [...accountMacros.value, ...characterMacros.value].sort((left, right) => left.index - right.index);
}

export function macroAt(index: number): Macro | undefined {
  return findMacro(isAccountMacro(index) ? accountMacros.value : characterMacros.value, index);
}

function storeFor(index: number): AccountStore<Macro[]> {
  return isAccountMacro(index) ? accountMacros : characterMacros;
}

function save(macro: Macro): void {
  const store = storeFor(macro.index);
  store.set(putMacro(store.value, macro));
}

function drop(index: number): void {
  const store = storeFor(index);
  store.set(removeMacro(store.value, index));
}

/**
 * Who hears that the macros changed from somewhere other than their own writes: the server's copy
 * landing, or the other window. The stock MacroFrame's model is one (UPDATE_MACROS).
 */
const macroListeners = new Set<() => void>();

function macrosChanged(): void {
  for (const listener of [...macroListeners]) {
    try { listener(); } catch (error) { console.error("[macros] listener failed", error); }
  }
}

for (const store of macroStores) store.onLoaded = macrosChanged;

/**
 * The same two stores for the stock macro API (FrameXmlMacro.ts): slots, names, bodies and icons
 * stay in the blobs this window has always written.
 */
export const frameXmlMacroStore: FrameXmlMacroStore = {
  list: allMacros,
  put: save,
  remove: drop,
  subscribe: (listener) => {
    macroListeners.add(listener);
    return () => { macroListeners.delete(listener); };
  },
  flush: () => { for (const store of macroStores) store.flush(); },
};

/** `/stopmacro [options]` (ChatFrame.lua:1398-1402); the ruRU client spells it only this way. */
const STOP_MACRO = /^\/stopmacro(?:\s+([\s\S]*))?$/i;

/**
 * One macro line through this client's own chat. `/stopmacro` is the runner's: its options are
 * evaluated here, as stock `SecureCmdList.STOPMACRO` does. `/cast` and `/use` evaluate their own
 * (CombatCommands.ts); any other line is what the player could have typed.
 */
function runNativeMacroLine(line: string): void {
  const stop = STOP_MACRO.exec(line);
  if (!stop) {
    submitChat(line);
    return;
  }
  const options = macroOptions((stop[1] ?? "").trim());
  if (options.error !== undefined) notice(`/stopmacro: ${options.error}.`);
  else if (evaluateMacroOptions(options, nativeMacroContext())) stopMacro();
}

// This client's chat is the floor: a stock chat that can evaluate conditions installs its own over it,
// and its UI error line over this notice for an unknown condition word (ERR_UNKNOWN_MACRO_OPTION_S).
installMacroLineExecutor(runNativeMacroLine);
installMacroOptionErrorSink((word) => notice(`Неизвестный параметр макроса: ${word}`));

/**
 * Runs one macro: its lines, in order, through the macro runner, until the end or `/stopmacro`.
 * `button` is the mouse button that started it, which `[btn:N]` reads; without one — a key, a chat
 * line — the client reads `LeftButton` (0x5ef0d0).
 *
 * `#showtooltip`/`#show` and `-` lines are skipped; a line without `/` is said. Conditions are
 * evaluated as each line runs; `macroProblems` refuses only what cannot be read.
 */
export function runMacro(index: number, button?: string): void {
  const macro = macroAt(index);
  if (!macro) {
    notice(`Макрос ${index} пуст`);
    return;
  }
  const problems = macroProblems(macro.name, macro.body);
  if (problems.length > 0) {
    notice(problems.join(" "));
    return;
  }
  const lines = macroBodyLines(macro.body);
  if (lines.length === 0) {
    notice(`Макрос «${macro.name}» ничего не содержит`);
    return;
  }
  runMacroLines(lines, macroLineExecutor() ?? runNativeMacroLine, button);
}

interface Parts {
  panel: Panel;
  tabs: Tabs;
  grid: HTMLElement;
  editor: HTMLElement;
}

let parts: Parts | undefined;
let selected: number | undefined;

function build(): Parts {
  const panel = new Panel({ id: "macro-window", title: "Макросы", className: "macro-window" });
  const tabs = new Tabs();
  tabs.set([{ id: "account", title: "Общие" }, { id: "character", title: "Персонажа" }], "account");
  tabs.onSelect = () => { selected = undefined; showMacros(); };
  const grid = document.createElement("div");
  grid.className = "macro-grid";
  grid.style.gridTemplateColumns = `repeat(${MACROS_PER_ROW}, 1fr)`;
  const editor = document.createElement("div");
  editor.className = "macro-editor";
  panel.body.append(tabs.root, grid, editor);
  return { panel, tabs, grid, editor };
}

/**
 * The four window entry points ask the stock MacroFrame's route first (FrameXmlMacroController.ts):
 * once the world mount has published it, the game menu, `/macro` and the chat menu open the stock
 * window, and this Panel is the fallback before that or after a failed load.
 */
export function macroWindowOpen(): boolean {
  return frameXmlMacroOpen() || (parts?.panel.visible ?? false);
}

export function closeMacroWindow(): void {
  closeFrameXmlMacro();
  parts?.panel.hide();
}

export function resetMacroWindow(): void {
  closeFrameXmlMacro();
  parts?.panel.hide();
  selected = undefined;
}

export function toggleMacroWindow(): void {
  if (toggleFrameXmlMacro()) return;
  toggleNativeMacroWindow();
}

/** Open (never close) the macro window; stock ShowMacroFrame's meaning. */
export function openMacroWindow(): void {
  if (openFrameXmlMacro()) return;
  openNativeMacroWindow();
}

/** The native Panel alone, for a stock load that failed while the player was waiting for it. */
export function openNativeMacroWindow(): void {
  if (!parts?.panel.visible) toggleNativeMacroWindow();
}

function toggleNativeMacroWindow(): void {
  parts ??= build();
  if (parts.panel.visible) {
    parts.panel.hide();
    return;
  }
  parts.panel.show();
  showMacros();
}

export function showMacros(): void {
  if (!parts?.panel.visible) return;
  const { tabs, grid, editor } = parts;
  const accountSet = tabs.active === "account";
  const macros = macrosForSet(allMacros(), accountSet);

  grid.replaceChildren(...macroIndexes(accountSet).map((index) => {
    const macro = findMacro(macros, index);
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === selected ? "macro-slot is-active" : "macro-slot";
    button.textContent = macro ? macro.name : "";
    button.setAttribute("aria-label", macro ? `Макрос ${index}: ${macro.name}` : `Пустой слот ${index}`);
    button.setAttribute("aria-pressed", String(index === selected));
    setTip(button, macro ? macro.name : `Создать макрос в слоте ${index}`);
    if (!macro) button.classList.add("macro-empty");
    button.addEventListener("click", () => { selected = index; showMacros(); });
    // 4.05: a macro goes onto a bar the way the original client puts it there — dragged out of
    // the window. An empty slot has nothing to drag (NativeAppShell lets only draggable="true" go).
    if (macro) {
      button.draggable = true;
      button.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData(...macroActionDragPayload(index));
        beginIconDrag(event, button, { label: macro.name.trim().charAt(0) || "?" });
      });
    }
    return button;
  }));

  editor.replaceChildren();
  if (selected === undefined) {
    const hint = document.createElement("p");
    hint.className = "muted";
    const free = nextFreeMacro(allMacros(), accountSet);
    hint.textContent = free === undefined
      ? "Все слоты заняты — выберите макрос, чтобы изменить его."
      : "Выберите слот, чтобы написать макрос.";
    editor.append(hint);
    return;
  }

  const macro = macroAt(selected);
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = MACRO_NAME_LIMIT;
  name.placeholder = "Имя";
  name.setAttribute("aria-label", "Имя макроса");
  name.value = macro?.name ?? "";
  const body = document.createElement("textarea");
  body.rows = 5;
  body.maxLength = MACRO_BODY_LIMIT;
  body.placeholder = "/dance\n/say Привет";
  body.setAttribute("aria-label", "Команды макроса");
  body.value = macro?.body ?? "";

  const problems = document.createElement("p");
  problems.className = "muted macro-problems";
  const counter = document.createElement("p");
  counter.className = "muted";
  const refreshCounter = (): void => {
    counter.textContent = `${body.value.length} / ${MACRO_BODY_LIMIT}`;
    problems.textContent = macroProblems(name.value, body.value).join(" ");
  };
  refreshCounter();
  name.addEventListener("input", refreshCounter);
  body.addEventListener("input", refreshCounter);

  const actions = document.createElement("div");
  actions.className = "macro-actions";
  const store = document.createElement("button");
  store.type = "button";
  store.textContent = "Сохранить";
  store.addEventListener("click", () => {
    const trimmedName = trimMacroName(name.value);
    const errors = macroProblems(trimmedName, body.value);
    if (errors.length > 0) {
      notice(errors.join(" "));
      return;
    }
    // The icon is the stock window's to choose; a save here keeps the one it chose.
    save(nativeMacroEdit(macro, selected as number, trimmedName, body.value));
    macrosChanged();
    showMacros();
  });
  const run = document.createElement("button");
  run.type = "button";
  run.textContent = "Выполнить";
  run.disabled = macro === undefined;
  run.addEventListener("click", () => runMacro(selected as number));
  const erase = document.createElement("button");
  erase.type = "button";
  erase.className = "danger";
  erase.textContent = "Удалить";
  erase.disabled = macro === undefined;
  erase.addEventListener("click", () => confirmPanel(erase, {
    title: `Удалить макрос «${macro?.name ?? selected}»?`,
    confirm: "Удалить",
    danger: true,
    onConfirm: () => { drop(selected as number); selected = undefined; macrosChanged(); showMacros(); },
  }));
  actions.append(store, run, erase);

  const hint = document.createElement("p");
  hint.className = "muted";
  // Said outright, because the answer to "why does my macro not work" is almost always this.
  hint.textContent = "Команды /help и эмоции; строки выполняются по порядку, "
    + "а что уйдёт за одно нажатие, решают восстановление и глобальная перезарядка. "
    + "/cast использует текущую цель; [@focus], [@self], [@pet], [@mouseover], [@party1] "
    + "доступны для адресных заклинаний. "
    + "Условия выбирают вариант: /cast [mod:shift] А; [@focus,help] Б; В — а также [combat], [harm], [dead], "
    + "[stance:1], [btn:2]…; /stopmacro [условия] останавливает макрос. "
    + "/use выбирает первый предмет с этим ID или именем в экипировке и сумках. Сервер проверяет результат. "
    + "Строка без «/» говорится в чат; задержки и Lua не поддерживаются.";

  const slotNote = document.createElement("p");
  slotNote.className = "muted";
  slotNote.textContent = isAccountMacro(selected)
    ? `Слот ${selected} · общий для всех персонажей аккаунта`
    : `Слот ${selected} · только у этого персонажа`;

  editor.append(slotNote, name, body, counter, problems, actions, hint);
}
