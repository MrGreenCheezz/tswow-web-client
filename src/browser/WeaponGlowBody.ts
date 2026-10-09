// 05.10-A7a-E2 (6.14): the effect models' own geometry on the glow anchors, beside their emitters.
//
// Slice E hung the ItemVisuals slots' effect models on the weapon's attachments 0…4 and drew only
// their emitters. Census of 05.10 over the ItemVisualEffects models the dataset's ItemVisuals rows
// name (scratch probe-refs/probe-effects): 17 carry a mesh — Sparkle_A and Rune_Intellect have
// nothing else, the other 15 (SkullBalls, Shaman_Rock, ExecutionerGlow_High, the
// Lightning/Holy/Ice/Summon/Vengeance hand effects, FaerieFire, ConjureItem…) have emitters as well —
// and every one of the 17 is boned and animated (a Stand clip, global loops on some) and uses only
// its own textures (type 0). ItemVisual 28 (sharpening stones, weightstones; enchants 13, 14, 40,
// 2506; 18 displays) is Sparkle_A alone in slot 4: without this file it drew nothing.
//
// A body is the model built like any other unit-side piece (`#buildRigged`, shared geometry and
// materials keyed `glow|<path>`, so every copy of one effect is one set of GPU buffers and its
// colour/alpha/texture-transform tracks run on the wall clock with the other builds) and, when the
// file is rigged, a skinned instance of the shared template with its own mixer playing Stand on a
// loop. The instance's root is reset to identity: the anchor is already in the weapon's M2 space,
// and `instantiateSkinned`'s M2→scene turn is for a root that hangs in the scene.
//
// The emitters of a body-bearing model ride the same rig (`glowEmitterEntries` hands it out), so
// they follow the animated bones; emitter-only glows (the colour glows, 72 of the 89 models) get no
// body and stay at the anchor's frame as slice E left them.

import * as THREE from "three";
import {
  applyBillboardBones, applyGlobalSequenceBones, disposeSkinnedInstance, instantiateSkinned,
  type SkinnedInstance, type SkinnedTemplate,
} from "./AnimatedModel.js";
import type { WvmModel } from "./Wvm.js";

/** What a body is built from: the shared build's geometry and materials (`BuiltModel`). */
export interface GlowBuild {
  readonly geometry: THREE.BufferGeometry;
  readonly materials: THREE.Material[];
}

/** One effect model's drawn geometry, hung under its anchor. */
export interface GlowBody {
  /** The mesh, or the skinned instance's root; a child of the anchor. */
  readonly object: THREE.Object3D;
  /** The cache entry it borrows, pinned while it is worn. */
  built: object;
  /** The rig, when the file has one that plays; the same three fields a unit's pose has (`PosedModel`). */
  skinned: SkinnedInstance | undefined;
  template: SkinnedTemplate | undefined;
  /** Stand, once the clip is there. */
  action: THREE.AnimationAction | undefined;
}

/** The part of a glow anchor this file reads and writes (WeaponGlow.ts `GlowAnchor`). */
export interface BodyAnchor {
  readonly path: string;
  readonly anchor: THREE.Object3D;
  wvm: WvmModel | undefined;
  /** undefined: not settled yet; null: the model has nothing to draw. */
  body?: GlowBody | null | undefined;
}

/** undefined: try again next frame (budget, still loading); null: nothing to draw. */
export type GlowBodyBuilder = (path: string, wvm: WvmModel) => GlowBody | null | undefined;

/** Stand: an effect model's one sequence (all 17 bodies carry exactly it). */
const STAND = 0;

/** Whether the effect model draws any geometry of its own. */
export function glowHasMesh(wvm: Pick<WvmModel, "indices" | "batches">): boolean {
  return wvm.indices.length > 0 && wvm.batches.length > 0;
}

/** A body from a build: a skinned instance of `template` when given, a plain mesh otherwise. */
export function makeGlowBody(built: GlowBuild, template: SkinnedTemplate | undefined): GlowBody {
  if (template) {
    const skinned = instantiateSkinned(template, built.materials);
    skinned.root.quaternion.identity();
    return { object: skinned.root, built, skinned, template, action: undefined };
  }
  const mesh = new THREE.Mesh(built.geometry, built.materials);
  mesh.frustumCulled = true;
  return { object: mesh, built, skinned: undefined, template: undefined, action: undefined };
}

/** Builds the bodies of anchors whose model has landed; returns how many were hung this call. */
export function mountGlowBodies(anchors: readonly BodyAnchor[] | undefined, build: GlowBodyBuilder): number {
  if (!anchors) return 0;
  let mounted = 0;
  for (const anchor of anchors) {
    if (anchor.body !== undefined || !anchor.wvm) continue;
    const body = build(anchor.path, anchor.wvm);
    if (body === undefined) continue;
    anchor.body = body;
    if (!body) continue;
    anchor.anchor.add(body.object);
    mounted++;
  }
  return mounted;
}

/**
 * Advances every rigged body: Stand on a loop by the frame's elapsed seconds, the global loops on
 * the world clock, billboard bones against the camera. Allocation-free once Stand is playing.
 */
export function poseGlowBodies(
  anchors: readonly BodyAnchor[] | undefined, elapsedSeconds: number, worldMs: number, camera: THREE.Object3D,
): void {
  if (!anchors) return;
  for (const anchor of anchors) {
    const body = anchor.body;
    const skinned = body?.skinned;
    const template = body?.template;
    if (!body || !skinned || !template) continue;
    if (!body.action) {
      const clip = template.clips.get(STAND) ?? template.clips.values().next().value;
      if (clip) {
        const action = skinned.mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
        body.action = action;
      }
    }
    skinned.mixer.update(elapsedSeconds);
    if (anchor.wvm) applyGlobalSequenceBones(skinned, template, anchor.wvm.globalSequences, worldMs);
    applyBillboardBones(skinned, template, camera);
  }
}

/** Every worn body's build into the renderer's eviction pins. */
export function pinGlowBuilds(anchors: readonly BodyAnchor[] | undefined, pins: { add(built: never): unknown }): void {
  if (!anchors) return;
  for (const anchor of anchors) if (anchor.body) pins.add(anchor.body.built as never);
}

/** Takes a body off its anchor and lets go of its rig; the shared build stays cached. */
export function disposeGlowBody(anchor: BodyAnchor): void {
  const body = anchor.body;
  anchor.body = undefined;
  if (!body) return;
  body.object.removeFromParent();
  disposeSkinnedInstance(body.skinned);
}

// 05.10: ревью E2 — a glow goes with the unit it is worn by. The bodies are meshes the unit's fade has to reach
// (`#unitOpacityMeshes`: the borrowed faded copies, the warm pass's fade twins), exactly like the blade they sit
// on; the emitters live in the renderer's world-level effect group, so they are faded and hidden here instead.

/** The mesh that wears a body's materials: the rig's skinned mesh, or the static mesh itself. */
export function* glowBodyMeshes(anchors: readonly BodyAnchor[] | undefined): Generator<THREE.Mesh> {
  if (!anchors) return;
  for (const anchor of anchors) {
    const body = anchor.body;
    if (!body) continue;
    const mesh = body.skinned?.mesh ?? body.object;
    if (mesh instanceof THREE.Mesh) yield mesh;
  }
}

/** Whether `node` and every node above it is shown: a blade turned away, held back or ridden in first person is not. */
export function glowShown(node: THREE.Object3D): boolean {
  for (let at: THREE.Object3D | null = node; at; at = at.parent) if (!at.visible) return false;
  return true;
}

/**
 * Fades one weapon's emitters by the unit's opacity; their materials are this instance's own and start white and
 * opaque (ParticleRender `buildModelEffects`), so the value is set, never compounded. The blend decides how, as
 * for the unit's own batches (ModelBuild `fadeMaterial`): a source factor of One ignores alpha and the colour
 * carries the fade; a modulate blend has nothing to fade toward and is left as it is. Uniforms only, per frame.
 */
export function fadeGlowEmitters(effects: { readonly emitters: readonly { readonly material: THREE.Material }[] }, factor: number): void {
  const clamped = Math.max(0, Math.min(1, factor));
  for (const emitter of effects.emitters) {
    const material = emitter.material as THREE.Material & { color?: THREE.Color };
    const custom = material.blending === THREE.CustomBlending;
    if (custom && material.blendSrc === THREE.DstColorFactor) continue;
    material.opacity = clamped;
    material.color?.setScalar(custom && material.blendSrc === THREE.OneFactor ? clamped : 1);
  }
}
