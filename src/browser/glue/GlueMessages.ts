import { AuthProtocolError, AuthServerProofError } from "../../auth/AuthProtocol.js";
import { AUTH_RESULT_NAMES, type AuthResultName } from "../../generated/authResults.js";
import { RESPONSE_CODE_NAMES, type ResponseCodeName } from "../../generated/responseCodes.js";
import { TransportClosedError, TransportConnectError } from "../../transport/WebSocketByteStream.js";
import { WorldAuthError } from "../../world/CharacterProtocol.js";

/**
 * A number the server answered with, as the string and the dialog the glue screens show.
 *
 * One place for what were three hand-written tables in `GlueCreation`, `GlueApi` and `GlueSession`
 * — one of which called 42-44 «invalid name». The numbers are the core's own enums, generated from
 * the TrinityCore checkout (`npm run protocol:generate`). The keys are the client's, read out of
 * Wow.exe 12340: a 104-entry table of GlueStrings names indexed by `ResponseCodes` value, every name
 * the enum's (docs/implementation/probes/A6/exe-response-table.out.txt); the paid-service result
 * handlers; the switch on the authserver's result byte and the dialog it opens. The text is whatever
 * the corpus the player runs defines for the key.
 *
 * Pure: the corpus is reached only through the lookup a caller passes, `vm.globalString` in the
 * page and a plain record in a test.
 */

/** Which screen asked: the client handles each screen's answer in its own function. */
export type GlueResponseContext = "create" | "delete" | "login" | "customize" | "faction" | "rename";

/** The corpus' string for a key, or `undefined` when it defines none. */
export type GlueStringLookup = (key: string) => string | undefined;

/** How a glue module fires an event into the corpus (`GlueApi.fireEvent`). */
export type GlueFireEvent = (event: string, ...args: readonly unknown[]) => void;

/** Creation, deletion and entering the world: each screen's «it failed», for a number the enum lacks. */
const UNKNOWN_RESPONSE_KEYS: Readonly<Record<"create" | "delete" | "login", string>> = {
  create: "CHAR_CREATE_UNKNOWN",
  delete: "CHAR_DELETE_FAILED",
  login: "CHAR_LOGIN_FAILED",
};

/**
 * 62-69 as the corpus spells them. GlueStrings.lua defines them only under their faction-change
 * names; the client's own table calls them `CHAR_CREATE_*`, which no corpus string answers to.
 */
const FACTION_CHANGE_REFUSALS: Readonly<Partial<Record<ResponseCodeName, string>>> = {
  CHAR_CREATE_RESTRICTED_RACECLASS: "CHAR_FACTION_CHANGE_RACECLASS_RESTRICTED",
  CHAR_CREATE_CHARACTER_CHOOSE_RACE: "CHAR_FACTION_CHANGE_CHOOSE_RACE",
  CHAR_CREATE_CHARACTER_ARENA_LEADER: "CHAR_FACTION_CHANGE_ARENA_LEADER",
  CHAR_CREATE_CHARACTER_DELETE_MAIL: "CHAR_FACTION_CHANGE_DELETE_MAIL",
  CHAR_CREATE_CHARACTER_SWAP_FACTION: "CHAR_FACTION_CHANGE_SWAP_FACTION",
  CHAR_CREATE_CHARACTER_RACE_ONLY: "CHAR_FACTION_CHANGE_RACE_ONLY",
  CHAR_CREATE_CHARACTER_GOLD_LIMIT: "CHAR_FACTION_CHANGE_GOLD_LIMIT",
  CHAR_CREATE_FORCE_LOGIN: "CHAR_FACTION_CHANGE_FORCE_LOGIN",
};

/**
 * Names the client's table uses and GlueStrings.lua never defines, and the corpus string that says
 * the same thing: 62-69 above, and `CHAR_NAME_CONSECUTIVE_SPACES`, which it has no string for at all.
 */
const CORPUS_RESPONSE_KEYS: Readonly<Partial<Record<ResponseCodeName, string>>> = {
  ...FACTION_CHANGE_REFUSALS,
  CHAR_NAME_CONSECUTIVE_SPACES: "CHAR_NAME_FAILURE",
};

const NAME_IN_USE: Readonly<Partial<Record<ResponseCodeName, string>>> = {
  CHAR_CREATE_NAME_IN_USE: "CHAR_CREATE_NAME_IN_USE",
};

/** A paid-service screen: the few codes its handler names, and its own failure for the rest. */
interface GlueServiceScreen {
  readonly keys: Readonly<Partial<Record<ResponseCodeName, string>>>;
  readonly otherwise: string;
}

/**
 * The client's result handlers for the paid services. Unlike creation, none of them reads the
 * response table for every code: each names a few and prints its screen's own failure for all the
 * others — 48 included, which the core answers from all three (CharacterHandler.cpp:1181, 1422,
 * 1678) and which would otherwise read «Ошибка создания персонажа».
 */
const SERVICE_SCREENS: Readonly<Record<"customize" | "faction" | "rename", GlueServiceScreen>> = {
  // FUN_004d9190, SMSG_CHAR_CUSTOMIZE: 50.
  customize: { keys: NAME_IN_USE, otherwise: "CHAR_CUSTOMIZE_FAILED" },
  // FUN_004d92d0, SMSG_CHAR_FACTION_CHANGE, which answers the race change too: 50 and 61-69.
  faction: {
    keys: {
      ...NAME_IN_USE,
      CHAR_CREATE_CHARACTER_IN_GUILD: "CHAR_FACTION_CHANGE_STILL_IN_GUILD",
      ...FACTION_CHANGE_REFUSALS,
    },
    otherwise: "CHAR_FACTION_CHANGE_FAILED",
  },
  // FUN_004da090, SMSG_CHAR_RENAME: 50.
  rename: { keys: NAME_IN_USE, otherwise: "CHAR_RENAME_FAILED" },
};

/** The GlueStrings key for a `ResponseCodes` value the screen in `context` received. */
export function responseKey(code: number, context: GlueResponseContext): string {
  const name = RESPONSE_CODE_NAMES.get(code);
  if (context === "customize" || context === "faction" || context === "rename") {
    const screen = SERVICE_SCREENS[context];
    return (name === undefined ? undefined : screen.keys[name]) ?? screen.otherwise;
  }
  if (name === undefined) return UNKNOWN_RESPONSE_KEYS[context];
  return CORPUS_RESPONSE_KEYS[name] ?? name;
}

/** The stock `GlueDialogTypes` a refusal opens, in their plain (not SimpleHTML) form. */
export type GlueLoginDialog = "OKAY" | "CONNECTION_HELP" | "PARENTAL_CONTROL" | "OKAY_WITH_URL";

/** A refusal as the client shows it. */
export interface GlueAuthMessage {
  /** The client's key for the refusal. */
  readonly key: string;
  /** What a corpus without `key` prints for the same refusal: the plain `AUTH_*` string. */
  readonly fallbackKey?: string;
  /** The `GlueDialogTypes` entry the client opens for it (FUN_004d80c0, FUN_004dab40). */
  readonly dialog: GlueLoginDialog;
  /** OPEN_STATUS_DIALOG's third argument, kept as `GlueDialog.data`. */
  readonly data?: string;
  /** What to print where there is no corpus to ask at all — the world half of the page. */
  readonly text?: string;
}

const refusal = (key: string, fallbackKey = "AUTH_FAILED"): GlueAuthMessage => ({ key, fallbackKey, dialog: "OKAY" });

/** Refusals the client makes itself, with no `AuthResult` behind them. */
export const CLIENT_LOGIN_REFUSALS = {
  /** DefaultServerLogin with an empty account name (FUN_004d8a30) — refused before connecting. */
  noAccountName: { key: "LOGIN_ENTER_NAME", dialog: "OKAY" },
  /** …and with an empty password. */
  noPassword: { key: "LOGIN_ENTER_PASSWORD", dialog: "OKAY" },
  /** The authserver's session proof did not match (`AuthServerProofError`). */
  badServerProof: { key: "LOGIN_BAD_SERVER_PROOF", fallbackKey: "AUTH_BAD_SERVER_PROOF", dialog: "OKAY" },
  /** Anything else that stopped a login, and the switch's own default: LOGIN_FAILED with its help button. */
  failed: { key: "LOGIN_FAILED", fallbackKey: "AUTH_FAILED", dialog: "CONNECTION_HELP" },
} as const satisfies Readonly<Record<string, GlueAuthMessage>>;

/**
 * FUN_008cb160 — the client's switch on the authserver's result byte (its jump tables are at
 * 0x8CB934 and 0x8CB8E4) — by the core's names. Each case picks an entry of the client's login-result
 * table (docs/implementation/probes/A6/exe-login-table.out.txt), and FUN_004d80c0 opens OKAY for it,
 * except PARENTAL_CONTROL for LOGIN_PARENTALCONTROL and CONNECTION_HELP for LOGIN_FAILED.
 *
 * 4 and 5 share one string, so a refusal never says which of name and password was wrong; the core
 * sends 4 for both, and for a wrong authenticator code too (AuthSession.cpp:321, 492, 558). A byte
 * the switch does not name — 0x0B, 0x0D and 0x13-0x15 among those the core declares — is its
 * default, LOGIN_FAILED. 0 and 0x0E never reach it: the client takes both as success.
 */
const AUTH_RESULT_REFUSALS: Readonly<Partial<Record<AuthResultName, GlueAuthMessage>>> = {
  WOW_FAIL_BANNED: refusal("LOGIN_BANNED", "AUTH_BANNED"),
  WOW_FAIL_UNKNOWN_ACCOUNT: refusal("LOGIN_UNKNOWN_ACCOUNT", "AUTH_UNKNOWN_ACCOUNT"),
  WOW_FAIL_INCORRECT_PASSWORD: refusal("LOGIN_UNKNOWN_ACCOUNT", "AUTH_UNKNOWN_ACCOUNT"),
  WOW_FAIL_ALREADY_ONLINE: refusal("LOGIN_ALREADYONLINE", "AUTH_ALREADY_ONLINE"),
  WOW_FAIL_NO_TIME: refusal("LOGIN_NOTIME", "AUTH_NO_TIME"),
  WOW_FAIL_DB_BUSY: refusal("LOGIN_DBBUSY", "AUTH_DB_BUSY"),
  WOW_FAIL_VERSION_INVALID: refusal("LOGIN_BADVERSION", "AUTH_VERSION_MISMATCH"),
  // The client starts a patch download here. This one downloads no patches, so it says what the
  // download would have fixed: the version is not the server's.
  WOW_FAIL_VERSION_UPDATE: refusal("LOGIN_BADVERSION", "AUTH_VERSION_MISMATCH"),
  WOW_FAIL_SUSPENDED: refusal("LOGIN_SUSPENDED", "AUTH_SUSPENDED"),
  WOW_FAIL_PARENTCONTROL: {
    key: "LOGIN_PARENTALCONTROL",
    fallbackKey: "AUTH_PARENTAL_CONTROL",
    dialog: "PARENTAL_CONTROL",
    data: "AUTH_PARENTAL_CONTROL_URL",
  },
  WOW_FAIL_LOCKED_ENFORCED: refusal("LOGIN_LOCKED_ENFORCED", "AUTH_LOCKED_ENFORCED"),
  WOW_FAIL_TRIAL_ENDED: refusal("LOGIN_TRIAL_EXPIRED"),
  WOW_FAIL_USE_BATTLENET: refusal("LOGIN_ACCOUNT_CONVERTED"),
  WOW_FAIL_CHARGEBACK: refusal("LOGIN_CHARGEBACK"),
  WOW_FAIL_INTERNET_GAME_ROOM_WITHOUT_BNET: refusal("LOGIN_IGR_WITHOUT_BNET"),
  WOW_FAIL_GAME_ACCOUNT_LOCKED: refusal("LOGIN_GAME_ACCOUNT_LOCKED"),
  WOW_FAIL_UNLOCKABLE_LOCK: refusal("LOGIN_UNLOCKABLE_LOCK"),
  WOW_FAIL_CONVERSION_REQUIRED: refusal("LOGIN_CONVERSION_REQUIRED"),
  WOW_FAIL_DISCONNECTED: refusal("DISCONNECTED"),
};

/** The refusal the client shows for an `AuthResult` byte, and its default for any other byte. */
export function authKey(code: number): GlueAuthMessage {
  const name = AUTH_RESULT_NAMES.get(code);
  return (name === undefined ? undefined : AUTH_RESULT_REFUSALS[name]) ?? CLIENT_LOGIN_REFUSALS.failed;
}

/**
 * Markup the way FUN_004d80c0 decides it: "<HTML>" anywhere in the text, in any case. Such a string
 * is SimpleHTML for GlueDialog.lua's *_HTML types; a plain type prints it into a FontString, tags
 * and all.
 */
export function isHtmlMessage(text: string | undefined): boolean {
  return text !== undefined && /<html>/i.test(text);
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
};

function decodeEntity(entity: string, name: string): string {
  if (name.startsWith("#")) {
    const hex = name[1] === "x" || name[1] === "X";
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }
  return HTML_ENTITIES[name.toLowerCase()] ?? entity;
}

/**
 * SimpleHTML as the plain text a FontString can show: whitespace collapses as HTML's does, a
 * paragraph, a header or a `<br/>` ends a line, a hyperlink keeps its text and loses its target,
 * entities are decoded once, and the client's own `|n` escapes stay for the FontString. Plain text
 * comes back untouched.
 */
export function flattenHtmlMessage(text: string): string {
  if (!isHtmlMessage(text)) return text;
  return text
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>|<\/(?:p|h[1-3])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => decodeEntity(entity, name))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Open a stock status dialog the way this renderer can draw it.
 *
 * GlueDialog_Show sizes its box while GlueDialog is still hidden, when the page measures the
 * FontString as 0 px tall; the stock UPDATE_STATUS_DIALOG handler measures the now-visible text and
 * sizes the box again, so a long refusal stays inside it. Markup is flattened into a plain type.
 *
 * 3.35-bounds (03.10): a *_HTML type opens exactly as the client opens it (FUN_004d80c0 fires only
 * OPEN_STATUS_DIALOG): the page as written into GlueDialogHTML, which GlueDialog_Show sizes from
 * `GetBoundsRect()` — the page's own height now (GlueBoundsRect.ts), measured whether or not the dialog
 * shows yet. UPDATE_STATUS_DIALOG would size the box from the hidden GlueDialogText instead.
 */
export function openStatusDialog(fire: GlueFireEvent, type: string, text: string, data?: string): void {
  if (/_HTML$/.test(type)) { // 3.35-bounds
    if (data === undefined) fire("OPEN_STATUS_DIALOG", type, text);
    else fire("OPEN_STATUS_DIALOG", type, text, data);
    return;
  }
  const plain = flattenHtmlMessage(text);
  if (data === undefined) fire("OPEN_STATUS_DIALOG", type, plain);
  else fire("OPEN_STATUS_DIALOG", type, plain, data);
  fire("UPDATE_STATUS_DIALOG", plain);
}

/** The corpus' text for `key`; `fallback` when there is no key, no corpus, or no such string. */
export function messageFor(
  key: string | undefined,
  glueString: GlueStringLookup | undefined,
  fallback: string,
): string {
  const text = key === undefined ? undefined : glueString?.(key);
  return text || fallback;
}

/**
 * A corpus format string filled the way its `%s` and `%d` expect: `%d`/`%i` truncate to an integer
 * as Lua 5.1's `format` does, `%%` is a percent sign, and a missing argument is empty.
 */
export function formatGlueString(format: string, ...args: readonly unknown[]): string {
  let next = 0;
  return format.replace(/%([%sdi])/g, (_match, spec: string) => {
    if (spec === "%") return "%";
    const value = args[next++];
    if (spec === "s") return value === undefined ? "" : String(value);
    const number = Number(value);
    return Number.isFinite(number) ? String(Math.trunc(number)) : "0";
  });
}

/**
 * Where a failure happened: the authserver login, the world connection of the glue screens, or a
 * character-creation request on it (whose non-transport failure is CHAR_CREATE_FAILED, not a login).
 */
export type GlueFailureContext = "auth" | "world" | "create";

/** `4290` — the gateway's refusal of a login storm (item 10.01); a close code, not a byte. */
const TOO_MANY_ATTEMPTS_CLOSE = 4290;

/**
 * The world-auth refusals FUN_004dab40 opens in OKAY_WITH_URL, and the global its HELP button
 * launches — Wow.exe 12340's own five-entry table at 0x9F4448 (code, URL key), read out of the file.
 */
const WORLD_AUTH_URLS: Readonly<Partial<Record<ResponseCodeName, string>>> = {
  AUTH_BANNED: "AUTH_BANNED_URL",
  AUTH_DB_BUSY: "AUTH_DB_BUSY_URL",
  AUTH_NO_TIME: "AUTH_NO_TIME_URL",
  AUTH_SUSPENDED: "AUTH_SUSPENDED_URL",
  AUTH_PARENTAL_CONTROL: "AUTH_PARENTAL_CONTROL_URL",
};

const okay = (key: string, text: string): GlueAuthMessage => ({ key, dialog: "OKAY", text });
const withText = (message: GlueAuthMessage, text: string): GlueAuthMessage => ({ ...message, text: message.text ?? text });

/**
 * The world's read loop failed under a character in play. Whatever broke the read — a close, a
 * backend gone, a stream error — the socket is gone and the player is told DISCONNECTED; the
 * connection-phase keys `describeFailure` picks (CHAR_LOGIN_FAILED, CHAR_LOGIN_NO_WORLD) name a login
 * that never happened here.
 */
export const WORLD_CONNECTION_LOST: GlueAuthMessage = okay("DISCONNECTED", "Соединение с сервером разорвано");

/**
 * An exception as the client's words for it, on the connection it happened on: the key, the stock
 * dialog and a Russian text for a host with no corpus. The exception's own message is English for
 * the log and never reaches a player.
 *
 * - An authserver's result byte is `authKey`; a session proof that does not match is the client's
 *   LOGIN_BAD_SERVER_PROOF.
 * - The realm's refusal of the session is the response table's key, and five of them open the
 *   client's OKAY_WITH_URL (see `WORLD_AUTH_URLS`).
 * - The gateway closes 1011 with a reason that starts «Backend» when the server behind it is gone
 *   (Gateway.ts `bridge()`): the authserver's LOGIN_SERVER_DOWN, or the realm's CHAR_LOGIN_NO_WORLD.
 *   4290 is item 10.01's login-storm refusal, for which the corpus has LOGIN_TOO_FAST. Any other
 *   close is DISCONNECTED; a socket that never opened is RESPONSE_FAILED_TO_CONNECT.
 * - Anything else is the connection's own «it failed»: the login's LOGIN_FAILED with its help
 *   button, the realm's CHAR_LOGIN_FAILED.
 */
export function describeFailure(error: unknown, context: GlueFailureContext): GlueAuthMessage {
  if (error instanceof AuthServerProofError) return withText(CLIENT_LOGIN_REFUSALS.badServerProof, "Недопустимый сервер");
  if (error instanceof AuthProtocolError && error.code !== undefined) return withText(authKey(error.code), "Ошибка авторизации");
  if (error instanceof WorldAuthError) {
    const key = responseKey(error.code ?? -1, "login");
    const name = error.code === undefined ? undefined : RESPONSE_CODE_NAMES.get(error.code);
    const url = name === undefined ? undefined : WORLD_AUTH_URLS[name];
    const text = "Игровой мир отказал во входе.";
    return url === undefined ? okay(key, text) : { key, dialog: "OKAY_WITH_URL", data: url, text };
  }
  if (error instanceof TransportConnectError) return okay("RESPONSE_FAILED_TO_CONNECT", "Не удалось соединиться с сервером.");
  if (error instanceof TransportClosedError) {
    if (error.code === TOO_MANY_ATTEMPTS_CLOSE) {
      return okay("LOGIN_TOO_FAST", "Слишком много попыток подключиться к серверу. Попробуйте еще раз через несколько минут.");
    }
    if (error.code === 1011 && error.reason.startsWith("Backend")) {
      return context === "auth"
        ? okay("LOGIN_SERVER_DOWN", "Сервер входа недоступен")
        : okay("CHAR_LOGIN_NO_WORLD", "Сервер недоступен");
    }
    return okay("DISCONNECTED", "Соединение с сервером разорвано");
  }
  if (context === "auth") return withText(CLIENT_LOGIN_REFUSALS.failed, "Ошибка подключения.");
  return context === "create"
    ? okay("CHAR_CREATE_FAILED", "Не удалось создать персонажа")
    : okay("CHAR_LOGIN_FAILED", "Ошибка входа");
}

/** How `showStatusMessage` reaches the corpus. */
export interface GlueStatusHost {
  readonly fire: GlueFireEvent;
  readonly glueString?: GlueStringLookup | undefined;
  /** Whether the corpus defines `GlueDialogTypes[type]`; without it only OKAY is trusted. */
  readonly hasDialogType?: ((type: string) => boolean) | undefined;
  /**
   * 3.35-review: whether GlueDialog is up showing `type` now. An *_HTML type that did not open — a Lua
   * error in GlueDialog_Show, such as a throw or no values from `GetBoundsRect` before its arithmetic —
   * falls back to the plain type with the page flattened, so a refusal is never left unsaid.
   */
  readonly dialogShown?: ((type: string) => boolean) | undefined;
}

/**
 * A refusal in the corpus' own words, in the stock dialog it names. GlueDialog_Show indexes
 * GlueDialogTypes unguarded, so a type the corpus does not define becomes OKAY (and loses its data)
 * rather than a Lua error.
 *
 * 3.35-bounds (03.10): markup opens the dialog's HTML twin, as FUN_004d80c0 does for a login result
 * whose string holds "<HTML>": OKAY_HTML, and CONNECTION_HELP_HTML for LOGIN_FAILED's CONNECTION_HELP
 * (the ruRU corpus writes 20 LOGIN_* strings that way, LOGIN_UNKNOWN_ACCOUNT among them). A corpus without
 * the twin keeps the plain type with the text flattened.
 */
export function showStatusMessage(host: GlueStatusHost, message: GlueAuthMessage, fallback = "Ошибка"): void {
  const text = messageFor(message.key, host.glueString,
    messageFor(message.fallbackKey, host.glueString, message.text ?? fallback));
  const stock = message.dialog === "OKAY" || (host.hasDialogType?.(message.dialog) ?? false);
  const twin = stock && (message.dialog === "OKAY" || message.dialog === "CONNECTION_HELP") && isHtmlMessage(text) // 3.35-bounds
    ? `${message.dialog}_HTML` : undefined; // 3.35-bounds
  if (twin !== undefined && (host.hasDialogType?.(twin) ?? false)) { // 3.35-bounds
    openStatusDialog(host.fire, twin, text, message.data); // 3.35-bounds
    if (host.dialogShown === undefined || host.dialogShown(twin)) return; // 3.35-review
  } // 3.35-bounds
  openStatusDialog(host.fire, stock ? message.dialog : "OKAY", text, stock ? message.data : undefined);
}
