/**
 * The two account-data stores of 4.12 (`InputAccount.ts`) over this page's binding table and window
 * manager, with the three calls the world's lifecycle makes (`app/EnterWorld.ts`, `app/Login.ts`).
 * While the switches are off (the default, see `INPUT_ACCOUNT_SYNC_KEYS`) every call is a no-op.
 */

import type { WorldClient } from "../../world/WorldClient.js";
import { onWindowLayoutChanged } from "../GameWindows.js";
import { gameWindows } from "../ui/Dom.js";
import { notice } from "../ui/Notices.js";
import { applyBindingTables, bindingTables, onBindingsChanged } from "./Bindings.js";
import { BINDINGS_ACCOUNT_SLOT, BindingsAccountSync, LayoutAccountSync } from "./InputAccount.js";

const onForeign = (slot: number): void => {
  notice(slot === BINDINGS_ACCOUNT_SLOT
    ? "Привязки клавиш в данных аккаунта записаны в другом формате. Они сохранены без изменений; используются локальные клавиши."
    : "Расположение окон в данных персонажа записано в другом формате. Оно сохранено без изменений; используется локальное.",
  "info");
};

let stores: [BindingsAccountSync, LayoutAccountSync] | undefined;

function inputAccountStores(): [BindingsAccountSync, LayoutAccountSync] {
  stores ??= [
    new BindingsAccountSync({ tables: bindingTables, apply: applyBindingTables, onChanged: onBindingsChanged }, { onForeign }),
    new LayoutAccountSync({
      layout: () => gameWindows.layout(),
      apply: (layout) => gameWindows.applyLayout(layout),
      onChanged: onWindowLayoutChanged,
    }, { onForeign }),
  ];
  return stores;
}

/** Asks for both slots once the character is known. */
export function attachInputAccount(world: WorldClient): void {
  for (const store of inputAccountStores()) store.attach(world);
}

/** `ACCOUNT_DATA_CHANGED`: takes the slot's copy when it is one of these two. */
export function acceptInputAccount(type: number): boolean {
  return inputAccountStores().some((store) => store.accept(type));
}

/** Leaving the world: a pending write goes out first. */
export function detachInputAccount(): void {
  for (const store of stores ?? []) store.detach();
}
