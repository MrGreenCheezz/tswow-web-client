/**
 * 10.07 — the few glue CVars the client keeps between runs (Config.wtf in the original), kept in
 * this browser per gateway: the account name, the realm, the last character, and whether the
 * account asked for an authenticator code. Never a password.
 *
 * Only the names in `PERSISTED` are ever written. The account pair gets one more rule: the stock
 * `AccountLogin.lua` stores the plain account name there, but a login-screen module may store a
 * reversible blob of name *and password* in the same two CVars (the owner's LoginScreenModule does,
 * through `SaveAccountString`). A value that is not a plain account name — longer than the 16 bytes
 * a logon challenge can carry, or with a second half in `accountList` — is therefore not kept, and
 * whatever was kept for the pair before is removed. The module still works for the session; it
 * only is not remembered across reloads.
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
const MAX_ACCOUNT_BYTES = 16;
const ENCODER = new TextEncoder();

export interface GlueCVarStore {
  /** What was kept for this gateway; unknown names and oversized values are dropped. */
  load(): Record<string, string>;
  /** Called after every change to a CVar, with the whole current table. */
  save(name: string, cvars: ReadonlyMap<string, string>): void;
}

/** A plain account name, as the stock login screen stores it: what a logon challenge can carry. */
export function isPlainAccountName(accountName: string, accountList: string): boolean {
  return accountList === "" && ENCODER.encode(accountName).byteLength <= MAX_ACCOUNT_BYTES
    && !/[\s^]/.test(accountName);
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
      if (!isPlainAccountName(kept["accountName"] ?? "", kept["accountList"] ?? "")) {
        delete kept["accountName"];
        delete kept["accountList"];
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
      if (!isPlainAccountName(kept["accountName"] ?? "", kept["accountList"] ?? "")) {
        delete kept["accountName"];
        delete kept["accountList"];
      }
      try {
        storage?.setItem(key, JSON.stringify(kept));
      } catch {
        // Blocked or full: this session keeps its values in memory, which is all that is possible.
      }
    },
  };
}
