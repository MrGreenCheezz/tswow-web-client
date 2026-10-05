import type { CharacterOptions } from "../CharacterAtlas.js";
import type { CreationClass, CreationRace } from "../../gateway/CharacterCreation.js";
import type { StartOutfitItem } from "../../gateway/CharStartOutfit.js";
import type { GlueSceneLook } from "./GlueCharacterScene.js";
import { RESPONSE_CODE_NAMES, RESPONSE_CODES } from "../../generated/responseCodes.js";
import { describeFailure, messageFor, openStatusDialog, responseKey, showStatusMessage } from "./GlueMessages.js";
import { checkCharacterName, type GlueNameRuleOptions } from "./GlueNameRules.js";
import type { CharacterSummary } from "../../world/CharacterProtocol.js";
import { paidServiceKind, RESPONSE_SUCCESS, type PaidServiceKind } from "../../world/CharacterServiceProtocol.js";
import type { GluePaidServiceOutcome, GluePaidServiceRequest } from "./GlueSession.js";

/**
 * What the character-creation screen has chosen, and the rules that keep it choosable.
 *
 * Everything here is read off `CharacterCreate.lua` rather than invented. The screen is *positional*
 * in three separate ways and each one is a way to be silently wrong:
 *
 * * `CharacterCreateEnumerateRaces(...)` counts `select("#", ...)/3` and reads its arguments in
 *   threes — name, file token, enabled — then indexes `RACE_ICON_TCOORDS[FILE.."_"..gender]`
 *   (`:161`, `:176-178`). The file token is `ChrRaces.ClientFileString`, not `ClientPrefix`.
 * * `GetSelectedClass()` is unpacked as `className, classFileName, index, tank, healer, damage`
 *   (`:360`), and elsewhere as `local _,_,currClass` (`:411`) — the **third** value is the index.
 * * Race and class are addressed by their **place in the enumerated list**, not by their DBC id:
 *   `SetSelectedRace(id)` at `:427` is handed the button number. So this class keeps both and
 *   converts at the boundary, which is also what stops a tswow race with id 22 from being unusable.
 *
 * The five customisation axes are `CHAR_CUSTOMIZATION1_DESC`..`5_DESC` in `GlueStrings.lua`
 * («Цвет кожи», «Лицо», «Прическа», «Цвет волос», «Борода и усы»), which is skin, face, hair style,
 * hair colour, facial hair, in that order — that is what `CycleCharCustomization(id, ±1)` numbers.
 */

/** `SEX_MALE`/`SEX_FEMALE` from `GlueParent.lua:126-128`. The wire uses 0 and 1. */
export const SEX_NONE = 1;
export const SEX_MALE = 2;
export const SEX_FEMALE = 3;

/** `NUM_CHAR_CUSTOMIZATIONS` and the axis each `CycleCharCustomization` id names. */
export const CUSTOMIZATION_SKIN = 1;
export const CUSTOMIZATION_FACE = 2;
export const CUSTOMIZATION_HAIR_STYLE = 3;
export const CUSTOMIZATION_HAIR_COLOR = 4;
export const CUSTOMIZATION_FACIAL_HAIR = 5;
export const NUM_CHAR_CUSTOMIZATIONS = 5;

/** `SMSG_CHAR_CREATE`'s success code, the same number `WorldClient` checks. */
export const CHAR_CREATE_SUCCESS = 47;

/** What `HandleCharCreateOpcode` can answer: the `CHAR_CREATE_*` results and the name checks'. */
const answersCharCreate = (name: string): boolean =>
  (name.startsWith("CHAR_CREATE_") && name !== "CHAR_CREATE_IN_PROGRESS")
  || (name.startsWith("CHAR_NAME_") && name !== "CHAR_NAME_SUCCESS");

/**
 * `SMSG_CHAR_CREATE`'s refusals by code, exactly as `responseKey(code, "create")` answers them.
 *
 * @deprecated The table is `GlueMessages.responseKey` since 1.19; this export stays one slice so
 * its importers keep resolving. 42-44, which it once called «invalid name», are
 * `ACCOUNT_CREATE_FAILED`, `CHAR_LIST_RETRIEVING` and `CHAR_LIST_RETRIEVED` and are not in it.
 */
export const CHAR_CREATE_RESULT_STRINGS: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries([...RESPONSE_CODE_NAMES]
    .filter(([, name]) => answersCharCreate(name))
    .map(([code]) => [code, responseKey(code, "create")])),
);

/** The tables the screen is drawn from, however the host got them. */
export interface GlueCreationTables {
  readonly races: readonly CreationRace[];
  readonly classes: readonly CreationClass[];
}

/** Where the per-profile answers come from. Injected so a node test needs no gateway. */
export interface GlueCreationSource {
  /** `/dbc/character-options?race=&sex=&class=` — only looks the selected class may create. */
  options(race: number, sex: number, classId?: number): Promise<CharacterOptions | undefined>;
  /** `/dbc/char-start-outfit?race=&class=&sex=` — empty on an older gateway, which is not an error. */
  startOutfit(race: number, classId: number, sex: number): Promise<readonly StartOutfitItem[]>;
  /** `CreatureDisplayInfo` row for a race and sex; undefined when the dataset names none. */
  displayId(race: number, sex: number): number | undefined;
}

export interface GlueCreationOptions {
  readonly source: GlueCreationSource;
  /** Tables the host has fetched, re-read on every call so a late answer is picked up. */
  readonly tables: () => GlueCreationTables;
  /** `CreateCharacter(name)` — the world reply code, or undefined when there is no connection. */
  readonly create?: (request: GlueCreateRequest) => Promise<number | undefined>;
  /** `CreateCharacter(name)` in paid mode (2.08): the session's `paidService`. */
  readonly paid?: (request: GluePaidServiceRequest) => Promise<GluePaidServiceOutcome>;
  /** How the screen is told something happened. */
  readonly fireEvent?: (event: string, ...args: readonly unknown[]) => void;
  readonly setGlueScreen?: (name: string) => void;
  /**
   * Something the preview draws from has changed.
   *
   * The two per-profile answers arrive over the network, so the C call that asked for them has
   * already returned by the time they land: without this the figure keeps whatever look it was
   * built with and the start outfit never reaches it — measured, a dwarf warrior stood in his
   * underwear while `/dbc/char-start-outfit` had already answered with four pieces.
   */
  readonly onChanged?: () => void;
  /** `undefined` keeps the corpus' own wording; the host resolves a GlueStrings key. */
  readonly glueString?: (key: string) => string | undefined;
  /** Whether the corpus defines `GlueDialogTypes[type]`, for a failed connection's dialog. */
  readonly hasDialogType?: (type: string) => boolean;
  /** Which alphabets the name may use right now; the client's defaults without it. */
  readonly nameRules?: () => GlueNameRuleOptions;
  readonly onDiagnostic?: (message: string) => void;
  /** Injected in tests so a random look is reproducible. */
  readonly random?: () => number;
}

export interface GlueCreateRequest {
  readonly name: string;
  readonly race: number;
  readonly classId: number;
  readonly gender: number;
  readonly skin: number;
  readonly face: number;
  readonly hairStyle: number;
  readonly hairColor: number;
  readonly facialHair: number;
  readonly outfitId: number;
}

/** One entry of `GetAvailableRaces()`/`GetAvailableClasses()`: three values per row. */
export interface GlueCreationEntry {
  readonly name: string;
  readonly token: string;
  readonly enabled: boolean;
}

/** The five indices the wire carries, in `CMSG_CHAR_CREATE`'s own order. */
export interface GlueCreationLook {
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
}

const DEATH_KNIGHT_CLASS = 6;

/** The character `CustomizeExistingCharacter` loaded, as it was when it was loaded (2.08). */
export interface GluePaidCharacter {
  readonly guid: bigint;
  readonly name: string;
  readonly race: number;
  readonly classId: number;
  /** Which packet `CreateCharacter` sends for it, by its list entry's customise flags. */
  readonly kind: PaidServiceKind;
}

/** The status dialog each paid packet opens while it waits (Wow.exe 0x4d8e10, 0x4d8f20, 0x4d9040). */
const PAID_IN_PROGRESS: Readonly<Record<PaidServiceKind, readonly [key: string, text: string]>> = {
  customize: ["CHAR_CUSTOMIZE_IN_PROGRESS", "Изменение внешности персонажа…"],
  faction: ["FACTION_CHANGE_IN_PROGRESS", "Обновление фракции…"],
  race: ["RACE_CHANGE_IN_PROGRESS", "Обновление расы…"],
};

/** Upper-case ASCII folded, nothing else — the client compares the names with `_strnicmp`. */
const asciiFold = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * Which `Interface\Glues\Models\UI_*` set stands behind a race on the creation screen.
 *
 * Gnome takes the dwarf's Ironforge and troll the orc's Durotar because `UI_Gnome` and `UI_Troll`
 * answer 404 on this client — measured in G4, along with the byte counts of the eight that resolve.
 */
const RACE_BACKGROUND_TOKEN: Readonly<Record<number, string>> = Object.freeze({
  1: "Human", 2: "Orc", 3: "Dwarf", 4: "NightElf", 5: "Scourge", 6: "Tauren",
  7: "Dwarf", 8: "Orc", 10: "BloodElf", 11: "Draenei",
});

/**
 * `ChrRaces.ClientFileString` for the ten playable rows, as a floor under an older gateway.
 *
 * Not the source of truth — the gateway's own column is, and a race a module adds is only ever
 * named there. This exists because the token is the one value on this screen whose absence is not
 * survivable: `CharacterCreateEnumerateRaces` does
 * `RACE_ICON_TCOORDS[strupper(token.."_"..gender)]` and then `coords[1]`, so a gateway that
 * predates the column would raise a Lua error inside `CharacterCreate_OnShow` and leave the screen
 * half-built. `clientPrefix` is not a substitute: it is `Hu`, and `RACE_ICON_TCOORDS` has no
 * `HU_MALE`. Measured off `ChrRaces` on this dataset — note 7 and 8, which differ from the backdrop
 * map above.
 */
const RACE_FILE_TOKEN: Readonly<Record<number, string>> = Object.freeze({
  1: "Human", 2: "Orc", 3: "Dwarf", 4: "NightElf", 5: "Scourge", 6: "Tauren",
  7: "Gnome", 8: "Troll", 10: "BloodElf", 11: "Draenei",
});

/** The token the screen keys its art and its GlueStrings on. See `RACE_FILE_TOKEN`. */
export function raceFileToken(race: CreationRace): string {
  return race.clientFileString || RACE_FILE_TOKEN[race.id] || race.clientPrefix || String(race.id);
}

export class GlueCreation {
  readonly #options: GlueCreationOptions;
  #raceIndex = 1;
  #classIndex = 1;
  #sex = SEX_MALE;
  #facing = 0;
  #look: GlueCreationLook = { skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0 };
  /** `race/sex/class` -> the answer, so revisiting a profile does not ask twice. */
  readonly #optionCache = new Map<string, CharacterOptions | undefined>();
  readonly #outfitCache = new Map<string, readonly StartOutfitItem[]>();
  #optionsFor: CharacterOptions | undefined;
  #outfit: readonly StartOutfitItem[] = [];
  /** Bumped by every profile change; a late fetch for an older profile is dropped. */
  #generation = 0;
  #creating = false;
  /** Paid mode (2.08): set by `beginPaidService`, cleared by `reset` (ResetCharCustomize). */
  #paid: GluePaidCharacter | undefined;

  constructor(options: GlueCreationOptions) {
    this.#options = options;
  }

  /* --- The two lists ------------------------------------------------------------------------- */

  /** Playable races, in id order — the order `CharacterCreateEnumerateRaces` draws buttons in. */
  get races(): readonly CreationRace[] {
    return [...this.#options.tables().races]
      .filter((race) => race.playable)
      .sort((left, right) => left.id - right.id);
  }

  /**
   * Every class, in id order, with the ones this race may not take marked disabled.
   *
   * All of them and not only the allowed ones, because the screen shows a class it cannot take as a
   * greyed button with a tooltip (`CharacterCreateEnumerateClasses`, `:222-228`) — dropping it from
   * the list would renumber every button after it on a race change.
   */
  get classes(): readonly CreationClass[] {
    return [...this.#options.tables().classes]
      .filter((entry) => entry.playable)
      .sort((left, right) => left.id - right.id);
  }

  availableRaces(): GlueCreationEntry[] {
    return this.races.map((race) => ({
      name: race.name || `Раса ${race.id}`,
      token: raceFileToken(race),
      enabled: true,
    }));
  }

  availableClasses(): GlueCreationEntry[] {
    const allowed = this.selectedRace()?.classes ?? [];
    const permitted = new Set(allowed);
    return this.classes.map((entry) => ({
      name: entry.name || `Класс ${entry.id}`,
      token: entry.fileName || String(entry.id),
      // An empty `CharBaseInfo` row set means the dataset says nothing, which the DOM form already
      // treats as "offer everything" — a custom race whose author forgot the pairs is creatable and
      // refused by the server, which is recoverable; a screen with no classes at all is not.
      enabled: permitted.size === 0 || permitted.has(entry.id),
    }));
  }

  /* --- The selection ------------------------------------------------------------------------- */

  /** 1-based, as the buttons are numbered. */
  get raceIndex(): number {
    return this.#raceIndex;
  }

  get classIndex(): number {
    return this.#classIndex;
  }

  /** `SEX_MALE` (2) or `SEX_FEMALE` (3) — the corpus' own numbering, not the wire's. */
  get sex(): number {
    return this.#sex;
  }

  /** 0 male, 1 female: what `CMSG_CHAR_CREATE` carries. */
  get gender(): number {
    return this.#sex === SEX_FEMALE ? 1 : 0;
  }

  get facing(): number {
    return this.#facing;
  }

  setFacing(degrees: number): void {
    this.#facing = Number.isFinite(degrees) ? degrees : 0;
  }

  get look(): GlueCreationLook {
    return { ...this.#look };
  }

  get creating(): boolean {
    return this.#creating;
  }

  selectedRace(): CreationRace | undefined {
    return this.races[this.#raceIndex - 1];
  }

  selectedClass(): CreationClass | undefined {
    return this.classes[this.#classIndex - 1];
  }

  /** `IsRaceClassValid(raceIndex, classIndex)` — both are button numbers, not DBC ids. */
  isRaceClassValid(raceIndex: number, classIndex: number): boolean {
    const race = this.races[raceIndex - 1];
    const entry = this.classes[classIndex - 1];
    if (!race || !entry) return false;
    return race.classes.length === 0 || race.classes.includes(entry.id);
  }

  selectRace(index: number): void {
    const race = this.races[index - 1];
    if (!race) return;
    this.#raceIndex = index;
    // The class survives a race change when the new race may take it, exactly as the corpus keeps
    // `GetSelectedClass()` and only re-reads it; otherwise the first class this race allows wins.
    if (!this.isRaceClassValid(index, this.#classIndex)) {
      const first = this.classes.findIndex((_, at) => this.isRaceClassValid(index, at + 1));
      if (first >= 0) this.#classIndex = first + 1;
    }
    void this.refreshProfile(true);
  }

  selectClass(index: number): void {
    if (!this.classes[index - 1]) return;
    this.#classIndex = index;
    // The core rejects death-knight-only CharSections for every other class.
    void this.refreshProfile(true);
  }

  selectSex(sex: number): void {
    const wanted = sex === SEX_FEMALE ? SEX_FEMALE : SEX_MALE;
    if (wanted === this.#sex) return;
    this.#sex = wanted;
    void this.refreshProfile(true);
  }

  /* --- The five axes ------------------------------------------------------------------------- */

  /** What one axis may be set to right now. Faces depend on the chosen skin; the rest do not. */
  offered(axis: number): readonly number[] {
    const options = this.#optionsFor;
    if (!options) return [];
    switch (axis) {
      case CUSTOMIZATION_SKIN: return options.skins;
      // A face row is keyed on `(face, skin)` and the pairs are not a full rectangle — the
      // death-knight skins carry three faces where the ordinary ones carry twenty-four. The union
      // is the fallback for a skin the answer says nothing about; `facesBySkin` is what binds.
      case CUSTOMIZATION_FACE: return options.facesBySkin[this.#look.skin] ?? options.faces;
      case CUSTOMIZATION_HAIR_STYLE: return options.hairStyles;
      case CUSTOMIZATION_HAIR_COLOR: return options.hairColors;
      case CUSTOMIZATION_FACIAL_HAIR: return options.facialHairs;
      default: return [];
    }
  }

  private valueOf(axis: number): number {
    switch (axis) {
      case CUSTOMIZATION_SKIN: return this.#look.skin;
      case CUSTOMIZATION_FACE: return this.#look.face;
      case CUSTOMIZATION_HAIR_STYLE: return this.#look.hairStyle;
      case CUSTOMIZATION_HAIR_COLOR: return this.#look.hairColor;
      case CUSTOMIZATION_FACIAL_HAIR: return this.#look.facialHair;
      default: return 0;
    }
  }

  private setValue(axis: number, value: number): void {
    switch (axis) {
      case CUSTOMIZATION_SKIN: this.#look.skin = value; break;
      case CUSTOMIZATION_FACE: this.#look.face = value; break;
      case CUSTOMIZATION_HAIR_STYLE: this.#look.hairStyle = value; break;
      case CUSTOMIZATION_HAIR_COLOR: this.#look.hairColor = value; break;
      case CUSTOMIZATION_FACIAL_HAIR: this.#look.facialHair = value; break;
      default: break;
    }
  }

  /**
   * `CycleCharCustomization(id, direction)` — one step along an axis, wrapping.
   *
   * Wrapping because the original's arrows never stop: the left arrow on the first face goes to the
   * last. Cycling the skin re-filters the faces, so a face that the new skin has no row for is
   * pulled back into range here rather than being sent to the server and drawn bald.
   */
  cycle(axis: number, direction: number): boolean {
    const values = this.offered(axis);
    if (values.length === 0) return false;
    const step = direction < 0 ? -1 : 1;
    const at = values.indexOf(this.valueOf(axis));
    const next = ((at < 0 ? 0 : at + step) % values.length + values.length) % values.length;
    this.setValue(axis, values[next] ?? 0);
    if (axis === CUSTOMIZATION_SKIN) this.clampFace();
    return true;
  }

  /** Pull the chosen face back onto the list the chosen skin actually has. */
  private clampFace(): void {
    const faces = this.offered(CUSTOMIZATION_FACE);
    if (faces.length === 0 || faces.includes(this.#look.face)) return;
    this.#look.face = faces[0] ?? 0;
  }

  /** `RandomizeCharCustomization()` — a legal value on every axis, faces after the skin. */
  randomize(): void {
    const random = this.#options.random ?? Math.random;
    const pick = (axis: number): number => {
      const values = this.offered(axis);
      if (values.length === 0) return 0;
      return values[Math.min(values.length - 1, Math.floor(random() * values.length))] ?? 0;
    };
    this.#look.skin = pick(CUSTOMIZATION_SKIN);
    // After the skin, because the face list is the skin's.
    this.#look.face = pick(CUSTOMIZATION_FACE);
    this.#look.hairStyle = pick(CUSTOMIZATION_HAIR_STYLE);
    this.#look.hairColor = pick(CUSTOMIZATION_HAIR_COLOR);
    this.#look.facialHair = pick(CUSTOMIZATION_FACIAL_HAIR);
  }

  /**
   * `ResetCharCustomize()` — what `CharacterCreate_OnShow` calls, and the comment beside it in the
   * corpus reads «randomly selects a combination». So this is a randomise and not a zeroing. It also
   * ends paid mode: Wow.exe 0x4e1fd0 forgets the paid character before anything else.
   */
  reset(): void {
    this.#paid = undefined;
    this.randomize();
  }

  /* --- Paid services (2.08) ------------------------------------------------------------------ */

  /** The character in paid mode, or undefined on an ordinary creation screen. */
  get paid(): GluePaidCharacter | undefined {
    return this.#paid;
  }

  /**
   * `CustomizeExistingCharacter(index)` — the existing character on the screen (Wow.exe 0x4e2330): its
   * race, class, sex and the five looks it wears, with nothing randomised and nothing pulled into the
   * new profile's range (`refreshProfile(false)`); a look the core zeroed for being invalid
   * (Player.cpp:1502-1507) stays zero. A race or class the screen has no button for leaves that
   * selection as it was, as the client's lookup does. A row that is not there changes nothing.
   */
  beginPaidService(character: CharacterSummary | undefined): boolean {
    if (!character) return false;
    this.#paid = {
      guid: character.guid,
      name: character.name,
      race: character.race,
      classId: character.classId,
      kind: paidServiceKind(character.customizeFlags),
    };
    const raceAt = this.races.findIndex((race) => race.id === character.race);
    if (raceAt >= 0) this.#raceIndex = raceAt + 1;
    else this.#options.onDiagnostic?.(`paid service: race ${character.race} has no button`);
    const classAt = this.classes.findIndex((entry) => entry.id === character.classId);
    if (classAt >= 0) this.#classIndex = classAt + 1;
    else this.#options.onDiagnostic?.(`paid service: class ${character.classId} has no button`);
    this.#sex = character.gender === 1 ? SEX_FEMALE : SEX_MALE;
    this.#look = {
      skin: character.skin,
      face: character.face,
      hairStyle: character.hairStyle,
      hairColor: character.hairColor,
      facialHair: character.facialHair,
    };
    void this.refreshProfile(false);
    return true;
  }

  /**
   * `PaidChange_GetCurrentRaceIndex()` — the loaded character's race as a button number, whatever the
   * screen has chosen since; 0 when it has none (Wow.exe 0x4e0ca0: the lookup's -1, plus one).
   */
  paidRaceIndex(): number {
    const paid = this.#paid;
    return paid ? this.races.findIndex((race) => race.id === paid.race) + 1 : 0;
  }

  /** `PaidChange_GetCurrentClassIndex()` — the same for the class (Wow.exe 0x4e0cd0). */
  paidClassIndex(): number {
    const paid = this.#paid;
    return paid ? this.classes.findIndex((entry) => entry.id === paid.classId) + 1 : 0;
  }

  /** `PaidChange_GetName()` — the loaded character's name, nil outside paid mode (Wow.exe 0x4e1b70). */
  paidName(): string | undefined {
    return this.#paid?.name;
  }

  /* --- What is on the screen ----------------------------------------------------------------- */

  /** `GetCreateBackgroundModel()` — the token `SetBackgroundModel` builds a path out of. */
  backgroundModel(): string {
    if (this.selectedClass()?.id === DEATH_KNIGHT_CLASS) return "DeathKnight";
    const race = this.selectedRace();
    return (race && RACE_BACKGROUND_TOKEN[race.id]) ?? "Human";
  }

  /** `GetHairCustomization()` / `GetFacialHairCustomization()` — GlueStrings key fragments. */
  hairCustomization(): string {
    return this.selectedRace()?.hairCustomization || "NORMAL";
  }

  facialHairCustomization(): string {
    const race = this.selectedRace();
    const pair = race?.facialHairCustomization;
    return (this.gender === 1 ? pair?.[1] : pair?.[0]) || "NORMAL";
  }

  /** The figure the preview should be drawing, or nothing while the tables are still in flight. */
  sceneLook(): GlueSceneLook | undefined {
    const race = this.selectedRace();
    if (!race) return undefined;
    const displayId = this.#options.source.displayId(race.id, this.gender);
    if (displayId === undefined) return undefined;
    const items = this.#outfit
      .map((item) => `${item.slot}:${item.inventoryType}:${item.displayId}`)
      .sort()
      .join(",");
    const look = this.#look;
    return {
      key: [
        "create", race.id, this.gender, this.selectedClass()?.id ?? 0, displayId,
        look.skin, look.face, look.hairStyle, look.hairColor, look.facialHair, items,
      ].join("/"),
      displayId,
      race: race.id,
      // 05.10-A7a-A 6.10: the class being created (a death knight's eyes glow in the preview).
      ...(this.selectedClass()?.id === undefined ? {} : { classId: this.selectedClass()!.id }),
      sex: this.gender,
      skin: look.skin,
      face: look.face,
      hairStyle: look.hairStyle,
      hairColor: look.hairColor,
      facialHair: look.facialHair,
      items,
      label: race.name || `раса ${race.id}`,
    };
  }

  /* --- Fetching -------------------------------------------------------------------------- */

  /**
   * Bring the five axes and the outfit into line with the chosen race, class and sex.
   *
   * `randomiseAfter` is the corpus' own behaviour on a race or sex change: `CharacterRace_OnClick`
   * does not keep the old skin index, because the same number means a different colour on another
   * race. What it does keep is a value the new profile also offers, which is what `clamp` below
   * does — a night elf's fourth hairstyle stays the fourth if there is one.
   */
  async refreshProfile(clamp = false): Promise<void> {
    const race = this.selectedRace();
    if (!race) return;
    const generation = ++this.#generation;
    const sex = this.gender;
    const classId = this.selectedClass()?.id;
    const key = `${race.id}/${sex}/${classId ?? "all"}`;
    let options = this.#optionCache.get(key);
    if (!this.#optionCache.has(key)) {
      options = await this.#options.source.options(race.id, sex, classId);
      this.#optionCache.set(key, options);
    }
    if (generation !== this.#generation) return;
    this.#optionsFor = options;
    if (clamp) this.clampToOffered();
    await this.refreshOutfit(generation);
    this.#options.onChanged?.();
  }

  /** Every axis moved onto the nearest legal value of the current profile. */
  private clampToOffered(): void {
    for (const axis of [CUSTOMIZATION_SKIN, CUSTOMIZATION_FACE, CUSTOMIZATION_HAIR_STYLE,
      CUSTOMIZATION_HAIR_COLOR, CUSTOMIZATION_FACIAL_HAIR]) {
      const values = this.offered(axis);
      if (values.length === 0) {
        this.setValue(axis, 0);
        continue;
      }
      if (values.includes(this.valueOf(axis))) continue;
      this.setValue(axis, values[0] ?? 0);
    }
  }

  async refreshOutfit(generation = this.#generation): Promise<void> {
    const race = this.selectedRace();
    const entry = this.selectedClass();
    if (!race || !entry) return;
    const key = `${race.id}/${entry.id}/${this.gender}`;
    let outfit = this.#outfitCache.get(key);
    if (!outfit) {
      outfit = await this.#options.source.startOutfit(race.id, entry.id, this.gender);
      this.#outfitCache.set(key, outfit);
    }
    if (generation !== this.#generation) return;
    this.#outfit = outfit;
    this.#options.onChanged?.();
  }

  /* --- Creating ------------------------------------------------------------------------------ */

  /**
   * `CreateCharacter(name)`.
   *
   * Everything the wire needs comes from here rather than from the screen, which is what the client
   * does: the Lua only ever hands over the typed name. 47 is `CHAR_CREATE_SUCCESS` and puts the
   * player back on the character-select screen with the list refreshed; anything else is the
   * corpus' own string for that code (`responseKey`: a `CHAR_CREATE_*` result or the name check's
   * `CHAR_NAME_*` reason) in the corpus' own dialog.
   */
  async createCharacter(name: string): Promise<number | undefined> {
    if (this.#paid) return this.changeCharacter(this.#paid, name);
    const race = this.selectedRace();
    const entry = this.selectedClass();
    const create = this.#options.create;
    if (!race || !entry) return undefined;
    // The client's own name check before anything is sent (`checkCharacterName`, the name as typed:
    // a leading or trailing space is an invalid character, not something to trim away). Its refusal
    // is the same dialog a refusal of the core's would be, with the reason's own text.
    const verdict = checkCharacterName(name, this.#options.nameRules?.() ?? {});
    if (verdict !== RESPONSE_CODES.CHAR_NAME_SUCCESS) {
      this.dialog(responseKey(verdict, "create"), "Недопустимое имя персонажа");
      return undefined;
    }
    if (!create) {
      this.dialog("CHAR_CREATE_FAILED", "Нет соединения с миром: персонажа не создать.");
      return undefined;
    }
    if (this.#creating) return undefined;
    this.#creating = true;
    try {
      const result = await create({
        name,
        race: race.id,
        classId: entry.id,
        gender: this.gender,
        skin: this.#look.skin,
        face: this.#look.face,
        hairStyle: this.#look.hairStyle,
        hairColor: this.#look.hairColor,
        facialHair: this.#look.facialHair,
        outfitId: 0,
      });
      if (result === undefined) return undefined;
      if (result === CHAR_CREATE_SUCCESS) {
        this.#options.setGlueScreen?.("charselect");
        return result;
      }
      this.dialog(responseKey(result, "create"), `Сервер отказал в создании, код ${result}.`);
      return result;
    } catch (error) {
      // The exception's English is for the log; the player reads the client's words for it
      // (`describeFailure`): a dropped socket is DISCONNECTED, any other failure CHAR_CREATE_FAILED.
      this.#options.onDiagnostic?.(error instanceof Error ? error.message : String(error));
      showStatusMessage({
        fire: (event, ...args) => { this.#options.fireEvent?.(event, ...args); },
        glueString: this.#options.glueString,
        hasDialogType: this.#options.hasDialogType,
      }, describeFailure(error, "create"));
      return undefined;
    } finally {
      this.#creating = false;
    }
  }

  /**
   * `CreateCharacter(name)` in paid mode (Wow.exe 0x4e0380 → 0x4d8e10 / 0x4d8f20 / 0x4d9040).
   *
   * The name is checked by the creation rules unless it is the character's own (`_strnicmp`, ASCII
   * case only), and a refusal is the creation screen's OKAY dialog. Then the CANCEL dialog with the
   * service's IN_PROGRESS text and the packet the character's flags call for, carrying the sex, the
   * five looks and — for a faction or race change — the chosen race's id. The answer (0x4d9190 for a
   * customisation, 0x4d92d0 for the other two): success closes the dialog and goes back to
   * `charselect`; a refusal is the OKAY dialog with the screen's key for it (`responseKey`), and the
   * creation screen stays up in paid mode.
   */
  private async changeCharacter(paid: GluePaidCharacter, name: string): Promise<number | undefined> {
    const race = this.selectedRace();
    if (!race) return undefined;
    if (asciiFold(name) !== asciiFold(paid.name)) {
      const verdict = checkCharacterName(name, this.#options.nameRules?.() ?? {});
      if (verdict !== RESPONSE_CODES.CHAR_NAME_SUCCESS) {
        this.dialog(responseKey(verdict, "create"), "Недопустимое имя персонажа");
        return undefined;
      }
    }
    const context = paid.kind === "customize" ? "customize" : "faction";
    const failed = (): void => {
      this.dialog(responseKey(-1, context), "Не удалось изменить персонажа.");
    };
    const send = this.#options.paid;
    if (!send) {
      failed();
      return undefined;
    }
    if (this.#creating) return undefined;
    this.#creating = true;
    try {
      const [key, text] = PAID_IN_PROGRESS[paid.kind];
      this.#options.fireEvent?.("OPEN_STATUS_DIALOG", "CANCEL", messageFor(key, this.#options.glueString, text));
      const outcome = await send({
        kind: paid.kind,
        guid: paid.guid,
        name,
        race: race.id,
        gender: this.gender,
        skin: this.#look.skin,
        face: this.#look.face,
        hairStyle: this.#look.hairStyle,
        hairColor: this.#look.hairColor,
        facialHair: this.#look.facialHair,
      });
      if (outcome.status !== "answered") {
        // Nobody to ask; otherwise cancelled (a late success is the session's to apply) or failed
        // (the connection's own dialog is already up).
        if (outcome.status === "unavailable") failed();
        return undefined;
      }
      const { result } = outcome.answer;
      if (result === RESPONSE_SUCCESS) {
        this.#options.fireEvent?.("CLOSE_STATUS_DIALOG");
        this.#options.setGlueScreen?.("charselect");
        return result;
      }
      this.dialog(responseKey(result, context), `Сервер отказал, код ${result}.`);
      return result;
    } finally {
      this.#creating = false;
    }
  }

  /** The stock OKAY dialog, re-measured once it is visible so a long refusal stays inside its box. */
  private dialog(key: string | undefined, fallback: string): void {
    const text = messageFor(key, this.#options.glueString, fallback);
    openStatusDialog((event, ...args) => { this.#options.fireEvent?.(event, ...args); }, "OKAY", text);
  }
}
