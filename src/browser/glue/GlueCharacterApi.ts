import type { CharacterSummary } from "../../world/CharacterProtocol.js";
import type { GlueLuaVm } from "./GlueLua.js";
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
  vm.registerGlobal("DisconnectFromServer", () => { session.closeWorld(); return []; });

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

  vm.registerGlobal("EnterWorld", () => {
    const character = session.selected;
    // `UpdateCharacterList` already disables the button with an empty list, so this is the case
    // where the list changed under a click — a delete that landed between the two.
    if (!character) {
      options.fireEvent("OPEN_STATUS_DIALOG", "OKAY", "Персонаж не выбран.");
      return [];
    }
    // No host to hand it to: `glue.html` is a dev entry with no renderer, no HUD and no `game`
    // context behind it. Recorded and said out loud rather than silently doing nothing.
    if (!options.enterWorld) {
      stub("EnterWorld");
      options.fireEvent("OPEN_STATUS_DIALOG", "OKAY",
        "Вход в мир доступен на главной странице клиента (index.html).");
      return [];
    }
    // Everything after this belongs to the host: it suspends these screens, adopts the world
    // connection the session opened, and runs the DOM app's own `enterWorld`. The glue side keeps
    // the session and the socket, so the way back is a screen change and not a new login.
    options.enterWorld({ character, index: session.selectedIndex });
    return [];
  });
}
