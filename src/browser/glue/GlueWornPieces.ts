/**
 * 15.11 (6.18, 6.14): what a figure drawn outside the world carries — the worn models (helm,
 * pauldrons, what is in the hands or stowed), the closed hand round a held item, the enchant glows on
 * a weapon and the effect models a spell kit hangs on the figure itself — for the three places that
 * draw a character apart from the world renderer: the character-select and creation figure
 * (GlueCharacterScene.ts), the PlayerModel and DressUpModel windows (GlueModelStage.ts) and the lab.
 *
 * Every rule is the one the world renderer follows (`WorldRenderer3D.#updateAttachments`), through the
 * same helpers, because Wow.exe draws these figures with the same calls:
 *
 * - An item model hangs on its point's bone at the point's offset (`Attachment.boneOf`,
 *   `attachmentOffset`), a hip-stowed blade turned down the leg (`attachmentRotation`). Which point is
 *   the caller's: each screen has its own rule (CharSelectWorn.ts, FrameXmlUnitModelLive.ts).
 * - An item on point 1 closes the right hand and one on point 2 the left: 0x004eaa70 → 0x004e7700
 *   (`HandsClosed.ts`); the duplicated model of a window does the same over its points (0x005975e0).
 *   HandsClosed travels in the animation sidecar, fetched once per model path.
 * - ItemVisuals slot i hangs its effect model on the item model's attachment i, and only there
 *   (0x004eaa70 → 0x004ea8f0 → 0x00831630; `WeaponGlow.glowPlacement`). An effect model's mesh and rig
 *   are built as the world builds a glow body (`WeaponGlowBody.ts`), its emitters follow its bones.
 * - A spell kit's effect on the figure (the ghost's `Ghost_state` on Base, 0x004e2ce0 → 0x004e2c30)
 *   hangs on the figure's own attachment, scaled by SpellVisualEffectName's scale, only when the figure
 *   has that attachment (0x004e2c30 asks 0x008273d0 first).
 *
 * The emitters are drawn in scene space, so they live in `overlay`, which the owner adds to the scene
 * beside the figure. `pose` runs after the figure's mixer and before its matrices are taken; `animate`
 * after them.
 */
import * as THREE from "three";
import type { AttachedModel } from "../../gateway/CharacterAppearance.js";
import {
  addSkinnedClips, applyGlobalSequenceBones, buildSkinnedTemplateFrom,
  type SkinnedInstance, type SkinnedTemplate,
} from "../AnimatedModel.js";
import { attachmentOffset, attachmentRotation, boneOf } from "../Attachment.js";
import { HANDS_CLOSED_ANIMATION, closedHandsFor, handOfPoint } from "../HandsClosed.js";
import { EVERY_GEOSET, buildModel, type BuiltModel } from "../ModelBuild.js";
import { billboardView, buildModelEffects, disposeModelEffects, updateModelEffects, type ModelEffects } from "../ParticleRender.js";
import type { BillboardView } from "../Particles.js";
import { glowPlacement } from "../WeaponGlow.js";
import { disposeGlowBody, glowHasMesh, glowRigOnly, makeGlowBody, poseGlowBodies, type GlowBody } from "../WeaponGlowBody.js";
import {
  TEXTURE_TYPE_OBJECT_SKIN, decodeWvaAnimations, visualAnimationsUrl, type WvmModel, type WvmSkeletonClip,
} from "../Wvm.js";

/** One worn item and the point the screen's rule hangs it on; `glow` is its ItemVisuals slots, if any. */
export interface GlueWornPiece {
  readonly item: AttachedModel;
  readonly point: number;
  readonly glow?: readonly (string | null)[] | undefined;
}

/** A spell kit's effect model on the figure's own attachment (SpellVisualKit → SpellVisualEffectName). */
export interface GlueFigureEffect {
  readonly path: string;
  readonly point: number;
  readonly scale: number;
}

export interface GlueWornPiecesHost {
  readonly baseUrl: string;
  /** The decoded model at an MPQ path; the host caches. */
  model(path: string): Promise<WvmModel>;
  loadTexture(url: string): THREE.Texture;
  /** Every material of a hung item or an effect body, once, after it is built (light clamp, coverage, a look). */
  prepare?: ((material: THREE.Material) => void) | undefined;
  /** Every emitter material, once (a glue canvas drops additive coverage). */
  prepareEmitter?: ((material: THREE.Material) => void) | undefined;
  /** The animation sidecar's bytes; the page's fetch when absent. */
  animations?: ((url: string) => Promise<ArrayBuffer>) | undefined;
  /** The HandsClosed clip already built, in place of the sidecar fetch and decode (tests). */
  handsClosedClip?: ((modelPath: string) => Promise<THREE.AnimationClip | undefined>) | undefined;
  onError?: ((message: string) => void) | undefined;
}

/** An effect model's place: under an item mesh at its attachment, or under a figure bone. */
interface EffectAnchor {
  readonly path: string;
  readonly anchor: THREE.Object3D;
  wvm: WvmModel | undefined;
  body?: GlowBody | null | undefined;
  /** The build a mesh body borrows, freed with the pieces. */
  built?: BuiltModel | undefined;
  effects?: ModelEffects | undefined;
}

interface HeldPiece {
  readonly mesh: THREE.Object3D;
  readonly itemModel: WvmModel;
  readonly item: AttachedModel | undefined;
  glowed: boolean;
}

/** The hands a set of hang points closes (0x004eaa70: points 1 and 2 only). */
export function glueHandsMask(points: Iterable<number>): number {
  let mask = 0;
  for (const point of points) mask |= handOfPoint(point);
  return mask;
}

/** HandsClosed out of each model's sidecar, decoded once per path (the clip alone is kept). */
const handsClips = new Map<string, Promise<readonly WvmSkeletonClip[]>>();

export class GlueWornPieces {
  /** The emitters, in scene space: the owner adds this to the scene the figure is in. */
  readonly overlay = new THREE.Group();
  readonly #wvm: WvmModel;
  readonly #modelPath: string;
  readonly #instance: SkinnedInstance;
  readonly #template: SkinnedTemplate;
  readonly #host: GlueWornPiecesHost;
  readonly #meshes: THREE.Mesh[] = [];
  readonly #builds: BuiltModel[] = [];
  readonly #anchors: EffectAnchor[] = [];
  readonly #points: number[] = [];
  /** 15.11 follow-up: the hung pieces, for glows handed over after they hang (`glowWith`). */
  readonly #held: HeldPiece[] = [];
  #glowLookup: ((item: AttachedModel) => readonly (string | null)[] | undefined) | undefined;
  readonly #billboard: BillboardView = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
  readonly #matrix = new THREE.Matrix4();
  #handsAsked = false;
  #disposed = false;

  constructor(wvm: WvmModel, modelPath: string, instance: SkinnedInstance, template: SkinnedTemplate, host: GlueWornPiecesHost) {
    this.#wvm = wvm;
    this.#modelPath = modelPath;
    this.#instance = instance;
    this.#template = template;
    this.#host = host;
    this.overlay.name = "glue-worn-effects";
  }

  /** The points items now hang on, in hang order (tests, the lab panel). */
  get points(): readonly number[] { return this.#points; }
  /** The hung item meshes (tests; a look applied after the fact). */
  get meshes(): readonly THREE.Mesh[] { return this.#meshes; }
  /** How many effect anchors (glow slots placed, kit effects) there are. */
  get effectAnchors(): number { return this.#anchors.length; }
  /** The hand mask the hung items close. */
  get handsMask(): number { return glueHandsMask(this.#points); }

  /**
   * Hangs the items, then the effects, each as its model arrives. A piece whose point the figure lacks,
   * or whose model fails, is skipped (the world skips it too); `isCurrent` false stops the walk.
   */
  async hang(pieces: readonly GlueWornPiece[], effects: readonly GlueFigureEffect[] = [], isCurrent: () => boolean = () => true): Promise<void> {
    const live = (): boolean => !this.#disposed && isCurrent();
    for (const piece of pieces) {
      const bone = boneOf(this.#wvm, this.#instance, piece.point);
      if (!bone) continue;
      let itemModel: WvmModel;
      try {
        itemModel = await this.#host.model(piece.item.model);
      } catch (error) {
        if (live()) this.#host.onError?.(`${piece.item.model}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!live()) return;
      const built = buildModel(itemModel, {
        modelPath: piece.item.model,
        // An item model almost never names its own diffuse texture: it declares the type 2 slot and
        // the wearer's ItemDisplayInfo fills it.
        slots: new Map(piece.item.texture ? [[TEXTURE_TYPE_OBJECT_SKIN, piece.item.texture]] : []),
        geosets: EVERY_GEOSET,
        baseUrl: this.#host.baseUrl,
        loadTexture: (url) => this.#host.loadTexture(url),
        skinned: false,
      });
      for (const material of built.materials) this.#host.prepare?.(material);
      const mesh = new THREE.Mesh(built.geometry, built.materials);
      mesh.frustumCulled = false;
      mesh.userData["point"] = piece.point;
      mesh.position.copy(attachmentOffset(this.#wvm, this.#template.pivots, piece.point));
      const hang = attachmentRotation(piece.point);
      if (hang) mesh.quaternion.copy(hang);
      bone.add(mesh);
      this.#meshes.push(mesh);
      this.#builds.push(built);
      this.#hold(mesh, itemModel, piece.point, piece.item, piece.glow);
    }
    for (const effect of effects) {
      // 0x004e2c30: the effect is hung only when the figure carries the point (0x008273d0).
      const bone = boneOf(this.#wvm, this.#instance, effect.point);
      if (!bone) continue;
      const anchor = new THREE.Object3D();
      anchor.name = `kit:${effect.point}`;
      anchor.position.copy(attachmentOffset(this.#wvm, this.#template.pivots, effect.point));
      if (effect.scale > 0 && effect.scale !== 1) anchor.scale.setScalar(effect.scale);
      bone.add(anchor);
      this.#anchors.push({ path: effect.path, anchor, wvm: undefined });
    }
    await this.settle(isCurrent);
  }

  /**
   * A piece the owner built and hung on its bone itself (the lab, which counts its triangles): its
   * hand and its glows are kept here all the same. `settle` then loads the glows.
   */
  adopt(mesh: THREE.Object3D, itemModel: WvmModel, point: number, item?: AttachedModel, glow?: readonly (string | null)[]): void {
    if (this.#disposed) return;
    this.#hold(mesh, itemModel, point, item, glow);
  }

  /**
   * 15.11 follow-up: the glows, once their tables are here. A piece never waits for them — it hangs as soon
   * as its own model has arrived — so the tables are handed over afterwards: every piece hung so far, and
   * every one hung later, gets the slots `lookup` names for its item (once). `settle` loads their models.
   */
  glowWith(lookup: (item: AttachedModel) => readonly (string | null)[] | undefined): void {
    if (this.#disposed) return;
    this.#glowLookup = lookup;
    for (const held of this.#held) this.#glowHeld(held);
  }

  /** A hung piece: its hand starts the HandsClosed request at once (never waited on), its glow when known. */
  #hold(mesh: THREE.Object3D, itemModel: WvmModel, point: number, item: AttachedModel | undefined,
    glow: readonly (string | null)[] | undefined): void {
    this.#points.push(point);
    const held: HeldPiece = { mesh, itemModel, item, glowed: false };
    this.#held.push(held);
    if (glow) {
      held.glowed = true;
      this.#glowAnchors(mesh, itemModel, glow);
    } else {
      this.#glowHeld(held);
    }
    if (handOfPoint(point) !== 0) void this.#askHands();
  }

  #glowHeld(held: HeldPiece): void {
    if (held.glowed || !held.item || !this.#glowLookup) return;
    held.glowed = true;
    const slots = this.#glowLookup(held.item);
    if (slots) this.#glowAnchors(held.mesh, held.itemModel, slots);
  }

  /** Asks for HandsClosed when a hand holds something and loads every effect model not yet loaded. */
  async settle(isCurrent: () => boolean = () => true): Promise<void> {
    const live = (): boolean => !this.#disposed && isCurrent();
    if (this.handsMask !== 0) void this.#askHands();
    for (const anchor of this.#anchors) {
      if (anchor.wvm) continue;
      try {
        anchor.wvm = await this.#host.model(anchor.path);
      } catch (error) {
        if (live()) this.#host.onError?.(`${anchor.path}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!live()) return;
      this.#mountEffect(anchor, anchor.wvm);
    }
  }

  /** ItemVisuals slot i on the item model's attachment i (`glowPlacement`), as anchors under its mesh. */
  #glowAnchors(mesh: THREE.Object3D, itemModel: WvmModel, glow: readonly (string | null)[]): void {
    for (const placement of glowPlacement(itemModel.attachments.map((attachment) => attachment.id), glow)) {
      const attachment = itemModel.attachments.find((candidate) => candidate.id === placement.attachment);
      if (!attachment) continue;
      const anchor = new THREE.Object3D();
      anchor.name = `glow:${placement.slot}`;
      anchor.position.set(attachment.position[0], attachment.position[1], attachment.position[2]);
      mesh.add(anchor);
      this.#anchors.push({ path: placement.path, anchor, wvm: undefined });
    }
  }

  /** The effect model's body (mesh or rig) under its anchor and its emitters in the overlay. */
  #mountEffect(anchor: EffectAnchor, wvm: WvmModel): void {
    let body: GlowBody | null;
    if (glowHasMesh(wvm)) {
      const built = buildModel(wvm, {
        modelPath: anchor.path, slots: new Map(), geosets: EVERY_GEOSET, baseUrl: this.#host.baseUrl,
        loadTexture: (url) => this.#host.loadTexture(url), skinned: Boolean(wvm.skeleton),
      });
      for (const material of built.materials) this.#host.prepare?.(material);
      const template = wvm.skeleton ? buildSkinnedTemplateFrom(built.geometry, wvm.skeleton, built.height) : undefined;
      body = makeGlowBody(built, template);
      anchor.built = built;
    } else {
      body = glowRigOnly(wvm);
    }
    anchor.body = body;
    if (body) anchor.anchor.add(body.object);
    if (wvm.particleEmitters.length + wvm.ribbonEmitters.length === 0) return;
    const effects = buildModelEffects(wvm, {
      baseUrl: this.#host.baseUrl,
      loadTexture: (url) => this.#host.loadTexture(url),
      disposeTextures: false,
      seed: 1 + ((anchor.path.length * 31 + this.#anchors.indexOf(anchor)) % 977),
    });
    if (!effects) return;
    for (const emitter of effects.emitters) this.#host.prepareEmitter?.(emitter.material);
    anchor.effects = effects;
    this.overlay.add(effects.group);
  }

  /** HandsClosed for this rig, out of the model's sidecar, once per path. */
  async #askHands(): Promise<void> {
    if (this.#handsAsked || this.#template.clips.has(HANDS_CLOSED_ANIMATION)) return;
    this.#handsAsked = true;
    const built = this.#host.handsClosedClip;
    if (built) {
      try {
        const clip = await built(this.#modelPath);
        if (clip && !this.#disposed) this.#template.clips.set(HANDS_CLOSED_ANIMATION, clip);
      } catch (error) {
        if (!this.#disposed) this.#host.onError?.(`HandsClosed ${this.#modelPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const bones = this.#template.parents.length;
    const key = `${this.#modelPath}|${bones}`;
    let pending = handsClips.get(key);
    if (!pending) {
      const url = visualAnimationsUrl(this.#host.baseUrl, this.#modelPath);
      const read = this.#host.animations ?? (async (target: string) => {
        const response = await fetch(target);
        if (!response.ok) throw new Error(`шлюз ответил ${response.status}`);
        return await response.arrayBuffer();
      });
      pending = read(url).then((data) => decodeWvaAnimations(data, bones)
        .filter((clip) => clip.animationId === HANDS_CLOSED_ANIMATION));
      handsClips.set(key, pending);
      pending.catch(() => handsClips.delete(key));
    }
    try {
      const clips = await pending;
      if (!this.#disposed && clips.length > 0) addSkinnedClips(this.#template, clips);
    } catch (error) {
      if (!this.#disposed) this.#host.onError?.(`HandsClosed ${this.#modelPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * After the figure's mixer, before its matrices: the global loops and the closed hands over the clip
   * (the fingers keep their own sequence, 0x00832ab0 on key bones 8–12 / 13–17).
   */
  pose(nowMs: number): void {
    if (this.#disposed) return;
    const hands = closedHandsFor(this.#template, this.#wvm.keyBones, this.handsMask);
    applyGlobalSequenceBones(this.#instance, hands?.source ?? this.#template, this.#wvm.globalSequences, nowMs);
  }

  /** After the figure's matrices: the effect bodies on their own clocks, then their emitters. */
  animate(seconds: number, nowMs: number, camera: THREE.Camera): void {
    if (this.#disposed || this.#anchors.length === 0) return;
    poseGlowBodies(this.#anchors, seconds, nowMs, camera);
    billboardView(camera, this.#billboard);
    for (const anchor of this.#anchors) {
      anchor.anchor.updateMatrixWorld(true);
      const effects = anchor.effects;
      if (!effects) continue;
      const rig = anchor.body?.skinned;
      const inverses = anchor.body?.template?.boneInverses;
      const fallback = anchor.anchor.matrixWorld;
      updateModelEffects(effects, seconds, {
        matrixFor: (bone) => {
          const target = rig?.skeleton.bones[bone];
          const inverse = inverses?.[bone];
          if (!target || !inverse) return fallback.elements;
          return this.#matrix.multiplyMatrices(target.matrixWorld, inverse).elements;
        },
        animationMs: (anchor.body?.action?.time ?? 0) * 1000,
        worldMs: nowMs,
      }, this.#billboard);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const anchor of this.#anchors) {
      disposeGlowBody(anchor);
      anchor.anchor.removeFromParent();
      if (anchor.effects) disposeModelEffects(anchor.effects);
      if (anchor.built) disposeBuilt(anchor.built);
    }
    this.#anchors.length = 0;
    this.#held.length = 0;
    for (const mesh of this.#meshes) mesh.removeFromParent();
    for (const built of this.#builds) disposeBuilt(built);
    this.#meshes.length = 0;
    this.#builds.length = 0;
    this.overlay.removeFromParent();
    this.overlay.clear();
  }
}

function disposeBuilt(built: BuiltModel): void {
  built.geometry.dispose();
  for (const material of built.materials) material.dispose();
  for (const texture of built.ownedTextures) texture.dispose();
}
