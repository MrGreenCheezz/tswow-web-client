/**
 * 10.07 — the few glue CVars the client keeps between runs (Config.wtf in the original), kept in
 * this browser per gateway: the account name, the realm, the last character, and whether the
 * account asked for an authenticator code. No CVar named for a password is ever written.
 *
 * Only the names in `PERSISTED` are ever written. The stock `AccountLogin.lua` stores the plain
 * account name in the account pair; a login-screen module may store a reversible blob of name *and
 * password* in the same two CVars (the owner's LoginScreenModule does, through `SaveAccountString`).
 * Until 12.10 such a blob was refused; the owner's decision of 12.10 («стоит сохранять пароль») keeps
 * it, as Wow.exe keeps it in Config.wtf, so the module remembers its account across reloads as
 * written. The stock screen's own password is kept beside it (`GlueSavedPassword.ts`).
 *
 * Every `localStorage` access is in `try`: a browser with site data blocked still gets a working
 * login screen, with nothing remembered.
 */

export const GLUE_CVAR_STORAGE_PREFIX = "webclient.glue.cvars:";

/** The CVars that survive a reload. */
export const PERSISTED_GLUE_CVARS: readonly string[] = Object.freeze([
  "accountName", "accountList", "realmName", "lastCharacterIndex", "usesToken",
]);

const PERSISTED = new Set(PERSISTED_GLUE_CVARS);
const MAX_VALUE_LENGTH = 2048;

export interface GlueCVarStore {
  /** What was kept for this gateway; unknown names and oversized values are dropped. */
  load(): Record<string, string>;
  /** Called after every change to a CVar, with the whole current table. */
  save(name: string, cvars: ReadonlyMap<string, string>): void;
}

export function createGlueCVarStore(
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  gatewayOrigin: string,
): GlueCVarStore {
  const key = `${GLUE_CVAR_STORAGE_PREFIX}${gatewayOrigin}`;
  const read = (): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(key) ?? "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const kept: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (PERSISTED.has(name) && typeof value === "string" && value.length <= MAX_VALUE_LENGTH) kept[name] = value;
      }
      return kept;
    } catch {
      return {};
    }
  };
  return {
    load: read,
    save(name, cvars) {
      if (!PERSISTED.has(name)) return;
      const kept = read();
      for (const persisted of PERSISTED) {
        const value = cvars.get(persisted);
        if (value !== undefined && value.length <= MAX_VALUE_LENGTH) kept[persisted] = value;
      }
      try {
        storage?.setItem(key, JSON.stringify(kept));
      } catch {
        // Blocked or full: this session keeps its values in memory, which is all that is possible.
      }
    },
  };
}
