/**
 * 12.10 — the password of the remembered account, kept in this browser per gateway.
 *
 * Not the original's behaviour: Wow.exe keeps the account name in Config.wtf and never the password
 * (10.07, `GlueCVarStore`). The owner's decision of 12.10 («стоит сохранять пароль») adds it on top of
 * the stock flow without touching the corpus' Lua:
 *
 * - it is remembered only when the stock «Запомнить учетную запись» box asks to remember the account
 *   (`AccountLogin_Login` calls `SetSavedAccountName(name)` right after `DefaultServerLogin`), and only
 *   once that login has been accepted — a mistyped password is never stored;
 * - it is forgotten when the box is cleared or the name is changed (`SetSavedAccountName("")`, which
 *   the account field's OnTextChanged calls), and when the server refuses it;
 * - the login screen gets it back after `AccountLogin_OnShow`, which clears the password field
 *   (`GLUE_SAVED_PASSWORD_LUA`), and only for the name the field shows.
 *
 * Plain text in `localStorage` on the page's origin, as Config.wtf is plain text on disk: anyone with
 * this browser profile can read it. Every access is in `try`; blocked storage remembers nothing.
 */

export const GLUE_PASSWORD_STORAGE_PREFIX = "webclient.glue.password:";

/** The longest password kept; the stock field takes 16 letters (`AccountLoginPasswordEdit`). */
const MAX_PASSWORD_LENGTH = 256;

export interface GlueSavedLogin {
  readonly account: string;
  readonly password: string;
}

export interface GlueSavedPasswordStore {
  load(): GlueSavedLogin | undefined;
  save(account: string, password: string): void;
  clear(): void;
}

export function createGlueSavedPasswordStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined,
  gatewayOrigin: string,
): GlueSavedPasswordStore {
  const key = `${GLUE_PASSWORD_STORAGE_PREFIX}${gatewayOrigin}`;
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(storage?.getItem(key) ?? "null");
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const { account, password } = parsed as { account?: unknown; password?: unknown };
        if (typeof account !== "string" || typeof password !== "string" || account === "" || password === ""
          || password.length > MAX_PASSWORD_LENGTH) return undefined;
        return { account, password };
      } catch {
        return undefined;
      }
    },
    save(account, password) {
      if (account === "" || password === "" || password.length > MAX_PASSWORD_LENGTH) return;
      try {
        storage?.setItem(key, JSON.stringify({ account, password }));
      } catch {
        // Blocked or full: nothing is remembered, which is the stock client's own behaviour.
      }
    },
    clear() {
      try {
        storage?.removeItem(key);
      } catch {
        // Nothing was kept either.
      }
    },
  };
}

/** The global the wrapper below asks: the saved password for the name the field shows, or "". */
export const GLUE_SAVED_PASSWORD_GLOBAL = "__webclientSavedPassword";

/**
 * Run once after the TOC walk: `AccountLogin_OnShow` empties the password field, so the saved one is
 * put back after it, and the stock OnShow has already moved the caret to the password field for a
 * remembered name — Enter logs in. A corpus without the stock login screen is left alone.
 */
export const GLUE_SAVED_PASSWORD_LUA = `
local stock = AccountLogin_OnShow
if type(stock) == "function" and AccountLoginAccountEdit and AccountLoginPasswordEdit then
  AccountLogin_OnShow = function(...)
    stock(...)
    local password = ${GLUE_SAVED_PASSWORD_GLOBAL}(AccountLoginAccountEdit:GetText())
    if password ~= "" then
      AccountLoginPasswordEdit:SetText(password)
    end
  end
end`;
