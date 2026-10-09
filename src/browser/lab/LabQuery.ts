// What the address bar asks the character lab for.
//
// Kept apart from the page so it can be driven by a test: the whole value of the lab is that the
// picture on the screen is the one a particular query names, and a query that is read loosely —
// "hair=4" silently becoming style 0 — would make every observation it produces worthless.

import type { EquippedItem } from "../../gateway/CharacterAppearance.js";
import { SHEATH_MELEE, SHEATH_RANGED, SHEATH_UNARMED } from "../Attachment.js";
import { CHARACTER_APPEARANCE_VERSION } from "../CharacterAtlas.js";
import { gatewayOrigin } from "../Environment.js";

export interface LabLook {
  race: number;
  sex: number;
  skin: number;
  face: number;
  hair: number;
  hairColor: number;
  facialHair: number;
  /** 05.10-A7a-A 6.10: `class=` from the page, passed on (the death knight's eye glow); absent sends none. */
  classId?: number;
  /** `slot:inventoryType:displayId[:subClass]`, the spelling `parseEquipment` takes on the gateway. */
  items: EquippedItem[];
}

export interface LabQuery extends LabLook {
  /** A contact sheet instead of one character. */
  sheet: "hair" | "legs" | undefined;
  /** Take the model from this display id rather than from the race's own. */
  display: number | undefined;
  /** Take the model from this path rather than resolving a display id at all. */
  model: string | undefined;
  /** Draw exactly these geosets instead of the ones the gateway chose. */
  geosets: number[] | undefined;
  /** Which pose to hold. `Stand` unless something else is asked for. */
  animation: string;
  /** Leg outfits for `sheet=legs`, as item display ids. Empty means the naked look. */
  legs: number[];
  /**
   * Which weapon is drawn: 0 none, 1 the melee pair, 2 the ranged one.
   *
   * The client hangs a weapon only while it is out — a stowed one would need the item's sheath
   * type to be placed, which the browser is not told — so a lab that defaulted to 0 would draw a
   * character holding nothing and be right about it, which is not what anybody opens the page for.
   * In the world this is UNIT_FIELD_BYTES_2 byte 0, and there is no such field here.
   */
  sheath: number;
}

/**
 * The base display ids of the playable races, `ChrRaces.MaleDisplayID`/`FemaleDisplayID`.
 *
 * Measured on this dataset: 21 rows, of which ten are playable — 1 Human 49/50, 2 Orc 51/52,
 * 3 Dwarf 53/54, 4 NightElf 55/56, 5 Scourge 57/58, 6 Tauren 59/60, 7 Gnome 1563/1564,
 * 8 Troll 1478/1479, 10 BloodElf 15476/15475, 11 Draenei 16125/16126. Race 9 is the goblin, which
 * 3.3.5 ships unplayable.
 *
 * The ids rather than the model paths, on purpose: handed to `/dbc/creature-models` they walk the
 * same CreatureDisplayInfo → CreatureModelData path the renderer walks for a real player, so the
 * lab cannot be looking at a file the client would never have loaded. There is no route yet that
 * enumerates races — Д3 adds one — and until there is, this table is what the lab has.
 */
export const PLAYABLE_RACE_DISPLAYS: Readonly<Record<number, readonly [number, number]>> = {
  1: [49, 50], 2: [51, 52], 3: [53, 54], 4: [55, 56], 5: [57, 58],
  6: [59, 60], 7: [1563, 1564], 8: [1478, 1479], 10: [15476, 15475], 11: [16125, 16126],
};

/** The twenty playable profiles, in race then sex order — the sweep every contact sheet runs. */
export function playableProfiles(): Array<{ race: number; sex: number; display: number }> {
  const profiles: Array<{ race: number; sex: number; display: number }> = [];
  for (const [race, displays] of Object.entries(PLAYABLE_RACE_DISPLAYS)) {
    for (const sex of [0, 1] as const) profiles.push({ race: Number(race), sex, display: displays[sex] });
  }
  return profiles;
}

function byte(params: URLSearchParams, name: string, fallback = 0): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  // Out of range is the caller's mistake and is worth saying so rather than quietly clamping: the
  // gateway answers 400 for anything outside a byte, and a lab that clamped would show a picture
  // of a look nobody asked for.
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`${name}=${raw} — не байт`);
  return value;
}

/** `slot:inventoryType:displayId[:subClass]`, as `visibleEquipment` builds it from the wire. */
export function parseLabItems(spec: string): EquippedItem[] {
  const items: EquippedItem[] = [];
  for (const entry of spec.split(",")) {
    if (!entry.trim()) continue;
    const parts = entry.split(":").map((part) => Number.parseInt(part, 10));
    if ((parts.length !== 3 && parts.length !== 4)
      || parts.some((part) => !Number.isInteger(part) || part < 0)
      || parts[0]! > 18
      || parts[1]! > 30
      || parts[2]! === 0 || parts[2]! > 1_000_000
      || parts.length === 4 && parts[3]! > 255) {
      throw new Error(`items=${entry} — ожидается slot:inventoryType:displayId[:subClass]`);
    }
    if (items.length >= 20) throw new Error("items — не больше 20 предметов");
    items.push({
      slot: parts[0]!, inventoryType: parts[1]!, displayId: parts[2]!,
      ...(parts.length === 4 ? { subClass: parts[3]! } : {}),
    });
  }
  return items;
}

function numberList(params: URLSearchParams, name: string): number[] | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const values = raw.split(",").filter((part) => part.trim() !== "").map((part) => Number.parseInt(part, 10));
  if (values.some((value) => !Number.isInteger(value) || value < 0)) throw new Error(`${name}=${raw} — не список чисел`);
  return values;
}

export function parseLabQuery(search: string): LabQuery {
  const params = new URLSearchParams(search);
  const sheet = params.get("sheet");
  if (sheet !== null && sheet !== "hair" && sheet !== "legs") throw new Error(`sheet=${sheet} — только hair или legs`);
  const display = params.get("display");
  const displayId = display === null ? undefined : Number.parseInt(display, 10);
  if (displayId !== undefined && (!Number.isInteger(displayId) || displayId <= 0)) {
    throw new Error(`display=${display} — не display id`);
  }
  return {
    race: byte(params, "race", 1),
    sex: byte(params, "sex"),
    skin: byte(params, "skin"),
    face: byte(params, "face"),
    hair: byte(params, "hair"),
    hairColor: byte(params, "hairColor"),
    facialHair: byte(params, "facialHair"),
    ...(params.get("class") === null ? {} : { classId: byte(params, "class") }), // 05.10-A7a-A 6.10
    items: parseLabItems(params.get("items") ?? ""),
    sheet: sheet ?? undefined,
    display: displayId,
    model: params.get("model") ?? undefined,
    geosets: numberList(params, "geosets"),
    animation: params.get("animation") ?? "Stand",
    legs: numberList(params, "legs") ?? [],
    sheath: sheathState(params),
  };
}

function sheathState(params: URLSearchParams): number {
  const raw = params.get("sheath");
  if (raw === null) return SHEATH_MELEE;
  const value = Number.parseInt(raw, 10);
  if (value !== SHEATH_UNARMED && value !== SHEATH_MELEE && value !== SHEATH_RANGED) {
    throw new Error(`sheath=${raw} — 0 (убрано), 1 (ближний бой) или 2 (стрелковое)`);
  }
  return value;
}

/**
 * The `/dbc/character-appearance` query for one look.
 *
 * The same spelling `CreatureModelClient.playerAppearance` sends, the version included — and the
 * version is imported from where the client takes it rather than written out a second time: the
 * lab is only worth having if what it asks the gateway for is what the client asks the gateway
 * for, and two copies of a cache-buster drift apart the first time one of them is bumped.
 */
export function appearanceQuery(look: LabLook): string {
  const worn = look.items.map((item) => `${item.slot}:${item.inventoryType}:${item.displayId}`
    + (item.subClass === undefined ? "" : `:${item.subClass}`)).sort().join(",");
  return `v=${CHARACTER_APPEARANCE_VERSION}&race=${look.race}&sex=${look.sex}&skin=${look.skin}&face=${look.face}`
    + `&hair=${look.hair}&hairColor=${look.hairColor}&facialHair=${look.facialHair}`
    + (worn ? `&items=${encodeURIComponent(worn)}` : "")
    + (look.classId === undefined ? "" : `&class=${look.classId}`); // 05.10-A7a-A 6.10
}

/** The address of the gateway, derived from the page exactly as `Dom.ts` derives it for the login. */
export function labGatewayUrl(location: { protocol: string; hostname: string }): string {
  return gatewayOrigin(location);
}
