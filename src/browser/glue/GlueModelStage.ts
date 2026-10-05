import * as THREE from "three";
import {
  M2_TO_SCENE, addSkinnedClips, applyBillboardBones, buildSkinnedTemplateFrom,
  disposeSkinnedInstance, instantiateSkinned, resolveAnimation,
  type SkinnedInstance, type SkinnedTemplate,
} from "../AnimatedModel.js";
import {
  EVERY_GEOSET, buildModel, characterSlots, updateBatchAppearance, type BuiltModel, // 05.10-A7a-G 6.18: geosetList → figureGeosets
} from "../ModelBuild.js";
import { figureGeosets } from "../FigureGeosets.js"; // 05.10-A7a-G 6.18
import {
  billboardView, buildModelEffects, disposeModelEffects, updateModelEffects, type ModelEffects,
} from "../ParticleRender.js";
import { portraitCameraSpec } from "../PortraitCamera.js";
import { ModelTextureLoader } from "../TextureLoad.js";
import { CharacterAtlasClient, appearanceKey, type CharacterAppearance } from "../CharacterAtlas.js";
import {
  decodeWvaAnimations, decodeWvm9, isWvm9, visualAnimationsUrl, visualModelUrl,
  TEXTURE_TYPE_BODY, type WvmModel, type WvmSkeletonClip,
} from "../Wvm.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

/**
 * The 3D behind a `<Model>`/`<ModelFFX>` widget.
 *
 * G2 left these as positioned boxes carrying the recorded state; this is the thing that draws in
 * them. Every piece of it is the shipping renderer's: `Wvm` decodes, `ModelBuild` builds,
 * `AnimatedModel` rigs and plays, `ParticleRender` emits, `PortraitCamera` reads the authored
 * camera. Nothing here is a second implementation of any of that — a glue model that draws wrong
 * here draws wrong in the world.
 *
 * **One GL context, many boxes.** The owner's login screen alone declares thirty Model widgets and
 * the corpus declares eighty-five; a `WebGLRenderer` per widget would exhaust the browser's
 * context limit (Chrome drops the oldest past sixteen) before the screen finished loading. So one
 * renderer draws into one offscreen canvas and each widget owns a plain 2D canvas that the frame
 * is blitted into. That keeps every view inside its own widget box, which is what makes DOM
 * z-order — a model in front of the logo, a dialog in front of the model — come out right without
 * the stage knowing anything about strata.
 *
 * **The resolution is measured, not budgeted.** A view renders into a target sized by its class and
 * is stretched to the box by CSS. The login scene's models are each the size of the whole screen,
 * and thirty-two of those at full resolution is more pixels per frame than the rest of the client
 * puts together, so *something* has to give — but which thing gives is decided by the last second of
 * frame times rather than by a constant somebody guessed. The fixed budgets are gone; see
 * `GLUE_QUALITY_STEPS` for the ladder and `GlueQualityController` for the thing that walks it.
 */

/**
 * Longest edge of a **subject** view's render target, in device pixels.
 *
 * A ceiling rather than a target: a subject renders at its own box times the display's device pixel
 * ratio and stops here. 2,048 is a 1440p widget at DPR 1 or a 1024-wide one at DPR 2, and it is the
 * size above which a single glue view starts to cost more than the whole rest of the pass.
 */
const MAX_SUBJECT_EDGE = 2048;

/**
 * Total canvas pixels the subject class may **hold**, shared out between them.
 *
 * A memory rail and not a time budget — the ladder is what answers time — because the two costs are
 * paid at different moments. Every view keeps a 2D canvas of its own at its render size, and the
 * login screen has thirty-two of them: measured live at 1920x969, the ladder happily walked up to
 * native and allocated **59.5 M pixels**, which is 238 MB of RGBA sitting in the compositor whether
 * or not the pass is cheap that second. Sixteen million is 64 MB, it leaves one full-stage subject
 * its whole 1920x969 outright, and it still gives each of thirty-two of them 1000x505 — twice the
 * linear resolution the flat 512 cap used to allow.
 */
const GLUE_SUBJECT_CANVAS_PIXELS = 16_000_000;

/**
 * How much of the stage a view has to cover before it is a **subject** rather than a prop.
 *
 * The rig test alone was the wrong question and the owner's screenshot is the proof: what dominates
 * the login frame is not the two figures but the plates behind them — the sky dome, nine cloud
 * cards, six fog cards and two radiation-fog balls — and every one of those is a full-screen widget.
 * Measured in the live page at 961x922: all thirty-two of `lgzg.lua`'s models are declared
 * `SetSize(LoginScene:GetWidth() / 1, LoginScene:GetHeight() / 1)`, so every box is the whole stage
 * (1639x922, 100 % coverage) and thirteen of them happened to carry bones. Rendering the other
 * nineteen at 512 and stretching them across 1,639 CSS pixels is a 3.2x upscale of the thing the
 * frame is mostly made of, which is the blur the owner calls low quality.
 *
 * Fifteen per cent is a sixth of the frame: below it a widget is a prop — an inset portrait, a spell
 * icon, one of the `UI-AutoCastButton` models the stock screens dot around — and the cheap class is
 * where it belongs. Nothing on this corpus lands between the two: the glue widgets are either the
 * whole stage or a button.
 */
export const GLUE_SUBJECT_COVERAGE = 0.15;

/**
 * How much of the viewport a widget box actually shows, as a fraction of the viewport.
 *
 * The intersection and not the box, because `lgzg.lua`'s stage is *wider* than the window — measured
 * live, a login model's box is 1639x922 at x = −339 in a 961x922 viewport — and a widget that hangs
 * off both edges only ever draws the part that is on screen.
 */
export function glueViewCoverage(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): number {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(vw, box.x + box.width);
  const bottom = Math.min(vh, box.y + box.height);
  if (right <= left || bottom <= top) return 0;
  return ((right - left) * (bottom - top)) / (vw * vh);
}

/**
 * Which of the two budgets a view is on.
 *
 * Measured, not guessed, and now by three tests rather than two:
 *
 * - a `ModelFFX` widget **is** the screen (`CharacterSelect` and `CharacterCreate` both declare
 *   `<ModelFFX>` as the screen frame itself, so `UI_Human` is drawn edge to edge — measured at
 *   99.95 % of the widget),
 * - a model that carries a skeleton is somebody rather than something, and
 * - a model that covers more than {@link GLUE_SUBJECT_COVERAGE} of the viewport **is** the picture,
 *   whatever it is made of. A sky dome has no bones and still fills the frame.
 *
 * Everything else is a prop and stays cheap.
 */
export function glueViewIsSubject(frameType: string, skinned: boolean, coverage = 0): boolean {
  return frameType === "ModelFFX" || skinned || coverage > GLUE_SUBJECT_COVERAGE;
}

/**
 * One rung of the quality ladder the stage climbs down under load and back up when it can.
 *
 * Three knobs, in the order the owner would give them up: how often a prop redraws, how big a prop's
 * render target is, and only then how many pixels the things he is actually looking at get.
 */
export interface GlueQualityStep {
  /** Named so the diagnostic line says which rung, not which index. */
  readonly name: string;
  /** Model passes between two redraws of a prop view; 1 is every pass. */
  readonly sceneryTick: number;
  /** Longest edge of a prop view's render target, in device pixels. */
  readonly sceneryEdge: number;
  /**
   * Ceiling on the device-pixel ratio a subject renders at.
   *
   * Above 1 it is a *cap* on a hidpi display and does nothing on a DPR 1 one; below 1 it is a real
   * reduction, and the rungs below 1 are the ones that bite on this corpus, because thirty-two
   * full-stage subjects at native is 48 M pixels a pass and no machine draws that at 30 Hz.
   */
  readonly subjectRatioCap: number;
}

/**
 * The ladder itself: highest quality first, and every rung a step the owner could name.
 *
 * The order is the brief's — props give up frame rate, then resolution, and the subject class is
 * touched last. The rungs below `subjectRatioCap: 1` are not in the brief and are here because the
 * measurement forces them: with coverage deciding the class, `lgzg.lua`'s login screen has
 * **thirty-two** subjects and not two, so a ladder that stops at native cannot reach a frame this
 * machine can draw. Measured on this machine at 961x922 — see the slice journal for the table the
 * controller actually settled on.
 */
export const GLUE_QUALITY_STEPS: readonly GlueQualityStep[] = [
  { name: "native", sceneryTick: 1, sceneryEdge: 512, subjectRatioCap: 2 },
  { name: "plates-15hz", sceneryTick: 2, sceneryEdge: 512, subjectRatioCap: 2 },
  { name: "plates-10hz", sceneryTick: 3, sceneryEdge: 512, subjectRatioCap: 2 },
  { name: "plates-7.5hz", sceneryTick: 4, sceneryEdge: 512, subjectRatioCap: 2 },
  { name: "props-384", sceneryTick: 4, sceneryEdge: 384, subjectRatioCap: 2 },
  { name: "props-256", sceneryTick: 4, sceneryEdge: 256, subjectRatioCap: 2 },
  { name: "subject-1.5x", sceneryTick: 4, sceneryEdge: 256, subjectRatioCap: 1.5 },
  { name: "subject-1x", sceneryTick: 4, sceneryEdge: 256, subjectRatioCap: 1 },
  { name: "subject-0.75x", sceneryTick: 4, sceneryEdge: 256, subjectRatioCap: 0.75 },
  { name: "subject-0.5x", sceneryTick: 4, sceneryEdge: 256, subjectRatioCap: 0.5 },
  { name: "subject-0.35x", sceneryTick: 4, sceneryEdge: 256, subjectRatioCap: 0.35 },
  { name: "subject-0.25x", sceneryTick: 4, sceneryEdge: 256, subjectRatioCap: 0.25 },
];

/**
 * The render target one view gets this pass, in device pixels.
 *
 * `dpr` is the display's device pixel ratio: a widget box is in CSS units and the stage is scaled by
 * a transform, so the pixels the compositor actually shows are the box times the ratio. Rendering
 * below that is the blur; rendering above it is waste. The two ladder numbers arrive per call rather
 * than as constants, because which rung the stage is on is a fact about the last second of frames
 * and not about the code.
 */
export function glueViewResolution(
  boxWidth: number,
  boxHeight: number,
  options: {
    readonly subject: boolean;
    readonly dpr: number;
    readonly sceneryEdge?: number;
    readonly subjectRatioCap?: number;
    /** How many subjects share {@link GLUE_SUBJECT_CANVAS_PIXELS}; one when not given. */
    readonly subjects?: number;
  },
): { readonly width: number; readonly height: number } {
  const width = Math.max(1, boxWidth);
  const height = Math.max(1, boxHeight);
  const box = Math.max(width, height);
  const ratio = Number.isFinite(options.dpr) && options.dpr > 0 ? options.dpr : 1;
  const cap = options.subjectRatioCap ?? GLUE_QUALITY_STEPS[0]!.subjectRatioCap;
  const edge = options.sceneryEdge ?? GLUE_QUALITY_STEPS[0]!.sceneryEdge;
  const share = GLUE_SUBJECT_CANVAS_PIXELS / Math.max(1, options.subjects ?? 1);
  const scale = options.subject
    ? Math.min(ratio, cap, MAX_SUBJECT_EDGE / box, Math.sqrt(share / (width * height)))
    : Math.min(1, edge / box);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The part of a live view that can make one quality rung do different work from another. */
export interface GlueQualityWorkView {
  readonly boxWidth: number;
  readonly boxHeight: number;
  readonly subject: boolean;
  readonly moving: boolean;
  readonly somebody: boolean;
}

/**
 * Whether two quality rungs change work for any of the views on this stage.
 *
 * Login's two skinned character views make the first seven lower rungs a no-op at DPR 1: the
 * scenery tick/edge knobs do not apply to a `somebody`, and every subject cap down to 1 still
 * resolves to the same native 1280x720 target. The chooser must not report those labels as quality
 * changes, because doing so turns one cold renderer pass into a rung cycle without changing a
 * single pixel. A moving non-subject is the one case where `sceneryTick` changes actual cadence.
 */
export function glueQualityStepChangesWork(
  current: GlueQualityStep,
  next: GlueQualityStep,
  views: readonly GlueQualityWorkView[],
  options: { readonly dpr: number; readonly subjects: number },
): boolean {
  if (current.sceneryTick !== next.sceneryTick
      && views.some((view) => view.moving && !view.somebody)) return true;
  return views.some((view) => {
    const from = glueViewResolution(view.boxWidth, view.boxHeight, {
      subject: view.subject, dpr: options.dpr, subjects: options.subjects,
      sceneryEdge: current.sceneryEdge, subjectRatioCap: current.subjectRatioCap,
    });
    const to = glueViewResolution(view.boxWidth, view.boxHeight, {
      subject: view.subject, dpr: options.dpr, subjects: options.subjects,
      sceneryEdge: next.sceneryEdge, subjectRatioCap: next.subjectRatioCap,
    });
    return from.width !== to.width || from.height !== to.height;
  });
}

/**
 * Find the next rung that changes work, skipping labels whose output is identical to `current`.
 *
 * On recovery, a quality level that is already rendering at native resolution is canonicalized to
 * `native` even when the labels between it and the current rung only changed knobs that are absent
 * from this scene. On degradation, `undefined` means there is no effective lower rung yet.
 */
export function glueQualityEffectiveStep(
  currentIndex: number,
  direction: -1 | 1,
  views: readonly GlueQualityWorkView[],
  options: { readonly dpr: number; readonly subjects: number },
): number | undefined {
  const current = GLUE_QUALITY_STEPS[currentIndex];
  if (!current) return undefined;
  for (let index = currentIndex + direction;
    index >= 0 && index < GLUE_QUALITY_STEPS.length;
    index += direction) {
    const candidate = GLUE_QUALITY_STEPS[index]!;
    if (glueQualityStepChangesWork(current, candidate, views, options)) return index;
  }
  return direction < 0 && currentIndex > 0 ? 0 : undefined;
}

/** The renderer's one-off work counters: compiled programs and uploaded textures/geometries. */
export interface GlueRendererWork {
  readonly programs: number;
  readonly textures: number;
  readonly geometries: number;
}

/** Read {@link GlueRendererWork} off `WebGLRenderer.info`; a missing counter reads as zero. */
export function glueRendererWork(info: {
  readonly programs?: readonly unknown[] | null;
  readonly memory?: { readonly textures?: number; readonly geometries?: number };
}): GlueRendererWork {
  return {
    programs: info.programs?.length ?? 0,
    textures: info.memory?.textures ?? 0,
    geometries: info.memory?.geometries ?? 0,
  };
}

/**
 * Whether a model pass paid a one-off cost: it compiled a program or uploaded a texture or geometry
 * the renderer had never held.
 *
 * **That is the character-select blur.** Picking another character builds a new figure and often a
 * new racial backdrop, and the first pass that draws them compiles and uploads everything at once —
 * measured on the canned charselect, switching Аларин → Лиэрель made one 364 ms pass. The warmup
 * window only covers the renderer's first sixty passes, so that one outlier held the rolling mean
 * near 16 ms for as long as it stayed in the window, and the ladder walked native → 0.75x → 0.5x →
 * 0.35x: the whole screen at a third of its resolution, stretched, for several seconds (longer
 * wherever the recovery lane is the eight-second one). A pass like that says what a *new* thing cost
 * once, not what the scene costs per frame, so it must not steer; the next pass of the same scene is
 * the honest sample.
 */
export function glueColdPass(before: GlueRendererWork, after: GlueRendererWork): boolean {
  return after.programs > before.programs
    || after.textures > before.textures
    || after.geometries > before.geometries;
}

/**
 * How long the pass has to sit on the wrong side of the target before the ladder moves.
 *
 * The R6 doctrine's shape, scoped to this stage: two seconds down, eight seconds up, so a scene that
 * is briefly expensive — a character walking on, a texture settling — is ridden out rather than
 * answered, and a recovery never oscillates against the degrade that caused it. The fast lane is the
 * one addition: at boot the stage starts on the top rung and the login screen's thirty-two
 * full-stage subjects are 48 M pixels, so *far* over target is answered in 250 ms instead of two
 * seconds and the screen settles in about a second rather than in twenty.
 */
/**
 * What one model pass is allowed to cost, in milliseconds.
 *
 * **Eight and not four, and the four is what the measurement rejected.** Fitted on this machine at
 * 961x922 over the owner's login screen, the pass costs `2.08 ms + 1.48 ms per megapixel` — a fixed
 * two milliseconds for thirty-two scene renders and a blit each, and the rest linear in pixels. Two
 * consequences follow, and both are numbers rather than opinions:
 *
 * | target | pixels a pass may draw | what each of the 32 views gets | judgement |
 * |---|---|---|---|
 * | 4 ms | 1.30 M | 240x231 | **blurrier than the build the owner is complaining about** |
 * | 8 ms | 4.00 M | 480x461 | the sharpness that build already had |
 * | 12 ms | 6.70 M | 720x691 | 36 % of the main thread at 30 Hz |
 *
 * The build the owner called low-quality was measured at **6.7 ms** a pass and he complained about
 * sharpness, not smoothness, so eight is that number rounded up to the whole millisecond: the stage
 * keeps what it was already spending and gains a floor it cannot run through. The pass is capped at
 * `MODEL_FPS`, so eight milliseconds is 24 % of one second's main thread.
 *
 * It is one constant and moving it moves the whole ladder, which is the point — but it is not a
 * setting, because a number the owner tunes by eye is exactly what this replaces.
 */
export const GLUE_QUALITY_TARGET_MS = 8;
const GLUE_QUALITY_WINDOW = 30;
const GLUE_QUALITY_DOWN_MS = 2000;
const GLUE_QUALITY_FAST_DOWN_MS = 250;
const GLUE_QUALITY_UP_MS = 8000;
/** Recover only when there is real headroom, or the step back up pays for the next step down. */
const GLUE_QUALITY_UP_FRACTION = 0.6;
/**
 * The other fast lane, and it is a *screen change* rather than a load spike.
 *
 * Measured: after the login screen walks the ladder to the bottom, the character screen is one view
 * costing 0.9 ms against a target of 8 — and at eight seconds a rung it would spend a minute and a
 * half climbing back to native while the owner looks at a 672x339 backdrop. Four times the headroom
 * is not an oscillation risk either, because one rung up roughly doubles the pixels and doubling
 * 0.25 of the target is still half of it.
 */
const GLUE_QUALITY_FAST_UP_MS = 1000;
const GLUE_QUALITY_FAST_UP_FRACTION = 0.25;
/**
 * Renderer/material compilation is a finite cold-start phase, not a sustainable frame budget.
 * At the measured 30 Hz stage cadence, two seconds covers the login's 1.2 s and charselect's 2.0 s
 * cold bursts while still allowing a continuously overloaded scene to steer after the window.
 */
const GLUE_QUALITY_WARMUP_PASSES = 60;

/**
 * The adaptive rung chooser: the model pass's own cost decides how much the model pass may spend.
 *
 * Deliberately **not** a settings knob. The two things it reads are measured — the rolling mean of
 * the pass in milliseconds and the clock — and the thing it writes is a rung of
 * {@link GLUE_QUALITY_STEPS}. Everything else about it is the hysteresis above.
 */
export class GlueQualityController {
  readonly #target: number;
  readonly #samples: number[] = [];
  #index = 0;
  #cursor = 0;
  #sum = 0;
  /** When the mean first crossed to the wrong side; undefined while it is on the right one. */
  #overSince: number | undefined;
  #underSince: number | undefined;

  constructor(targetMs: number = GLUE_QUALITY_TARGET_MS) {
    this.#target = targetMs > 0 ? targetMs : GLUE_QUALITY_TARGET_MS;
  }

  get step(): number {
    return this.#index;
  }

  get current(): GlueQualityStep {
    return GLUE_QUALITY_STEPS[this.#index]!;
  }

  /** The rolling mean of the model pass, in milliseconds; zero until the first pass. */
  get passMs(): number {
    return this.#samples.length === 0 ? 0 : this.#sum / this.#samples.length;
  }

  /**
   * Bank one representative pass and answer with the new rung when it moved, or undefined when it
   * did not. A clock pass with no due model is still useful to the renderer, but it is not evidence
   * of model headroom: counting it would let scenery cadence gaps climb the rung before the next
   * representative redraw. The caller marks those observations explicitly and they only clear a
   * pending recovery timer.
   *
   * The caller logs the move; the controller does not know what a diagnostic is.
   */
  sample(passMs: number, nowMs: number, options: {
    readonly representative?: boolean;
    /** False while the stage is still in its measured cold renderer/material window. */
    readonly steeringReady?: boolean;
    /** First lower rung that actually changes work, or null when this scene has no such rung. */
    readonly downStep?: number | null;
    /** First higher rung that actually changes work, or null when there is no higher work change. */
    readonly upStep?: number | null;
  } = {}): GlueQualityStep | undefined {
    if (options.representative === false) {
      this.#overSince = undefined;
      this.#underSince = undefined;
      return undefined;
    }
    if (options.steeringReady === false) {
      this.#overSince = undefined;
      this.#underSince = undefined;
      return undefined;
    }
    if (!Number.isFinite(passMs) || passMs < 0) return undefined;
    if (this.#samples.length < GLUE_QUALITY_WINDOW) {
      this.#samples.push(passMs);
      this.#sum += passMs;
    } else {
      this.#sum += passMs - this.#samples[this.#cursor]!;
      this.#samples[this.#cursor] = passMs;
      this.#cursor = (this.#cursor + 1) % GLUE_QUALITY_WINDOW;
    }
    // A window that is not full yet still steers, because the boot frames are the expensive ones and
    // waiting a second before answering them is the stutter the owner would see.
    const mean = this.passMs;
    if (mean > this.#target) {
      this.#underSince = undefined;
      this.#overSince ??= nowMs;
      const wait = mean > this.#target * 2 ? GLUE_QUALITY_FAST_DOWN_MS : GLUE_QUALITY_DOWN_MS;
      const destination = options.downStep === null
        ? this.#index
        : options.downStep ?? this.#index + 1;
      if (nowMs - this.#overSince >= wait
          && destination > this.#index
          && destination < GLUE_QUALITY_STEPS.length) {
        this.#index = destination;
        this.#overSince = nowMs;
        return this.current;
      }
      if (destination === this.#index) this.#overSince = undefined;
      return undefined;
    }
    this.#overSince = undefined;
    if (mean < this.#target * GLUE_QUALITY_UP_FRACTION) {
      this.#underSince ??= nowMs;
      const wait = mean < this.#target * GLUE_QUALITY_FAST_UP_FRACTION
        ? GLUE_QUALITY_FAST_UP_MS
        : GLUE_QUALITY_UP_MS;
      const destination = options.upStep === null ? this.#index : options.upStep ?? this.#index - 1;
      if (nowMs - this.#underSince >= wait && destination >= 0 && destination < this.#index) {
        this.#index = destination;
        this.#underSince = nowMs;
        return this.current;
      }
      if (destination === this.#index) this.#underSince = undefined;
    } else {
      this.#underSince = undefined;
    }
    return undefined;
  }
}

/**
 * Everything about a widget that changes what its picture should look like.
 *
 * Only for the views that cannot move on their own: a cloud card with one static batch and no
 * emitter draws identical pixels for ever, and the only reason to draw it a second time is that the
 * corpus moved, turned, rescaled, re-lit or re-pointed it. Cheap enough to compute for every view
 * every pass — six numbers and a path.
 */
export function glueViewSignature(frame: FrameXmlFrame): string {
  const state = frame.model;
  const position = state.position;
  return [
    state.file,
    state.sequence ?? 0,
    state.facing ?? 0,
    state.modelScale ?? 0,
    position ? `${position[0]},${position[1]},${position[2]}` : "-",
    state.light ? state.light.join(",") : "-",
    state.lights ? state.lights.map((light) => light.join(",")).join(";") : "-",
  ].join("|");
}

/**
 * How often one view redraws, as a divisor of the model pass.
 *
 * **Resolution and frame rate are two questions and they get two answers.** Coverage decides how
 * many pixels a view is worth, because a plate that fills the frame is what the owner is looking at.
 * It does not decide how often those pixels are recomputed, because a sky dome that fills the frame
 * still holds perfectly still — measured on this corpus, the cost of treating every full-stage view
 * as a face was thirty-two redraws a pass and a ladder that bottomed out three rungs below where it
 * needed to be.
 *
 * So `somebody` — a `ModelFFX` screen, a rigged model, or a widget with a character standing in it —
 * never skips a pass, and everything else rides the ladder's divisor. At the top rung that divisor is
 * 1 and nothing skips at all; at the deepest it is 7.5 Hz drift on a card that takes seconds to
 * cross the screen.
 */
export function glueViewTickDivisor(somebody: boolean, sceneryTick = 1): number {
  return somebody ? 1 : Math.max(1, Math.round(sceneryTick));
}

/**
 * Whether a widget's authored scale mirrors the model rather than merely resizing it.
 *
 * `lgzg.lua` writes negative scales — the nine `tu_clouds_01` cards run −0.419 to −0.720 and one
 * `silvermyst_lightshaft03` is at −1.118 — and a uniform negative scale is a point reflection: its
 * matrix has a negative determinant, so **every triangle's winding is reversed**. Three does not
 * compensate, `GL_CULL_FACE` is on for anything the file did not flag two-sided, and the model
 * disappears completely.
 *
 * **That is the owner's white plate, and the corpus proves the mechanism by itself.** Read out of
 * the artifacts the gateway serves: `tu_clouds_01.m2` is one batch, blend 2, material flags 16 —
 * *not* two-sided — and all nine of its cards are negatively scaled, so all nine drew nothing;
 * `silvermyst_lightshaft03.m2` is one batch, blend 4, flags 21, and flag 0x04 **is** two-sided,
 * which is exactly why the one negatively-scaled lightshaft kept drawing while the clouds did not.
 * With the cloud disc gone, what was left behind the two figures was the bare sky dome plus the two
 * `Largebluegreenradiationfog` emitters — measured in the live page, a disc region at mean luminance
 * 184.2 with a third of it clipped to pure white.
 */
export function glueScaleMirrors(scale: number | undefined): boolean {
  return scale !== undefined && Number.isFinite(scale) && scale < 0;
}

/**
 * Turn every single-sided material in a build inside out, and answer with how many moved.
 *
 * An involution, so the same call puts them back: it is applied when a view's authored scale changes
 * sign and never accumulates. `DoubleSide` is left alone because a two-sided batch has no front to
 * lose — the lightshaft above is the corpus' own control case.
 */
export function glueFlipMaterialSides(materials: Iterable<THREE.Material>): number {
  let flipped = 0;
  for (const material of materials) {
    if (material.side === THREE.FrontSide) material.side = THREE.BackSide;
    else if (material.side === THREE.BackSide) material.side = THREE.FrontSide;
    else continue;
    material.needsUpdate = true;
    flipped += 1;
  }
  return flipped;
}

/**
 * How often the model views redraw, in frames per second.
 *
 * The DOM widgets keep the page's own `requestAnimationFrame`; only the 3D is paced. Glue models
 * are ambient scenery — smoke, cloth, a torch — and the original renders them inside a UI that was
 * itself capped. Measured on this machine before the cap, the owner's thirty-model scene spent
 * essentially the whole frame in the model pass; see the slice journal for the numbers.
 */
const MODEL_FPS = 30;

/**
 * The Model frame's own camera, for a widget the corpus composes by hand.
 *
 * These two numbers are the one thing in this file that is **not** measured, and that is recorded
 * rather than hidden: nothing in the client data, the WVM artifacts or the corpus states where a
 * `Model` frame's default camera stands when the model carries none of its own, and
 * `Model:SetCamera(1)` — which `lgzg.lua` calls on every one of its thirty models — selects a
 * camera index none of those doodads has. What is measured is the *shape* the authored numbers
 * imply: `SetPosition`'s first component runs from +1.53 (the skybox) down to −24.5 (the far
 * lightshafts), so the camera looks along −X from a little in front of the origin, and the
 * placements read as depth. The distance and angle were then set against the module's own
 * reference picture. Pinning them from a running 3.3.5 client is a followup.
 *
 * **What a second look found, and why it still does not pin them.** The obvious lever — the row
 * whose intent is unambiguous — does not pull: `SkywallSkyBox` sits at the extreme **+x** end of
 * the authored range (+1.530 against −24.478), which under a camera at +6 looking along −x makes
 * the sky the *nearest* thing in the scene. That is not a contradiction, because the author never
 * uses x for ordering: every model has a widget of its own, DOM order decides what is in front of
 * what, and `lgzg.lua` puts the skybox behind everything by hand
 * (`mod:SetFrameStrata("BACKGROUND")`, line 266). So x only sets apparent size, and both signs
 * remain arguable. Measured under the constants below, at 1280x768: the skybox's own bounds
 * (±123.5 x/y, −93..118.6 z, scaled 0.012) land 4.47 yards out and subtend ±18.3° against the
 * frustum's 22.5° vertical — a sky plate covering 22.83 % of the widget at mean α 254, not a
 * backdrop that fills the frame. The other end, `silvermyst_lightshaft03` at −24.478 and scale
 * 3.933, straddles the camera plane entirely. Neither reading is falsified by anything in the
 * corpus, and `Fondo.png` cannot arbitrate: it is a 2,048² backdrop plate with black bars and no
 * figure in it. Left exactly as they were.
 *
 * A live third look (2026-08-30) tried the two rival camera stations and both are now FALSIFIED
 * by the screen itself: at distance 0.01 (camera at the origin, inside the scaled dome whose
 * shell spans +0.05..+3.01) the sky becomes an all-over haze and both characters leave the frame
 * entirely; at 1.53 (the dome's own centre) the characters — authored around x ≈ +1.2 — fill the
 * screen with their robe hems. Only the shipped 6 frames the two figures mid-screen IN FRONT of
 * the cloud disc, which is the composition the module's reference plate implies: the disc inside
 * the portal arch, the figures floating over it. The octagonal silhouette of the disc is the
 * dome's own low-poly rim seen from outside — authored geometry, not a projection error.
 */
const GLUE_MODEL_CAMERA_DISTANCE = 6;
const GLUE_MODEL_CAMERA_FOV = 45;

/**
 * The file a glue model actually lives in.
 *
 * GlueXML and the server's `lgzg.lua` both write `.mdx`, which is the Warcraft III extension and
 * has never been what a 3.3.5 client has on disk — the client swaps it for `.m2` before it opens
 * anything. Measured against the running gateway: all sixteen distinct model paths the corpus
 * names answer 400 as written and 200 as `.m2`, including every one of the owner's scene models
 * (`Environments\Stars\SkywallSkyBox`, both `creature\CustomCharacters\…`, the fog, cloud,
 * lightshaft and smoke doodads) and the stock `Interface\Glues\Models\…` sets.
 */
export function glueModelPath(file: string): string {
  const path = file.trim().replaceAll("/", "\\");
  if (path === "") return "";
  const cut = path.lastIndexOf("\\");
  const leaf = path.slice(cut + 1);
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return `${path}.m2`;
  return `${path.slice(0, cut + 1)}${leaf.slice(0, dot)}.m2`;
}

/**
 * The file name an M2 texture slot really carries.
 *
 * An `M2Texture`'s filename is a NUL-terminated C string: the record's length is how much room the
 * author's tool allocated for it, and the client opens the bytes up to the terminator. The
 * extraction reads `length` bytes and strips only *trailing* NULs, so a slot whose authored length
 * overruns its string keeps the terminator and the next entry's tail glued on behind it — and the
 * gateway answers that 400.
 *
 * Measured on the owner's own `world\expansion07\Doodads\fx\8fx_generic_shadow_debuff.m2` (6,188 B,
 * MD20 version 264): nine type-0 slots at offsets 5,832–6,144 with lengths 50/41/20/26/41/52/41/41/42,
 * of which **two carry an interior NUL** — slot 0 reads `spells\7fx_alphamask_glowbright_black.blp`
 * followed by `\0113.blp`, and slot 5 by `\0e_128.blp`. Cutting at the terminator turns slot 0 back
 * into the file the module ships (23,044 B) and into the very URL slots 1/4/6/7/8 already fetch 200.
 *
 * It cannot repair a slot whose authored length is too *short* — slot 3's 26 bytes stop inside
 * `spells\7fx_alphamask_glowb`, and the bytes that finish that name were dropped before the artifact
 * was written. What it can do is refuse to ask for it. A texture slot's name is a file name, and
 * every well-formed one in this client ends in an extension; a leaf with no dot in it cannot name a
 * file, so it is answered with the empty string — the same thing a slot the *client* is supposed to
 * fill already answers. `resolveSlot` then gives the batch no picture and `hideFailedBatches` keeps
 * it out of the frame, while `buildModelEffects` drops an emitter with no texture outright. That is
 * the one 400 left on the login screen after G7: measured, slot 3 of
 * `8fx_generic_shadow_debuff.m2` feeds emitter 1 of 3, and asking the gateway for a path with no
 * `.blp` on the end is a guaranteed 400 rather than a miss.
 */
export function glueTextureName(path: string): string {
  const end = path.indexOf("\0");
  const name = end < 0 ? path : path.slice(0, end);
  const leaf = name.slice(name.lastIndexOf("\\") + 1);
  return /\.[^.\\]+$/.test(leaf) ? name : "";
}

/**
 * Whether a built material adds light to the frame instead of covering it.
 *
 * The file's two additive modes are the only ones `applyBlendMode` gives `blendDst = One`: mode 3
 * is `One/One` and mode 4 is `SrcAlpha/One`. Mode 7 (`One/OneMinusSrcAlpha`) is premultiplied
 * source-over and does composite over what is behind it, so it is deliberately not in here.
 */
export function glueIsAdditive(material: THREE.Material): boolean {
  return material.blending === THREE.CustomBlending && material.blendDst === THREE.OneFactor;
}

/**
 * Make an additive draw contribute light without contributing coverage.
 *
 * **Why a widget canvas needs this and the world does not.** In the client every model on the login
 * screen is drawn into the *same* frame buffer, so an additive quad adds to whatever the scene put
 * there. Here each `Model` widget owns its own transparent canvas and the browser composites that
 * canvas over the page with source-over, `Co = Cs + Cb·(1 − αs)`. three's `SrcAlpha/One` uses the
 * same pair for the alpha channel, so an additive draw *also* accumulates `αs`, and every bit of
 * that α is a bit of the login scene deleted from behind the glow — coverage a light source has no
 * business claiming. Setting the alpha pair to `Zero/One` leaves the canvas's α exactly as it was
 * and lets the RGB accumulate as before; the widget then carries premultiplied light with no
 * coverage, and source-over over the page reduces to `Cs + Cb` — addition, exactly.
 *
 * It is right for a mixed model too, and that is why it is applied per material rather than per
 * view: a batch that really does cover keeps writing α, and the emitters over it still only add.
 *
 * **Measured on the live login screen** (1280x768, 32 views). Chrome carries the superluminous
 * premultiplied values through the WebGL→2D blit intact — of the 21,525 inked pixels on one
 * `Largebluegreenradiationfog` canvas, 21,456 have `P > α` — so the RGB half was already right and
 * only the α half was wrong. Composited in software against the real backdrop, today's source-over
 * against true addition differs by **+0.46** mean luminance over the 23.3 % of the frame those two
 * cards ink (105.89 → 106.35) and by at most 138.7 on six pixels: the two fog cards were never the
 * expensive case, because their α stays low. The expensive case is
 * `6du_mooncultist_watersouls_fxwrap`, six additive batches and five additive emitters of nearly
 * black art at α up to 33/255 across a quarter of the topmost widget on the screen: it *subtracted*
 * light it should have left alone. Over all thirteen additive-only views the whole-frame mean
 * luminance is **45.30 → 62.72** and the mean over the 41.8 % of the frame they ink is
 * **79.76 → 121.45**, with 29,502 pixels moving by more than 8.
 *
 * **Why not `mix-blend-mode: plus-lighter`.** It is the same arithmetic and it does not reach:
 * measured in this browser with a chain built to match the real one, an element that establishes a
 * stacking context isolates blending, and every FrameXML widget carries a `z-index` — a probe with
 * `difference` over red stayed white through the widget, through `s.parent` and through
 * `LoginScene`. Nothing on the login screen needs a blend this cannot express: the census of all
 * ten distinct model files behind the 32 views is 0/2/4 only — opaque, alpha and add — with no
 * `MOD` or `MOD2X` batch or emitter anywhere.
 */
export function glueDropAdditiveCoverage(material: THREE.Material): boolean {
  if (!glueIsAdditive(material)) return false;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  return true;
}

/**
 * Client light units to three.js light intensities.
 *
 * `SetLight` means what the fixed-function client meant: a surface is `texel × (ambient + N·L ×
 * diffuse)`, clamped. `MeshStandardMaterial` — what `ModelBuild` gives every lit batch — puts both
 * terms through `BRDF_Lambert`, which is `RECIPROCAL_PI * diffuseColor`, so an intensity handed over
 * literally arrives on screen divided by π.
 *
 * Measured in the live page (three r185, `outputColorSpace: "srgb"`, `NoToneMapping`, one white
 * texel on a plane facing the light) against the corpus' own numbers — `lgzg.lua`'s `newModel`
 * falls back to `{1, 0, 0, -0.707, -0.707, 0.7, 1, 1, 1, 0.8, 1, 1, 0.8}` for every one of the
 * thirty login models, because `mainlight` is a global the module never assigns:
 *
 * | mapping                | ambient only | ambient + N·L·diffuse |
 * | ---------------------- | ------------ | --------------------- |
 * | intensity taken as-is  | **130**      | **184**               |
 * | intensity × π          | **218**      | **255**               |
 * | what the client draws  | 218 (0.7)    | 255 (min(1, 1.5))     |
 *
 * So the scene was rendering the owner's login at a little over half the brightness he lit it at,
 * and the correction is exactly the π the BRDF takes out — not a taste knob.
 */
export const GLUE_LIGHT_INTENSITY_SCALE = Math.PI;

/**
 * `Model:SetLight(enabled, omni, dirX, dirY, dirZ, ambIntensity, ambR, ambG, ambB, dirIntensity,
 * dirR, dirG, dirB)`, as two three.js lights.
 *
 * The corpus does not call this decoratively: `lgzg.lua`'s `SetModelLighting` drives every model on
 * the login screen through it, and with the call recorded and dropped the whole scene rendered
 * under whatever default the stage happened to pick. Thirteen numbers map onto exactly one ambient
 * and one directional light, so they are read rather than recorded.
 *
 * The intensities come out in the *client's* units; `GLUE_LIGHT_INTENSITY_SCALE` converts them at
 * the point they are pushed onto three's lights.
 */
export interface GlueModelLight {
  readonly ambient: THREE.Color;
  readonly ambientIntensity: number;
  readonly direction: THREE.Vector3;
  readonly diffuse: THREE.Color;
  readonly diffuseIntensity: number;
}

export function glueModelLight(args: readonly unknown[]): GlueModelLight | undefined {
  const number = (index: number, fallback: number): number => {
    const value = Number(args[index]);
    return Number.isFinite(value) ? value : fallback;
  };
  if (args.length < 13) return undefined;
  // A zero direction would make `lookAt` degenerate; the client's own default points down and back.
  const dx = number(2, -0.707);
  const dy = number(3, -0.707);
  const dz = number(4, 0);
  const direction = new THREE.Vector3(dx, dz, -dy);
  if (direction.lengthSq() < 1e-8) direction.set(0, -1, 0);
  return {
    ambient: new THREE.Color(number(6, 1), number(7, 1), number(8, 1)),
    ambientIntensity: Math.max(0, number(5, 0.7)),
    direction: direction.normalize(),
    diffuse: new THREE.Color(number(10, 1), number(11, 1), number(12, 1)),
    diffuseIntensity: Math.max(0, number(9, 1)),
  };
}

/**
 * How many directional lights one glue view can hold.
 *
 * The corpus' own ceiling and its own maximum: `GlueParent.lua:359` says «You can add up to four
 * lights per light set», and the largest set it actually declares is three — `RaceLights.HUMAN`,
 * `DRAENEI` and `BLOODELF`. One of those three is usually pure ambient, so two directionals is what
 * a backdrop normally uses; the third is kept because two races fill it.
 */
export const GLUE_MAX_DIRECTIONAL_LIGHTS = 3;

/** The ambient term and the directional lights one Model widget is standing in. */
export interface GlueSceneLighting {
  readonly ambient: THREE.Color;
  readonly ambientIntensity: number;
  readonly directional: readonly GlueModelLight[];
}

/**
 * Everything lighting one Model widget, from whichever of the two calls the corpus used.
 *
 * There are two, and only the first was ever read. `SetLight` is what the owner's `lgzg.lua` drives
 * its thirty login models with. The stock character screens never call it at all: `SetBackgroundModel`
 * hands off to `SetLighting`, which calls `ResetLights()` and then adds `RaceLights[race]` through
 * `AddLight` — recorded and dropped until now, which is why both character screens were lit by a
 * constant nobody had measured.
 *
 * **The authored numbers, read out of `GlueParent.lua:51-94`.** Thirteen per light, same layout as
 * `SetLight`. A human backdrop gets three: a pure ambient `0.27` grey, a cool key
 * `1.0 x (0.199, 0.349, 0.436)` from (−0.458, −0.589, −0.666), and a warm key **at intensity 2**,
 * `2.0 x (0.522, 0.440, 0.298)` from (−0.646, 0.576, −0.501). A dwarf gets ambient `0.30` and one
 * key at 2.0; a night elf gets ambient `(0.090, 0.090, 0.170)` and no key at all; `CHARACTERSELECT`
 * — the set used before a character is picked — matches the orc's, ambient `0.15` plus two keys.
 * The stage's previous guess was ambient `0.7` white plus a white key at `1.0`: about two and a half
 * times the human ambient, white where the author is cool-grey, and flat where he is two-keyed.
 *
 * **`enabled` is the first number and was being ignored.** Every set in this client passes 1, and
 * `SetLighting` itself tests `Array[1]==1` before adding a light, so honouring it costs nothing and
 * stops a `SetLight(0, …)` from lighting anything.
 *
 * With neither call, the fall-back is a flat white ambient of 1 and no key — which is what the
 * fixed-function client draws with lighting off, and what a backdrop whose light is baked into its
 * own texture wants. Nothing in this corpus reaches it: the login models call `SetLight` and both
 * character screens go through `SetLighting`.
 */
export function glueSceneLighting(state: {
  readonly light?: readonly number[] | undefined;
  readonly lights?: readonly (readonly number[])[] | undefined;
}): GlueSceneLighting {
  const enabled = (args: readonly number[]): boolean => Number(args[0]) !== 0;
  const sets = state.lights?.length ? state.lights : state.light ? [state.light] : [];
  const ambient = new THREE.Color(0, 0, 0);
  const directional: GlueModelLight[] = [];
  let ambientIntensity = 0;
  let lit = false;
  for (const set of sets) {
    if (!enabled(set)) continue;
    const light = glueModelLight(set);
    if (!light) continue;
    lit = true;
    // Ambient terms add: the client merges a light set in the engine, and two of the three lights
    // in a race set carry a black ambient precisely so the third one's is the scene's.
    ambient.add(light.ambient.clone().multiplyScalar(light.ambientIntensity));
    if (light.diffuseIntensity <= 0) continue;
    if (light.diffuse.r === 0 && light.diffuse.g === 0 && light.diffuse.b === 0) continue;
    if (directional.length < GLUE_MAX_DIRECTIONAL_LIGHTS) directional.push(light);
  }
  if (!lit) return { ambient: new THREE.Color(1, 1, 1), ambientIntensity: 1, directional: [] };
  // The summed ambient travels as a colour at intensity one rather than as colour x intensity,
  // because three multiplies the two back together and only their product reaches a surface.
  ambientIntensity = 1;
  return { ambient, ambientIntensity, directional };
}

/**
 * Somebody standing inside a backdrop scene: the character on the character-select screen.
 *
 * The stage takes it as a finished object rather than building it, because a character is the one
 * thing on a glue screen that is *not* a plain model file — it is an atlas composed out of
 * `CharSections`, a geoset list, a worn-item attachment walk and a display record, all of which
 * `GlueCharacterScene` already owns. What the stage adds is the two things only it knows: where in
 * the backdrop the figure stands, and the mixer tick that keeps it breathing.
 */
export interface GlueStageActor {
  readonly root: THREE.Object3D;
  readonly mixer?: THREE.AnimationMixer | undefined;
  /** Turned about its own up axis, in degrees — `SetCharacterSelectFacing`'s unit. */
  facingDegrees: number;
  /** Model-space scale from `CreatureDisplayInfo`, already applied to `root` by the builder. */
  dispose(): void;
}

interface ModelView {
  readonly frame: FrameXmlFrame;
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly ambient: THREE.AmbientLight;
  /** `GLUE_MAX_DIRECTIONAL_LIGHTS` of them, made once; an unused one is left at intensity zero. */
  readonly suns: readonly THREE.DirectionalLight[];
  path: string;
  sourceKey: string;
  loadGeneration: number;
  source?: GlueModelSource | undefined;
  width: number;
  height: number;
  wvm?: WvmModel | undefined;
  built?: BuiltModel | undefined;
  template?: SkinnedTemplate | undefined;
  instance?: SkinnedInstance | undefined;
  effects?: ModelEffects | undefined;
  root?: THREE.Object3D | undefined;
  action?: THREE.AnimationAction | undefined;
  sequence: number;
  /** Local clock of the played clip, in milliseconds, for the emitters' animated tracks. */
  animationMs: number;
  loading: boolean;
  failed: boolean;
  /** Which resolution and tick budget this view is on; see `glueViewIsSubject`. */
  subject: boolean;
  /** Whether the decoded artifact carries a skeleton — one of the three subject tests. */
  rigged: boolean;
  /** What fraction of the viewport this widget's box last covered; the other subject test. */
  coverage: number;
  /** Whether this view's materials are currently turned inside out; see `glueScaleMirrors`. */
  mirrored: boolean;
  /**
   * Whether anything in this view can move on its own: a mixer, an animated batch, an emitter or an
   * actor. A view with none of those draws the same picture for ever, so it is drawn once.
   */
  animated: boolean;
  /** The widget's box the last time it was read, in CSS units; a change is a redraw. */
  boxWidth: number;
  boxHeight: number;
  /**
   * Seconds this view has not been advanced for yet.
   *
   * A view that draws every other pass must still be handed *both* passes' worth of time, or its
   * mixer and its emitters run at half speed instead of at half the frame rate.
   */
  pending: number;
  /** The widget state the last drawn frame was made from, so a change can be noticed. */
  signature: string;
  /** Set whenever something the picture depends on changed; cleared by a draw. */
  dirty: boolean;
  /** Loader settlement generation this view's batches were last checked against. */
  textureGeneration: number;
  /** Materials kept out of the frame because their texture is not there; re-asserted each frame. */
  masked: THREE.Material[];
  actor?: GlueStageActor | undefined;
}

/** Host-resolved creature appearance, consumed by the same model builder as file models. */
export interface GlueModelSource {
  readonly key: string;
  readonly file: string;
  readonly textures?: string;
  readonly appearance?: CharacterAppearance | undefined;
  readonly displayScale?: number;
  /** Unit previews fit their full body; glue scenes retain their authored cameras. */
  readonly fitBody?: boolean;
}

export interface GlueModelStageOptions {
  readonly gatewayOrigin: string;
  /** The frames the stage should look at, and where each one is on the page. */
  readonly models: () => Iterable<FrameXmlFrame>;
  readonly elementFor: (frame: FrameXmlFrame) => HTMLElement | undefined;
  readonly isVisible: (frame: FrameXmlFrame) => boolean;
  readonly onDiagnostic?: (message: string) => void;
  /** Undefined means the host is still resolving the requested model, or it was cleared. */
  readonly resolveModel?: (frame: FrameXmlFrame) => GlueModelSource | undefined;
}

export class GlueModelStage {
  readonly #options: GlueModelStageOptions;
  readonly #textures = new ModelTextureLoader({ cache: true });
  #atlases: CharacterAtlasClient | undefined;
  readonly #views = new Map<FrameXmlFrame, ModelView>();
  readonly #wvmCache = new Map<string, Promise<WvmModel>>();
  /** Held-back clips per model path; see `ensureAnimation` for why it holds clips and not templates. */
  readonly #animationCache = new Map<string, Promise<readonly WvmSkeletonClip[]>>();
  readonly #billboard = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
  readonly #boneMatrix = new THREE.Matrix4();
  /** Textures this stage asked for that have not settled yet; drained on every generation change. */
  #unsettledTextures: THREE.Texture[] = [];
  /**
   * The pixel sources whose fetch failed, so a batch sampling one can be left out of the frame.
   *
   * Keyed on `Texture.source` rather than on the Texture: `buildMaterial` hands a batch a private
   * *clone* whenever it carries a texture transform or a second UV set, and a clone shares its
   * source with the base the loader settled.
   */
  readonly #failedSources = new Set<THREE.Texture["source"]>();
  #renderer: THREE.WebGLRenderer | undefined;
  #rendererFailed = false;
  /** The size the shared render target is currently at, so `setSize` is called only on a change. */
  #targetWidth = 0;
  #targetHeight = 0;
  #sinceLastDraw = 0;
  #drawn = 0;
  #lastFrameMs = 0;
  /** Model passes since the stage started; prop views ride every n-th one. */
  #pass = 0;
  /** How many views the last pass actually redrew, for the budget line in `stats`. */
  #drawnLastPass = 0;
  /** Representative redraws seen since this renderer was created; cold passes do not steer. */
  #qualityRepresentativePasses = 0;
  /** The thing that decides how much this stage may spend; see `GlueQualityController`. */
  readonly #quality = new GlueQualityController();

  constructor(options: GlueModelStageOptions) {
    this.#options = options;
  }

  /**
   * Live views, frames drawn so far, the cost of the last model pass in milliseconds, and the
   * budget that cost was paid under.
   *
   * `subjects`/`scenery`/`still` and `pixels` are published so the browser smoke can *read* the
   * budget table out of the running page instead of being told what it should be — the same reason
   * `lastFrameMs` is here.
   */
  get stats(): {
    readonly views: number; readonly frames: number; readonly lastFrameMs: number;
    readonly subjects: number; readonly scenery: number; readonly still: number;
    readonly drawnLastPass: number; readonly pixels: number;
    readonly quality: {
      readonly step: number; readonly name: string; readonly passMs: number;
      readonly targetMs: number; readonly sceneryTick: number; readonly sceneryEdge: number;
      readonly subjectRatioCap: number;
    };
  } {
    let subjects = 0;
    let still = 0;
    let pixels = 0;
    for (const view of this.#views.values()) {
      if (view.subject) subjects += 1;
      if (!view.animated) still += 1;
      pixels += view.width * view.height;
    }
    const step = this.#quality.current;
    return {
      views: this.#views.size, frames: this.#drawn, lastFrameMs: this.#lastFrameMs,
      subjects, scenery: this.#views.size - subjects, still,
      drawnLastPass: this.#drawnLastPass, pixels,
      // Published rather than logged, for the same reason `lastFrameMs` is: the acceptance check
      // reads which rung the stage settled on out of the running page.
      quality: {
        step: this.#quality.step, name: step.name,
        passMs: Math.round(this.#quality.passMs * 100) / 100, targetMs: GLUE_QUALITY_TARGET_MS,
        sceneryTick: step.sceneryTick, sceneryEdge: step.sceneryEdge,
        subjectRatioCap: step.subjectRatioCap,
      },
    };
  }

  /** Bring the set of live views into line with what is on the page. Cheap; call after every sync. */
  reconcile(): void {
    const wanted = new Set<FrameXmlFrame>();
    for (const frame of this.#options.models()) {
      const element = this.#options.elementFor(frame);
      if (!element || !this.#options.isVisible(frame)) continue;
      const source = this.#options.resolveModel?.(frame);
      const file = glueModelPath(this.#options.resolveModel ? source?.file ?? "" : frame.model.file);
      if (!file) continue;
      wanted.add(frame);
      let view = this.#views.get(frame);
      if (view && view.element !== element) {
        this.dropView(view);
        this.#views.delete(frame);
        view = undefined;
      }
      if (!view) {
        const created = this.createView(frame, element);
        if (!created) continue;
        view = created;
        this.#views.set(frame, view);
      }
      const sourceKey = source?.key ?? file;
      if (view.sourceKey !== sourceKey) {
        this.clearContent(view);
        view.path = file;
        view.sourceKey = sourceKey;
        const generation = ++view.loadGeneration;
        view.source = source;
        view.failed = false;
        void this.loadInto(view, file, generation, source);
      }
      const sequence = frame.model.sequence ?? 0;
      if (view.sequence !== sequence) {
        view.sequence = sequence;
        this.playSequence(view);
      }
    }
    for (const [frame, view] of this.#views) {
      if (wanted.has(frame)) continue;
      this.dropView(view);
      this.#views.delete(frame);
    }
  }

  /**
   * Advance and redraw every live view.
   *
   * `elapsedSeconds` is the page's own frame delta, already clamped by the caller — the same number
   * the widget OnUpdate pass gets, so a backgrounded tab comes back to a running scene rather than
   * to one frame holding four seconds of smoke.
   */
  frame(elapsedSeconds: number, nowMs: number): void {
    if (this.#views.size === 0) return;
    this.#sinceLastDraw += elapsedSeconds;
    if (this.#sinceLastDraw < 1 / MODEL_FPS) return;
    const step = this.#sinceLastDraw;
    this.#sinceLastDraw = 0;
    const renderer = this.renderer();
    if (!renderer) return;
    const started = performance.now();
    this.sweepTextureFailures();
    const generation = this.#textures.stats.generation;
    this.#pass += 1;
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

    // Two passes over the views, and the first one costs nothing but arithmetic. What it buys is a
    // shared render target that is only ever *grown*: with two resolution classes on one screen a
    // per-view `setSize` would reallocate the drawing buffer on every switch, and reallocation is
    // the one thing in this loop that is not measured in tenths of a millisecond. Each view then
    // renders into a scissored viewport of that target and blits its own rectangle out.
    const rung = this.#quality.current;
    const viewport = typeof window === "undefined"
      ? { width: 1, height: 1 }
      : { width: window.innerWidth, height: window.innerHeight };
    // Taken over every live view rather than over the due ones, so a plate pass and a full pass hand
    // the subjects the same share of the canvas rail and nothing re-sizes on alternate frames.
    let subjects = 0;
    for (const view of this.#views.values()) if (view.root && view.subject) subjects += 1;

    const due: { view: ModelView; width: number; height: number }[] = [];
    const qualityViews: GlueQualityWorkView[] = [];
    let targetWidth = 1;
    let targetHeight = 1;
    for (const view of this.#views.values()) {
      if (!view.root) continue;
      // Every live view banks the pass's time whether or not it is about to draw; see `pending`.
      view.pending += step;
      // Textures settle after the build that asked for them, so which batches have a picture is
      // known only here. Rechecked on a settlement generation rather than every frame: the sweep
      // above is what moves the number, and between two of them nothing can have changed.
      if (view.textureGeneration !== generation) {
        view.textureGeneration = generation;
        this.hideFailedBatches(view);
        view.dirty = true;
      }
      const box = view.element.getBoundingClientRect();
      const boxWidth = Math.max(1, Math.round(box.width));
      const boxHeight = Math.max(1, Math.round(box.height));
      // A widget with no box shows nothing, so there is nothing to draw into. `reconcile` already
      // drops the views of a hidden screen, so on this corpus the lever is empty — G8 measured 0 of
      // 32 login views offscreen and the character screen has one view filling the frame — but a
      // collapsed box would otherwise cost a 1x1 render every pass for ever.
      if (boxWidth <= 1 && boxHeight <= 1) continue;
      if (view.boxWidth !== boxWidth || view.boxHeight !== boxHeight) {
        view.boxWidth = boxWidth;
        view.boxHeight = boxHeight;
        view.dirty = true;
      }
      // Coverage is read here rather than at load, because it is a fact about the *window*: the same
      // widget is the whole picture at 961x922 and a corner of it on a 4K panel.
      view.coverage = glueViewCoverage(box, viewport);
      const subject = glueViewIsSubject(view.frame.type, view.rigged, view.coverage);
      if (view.subject !== subject) {
        view.subject = subject;
        view.dirty = true;
      }
      const signature = glueViewSignature(view.frame);
      if (view.signature !== signature) {
        view.signature = signature;
        view.dirty = true;
      }
      // A plate every n-th pass; a view with nothing that can move only when something changed.
      const moving = view.animated || Boolean(view.actor);
      const somebody = view.frame.type === "ModelFFX" || view.rigged || Boolean(view.actor);
      qualityViews.push({
        boxWidth, boxHeight, subject: view.subject, moving, somebody,
      });
      const divisor = glueViewTickDivisor(somebody, rung.sceneryTick);
      if (!view.dirty && !(moving && this.#pass % divisor === 0)) continue;
      const size = glueViewResolution(boxWidth, boxHeight, {
        subject: view.subject, dpr, subjects,
        sceneryEdge: rung.sceneryEdge, subjectRatioCap: rung.subjectRatioCap,
      });
      due.push({ view, width: size.width, height: size.height });
      targetWidth = Math.max(targetWidth, size.width);
      targetHeight = Math.max(targetHeight, size.height);
    }
    // One-off work (a program compiled, a first upload, the shared target grown) is counted across
    // the pass so it cannot steer the quality ladder; see `glueColdPass`.
    const workBefore = glueRendererWork(renderer.info);
    let grown = false;
    if (due.length > 0) {
      if (this.#targetWidth < targetWidth || this.#targetHeight < targetHeight) {
        this.#targetWidth = Math.max(this.#targetWidth, targetWidth);
        this.#targetHeight = Math.max(this.#targetHeight, targetHeight);
        renderer.setSize(this.#targetWidth, this.#targetHeight, false);
        grown = true;
      }
      for (const { view, width, height } of due) {
        const seconds = view.pending;
        view.pending = 0;
        this.drawView(renderer, view, width, height, seconds, nowMs);
      }
    }
    this.#drawnLastPass = due.length;
    this.#lastFrameMs = performance.now() - started;
    this.#drawn += 1;
    // The pass pays for the next one. Logged on the change and only on the change, so a settled
    // stage is silent and a thrashing one is not. Only a view that is actually animated or an actor
    // counts as representative; a static dirty redraw and an empty scenery tick must not steer
    // quality for the next redraw cadence. The first measured cold-start window is likewise not a
    // sustainable budget: texture upload and shader compilation are paid once, so they cannot by
    // themselves force the login below its native target.
    const representative = due.some(({ view }) => view.animated || Boolean(view.actor));
    if (representative) this.#qualityRepresentativePasses += 1;
    const cold = grown || glueColdPass(workBefore, glueRendererWork(renderer.info));
    const steeringReady = this.#qualityRepresentativePasses > GLUE_QUALITY_WARMUP_PASSES && !cold;
    const moved = this.#quality.sample(this.#lastFrameMs, nowMs, {
      representative,
      steeringReady,
      downStep: glueQualityEffectiveStep(this.#quality.step, 1, qualityViews, { dpr, subjects }) ?? null,
      upStep: glueQualityEffectiveStep(this.#quality.step, -1, qualityViews, { dpr, subjects }) ?? null,
    });
    if (moved) {
      const drawnPixels = due.reduce((sum, item) => sum + item.width * item.height, 0);
      this.#options.onDiagnostic?.(
        `Качество 3D: ступень «${moved.name}» (${this.#quality.step}/${GLUE_QUALITY_STEPS.length - 1}), `
        + `проход ${this.#quality.passMs.toFixed(1)} мс при цели ${GLUE_QUALITY_TARGET_MS} мс `
        + `(due ${due.length}/${this.#views.size}, ${drawnPixels} px)`);
    }
  }

  /**
   * Stand somebody in one widget's backdrop scene, or take them out again.
   *
   * Returns false when the widget has no live view yet — the backdrop is still on the wire — so the
   * caller can try again on the next reconcile rather than leaking the object it built.
   */
  setActor(frame: FrameXmlFrame, actor: GlueStageActor | undefined): boolean {
    const view = this.#views.get(frame);
    if (!view) return false;
    if (view.actor === actor) return true;
    if (view.actor) {
      view.scene.remove(view.actor.root);
      view.actor.dispose();
    }
    view.actor = actor;
    view.dirty = true;
    if (actor) {
      view.scene.add(actor.root);
      this.placeActor(view, actor);
    }
    return true;
  }

  /** Whether a widget has a scene to stand somebody in yet. */
  hasView(frame: FrameXmlFrame): boolean {
    return this.#views.has(frame);
  }

  /**
   * Backdrop diagonal FOV for the standing-figure aspect compensation.
   *
   * The figure's own model carries a portrait camera made for a different frame; the number that
   * matters here is the set's scene camera, read off the widget's live view.
   */
  backgroundFov(frameName: string): number | undefined {
    for (const view of this.#views.values()) {
      const fov = view.frame.name === frameName ? view.wvm?.sceneCamera?.fov : undefined;
      if (fov !== undefined && Number.isFinite(fov) && fov > 0) return (fov * 180) / Math.PI;
    }
    return undefined;
  }

  /** The backdrop currently loaded in one widget, so the caller can tell when it changed. */
  actorOf(frame: FrameXmlFrame): GlueStageActor | undefined {
    return this.#views.get(frame)?.actor;
  }

  dispose(): void {
    for (const view of this.#views.values()) this.dropView(view);
    this.#views.clear();
    this.#wvmCache.clear();
    this.#animationCache.clear();
    this.#textures.clear();
    this.#atlases?.dispose();
    this.#atlases = undefined;
    this.#unsettledTextures = [];
    this.#failedSources.clear();
    this.#renderer?.dispose();
    this.#renderer = undefined;
    this.#targetWidth = 0;
    this.#targetHeight = 0;
    this.#qualityRepresentativePasses = 0;
  }

  /**
   * One texture, and a note to look at it again once the loader has an answer.
   *
   * `ModelTextureLoader` is fire-and-forget and answers a failed fetch with one opaque white pixel,
   * which is the right answer for a hair card and the wrong one for a full-screen quad. Everything
   * this stage asks for is recorded here so that {@link sweepTextureFailures} can find out which
   * ones the gateway refused.
   */
  private loadTexture(url: string): THREE.Texture {
    const texture = this.#textures.load(url);
    if (this.#textures.status(texture) === "failed") this.#failedSources.add(texture.source);
    else if (this.#textures.status(texture) === "pending") this.#unsettledTextures.push(texture);
    return texture;
  }

  /** Move every texture that has settled since the last call out of the pending list. */
  private sweepTextureFailures(): void {
    if (this.#unsettledTextures.length === 0) return;
    const stillPending: THREE.Texture[] = [];
    for (const texture of this.#unsettledTextures) {
      const status = this.#textures.status(texture);
      if (status === "pending") stillPending.push(texture);
      else if (status === "failed") this.#failedSources.add(texture.source);
    }
    this.#unsettledTextures = stillPending;
  }

  /**
   * Leave the batches and emitters whose texture never arrived out of the frame.
   *
   * G3 already did this for a batch with no texture *slot* at all, for the reason that still
   * applies: a white sheet across the art is further from the original than nothing. A slot that
   * names a file the chain does not have ends up in exactly the same place — the loader's opaque
   * white pixel — and it is the one the owner's login screen actually hits. Measured before this,
   * at 1280x768: the two `8fx_generic_shadow_debuff` widgets covered **49.9%** and **39.7%** of the
   * screen and put **8.6%** and **8.4%** of it under flat bright grey.
   *
   * The masked materials are remembered rather than only switched off, because
   * `updateBatchAppearance` writes `visible` from the file's own opacity track every frame and
   * would hand a missing texture the screen back on the next one.
   */
  private hideFailedBatches(view: ModelView): void {
    const failed = (material: THREE.Material): boolean => {
      const map = (material as THREE.Material & { map?: THREE.Texture | null }).map;
      return !map || this.#failedSources.has(map.source);
    };
    let hidden = 0;
    for (const material of view.built?.materials ?? []) {
      if (view.masked.includes(material) || !failed(material)) continue;
      material.visible = false;
      view.masked.push(material);
      hidden += 1;
    }
    for (const emitter of view.effects?.emitters ?? []) {
      if (!emitter.mesh.visible || !failed(emitter.material)) continue;
      emitter.mesh.visible = false;
      hidden += 1;
    }
    if (hidden > 0) {
      this.#options.onDiagnostic?.(
        `${view.path}: ${hidden} батчей/эмиттеров без текстуры — не рисуются`);
    }
  }

  /** The one GL context this page uses, made on the first model that actually wants it. */
  private renderer(): THREE.WebGLRenderer | undefined {
    if (this.#renderer || this.#rendererFailed) return this.#renderer;
    try {
      // `preserveDrawingBuffer` because every view copies the frame out with `drawImage`, and a
      // buffer the compositor is free to clear is a screen full of blank boxes.
      this.#renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      this.#renderer.setPixelRatio(1);
      this.#renderer.setClearColor(0x000000, 0);
      // A fresh context is at whatever size three made its canvas, so the guard in `drawView` must
      // not believe it is already at the last one's.
      this.#targetWidth = 0;
      this.#targetHeight = 0;
    } catch (error) {
      this.#rendererFailed = true;
      this.#options.onDiagnostic?.(`WebGL недоступен: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.#renderer;
  }

  private createView(frame: FrameXmlFrame, element: HTMLElement): ModelView | undefined {
    const document = element.ownerDocument;
    if (!document) return undefined;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-framexml-model-canvas", "true");
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none";
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    element.append(canvas);
    const scene = new THREE.Scene();
    // Made once and re-aimed, never added and removed: three compiles the light count into the
    // program, and a scene whose count changes recompiles every material it holds.
    const ambient = new THREE.AmbientLight(0xffffff, GLUE_LIGHT_INTENSITY_SCALE);
    const suns: THREE.DirectionalLight[] = [];
    for (let index = 0; index < GLUE_MAX_DIRECTIONAL_LIGHTS; index += 1) {
      const sun = new THREE.DirectionalLight(0xffffff, 0);
      sun.position.set(0.707, 0.707, 0);
      scene.add(sun);
      suns.push(sun);
    }
    scene.add(ambient);
    return {
      frame, element, canvas, context, scene, ambient, suns,
      camera: new THREE.PerspectiveCamera(45, 1, 0.05, 500),
      path: "", sourceKey: "", loadGeneration: 0, width: 0, height: 0, sequence: frame.model.sequence ?? 0,
      animationMs: 0, loading: false, failed: false, textureGeneration: -1, masked: [],
      // A ModelFFX is the screen it is declared as, so it is a subject before a single byte of its
      // model has arrived; a rig can only be known once the artifact is decoded, and coverage only
      // once the widget has a box.
      subject: glueViewIsSubject(frame.type, false), rigged: false, coverage: 0, mirrored: false,
      animated: true, boxWidth: 0, boxHeight: 0, pending: 0, signature: "", dirty: true,
    };
  }

  private dropView(view: ModelView): void {
    if (view.actor) {
      view.scene.remove(view.actor.root);
      view.actor.dispose();
      view.actor = undefined;
    }
    this.clearContent(view);
    view.canvas.remove();
  }

  private clearContent(view: ModelView): void {
    // The actor is deliberately left alone: `clearContent` also runs when the *backdrop* changes —
    // selecting a night elf after a human — and rebuilding the character's atlas and model for a
    // change of scenery would be a second of blank screen for nothing. It is re-placed against the
    // new scene on the next drawn frame and only disposed with the view itself.
    if (view.effects) {
      disposeModelEffects(view.effects);
      view.effects = undefined;
    }
    if (view.root) {
      view.scene.remove(view.root);
      view.root = undefined;
    }
    disposeSkinnedInstance(view.instance);
    view.instance = undefined;
    view.template = undefined;
    view.action = undefined;
    if (view.built) {
      view.built.geometry.dispose();
      for (const material of view.built.materials) material.dispose();
      for (const texture of view.built.ownedTextures) texture.dispose();
      view.built = undefined;
    }
    view.wvm = undefined;
    view.animationMs = 0;
    view.textureGeneration = -1;
    view.masked = [];
    view.rigged = false;
    // The next build's materials arrive with the sides the file authored, so the flip has to be
    // forgotten with them or it would be applied on top of itself.
    view.mirrored = false;
    view.scene.fog = null;
  }

  private model(path: string): Promise<WvmModel> {
    let pending = this.#wvmCache.get(path);
    if (pending) return pending;
    pending = (async () => {
      const response = await fetch(visualModelUrl(this.#options.gatewayOrigin, path));
      if (!response.ok) throw new Error(`${path}: шлюз ответил ${response.status}`);
      const data = await response.arrayBuffer();
      if (!isWvm9(data)) throw new Error(`${path}: артефакт не WVM9`);
      const wvm = decodeWvm9(data);
      // Once, here, rather than at every place a name becomes a URL: geometry batches and particle
      // emitters read the same slot table, and both were asking the gateway for the terminator and
      // whatever followed it. See `glueTextureName` for the nine slots this was measured on.
      let repaired = 0;
      let dropped = 0;
      for (const slot of wvm.textures) {
        const fixed = glueTextureName(slot.path);
        if (fixed === slot.path) continue;
        if (fixed === "") dropped += 1;
        else repaired += 1;
        slot.path = fixed;
      }
      if (repaired > 0 || dropped > 0) {
        this.#options.onDiagnostic?.(
          `${path}: имён текстур обрезано по нулевому байту — ${repaired}, `
          + `без расширения (не запрашиваются) — ${dropped}`);
      }
      return wvm;
    })();
    this.#wvmCache.set(path, pending);
    return pending;
  }

  private async loadInto(view: ModelView, path: string, generation: number, source?: GlueModelSource): Promise<void> {
    view.loading = true;
    try {
      const wvm = await this.model(path);
      // The widget may have been re-pointed or torn down while the bytes were in flight.
      const current = (): boolean => view.loadGeneration === generation && this.#views.get(view.frame) === view;
      if (!current()) return;
      const appearance = source?.appearance;
      let body: THREE.Texture | undefined;
      if (appearance && appearance.body.length > 0) {
        this.#atlases ??= new CharacterAtlasClient(this.#options.gatewayOrigin);
        body = await this.#atlases.compose(appearanceKey(appearance), appearance.body);
        if (!current()) return;
      }
      const anisotropy = this.#renderer?.capabilities.getMaxAnisotropy();
      const built = buildModel(wvm, {
        modelPath: path,
        geosets: figureGeosets(wvm, appearance), // 05.10-A7a-G 6.18: the world's boot choice; EVERY_GEOSET without an appearance
        ...(source ? { slots: characterSlots(source.textures ?? "", appearance) } : {}),
        ...(body ? { slotTextures: new Map([[TEXTURE_TYPE_BODY, body]]) } : {}),
        baseUrl: this.#options.gatewayOrigin,
        loadTexture: (url) => this.loadTexture(url),
        skinned: Boolean(wvm.skeleton),
        // The loader hands the *same* Texture object back for a URL it has already fetched, and a
        // login scene draws nine copies of one cloud. Without this the first view torn down would
        // dispose a texture the other eight are still sampling; the cache owns the bases and frees
        // them in `dispose`, while any private view this build makes stays this build's to free.
        borrowLoadedTextures: true,
        ...(anisotropy === undefined ? {} : { anisotropy }),
      });
      view.wvm = wvm;
      view.built = built;
      const rig = wvm.skeleton;
      const template = rig ? buildSkinnedTemplateFrom(built.geometry, rig, built.height) : undefined;
      if (template) {
        const instance = instantiateSkinned(template, built.materials);
        view.template = template;
        view.instance = instance;
        view.root = instance.root;
      } else {
        // A tenth of the client's models carry no bones at all, and most glue scenery is in that
        // tenth: the static path is the same one the world renderer uses for them.
        const mesh = new THREE.Mesh(built.geometry, built.materials);
        mesh.quaternion.copy(M2_TO_SCENE);
        mesh.frustumCulled = false;
        view.root = mesh;
      }
      view.scene.add(view.root);
      const effects = buildModelEffects(wvm, {
        baseUrl: this.#options.gatewayOrigin,
        loadTexture: (url) => this.loadTexture(url),
        disposeTextures: false,
        seed: 1 + (view.path.length % 977),
      });
      if (effects) {
        view.effects = effects;
        view.scene.add(effects.group);
      }
      // Once per build, over everything this view will ever draw: a widget canvas is composited
      // over the page, and light must not arrive as coverage. Silent, because it is what every
      // additive draw on a glue screen wants — see `glueDropAdditiveCoverage` for the measurement.
      for (const material of built.materials) glueDropAdditiveCoverage(material);
      for (const emitter of effects?.emitters ?? []) glueDropAdditiveCoverage(emitter.material);
      // Below every real generation, so the first drawn frame checks this build even when nothing
      // new settles afterwards. A batch whose slot the *client* fills — a glue widget names a file
      // and no display record, so `resolveSlot` returns "" — has no picture from the start and is
      // caught by the same pass as one whose fetch failed.
      view.textureGeneration = -1;
      // Now that the artifact is decoded, the two budget questions can be answered from it: whether
      // this view is somebody (a rig) and whether anything in it can move at all. Nine of the
      // owner's login views are `tu_clouds_01` cards with one static batch and no emitter — they
      // draw the same pixels every pass, and `frame()` now draws them once. The third question,
      // coverage, is the window's and is answered every pass in `frame()`.
      view.rigged = Boolean(rig);
      view.subject = glueViewIsSubject(view.frame.type, view.rigged, view.coverage);
      view.animated = Boolean(view.instance) || Boolean(view.effects)
        || built.animatedBatches.length > 0;
      view.dirty = true;
      this.playSequence(view);
    } catch (error) {
      if (view.loadGeneration !== generation || this.#views.get(view.frame) !== view) return;
      view.failed = true;
      this.#options.onDiagnostic?.(`Model ${path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (view.loadGeneration === generation) view.loading = false;
    }
  }

  /**
   * The clips the artifact held back, fetched only when the widget asks for one of them.
   *
   * **Why the login characters stood still.** `generate-visual-model.mjs` splits a model's clips at
   * publish time: `BASE_ANIMATION_NAMES` — Stand, Walk, Run, Jump, Swim, Death and the rest of
   * locomotion — travel inside the `.bin`, and everything else moves into the `.anim.bin` beside it
   * behind `/visual/animations`. The owner's scene asks for **220** on Archibald and **218** on
   * Morethan (`lgzg.lua` rows 2 and 3, and again in `updateModels`), and those two ids are
   * `CustomSpell08` and `CustomSpell06` in this build's `AnimationData.dbc` — neither is a base
   * name and neither has a `Fallback`, so `resolveAnimation` came back empty and the stage struck
   * clip 0. Read out of the client's own files: both models carry 218 and 220 inline in the M2
   * (Archibald 320 sequences, Morethan 373), so the poses exist — they were simply on the other
   * side of the split.
   *
   * **What it costs, measured on the owner's own artifacts.** Archibald's sidecar is 15.24 MiB and
   * holds 262 clips over 230 bones (91 ms to decode here); Morethan's is 20.56 MiB, 308 clips over
   * 251 bones (66-125 ms). Sequence 220 is 2.667 s long and so is 218. Two things follow. The fetch
   * is off the render path — `playSequence` strikes the base pose first and this re-strikes when
   * the real one arrives — and only the **one** clip that was asked for is built into the template
   * and kept, because `addSkinnedClips` builds every clip it is handed and a login screen has no
   * use for the other 261.
   *
   * The cache is therefore keyed on path *and* id and holds the matching clips rather than "having
   * added them to a template": each view builds its own `SkinnedTemplate`, so a second view
   * awaiting a promise that had already given its clips away would get none — the trap
   * `CharacterLab.ensureAnimation` records.
   */
  private async ensureAnimation(view: ModelView, path: string, wanted: number): Promise<void> {
    const template = view.template;
    if (!template || template.clips.has(wanted)) return;
    const key = `${path}|${wanted}`;
    const bones = template.parents.length;
    let pending = this.#animationCache.get(key);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(visualAnimationsUrl(this.#options.gatewayOrigin, path));
        if (!response.ok) throw new Error(`шлюз ответил ${response.status}`);
        const decoded = decodeWvaAnimations(await response.arrayBuffer(), bones);
        // Everything else decoded here is dropped with this scope: 262 built clips over 230 bones
        // is tens of megabytes of keyframes that no glue screen will ever strike.
        return decoded.filter((clip) => clip.animationId === wanted);
      })();
      this.#animationCache.set(key, pending);
    }
    try {
      const clips = await pending;
      // The widget may have been re-pointed or torn down while the bytes were in flight.
      if (view.template !== template || view.path !== path) return;
      if (clips.length === 0) {
        this.#options.onDiagnostic?.(`Анимации ${path}: секвенции ${wanted} нет в сайдкаре`);
        return;
      }
      if (addSkinnedClips(template, clips) > 0 && view.sequence === wanted) {
        this.strike(view);
        view.dirty = true;
      }
    } catch (error) {
      this.#options.onDiagnostic?.(
        `Анимации ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private playSequence(view: ModelView): void {
    const template = view.template;
    if (!view.instance || !template) return;
    // Ask for the held-back clips before striking, then strike whatever is available now: a figure
    // that stands in its base pose for one round-trip is better than one that never moves, and the
    // fetch re-strikes the moment the real pose is built.
    if (view.sequence > 0 && !template.clips.has(view.sequence) && view.path !== "") {
      void this.ensureAnimation(view, view.path, view.sequence);
    }
    this.strike(view);
  }

  /**
   * Strike the sequence the widget asked for, looped.
   *
   * `SetSequence` names an `AnimationData` id, so it is resolved the way the world resolves one —
   * through `resolveAnimation`, which walks the fallback chain — and only then falls back to
   * whatever the file's first clip is. The owner's scene asks for 220 and 218 on its two custom
   * characters and 0 on everything else; a doodad that has one clip and does not know its id would
   * otherwise stand still.
   */
  private strike(view: ModelView): void {
    const instance = view.instance;
    const template = view.template;
    if (!instance || !template) return;
    const wanted = view.sequence;
    const resolved = resolveAnimation(template.clips, [wanted])
      ?? (template.clips.has(0) ? 0 : template.clips.keys().next().value);
    const clip = resolved === undefined ? undefined : template.clips.get(resolved);
    if (!clip) return;
    if (view.action) view.action.stop();
    const action = instance.mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
    view.action = action;
    view.animationMs = 0;
  }

  private drawView(
    renderer: THREE.WebGLRenderer,
    view: ModelView,
    width: number,
    height: number,
    seconds: number,
    nowMs: number,
  ): void {
    if (view.width !== width || view.height !== height) {
      view.width = width;
      view.height = height;
      view.canvas.width = width;
      view.canvas.height = height;
    }

    this.applyState(view);
    if (view.instance) {
      view.instance.mixer.update(seconds);
      if (view.action) view.animationMs = view.action.time * 1000;
    }
    // What the file paints this batch *now*: colour, opacity and where the texture sits. The world
    // has advanced these every frame since WVM9; the stage was calling it once at time zero, inside
    // `buildModel`, and then leaving it — so every scrolling UV and every fading card on the login
    // screen was frozen on its first key. The scene is almost nothing but such cards: `lgzg.lua`
    // fills it with fog, smoke, cloud and lightshaft doodads. `animatedBatches` is already filtered
    // to the batches that actually move, so a model whose tracks are constants costs nothing.
    if (view.built) {
      updateBatchAppearance(view.built.animatedBatches, view.animationMs, nowMs);
      // …and a batch whose texture never arrived stays out, whatever its opacity track says.
      for (const material of view.masked) material.visible = false;
    }
    if (view.actor) {
      view.actor.mixer?.update(seconds);
      this.placeActor(view, view.actor);
    }

    this.placeCamera(view, width / height);
    if (view.instance && view.template) {
      view.instance.root.updateMatrixWorld(true);
      applyBillboardBones(view.instance, view.template, view.camera);
      view.instance.root.updateMatrixWorld(true);
      view.instance.skeleton.update();
    } else {
      view.root?.updateMatrixWorld(true);
    }
    if (view.effects) {
      billboardView(view.camera, this.#billboard);
      const inverses = view.template?.boneInverses;
      const bones = view.instance?.skeleton.bones;
      const fallback = view.root?.matrixWorld ?? new THREE.Matrix4();
      updateModelEffects(view.effects, seconds, {
        matrixFor: (bone) => {
          const target = bones?.[bone];
          const inverse = inverses?.[bone];
          if (!target || !inverse) return fallback.elements;
          return this.#boneMatrix.multiplyMatrices(target.matrixWorld, inverse).elements;
        },
        animationMs: view.animationMs,
        worldMs: nowMs,
      }, this.#billboard);
    }

    // The shared target is at least this big and is never resized here — see `frame()`. The view
    // takes a scissored rectangle in its **top-left** corner, which in GL's bottom-left coordinates
    // is `y = targetHeight - height`, so the blit below can read the image from (0, 0). The scissor
    // also means the per-view clear touches only this rectangle instead of the whole buffer.
    const bottom = Math.max(0, this.#targetHeight - height);
    renderer.setViewport(0, bottom, width, height);
    renderer.setScissor(0, bottom, width, height);
    renderer.setScissorTest(true);
    renderer.render(view.scene, view.camera);
    // Measured on twenty passes of the owner's thirty-two views: `clearRect` + `drawImage` and a
    // single `copy` composite both cost 0.9 ms across all of them, so the pair stays as it is.
    //
    // **The blit deliberately does not apply the widget's `SetAlpha`, and that was checked rather
    // than assumed.** `Model:SetAlpha` reaches the composite one level up, as
    // `element.style.opacity` on the widget the canvas lives in — measured live on the login screen,
    // all seven of `lgzg.lua`'s sub-unity rows arrive intact (0.702 x3, 0.573, 0.173, 0.286, 0.090).
    // The half worth doubting was whether CSS opacity scales *premultiplied superluminous* light,
    // the pixels `glueDropAdditiveCoverage` leaves behind, since those carry `P > 0` at `α = 0`.
    // Probed in this browser with a WebGL canvas drawn exactly as this one is — `SrcAlpha/One` RGB,
    // `Zero/One` alpha, one fragment of 0.8 grey, read back as premultiplied (204, 204, 204, 0) —
    // and blitted over an opaque 64-grey strip at opacities 1, 0.5 and 0.25, the strip reads 255,
    // 166 and 115: `64 + 204`, `64 + 102`, `64 + 51`. Linear, on the nose. Setting `globalAlpha`
    // here as well would square the authored alpha, not apply it.
    view.context.clearRect(0, 0, width, height);
    view.context.drawImage(renderer.domElement, 0, 0, width, height, 0, 0, width, height);
    view.dirty = false;
  }

  /** Push the widget's recorded 3D state onto the scene it owns. */
  private applyState(view: ModelView): void {
    const state = view.frame.model;
    const root = view.root;
    if (root) {
      // The literal number, sign and all. `lgzg.lua`'s scene carries negative scales — the clouds
      // are at −0.428 and one lightshaft at −1.118 — which in the original mirror the model rather
      // than disable it. Treating «not positive» as «no scale» put a cloud card on the screen at
      // scale 1 instead of 0.428, which is the white sheet that covered a third of the login
      // screen before this was read properly.
      const scale = (state.modelScale ?? 1) * (view.source?.displayScale ?? 1);
      root.scale.setScalar(scale !== undefined && Number.isFinite(scale) && scale !== 0 ? scale : 1);
      // …and mirroring it is only half the job: a negative uniform scale reverses every triangle's
      // winding, so a single-sided batch is culled away entirely unless its material is turned
      // inside out with it. See `glueScaleMirrors` for the nine cloud cards this was measured on.
      const mirrored = glueScaleMirrors(scale);
      if (mirrored !== view.mirrored) {
        view.mirrored = mirrored;
        const flipped = glueFlipMaterialSides(view.built?.materials ?? []);
        if (flipped > 0) {
          this.#options.onDiagnostic?.(
            `${view.path}: масштаб ${scale} зеркалит модель — ${flipped} материалов вывернуто`);
        }
      }
      // `SetPosition(x, y, z)` is in the model's own frame — x forward, y left, z up — and the
      // scene is Y-up, so it goes through the same swap every model instance does.
      const [x, y, z] = state.position ?? [0, 0, 0];
      root.position.set(x, z, -y);
      // `SetFacing` turns the model about its up axis, which is the scene's Y. The M2->scene
      // quarter turn is baked into the same quaternion for both paths: `instantiateSkinned` sets
      // it on the rig root and the static path sets it on the mesh, and both are this object.
      root.quaternion.setFromAxisAngle(UP, state.facing ?? 0).multiply(M2_TO_SCENE);
    }
    const lighting = glueSceneLighting(state);
    view.ambient.color.copy(lighting.ambient);
    view.ambient.intensity = lighting.ambientIntensity * GLUE_LIGHT_INTENSITY_SCALE;
    for (const [index, sun] of view.suns.entries()) {
      const light = lighting.directional[index];
      if (!light) {
        sun.intensity = 0;
        continue;
      }
      sun.color.copy(light.diffuse);
      sun.intensity = light.diffuseIntensity * GLUE_LIGHT_INTENSITY_SCALE;
      // A directional light in three points from its position at the origin, so the authored
      // direction is walked backwards to put the lamp where the light comes from.
      sun.position.copy(light.direction).multiplyScalar(-10);
    }
    // ModelFFX's fog is a real distance fog on the widget's own scene, not a tint over it.
    const near = state.fogNear;
    const far = state.fogFar;
    if (near !== undefined && far !== undefined && far > near) {
      const colour = state.fogColor ?? { r: 0, g: 0, b: 0, a: 1 };
      if (view.scene.fog instanceof THREE.Fog) {
        view.scene.fog.near = near;
        view.scene.fog.far = far;
        view.scene.fog.color.setRGB(colour.r, colour.g, colour.b);
      } else {
        view.scene.fog = new THREE.Fog(new THREE.Color(colour.r, colour.g, colour.b), near, far);
      }
    } else if (view.scene.fog) {
      view.scene.fog = null;
    }
  }

  /**
   * Put the actor where the backdrop says somebody stands, facing the camera.
   *
   * Recomputed each drawn frame rather than cached, because both inputs move: the backdrop can be
   * swapped under the actor when another character is selected, and the facing comes from the drag.
   * Two vector reads and a quaternion, at 30 Hz, for one object.
   */
  private placeActor(view: ModelView, actor: GlueStageActor): void {
    const wvm = view.wvm;
    if (!wvm) return;
    const stand = glueStandPoint(wvm);
    if (!stand) return;
    // Model space is x forward, y left, z up; the scene is Y-up. The same swap `applyState` makes.
    actor.root.position.set(stand[0], stand[2], -stand[1]);
    // Facing the viewer is the default, and the authored camera is the only thing in the file that
    // says where the viewer is. `SetCharacterSelectFacing` turns the character from there.
    const eye = wvm.sceneCamera?.position;
    const base = eye ? Math.atan2(eye[1] - stand[1], eye[0] - stand[0]) : 0;
    const angle = base + (actor.facingDegrees * Math.PI) / 180;
    actor.root.quaternion.setFromAxisAngle(UP, angle).multiply(M2_TO_SCENE);
  }

  /**
   * Frame the model the way it was authored to be framed.
   *
   * A glue set carries its own camera and G1 put it on the wire — measured, `UI_MainMenu` at 86°
   * and `UI_Human` at 80°, with positions and targets — so `portraitCameraSpec` reads it out of the
   * same 36-byte record it reads a portrait camera from, in the same model space.
   *
   * The six `UI_RS_*` sets carry no camera at all (measured in G1), and neither does any doodad the
   * owner's scene uses, so those get a bounds framing instead: the whole model inside a 45° cone,
   * looked at along the model's own forward axis. `portraitCameraSpec`'s fallback is not the right
   * one here — it aims at a face and frames a bust, which is what a unit portrait wants and not
   * what a scene does.
   */
  private placeCamera(view: ModelView, aspect: number): void {
    const wvm = view.wvm;
    if (!wvm) return;
    const camera = view.camera;
    if (view.source?.fitBody) {
      const bounds = new THREE.Box3().setFromObject(view.root ?? view.scene);
      const size = bounds.getSize(new THREE.Vector3());
      const centre = bounds.getCenter(new THREE.Vector3());
      const vertical = Math.PI / 8;
      const horizontal = Math.atan(Math.tan(vertical) * Math.max(0.1, aspect));
      const radius = Math.max(0.2, size.length() / 2);
      const distance = Math.max(radius / Math.sin(Math.min(vertical, horizontal)), 0.5) * 1.1;
      camera.fov = 45;
      camera.near = Math.max(0.01, distance * 0.01);
      camera.far = distance * 8 + radius * 4;
      camera.position.copy(centre).add(new THREE.Vector3(distance, 0, 0));
      camera.lookAt(centre);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      return;
    }
    const composed = view.frame.model.position !== undefined
      || view.frame.model.modelScale !== undefined;
    if (composed && !wvm.sceneCamera) {
      // A widget the corpus has *placed* is composed against the Model frame's own fixed camera,
      // not framed to fit: `lgzg.lua` puts thirty models in one scene with `SetPosition` depths
      // from +1.5 to −24 and scales from 0.007 to 3.9, and a camera that refits itself to each
      // model's bounds throws that composition away — every one of them ends up filling the screen.
      // So the camera stands still and the models move in front of it, which is the shape the
      // authored numbers are written in.
      camera.fov = GLUE_MODEL_CAMERA_FOV;
      camera.near = 0.05;
      camera.far = 500;
      camera.position.set(GLUE_MODEL_CAMERA_DISTANCE, 0, 0);
      camera.lookAt(0, 0, 0);
    } else if (wvm.sceneCamera) {
      const spec = portraitCameraSpec({ camera: wvm.sceneCamera, bounds: wvm.bounds });
      camera.fov = glueSceneVerticalFov(spec.fov, aspect);
      camera.near = spec.near;
      camera.far = spec.far;
      camera.position.set(...spec.position);
      camera.lookAt(...spec.target);
    } else {
      const { min, max } = wvm.bounds;
      const centre: [number, number, number] = [
        (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2,
      ];
      const radius = Math.max(0.2, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
      camera.fov = 45;
      const distance = radius / Math.tan((camera.fov / 2) * Math.PI / 180) * 1.15;
      camera.near = Math.max(0.01, distance * 0.01);
      camera.far = distance * 8 + radius * 4;
      camera.position.set(centre[0] + distance, centre[2], -centre[1]);
      camera.lookAt(centre[0], centre[2], -centre[1]);
    }
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The frame a glue backdrop was authored for. 1024x768 — the client's own default resolution and
 * the one `GLUE_LOGICAL_HEIGHT` is taken from.
 */
export const GLUE_AUTHORED_ASPECT = 4 / 3;

/** Past this aspect the figure compensation holds its 16:9 value; ultrawide is out of scope. */
export const GLUE_FIGURE_COMPENSATION_MAX_ASPECT = 16 / 9;

/**
 * How much smaller a standing figure draws past 4:3, so it keeps its authored size.
 *
 * The backdrop camera's cover rule narrows the vertical field as the viewport widens, and a
 * figure on its authored mark grows with it: a human fills ~60% of the frame at 4:3 and ~78%
 * at 16:9. Scaling the actor by the current-to-authored vertical ratio holds the angular size
 * while the sky stays fully covered — feet planted on the mark, nothing reframed. 4:3 and
 * narrower read exactly 1, because the cover rule does not narrow there either.
 */
export function glueFigureScaleCompensation(diagonalDegrees: number, aspect: number): number {
  if (!Number.isFinite(diagonalDegrees) || !Number.isFinite(aspect) || aspect <= 0) return 1;
  const framed = Math.min(Math.max(aspect, GLUE_AUTHORED_ASPECT), GLUE_FIGURE_COMPENSATION_MAX_ASPECT);
  const authored = glueSceneVerticalFov(diagonalDegrees, GLUE_AUTHORED_ASPECT);
  const current = glueSceneVerticalFov(diagonalDegrees, framed);
  if (!(authored > 0) || !(current > 0)) return 1;
  return current / authored;
}

/**
 * The vertical field of view a backdrop wants, in degrees, for a viewport of this aspect.
 *
 * **The authored `fov` is a diagonal.** Read as three.js' vertical it made the whole sky a
 * hard-edged rectangle floating in black: `UI_Human` publishes 80°, and its sky is a single
 * four-vertex quad (batch 5, submesh 22, blend `opaque`, flags `UNLIT|UNFOGGED`) that reaches only
 * **26.09° above** the camera's aim and 34.09°/34.95° to the sides — so an 80° *vertical* frustum
 * drew 40° of nothing above a quad that stops at 26. Measured in the live page at 1280x720 before
 * this: the quad's top edge landed at y=94 of a 450-pixel screenshot, exactly where
 * `0.489/0.839` of the half-height puts it.
 *
 * Diagonal is the reading that fits the data. At 4:3 a diagonal half-tangent splits into
 * `0.8` horizontal and `0.6` vertical, so 80° gives 33.87° horizontal and 26.72° vertical — and
 * `UI_Human`'s sky covers 34.09/34.95 and 26.09. The other three backdrops whose sky is a plain
 * quad agree: `UI_Dwarf` 65° wants 27.01/20.92 and covers 27.74/27.76 and 23.41, `UI_Tauren` 65°
 * covers 28.53/29.12 and 22.14, `UI_NightElf` 60° wants 24.79/19.11 and covers 23.37/23.48 and
 * 25.36. Every one is within a degree and a half of the authored frame, which no other reading of
 * `fov` comes close to.
 *
 * The rule for other aspects is **cover**: the visible frustum stays inside the authored 4:3 frame
 * on both axes, so the backdrop always fills the widget's box. Wider than 4:3 keeps the authored
 * horizontal angle and loses vertical; narrower keeps the vertical and loses horizontal. Anything
 * else shows the edge of a painted sky, which is the defect this replaces.
 */
export function glueSceneVerticalFov(diagonalDegrees: number, aspect: number): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : GLUE_AUTHORED_ASPECT;
  const diagonal = Math.tan((Math.max(1, Math.min(179, diagonalDegrees)) / 2) * Math.PI / 180);
  const authoredVertical = diagonal / Math.hypot(1, GLUE_AUTHORED_ASPECT);
  const authoredHorizontal = authoredVertical * GLUE_AUTHORED_ASPECT;
  const vertical = Math.min(authoredVertical, authoredHorizontal / safeAspect);
  return 2 * Math.atan(vertical) * 180 / Math.PI;
}

/**
 * Where the character stands relative to the backdrop's own camera, in yards.
 *
 * Both numbers are measured off this client's data, and the shape of the rule is measured too.
 * Four of the ten `Interface\Glues\Models\UI_*` backdrops carry bones — and therefore an attachment
 * table — and all four put point 0 on the ground the character stands on. Read against each set's
 * authored camera, those four marks say the same three things:
 *
 * 1. **The mark is on the camera's aim direction.** Projected onto the ground plane, the vector
 *    camera→mark is parallel to camera→target in every one of the four. `UI_BloodElf` is the
 *    clearest, because its camera is not axis-aligned: camera→target is (7.210, −5.321) and
 *    camera→mark is (4.556, −3.361), both bearing −36.4°.
 * 2. **It stands about 4.8 yards from the camera.** Ground distances: Scourge 3.80, Draenei 4.74,
 *    Dwarf 4.79, BloodElf 5.66 — median 4.79, and the constant below.
 * 3. **The camera aims about 1.13 yards above it.** Target z minus mark z: Draenei 0.925,
 *    Scourge 1.126, Dwarf 1.131, BloodElf 1.205 — median 1.129. The camera looks at the figure's
 *    chest, not at its feet.
 *
 * The aim point itself is *not* where the character stands: it runs 4.73 to 8.96 yards out, because
 * the author pointed the camera past the figure at the scenery behind it. Standing a character
 * there put a human 8.93 yards away in `UI_Human` and half the size it should be — measured in the
 * live page before this rule replaced it.
 *
 * The six boneless sets — Human, Orc, NightElf, Tauren, DeathKnight and the main menu, which have
 * no attachment table at all and so *cannot* carry a mark — are placed by the rule. The residual is
 * the spread above: 3.8 to 5.7 yards over the four that can be checked. Pinning it exactly needs a
 * screenshot from a running 3.3.5 client, which is the owner's gate.
 */
export const GLUE_STAND_DISTANCE = 4.79;
export const GLUE_STAND_AIM_HEIGHT = 1.13;

/** Attachment id 0 on a glue backdrop: the mark the character stands on. */
const GLUE_STAND_ATTACHMENT = 0;

/**
 * Where a character stands in one backdrop scene, in the model's own space.
 *
 * Exported for the test: which branch a given set takes is a property of the client's data rather
 * than of this code, and the second branch is the derivation documented above.
 */
export function glueStandPoint(wvm: WvmModel): [number, number, number] | undefined {
  const mark = wvm.attachments.find((candidate) => candidate.id === GLUE_STAND_ATTACHMENT);
  if (mark) return [...mark.position];
  const camera = wvm.sceneCamera;
  if (camera) {
    const [ex, ey, ez] = camera.position;
    const [tx, ty, tz] = camera.target;
    const dx = tx - ex;
    const dy = ty - ey;
    const ground = Math.hypot(dx, dy);
    if (ground > 1e-4) {
      return [
        ex + (dx / ground) * GLUE_STAND_DISTANCE,
        ey + (dy / ground) * GLUE_STAND_DISTANCE,
        tz - GLUE_STAND_AIM_HEIGHT,
      ];
    }
    // A camera looking straight down or up has no ground bearing to walk along; the aim point,
    // dropped, is the only thing left. No set in this client does it.
    return [tx, ty, tz - GLUE_STAND_AIM_HEIGHT];
  }
  // No mark and no camera: the middle of the box, on its floor. Nothing in this client's glue sets
  // reaches here — all ten answer one of the two branches above — so it is a floor, not a path.
  const { min, max } = wvm.bounds;
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]];
}
