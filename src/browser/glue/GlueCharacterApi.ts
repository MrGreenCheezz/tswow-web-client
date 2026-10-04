import { RESPONSE_CODES } from "../../generated/responseCodes.js";
import { characterNeedsRename, RESPONSE_SUCCESS, type CharacterSummary } from "../../world/CharacterProtocol.js";
import { CHARACTER_FLAG_DECLINED, enterWorldRefusal } from "./GlueEnterGate.js";
import type { GlueLuaVm } from "./GlueLua.js";
import { messageFor, openStatusDialog, responseKey } from "./GlueMessages.js";
import { checkCharacterName, sameCharacterName, type GlueNameRuleOptions } from "./GlueNameRules.js";
import type { GlueSession } from "./GlueSession.js";

/**
 * The realm-list and character-select half of the glue C API.
 *
 * Every name here was a constant stub in G2 and is now answered from the live session. The
 * signatures are not invented: each one is read off the only caller in the client's own corpus, and
 * the comment on it names the line. That matters more than usual on this screen, because the corpus
 * unpacks fourteen values out of `GetRealmInfo` and ten out of `GetCharacterInfo` positionally —
 * one value in the wrong slot and the realm list colours every realm as "down".
 *
 * Kept out of `GlueApi.ts` because it is a different subject with a different dependency: this file
 * needs a session and a world connection, and the rest of the C API needs neither.
 */

/** What the 3D layer has to be told, from a screen that knows nothing about three.js. */
export interface GlueCharacterView {
  /** Draw the selected character in the backdrop, or clear it when there is none. */
  update(): void;
  /** Which Model frame the character is drawn in; `SetCharSelectModelFrame` names it. */
  setModelFrame(name: string): void;
}

/**
 * What `EnterWorld()` hands the host.
 *
 * The character and where it sat in the list, and nothing else: the world *connection* is the one
 * the session already owns and the host was handed when it supplied the connector, so passing it
 * here would be a second reference to the same socket with no owner. See `main.ts`, where the
 * handover is «suspend the glue screens, adopt the connection, call `enterWorld`».
 */
export interface GlueEnterWorldRequest {
  readonly character: CharacterSummary;
  /** 1-based, as `CharacterSelect` counts and as `SelectCharacter` was last told. */
  readonly index: number;
}

export interface GlueCharacterApiOptions {
  readonly vm: GlueLuaVm;
  readonly session: GlueSession;
  readonly setGlueScreen: (name: string) => void;
  readonly fireEvent: (event: string, ...args: readonly unknown[]) => void;
  readonly view?: GlueCharacterView;
  /** «Вход в игровой мир». Absent on a page with no world behind it, which then says so. */
  readonly enterWorld?: (request: GlueEnterWorldRequest) => void;
  /**
   * The pointer, in UI units with y measured from the bottom — `GetCursorPosition`'s own frame.
   *
   * `CharacterSelectFrame_OnUpdate` turns the character by the *difference* between two readings
   * of this, so a constant answer is a screen whose drag does nothing at all.
   */
  readonly cursor?: () => readonly [number, number];
  /** Recorded so the report can say what the corpus reached for that this slice does not do. */
  readonly onStub?: (name: string) => void;
  /** Which alphabets a new name may use right now (`forceEnglishNames`, the category's mask). */
  readonly nameRules?: () => GlueNameRuleOptions;
  /** The glue screen that is up (`GetCurrentGlueScreenName`), for an EnterWorld that had to wait. */
  readonly currentScreen?: () => string;
  /** `GetLocale()`: the declension step exists only on a ruRU client (10.09). */
  readonly locale?: () => string;
  /** `DisconnectFromServer()` also ends the auth connection kept for realm refreshes (10.08). */
  readonly onDisconnect?: () => void;
}

/** `RealmListUpdateRate()` — seconds between automatic refreshes of the realm dialog. */
const REALM_LIST_UPDATE_SECONDS = 10;

export function installGlueCharacterApi(options: GlueCharacterApiOptions): void {
  const { vm, session, view } = options;
  const number = (value: unknown, fallback = 0): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const stub = (name: string): void => { options.onStub?.(name); };

  /* --- The realm list ------------------------------------------------------------------------ */

  vm.registerGlobal("RequestRealmList", () => { session.requestRealmList(); return []; });
  vm.registerGlobal("CancelRealmListQuery", () => []);
  vm.registerGlobal("RealmListDialogCancelled", () => []);
  vm.registerGlobal("RealmListUpdateRate", () => [REALM_LIST_UPDATE_SECONDS]);
  vm.registerGlobal("SortRealms", () => []);
  // `RealmList.lua:33` calls this with the selected category and nothing else.
  vm.registerGlobal("GetNumRealms", (args) => [session.realmsIn(number(args[0], 1)).length]);
  vm.registerGlobal("GetSelectedCategory", () => [session.selectedCategory]);
  // Varargs: `RealmList_UpdateTabs(...)` counts them with `select("#", ...)` and names a tab from
  // each, so an empty list is a realm dialog with no tabs and not an error.
  vm.registerGlobal("GetRealmCategories", () => session.categories().map((category) => category.name));
  vm.registerGlobal("GetRealmInfo", (args) => {
    const row = session.realmRow(number(args[0], 1), number(args[1], 0));
    if (!row) return [];
    // The order is `RealmList.lua:47` exactly. `major/minor/revision/build/type` are left off the
    // end: this build does not read the version triplet off the wire, and `if (major)` on the next
    // line is the corpus' own test for that.
    return [
      row.name, row.numCharacters, row.invalidRealm, row.realmDown, row.currentRealm,
      row.pvp, row.rp, row.load, row.locked,
    ];
  });
  vm.registerGlobal("ChangeRealm", (args) => {
    session.changeRealm(number(args[0], 1), number(args[1], 0));
    return [];
  });
  // Locale and tournament gates: this client talks to one server with one locale, so both
  // questions are honestly "no" rather than recorded.
  vm.registerGlobal("IsInvalidLocale", () => [false]);
  vm.registerGlobal("IsTournamentRealmCategory", () => [false]);
  vm.registerGlobal("IsInvalidTournamentRealmCategory", () => [false]);

  /* --- The connection ------------------------------------------------------------------------ */

  // `CharacterSelect_OnShow` unpacks three and `RealmList_OnCancel` a fourth (`isDown`).
  vm.registerGlobal("GetServerName", () => {
    const server = session.serverName();
    return server ? [server.name, server.pvp, server.rp, server.down] : [];
  });
  vm.registerGlobal("IsConnectedToServer", () => [session.connected]);
  vm.registerGlobal("DisconnectFromServer", () => { session.closeWorld(); options.onDisconnect?.(); return []; });

  /* --- The character list -------------------------------------------------------------------- */

  vm.registerGlobal("GetNumCharacters", () => [session.characters.length]);
  vm.registerGlobal("GetCharacterInfo", (args) => {
    const row = session.characterRow(number(args[0], 0));
    if (!row) return [];
    // `CharacterSelect.lua:314`: name, race, class, level, zone, sex, ghost, PCC, PRC, PFC.
    // `class` and `zone` are the words the screen prints — `CHARACTER_SELECT_INFO` is
    // «Уровень %d, %s» and the location line is the zone — so they are names, not ids.
    return [
      row.name, row.race, row.className, row.level, row.zone, row.sex,
      row.ghost, row.customize, row.raceChange, row.factionChange,
    ];
  });
  vm.registerGlobal("GetCharacterListUpdate", () => { void session.refreshCharacters(); return []; });
  vm.registerGlobal("SelectCharacter", (args) => {
    session.selectCharacter(number(args[0], 0));
    view?.update();
    return [];
  });
  vm.registerGlobal("DeleteCharacter", (args) => {
    void session.deleteCharacter(number(args[0], 0));
    return [];
  });
  vm.registerGlobal("ReadyForAccountDataTimes", () => []);
  vm.registerGlobal("GetSelectBackgroundModel", (args) => [session.backgroundModel(number(args[0], 0))]);

  /* --- The 3D character ---------------------------------------------------------------------- */

  vm.registerGlobal("SetCharSelectModelFrame", (args) => {
    view?.setModelFrame(String(args[0] ?? ""));
    return [];
  });
  vm.registerGlobal("UpdateSelectionCustomizationScene", () => { view?.update(); return []; });
  vm.registerGlobal("GetCharacterSelectFacing", () => [session.facing]);
  vm.registerGlobal("SetCharacterSelectFacing", (args) => {
    session.setFacing(number(args[0], 0));
    return [];
  });
  vm.registerGlobal("GetCursorPosition", () => {
    const [x, y] = options.cursor?.() ?? [0, 0];
    return [x, y];
  });

  /* --- Entering the world -------------------------------------------------------------------- */

  const glueString = (key: string): string | undefined => vm.globalString(key);
  const okay = (text: string): void => {
    openStatusDialog((event, ...args) => { options.fireEvent(event, ...args); }, "OKAY", text);
  };
  /**
   * The EnterWorld click waiting for the session's last request to be answered: which character it
   * was for and on which screen. The latest click replaces an earlier one; a wait that ends with
   * another character selected or another screen up drops it, so the click never fires later from
   * the creation screen or for a character the player has moved away from.
   */
  let enterQueued: { readonly guid: bigint; readonly screen: string | undefined } | undefined;

  const enterWorld = (): void => {
    const character = session.selected;
    // `UpdateCharacterList` already disables the button with an empty list, so this is the case
    // where the list changed under a click — a delete that landed between the two.
    if (!character) {
      okay("Персонаж не выбран.");
      return;
    }
    // FUN_004d9bd0's gate, in its order: a locked character gets the OKAY dialog with code 84's or
    // 85's text; one the core has marked for a new name gets the rename dialog — the core would load
    // it only to refuse and kick it, and the screen would loop «disconnected → character select».
    // FORCE_RENAME_CHARACTER carries the key, which CharacterSelect.lua prints.
    const refusal = enterWorldRefusal(character.flags, { name: character.name, locale: options.locale?.() ?? "" });
    if (refusal?.kind === "locked") {
      okay(messageFor(refusal.key, glueString, refusal.text));
      return;
    }
    if (refusal?.kind === "rename") {
      options.fireEvent("FORCE_RENAME_CHARACTER", refusal.key);
      return;
    }
    // Step 4 (10.09): a Russian name with no declension yet. No argument: GlueLocalizationPost.lua
    // then shows the declension frame, whose OK calls DeclineCharacter below.
    if (refusal?.kind === "decline") {
      options.fireEvent("FORCE_DECLINE_CHARACTER");
      return;
    }
    // No host to hand it to: `glue.html` is a dev entry with no renderer, no HUD and no `game`
    // context behind it. Recorded and said out loud rather than silently doing nothing.
    if (!options.enterWorld) {
      stub("EnterWorld");
      okay("Вход в мир доступен на главной странице клиента (index.html).");
      return;
    }
    // The world reads the socket from the moment it logs in. A request of these screens still
    // waiting for its answer — a rename the player cancelled the wait for — would be a second reader
    // on it, so the handover waits for that answer and then checks the character again.
    if (session.busy) {
      const waiting = enterQueued !== undefined;
      enterQueued = { guid: character.guid, screen: options.currentScreen?.() };
      if (waiting) return;
      void session.idle().then(() => {
        const click = enterQueued;
        enterQueued = undefined;
        if (!click || !session.connected) return;
        if (session.selected?.guid !== click.guid || options.currentScreen?.() !== click.screen) return;
        enterWorld();
      });
      return;
    }
    // Everything after this belongs to the host: it suspends these screens, adopts the world
    // connection the session opened, and runs the DOM app's own `enterWorld`. The glue side keeps
    // the session and the socket, so the way back is a screen change and not a new login.
    options.enterWorld({ character, index: session.selectedIndex });
  };
  vm.registerGlobal("EnterWorld", () => { enterWorld(); return []; });

  /**
   * `DeclineCharacter(index, case1…case5)` — the declension frame's OK (10.09).
   *
   * The client's own (Wow.exe 0x4e3530, then 0x4d9a40): an empty or missing case, a row that is not
   * there, or a character already declined — nothing at all; otherwise the CANCEL dialog with
   * CHAR_DECLINE_IN_PROGRESS, CMSG_SET_PLAYER_DECLINED_NAMES, and 1. The client also checks each
   * case against the name with a rule of its own before sending; that rule is not reconstructed
   * here — the core applies `CheckDeclinedNames` and its refusal comes back as the dialog below.
   * The answer closes the status dialog; a refusal re-opens the frame with CHAR_DECLINE_FAILED.
   */
  vm.registerGlobal("DeclineCharacter", (args) => {
    const index = number(args[0], 0);
    const cases: string[] = [];
    for (let at = 1; at <= 5; at++) {
      const raw = args[at];
      const form = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
      if (form.length === 0) return [];
      cases.push(form);
    }
    const character = session.characters[index - 1];
    if (!character || (character.flags & CHARACTER_FLAG_DECLINED) !== 0) return [];
    options.fireEvent("OPEN_STATUS_DIALOG", "CANCEL",
      messageFor("CHAR_DECLINE_IN_PROGRESS", glueString, "Обновление персонажа..."));
    void session.declineCharacter(index, cases).then((outcome) => {
      // Cancelled, or failed (the connection's own dialog is already up).
      if (outcome === "cancelled" || outcome === "failed") return;
      options.fireEvent("CLOSE_STATUS_DIALOG");
      if (outcome !== "accepted") options.fireEvent("FORCE_DECLINE_CHARACTER", "CHAR_DECLINE_FAILED");
    });
    return [1];
  });

  /**
   * `RenameCharacter(index, name)` — the rename dialog's OK, Enter and nothing else.
   *
   * The client's own (FUN_004e3410, then FUN_004d8d20), step for step. The dialog hides itself only
   * when this answers something true (CharacterSelect.xml:1186, :1257):
   * - no name, a row that is not there, or a character without CHARACTER_FLAG_RENAME: nothing at
   *   all — no event, no answer;
   * - its current name again (case ignored, Ё still not Е): FORCE_RENAME_CHARACTER with
   *   CHAR_CREATE_NAME_IN_USE and no answer;
   * - a name the client's own rules refuse (`checkCharacterName`, the name as typed — a space is an
   *   invalid character): FORCE_RENAME_CHARACTER with that reason's key, and nil;
   * - otherwise the CANCEL dialog with CHAR_RENAME_IN_PROGRESS, CMSG_CHAR_RENAME, and 1.
   *
   * The answer (FUN_004da090) closes the status dialog; a refusal re-opens the rename dialog with
   * CHAR_CREATE_NAME_IN_USE for 50 and CHAR_RENAME_FAILED for anything else — the core answers a
   * taken name with 48, so that one reads «failed» in the original too. A success renames the row
   * and, when it is the selected one, carries on into the world.
   */
  vm.registerGlobal("RenameCharacter", (args) => {
    const index = number(args[0], 0);
    const raw = args[1];
    const name = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
    const character = session.characters[index - 1];
    if (name.length === 0 || !character || !characterNeedsRename(character)) return [];
    const renameAgain = (key: string): void => { options.fireEvent("FORCE_RENAME_CHARACTER", key); };
    if (sameCharacterName(name, character.name)) {
      renameAgain("CHAR_CREATE_NAME_IN_USE");
      return [];
    }
    const verdict = checkCharacterName(name, options.nameRules?.() ?? {});
    if (verdict !== RESPONSE_CODES.CHAR_NAME_SUCCESS) {
      renameAgain(responseKey(verdict, "create"));
      return [undefined];
    }
    // A connection that cannot carry the request (none, or a host's seam without the call): there is
    // nobody to wait for, so the rename dialog comes back rather than a CANCEL dialog that no answer
    // will ever close.
    if (!session.canRename(index)) {
      renameAgain("CHAR_RENAME_FAILED");
      return [undefined];
    }
    options.fireEvent("OPEN_STATUS_DIALOG", "CANCEL",
      messageFor("CHAR_RENAME_IN_PROGRESS", glueString, "Переименование персонажа..."));
    void session.renameCharacter(index, name).then((outcome) => {
      if (outcome.status === "unavailable") {
        // The connection went away between the check and the send.
        options.fireEvent("CLOSE_STATUS_DIALOG");
        renameAgain("CHAR_RENAME_FAILED");
        return;
      }
      // Cancelled (a late success is the session's to apply) or failed (its dialog is already up).
      if (outcome.status !== "answered") return;
      const { answer } = outcome;
      options.fireEvent("CLOSE_STATUS_DIALOG");
      if (answer.result !== RESPONSE_SUCCESS) {
        renameAgain(responseKey(answer.result, "rename"));
        return;
      }
      // The row as the answer names it, not as a re-read list might: the list is applied from the
      // answer (FUN_004e2870), so the character that goes in is the renamed one and not a stale row
      // that still carries the rename flag.
      session.applyRename(answer.guid ?? character.guid, answer.name ?? name);
      if (session.selected?.guid === character.guid) enterWorld();
    });
    return [1];
  });
}
