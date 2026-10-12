/**
 * The developer flag (WORK_PLAN 4.11, the owner's decision 0.4g of 12.10).
 *
 * What only someone working on this client needs — the diagnostics window and the module window
 * editor it opens — is reachable only with it. Without it neither has a key, a game-menu entry or a
 * row in either bindings window, so the default layout is the stock one: O is TOGGLESOCIAL, as
 * DefaultBindings.wtf ships it, not «Диагностика». Nothing is removed; with the flag both work as
 * they did.
 *
 * `?dev=1` in the page address turns it on and `?dev=0` off; without the parameter this browser's
 * remembered choice decides, set from the console — `localStorage.setItem("webclient.developer", "1")`
 * and reload (the player app has no address bar; its tools are on F12). The query wins in both
 * directions, as `?legacy-login` does (glue/FrontDoor.ts), so a link can always override what a
 * browser remembers. Off by default, and off outside a browser.
 *
 * A leaf with no imports: the input table, both game menus and the bindings windows ask it.
 */

/** `?dev=…`. A bare `?dev` is `""` and means yes, as a bare `?legacy-login` does. */
export const DEVELOPER_PARAMETER = "dev";
/** The remembered choice: `"1"` (or true/yes/on) is on, anything else off. */
export const DEVELOPER_STORAGE_KEY = "webclient.developer";

const QUERY_ON = new Set(["", "1", "true", "yes", "on"]);
const QUERY_OFF = new Set(["0", "false", "no", "off"]);
const STORED_ON = new Set(["1", "true", "yes", "on"]);

/** Query flag first, then the remembered value, then off. Pure, for the tests. */
export function developerModeFrom(search: string, stored?: string | null): boolean {
  const flag = new URLSearchParams(search).get(DEVELOPER_PARAMETER);
  if (flag !== null) {
    const value = flag.trim().toLowerCase();
    if (QUERY_ON.has(value)) return true;
    if (QUERY_OFF.has(value)) return false;
  }
  return STORED_ON.has(stored?.trim().toLowerCase() ?? "");
}

let cached: boolean | undefined;

/**
 * Whether this page runs with the developer flag. Read once and kept: the entries it hides are built
 * once (the game menus, the editor's key), so a value that changed under them would show half a flag.
 */
export function developerMode(): boolean {
  cached ??= readPage();
  return cached;
}

/** Tests: force the flag; `undefined` reads the page again on the next ask. */
export function useDeveloperMode(value: boolean | undefined): void {
  cached = value;
}

function readPage(): boolean {
  const search = (globalThis as { location?: { search?: unknown } }).location?.search;
  let stored: string | null = null;
  try {
    stored = typeof localStorage === "undefined" ? null : localStorage.getItem(DEVELOPER_STORAGE_KEY);
  } catch {
    // Site data blocked: the getter throws. Nothing remembered, so the address alone decides.
    stored = null;
  }
  return developerModeFrom(typeof search === "string" ? search : "", stored);
}
