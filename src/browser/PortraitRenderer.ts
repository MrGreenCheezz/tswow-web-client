import * as THREE from "three";
import {
  applyBillboardBones, disposeSkinnedInstance, instantiateSkinned,
  type SkinnedInstance,
  type SkinnedTemplate,
} from "./AnimatedModel.js";
import {
  fullBodyCameraSpec, m2ToScene, portraitCameraSpec, type PortraitBounds,
} from "./PortraitCamera.js";
import type { BuiltModel } from "./ModelBuild.js";
import {
  type RetainedResourceVisitor,
  visitGeometryBuffers,
  visitMaterialTextures,
} from "./ResourceAccounting.js";
import type { WvmModel } from "./Wvm.js";
import { cloneMaterialForPortrait } from "./WorldLighting.js";
import { ProgramWarmup, PROGRAM_WARMUP_BATCH } from "./ProgramWarmup.js";
import { game } from "./game/Context.js";
import { unit as unitFields } from "../world/Fields.js";

export const PORTRAIT_SLOTS = ["player", "target", "focus", "tot", "pet"] as const;
/** Stable party rows share the same renderer but keep their own surfaces and output canvases. */
export const PARTY_PORTRAIT_SLOTS = ["party1", "party2", "party3", "party4"] as const;
/** Full-body paperdoll shares the world's renderer and model provider with ordinary portraits. */
export const PAPERDOLL_PORTRAIT_SLOT = "paperdoll" as const;
/** Stock CharacterFramePortrait is a separate bust output, but uses the same player source. */
export const CHARACTER_PORTRAIT_SLOT = "character" as const;
/** Stock QuestFramePortrait follows the active giver, independently of target selection. */
export const QUEST_GIVER_PORTRAIT_SLOT = "questnpc" as const;
/**
 * Stock FocusFrameToTPortrait: the focus's target, the one unit-frame row the native HUD has no
 * canvas for (TargetFrame.xml:678 creates FocusFrameToT for "focus-target"). A HUD-style output
 * like `tot`, kept out of PORTRAIT_SLOTS because that list is the five native rows.
 */
export const FOCUS_TARGET_PORTRAIT_SLOT = "focustot" as const;
export const ALL_PORTRAIT_SLOTS = [
  ...PORTRAIT_SLOTS, FOCUS_TARGET_PORTRAIT_SLOT, ...PARTY_PORTRAIT_SLOTS, PAPERDOLL_PORTRAIT_SLOT,
  CHARACTER_PORTRAIT_SLOT, QUEST_GIVER_PORTRAIT_SLOT,
] as const;
/**
 * One stock FrameXML `SetPortraitTexture` output outside the fixed HUD rows: GossipFramePortrait,
 * MerchantFramePortrait, TradeFrameRecipientPortrait and the like. These come and go with their
 * windows, so they are keyed by texture rather than declared here (framexml/FrameXmlPortraits*.ts).
 */
export type StockPortraitSlot = `stock:${string}`;
export type PortraitSlot = (typeof ALL_PORTRAIT_SLOTS)[number] | StockPortraitSlot;

/** Stock portrait slots are not a fixed list; `stock:` is their whole namespace. */
export function isStockPortraitSlot(slot: PortraitSlot): slot is StockPortraitSlot {
  return slot.startsWith("stock:");
}

/**
 * The client's `SetPortraitTexture` picture rather than a HUD canvas: the unit over an opaque black
 * ground, cut to the circle of `Interface\CharacterFrame\TempPortraitAlphaMask`. The stock frame
 * art has a transparent hole where its portrait Texture sits (UI-QuestGreeting-TopLeft,
 * UI-Merchant-TopLeft…), so a transparent ground would show the world through the window, and a
 * square one would show its corners outside the ring. The quest giver's and CharacterFrame's
 * header busts are the same stock call on QuestFramePortrait and CharacterFramePortrait, so they
 * follow the same rule; a live crop of stock CharacterFrame showed the terrain through that ring
 * around the player's head while its ground was transparent.
 */
export function portraitTextureOutput(slot: PortraitSlot): boolean {
  return slot === QUEST_GIVER_PORTRAIT_SLOT || slot === CHARACTER_PORTRAIT_SLOT || isStockPortraitSlot(slot);
}

/**
 * A stock window's canvas whose unit is named but not painted yet — its model still loading, its
 * first readback in flight, its backing store just resized — shows the picture's black ground cut
 * to the circle, not a transparent canvas: underneath is the host's «portrait not available» art,
 * which the client never shows for a unit it can see. Measured on the rich route before this, model
 * load included: the first picture took 308 ms on Gossip's first open and 204 ms on Bank's, with the
 * «?» showing all that time. The quest giver and CharacterFrame keep their transparent blank (the
 * book icon under the quest giver is that page's own fallback).
 */
function pendingStockPicture(slot: PortraitSlot, guid: bigint | undefined): boolean {
  return guid !== undefined && isStockPortraitSlot(slot);
}

/**
 * Host-owned stock portrait targets, read by the world's PortraitRenderer when `setTargets` runs.
 *
 * The HUD's fixed slots arrive as one map from ui/Portraits.ts every frame. Stock window portraits
 * are claimed by FrameXML's `SetPortraitTexture` bridge instead, and must not require that module
 * (or WorldRenderer3D) to know every window's texture. A write that changes nothing does not bump
 * the version, so the renderer's per-frame cost for an unchanged set is one integer compare.
 */
export class StockPortraitTargets {
  readonly #targets = new Map<StockPortraitSlot, PortraitTarget>();
  #version = 0;

  get version(): number {
    return this.#version;
  }

  get size(): number {
    return this.#targets.size;
  }

  get(slot: StockPortraitSlot): PortraitTarget | undefined {
    return this.#targets.get(slot);
  }

  entries(): ReadonlyMap<StockPortraitSlot, PortraitTarget> {
    return this.#targets;
  }

  set(slot: StockPortraitSlot, guid: bigint | undefined, canvas: HTMLCanvasElement | undefined): void {
    const previous = this.#targets.get(slot);
    if (previous && previous.guid === guid && previous.canvas === canvas) return;
    this.#targets.set(slot, { guid, canvas });
    this.#version++;
  }

  delete(slot: StockPortraitSlot): void {
    if (this.#targets.delete(slot)) this.#version++;
  }
}

/** The live client's single set; tests hand a PortraitRenderer their own instance. */
export const stockPortraitTargets = new StockPortraitTargets();

/** One fixed-function directional lamp in the stock character-select light set. */
export interface PortraitDirectionalLightProfile {
  readonly color: number;
  /** Three.js intensity after the Lambert BRDF's `1 / PI` conversion. */
  readonly intensity: number;
  /** Direction from the model origin towards the lamp, in portrait model coordinates. */
  readonly direction: readonly [number, number, number];
}

/**
 * Target/focus/party HUD portraits keep the established cool hemisphere/warm key, while the
 * player portrait and stock CharacterFrame use the race-aware character profile.
 *
 * CharacterFrame resolves the race-specific `RaceLights` set from `GlueParent.lua` when the self
 * object has a race byte; neutral is used only
 * while that byte is unavailable. The client values are converted by PI because ModelBuild uses
 * MeshStandardMaterial (whose Lambert term divides direct and ambient irradiance by PI).
 */
export interface PortraitLightingProfile {
  readonly mode: "hud" | "character";
  readonly ambient: {
    readonly kind: "hemisphere" | "ambient";
    readonly topColor: number;
    readonly bottomColor: number;
    readonly intensity: number;
  };
  readonly directional: readonly PortraitDirectionalLightProfile[];
}

export type PortraitRace = "neutral" | "human" | "nightElf";

const PORTRAIT_BRDF_SCALE = Math.PI;
/** M2 AnimationData's canonical Stand row; unlike a live unit pose this is stable across frames. */
const STAND_ANIMATION_ID = 0;
/** WebGLRenderTarget readback is working-space linear; ImageData expects display-space sRGB. */
const LINEAR_TO_SRGB_BYTE = Uint8Array.from({ length: 256 }, (_, byte) => {
  const linear = byte / 255;
  const srgb = linear <= 0.0031308
    ? 12.92 * linear
    : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, srgb)) * 255);
});

export const PORTRAIT_LIGHTING_PROFILES: Readonly<{
  readonly hud: PortraitLightingProfile;
  readonly neutral: PortraitLightingProfile;
  readonly human: PortraitLightingProfile;
  readonly nightElf: PortraitLightingProfile;
}> = Object.freeze({
  hud: Object.freeze({
    mode: "hud",
    ambient: Object.freeze({
      kind: "hemisphere", topColor: 0xd8e7ff, bottomColor: 0x30261c, intensity: 1.7,
    }),
    directional: Object.freeze([Object.freeze({
      color: 0xffe2b2, intensity: 2.2, direction: [2, 4, 3] as const,
    })]),
  }),
  neutral: Object.freeze({
    mode: "character",
    // A race-neutral fallback used only while the player object has no race byte yet.  Character
    // frames use a hemisphere here, rather than the old single ambient lamp, so dark armour still
    // has a readable lower edge while its face receives the neutral key.
    ambient: Object.freeze({
      kind: "hemisphere", topColor: 0x77839b, bottomColor: 0x30291f,
      intensity: 1.05 * PORTRAIT_BRDF_SCALE,
    }),
    directional: Object.freeze([
      Object.freeze({
        color: 0xb7c5e1, intensity: 1.35 * PORTRAIT_BRDF_SCALE,
        direction: [0.32, 0.78, 0.52] as const,
      }),
      Object.freeze({
        color: 0x594b39, intensity: 0.55 * PORTRAIT_BRDF_SCALE,
        direction: [-0.55, 0.28, -0.66] as const,
      }),
    ]),
  }),
  human: Object.freeze({
    mode: "character",
    ambient: Object.freeze({
      kind: "hemisphere", topColor: 0x72809a, bottomColor: 0x31291f,
      intensity: 1.0 * PORTRAIT_BRDF_SCALE,
    }),
    directional: Object.freeze([
      // RaceLights.HUMAN: cool key, 1.0 x (0.199, 0.349, 0.436).
      Object.freeze({
        color: 0x33596f, intensity: PORTRAIT_BRDF_SCALE,
        direction: [-0.458, -0.666, 0.589] as const,
      }),
      // RaceLights.HUMAN: warm key, 2.0 x (0.522, 0.440, 0.298).
      Object.freeze({
        color: 0x85704c, intensity: 2 * PORTRAIT_BRDF_SCALE,
        direction: [-0.646, -0.501, -0.576] as const,
      }),
    ]),
  }),
  nightElf: Object.freeze({
    mode: "character",
    // The client race-light is blue-violet, but its ambient-only implementation makes a night elf
    // nearly black under MeshStandardMaterial.  Keep the hue and add the neutral key/fill the
    // browser renderer needs to show facial planes and the silhouette at small paperdoll sizes.
    ambient: Object.freeze({
      kind: "hemisphere", topColor: 0x5d668b, bottomColor: 0x211b24,
      intensity: 1.0 * PORTRAIT_BRDF_SCALE,
    }),
    directional: Object.freeze([
      Object.freeze({
        color: 0x9eafd9, intensity: 1.15 * PORTRAIT_BRDF_SCALE,
        direction: [0.35, 0.75, 0.50] as const,
      }),
      Object.freeze({
        color: 0x6b4f43, intensity: 0.48 * PORTRAIT_BRDF_SCALE,
        direction: [-0.52, 0.24, -0.70] as const,
      }),
    ]),
  }),
});

/** Convert authored M2/Z-up lamp directions into the Y-up coordinates used by Three.js. */
export function portraitLightDirectionToScene(
  direction: readonly [number, number, number],
): [number, number, number] {
  const [x, y, z] = m2ToScene(direction);
  const length = Math.hypot(x, y, z);
  if (!(length > 0) || !Number.isFinite(length)) return [0, 1, 0];
  return [x / length, y / length, z / length];
}

/**
 * The fixed slot whose light rig and pose a stock portrait shares: the player's own bust (race
 * lights, Stand) when a window names the player — TradeFramePlayerPortrait, PVPFramePortrait —
 * and the target's (HUD lights, the live world pose) for anybody else.
 */
function portraitRole(slot: PortraitSlot, guid: bigint | undefined): Exclude<PortraitSlot, StockPortraitSlot> {
  if (!isStockPortraitSlot(slot)) return slot;
  const self = game.world?.state.selfGuid;
  return guid !== undefined && self !== undefined && guid === self ? "player" : "target";
}

/** Resolve the renderer-owned light rig for a concrete output slot and known player race. */
export function portraitLightingProfile(
  slot: PortraitSlot,
  race: PortraitRace = "neutral",
): PortraitLightingProfile {
  if (slot !== "player" && slot !== PAPERDOLL_PORTRAIT_SLOT && slot !== CHARACTER_PORTRAIT_SLOT) {
    return PORTRAIT_LIGHTING_PROFILES.hud;
  }
  return PORTRAIT_LIGHTING_PROFILES[race];
}

function portraitRaceForGuid(guid: bigint): PortraitRace {
  const object = game.world?.state.objects.get(guid);
  const race = object === undefined ? undefined : unitFields.race(object);
  if (race === 1) return "human";
  if (race === 4) return "nightElf";
  return "neutral";
}

export interface PortraitTarget {
  guid: bigint | undefined;
  canvas: HTMLCanvasElement | undefined;
  /**
   * False while the canvas is off screen — its window closed. Omitted means shown, which is what
   * the HUD rows always are. A hidden target is neither rebuilt nor drawn and asks the world for
   * no pose; its surface keeps the source key of its last paint, so the comparison `#renderSlot`
   * makes is deferred rather than skipped, and the first frame it shows again repaints it once if
   * the look moved meanwhile. Before this every look change rebuilt the paper doll and the
   * CharacterFrame bust with the character window closed — a skinned instance, a Stand pose,
   * material clones, a first draw and a readback each: `render()` on the frame after an equip took
   * 7.5 ms with all three player outputs shown and takes 2.2 ms with those two hidden (HumanMale,
   * three over a no-op WebGL2, Node 22; driver and GPU time come on top of both).
   */
  visible?: boolean;
}

const EMPTY_PORTRAIT_TARGET = { guid: undefined, canvas: undefined } as const;

/** A target that is on screen: anything but an explicit `visible: false`. */
function targetShown(target: PortraitTarget | undefined): boolean {
  return target?.visible !== false;
}

/** The already-built model data borrowed by a portrait; no geometry or material is owned here. */
export interface PortraitSource {
  key: string;
  /** The cache key, kept separate from `key` when an atlas repaint generation changes. */
  buildKey?: string;
  model: WvmModel;
  built: BuiltModel;
  template?: SkinnedTemplate | undefined;
  /** Live world bones are borrowed read-only; their transforms are copied once into the snapshot. */
  liveBones?: readonly THREE.Bone[] | undefined;
  scale: number;
}

export type PortraitSourceProvider = (guid: bigint) => PortraitSource | undefined;

/**
 * Clone only the material shells used by one portrait surface.
 *
 * ModelBuild materials can carry world-only `onBeforeCompile` and program-cache hooks (notably
 * the authored world-light equation). The WorldLighting helper removes only that outer wrapper,
 * while retaining any authored second-layer/fog/fantasy chain. Textures and geometry are still
 * borrowed from the build and must not be disposed by this helper's caller through the material
 * clones.
 */
export function clonePortraitMaterials(materials: readonly THREE.Material[]): THREE.Material[] {
  return materials.map(cloneMaterialForPortrait);
}

/** Release material shells owned by one portrait surface; their borrowed maps stay alive. */
export function disposePortraitMaterials(materials: readonly THREE.Material[] | undefined): void {
  for (const material of materials ?? []) material.dispose();
}

/**
 * Returns a cheap readiness token for the maps a built portrait actually samples.
 *
 * Model textures are loaded after a WVM has been built. A static portrait can therefore paint a
 * transparent/black first frame while the world model is still waiting for its PNG, then remain
 * frozen forever because the appearance key did not change. Texture.version is incremented by
 * three when the loader installs the image; dimensions cover small loader implementations that
 * mutate the image without replacing the Texture object. Atlas repaint generations still travel
 * through PortraitSource.key and do not need a second invalidation path here.
 */
export function portraitTextureRevision(built: Pick<BuiltModel, "materials">): string {
  const revision: string[] = [];
  for (const material of built.materials) {
    const maps = material as THREE.Material & {
      map?: THREE.Texture | null;
      alphaMap?: THREE.Texture | null;
    };
    for (const texture of [maps.map, maps.alphaMap]) {
      if (!texture) {
        revision.push("-");
        continue;
      }
      const image = texture.image as { width?: unknown; height?: unknown } | undefined;
      const width = typeof image?.width === "number" ? image.width : 0;
      const height = typeof image?.height === "number" ? image.height : 0;
      revision.push(`${texture.uuid}:${texture.version}:${width}x${height}`);
    }
  }
  return revision.join("|");
}

interface PortraitSurface {
  group: THREE.Group;
  target: THREE.WebGLRenderTarget;
  root: THREE.Object3D | undefined;
  skinned: SkinnedInstance | undefined;
  /** Per-surface material shells; their maps are borrowed from the shared build. */
  materials: THREE.Material[] | undefined;
  /** Exact shared cache entry borrowed by root/skinned while this surface retains it. */
  built: BuiltModel | undefined;
  /** Raw build/atlas key retained by the material maps borrowed through `built`. */
  buildKey: string | undefined;
  /** Texture-loader revision captured by the last submitted portrait readback. */
  textureRevision: string | undefined;
  sourceKey: string | undefined;
  output: HTMLCanvasElement | undefined;
  pixels: Uint8Array;
  flipped: Uint8ClampedArray;
  width: number;
  height: number;
  dirty: boolean;
  /** A portrait is deliberately a single posed snapshot, not a second animated unit. */
  staticPoseCaptured: boolean;
  /** The target GUID matters even when two units share the same appearance/build key. */
  sourceGuid: bigint | undefined;
  /** Identity of the last successful 2D readback, independent of a borrowed model's lifetime. */
  paintedGuid: bigint | undefined;
  /** Invalidates an in-flight readback even if a target changes away and back again. */
  readbackVersion: number;
}

interface PortraitReadback {
  readonly surface: PortraitSurface;
  readonly version: number;
  readonly guid: bigint;
  readonly sourceKey: string;
  readonly textureRevision: string;
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface PortraitLightState {
  readonly light: THREE.Light;
  readonly visible: boolean;
  readonly intensity: number;
  readonly color: number;
  readonly position: readonly [number, number, number];
  readonly groundColor: number | undefined;
}

export interface PortraitRendererOptions {
  /** Reserved for source compatibility; portraits are now painted once per invalidation. */
  repaintIntervalMs?: number;
  /** Stock window portrait targets; the module's `stockPortraitTargets` unless a test isolates it. */
  stockTargets?: StockPortraitTargets;
}

/**
 * Per-size coverage of the portrait circle, 0..255, with a one-pixel anti-aliased rim. Built once
 * per backing-store size and shared by every surface of that size; a readback only multiplies.
 */
const portraitCircleMasks = new Map<string, Uint8Array>();

export function portraitCircleMask(width: number, height: number): Uint8Array {
  const key = `${width}x${height}`;
  let mask = portraitCircleMasks.get(key);
  if (mask) return mask;
  mask = new Uint8Array(width * height);
  const radius = Math.min(width, height) / 2;
  const centreX = width / 2;
  const centreY = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Pixel centres: a 60px portrait has 30px of radius to either side of its middle line.
      const distance = Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY);
      const coverage = Math.max(0, Math.min(1, radius - distance + 0.5));
      mask[y * width + x] = Math.round(coverage * 255);
    }
  }
  portraitCircleMasks.set(key, mask);
  return mask;
}

/**
 * Renders the five core and four stable party model views, the character/quest headers and any
 * open stock window's `SetPortraitTexture` pictures through the world's existing WebGLRenderer.
 *
 * A WebGL texture cannot be used as an `<img>` or CSS background. The only browser-safe bridge is a
 * readback into a 2D canvas. Render targets therefore live for the lifetime of a slot and are only
 * resized when that slot's canvas changes size; static portraits are read back only when invalidated.
 */
export class PortraitRenderer {
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  readonly #ambient = new THREE.HemisphereLight(0xd8e7ff, 0x30261c, 1.7);
  readonly #key = new THREE.DirectionalLight(0xffe2b2, 2.2);
  /** Hidden for HUD slots; these are the two authored human character-select lamps. */
  readonly #characterAmbient = new THREE.HemisphereLight(0x72809a, 0x31291f, PORTRAIT_BRDF_SCALE);
  readonly #characterCoolKey = new THREE.DirectionalLight(0x33596f, PORTRAIT_BRDF_SCALE);
  readonly #characterWarmKey = new THREE.DirectionalLight(0x85704c, 2 * PORTRAIT_BRDF_SCALE);
  readonly #slotGroups = new Map<PortraitSlot, THREE.Group>();
  readonly #surfaces = new Map<PortraitSlot, PortraitSurface>();
  readonly #targets = new Map<PortraitSlot, PortraitTarget>();
  readonly #targetGuids = new Set<bigint>();
  /** Kept until each fence settles, including across clear/repopulation of the same slot. */
  readonly #pendingReadbacks = new Map<PortraitSlot, PortraitReadback>();
  readonly #programWarmup: ProgramWarmup;
  readonly #source: PortraitSourceProvider;
  readonly #stockTargets: StockPortraitTargets;
  /** `#stockTargets.version` last applied; -1 forces the next setTargets to re-read the set. */
  #stockVersion = -1;
  /** The stock slots currently in `#targets`, as an array so the hot loops allocate nothing. */
  #stockSlots: StockPortraitSlot[] = [];
  /** Canvases this renderer cleared and has not painted since; see `#markUnavailable`. */
  readonly #blankCanvases = new WeakSet<HTMLCanvasElement>();
  /** The GUID whose picture each canvas holds from this renderer's last readback into it. */
  readonly #paintedGuids = new WeakMap<HTMLCanvasElement, bigint>();

  constructor(renderer: THREE.WebGLRenderer, source: PortraitSourceProvider,
    options: PortraitRendererOptions = {}) {
    this.#renderer = renderer;
    this.#programWarmup = new ProgramWarmup(renderer, this.#scene);
    this.#source = source;
    this.#stockTargets = options.stockTargets ?? stockPortraitTargets;
    // Keep accepting the old option while intentionally ignoring it. A static portrait has no
    // animation cadence to throttle: readback happens only after a model/target/size invalidation.
    void options.repaintIntervalMs;
    // Keep the `portrait-*` namespace exclusive to isolated model groups. The lightweight renderer
    // seam (and scene diagnostics) can then count visible portrait roots without mistaking lights
    // for three additional models in every readback.
    this.#ambient.name = "hud-portrait-light-ambient";
    this.#key.name = "hud-portrait-light-key";
    this.#characterAmbient.name = "character-portrait-light-ambient";
    this.#characterCoolKey.name = "character-portrait-light-cool-key";
    this.#characterWarmKey.name = "character-portrait-light-warm-key";
    this.#scene.add(
      this.#ambient, this.#key,
      this.#characterAmbient, this.#characterCoolKey, this.#characterWarmKey,
    );
    for (const slot of ALL_PORTRAIT_SLOTS) {
      // The scene and lights are shared, but each slot owns an isolated group. Only the group
      // being painted is visible during a readback; otherwise all nine roots overlap in one pass.
      const group = new THREE.Group();
      group.name = `portrait-${slot}`;
      group.visible = false;
      this.#slotGroups.set(slot, group);
      this.#scene.add(group);
    }
    this.#key.position.set(2, 4, 3);
    this.#characterCoolKey.position.set(-0.458, -0.666, 0.589);
    this.#characterWarmKey.position.set(-0.646, -0.501, -0.576);
    this.#applyLighting("player");
    this.#scene.background = null;
  }

  /** Allocation-free hot-path query used while posing world units. */
  hasTarget(guid: bigint): boolean {
    return this.#targetGuids.has(guid);
  }

  /**
   * Whether a world unit still needs one pose step before its static portrait can be painted.
   *
   * The query itself allocates no temporary collections: the world pose loop asks it for every
   * drawn unit, so a unit no slot names leaves on one Set lookup, and a portrait unit walks the
   * fixed slots and the (usually empty) stock array reading existing surface/canvas state before
   * resolving the current source key for matching clean slots. A successful snapshot clears the
   * answer until a target, model, or backing-store size invalidates it.
   */
  needsPose(guid: bigint): boolean {
    if (!this.#targetGuids.has(guid)) return false;
    for (const slot of ALL_PORTRAIT_SLOTS) {
      if (this.#slotNeedsPose(slot, guid)) return true;
    }
    const stock = this.#stockSlots;
    for (let index = 0; index < stock.length; index++) {
      if (this.#slotNeedsPose(stock[index]!, guid)) return true;
    }
    return false;
  }

  #slotNeedsPose(slot: PortraitSlot, guid: bigint): boolean {
    const target = this.#targets.get(slot);
    // A hidden surface paints nothing, so it must not keep the world unit off its flat pose.
    if (target?.guid !== guid || !target.canvas || !targetShown(target)) return false;
    const surface = this.#surfaces.get(slot);
    if (!surface || surface.dirty || !surface.staticPoseCaptured || surface.sourceGuid !== guid) return true;
    const width = Math.max(1, target.canvas.width || 96);
    const height = Math.max(1, target.canvas.height || 96);
    if (surface.width !== width || surface.height !== height) return true;
    // Atlas generations are folded into source.key. Resolve the current source only after the
    // cheap surface checks above, so ordinary non-portrait units still pay no provider call.
    const source = this.#source(guid);
    if (!source || surface.sourceKey !== source.key) return true;
    return surface.textureRevision !== portraitTextureRevision(source.built);
  }

  setTargets(targets: ReadonlyMap<PortraitSlot, PortraitTarget>): void {
    // Pushed every frame by the loop: read first, write only on change, so an unchanged frame
    // costs comparisons instead of a cleared guid set, map writes and canvas clears.
    let changed = false;
    for (const slot of ALL_PORTRAIT_SLOTS) {
      const next = targets.get(slot) ?? EMPTY_PORTRAIT_TARGET;
      const previous = this.#targets.get(slot);
      if (previous?.guid !== next.guid || previous?.canvas !== next.canvas
        || targetShown(previous) !== targetShown(next)) {
        changed = true;
        break;
      }
    }
    const stockChanged = this.#stockVersion !== this.#stockTargets.version;
    if (!changed && !stockChanged) return;
    if (changed) {
      for (const slot of ALL_PORTRAIT_SLOTS) this.#applyTarget(slot, targets.get(slot) ?? EMPTY_PORTRAIT_TARGET);
    }
    if (stockChanged) this.#applyStockTargets();
    this.#targetGuids.clear();
    // Only shown targets pin their unit into the world's admission; a closed window's does not.
    for (const target of this.#targets.values()) {
      if (target.guid !== undefined && targetShown(target)) this.#targetGuids.add(target.guid);
    }
  }

  #applyTarget(slot: PortraitSlot, next: PortraitTarget): void {
    const previous = this.#targets.get(slot);
    this.#targets.set(slot, next);
    if (previous?.guid === next.guid && previous?.canvas === next.canvas) return;
    const surface = this.#surfaces.get(slot);
    if (surface) {
      surface.dirty = true;
      surface.readbackVersion++;
    }
    // A stock window reopened on the same unit (the vendor closed and talked to again) keeps the
    // picture its canvas already holds while the fresh surface paints; nothing stale can show,
    // because that canvas last showed exactly this GUID.
    if (!previous && isStockPortraitSlot(slot) && next.guid !== undefined && next.canvas
      && this.#paintedGuids.get(next.canvas) === next.guid) return;
    // Keep the old class/creature image as fallback while the new model is loading; a stale
    // 3D readback must not remain visible through a target transition.
    this.#clearCanvas(previous?.canvas);
    this.#clearCanvas(next.canvas, pendingStockPicture(slot, next.guid));
  }

  /**
   * Follow the stock window set: a slot that left it gives back its whole surface — model, material
   * shells, render target, group — rather than idling at "no GUID" like a fixed HUD row. A closed
   * window therefore costs nothing per frame, and the next open paints once from scratch.
   */
  #applyStockTargets(): void {
    this.#stockVersion = this.#stockTargets.version;
    const entries = this.#stockTargets.entries();
    for (const slot of this.#stockSlots) {
      if (!entries.has(slot)) this.#releaseStockSlot(slot);
    }
    const slots: StockPortraitSlot[] = [];
    for (const [slot, target] of entries) {
      this.#applyTarget(slot, target);
      slots.push(slot);
    }
    this.#stockSlots = slots;
  }

  #releaseStockSlot(slot: StockPortraitSlot): void {
    this.#targets.delete(slot);
    const surface = this.#surfaces.get(slot);
    if (surface) {
      this.#disposeModel(surface);
      surface.target.dispose();
      this.#surfaces.delete(slot);
    }
    const group = this.#slotGroups.get(slot);
    group?.removeFromParent();
    this.#slotGroups.delete(slot);
    // The canvas is not blanked: the host hides a closed window's canvas (or drops it with its
    // claim), and its 2D pixels — all that is left — let the same unit's next visit show at once
    // (`#applyTarget`).
  }

  #slotGroup(slot: PortraitSlot): THREE.Group {
    let group = this.#slotGroups.get(slot);
    if (!group) {
      group = new THREE.Group();
      group.name = `portrait-${slot}`;
      group.visible = false;
      this.#slotGroups.set(slot, group);
      this.#scene.add(group);
    }
    return group;
  }

  targetGuids(): ReadonlySet<bigint> {
    return this.#targetGuids;
  }

  /** Build keys that must be kept alive by the unit cache eviction pass. */
  liveBuildKeys(): Set<string> {
    const live = new Set<string>();
    for (const target of this.#targets.values()) {
      if (target.guid === undefined) continue;
      const source = this.#source(target.guid);
      if (source) live.add(source.buildKey ?? source.key);
    }
    return live;
  }

  /** Exact cache entries retained now or needed by the next invalidated portrait paint. */
  liveBuilds(): Set<BuiltModel> {
    const live = this.retainedBuilds();
    for (const target of this.#targets.values()) {
      if (target.guid === undefined) continue;
      const source = this.#source(target.guid);
      if (source) live.add(source.built);
    }
    return live;
  }

  /** Exact cache entries physically retained by existing portrait roots. */
  retainedBuilds(): Set<BuiltModel> {
    const retained = new Set<BuiltModel>();
    for (const surface of this.#surfaces.values()) {
      if (surface.built) retained.add(surface.built);
    }
    return retained;
  }

  /** Raw cache/atlas keys physically retained by existing portrait roots. */
  retainedBuildKeys(): Set<string> {
    const retained = new Set<string>();
    for (const surface of this.#surfaces.values()) {
      if (surface.buildKey) retained.add(surface.buildKey);
    }
    return retained;
  }

  /** Accounts resources retained by live surfaces and bounded outstanding readbacks. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const surface of this.#surfaces.values()) {
      visitor.referenceCpu(surface, surface.pixels);
      visitor.referenceCpu(surface, surface.flipped);
      visitor.referenceGpuRenderTarget(surface, surface.target);
      if (surface.output) visitor.referenceUnsupported(surface, surface.output);
      surface.root?.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry?.isBufferGeometry === true) {
          visitGeometryBuffers(visitor, object, mesh.geometry);
        }
        if (mesh.material) visitMaterialTextures(visitor, mesh.material);
      });
      const skeleton = surface.skinned?.skeleton;
      if (skeleton) {
        if (skeleton.boneMatrices) visitor.referenceCpu(skeleton, skeleton.boneMatrices);
        if (skeleton.boneTexture) visitor.referenceGpuTexture(skeleton, skeleton.boneTexture);
      }
    }
    for (const pending of this.#pendingReadbacks.values()) {
      visitor.referenceCpu(pending, pending.pixels);
      visitor.referenceCpu(pending, pending.surface.flipped);
      visitor.referenceUnsupported(pending, pending.canvas);
      // Three owns the transient pixel-pack buffer/fence; no raw WebGL handle is exposed here.
      visitor.referenceUnsupported(pending, pending);
    }
  }

  /** Render invalidated portraits. Returns readbacks submitted; canvas updates finish asynchronously. */
  render(_now = performance.now()): number {
    let rendered = 0;
    for (const slot of ALL_PORTRAIT_SLOTS) rendered += this.#renderSlot(slot);
    const stock = this.#stockSlots;
    for (let index = 0; index < stock.length; index++) rendered += this.#renderSlot(stock[index]!);
    return rendered;
  }

  #renderSlot(slot: PortraitSlot): number {
    const target = this.#targets.get(slot);
    if (!target?.canvas || target.guid === undefined) {
      this.#markUnavailable(slot);
      return 0;
    }
    // Off screen: nothing is resolved, rebuilt or drawn, and the canvas keeps its last picture. The
    // surface's recorded source key is the dirty mark — the checks below run on the first frame the
    // canvas is shown again, and repaint exactly once if the look or the texture moved meanwhile.
    if (!targetShown(target)) return 0;
    const source = this.#source(target.guid);
    if (!source) {
      this.#markUnavailable(slot, true);
      return 0;
    }
    const surface = this.#surface(slot, target.canvas);
    const sourceKey = source.key;
    const textureRevision = portraitTextureRevision(source.built);
    if (surface.sourceKey !== sourceKey || surface.sourceGuid !== target.guid) {
      this.#replaceModel(surface, source);
      surface.sourceKey = sourceKey;
      surface.sourceGuid = target.guid;
      surface.dirty = true;
    } else if (surface.textureRevision !== textureRevision) {
      // A late TextureLoader completion changes only the pixels. Keep the captured pose and
      // repaint the existing root instead of needlessly rebuilding the rig.
      surface.dirty = true;
      surface.readbackVersion++;
    }
    surface.output = target.canvas;
    if (!surface.dirty || this.#pendingReadbacks.has(slot)) return 0;
    // Capture the current world pose once. The independent portrait rig is intentionally not
    // advanced by a mixer and must not keep following the animated world unit on later calls.
    this.#captureStaticPose(surface, source, slot);
    if (!this.#paint(slot, surface, source, textureRevision)) return 0;
    surface.dirty = false;
    surface.textureRevision = textureRevision;
    return 1;
  }

  clear(): void {
    for (const surface of this.#surfaces.values()) {
      this.#disposeModel(surface);
      surface.target.dispose();
      this.#clearCanvas(surface.output);
    }
    this.#surfaces.clear();
    this.#targets.clear();
    this.#targetGuids.clear();
    // Stock groups belong to their slot, not to the renderer's lifetime. The set itself is the
    // host's: the next setTargets reads it again, so a mount that outlives a world clear repaints.
    for (const slot of this.#stockSlots) {
      this.#slotGroups.get(slot)?.removeFromParent();
      this.#slotGroups.delete(slot);
    }
    this.#stockSlots = [];
    this.#stockVersion = -1;
    this.#programWarmup.reset();
  }

  dispose(): void {
    this.clear();
    this.#scene.clear();
  }

  #surface(slot: PortraitSlot, canvas: HTMLCanvasElement): PortraitSurface {
    // Use the backing store only. clientWidth/clientHeight are zero for a display:none frame and
    // must not make a portrait target depend on whether its parent is currently visible.
    const width = Math.max(1, canvas.width || 96);
    const height = Math.max(1, canvas.height || 96);
    let surface = this.#surfaces.get(slot);
    if (!surface) {
      const target = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: true, stencilBuffer: false,
        generateMipmaps: false,
      });
      surface = {
        group: this.#slotGroup(slot),
        target, root: undefined, skinned: undefined, materials: undefined,
        built: undefined, buildKey: undefined,
        textureRevision: undefined,
        sourceKey: undefined, output: canvas,
        pixels: new Uint8Array(width * height * 4),
        flipped: new Uint8ClampedArray(width * height * 4),
        width, height, dirty: true, staticPoseCaptured: false, sourceGuid: undefined, paintedGuid: undefined,
        readbackVersion: 0,
      };
      this.#surfaces.set(slot, surface);
    } else if (surface.width !== width || surface.height !== height) {
      surface.target.setSize(width, height);
      surface.pixels = new Uint8Array(width * height * 4);
      surface.flipped = new Uint8ClampedArray(width * height * 4);
      surface.width = width;
      surface.height = height;
      surface.dirty = true;
      surface.readbackVersion++;
      // A new backing store is a transparent bitmap: a stock window's canvas re-measured for a
      // new stage scale shows the pending picture, not the stand-in, until the repaint lands.
      if (isStockPortraitSlot(slot)) this.#clearCanvas(canvas, true);
    }
    return surface;
  }

  #replaceModel(surface: PortraitSurface, source: PortraitSource): void {
    this.#disposeModel(surface);
    const materials = clonePortraitMaterials(source.built.materials);
    let root: THREE.Object3D;
    if (source.template) {
      const instance = instantiateSkinned(source.template, materials);
      surface.skinned = instance;
      root = instance.root;
    } else {
      const mesh = new THREE.Mesh(source.built.geometry, materials);
      mesh.quaternion.set(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      surface.skinned = undefined;
      root = mesh;
    }
    root.scale.setScalar(source.scale > 0 ? source.scale : 1);
    surface.group.add(root);
    surface.root = root;
    surface.materials = materials;
    surface.built = source.built;
    surface.buildKey = source.buildKey ?? source.key;
    surface.textureRevision = undefined;
    surface.staticPoseCaptured = false;
  }

  #disposeModel(surface: PortraitSurface): void {
    surface.readbackVersion++;
    if (surface.root) this.#programWarmup.unregisterObject(surface.root);
    disposeSkinnedInstance(surface.skinned);
    disposePortraitMaterials(surface.materials);
    surface.root?.removeFromParent();
    surface.root = undefined;
    surface.skinned = undefined;
    surface.materials = undefined;
    surface.built = undefined;
    surface.buildKey = undefined;
    surface.textureRevision = undefined;
    surface.sourceKey = undefined;
    surface.sourceGuid = undefined;
    surface.staticPoseCaptured = false;
  }

  #captureStaticPose(surface: PortraitSurface, source: PortraitSource, slot: PortraitSlot): void {
    if (surface.staticPoseCaptured) return;
    const skinned = surface.skinned;
    if (!skinned) {
      surface.staticPoseCaptured = true;
      return;
    }
    // A source without a live rig is still a valid static portrait: instantiateSkinned's rest
    // pose is the deterministic fallback. Do not retry on every render and accidentally animate
    // when a world unit later changes state.
    // The player's bust camera is authored for Stand. Freezing a running, casting or dead world
    // pose can leave the head outside that camera until the appearance changes again.
    const role = portraitRole(slot, surface.sourceGuid);
    if (role !== "player" && role !== PAPERDOLL_PORTRAIT_SLOT && role !== CHARACTER_PORTRAIT_SLOT && source.liveBones) {
      const bones = skinned.skeleton.bones;
      for (let index = 0; index < bones.length; index++) {
        const pose = source.liveBones[index];
        const bone = bones[index];
        if (!pose || !bone) continue;
        bone.position.copy(pose.position);
        bone.quaternion.copy(pose.quaternion);
        bone.scale.copy(pose.scale);
      }
    } else if (source.template) {
      // "Rest" must mean the model's authored Stand sequence, not merely the skeleton's bind
      // matrices. A bind pose is commonly a T-pose while M2's Stand clip folds the elbows, sets
      // the head and establishes the silhouette players recognise. Sample it once at frame zero
      // on this isolated mixer, then pause the action: this is a deterministic neutral snapshot,
      // never a second continuously animated world rig. If the base model genuinely has no Stand
      // clip, leave instantiateSkinned's bind pose as the explicit fallback.
      const stand = source.template.clips.get(STAND_ANIMATION_ID);
      if (stand) {
        const action = skinned.mixer.clipAction(stand);
        action.reset();
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        skinned.mixer.setTime(0);
        action.paused = true;
        skinned.root.updateMatrixWorld(true);
      }
    }
    surface.staticPoseCaptured = true;
  }

  #portraitLights(): readonly THREE.Light[] {
    return [
      this.#ambient, this.#key,
      this.#characterAmbient, this.#characterCoolKey, this.#characterWarmKey,
    ];
  }

  #captureLighting(): PortraitLightState[] {
    return this.#portraitLights().map((light) => ({
      light,
      visible: light.visible,
      intensity: light.intensity,
      color: light.color.getHex(),
      position: [light.position.x, light.position.y, light.position.z] as const,
      groundColor: light instanceof THREE.HemisphereLight ? light.groundColor.getHex() : undefined,
    }));
  }

  #restoreLighting(states: readonly PortraitLightState[]): void {
    for (const state of states) {
      state.light.visible = state.visible;
      state.light.intensity = state.intensity;
      state.light.color.setHex(state.color);
      state.light.position.set(...state.position);
      if (state.groundColor !== undefined && state.light instanceof THREE.HemisphereLight) {
        state.light.groundColor.setHex(state.groundColor);
      }
    }
  }

  #applyLighting(slot: PortraitSlot, guid?: bigint): void {
    const profile = portraitLightingProfile(
      portraitRole(slot, guid),
      guid === undefined ? "neutral" : portraitRaceForGuid(guid),
    );
    const character = profile.mode === "character";
    this.#ambient.visible = !character;
    this.#key.visible = !character;
    this.#characterAmbient.visible = character;
    this.#characterCoolKey.visible = character && profile.directional.length > 0;
    this.#characterWarmKey.visible = character && profile.directional.length > 1;

    if (!character) {
      this.#ambient.color.setHex(profile.ambient.topColor);
      this.#ambient.groundColor.setHex(profile.ambient.bottomColor);
      this.#ambient.intensity = profile.ambient.intensity;
      const key = profile.directional[0];
      if (key) {
        this.#key.color.setHex(key.color);
        this.#key.intensity = key.intensity;
        this.#key.position.set(...portraitLightDirectionToScene(key.direction));
      }
      return;
    }

    this.#characterAmbient.color.setHex(profile.ambient.topColor);
    this.#characterAmbient.groundColor.setHex(profile.ambient.bottomColor);
    this.#characterAmbient.intensity = profile.ambient.intensity;
    const [cool, warm] = profile.directional;
    if (cool) {
      this.#characterCoolKey.color.setHex(cool.color);
      this.#characterCoolKey.intensity = cool.intensity;
      this.#characterCoolKey.position.set(...portraitLightDirectionToScene(cool.direction));
    }
    if (warm) {
      this.#characterWarmKey.color.setHex(warm.color);
      this.#characterWarmKey.intensity = warm.intensity;
      this.#characterWarmKey.position.set(...portraitLightDirectionToScene(warm.direction));
    }
  }

  #paint(slot: PortraitSlot, surface: PortraitSurface, source: PortraitSource,
    textureRevision: string): boolean {
    if (!surface.root || !surface.output || surface.sourceGuid === undefined) return false;
    const visibleBounds: PortraitBounds | undefined = source.built.geometry.boundingBox ? {
      min: [
        source.built.geometry.boundingBox.min.x,
        source.built.geometry.boundingBox.min.y,
        source.built.geometry.boundingBox.min.z,
      ],
      max: [
        source.built.geometry.boundingBox.max.x,
        source.built.geometry.boundingBox.max.y,
        source.built.geometry.boundingBox.max.z,
      ],
    } : undefined;
    const cameraInput = {
      bounds: source.model.bounds,
      visibleBounds,
      attachments: source.model.attachments,
      scale: source.scale,
    };
    // Paperdolls show the complete visible model and must not inherit the creature bust camera.
    // Both paths remain pure camera resolution; the shared renderer/readback is unchanged.
    const spec = slot === PAPERDOLL_PORTRAIT_SLOT
      ? fullBodyCameraSpec(cameraInput)
      : portraitCameraSpec({ ...cameraInput, camera: source.model.portraitCamera });
    this.#camera.fov = spec.fov;
    this.#camera.near = spec.near;
    this.#camera.far = spec.far;
    this.#camera.aspect = surface.width / surface.height;
    this.#camera.position.set(...spec.position);
    this.#camera.lookAt(...spec.target);
    this.#camera.updateProjectionMatrix();
    this.#camera.updateMatrixWorld(true);
    if (surface.skinned) {
      surface.root.updateMatrixWorld(true);
      // The world unit may already have billboarded its own bones against the world camera. Apply
      // the billboard rule again on this independent rig so cards/glows face the portrait camera.
      if (source.template) applyBillboardBones(surface.skinned, source.template, this.#camera);
      surface.root.updateMatrixWorld(true);
      // Skeleton.update reads each bone's world matrix, so update the independent hierarchy first.
      surface.skinned.skeleton.update();
    } else {
      surface.root.updateMatrixWorld(true);
    }

    const previousTarget = this.#renderer.getRenderTarget();
    const previousViewport = this.#renderer.getViewport(new THREE.Vector4());
    const previousScissor = this.#renderer.getScissor(new THREE.Vector4());
    const previousScissorTest = this.#renderer.getScissorTest();
    const previousClear = this.#renderer.getClearColor(new THREE.Color());
    const previousAlpha = this.#renderer.getClearAlpha();
    const previousAutoClear = this.#renderer.autoClear;
    const previousVisibility = [...this.#slotGroups.values()]
      .map((group) => [group, group.visible] as const);
    const previousLighting = this.#captureLighting();
    try {
      this.#applyLighting(slot, surface.sourceGuid ?? undefined);
      for (const group of this.#slotGroups.values()) group.visible = group === surface.group;
      this.#renderer.setRenderTarget(surface.target);
      this.#renderer.setViewport(0, 0, surface.width, surface.height);
      this.#renderer.setScissor(0, 0, surface.width, surface.height);
      this.#renderer.setScissorTest(false);
      // A stock SetPortraitTexture picture has a black ground (see portraitTextureOutput); the
      // HUD's own canvases keep their transparent one for the native frames' styled backgrounds.
      this.#renderer.setClearColor(0x000000, portraitTextureOutput(slot) ? 1 : 0);
      this.#renderer.autoClear = true;
      this.#renderer.clear(true, true, true);
      this.#renderer.render(this.#scene, this.#camera);
      // The real draw has already linked the exact portrait variants. Give those programs inert
      // owners before a target change disposes its material clones. Drain this surface's finite
      // material list under the same render target/lights; another slot may use a different rig.
      this.#programWarmup.registerObject(surface.root);
      const warmupBatches = Math.ceil(this.#programWarmup.queued / PROGRAM_WARMUP_BATCH);
      for (let batch = 0; batch < warmupBatches; batch++) this.#programWarmup.tick(this.#camera);
      const pending: PortraitReadback = {
        surface, version: surface.readbackVersion, guid: surface.sourceGuid,
        sourceKey: source.key, textureRevision, canvas: surface.output,
        width: surface.width, height: surface.height, pixels: surface.pixels,
      };
      // Three submits a pixel-pack buffer and GPU fence before returning its Promise. The finally
      // below restores the world's state now; no world frame waits for readback or 2D conversion.
      const readback = this.#renderer.readRenderTargetPixelsAsync(
        surface.target, 0, 0, pending.width, pending.height, pending.pixels,
      );
      this.#pendingReadbacks.set(slot, pending);
      void readback.then(
        () => this.#finishReadback(slot, pending, true),
        () => this.#finishReadback(slot, pending, false),
      );
      return true;
    } catch {
      this.#markUnavailable(slot);
      return false;
    } finally {
      this.#renderer.autoClear = previousAutoClear;
      this.#renderer.setClearColor(previousClear, previousAlpha);
      // Select the original framebuffer first: three may apply a target's own viewport/scissor when
      // it becomes current, so restoring those before the target would lose the caller's state.
      this.#renderer.setRenderTarget(previousTarget);
      this.#renderer.setScissorTest(previousScissorTest);
      this.#renderer.setScissor(previousScissor);
      this.#renderer.setViewport(previousViewport);
      for (const [group, visible] of previousVisibility) group.visible = visible;
      this.#restoreLighting(previousLighting);
    }
  }

  #finishReadback(slot: PortraitSlot, pending: PortraitReadback, succeeded: boolean): void {
    const { surface, canvas, width, height, pixels } = pending;
    try {
      if (this.#pendingReadbacks.get(slot) !== pending || this.#surfaces.get(slot) !== surface) return;
      const target = this.#targets.get(slot);
      const source = target?.guid === pending.guid ? this.#source(pending.guid) : undefined;
      if (!succeeded || surface.readbackVersion !== pending.version
        || target?.canvas !== canvas || surface.output !== canvas
        || Math.max(1, canvas.width || 96) !== width || Math.max(1, canvas.height || 96) !== height
        || surface.width !== width || surface.height !== height
        || source?.key !== pending.sourceKey
        || portraitTextureRevision(source.built) !== pending.textureRevision) {
        surface.dirty = true;
        return;
      }
      const context = canvas.getContext("2d");
      if (!context) {
        surface.dirty = true;
        return;
      }
      const rowBytes = width * 4;
      // The stock picture is opaque inside its circle; the rendered alpha there is always 1 over
      // the black clear, so the mask alone is the output coverage.
      const circle = portraitTextureOutput(slot) ? portraitCircleMask(width, height) : undefined;
      for (let y = 0; y < height; y++) {
        const from = (height - y - 1) * rowBytes;
        const to = y * rowBytes;
        for (let column = 0; column < rowBytes; column += 4) {
          const sourcePixel = from + column;
          const outputPixel = to + column;
          surface.flipped[outputPixel] = LINEAR_TO_SRGB_BYTE[pixels[sourcePixel]!]!;
          surface.flipped[outputPixel + 1] = LINEAR_TO_SRGB_BYTE[pixels[sourcePixel + 1]!]!;
          surface.flipped[outputPixel + 2] = LINEAR_TO_SRGB_BYTE[pixels[sourcePixel + 2]!]!;
          // Alpha is display-space coverage and survives readback byte-for-byte.
          surface.flipped[outputPixel + 3] = circle ? circle[y * width + column / 4]! : pixels[sourcePixel + 3]!;
        }
      }
      const image = context.createImageData(width, height);
      image.data.set(surface.flipped);
      context.putImageData(image, 0, 0);
      this.#blankCanvases.delete(canvas);
      this.#paintedGuids.set(canvas, pending.guid);
      surface.paintedGuid = pending.guid;
      canvas.dataset["portraitReady"] = "true";
      canvas.dataset["portraitSlot"] = slot;
    } catch {
      // Driver/context loss or an unavailable 2D canvas leaves the existing fallback intact.
      // A later frame can retry after this slot's one pending fence has settled.
      if (this.#surfaces.get(slot) === surface) surface.dirty = true;
    } finally {
      if (this.#pendingReadbacks.get(slot) === pending) this.#pendingReadbacks.delete(slot);
    }
  }

  /**
   * Runs every frame for every slot without a paintable unit, so its steady state is a no-op: a
   * canvas this renderer already blanked is not cleared again (measured before: one `clearRect`
   * and a dataset write per frame for a closed quest page's canvas, for as long as the HUD lived),
   * and a surface whose model is already gone is not disposed again.
   */
  #markUnavailable(slot: PortraitSlot, preserveSnapshot = false): void {
    const target = this.#targets.get(slot);
    const surface = this.#surfaces.get(slot);
    // Model/atlas replacement can briefly remove a source. Retain only the previous pixels for
    // this exact GUID/canvas; setTargets and clear still invalidate character/world transitions.
    const keepPixels = preserveSnapshot && target?.guid !== undefined && surface?.paintedGuid === target.guid
      && surface.output === target.canvas && target.canvas?.dataset["portraitReady"] === "true"
      && surface.width === target.canvas.width && surface.height === target.canvas.height;
    // Both halves: an adoption cleanup may restore an older `portraitReady` onto a canvas this
    // renderer blanked, and the flag must be put right again once.
    if (target?.canvas && !keepPixels && !(this.#blankCanvases.has(target.canvas)
      && target.canvas.dataset["portraitReady"] === "false")) {
      this.#clearCanvas(target.canvas, pendingStockPicture(slot, target.guid));
    }
    if (surface && (surface.root !== undefined || surface.sourceGuid !== undefined
      || !surface.dirty || surface.output !== target?.canvas)) {
      surface.output = target?.canvas;
      surface.dirty = true;
      // Retaining the 2D snapshot does not retain a model, material, atlas or live skeleton.
      this.#disposeModel(surface);
    }
  }

  /** `pending`: blank to the black disc of `pendingStockPicture` rather than to transparent. */
  #clearCanvas(canvas: HTMLCanvasElement | undefined, pending = false): void {
    if (!canvas) return;
    const context = canvas.getContext("2d");
    context?.clearRect(0, 0, canvas.width, canvas.height);
    if (pending && context && canvas.width > 0 && canvas.height > 0) {
      // Colour 0 is the picture's black ground; the alpha is the same circle a readback gets.
      const mask = portraitCircleMask(canvas.width, canvas.height);
      const image = context.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < mask.length; index++) image.data[index * 4 + 3] = mask[index]!;
      context.putImageData(image, 0, 0);
    }
    canvas.dataset["portraitReady"] = "false";
    this.#blankCanvases.add(canvas);
    this.#paintedGuids.delete(canvas);
  }
}
