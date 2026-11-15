/**
 * The account-data stores of the input side over this page's binding table and window manager, with the
 * three calls the world's lifecycle makes (`app/EnterWorld.ts`, `app/Login.ts`): the key bindings in slots
 * 2 and 3 in Wow.exe's text (5.37, `BindingsSlotSync.ts`) and the window positions in slot 6 (4.12). Both
 * switches are on by default (`INPUT_ACCOUNT_SYNC_KEYS`); while one is off its calls are no-ops.
 */

import type { WorldClient } from "../../world/WorldClient.js";
import { onWindowLayoutChanged } from "../GameWindows.js";
import { gameWindows } from "../ui/Dom.js";
import { notice } from "../ui/Notices.js";
import { applyBindingTables, bindingTables, onBindingsChanged } from "./Bindings.js";
import { BindingsSlotSync } from "./BindingsSlotSync.js";
import { INPUT_ACCOUNT_SYNC_KEYS, LayoutAccountSync, accountSyncEnabled } from "./InputAccount.js";

const onForeign = (): void => {
  notice("Расположение окон в данных персонажа записано в другом формате. Оно сохранено без изменений; используется локальное.",
    "info");
};

let stores: [BindingsSlotSync, LayoutAccountSync] | undefined;

function inputAccountStores(): [BindingsSlotSync, LayoutAccountSync] {
  if (!stores) {
    const layout = new LayoutAccountSync({
      layout: () => gameWindows.layout(),
      apply: (next) => gameWindows.applyLayout(next),
      onChanged: onWindowLayoutChanged,
    }, { onForeign });
    // Review 15.11: slot 6 is asked for once, by the settings store (ui/Settings.ts); this store listens.
    layout.requestsSlot = false;
    stores = [
      new BindingsSlotSync({ tables: bindingTables, apply: applyBindingTables, onChanged: onBindingsChanged }, {
        enabled: () => accountSyncEnabled(INPUT_ACCOUNT_SYNC_KEYS.bindings),
      }),
      layout,
    ];
  }
  return stores;
}

/** Asks for the slots once the character is known. */
export function attachInputAccount(world: WorldClient): void {
  for (const store of inputAccountStores()) store.attach(world);
}

/** `ACCOUNT_DATA_CHANGED`: takes the slot's copy when it is one of these. */
export function acceptInputAccount(type: number): boolean {
  return inputAccountStores().some((store) => store.accept(type));
}

/** Leaving the world: a pending write goes out first. */
export function detachInputAccount(): void {
  for (const store of stores ?? []) store.detach();
}
