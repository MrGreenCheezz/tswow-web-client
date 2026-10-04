import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_LOGIN_REFUSALS, authKey, describeFailure, flattenHtmlMessage, formatGlueString, isHtmlMessage, messageFor,
  openStatusDialog, responseKey, showStatusMessage,
} from "../dist/code/browser/glue/GlueMessages.js";
import { WorldAuthError } from "../dist/code/world/CharacterProtocol.js";
import { TransportClosedError, TransportConnectError } from "../dist/code/transport/WebSocketByteStream.js";
import { RESPONSE_CODES, RESPONSE_CODE_NAMES } from "../dist/code/generated/responseCodes.js";
import { AUTH_RESULTS, AUTH_RESULT_NAMES } from "../dist/code/generated/authResults.js";
import { AuthProtocolError, AuthServerProofError, parseLogonProof } from "../dist/code/auth/AuthProtocol.js";
import { GlueSession } from "../dist/code/browser/glue/GlueSession.js";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { GlueLuaVm } from "../dist/code/browser/glue/GlueLua.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { fakeGlueSession } from "../dist/code/browser/glue/GlueFakeSession.js";

/**
 * 1.19: one table from a server's number to the string the glue screens print, as Wow.exe 12340
 * prints it.
 *
 * The numbers are the core's own enums (`ResponseCodes`, `AuthResult`), generated from the
 * TrinityCore checkout. The keys are the client's: its 104-entry table of GlueStrings names indexed
 * by `ResponseCodes` value (docs/implementation/probes/A6/exe-response-table.out.txt), the result
 * handlers of the paid services (FUN_004d9190, FUN_004d92d0, FUN_004da090) and the authserver
 * switch FUN_008cb160 with the dialog picker FUN_004d80c0 — decompiled from F:/Circle/Wow.exe.clean.
 */

const CONTEXTS = ["create", "delete", "login", "customize", "faction", "rename"];
const inRange = (from, to) => [...RESPONSE_CODE_NAMES.keys()].filter((code) => code >= from && code <= to);

/* --- ResponseCodes ------------------------------------------------------------------------------ */

test("every refusal the core can send has a key on every screen", () => {
  const codes = [...inRange(47, 69), ...inRange(72, 75), ...inRange(88, 103)];
  assert.equal(codes.length, 23 + 4 + 16, "the generated table covers all three ranges");
  for (const context of CONTEXTS) {
    for (const code of codes) {
      const key = responseKey(code, context);
      assert.equal(typeof key, "string", `${context} ${code}`);
      assert.match(key, /^[A-Z][A-Z0-9_]+$/, `${context} ${code}`);
    }
  }
});

test("42-44 are the account and character-list states, not three invalid names", () => {
  assert.equal(RESPONSE_CODE_NAMES.get(42), "ACCOUNT_CREATE_FAILED");
  assert.equal(RESPONSE_CODE_NAMES.get(43), "CHAR_LIST_RETRIEVING");
  assert.equal(RESPONSE_CODE_NAMES.get(44), "CHAR_LIST_RETRIEVED");
  for (const code of [42, 43, 44]) {
    assert.notEqual(responseKey(code, "create"), "CHAR_CREATE_INVALID_NAME", `code ${code}`);
    assert.equal(responseKey(code, "create"), RESPONSE_CODE_NAMES.get(code));
  }
});

test("a name refusal at creation is its own CHAR_NAME_* reason", () => {
  assert.equal(responseKey(88, "create"), "CHAR_NAME_FAILURE");
  assert.equal(responseKey(RESPONSE_CODES.CHAR_NAME_TOO_SHORT, "create"), "CHAR_NAME_TOO_SHORT");
  assert.equal(responseKey(90, "create"), "CHAR_NAME_TOO_SHORT");
  assert.equal(responseKey(92, "create"), "CHAR_NAME_INVALID_CHARACTER");
  assert.equal(responseKey(95, "create"), "CHAR_NAME_RESERVED");
  assert.equal(responseKey(103, "create"), "CHAR_NAME_DECLENSION_DOESNT_MATCH_BASE_NAME");
  // GlueStrings.lua has no CHAR_NAME_CONSECUTIVE_SPACES: the generic name refusal stands in.
  assert.equal(responseKey(100, "create"), "CHAR_NAME_FAILURE");
});

test("62-69 print their faction-change strings at creation, the only spelling the corpus has", () => {
  // The client's own name for 62 (CHAR_CREATE_RESTRICTED_RACECLASS) is defined nowhere in the
  // corpus, so creation prints the corpus string for the same refusal.
  assert.equal(responseKey(62, "create"), "CHAR_FACTION_CHANGE_RACECLASS_RESTRICTED");
  assert.equal(responseKey(69, "create"), "CHAR_FACTION_CHANGE_FORCE_LOGIN");
  // 61 has a create-screen string of its own.
  assert.equal(responseKey(61, "create"), "CHAR_CREATE_CHARACTER_IN_GUILD");
});

test("each paid-service screen singles out what its handler does and prints its own failure otherwise", () => {
  // FUN_004d92d0 (faction and race change): 50 and 61-69 by name, anything else FACTION_CHANGE_FAILED.
  const faction = {
    61: "CHAR_FACTION_CHANGE_STILL_IN_GUILD",
    62: "CHAR_FACTION_CHANGE_RACECLASS_RESTRICTED",
    63: "CHAR_FACTION_CHANGE_CHOOSE_RACE",
    64: "CHAR_FACTION_CHANGE_ARENA_LEADER",
    65: "CHAR_FACTION_CHANGE_DELETE_MAIL",
    66: "CHAR_FACTION_CHANGE_SWAP_FACTION",
    67: "CHAR_FACTION_CHANGE_RACE_ONLY",
    68: "CHAR_FACTION_CHANGE_GOLD_LIMIT",
    69: "CHAR_FACTION_CHANGE_FORCE_LOGIN",
  };
  // Every code, known or not. 0 is these screens' success and never reaches a dialog.
  for (const code of [...RESPONSE_CODE_NAMES.keys(), 104, 255, -1]) {
    const inUse = code === RESPONSE_CODES.CHAR_CREATE_NAME_IN_USE;
    // FUN_004d9190 (customize): 50, anything else CHAR_CUSTOMIZE_FAILED.
    assert.equal(responseKey(code, "customize"), inUse ? "CHAR_CREATE_NAME_IN_USE" : "CHAR_CUSTOMIZE_FAILED", `customize ${code}`);
    // FUN_004da090 (rename): 50, anything else CHAR_RENAME_FAILED.
    assert.equal(responseKey(code, "rename"), inUse ? "CHAR_CREATE_NAME_IN_USE" : "CHAR_RENAME_FAILED", `rename ${code}`);
    assert.equal(responseKey(code, "faction"),
      inUse ? "CHAR_CREATE_NAME_IN_USE" : faction[code] ?? "CHAR_FACTION_CHANGE_FAILED", `faction ${code}`);
  }
  // The core answers 48 from all three handlers (CharacterHandler.cpp:1181, 1422, 1678): it is the
  // screen's own failure, never «Ошибка создания персонажа».
  assert.equal(responseKey(48, "customize"), "CHAR_CUSTOMIZE_FAILED");
  assert.equal(responseKey(48, "faction"), "CHAR_FACTION_CHANGE_FAILED");
  assert.equal(responseKey(48, "rename"), "CHAR_RENAME_FAILED");
});

test("a refused delete names the core's reason", () => {
  assert.equal(responseKey(72, "delete"), "CHAR_DELETE_FAILED");
  assert.equal(responseKey(73, "delete"), "CHAR_DELETE_FAILED_LOCKED_FOR_TRANSFER");
  assert.equal(responseKey(74, "delete"), "CHAR_DELETE_FAILED_GUILD_LEADER");
  assert.equal(responseKey(75, "delete"), "CHAR_DELETE_FAILED_ARENA_CAPTAIN");
});

test("a code the table does not know is the screen's own «it failed», never a raw number", () => {
  const unknown = {
    create: "CHAR_CREATE_UNKNOWN", delete: "CHAR_DELETE_FAILED", login: "CHAR_LOGIN_FAILED",
    customize: "CHAR_CUSTOMIZE_FAILED", faction: "CHAR_FACTION_CHANGE_FAILED", rename: "CHAR_RENAME_FAILED",
  };
  for (const code of [104, 255, -1, 0.5, Number.NaN]) {
    for (const context of CONTEXTS) assert.equal(responseKey(code, context), unknown[context], `${context} ${code}`);
  }
  // The world handshake's own answers keep their AUTH_* names in the login context.
  assert.equal(responseKey(14, "login"), "AUTH_REJECT");
  assert.equal(responseKey(78, "login"), "CHAR_LOGIN_NO_WORLD");
});

/* --- AuthResult --------------------------------------------------------------------------------- */

/**
 * FUN_008cb160 — the client's switch on the authserver's result byte (jump tables 0x8CB934 and
 * 0x8CB8E4) — and the dialog FUN_004d80c0 opens for it, for every AuthResult the core declares:
 * [key, dialog, fallback key for a corpus without `key`, dialog data].
 */
const AUTH_TABLE = {
  // 0 and 0x0E are success in the client and never reach its switch; pinned so every name is here.
  WOW_SUCCESS: ["LOGIN_FAILED", "CONNECTION_HELP", "AUTH_FAILED"],
  WOW_SUCCESS_SURVEY: ["LOGIN_FAILED", "CONNECTION_HELP", "AUTH_FAILED"],
  WOW_FAIL_BANNED: ["LOGIN_BANNED", "OKAY", "AUTH_BANNED"],
  // One string for both, so a refusal does not say which of the two was wrong.
  WOW_FAIL_UNKNOWN_ACCOUNT: ["LOGIN_UNKNOWN_ACCOUNT", "OKAY", "AUTH_UNKNOWN_ACCOUNT"],
  WOW_FAIL_INCORRECT_PASSWORD: ["LOGIN_UNKNOWN_ACCOUNT", "OKAY", "AUTH_UNKNOWN_ACCOUNT"],
  WOW_FAIL_ALREADY_ONLINE: ["LOGIN_ALREADYONLINE", "OKAY", "AUTH_ALREADY_ONLINE"],
  WOW_FAIL_NO_TIME: ["LOGIN_NOTIME", "OKAY", "AUTH_NO_TIME"],
  WOW_FAIL_DB_BUSY: ["LOGIN_DBBUSY", "OKAY", "AUTH_DB_BUSY"],
  WOW_FAIL_VERSION_INVALID: ["LOGIN_BADVERSION", "OKAY", "AUTH_VERSION_MISMATCH"],
  // The client starts a patch download here; this client has none to start.
  WOW_FAIL_VERSION_UPDATE: ["LOGIN_BADVERSION", "OKAY", "AUTH_VERSION_MISMATCH"],
  WOW_FAIL_INVALID_SERVER: ["LOGIN_FAILED", "CONNECTION_HELP", "AUTH_FAILED"],
  WOW_FAIL_SUSPENDED: ["LOGIN_SUSPENDED", "OKAY", "AUTH_SUSPENDED"],
  WOW_FAIL_FAIL_NOACCESS: ["LOGIN_FAILED", "CONNECTION_HELP", "AUTH_FAILED"],
  WOW_FAIL_PARENTCONTROL: ["LOGIN_PARENTALCONTROL", "PARENTAL_CONTROL", "AUTH_PARENTAL_CONTROL", "AUTH_PARENTAL_CONTROL_URL"],
  WOW_FAIL_LOCKED_ENFORCED: ["LOGIN_LOCKED_ENFORCED", "OKAY", "AUTH_LOCKED_ENFORCED"],
  WOW_FAIL_TRIAL_ENDED: ["LOGIN_TRIAL_EXPIRED", "OKAY", "AUTH_FAILED"],
  WOW_FAIL_USE_BATTLENET: ["LOGIN_ACCOUNT_CONVERTED", "OKAY", "AUTH_FAILED"],
  // Declared by the core, not handled by the client's switch: its default.
  WOW_FAIL_ANTI_INDULGENCE: ["LOGIN_FAILED", "CONNECTION_HELP", "AUTH_FAILED"],
  WOW_FAIL_EXPIRED: ["LOGIN_FAILED", "CONNECTION_HELP", "AUTH_FAILED"],
  WOW_FAIL_NO_GAME_ACCOUNT: ["LOGIN_FAILED", "CONNECTION_HELP", "AUTH_FAILED"],
  WOW_FAIL_CHARGEBACK: ["LOGIN_CHARGEBACK", "OKAY", "AUTH_FAILED"],
  WOW_FAIL_INTERNET_GAME_ROOM_WITHOUT_BNET: ["LOGIN_IGR_WITHOUT_BNET", "OKAY", "AUTH_FAILED"],
  WOW_FAIL_GAME_ACCOUNT_LOCKED: ["LOGIN_GAME_ACCOUNT_LOCKED", "OKAY", "AUTH_FAILED"],
  WOW_FAIL_UNLOCKABLE_LOCK: ["LOGIN_UNLOCKABLE_LOCK", "OKAY", "AUTH_FAILED"],
  WOW_FAIL_CONVERSION_REQUIRED: ["LOGIN_CONVERSION_REQUIRED", "OKAY", "AUTH_FAILED"],
  WOW_FAIL_DISCONNECTED: ["DISCONNECTED", "OKAY", "AUTH_FAILED"],
};
const shape = ({ key, dialog, fallbackKey, data }) => [key, dialog, fallbackKey, data].filter((v) => v !== undefined);

test("every AuthResult the core declares is pinned to the client's own switch", () => {
  assert.deepEqual([...AUTH_RESULT_NAMES.values()].sort(), Object.keys(AUTH_TABLE).sort(),
    "a code the core adds has to be pinned here against the client");
  for (const [name, expected] of Object.entries(AUTH_TABLE)) {
    assert.deepEqual(shape(authKey(AUTH_RESULTS[name])), expected, name);
  }
  // The byte the core sends for an unknown account, a wrong password and a wrong TOTP alike
  // (AuthSession.cpp:321, 492, 558).
  assert.equal(authKey(0x04).key, "LOGIN_UNKNOWN_ACCOUNT");
});

test("a byte the core does not declare is the client's default: LOGIN_FAILED with its help button", () => {
  for (const code of [0x01, 0x02, 0x1a, 0x1f, 0x21, 0x7e, 0xfe, -1, 0.5]) {
    assert.deepEqual(shape(authKey(code)), ["LOGIN_FAILED", "CONNECTION_HELP", "AUTH_FAILED"], `0x${code.toString(16)}`);
  }
});

test("the refusals the client makes itself, with no AuthResult behind them", () => {
  assert.deepEqual(shape(CLIENT_LOGIN_REFUSALS.noAccountName), ["LOGIN_ENTER_NAME", "OKAY"]);
  assert.deepEqual(shape(CLIENT_LOGIN_REFUSALS.noPassword), ["LOGIN_ENTER_PASSWORD", "OKAY"]);
  assert.deepEqual(shape(CLIENT_LOGIN_REFUSALS.badServerProof), ["LOGIN_BAD_SERVER_PROOF", "OKAY", "AUTH_BAD_SERVER_PROOF"]);
  assert.deepEqual(shape(CLIENT_LOGIN_REFUSALS.failed), shape(authKey(0x7e)));
  // A server whose session proof does not match is the one refusal the protocol names itself.
  const proof = Uint8Array.of(1, 0, ...new Uint8Array(20).fill(7), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  assert.throws(() => parseLogonProof(proof, new Uint8Array(20)),
    (error) => error instanceof AuthServerProofError && error instanceof AuthProtocolError && error.code === undefined);
});

/* --- Text --------------------------------------------------------------------------------------- */

test("markup is what the client calls markup: <HTML> anywhere, in any case (FUN_004d80c0)", () => {
  assert.equal(isHtmlMessage("<HTML><BODY>x</BODY></HTML>"), true);
  assert.equal(isHtmlMessage("\n<html><body>x</body></html>"), true);
  assert.equal(isHtmlMessage("Неверный пароль <html>"), true);
  assert.equal(isHtmlMessage("<htm>Неверный пароль"), false);
  assert.equal(isHtmlMessage(""), false);
  assert.equal(isHtmlMessage(undefined), false);
});

test("an <html> string flattens to the plain text a FontString can show", () => {
  assert.equal(flattenHtmlMessage('<html><body><p align="CENTER">Ошибка подключения.</p></body></html>'),
    "Ошибка подключения.");
  // A hyperlink keeps its text and loses its target; an entity is decoded exactly once.
  assert.equal(flattenHtmlMessage('<html><body><p>Страница <a href="https://x.test/?a=1&amp;b=2">https://x.test/?a=1&amp;b=2</a>.</p></body></html>'),
    "Страница https://x.test/?a=1&b=2.");
  // Paragraphs, headers and <br/> are line breaks; whitespace collapses as HTML's does.
  assert.equal(flattenHtmlMessage("<html><body><h1>Заголовок</h1><p>Один  \n  два</p><p>Три<br/>Четыре<BR>Пять</p></body></html>"),
    "Заголовок\nОдин два\nТри\nЧетыре\nПять");
  // &nbsp; is a space HTML does not collapse, so it stays next to the one before it.
  assert.equal(flattenHtmlMessage("<html><body><p>&lt;b&gt; &quot;q&quot; &#39;s&#39; &#x41;&#66; &amp;amp; &nbsp;x</p></body></html>"),
    "<b> \"q\" 's' AB &amp;  x");
  // The client's own |n escape is not HTML and stays for the FontString to break on.
  assert.equal(flattenHtmlMessage("<html><body><p>Раз.|nДва.</p></body></html>"), "Раз.|nДва.");
  // Plain text is left exactly as it is.
  assert.equal(flattenHtmlMessage("Неверный пароль  <b>"), "Неверный пароль  <b>");
});

test("messageFor prints the corpus string, and the fallback only when there is none", () => {
  const lookup = (key) => ({ CHAR_NAME_TOO_SHORT: "Имя должно содержать не менее 2 символов", EMPTY: "" })[key];
  assert.equal(messageFor("CHAR_NAME_TOO_SHORT", lookup, "запасной"), "Имя должно содержать не менее 2 символов");
  assert.equal(messageFor("CHAR_NAME_CONSECUTIVE_SPACES", lookup, "запасной"), "запасной");
  assert.equal(messageFor("EMPTY", lookup, "запасной"), "запасной");
  assert.equal(messageFor(undefined, lookup, "запасной"), "запасной");
  assert.equal(messageFor("CHAR_NAME_TOO_SHORT", undefined, "запасной"), "запасной");
});

test("a status dialog opens, then re-measures its now-visible text; markup is flattened first", () => {
  const events = [];
  const fire = (...args) => events.push(args.map(String).join(" / "));
  openStatusDialog(fire, "OKAY", "Неверный пароль");
  openStatusDialog(fire, "CONNECTION_HELP", '<html><body><p align="CENTER">Ошибка <a href="u">подключения</a>.</p></body></html>');
  openStatusDialog(fire, "PARENTAL_CONTROL", "Родительский контроль", "AUTH_PARENTAL_CONTROL_URL");
  assert.deepEqual(events, [
    "OPEN_STATUS_DIALOG / OKAY / Неверный пароль",
    "UPDATE_STATUS_DIALOG / Неверный пароль",
    "OPEN_STATUS_DIALOG / CONNECTION_HELP / Ошибка подключения.",
    "UPDATE_STATUS_DIALOG / Ошибка подключения.",
    "OPEN_STATUS_DIALOG / PARENTAL_CONTROL / Родительский контроль / AUTH_PARENTAL_CONTROL_URL",
    "UPDATE_STATUS_DIALOG / Родительский контроль",
  ]);
});

/* --- 10.06: an exception as the client's words ------------------------------------------------- */

test("describeFailure names each failure the way the client does on the connection it happened on", () => {
  const backend = new TransportClosedError(1011, "Backend unavailable", true);
  const cases = [
    // [error, context, key, dialog, data]
    [new AuthProtocolError("Auth challenge failed with code 4", 0x04), "auth", "LOGIN_UNKNOWN_ACCOUNT", "OKAY"],
    [new AuthServerProofError(), "auth", "LOGIN_BAD_SERVER_PROOF", "OKAY"],
    [new WorldAuthError(14), "world", "AUTH_REJECT", "OKAY"],
    [new WorldAuthError(39), "world", "REALM_LIST_REALM_NOT_FOUND", "OKAY"],
    // Wow.exe's own table at 0x9F4448: these five open OKAY_WITH_URL with their *_URL global.
    [new WorldAuthError(28), "world", "AUTH_BANNED", "OKAY_WITH_URL", "AUTH_BANNED_URL"],
    [new WorldAuthError(31), "world", "AUTH_DB_BUSY", "OKAY_WITH_URL", "AUTH_DB_BUSY_URL"],
    [new WorldAuthError(30), "world", "AUTH_NO_TIME", "OKAY_WITH_URL", "AUTH_NO_TIME_URL"],
    [new WorldAuthError(32), "world", "AUTH_SUSPENDED", "OKAY_WITH_URL", "AUTH_SUSPENDED_URL"],
    [new WorldAuthError(33), "world", "AUTH_PARENTAL_CONTROL", "OKAY_WITH_URL", "AUTH_PARENTAL_CONTROL_URL"],
    [new WorldAuthError(undefined), "world", "CHAR_LOGIN_FAILED", "OKAY"],
    // Gateway.ts `bridge()` closes 1011 with "Backend …" when the server behind it is gone.
    [backend, "auth", "LOGIN_SERVER_DOWN", "OKAY"],
    [backend, "world", "CHAR_LOGIN_NO_WORLD", "OKAY"],
    [new TransportClosedError(1011, "Backend connection failed", true), "world", "CHAR_LOGIN_NO_WORLD", "OKAY"],
    [new TransportClosedError(1011, "Client stopped responding", true), "world", "DISCONNECTED", "OKAY"],
    [new TransportClosedError(1000, "", true), "world", "DISCONNECTED", "OKAY"],
    [new TransportClosedError(1006, "", false), "auth", "DISCONNECTED", "OKAY"],
    // Item 10.01's refusal of a login storm; the corpus has the words for it already.
    [new TransportClosedError(4290, "Too many login attempts", true), "auth", "LOGIN_TOO_FAST", "OKAY"],
    [new TransportConnectError("ws://gateway.test/auth"), "auth", "RESPONSE_FAILED_TO_CONNECT", "OKAY"],
    [new TransportConnectError("ws://gateway.test/world"), "world", "RESPONSE_FAILED_TO_CONNECT", "OKAY"],
    [new Error("anything"), "auth", "LOGIN_FAILED", "CONNECTION_HELP"],
    [new Error("anything"), "world", "CHAR_LOGIN_FAILED", "OKAY"],
    ["not even an Error", "world", "CHAR_LOGIN_FAILED", "OKAY"],
  ];
  for (const [error, context, key, dialog, data] of cases) {
    const failure = describeFailure(error, context);
    const label = `${error?.name ?? typeof error} ${error?.code ?? ""} ${context}`;
    assert.deepEqual([failure.key, failure.dialog, failure.data], [key, dialog, data], label);
    // Something to print on a host with no corpus at all (the world half of the page), in Russian.
    assert.match(failure.text ?? "", /[А-Яа-яЁё]/, label);
  }
});

test("formatGlueString fills %s and %d the way the corpus strings expect", () => {
  assert.equal(formatGlueString("Место в очереди: %d", 12), "Место в очереди: 12");
  assert.equal(formatGlueString("Свободных мест нет: %s\nМесто в очереди: %d", "Круг Теней", 3),
    "Свободных мест нет: Круг Теней\nМесто в очереди: 3");
  assert.equal(formatGlueString("%d%% из %i", 7.9, "12"), "7% из 12");
  assert.equal(formatGlueString("%s и %s", "одно"), "одно и ");
});

test("showStatusMessage prints the corpus string in the stock dialog it names, or in OKAY without one", () => {
  const events = [];
  const fire = (...args) => events.push(args.map(String).join(" / "));
  const strings = { AUTH_BANNED: "Заблокирована.", CHAR_LOGIN_FAILED: "Ошибка входа" };
  const glueString = (key) => strings[key];
  const banned = describeFailure(new WorldAuthError(28), "world");
  showStatusMessage({ fire, glueString, hasDialogType: () => true }, banned);
  showStatusMessage({ fire, glueString }, banned);
  // No corpus string at all: the failure's own text.
  showStatusMessage({ fire }, describeFailure(new TransportClosedError(1006, "", false), "world"));
  assert.deepEqual(events, [
    "OPEN_STATUS_DIALOG / OKAY_WITH_URL / Заблокирована. / AUTH_BANNED_URL",
    "UPDATE_STATUS_DIALOG / Заблокирована.",
    "OPEN_STATUS_DIALOG / OKAY / Заблокирована.",
    "UPDATE_STATUS_DIALOG / Заблокирована.",
    `OPEN_STATUS_DIALOG / OKAY / ${describeFailure(new TransportClosedError(1006, "", false), "world").text}`,
    `UPDATE_STATUS_DIALOG / ${describeFailure(new TransportClosedError(1006, "", false), "world").text}`,
  ]);
});

/* --- The screens that print them ---------------------------------------------------------------- */

test("a refused delete prints the core's reason in the corpus' words, and re-measures it", async () => {
  const canned = fakeGlueSession("charselect");
  const corpus = {
    CHAR_DELETE_FAILED: "Ошибка удаления персонажа",
    CHAR_DELETE_FAILED_GUILD_LEADER: "Этот персонаж является главой гильдии.",
  };
  const refuse = async (code, glueString) => {
    const events = [];
    const session = new GlueSession({
      fireEvent: (event, ...args) => events.push([event, ...args].map(String).join(" / ")),
      connect: async () => ({
        characters: async () => [...(await (await canned.connect()).characters())],
        deleteCharacter: async () => code,
        close: () => {},
      }),
      ...(glueString ? { glueString } : {}),
    });
    session.beginSession(canned.auth);
    await session.connect(canned.realm);
    events.length = 0;
    assert.equal(await session.deleteCharacter(1), code);
    assert.equal(session.characters.length, 3, "a refused delete leaves the list alone");
    session.close();
    return events;
  };
  const dialog = (text) => [`OPEN_STATUS_DIALOG / OKAY / ${text}`, `UPDATE_STATUS_DIALOG / ${text}`];
  const lookup = (key) => corpus[key];
  assert.deepEqual(await refuse(74, lookup), dialog("Этот персонаж является главой гильдии."));
  assert.deepEqual(await refuse(72, lookup), dialog("Ошибка удаления персонажа"));
  // A number the enum does not have is the delete screen's own «it failed».
  assert.deepEqual(await refuse(250, lookup), dialog("Ошибка удаления персонажа"));
  assert.deepEqual(await refuse(74), dialog("Удаление отклонено сервером, код 74."),
    "with no corpus to ask, the code is still reported rather than nothing");
});

const LOGIN_STRINGS = `
  GlueScreenInfo = {};
  SEEN = {};
  AUTH_FAILED = "Ошибка авторизации";
  AUTH_UNKNOWN_ACCOUNT = "Неизвестная учетная запись";
  AUTH_BANNED = "Учетная запись заблокирована";
  LOGIN_UNKNOWN_ACCOUNT = "<html><body><p align=\\"CENTER\\">Вы указали неверные сведения: <a href=\\"https://support.test/?a=1&amp;b=2\\">https://support.test/?a=1&amp;b=2</a>.</p></body></html>";
  LOGIN_UNLOCKABLE_LOCK = "Данная учетная запись была заблокирована, но может быть разблокирована.";
  LOGIN_TRIAL_EXPIRED = "<html><body><p align=\\"CENTER\\">Пробный период закончился.</p></body></html>";
  LOGIN_FAILED = "<html><body><p align=\\"CENTER\\">Ошибка подключения.</p></body></html>";
  LOGIN_PARENTALCONTROL = "Доступ ограничен родительским контролем.";
  LOGIN_ENTER_NAME = "Введите название учетной записи.";
  LOGIN_ENTER_PASSWORD = "Введите пароль.";
  LOGIN_BAD_SERVER_PROOF = "<html><body><p align=\\"CENTER\\">Вы пытаетесь подключиться к некорректному серверу.</p></body></html>";
  LOGIN_SERVER_DOWN = "Сервер входа недоступен";
  RESPONSE_FAILED_TO_CONNECT = "Ошибка соединения.";
  CHAR_DELETE_FAILED_GUILD_LEADER = "Этот персонаж является главой гильдии.";
  function SetGlueScreen(name) end
`;

/** `GlueDialogTypes`, with or without the two stock types the login refusals open besides OKAY. */
function fixture({ dialogTypes = true } = {}) {
  return {
    "Interface/GlueXML/GlueXML.toc": ["## Interface: 30300", "GlueStrings.lua", "GlueParent.xml"].join("\n"),
    "Interface/GlueXML/GlueStrings.lua": `${LOGIN_STRINGS}
      GlueDialogTypes = ${dialogTypes ? "{ OKAY = {}, CONNECTION_HELP = {}, PARENTAL_CONTROL = {} }" : "{ OKAY = {} }"};`,
    "Interface/GlueXML/GlueParent.xml": `<Ui>
      <Frame name="GlueParent" setAllPoints="true">
        <Scripts>
          <OnLoad>
            self:RegisterEvent("OPEN_STATUS_DIALOG");
            self:RegisterEvent("UPDATE_STATUS_DIALOG");
          </OnLoad>
          <OnEvent>
            SEEN[#SEEN + 1] = event .. " / " .. tostring(arg1) .. " / " .. tostring(arg2) .. " / " .. tostring(arg3);
          </OnEvent>
        </Scripts>
      </Frame>
    </Ui>`,
  };
}

/** Every OPEN/UPDATE_STATUS_DIALOG the corpus received, as `event / arg1 / arg2 / arg3`. */
function seen(runtime) {
  runtime.vm.setGlobal("__seen", undefined);
  const outcome = runtime.vm.execute('__seen = table.concat(SEEN, "\\n")', "@glue-messages-probe");
  assert.equal(outcome.ok, true, outcome.error);
  const text = runtime.vm.getGlobal("__seen");
  return typeof text === "string" && text ? text.split("\n") : [];
}

/**
 * `DefaultServerLogin(account, password)` against an authserver that answers the challenge with
 * `answer`: a result byte, or an error the stream throws. Returns every dialog event, the result
 * codes the host was told about, the diagnostics and how many connections were opened.
 */
async function login(answer, { account = "ACCOUNT", password = "irrelevant", dialogTypes = true } = {}) {
  const codes = [];
  const diagnostics = [];
  let connections = 0;
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(fixture({ dialogTypes })),
    api: {
      locale: "ruRU",
      authUrl: "ws://fixture.invalid/auth",
      connect: async () => {
        connections += 1;
        // A gateway that never answers: WebSocketByteStream.connect rejects before any stream exists.
        if (answer instanceof TransportConnectError) throw answer;
        return {
          send() {},
          async readExactly(length) {
            if (answer instanceof Error) throw answer;
            assert.equal(length, 3);
            return Uint8Array.of(0, 0, answer);
          },
          close() {},
        };
      },
      onAuthDiagnostic: (value) => codes.push(value),
      session: { onDiagnostic: (message) => diagnostics.push(message) },
    },
  });
  await runtime.load();
  try {
    await runtime.api.login(account, password);
    return { events: seen(runtime), codes, diagnostics, connections };
  } finally {
    runtime.close();
  }
}

/** The connecting dialog every attempt that reaches the network opens first. */
const CONNECTING = [
  "OPEN_STATUS_DIALOG / CANCEL / Соединение... / nil",
  "UPDATE_STATUS_DIALOG / Проверка учётной записи... / nil / nil",
];
const shown = (type, text, data) => [
  `OPEN_STATUS_DIALOG / ${type} / ${text} / ${data ?? "nil"}`,
  `UPDATE_STATUS_DIALOG / ${text} / nil / nil`,
];

test("DefaultServerLogin shows the client's LOGIN_* refusal, flattened into a plain dialog it re-measures", async () => {
  const unknown = "Вы указали неверные сведения: https://support.test/?a=1&b=2.";
  for (const code of [0x04, 0x05]) {
    const result = await login(code);
    assert.deepEqual(result.events, [...CONNECTING, ...shown("OKAY", unknown)], `0x0${code}`);
    assert.deepEqual(result.codes, [code]);
  }
  assert.deepEqual((await login(0x19)).events,
    [...CONNECTING, ...shown("OKAY", "Данная учетная запись была заблокирована, но может быть разблокирована.")]);
  assert.deepEqual((await login(0x11)).events, [...CONNECTING, ...shown("OKAY", "Пробный период закончился.")]);
});

test("the client's default and its parental-control refusal open their own stock dialogs", async () => {
  for (const code of [0x0b, 0x0d, 0x13, 0x7e]) {
    assert.deepEqual((await login(code)).events, [...CONNECTING, ...shown("CONNECTION_HELP", "Ошибка подключения.")],
      `0x${code.toString(16)}`);
  }
  assert.deepEqual((await login(0x0f)).events,
    [...CONNECTING, ...shown("PARENTAL_CONTROL", "Доступ ограничен родительским контролем.", "AUTH_PARENTAL_CONTROL_URL")]);
  // A corpus without those GlueDialogTypes gets OKAY: GlueDialog_Show indexes the table unguarded.
  assert.deepEqual((await login(0x7e, { dialogTypes: false })).events,
    [...CONNECTING, ...shown("OKAY", "Ошибка подключения.")]);
  assert.deepEqual((await login(0x0f, { dialogTypes: false })).events,
    [...CONNECTING, ...shown("OKAY", "Доступ ограничен родительским контролем.")]);
});

test("a corpus without the client's LOGIN_* string prints the plain AUTH_* one for the same refusal", async () => {
  assert.deepEqual((await login(0x03)).events, [...CONNECTING, ...shown("OKAY", "Учетная запись заблокирована")]);
});

test("DefaultServerLogin refuses empty fields and an impossible name before it connects (FUN_004d8a30)", async () => {
  const noName = await login(0x04, { account: "" });
  assert.deepEqual(noName.events, shown("OKAY", "Введите название учетной записи."));
  assert.equal(noName.connections, 0);
  const noPassword = await login(0x04, { password: "" });
  assert.deepEqual(noPassword.events, shown("OKAY", "Введите пароль."));
  assert.equal(noPassword.connections, 0);
  // The logon challenge carries at most 16 bytes of name: no authserver has such an account, and
  // the answer it would give is the unknown-account one.
  const tooLong = await login(0x04, { account: "ДЛИННОЕИМЯ" });
  assert.deepEqual(tooLong.events, shown("OKAY", "Вы указали неверные сведения: https://support.test/?a=1&b=2."));
  assert.equal(tooLong.connections, 0);
});

test("a failure with no result byte is shown in the client's words; the detail goes to the log", async () => {
  const forged = await login(new AuthServerProofError());
  assert.deepEqual(forged.events, [...CONNECTING, ...shown("OKAY", "Вы пытаетесь подключиться к некорректному серверу.")]);
  assert.deepEqual(forged.codes, []);
  const closed = await login(new Error("WebSocket transport closed"));
  assert.deepEqual(closed.events, [...CONNECTING, ...shown("CONNECTION_HELP", "Ошибка подключения.")]);
  assert.deepEqual(closed.diagnostics, ["login: WebSocket transport closed"]);
  assert.ok(!closed.events.some((line) => /WebSocket/.test(line)), "no English reaches the dialog");
});

test("DefaultServerLogin names a lost authserver and an unreachable gateway in the corpus' words", async () => {
  // Gateway.ts closes the socket 1011 "Backend unavailable" when the authserver behind it is gone.
  const down = await login(new TransportClosedError(1011, "Backend unavailable", true));
  assert.deepEqual(down.events, [...CONNECTING, ...shown("OKAY", "Сервер входа недоступен")]);
  assert.match(down.diagnostics[0], /^login: .*1011/);
  // Nothing answered the WebSocket at all: the connecting dialog is the only one that got up.
  const unreachable = await login(new TransportConnectError("ws://fixture.invalid/auth"));
  assert.deepEqual(unreachable.events, [
    "OPEN_STATUS_DIALOG / CANCEL / Соединение... / nil",
    ...shown("OKAY", "Ошибка соединения."),
  ]);
});

test("the live session asks the corpus for the delete reason", async () => {
  const canned = fakeGlueSession("charselect");
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(fixture()),
    api: {
      locale: "ruRU",
      session: {
        connect: async () => ({
          characters: async () => [...(await (await canned.connect()).characters())],
          deleteCharacter: async () => 74,
          close: () => {},
        }),
      },
    },
  });
  await runtime.load();
  try {
    runtime.session.beginSession(canned.auth);
    await runtime.session.connect(canned.realm);
    assert.equal(await runtime.session.deleteCharacter(1), 74);
    assert.deepEqual(seen(runtime), shown("OKAY", "Этот персонаж является главой гильдии."));
  } finally {
    runtime.close();
  }
});

/* --- Against the client's own corpus ------------------------------------------------------------ */

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

/**
 * The client's patch chain, opened once for this file. `clientArchives` hands every caller in the
 * process the same chain, so a test that closed it would leave the next one reading nothing.
 */
let chainOpened;
const clientChain = async () => {
  chainOpened ??= import("../tools/mpq.mjs").then(({ clientArchives }) => clientArchives(clientDirectory));
  return await chainOpened;
};
test.after(async () => {
  if (chainOpened) (await chainOpened).close();
});

/**
 * Codes whose key is deliberately not a GlueStrings entry. CHAR_NAME_SUCCESS is the name check's own
 * «the name is fine» and never reaches a dialog; the client's table names it and the corpus does not.
 */
const NOT_MESSAGES = new Map([[87, "CHAR_NAME_SUCCESS"]]);

test("every key the tables answer is a string the client's GlueStrings.lua defines", withClient, async () => {
  const chain = await clientChain();
  const vm = new GlueLuaVm();
  try {
    const bytes = await chain.read("Interface\\GlueXML\\GlueStrings.lua");
    assert.ok(bytes, "GlueStrings.lua is in the patch chain");
    const loaded = vm.execute(new TextDecoder("utf-8").decode(bytes), "@Interface\\GlueXML\\GlueStrings.lua");
    assert.equal(loaded.ok, true, loaded.error);
    const lookup = (key) => vm.globalString(key);

    const missing = [];
    const expect = (label, key) => {
      if (key !== undefined && !lookup(key)) missing.push(`${label}: ${key}`);
    };
    for (const context of CONTEXTS) {
      for (const [code, name] of RESPONSE_CODE_NAMES) {
        if (NOT_MESSAGES.get(code) === name) continue;
        expect(`${context} ${code}`, responseKey(code, context));
      }
      expect(`${context} unknown`, responseKey(-1, context));
    }
    for (const code of [...AUTH_RESULT_NAMES.keys(), 0x7e]) {
      expect(`auth 0x${code.toString(16)}`, authKey(code).key);
      expect(`auth 0x${code.toString(16)} fallback`, authKey(code).fallbackKey);
    }
    for (const [name, refusal] of Object.entries(CLIENT_LOGIN_REFUSALS)) {
      expect(name, refusal.key);
      expect(`${name} fallback`, refusal.fallbackKey);
    }
    assert.deepEqual(missing, []);
    // What is known about the one exception is still true of this corpus.
    for (const [, name] of NOT_MESSAGES) assert.equal(lookup(name), undefined, `${name} became a string`);
  } finally {
    vm.close();
  }
});

test("the stock GlueDialog.lua shows each kind of refusal in the dialog the client picks, without a Lua error", withClient, async () => {
  const chain = await clientChain();
  const luaErrors = [];
  let answer = 0x04;
  const runtime = new GlueRuntime({
    provider: {
      async read(path) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        return data ? new TextDecoder("utf-8").decode(data) : undefined;
      },
    },
    lua: { onError: (message) => luaErrors.push(message) },
    api: {
      locale: "ruRU",
      screenWidth: 1024,
      screenHeight: 768,
      authUrl: "ws://fixture.invalid/auth",
      connect: async () => ({
        send() {},
        async readExactly() { return Uint8Array.of(0, 0, answer); },
        close() {},
      }),
    },
  });
  const probe = (expression) => {
    runtime.vm.setGlobal("__probe", undefined);
    assert.equal(runtime.vm.execute(`__probe = ${expression}`, "@glue-messages-probe").ok, true, expression);
    return runtime.vm.getGlobal("__probe");
  };
  try {
    await runtime.load();
    const html = runtime.bridge.getFrame("GlueDialogHTML");
    const plain = runtime.bridge.getFrame("GlueDialogText");
    // 3.35-bounds (03.10): FUN_004d80c0 opens a markup string's HTML twin — OKAY_HTML, and
    // CONNECTION_HELP_HTML for LOGIN_FAILED — whose GlueDialogHTML draws the page as written and is sized
    // by GetBoundsRect (GlueBoundsRect.ts); PARENTAL_CONTROL has no twin, and this corpus' text is plain.
    const cases = [
      // The core's everyday refusal: LOGIN_UNKNOWN_ACCOUNT is markup in this corpus.
      [0x04, "OKAY_HTML", "LOGIN_UNKNOWN_ACCOUNT", undefined, true],
      [0x0b, "CONNECTION_HELP_HTML", "LOGIN_FAILED", undefined, true],
      [0x0f, "PARENTAL_CONTROL", "LOGIN_PARENTALCONTROL", "AUTH_PARENTAL_CONTROL_URL", false],
    ];
    for (const [code, which, key, data, markup] of cases) {
      answer = code;
      const source = runtime.vm.globalString(key);
      assert.equal(typeof source, "string", `the corpus loaded and defines ${key}`);
      await runtime.api.login("ACCOUNT", "irrelevant");
      assert.deepEqual(luaErrors, [], `unhandled Lua errors while showing 0x${code.toString(16)}`);
      assert.deepEqual(runtime.vm.errors, []);
      assert.equal(probe("GlueDialog.which"), which);
      assert.equal(probe("GlueDialog.data"), data);
      assert.equal(runtime.bridge.getFrame("GlueDialog")?.visible, true);
      assert.equal(html?.visible, markup, `${key}: GlueDialogHTML ${markup ? "draws" : "does not draw"} it`);
      assert.equal(plain?.visible, !markup);
      if (markup) {
        assert.equal(html?.text, source, "the page as written");
      } else {
        assert.equal(plain?.text, flattenHtmlMessage(source));
        assert.ok(!/<a |<p|<\/?html>/i.test(plain?.text ?? ""), `no markup left in ${key}`);
      }
    }
  } finally {
    runtime.close();
  }
});
