import * as THREE from "three";
import type { WmoReliefAnswer } from "./WmoReliefLoad.js";
import { deriveWmoReliefAsync } from "./WmoReliefWorker.js";

/**
 * 22.10 (7.47 stage 2): the relief maps of building textures, one per texture URL, shared by every
 * material drawing that texture and released with the last of them.
 *
 * A material asks for its map as it is bound; until the map arrives — and for good when the texture
 * is too flat or the derivation fails — it samples {@link WMO_RELIEF_FLAT} with its switch uniform
 * at 0, so the program it was built with never changes (`WmoReliefShader.ts`).
 */

/** 22.10 (7.47 stage 2): the 1×1 stand-in a material samples until (unless) its map arrives. */
export const WMO_RELIEF_FLAT: THREE.DataTexture = (() => {
  const texture = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
})();

type Listener = (texture: THREE.Texture) => void;

interface MapEntry {
  refs: number;
  texture?: THREE.DataTexture;
  /** The derivation answered (with a map or without one). */
  settled: boolean;
  readonly listeners: Set<Listener>;
}

export interface WmoReliefMapStats {
  /** Textures with a map or a derivation underway. */
  readonly entries: number;
  readonly maps: number;
  /** CPU bytes of the maps (the GPU holds the same plus a third for mips). */
  readonly bytes: number;
  readonly pending: number;
  /** 23.10 (7.47): released maps kept for a quick rebuild (`WMO_RELIEF_RETAIN`). */
  readonly retained: number;
}

/**
 * 23.10 (7.47): how many released URLs keep their map (or their pending derivation, or their "no
 * map" answer) for a while. A building's materials are rebuilt now and then — the world material
 * cache evicting, a placement rebuilt, a range change — and a map released with its last material
 * used to be disposed and derived again in the worker, so the new material drew flat until it came
 * back: the relief blinked off and on (the owner, 22.10). ≤ 128² RGBA each: 64 × 64 KB = 4 MB CPU.
 */
export const WMO_RELIEF_RETAIN = 64;

/** 22.10 (7.47 stage 2): the map's texture: RGBA8 data (not colour), repeating, mipmapped like its base. */
export function wmoReliefTexture(relief: Uint8Array, side: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(relief, side, side, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  // Row 0 is the image's top row, at v = 0 — as the WMO textures are uploaded (`flipY = false`).
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

export class WmoReliefMaps {
  readonly #entries = new Map<string, MapEntry>();
  /** 23.10 (7.47): released entries, oldest first (a Map keeps insertion order). */
  readonly #retired = new Map<string, MapEntry>();
  readonly #derive: (url: string) => Promise<WmoReliefAnswer>;
  readonly #retain: number;
  #bytes = 0;

  constructor(derive: (url: string) => Promise<WmoReliefAnswer> = deriveWmoReliefAsync, retain = WMO_RELIEF_RETAIN) {
    this.#derive = derive;
    this.#retain = retain;
  }

  /**
   * 22.10 (7.47 stage 2): holds the map of `url`; `onMap` is called once with it (now, if it is
   * ready). Returns the release; the last release retires the map (`WMO_RELIEF_RETAIN`).
   */
  acquire(url: string, onMap: Listener): () => void {
    let entry = this.#entries.get(url);
    if (!entry) {
      // 23.10 (7.47): a map released moments ago comes back as it was — bound at once, not derived again.
      entry = this.#retired.get(url);
      if (entry) this.#retired.delete(url);
      else {
        entry = { refs: 0, settled: false, listeners: new Set() };
        this.#start(url, entry);
      }
      this.#entries.set(url, entry);
    }
    entry.refs++;
    if (entry.texture) onMap(entry.texture);
    else if (!entry.settled) entry.listeners.add(onMap);
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.listeners.delete(onMap);
      held.refs--;
      if (held.refs > 0 || this.#entries.get(url) !== held) return;
      this.#entries.delete(url);
      this.#retired.set(url, held);
      this.#trim(this.#retain);
    };
  }

  /** 23.10 (7.47): drops the released maps past the newest `keep` (all of them with 0: the leaf turned off). */
  trim(keep = 0): void {
    this.#trim(keep);
  }

  #trim(keep: number): void {
    for (const [url, entry] of this.#retired) {
      if (this.#retired.size <= keep) return;
      this.#retired.delete(url);
      if (entry.texture) {
        this.#bytes -= (entry.texture.image.data as Uint8Array).byteLength;
        entry.texture.dispose();
        delete entry.texture;
      }
    }
  }

  #start(url: string, entry: MapEntry): void {
    const settle = (answer: WmoReliefAnswer | undefined) => {
      entry.settled = true;
      const listeners = [...entry.listeners];
      entry.listeners.clear();
      // Released and dropped meanwhile: nothing is kept (released but retained: kept for a comeback).
      if ((this.#entries.get(url) !== entry && this.#retired.get(url) !== entry) || !answer?.relief) return;
      entry.texture = wmoReliefTexture(answer.relief, answer.side);
      this.#bytes += answer.relief.byteLength;
      for (const listener of listeners) listener(entry.texture);
    };
    this.#derive(url).then(settle, () => settle(undefined));
  }

  get stats(): WmoReliefMapStats {
    let maps = 0;
    let pending = 0;
    for (const entry of this.#entries.values()) {
      if (entry.texture) maps++;
      else if (!entry.settled) pending++;
    }
    return { entries: this.#entries.size, maps, bytes: this.#bytes, pending, retained: this.#retired.size };
  }
}
