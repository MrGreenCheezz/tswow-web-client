/**
 * Which interface `index.html` opens with, and where the world sends the player back to.
 *
 * Deliberately the only module both halves of the client import: `app/Login.ts` needs to know
 * where a player who just left the world belongs, and it must not drag the Lua VM into
 * `index.html`'s main chunk to find out. So everything here is either a pure function or a
 * one-slot registry. The one run-time import is `Environment.ts`, a leaf module with no imports of
 * its own (the gateway policy's page defaults) — which keeps the whole truth table runnable in a
 * node test with no DOM.
 */

import type { GlueAuthMessage } from "./GlueMessages.js";
import { GATEWAY_ALLOWED_STORAGE_KEY, pageGatewayPolicy, type GatewayPolicy } from "../Environment.js";

export type FrontDoorMode = "glue" | "legacy";

/**
 * The console escape hatch, for a player who has to reach the old forms on a page they cannot
 * put a query parameter on.
 *
 * `localStorage.setItem("webclient.frontDoor", "legacy")` and reload; `"glue"` or
 * `localStorage.removeItem(...)` puts the GlueXML screens back. The query flag wins over it in
 * both directions, so a link can always override whatever this browser remembers.
 */
export const FRONT_DOOR_STORAGE_KEY = "webclient.frontDoor";

/** `?legacy-login=…`: the parity switch the plan promises («старый DOM-глю остаётся за флагом»). */
export const LEGACY_LOGIN_PARAMETER = "legacy-login";

/** Values a query flag may spell "yes" with. A bare `?legacy-login` is `""` and also means yes. */
const TRUTHY = new Set(["", "1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Query flag first, then this browser's remembered choice, then the GlueXML screens.
 *
 * The flag is read in both directions on purpose: `?legacy-login=0` has to be able to undo a
 * `localStorage` value set months ago from the console, or the escape hatch becomes a trap.
 */
export function frontDoorMode(search: string, stored?: string | null): FrontDoorMode {
  const flag = new URLSearchParams(search).get(LEGACY_LOGIN_PARAMETER);
  if (flag !== null) {
    const value = flag.trim().toLowerCase();
    if (TRUTHY.has(value)) return "legacy";
    if (FALSY.has(value)) return "glue";
  }
  return stored?.trim().toLowerCase() === "legacy" ? "legacy" : "glue";
}

/** Reads the remembered choice without letting a locked-down browser take the page down with it. */
export function storedFrontDoorMode(storage?: Pick<Storage, "getItem"> | null): string | null {
  try {
    return storage?.getItem(FRONT_DOOR_STORAGE_KEY) ?? null;
  } catch {
    // A browser with site data blocked throws on the *getter*, not on the read. The page still has
    // a front door: the default one.
    return null;
  }
}

/**
 * `?gateway=…` — the glue screens' answer to the DOM form's gateway field.
 *
 * The old login screen carried an editable address, and the GlueXML one has no such field: the
 * corpus' `AccountLogin` knows about an account and a password and nothing else. So the override
 * moves to the URL, where it is the same class of thing the text field was — something the person
 * sitting at this browser types to point their own client somewhere else.
 *
 * Accepts what a player is likely to paste: a bare `host:port`, an `http(s)://` origin, or the
 * `ws(s)://…/auth` URL the old field was pre-filled with. Anything else is refused rather than
 * half-understood, and the page falls back to the compiled default.
 */
export function parseGatewayOverride(search: string): string | undefined {
  const raw = new URLSearchParams(search).get("gateway")?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export type { GatewayPolicy };

export type GatewayOverride =
  | { readonly kind: "none" }
  | { readonly kind: "use"; readonly origin: string }
  | { readonly kind: "refused"; readonly origin: string; readonly reason: string };

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function normalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The policy verdict for `?gateway=`, with no DOM: (1) the page's own host on any port, (2) both
 * page and gateway on loopback — the development case, (3) the compiled default, (4) an explicit
 * allow-list entry. Anything unparseable is `none`, not `refused`: there is nothing to warn about.
 */
export function gatewayOverride(search: string, policy: GatewayPolicy): GatewayOverride {
  const origin = parseGatewayOverride(search);
  if (origin === undefined) return { kind: "none" };
  const hostname = new URL(origin).hostname;
  const pageHost = policy.pageHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname.replace(/^\[|\]$/g, "") === pageHost) return { kind: "use", origin };
  if (isLoopbackHostname(hostname) && isLoopbackHostname(pageHost)) return { kind: "use", origin };
  if (normalOrigin(policy.defaultOrigin) === origin) return { kind: "use", origin };
  if (policy.allowedOrigins.some((allowed) => normalOrigin(allowed) === origin)) return { kind: "use", origin };
  return {
    kind: "refused",
    origin,
    // Printed on the page the link opened, so it carries no instructions: a ready-made command that
    // trusts the link's own host is exactly what a phishing link would want the player to paste.
    reason: `?gateway=${origin} не разрешён: страница работает с ${policy.defaultOrigin}.`,
  };
}

/** For the console only: where the owner of a browser or a build adds a gateway it trusts. */
export const GATEWAY_ALLOW_HINT = "Доверенные адреса gateway: VITE_GATEWAY_ALLOWED_ORIGINS при сборке или "
  + `ключ localStorage "${GATEWAY_ALLOWED_STORAGE_KEY}" (JSON-массив origin) в этом браузере.`;

/**
 * The override a page may use, or `undefined` — the compiled default then applies.
 *
 * `policy` defaults to the one this page is running under (`Environment.pageGatewayPolicy`); tests
 * pass their own. A refusal is logged here so a page that only wants the origin still tells the
 * person why their link was ignored.
 */
export function frontDoorGatewayOrigin(search: string, policy: GatewayPolicy = pageGatewayPolicy()): string | undefined {
  const verdict = gatewayOverride(search, policy);
  if (verdict.kind === "refused") console.warn(`[gateway] ${verdict.reason} ${GATEWAY_ALLOW_HINT}`);
  return verdict.kind === "use" ? verdict.origin : undefined;
}

/** The WebSocket URL of one gateway route, from an http(s) origin. */
export function gatewaySocketUrl(origin: string, route: string): string {
  const url = new URL(route, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** Why the client is leaving the world. Each one is a real path through `app/`. */
export type WorldExit =
  /** `SMSG_LOGOUT_COMPLETE`: the server sat the character down and let go of it. */
  | "logout"
  /** The world read loop threw — the socket is gone. */
  | "connection-lost"
  /** `enterWorld` failed before the world became usable. */
  | "enter-failed"
  /** The player asked for the login screen: a different account. */
  | "relogin";

export interface FrontDoorReturn {
  readonly screen: "login" | "charselect";
  /**
   * Open the world connection again before listing characters.
   *
   * Not an optimisation to skip: `WorldClient.characters()` reads the socket directly through
   * `#waitFor`, and once `loginCharacter` has started `#readWorld` there are two readers on one
   * connection. Every return to the character list therefore gets a fresh connection, which is
   * cheap (the session key is still valid, so it is a reconnect and not a re-login) and is the one
   * rule that cannot be wrong regardless of how far into the world the client got.
   */
  readonly reconnect: boolean;
  /** Drop the world connection object; the socket behind it is dead or is being replaced. */
  readonly closeWorld: boolean;
}

/**
 * Where each exit lands, given whether the glue session still has a realm to go back to.
 *
 * `realmSelected` is the session's own `selectedRealm`: without one there is nothing to reconnect
 * to and nothing for `charselect` to draw, so the screen is the login one — which is also what the
 * original does when a session dies under it.
 */
export function frontDoorReturn(exit: WorldExit, realmSelected: boolean): FrontDoorReturn {
  if (exit === "relogin" || exit === "connection-lost") {
    return { screen: "login", reconnect: false, closeWorld: true };
  }
  if (!realmSelected) return { screen: "login", reconnect: false, closeWorld: true };
  // `connect()` closes the previous connection itself, so asking for both would close it twice.
  return { screen: "charselect", reconnect: true, closeWorld: false };
}

/**
 * What the world half of the client can ask of the glue half.
 *
 * Registered by `main.ts` after the glue runtime is up, so `app/Login.ts` can route a player out
 * of the world without importing the runtime — and so that in legacy mode nothing is registered
 * and every path keeps its old DOM behaviour by construction.
 */
export interface FrontDoorHost {
  /** The world is about to cover the screen: stop the music, the 3D and the clock. */
  enteringWorld(): void;
  /**
   * The world is over. Bring the right glue screen back, and say why in the corpus' own words: the
   * message is a key with a plain fallback (`GlueAuthMessage`), never an exception's text.
   */
  returnFromWorld(exit: WorldExit, message?: GlueAuthMessage): void;
}

let host: FrontDoorHost | undefined;

/** Called once by the page that owns a glue runtime; `undefined` puts the DOM flow back in charge. */
export function useFrontDoor(next: FrontDoorHost | undefined): void {
  host = next;
}

/** The registered host, or `undefined` in legacy mode. */
export function frontDoorHost(): FrontDoorHost | undefined {
  return host;
}
