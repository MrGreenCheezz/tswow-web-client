import { canSelectRealm, REALM_FLAG_OFFLINE, type RealmInfo } from "../../auth/AuthProtocol.js";
import type { AuthSessionResult } from "../../auth/login.js";
import type { CharacterSummary, RenameResult } from "../../world/CharacterProtocol.js";
import {
  describeFailure, formatGlueString, messageFor, openStatusDialog, responseKey, showStatusMessage,
  type GlueStringLookup,
} from "./GlueMessages.js";

/**
 * What the glue screens know about the account, the realms and the characters on one of them.
 *
 * The glue runtime owns this outright. It deliberately shares nothing with the DOM app's
 * `game`/`Context`: that object is the *world* session — a store, a HUD binding, a module loader —
 * and the two would fight over one socket the moment somebody logged in twice. Everything the
 * screens need is here, the world connection included, and closing the session closes it.
 *
 * The connection itself arrives as a seam rather than as a `WorldClient` import, so the realm and
 * character C-API can be driven end to end by a fake in a node test. `main.ts` passes the real
 * `WorldClient.connect` over a `WebSocketByteStream`; the tests pass three canned characters.
 */

/** The half of `WorldClient` the glue screens use. */
export interface GlueWorldConnection {
  characters(): Promise<CharacterSummary[]>;
  deleteCharacter(guid: bigint): Promise<number>;
  /**
   * `CMSG_CHAR_CREATE`. Optional because a connection that cannot create is a usable connection —
   * the character-select screen works without it, and a fake that only lists characters stays a
   * two-line object.
   */
  createCharacter?(request: GlueCreateCharacterRequest): Promise<number>;
  /** `CMSG_CHAR_RENAME`, optional for the same reason: the answer, with the name the core normalised. */
  renameCharacter?(guid: bigint, name: string): Promise<RenameResult>;
  close(): void;
}

/** `CMSG_CHAR_CREATE`'s payload, in `world/CharacterProtocol.ts`'s own field names. */
export interface GlueCreateCharacterRequest {
  name: string;
  race: number;
  classId: number;
  gender: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
  outfitId: number;
}

/**
 * How far a world connection has come, as the connector reports it: the socket is open and the
 * session is being checked, or the realm has queued it (`position`, again every time it moves).
 */
export interface GlueConnectProgress {
  readonly stage: "authenticating" | "queued";
  readonly position?: number;
}

/**
 * Opens the world connection for a realm. `progress` hears the stages above; `signal` is aborted
 * when the player cancels the connecting dialog, and the connector closes its socket then — which
 * is what ends a wait in the realm's queue.
 */
export type GlueWorldConnector = (
  realm: RealmInfo,
  auth: AuthSessionResult,
  progress?: (progress: GlueConnectProgress) => void,
  signal?: AbortSignal,
) => Promise<GlueWorldConnection>;

/**
 * Names and display ids the screens have to show, from wherever the host gets them.
 *
 * Injected because a node test has no gateway and because the answers are per dataset: a custom
 * race is named by `ChrRaces` on the server the player is actually on, not by a table compiled into
 * this file.
 */
export interface GlueNameLookup {
  raceName(race: number): string;
  className(classId: number): string;
  /** The zone a character is parked in, or "" when the area table has not arrived. */
  zoneName(zone: number): string;
  /** `CreatureDisplayInfo` row for a race and sex, or undefined when the dataset has none. */
  raceDisplayId(race: number, sex: number): number | undefined;
}

export interface GlueSessionOptions {
  readonly connect?: GlueWorldConnector;
  /** How the session tells the corpus something happened; `GlueApi.fireEvent` in the live page. */
  readonly fireEvent: (event: string, ...args: readonly unknown[]) => void;
  /** Asks the corpus to change screens, exactly as the C side does after a realm is chosen. */
  readonly setGlueScreen?: (name: string) => void;
  readonly names?: GlueNameLookup;
  readonly onDiagnostic?: (message: string) => void;
  /** The corpus' string for a GlueStrings key (`vm.globalString` in the page); a refusal's text. */
  readonly glueString?: GlueStringLookup;
  /** Whether the corpus defines `GlueDialogTypes[type]`, for a refusal the client shows in one. */
  readonly hasDialogType?: (type: string) => boolean;
}

/**
 * `RealmFlags`, read from the core this client talks to
 * (`TrinityCore/src/server/shared/Realm/Realm.h:26-36`).
 *
 * The three the realm list turns into a load figure are not a population at all — the authserver
 * sets them as flags and the original client maps each to one of the sentinel values `RealmList.lua`
 * compares against (`load == -3` recommended, `-2` new, `2` full).
 */
const REALM_FLAG_VERSION_MISMATCH = 0x01;
const REALM_FLAG_RECOMMENDED = 0x20;
const REALM_FLAG_NEW = 0x40;
const REALM_FLAG_FULL = 0x80;

/** `RealmType`, second column of `Cfg_Configs.dbc` (`Realm.h:49-56`). */
const REALM_TYPE_PVP = 1;
const REALM_TYPE_RP = 6;
const REALM_TYPE_RPPVP = 8;

/** `CharacterFlags` / `CharacterCustomizeFlags` (`Player.cpp:144-187`). */
const CHARACTER_FLAG_GHOST = 0x00002000;
const CHAR_CUSTOMIZE_FLAG_CUSTOMIZE = 0x00000001;
const CHAR_CUSTOMIZE_FLAG_FACTION = 0x00010000;
const CHAR_CUSTOMIZE_FLAG_RACE = 0x00100000;

/** `SMSG_CHAR_DELETE`'s success code, the same number `app/Login.ts:246` checks. */
export const CHAR_DELETE_SUCCESS = 71;

/** `SMSG_CHAR_CREATE`'s success code, the same number `WorldClient.ts:534` checks. */
export const CHAR_CREATE_SUCCESS = 47;

/**
 * The fourteen values `GetRealmInfo(category, index)` hands `RealmListUpdate`, in its order.
 *
 * Read off `RealmList.lua:47`, which is the only caller: `name, numCharacters, invalidRealm,
 * realmDown, currentRealm, pvp, rp, load, locked, major, minor, revision, build, type`. The three
 * version numbers come back `undefined` on purpose — the authserver only writes them when the realm
 * sets `REALM_FLAG_SPECIFYBUILD`, and `src/auth/AuthProtocol.ts` reads past them without keeping
 * them, so there is nothing honest to answer. `RealmList.lua:97` tests `if (major)` and falls back
 * to the plain name, which is exactly the right behaviour for "this build does not know".
 */
export interface GlueRealmRow {
  readonly name: string;
  readonly numCharacters: number;
  readonly invalidRealm: boolean;
  readonly realmDown: boolean;
  readonly currentRealm: number;
  readonly pvp: boolean;
  readonly rp: boolean;
  readonly load: number;
  readonly locked: boolean;
}

/** The ten values `GetCharacterInfo(index)` hands `UpdateCharacterList` (`CharacterSelect.lua:314`). */
export interface GlueCharacterRow {
  readonly name: string;
  readonly race: string;
  readonly className: string;
  readonly level: number;
  readonly zone: string;
  readonly sex: number;
  readonly ghost: boolean;
  readonly customize: boolean;
  readonly raceChange: boolean;
  readonly factionChange: boolean;
}

/**
 * Which `Interface\Glues\Models\UI_<name>` set stands behind a character, by race.
 *
 * Measured against the running gateway, all ten playable races asked for by name: `UI_Gnome` and
 * `UI_Troll` answer **404** — they do not exist in this client — while the other eight resolve
 * (Human 450,267 B, Orc 129,693, Dwarf 420,864, NightElf 123,760, Tauren 268,514, Scourge 386,486,
 * Draenei 208,322, BloodElf 810,105). So a gnome borrows the dwarf's Ironforge set and a troll the
 * orc's Durotar one, which is what the original does and what the reference client's map says.
 */
const RACE_BACKGROUND_MODEL: Readonly<Record<number, string>> = Object.freeze({
  1: "Human", 2: "Orc", 3: "Dwarf", 4: "NightElf", 5: "Scourge", 6: "Tauren",
  7: "Dwarf", 8: "Orc", 10: "BloodElf", 11: "Draenei",
});

/** Death knights get their own backdrop whatever race they are; `UI_DeathKnight.m2` is 356,472 B. */
const DEATH_KNIGHT_CLASS = 6;

export function glueBackgroundModelFor(race: number, classId: number): string {
  if (classId === DEATH_KNIGHT_CLASS) return "DeathKnight";
  return RACE_BACKGROUND_MODEL[race] ?? "Human";
}

/** A category of the realm list: the tabs across the top of `RealmList`. */
export interface GlueRealmCategory {
  readonly id: number;
  readonly name: string;
}

export class GlueSession {
  readonly #options: GlueSessionOptions;
  #auth: AuthSessionResult | undefined;
  #realms: readonly RealmInfo[] = [];
  #selectedCategory = 1;
  #selectedRealm: RealmInfo | undefined;
  #world: GlueWorldConnection | undefined;
  #connecting = false;
  #characterRefresh: Promise<void> | undefined;
  #characters: readonly CharacterSummary[] = [];
  #selectedIndex = 0;
  #facing = 0;
  /** Bumped by every connect and every relogin; a late reply from an older one is dropped. */
  #generation = 0;
  /** The connecting dialog of a ChangeRealm is up; the first character list closes it. */
  #announced = false;
  /** Tells the connector of the connection in flight to close its socket. */
  #abort: AbortController | undefined;
  /** Bumped by every rename and every cancel of one; an answer to an older one is dropped. */
  #renameGeneration = 0;
  #renaming = false;

  constructor(options: GlueSessionOptions) {
    this.#options = options;
  }

  get auth(): AuthSessionResult | undefined {
    return this.#auth;
  }

  get realms(): readonly RealmInfo[] {
    return this.#realms;
  }

  get characters(): readonly CharacterSummary[] {
    return this.#characters;
  }

  get selectedRealm(): RealmInfo | undefined {
    return this.#selectedRealm;
  }

  get selectedCategory(): number {
    return this.#selectedCategory;
  }

  /** 1-based, as the corpus counts; 0 when nothing is selected. */
  get selectedIndex(): number {
    return this.#selectedIndex;
  }

  get connected(): boolean {
    return this.#world !== undefined;
  }

  /** Degrees, the unit `CHARACTER_FACING_INCREMENT = 2` and `CHARACTER_ROTATION_CONSTANT` work in. */
  get facing(): number {
    return this.#facing;
  }

  setFacing(degrees: number): void {
    this.#facing = Number.isFinite(degrees) ? degrees : 0;
  }

  /** The character the screen is showing, if there is one. */
  get selected(): CharacterSummary | undefined {
    return this.#characters[this.#selectedIndex - 1];
  }

  /** A fresh SRP6 result: a new account, a new realm list, and nothing carried over. */
  beginSession(auth: AuthSessionResult): void {
    this.close();
    this.#auth = auth;
    this.#realms = auth.realms;
    this.#selectedCategory = 1;
    this.#selectedRealm = undefined;
  }

  /**
   * The realm list's category tabs.
   *
   * A category in 3.3.5 is `Cfg_Categories.dbc` and the authserver hands only its number, in the
   * realm's `timezone` byte — so the categories are exactly the distinct timezones the list came
   * with, in order. A private server sends one, and `RealmList_UpdateTabs` hides the tab row
   * entirely when there is only one, which is the original's behaviour and not a shortcut.
   */
  categories(): GlueRealmCategory[] {
    const seen = new Set<number>();
    for (const realm of this.#realms) seen.add(realm.timezone);
    const ids = [...seen].sort((left, right) => left - right);
    if (ids.length === 0) return [];
    return ids.map((id) => ({ id, name: String(id) }));
  }

  /** Realms in one category, in the order the authserver listed them. */
  realmsIn(category: number): RealmInfo[] {
    const ids = this.categories();
    const wanted = ids[Math.max(0, category - 1)]?.id;
    if (wanted === undefined) return [];
    return this.#realms.filter((realm) => realm.timezone === wanted);
  }

  realmRow(category: number, index: number): GlueRealmRow | undefined {
    const realm = this.realmsIn(category)[index - 1];
    if (!realm) return undefined;
    return {
      name: realm.name,
      numCharacters: realm.characters,
      invalidRealm: (realm.flags & REALM_FLAG_VERSION_MISMATCH) !== 0,
      realmDown: (realm.flags & REALM_FLAG_OFFLINE) !== 0,
      currentRealm: this.#selectedRealm?.id === realm.id ? 1 : 0,
      pvp: realm.type === REALM_TYPE_PVP || realm.type === REALM_TYPE_RPPVP,
      rp: realm.type === REALM_TYPE_RP || realm.type === REALM_TYPE_RPPVP,
      load: realmLoad(realm),
      locked: realm.locked,
    };
  }

  selectCategory(category: number): void {
    if (category > 0) this.#selectedCategory = category;
  }

  /** `RequestRealmList()`: the C side answers by opening the dialog the corpus already has. */
  requestRealmList(): void {
    this.#options.fireEvent("OPEN_REALM_LIST");
  }

  /**
   * `ChangeRealm(category, index)`: pick a realm, open a world connection, list its characters.
   *
   * Stock `CharacterSelect_OnShow` reads `IsConnectedToServer()` only once when it labels the realm.
   * Show it after the world handshake, so a connecting realm is not permanently labelled down.
   */
  changeRealm(category: number, index: number): void {
    const realm = this.realmsIn(category)[index - 1];
    if (!realm || !canSelectRealm(realm)) return;
    this.#selectedCategory = category;
    this.#selectedRealm = realm;
    void this.connect(realm, true);
  }

  /**
   * Open the world connection for one realm. Public so a test can drive it without the dialog.
   *
   * `showScreenWhenConnected` is ChangeRealm — the player's own choice of a realm — and that one
   * waits in the stock CANCEL dialog the client puts up for it (FUN_004d8bd0, FUN_004dab40):
   * «Соединение...», «Авторизация», the realm's queue with the button relabelled «Выбор мира», the
   * list being fetched, and closed as the list arrives. A reconnect behind a screen that is already
   * up (after the world, `?fake=`) does not announce itself.
   */
  async connect(realm: RealmInfo, showScreenWhenConnected = false): Promise<void> {
    if (!canSelectRealm(realm)) return;
    const auth = this.#auth;
    const connector = this.#options.connect;
    this.#selectedRealm = realm;
    this.closeWorld();
    if (!auth || !connector) {
      this.#options.onDiagnostic?.("нет сессии авторизации — подключение к миру невозможно");
      return;
    }
    const generation = ++this.#generation;
    const announce = showScreenWhenConnected;
    const abort = new AbortController();
    this.#connecting = true;
    this.#abort = abort;
    if (announce) {
      this.#announced = true;
      this.#options.fireEvent("OPEN_STATUS_DIALOG", "CANCEL", this.text("CSTATUS_CONNECTING", "Соединение..."));
    }
    const progress = (step: GlueConnectProgress): void => {
      if (!announce || !this.#announced || generation !== this.#generation) return;
      if (step.stage === "authenticating") {
        this.#options.fireEvent("UPDATE_STATUS_DIALOG", this.text("CSTATUS_AUTHENTICATING", "Авторизация"));
      } else {
        this.#options.fireEvent("UPDATE_STATUS_DIALOG", this.queueText(realm, step.position ?? 0),
          this.text("CHANGE_REALM", "Выбор мира"));
      }
    };
    try {
      const world = await connector(realm, auth, progress, abort.signal);
      if (generation !== this.#generation) {
        world.close();
        return;
      }
      this.#world = world;
      // `SetGlueScreen` synchronously runs CharacterSelect_OnShow, which asks for characters.
      // Coalesce that request with the one below so only one CMSG_CHAR_ENUM is in flight.
      if (showScreenWhenConnected) this.#options.setGlueScreen?.("charselect");
      if (announce && this.#announced) {
        this.#options.fireEvent("UPDATE_STATUS_DIALOG", this.text("CHAR_LIST_RETRIEVING", "Загрузка списка персонажей"));
      }
      await this.refreshCharacters();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.report(error);
    } finally {
      if (generation === this.#generation) {
        this.#connecting = false;
        this.#abort = undefined;
      }
    }
  }

  /**
   * StatusDialogClick on a CANCEL dialog this session put up: the realm connection in flight — its
   * connector closes the socket, which also ends a wait in the realm's queue, and the realm list
   * comes back — or the rename still waiting for its answer, which is then dropped. Every OKAY
   * dialog ends in StatusDialogClick too, so with nothing in flight this does nothing.
   */
  cancelPending(): void {
    if (this.#renaming) {
      this.#renaming = false;
      this.#renameGeneration += 1;
    }
    if (!this.#connecting || !this.#announced) return;
    this.#announced = false;
    this.closeWorld();
    this.requestRealmList();
  }

  /**
   * FUN_004dab40's line for a queued session: QUEUE_NAME_TIME_LEFT_UNKNOWN with the realm's name —
   * the core sends no wait time — and the plainer forms in a corpus without it.
   */
  private queueText(realm: RealmInfo, position: number): string {
    const glueString = this.#options.glueString;
    const named = glueString?.("QUEUE_NAME_TIME_LEFT_UNKNOWN");
    if (named && realm.name) return formatGlueString(named, realm.name, position);
    const unnamed = glueString?.("QUEUE_TIME_LEFT_UNKNOWN");
    if (unnamed) return formatGlueString(unnamed, position);
    return formatGlueString(this.text("AUTH_WAIT_QUEUE", "Место в очереди: %d"), position);
  }

  private text(key: string, fallback: string): string {
    return messageFor(key, this.#options.glueString, fallback);
  }

  get connecting(): boolean {
    return this.#connecting;
  }

  /** `GetCharacterListUpdate()`: ask the world again and answer with CHARACTER_LIST_UPDATE. */
  async refreshCharacters(): Promise<void> {
    if (this.#characterRefresh) return this.#characterRefresh;
    const refresh = this.loadCharacters();
    this.#characterRefresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.#characterRefresh === refresh) this.#characterRefresh = undefined;
    }
  }

  private async loadCharacters(): Promise<void> {
    const world = this.#world;
    if (!world) {
      this.#characters = [];
      this.#options.fireEvent("CHARACTER_LIST_UPDATE");
      return;
    }
    const generation = this.#generation;
    try {
      const characters = await world.characters();
      if (generation !== this.#generation) return;
      this.#characters = characters;
      if (this.#selectedIndex > characters.length) this.#selectedIndex = 0;
      // The connecting dialog comes down as the list it was waiting for goes up.
      if (this.#announced) {
        this.#announced = false;
        this.#options.fireEvent("CLOSE_STATUS_DIALOG");
      }
      this.#options.fireEvent("CHARACTER_LIST_UPDATE");
    } catch (error) {
      if (generation !== this.#generation) return;
      this.report(error);
    }
  }

  characterRow(index: number): GlueCharacterRow | undefined {
    const character = this.#characters[index - 1];
    if (!character) return undefined;
    const names = this.#options.names;
    return {
      name: character.name,
      race: names?.raceName(character.race) ?? String(character.race),
      className: names?.className(character.classId) ?? String(character.classId),
      level: character.level,
      zone: names?.zoneName(character.zone) ?? "",
      // The protocol's own number — 0 male, 1 female, as `CMSG_CHAR_CREATE` sends it and as
      // `parseCharacterList` reads it. The stock `CharacterSelect.lua` reads this slot and never
      // uses it; passing the wire value on is the only answer that cannot be wrong.
      sex: character.gender,
      ghost: (character.flags & CHARACTER_FLAG_GHOST) !== 0,
      customize: (character.customizeFlags & CHAR_CUSTOMIZE_FLAG_CUSTOMIZE) !== 0,
      raceChange: (character.customizeFlags & CHAR_CUSTOMIZE_FLAG_RACE) !== 0,
      factionChange: (character.customizeFlags & CHAR_CUSTOMIZE_FLAG_FACTION) !== 0,
    };
  }

  /** `SelectCharacter(index)`: the C side answers with UPDATE_SELECTED_CHARACTER. */
  selectCharacter(index: number): void {
    const clamped = index > 0 && index <= this.#characters.length ? index : 0;
    this.#selectedIndex = clamped;
    // A newly selected character faces the camera; the drag and the arrows turn it from there.
    this.#facing = 0;
    this.#options.fireEvent("UPDATE_SELECTED_CHARACTER", clamped);
  }

  /**
   * `DeleteCharacter(index)`.
   *
   * 71 is `CHAR_DELETE_SUCCESS`; anything else is refused and said so in a dialog rather than
   * silently leaving the character in the list. The dialog prints the corpus' string for the code
   * the core sent — it sends 74 (guild leader) and 75 (arena captain) — and `CHAR_DELETE_FAILED`
   * for a number the enum does not have.
   */
  async deleteCharacter(index: number): Promise<number | undefined> {
    const character = this.#characters[index - 1];
    const world = this.#world;
    if (!character || !world) return undefined;
    const generation = this.#generation;
    try {
      const result = await world.deleteCharacter(character.guid);
      if (generation !== this.#generation) return undefined;
      if (result !== CHAR_DELETE_SUCCESS) {
        this.dialog(messageFor(responseKey(result, "delete"), this.#options.glueString,
          `Удаление отклонено сервером, код ${result}.`));
        return result;
      }
      if (this.#selectedIndex >= index) this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
      await this.refreshCharacters();
      return result;
    } catch (error) {
      if (generation !== this.#generation) return undefined;
      this.report(error);
      return undefined;
    }
  }

  /**
   * `CreateCharacter(name)` — the wire half of it.
   *
   * `undefined` means "the question was never asked": no world connection, or one that does not
   * carry the call. The screen prints its own refusal in that case rather than a server code, which
   * is the honest difference between "the server said no" and "there was nobody to ask".
   *
   * A success refreshes the list before the caller sees it, because the corpus moves straight to
   * `charselect` and `CharacterSelect_OnShow` draws whatever the session is holding.
   */
  async createCharacter(request: GlueCreateCharacterRequest): Promise<number | undefined> {
    const world = this.#world;
    if (!world?.createCharacter) return undefined;
    const generation = this.#generation;
    const result = await world.createCharacter(request);
    if (generation !== this.#generation) return undefined;
    if (result === CHAR_CREATE_SUCCESS) await this.refreshCharacters();
    return result;
  }

  /**
   * `CMSG_CHAR_RENAME` for the character at `index` — the wire half of `RenameCharacter`.
   *
   * `undefined` when the question was never asked (no connection, or one that cannot rename) or its
   * answer was cancelled; a failed connection is reported like any other. The dialogs and the list
   * that follow an answer belong to the C API, which is where the client handles them (FUN_004da090).
   */
  async renameCharacter(index: number, name: string): Promise<RenameResult | undefined> {
    const character = this.#characters[index - 1];
    const world = this.#world;
    if (!character || !world?.renameCharacter) return undefined;
    const generation = this.#generation;
    const request = ++this.#renameGeneration;
    this.#renaming = true;
    try {
      const result = await world.renameCharacter(character.guid, name);
      return generation === this.#generation && request === this.#renameGeneration ? result : undefined;
    } catch (error) {
      if (generation === this.#generation && request === this.#renameGeneration) this.report(error);
      return undefined;
    } finally {
      if (request === this.#renameGeneration) this.#renaming = false;
    }
  }

  /** The realm's own name and type, as `GetServerName()` returns them. */
  serverName(): { name: string; pvp: boolean; rp: boolean; down: boolean } | undefined {
    const realm = this.#selectedRealm;
    if (!realm) return undefined;
    return {
      name: realm.name,
      pvp: realm.type === REALM_TYPE_PVP || realm.type === REALM_TYPE_RPPVP,
      rp: realm.type === REALM_TYPE_RP || realm.type === REALM_TYPE_RPPVP,
      down: (realm.flags & REALM_FLAG_OFFLINE) !== 0,
    };
  }

  /** The backdrop token for one character, the string `SetBackgroundModel` builds a path out of. */
  backgroundModel(index: number): string {
    const character = this.#characters[index - 1];
    if (!character) return "Human";
    return glueBackgroundModelFor(character.race, character.classId);
  }

  /** The display id the selected character's model comes from, when the dataset names one. */
  displayIdFor(character: CharacterSummary): number | undefined {
    return this.#options.names?.raceDisplayId(character.race, character.gender);
  }

  /** Drop the world connection and everything that came over it. Keeps the auth session. */
  closeWorld(): void {
    this.#generation += 1;
    this.#connecting = false;
    this.#announced = false;
    // A connection still being opened is told to close its socket rather than left to finish.
    this.#abort?.abort();
    this.#abort = undefined;
    this.#characterRefresh = undefined;
    this.#world?.close();
    this.#world = undefined;
    this.#characters = [];
    this.#selectedIndex = 0;
  }

  /** Everything: the world, the realm list and the account. */
  close(): void {
    this.closeWorld();
    this.#auth = undefined;
    this.#realms = [];
    this.#selectedRealm = undefined;
  }

  /**
   * A failure of the world connection, in the corpus' words (`describeFailure`): the exception's own
   * English goes to the log only. Its dialog replaces the connecting one, if that was still up.
   */
  private report(error: unknown): void {
    this.#options.onDiagnostic?.(error instanceof Error ? error.message : String(error));
    this.#announced = false;
    showStatusMessage({
      fire: (event, ...args) => { this.#options.fireEvent(event, ...args); },
      glueString: this.#options.glueString,
      hasDialogType: this.#options.hasDialogType,
    }, describeFailure(error, "world"));
  }

  /** The stock OKAY dialog, re-measured once it is visible so a long reason stays inside its box. */
  private dialog(message: string): void {
    openStatusDialog((event, ...args) => { this.#options.fireEvent(event, ...args); }, "OKAY", message);
  }
}

/**
 * The number `RealmList.lua` compares against, not the raw population float.
 *
 * `RealmListUpdate` tests `load == -3.0`, `-2.0` and `2.0` before it looks at the sign, and those
 * three are sentinels for the flags the authserver sets rather than crowd sizes. Full is checked
 * first because a realm can be both full and recommended and the client's own order puts the
 * refusal above the invitation.
 */
export function realmLoad(realm: RealmInfo): number {
  if ((realm.flags & REALM_FLAG_FULL) !== 0) return 2;
  if ((realm.flags & REALM_FLAG_RECOMMENDED) !== 0) return -3;
  if ((realm.flags & REALM_FLAG_NEW) !== 0) return -2;
  return Number.isFinite(realm.population) ? realm.population : 0;
}
