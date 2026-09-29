import type { GlueLuaVm } from "./GlueLua.js";
import { GlueCreation, raceFileToken, SEX_FEMALE, SEX_MALE } from "./GlueCreation.js";

/**
 * The character-creation half of the glue C API.
 *
 * Every signature below is read off its only caller in `CharacterCreate.lua`, and on this screen
 * that matters more than usual because the corpus unpacks nearly all of them **positionally**:
 * `CharacterCreateEnumerateRaces(GetAvailableRaces())` counts `select("#", ...)/3` and reads name,
 * file token and enabled flag in threes; `local _,_,index = GetSelectedClass()` takes the third
 * value; `local name, faction = GetFactionForRace(...)` uses the second to key
 * `FACTION_BACKDROP_COLOR_TABLE`. One value in the wrong slot and the screen colours every race
 * button by the wrong faction, or indexes a nil `coords` table and dies inside `OnShow`.
 *
 * The enabled flag is the **number 1**, not `true`: the corpus tests `select(i+2, ...) == 1`.
 */

/** What the 3D preview has to be told, from a screen that knows nothing about three.js. */
export interface GlueCreationView {
  /** Rebuild the previewed figure from the current selection. */
  update(): void;
  /** `SetCharCustomizeFrame` names the widget the figure stands in. */
  setModelFrame(name: string): void;
}

export interface GlueCreateApiOptions {
  readonly vm: GlueLuaVm;
  readonly creation: GlueCreation;
  readonly view?: GlueCreationView;
}

export function installGlueCreateApi(options: GlueCreateApiOptions): void {
  const { vm, creation, view } = options;
  const number = (value: unknown, fallback = 0): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  /** Every change to the selection has to reach the preview; one place does it. */
  const changed = (): void => { view?.update(); };

  /* --- The two lists ------------------------------------------------------------------------- */

  const flatten = (entries: readonly { name: string; token: string; enabled: boolean }[]): unknown[] => {
    const out: unknown[] = [];
    for (const entry of entries) out.push(entry.name, entry.token, entry.enabled ? 1 : 0);
    return out;
  };
  vm.registerGlobal("GetAvailableRaces", () => flatten(creation.availableRaces()));
  vm.registerGlobal("GetAvailableClasses", () => flatten(creation.availableClasses()));

  /* --- The selection ------------------------------------------------------------------------- */

  vm.registerGlobal("GetSelectedRace", () => [creation.raceIndex]);
  vm.registerGlobal("SetSelectedRace", (args) => {
    creation.selectRace(number(args[0], 1));
    changed();
    return [];
  });
  // `className, classFileName, index, tank, healer, damage`. 3.3.5's `ChrClasses` carries no role
  // columns at all, so the last three are `false` rather than invented — and the only caller
  // (`SetCharacterClass`, `:360`) never reads them.
  vm.registerGlobal("GetSelectedClass", () => {
    const entry = creation.selectedClass();
    if (!entry) return ["", "", creation.classIndex, false, false, false];
    return [
      entry.name || `Класс ${entry.id}`,
      entry.fileName || String(entry.id),
      creation.classIndex,
      false, false, false,
    ];
  });
  vm.registerGlobal("SetSelectedClass", (args) => {
    creation.selectClass(number(args[0], 1));
    changed();
    return [];
  });
  vm.registerGlobal("GetSelectedSex", () => [creation.sex]);
  vm.registerGlobal("SetSelectedSex", (args) => {
    creation.selectSex(number(args[0], SEX_MALE) === SEX_FEMALE ? SEX_FEMALE : SEX_MALE);
    changed();
    return [];
  });

  // `local race, fileString = GetNameForRace()` — called with no argument, so it is the selection.
  vm.registerGlobal("GetNameForRace", (args) => {
    const index = args[0] === undefined ? creation.raceIndex : number(args[0], creation.raceIndex);
    const race = creation.races[index - 1];
    if (!race) return ["", ""];
    return [race.name || `Раса ${race.id}`, raceFileToken(race)];
  });
  // `local name, faction = GetFactionForRace(index)`; `faction` keys FACTION_BACKDROP_COLOR_TABLE,
  // whose only two entries are `Alliance` and `Horde`. `ChrRaces.Alliance` is 0, 1 or 2 — the third
  // being a race nobody may create, which cannot be selected here and answers as the Alliance so a
  // dataset oddity cannot index a nil colour table four lines later.
  vm.registerGlobal("GetFactionForRace", (args) => {
    const race = creation.races[number(args[0], creation.raceIndex) - 1];
    const horde = race?.side === 1;
    const key = horde ? "Horde" : "Alliance";
    return [vm.globalString(horde ? "FACTION_HORDE" : "FACTION_ALLIANCE") ?? key, key];
  });
  vm.registerGlobal("IsRaceClassValid", (args) => [
    creation.isRaceClassValid(number(args[0], 1), number(args[1], 1)),
  ]);

  /* --- The five axes ------------------------------------------------------------------------- */

  vm.registerGlobal("GetHairCustomization", () => [creation.hairCustomization()]);
  vm.registerGlobal("GetFacialHairCustomization", () => [creation.facialHairCustomization()]);
  vm.registerGlobal("CycleCharCustomization", (args) => {
    creation.cycle(number(args[0], 1), number(args[1], 1));
    changed();
    return [];
  });
  vm.registerGlobal("RandomizeCharCustomization", () => {
    creation.randomize();
    changed();
    return [];
  });
  vm.registerGlobal("ResetCharCustomize", () => {
    creation.reset();
    changed();
    return [];
  });
  vm.registerGlobal("UpdateCustomizationScene", () => { changed(); return []; });
  vm.registerGlobal("SetCharCustomizeFrame", (args) => {
    view?.setModelFrame(String(args[0] ?? ""));
    return [];
  });

  /* --- The backdrop and the turntable -------------------------------------------------------- */

  vm.registerGlobal("GetCreateBackgroundModel", () => [creation.backgroundModel()]);
  vm.registerGlobal("GetCharacterCreateFacing", () => [creation.facing]);
  vm.registerGlobal("SetCharacterCreateFacing", (args) => {
    creation.setFacing(number(args[0], 0));
    return [];
  });

  /* --- Creating ------------------------------------------------------------------------------ */

  vm.registerGlobal("CreateCharacter", (args) => {
    void creation.createCharacter(String(args[0] ?? ""));
    return [];
  });
}
