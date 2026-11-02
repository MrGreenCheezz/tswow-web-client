/**
 * The macro window.
 *
 * A body runs its lines, in order, through the one macro runner (macro/MacroRunner.ts, MacroRun.ts);
 * conditions choose what each line does when it runs, and the cast guard what one press may send. The
 * complete body is validated before any line runs, including macros restored from account data.
 * The macros themselves are in MacroStore.ts.
 */

import {
  closeFrameXmlMacro, frameXmlMacroOpen, openFrameXmlMacro, toggleFrameXmlMacro,
} from "../framexml/FrameXmlMacroController.js";
import { runMacro } from "./MacroRun.js";
import { notice } from "./Notices.js";
import {
  MACRO_BODY_LIMIT, MACRO_NAME_LIMIT, MACROS_PER_ROW, findMacro, isAccountMacro, macroIndexes, macroProblems,
  macrosForSet, nativeMacroEdit, nextFreeMacro, trimMacroName,
} from "./MacroModel.js";
import { allMacros, dropMacro, macroAt, macrosChanged, saveMacro } from "./MacroStore.js";
import { setTip, Panel, Tabs, confirmPanel } from "./Widgets.js";
import { macroActionDragPayload } from "./ActionDrag.js";
import { beginIconDrag } from "./DragGhost.js";

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
    saveMacro(nativeMacroEdit(macro, selected as number, trimmedName, body.value));
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
    onConfirm: () => { dropMacro(selected as number); selected = undefined; macrosChanged(); showMacros(); },
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
