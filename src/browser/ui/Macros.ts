/**
 * The macro window, and the thing that runs one.
 *
 * Running a macro turned out to need nothing new: `submitChat` already resolves the world itself,
 * already knows twenty-eight slash commands and every emote in the table, and already refuses a
 * line the server would drop. A macro body is a list of lines, and running it is feeding them to
 * that function in order. What the slice had to build was the rest — somewhere to keep fifty-four
 * of them, a window to write them in, and the bar slot that fires one.
 *
 * The two halves are stored in two different account-data slots, shared and per character, which
 * is why there are two stores and one merged list.
 */

import { AccountStore } from "../AccountStore.js";
import { GLOBAL_MACROS_CACHE, PER_CHARACTER_MACROS_CACHE } from "../../world/SessionProtocol.js";
import { submitChat } from "./Chat.js";
import { notice } from "./Notices.js";
import {
  MACRO_BODY_LIMIT, MACRO_NAME_LIMIT, MACROS_PER_ROW, findMacro, isAccountMacro, macroIndexes,
  macroLines, macroProblems, macrosForSet, nextFreeMacro, parseMacros, putMacro, removeMacro,
  serialiseMacros, trimMacroBody, trimMacroName, type Macro,
} from "./MacroModel.js";
import { Panel, Tabs, confirmPanel } from "./Widgets.js";

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
 * Runs one macro: every line, in order, through the chat box.
 *
 * No conditionals — `macroProblems` says so when the macro is written, rather than letting a
 * `[combat]` line run unconditionally and look like it worked.
 */
export function runMacro(index: number): void {
  const macro = macroAt(index);
  if (!macro) {
    notice(`Макрос ${index} пуст`);
    return;
  }
  const lines = macroLines(macro.body);
  if (lines.length === 0) {
    notice(`Макрос «${macro.name}» ничего не содержит`);
    return;
  }
  for (const line of lines) submitChat(line);
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

export function macroWindowOpen(): boolean {
  return parts?.panel.visible ?? false;
}

export function closeMacroWindow(): void {
  parts?.panel.hide();
}

export function resetMacroWindow(): void {
  parts?.panel.hide();
  selected = undefined;
}

export function toggleMacroWindow(): void {
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
    if (!macro) button.classList.add("macro-empty");
    button.addEventListener("click", () => { selected = index; showMacros(); });
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
  name.value = macro?.name ?? "";
  const body = document.createElement("textarea");
  body.rows = 5;
  body.maxLength = MACRO_BODY_LIMIT;
  body.placeholder = "/dance\n/say Привет";
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
    if (!trimmedName) {
      notice("У макроса должно быть имя");
      return;
    }
    save({ index: selected as number, name: trimmedName, body: trimMacroBody(body.value) });
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
    onConfirm: () => { drop(selected as number); selected = undefined; showMacros(); },
  }));
  actions.append(store, run, erase);

  const hint = document.createElement("p");
  hint.className = "muted";
  // Said outright, because the answer to "why does my macro not work" is almost always this.
  hint.textContent = "Каждая строка идёт в чат как есть: /закл и условия в скобках пока не поддержаны, "
    + "работают команды из /help и эмоции.";

  const slotNote = document.createElement("p");
  slotNote.className = "muted";
  slotNote.textContent = isAccountMacro(selected)
    ? `Слот ${selected} · общий для всех персонажей аккаунта`
    : `Слот ${selected} · только у этого персонажа`;

  editor.append(slotNote, name, body, counter, problems, actions, hint);
}

/** Puts a macro on the bar the way the original client does: drag it out of the window. */
export function macroDragPayload(index: number): string {
  return JSON.stringify({ action: index, type: 0x40 });
}
