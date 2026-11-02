/**
 * 03.11: the trackers of the stock tracking menu that are not spells, as Wow.exe's GetTrackingInfo lists them (category
 * «other»; read on a warrior, a rogue and a hunter). They ask the server nothing: the client looks at the NPC flags itself.
 * One at a time: selecting one drops the last, measured by turning all of them on in a row. The choice is the client's
 * CVar in the original, a browser setting here.
 */
import { unit, worldObject } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { MINIMAP_TOWN_CELL, type MinimapIconCell } from "./MinimapArt.js";

export interface TownTracker {
  /** The GlobalStrings key of its name, also what the choice is stored as. */
  readonly name: string;
  readonly texture: string;
  /** UNIT_NPC_FLAGS bits it shows; none for the mailbox and the low-level quests. */
  readonly npcFlags: number;
  /** Only this class gets it. */
  readonly classId?: number;
}

const CLASS_HUNTER = 3;
const CLASS_ROGUE = 4;
const MAILBOX_GAMEOBJECT_TYPE = 19;
const TRIVIAL_QUESTS = "MINIMAP_TRACKING_TRIVIAL_QUESTS";
const MAILBOX = "MINIMAP_TRACKING_MAILBOX";
const STORAGE_KEY = "webclient.minimap.town";

const tracker = (key: string, picture: string, npcFlags: number, classId?: number): TownTracker => ({
  name: `MINIMAP_TRACKING_${key}`,
  texture: `Interface\\Minimap\\Tracking\\${picture}`,
  npcFlags,
  ...(classId === undefined ? {} : { classId }),
});

const TOWN_TRACKERS: readonly TownTracker[] = [
  tracker("REPAIR", "Repair", 0x1000),
  tracker("VENDOR_FOOD", "Food", 0x200),
  tracker("VENDOR_POISON", "Poisons", 0x400, CLASS_ROGUE),
  tracker("VENDOR_AMMO", "Ammunition", 0x100),
  tracker("VENDOR_REAGENT", "Reagents", 0x800),
  tracker("INNKEEPER", "Innkeeper", 0x10000),
  tracker("FLIGHTMASTER", "FlightMaster", 0x2000),
  tracker("STABLEMASTER", "StableMaster", 0x400000, CLASS_HUNTER),
  tracker("BATTLEMASTER", "BattleMaster", 0x100000),
  tracker("TRAINER_CLASS", "Class", 0x20),
  tracker("TRAINER_PROFESSION", "Profession", 0x40),
  tracker("AUCTIONEER", "Auctioneer", 0x200000),
  tracker("BANKER", "Banker", 0x20000),
  tracker("MAILBOX", "Mailbox", 0),
  tracker("TRIVIAL_QUESTS", "TrivialQuests", 0),
];

/** The list a character of this class sees, in the client's order. */
export function townTrackersOf(classId: number | undefined): readonly TownTracker[] {
  return TOWN_TRACKERS.filter((row) => row.classId === undefined || row.classId === classId);
}

function readActive(): string | undefined {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return TOWN_TRACKERS.some((row) => row.name === stored) ? stored! : undefined;
  } catch {
    return undefined;
  }
}

let active: string | undefined = readActive();

export function activeTownTracker(): string | undefined {
  return active;
}

export function setTownTracker(name: string | undefined): void {
  active = name;
  try {
    if (name === undefined) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // A browser with storage turned off still tracks; it just forgets.
  }
}

/** The «low-level quests» tracker: what lets statuses 2 and 4 mark the map. */
export function trivialQuestsTracked(): boolean {
  return active === TRIVIAL_QUESTS;
}

/** Whether the active town tracker shows this object, and with which cell. */
export function townTrackedCell(object: WorldObjectState): MinimapIconCell | undefined {
  if (active === undefined) return undefined;
  if (active === MAILBOX) {
    if (object.typeId !== 5) return undefined;
    const template = game.world?.gameObjectTemplate(worldObject.entry(object) ?? 0, object.guid);
    return template?.type === MAILBOX_GAMEOBJECT_TYPE ? MINIMAP_TOWN_CELL : undefined;
  }
  if (object.typeId !== 3) return undefined;
  const row = TOWN_TRACKERS.find((candidate) => candidate.name === active);
  return row && row.npcFlags !== 0 && ((unit.npcFlags(object) ?? 0) & row.npcFlags) !== 0 ? MINIMAP_TOWN_CELL : undefined;
}
