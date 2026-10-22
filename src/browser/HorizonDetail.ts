import * as THREE from "three";
import type { HorizonDetailTiles } from "./HorizonDetailTiles.js";

/**
 * 22.10 (7.44): the far ground's detail — the client's minimap bakes laid over the WDL horizon on
 * the enhanced path, at far more than the colour map's 16 texels a tile.
 *
 * Seen from above the bake already holds what the far view lacks: tree crowns, roads, fields and
 * roofs, so a forest two kilometres out reads as a forest rather than a green smear. Two levels,
 * each a toroidal window of whole tiles around the player's tile (a clipmap):
 *
 *   level 0 — 256 texels a tile, the 5×5 tiles within two of the player's (6 slots a side, 1,536²);
 *   level 1 — 128 texels a tile, the 9×9 within four (10 slots a side, 1,280²).
 *
 * A tile sits in slot `(gridY mod slots, gridX mod slots)`, so neighbouring tiles are neighbouring
 * texels and both bilinear filtering and the mip chain run across tile edges exactly as they would
 * on one big picture; only the window's far edge borders a stale slot, and the shader fades each
 * level out over the last third of a tile before it gets there. Past level 1 (the 5–6 tile band,
 * inside the closing fog) the colour map is all there is, as before.
 *
 * GPU memory: 1,536² + 1,280² RGBA with mips = 12.6 + 8.7 = 21.3 MB, plus a 64×64 residency map
 * (16 KB). A cell is uploaded once when it enters a window (texSubImage2D of one resized bitmap
 * and one mipmap regeneration), at most {@link HORIZON_DETAIL_UPLOADS_PER_FRAME} a frame, and
 * fades in over {@link HORIZON_DETAIL_FADE_MS} rather than popping.
 */

export interface HorizonDetailLevel {
  /** Texels per tile side. */
  readonly texels: number;
  /** Slots per side of the toroidal window texture. */
  readonly slots: number;
  /** Tiles either side of the player's tile the level holds (Chebyshev). */
  readonly reach: number;
  /** Chebyshev distance from the window's centre, in tiles, where the level starts fading out. */
  readonly fadeFrom: number;
  /** Where it has faded out — inside `reach + 0.5`, the window's edge. */
  readonly fadeTo: number;
}

export const HORIZON_DETAIL_LEVELS: readonly HorizonDetailLevel[] = Object.freeze([
  Object.freeze({ texels: 256, slots: 6, reach: 2, fadeFrom: 2.15, fadeTo: 2.45 }),
  Object.freeze({ texels: 128, slots: 10, reach: 4, fadeFrom: 4.1, fadeTo: 4.45 }),
]);

/** Cells uploaded into the level textures per frame (each one texSubImage2D plus a mip rebuild). */
export const HORIZON_DETAIL_UPLOADS_PER_FRAME = 2;
/** Pictures being fetched or decoded at once. */
export const HORIZON_DETAIL_CONCURRENCY = 4;
/** How long a newly uploaded cell takes to fade in. */
export const HORIZON_DETAIL_FADE_MS = 400;
/** Anisotropic filtering of the levels: the far ground is only ever seen at a grazing angle. */
export const HORIZON_DETAIL_ANISOTROPY = 8;

/** A grid coordinate's slot in a toroidal window of `slots`. */
export function horizonDetailSlot(grid: number, slots: number): number {
  return ((grid % slots) + slots) % slots;
}

/** Bytes a level texture holds on the GPU, with its full mip chain (RGBA8). */
export function horizonDetailLevelBytes(level: HorizonDetailLevel): number {
  const side = level.texels * level.slots;
  let bytes = 0;
  for (let size = side; ; size = Math.max(1, Math.floor(size / 2))) {
    bytes += size * size * 4;
    if (size === 1) break;
  }
  return bytes;
}

/** Every level and the residency map. */
export function horizonDetailBytes(levels: readonly HorizonDetailLevel[] = HORIZON_DETAIL_LEVELS): number {
  return levels.reduce((sum, level) => sum + horizonDetailLevelBytes(level), 0) + 64 * 64 * 4;
}

/**
 * The cells of a level's window around `centre`, nearest first (Chebyshev rings outward, so the
 * ground beside the near ring fills before the far edge).
 */
export function horizonDetailWindow(centreX: number, centreY: number, reach: number): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  for (let ring = 0; ring <= reach; ring++) {
    for (let x = centreX - ring; x <= centreX + ring; x++) {
      for (let y = centreY - ring; y <= centreY + ring; y++) {
        if (Math.max(Math.abs(x - centreX), Math.abs(y - centreY)) !== ring) continue;
        if (x < 0 || x > 63 || y < 0 || y > 63) continue;
        cells.push({ x, y });
      }
    }
  }
  return cells;
}

/** One cell's state in one level. */
interface CellState {
  /** `none`: no bake (or it failed) — the colour map shows there. */
  status: "waiting" | "loading" | "ready" | "uploaded" | "none";
  bitmap?: ImageBitmap | undefined;
}

class DetailLevelState {
  readonly level: HorizonDetailLevel;
  readonly texture: THREE.DataTexture;
  /** Cell id (`gridX * 64 + gridY`) → state, for the cells of the current window. */
  readonly cells = new Map<number, CellState>();
  /** Cell id each slot was last written for (-1: never). */
  readonly slotOwner: Int32Array;
  /** The window, nearest first, as cell ids. */
  order: number[] = [];
  /** Whether the GPU storage exists (`renderer.initTexture`). */
  allocated = false;

  constructor(level: HorizonDetailLevel, index: number) {
    this.level = level;
    const side = level.texels * level.slots;
    // No data: allocated on the GPU only (texStorage2D), filled cell by cell.
    const texture = new THREE.DataTexture(null, side, side, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.source.dataReady = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = HORIZON_DETAIL_ANISOTROPY;
    texture.name = `horizon-detail-${index}`;
    texture.needsUpdate = true;
    this.texture = texture;
    this.slotOwner = new Int32Array(level.slots * level.slots).fill(-1);
  }
}

/** The renderer's far-ground detail: the level textures, the residency map and the streaming. */
export class HorizonDetail {
  readonly #levels: DetailLevelState[];
  readonly #residencyData = new Uint8Array(64 * 64 * 4);
  /** What each cell's residency is heading for, per level channel (0 or 255). */
  readonly #residencyTarget = new Uint8Array(64 * 64 * 4);
  readonly #fading = new Set<number>();
  readonly residency: THREE.DataTexture;
  readonly centre = new THREE.Vector2(-100, -100);
  readonly #scratch = new THREE.Vector2();
  #map = -1;
  #centreX = -1;
  #centreY = -1;
  #inFlight = 0;
  #generation = 0;
  #lastTime = Number.NaN;
  /** Uploads done so far (diagnostics and tests). */
  uploads = 0;

  constructor(levels: readonly HorizonDetailLevel[] = HORIZON_DETAIL_LEVELS) {
    this.#levels = levels.map((level, index) => new DetailLevelState(level, index));
    const residency = new THREE.DataTexture(this.#residencyData, 64, 64, THREE.RGBAFormat, THREE.UnsignedByteType);
    residency.magFilter = THREE.NearestFilter;
    residency.minFilter = THREE.NearestFilter;
    residency.generateMipmaps = false;
    residency.flipY = false;
    residency.name = "horizon-detail-residency";
    residency.needsUpdate = true;
    this.residency = residency;
  }

  /** The level textures, finest first. */
  get textures(): readonly THREE.Texture[] {
    return this.#levels.map((state) => state.texture);
  }

  /** Cells being fetched or decoded, and decoded cells waiting for their upload. */
  get pending(): number {
    let waiting = 0;
    for (const state of this.#levels) {
      for (const cell of state.cells.values()) if (cell.status === "ready" || cell.status === "loading") waiting++;
    }
    return waiting;
  }

  /** Uploaded cells per level (diagnostics). */
  get resident(): number[] {
    return this.#levels.map((state) => [...state.cells.values()].filter((cell) => cell.status === "uploaded").length);
  }

  /**
   * One frame: follow the player's tile, ask for the cells that entered a window, upload the ones
   * that are decoded (a bounded number), and advance the fades.
   */
  update(renderer: THREE.WebGLRenderer, map: number, centreX: number, centreY: number,
    tiles: HorizonDetailTiles, now: number): void {
    if (map !== this.#map) this.#reset(map);
    if (centreX !== this.#centreX || centreY !== this.#centreY) this.#recentre(centreX, centreY);
    this.#request(map, tiles);
    this.#upload(renderer);
    this.#fade(now);
  }

  /** Drop every cell and forget the map: the textures stay allocated, the residency goes to zero. */
  release(): void {
    this.#reset(-1);
  }

  dispose(): void {
    this.#reset(-1);
    for (const state of this.#levels) {
      state.texture.dispose();
      state.allocated = false;
    }
    this.residency.dispose();
  }

  #reset(map: number): void {
    this.#generation++;
    for (const state of this.#levels) {
      for (const cell of state.cells.values()) cell.bitmap?.close();
      state.cells.clear();
      state.order = [];
      state.slotOwner.fill(-1);
    }
    this.#residencyData.fill(0);
    this.#residencyTarget.fill(0);
    this.#fading.clear();
    this.residency.needsUpdate = true;
    this.#map = map;
    this.#centreX = -1;
    this.#centreY = -1;
    this.centre.set(-100, -100);
  }

  #recentre(centreX: number, centreY: number): void {
    this.#centreX = centreX;
    this.#centreY = centreY;
    // (column, row) of the centre tile's middle: the shader's `vMapUv * 64` frame.
    this.centre.copy(this.#scratch.set(centreY + 0.5, centreX + 0.5));
    for (let index = 0; index < this.#levels.length; index++) {
      const state = this.#levels[index]!;
      const window = horizonDetailWindow(centreX, centreY, state.level.reach);
      const wanted = new Set<number>();
      state.order = window.map((cell) => {
        const id = cell.x * 64 + cell.y;
        wanted.add(id);
        return id;
      });
      for (const [id, cell] of state.cells) {
        if (wanted.has(id)) continue;
        cell.bitmap?.close();
        state.cells.delete(id);
        this.#setResidency(id, index, 0, true);
      }
      for (const id of state.order) if (!state.cells.has(id)) state.cells.set(id, { status: "waiting" });
    }
  }

  #request(map: number, tiles: HorizonDetailTiles): void {
    if (this.#inFlight >= HORIZON_DETAIL_CONCURRENCY) return;
    // Finest level first: the ground nearest the player is the one the eye is on.
    for (let index = 0; index < this.#levels.length; index++) {
      const state = this.#levels[index]!;
      for (const id of state.order) {
        if (this.#inFlight >= HORIZON_DETAIL_CONCURRENCY) return;
        const cell = state.cells.get(id);
        if (!cell || cell.status !== "waiting") continue;
        const hash = tiles.hash(map, Math.floor(id / 64), id % 64);
        if (hash === undefined) return; // the index is still on its way
        if (hash === null) {
          cell.status = "none";
          continue;
        }
        cell.status = "loading";
        this.#inFlight++;
        const generation = this.#generation;
        void tiles.picture(hash, state.level.texels).then((bitmap) => {
          this.#inFlight--;
          if (generation !== this.#generation || state.cells.get(id) !== cell) {
            bitmap?.close();
            return;
          }
          if (!bitmap) {
            cell.status = "none";
            return;
          }
          cell.status = "ready";
          cell.bitmap = bitmap;
        });
      }
    }
  }

  #upload(renderer: THREE.WebGLRenderer): void {
    let budget = HORIZON_DETAIL_UPLOADS_PER_FRAME;
    for (let index = 0; index < this.#levels.length && budget > 0; index++) {
      const state = this.#levels[index]!;
      const batch: Array<{ id: number; cell: CellState }> = [];
      for (const id of state.order) {
        if (batch.length >= budget) break;
        const cell = state.cells.get(id);
        if (cell?.status === "ready" && cell.bitmap) batch.push({ id, cell });
      }
      if (batch.length === 0) continue;
      const { texels, slots } = state.level;
      const texture = state.texture;
      // Allocated with its whole mip chain before the first copy (the batch below turns
      // `generateMipmaps` off between copies, which would otherwise allocate a single level).
      if (!state.allocated) {
        renderer.initTexture(texture);
        state.allocated = true;
      }
      for (let at = 0; at < batch.length; at++) {
        const { id, cell } = batch[at]!;
        const gridX = Math.floor(id / 64);
        const gridY = id % 64;
        const slot = horizonDetailSlot(gridX, slots) * slots + horizonDetailSlot(gridY, slots);
        const previous = state.slotOwner[slot]!;
        // The slot's former cell left the window; it no longer shows from here.
        if (previous !== -1 && previous !== id) this.#setResidency(previous, index, 0, true);
        state.slotOwner[slot] = id;
        const source = new THREE.Texture(cell.bitmap);
        source.flipY = false;
        // One mip rebuild for the batch: only the last copy regenerates the chain.
        texture.generateMipmaps = at === batch.length - 1;
        renderer.copyTextureToTexture(source, texture, null,
          new THREE.Vector2(horizonDetailSlot(gridY, slots) * texels, horizonDetailSlot(gridX, slots) * texels));
        cell.bitmap!.close();
        cell.bitmap = undefined;
        cell.status = "uploaded";
        this.#setResidency(id, index, 255, false);
        this.uploads++;
        budget--;
      }
      texture.generateMipmaps = true;
    }
  }

  #setResidency(id: number, level: number, value: number, immediate: boolean): void {
    const at = id * 4 + level;
    this.#residencyTarget[at] = value;
    if (immediate) {
      if (this.#residencyData[at] !== value) {
        this.#residencyData[at] = value;
        this.residency.needsUpdate = true;
      }
      this.#fading.delete(at);
    } else if (this.#residencyData[at] !== value) {
      this.#fading.add(at);
    }
  }

  #fade(now: number): void {
    const elapsed = Number.isFinite(this.#lastTime) ? Math.max(0, now - this.#lastTime) : 16;
    this.#lastTime = now;
    if (this.#fading.size === 0) return;
    const step = Math.max(1, Math.round((255 * elapsed) / HORIZON_DETAIL_FADE_MS));
    for (const at of this.#fading) {
      const target = this.#residencyTarget[at]!;
      const value = this.#residencyData[at]!;
      const next = target > value ? Math.min(target, value + step) : Math.max(target, value - step);
      this.#residencyData[at] = next;
      if (next === target) this.#fading.delete(at);
    }
    this.residency.needsUpdate = true;
  }
}

/**
 * The fragment code that replaces Lambert's `map_fragment`: the colour map, then level 1, then
 * level 0, each mixed in by its cell's residency and its window fade. Every level is sampled
 * unconditionally — a sample inside a branch has no derivatives to choose its mip by.
 */
export function horizonDetailFragment(levels: readonly HorizonDetailLevel[] = HORIZON_DETAIL_LEVELS): string {
  const channels = ["r", "g", "b", "a"];
  const lines = [
    "#ifdef USE_MAP",
    "\tvec4 sampledDiffuseColor = texture2D( map, vMapUv );",
    "\tvec2 horizonCell = vMapUv * 64.0;",
    "\tvec4 horizonResident = texelFetch( horizonDetailResidency, clamp( ivec2( floor( horizonCell ) ), ivec2( 0 ), ivec2( 63 ) ), 0 );",
    "\tvec2 horizonOffset = abs( horizonCell - horizonDetailCentre );",
    "\tfloat horizonReach = max( horizonOffset.x, horizonOffset.y );",
  ];
  // Coarsest first, so the finer level is mixed over it.
  for (let index = levels.length - 1; index >= 0; index--) {
    const level = levels[index]!;
    lines.push(
      `\tvec3 horizonLevel${index} = texture2D( horizonDetail${index}, horizonCell / ${level.slots.toFixed(1)} ).rgb;`,
      `\tfloat horizonWeight${index} = horizonResident.${channels[index]} * ( 1.0 - smoothstep( ${level.fadeFrom.toFixed(3)}, ${level.fadeTo.toFixed(3)}, horizonReach ) );`,
      `\tsampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, horizonLevel${index}, horizonWeight${index} );`,
    );
  }
  lines.push("\tdiffuseColor *= sampledDiffuseColor;", "#endif");
  return lines.join("\n");
}

/** The uniforms' declarations, prepended to the fragment shader. */
export function horizonDetailPars(levels: readonly HorizonDetailLevel[] = HORIZON_DETAIL_LEVELS): string {
  return [
    ...levels.map((_, index) => `uniform sampler2D horizonDetail${index};`),
    "uniform sampler2D horizonDetailResidency;",
    "uniform vec2 horizonDetailCentre;",
  ].join("\n");
}

export const HORIZON_DETAIL_PROGRAM_KEY = "horizon-detail-7.44";

/**
 * Installs the detail on a Lambert material whose `map` is the colour map. Call before
 * `applyWorldLight`, which chains this hook and keeps its program key.
 */
export function installHorizonDetail(material: THREE.MeshLambertMaterial, detail: HorizonDetail): void {
  material.onBeforeCompile = (shader) => {
    detail.textures.forEach((texture, index) => {
      shader.uniforms[`horizonDetail${index}`] = { value: texture };
    });
    shader.uniforms.horizonDetailResidency = { value: detail.residency };
    shader.uniforms.horizonDetailCentre = { value: detail.centre };
    const target = "#include <map_fragment>";
    if (!shader.fragmentShader.includes(target)) throw new Error("Horizon detail expected Lambert's map_fragment");
    shader.fragmentShader = `${horizonDetailPars()}\n${shader.fragmentShader}`.replace(target, horizonDetailFragment());
  };
  material.customProgramCacheKey = () => HORIZON_DETAIL_PROGRAM_KEY;
  material.needsUpdate = true;
}
