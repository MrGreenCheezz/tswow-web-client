import { CAMERA_PITCH_LIMIT } from "./CameraRig.js";
import { CAMERA_VIEW_DEFAULT, CAMERA_VIEW_DEFAULTS } from "./CameraViews.js";

/**
 * 5.14 (owner, 12.10: the camera keeps to the original): where a character's camera starts, as Wow.exe
 * 3.3.5a (12340) keeps it. Read-only notes: .runtime/re-2026-10-11/glue-1110/cam1–cam6.
 *
 * - `cameraSavedDistance` and `cameraSavedPitch` are registered by 0x5fd910 with flag 0x20 — the
 *   per-character config cache — and default to view 2's row of the views table (0xad1ba8, index
 *   from the string "2" at 0xad1b90): "5.55" yards and "10.0" degrees, positive looking down.
 * - 0x5ff3e0, run when the character's config has arrived (0x518bf0), puts them in the camera: the
 *   distance clamped to 0…50 (0x00a1e2fc) into both the current and the target distance (camera+0x118,
 *   +0x1e8), the pitch in radians into both pitches (+0x120, +0x230) — no glide.
 * - 0x5ff320 writes them back ("%f"): the target distance and pitch × 57.29578, when the config cache is
 *   saved (0x512890) and when the vehicle distance takes over (0x600590, VehicleCamera.ts). While the
 *   vehicle distance is in force the camera's distance is the vehicle's, so nothing is saved here then.
 *
 * This client keeps the pair in browser storage per account, realm and character, like the views
 * (CameraViews.ts keeps the account's): read on the first frame of a world once the character's guid is
 * known, written when the world changes and at most every five seconds while it lasts — the page has
 * no logout to wait for, a closed tab loses at most those seconds. Nothing is allocated per frame.
 */

/** View 2's row (0xad1ba8): yards, and degrees with positive looking down. */
export const CAMERA_SAVED_DISTANCE_DEFAULT = CAMERA_VIEW_DEFAULTS[CAMERA_VIEW_DEFAULT]![0];
export const CAMERA_SAVED_PITCH_DEFAULT = CAMERA_VIEW_DEFAULTS[CAMERA_VIEW_DEFAULT]![1];
/** 0x5ff3e0's clamp (0x00a1e2fc). */
export const CAMERA_SAVED_DISTANCE_MAX = 50;
/** How often a changed camera is written while the world lasts, ms. */
export const CAMERA_SAVE_INTERVAL_MS = 5_000;
/** Two numbers closer than this are the same (0x00a1e34c). */
const SAME = 1e-3;
const DEG = Math.PI / 180;

/** The camera numbers this reads and writes: CameraRig's, the eased ones optional. */
export interface SavedCameraRig {
  /** The wheel's number, yards. */
  distance: number;
  /** Positive looks up. */
  pitch: number;
  /** The eased distance and the one walls allowed; set with the distance so nothing glides. */
  zoom?: number;
  view?: number;
  /** The pitch the floor allowed. */
  viewPitch?: number;
}

export interface CameraSavedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where a character's camera is kept; Latin letters of the account fold, as CameraViews' key does. */
export function cameraSavedStorageKey(account: string, realm: string, guid: bigint): string {
  return `webclient.camera-saved.v1:${account.replace(/[A-Z]/g, (letter) => letter.toLowerCase())}:${realm}:${guid.toString()}`;
}

/** "distance,pitch" read back, each a finite number, or undefined. */
export function parseCameraSaved(text: string | null | undefined): { distance: number; pitch: number } | undefined {
  if (!text) return undefined;
  const comma = text.indexOf(",");
  if (comma < 0) return undefined;
  const distance = Number(text.slice(0, comma));
  const pitch = Number(text.slice(comma + 1));
  return Number.isFinite(distance) && Number.isFinite(pitch) ? { distance, pitch } : undefined;
}

function pageStorage(): CameraSavedStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export class CameraSaved {
  readonly #storageOption: CameraSavedStorage | null | undefined;
  #world: unknown;
  /** The character whose camera is on screen; undefined until its guid is known. */
  #key: string | undefined;
  /** The new world still waits for the character's guid. */
  #pending = false;
  /** What storage holds for `#key`: yards and degrees (positive down). */
  #storedDistance = Number.NaN;
  #storedPitch = Number.NaN;
  #nextSave = 0;

  /** `storage`: undefined is the page's localStorage, null none (tests pass their own). */
  constructor(storage?: CameraSavedStorage | null) {
    this.#storageOption = storage;
  }

  /** The storage key of the character on screen (tests, diagnostics). */
  get key(): string | undefined {
    return this.#key;
  }

  /**
   * Once a frame. `vehicleMode`: the vehicle distance is in force (VehicleCamera.ts), and the camera's
   * distance is not the character's to keep.
   */
  frame(
    rig: SavedCameraRig, now: number, world: unknown, account: string | undefined,
    realm: string | undefined, guid: bigint | undefined, vehicleMode: boolean,
  ): void {
    if (world !== this.#world) {
      // 0x5ff320 for the camera being left, then the new world waits for its character.
      if (!vehicleMode) this.#save(rig);
      this.#world = world;
      this.#key = undefined;
      this.#pending = true;
    }
    if (this.#pending) {
      if (account === undefined || realm === undefined || guid === undefined || guid === 0n) return;
      this.#pending = false;
      this.#key = cameraSavedStorageKey(account, realm, guid);
      this.#load(rig);
      this.#nextSave = now + CAMERA_SAVE_INTERVAL_MS;
      return;
    }
    if (now < this.#nextSave) return;
    this.#nextSave = now + CAMERA_SAVE_INTERVAL_MS;
    if (!vehicleMode) this.#save(rig);
  }

  /** 0x5ff3e0: the saved pair, or view 2's, into the camera without a glide. */
  #load(rig: SavedCameraRig): void {
    const saved = parseCameraSaved(this.#storage()?.getItem(this.#key!));
    const distance = saved?.distance ?? CAMERA_SAVED_DISTANCE_DEFAULT;
    const pitch = saved?.pitch ?? CAMERA_SAVED_PITCH_DEFAULT;
    this.#storedDistance = saved ? distance : Number.NaN;
    this.#storedPitch = saved ? pitch : Number.NaN;
    const yards = distance >= 0 && distance < CAMERA_SAVED_DISTANCE_MAX ? distance
      : distance >= CAMERA_SAVED_DISTANCE_MAX ? CAMERA_SAVED_DISTANCE_MAX : 0;
    // Wow.exe takes the pitch as it is; this rig keeps its own limit, so it is held inside it.
    const up = Math.max(-CAMERA_PITCH_LIMIT, Math.min(CAMERA_PITCH_LIMIT, -pitch * DEG));
    rig.distance = yards;
    if (rig.zoom !== undefined) rig.zoom = yards;
    if (rig.view !== undefined) rig.view = yards;
    rig.pitch = up;
    if (rig.viewPitch !== undefined) rig.viewPitch = up;
  }

  /** 0x5ff320: the camera's distance and pitch, when they differ from what storage holds. */
  #save(rig: SavedCameraRig): void {
    const key = this.#key;
    if (key === undefined) return;
    const distance = rig.distance;
    const pitch = -rig.pitch / DEG;
    if (!Number.isFinite(distance) || !Number.isFinite(pitch)) return;
    if (Math.abs(distance - this.#storedDistance) < SAME && Math.abs(pitch - this.#storedPitch) < SAME) return;
    try {
      this.#storage()?.setItem(key, `${distance.toFixed(3)},${pitch.toFixed(3)}`);
    } catch {
      return;
    }
    this.#storedDistance = distance;
    this.#storedPitch = pitch;
  }

  #storage(): CameraSavedStorage | undefined {
    return this.#storageOption === null ? undefined : this.#storageOption ?? pageStorage();
  }
}

export const cameraSaved = new CameraSaved();
