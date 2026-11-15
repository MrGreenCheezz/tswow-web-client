/**
 * 24.10 (7.50): a lamp model's lights as data, taken once from the model and placed at every
 * placement of it whether or not that placement has been built.
 *
 * Owner, 24.10: «Крайне сильно заметно, как источники света загораются при подгрузке». A fixture's
 * pool, halo and far glow came from its built placement (`modelFixtureLights` on the placement's
 * `wvm`), and placements build by a size leash and a per-frame budget — a hanging lantern at 90
 * yards, a lamp post at 245–305, later in a city whose build budget binds — so a light switched on
 * where its model did. A template is what the cinematic profile's heuristic and the model's own M2
 * lights give at the bind pose (`sampleFixtureLight` through the identity), in model space;
 * `sampleLightTemplate` puts it where a placement stands and answers exactly what the built
 * placement's sample answers there (its bones at rest, the same flicker).
 *
 * 15.11 (7.50): a light whose tracks are animated keeps them (`motion`, `LightTemplateMotion.ts`) and is
 * sampled at the moment asked, as the built lamp is on the same clock; before, every template was its
 * light at time 0, and a lamp dark at time 0 (`BE_LampPost_Ghostlands01.m2`, whose glow card blinks on
 * sequence 0 from 667 ms) had no template at all and switched on when its model was built.
 */
import * as THREE from "three";
import {
  FIXTURE_RADIUS_CAP, M2_LIGHT_RADIUS_CAP, fixtureFlicker, modelFixtureLights, sampleFixtureLight,
  type LocalLightSample,
} from "./LocalLighting.js";
import {
  emitterFixtureBase, fixtureMotion, motionMean, reviveLightMotion, sampleMotion, sampleMotionFar,
  type LightMotion, type MotionValue,
} from "./LightTemplateMotion.js";
import type { WvmModel } from "./Wvm.js";

/** One light of a model at its bind pose, in model space. */
export interface LightTemplate {
  readonly position: readonly [number, number, number];
  /** The colour; with `motion`, the base its tracks multiply (an M2 light's comes from its tracks alone). */
  readonly colour: readonly [number, number, number];
  /** The fixture's reach before the placement's scale (the M2 light's `M2_LIGHT_REACH`). */
  readonly reach: number;
  /** Strength without the heuristic's flicker; with `motion`, before its tracks. */
  readonly intensity: number;
  /** A model's own M2 light: the client's falloff, no flicker (`sampleM2Light`). */
  readonly client: boolean;
  /** 15.11 (7.50): the light's animated tracks, sampled at the moment asked; absent for a steady light. */
  readonly motion?: LightMotion;
}

const IDENTITY = new THREE.Matrix4();
const REST_FLICKER = fixtureFlicker(0, 0, 0, 0);

/** The cinematic profile's lights of `model` (named `name`) at the bind pose; empty for none. */
export function deriveLightTemplates(model: WvmModel, name: string): LightTemplate[] {
  const sample: LocalLightSample = { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 };
  const templates: LightTemplate[] = [];
  for (const fixture of modelFixtureLights(model, name, true)) {
    const position: [number, number, number] = [fixture.position[0], fixture.position[1], fixture.position[2]];
    const motion = fixtureMotion(fixture, model);
    if (motion) {
      // 15.11 (7.50): kept whether or not it is lit at time 0; the base is the fixture's own.
      const base = fixture.emitter ? emitterFixtureBase(fixture)
        : { colour: [fixture.colour[0], fixture.colour[1], fixture.colour[2]] as [number, number, number], intensity: fixture.intensity };
      if (!base) continue; // a flame whose own ramp leaves it dark never lights
      templates.push({ position, colour: base.colour, reach: fixture.radius, intensity: base.intensity,
        client: fixture.light !== undefined, motion });
      continue;
    }
    if (!sampleFixtureLight(fixture, model, IDENTITY, 0, 0, sample)) continue;
    const client = sample.client === true;
    templates.push({
      position,
      colour: [sample.colour.x, sample.colour.y, sample.colour.z],
      reach: client ? sample.radius : fixture.radius,
      intensity: client ? sample.intensity : sample.intensity / REST_FLICKER,
      client,
    });
  }
  return templates;
}

/**
 * A stored value as a template list (the persistent cache is read back untyped), its motions revived
 * with typed arrays; undefined when it is not one.
 */
export function reviveLightTemplates(value: unknown): LightTemplate[] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const triple = (entry: unknown): entry is [number, number, number] => Array.isArray(entry) && entry.length === 3
    && entry.every((number) => typeof number === "number" && Number.isFinite(number));
  const out: LightTemplate[] = [];
  for (const entry of value as (Partial<Record<keyof LightTemplate, unknown>> | null)[]) {
    if (typeof entry !== "object" || entry === null || !triple(entry.position) || !triple(entry.colour)
      || typeof entry.reach !== "number" || !(entry.reach > 0) || typeof entry.intensity !== "number"
      || !Number.isFinite(entry.intensity) || typeof entry.client !== "boolean") return undefined;
    const template: LightTemplate = { position: entry.position, colour: entry.colour, reach: entry.reach,
      intensity: entry.intensity, client: entry.client };
    if (entry.motion !== undefined) {
      const motion = reviveLightMotion(entry.motion);
      if (!motion) return undefined;
      out.push({ ...template, motion });
    } else out.push(template);
  }
  return out;
}

/** Whether a stored value is a template list. */
export function validLightTemplates(value: unknown): value is LightTemplate[] {
  return reviveLightTemplates(value) !== undefined;
}

/**
 * Where one template stands at a placement whose model-to-world matrix is `matrix`: position, reach,
 * falloff kind; colour and strength are the template's base (its flicker and tracks not applied).
 */
export function placeLightTemplate(template: LightTemplate, matrix: THREE.Matrix4, result: LocalLightSample): boolean {
  const e = matrix.elements;
  result.position.set(template.position[0], template.position[1], template.position[2]).applyMatrix4(matrix);
  result.colour.set(template.colour[0], template.colour[1], template.colour[2]);
  const scale = Math.max(Math.hypot(e[0]!, e[1]!, e[2]!), Math.hypot(e[4]!, e[5]!, e[6]!),
    Math.hypot(e[8]!, e[9]!, e[10]!));
  result.radius = Math.min(template.client ? M2_LIGHT_RADIUS_CAP : FIXTURE_RADIUS_CAP, template.reach * scale);
  result.intensity = template.intensity;
  result.client = template.client;
  result.halo = true;
  return Number.isFinite(result.radius) && result.radius > 0
    && Number.isFinite(result.position.x) && Number.isFinite(result.position.y) && Number.isFinite(result.position.z);
}

const moment: MotionValue = { colour: new THREE.Vector3(), intensity: 0 };

/**
 * A template's colour and unflickered strength at `ms` (animation and world time alike, the clock a built
 * doodad's light runs on): its tracks' answer with `motion`, else its stored values. False while dark.
 */
export function templateMoment(template: LightTemplate, ms: number, out: MotionValue): boolean {
  if (!template.motion) {
    out.colour.set(template.colour[0], template.colour[1], template.colour[2]);
    out.intensity = template.intensity;
    return true;
  }
  return sampleMotion(template.motion, template.colour, template.intensity, ms, ms, out);
}

/**
 * One template at a placement whose model-to-world matrix is `matrix`, at `worldMs`: position, colour,
 * reach and strength as `sampleFixtureLight` gives them for the built placement at that moment.
 */
export function sampleLightTemplate(template: LightTemplate, matrix: THREE.Matrix4, worldMs: number,
  result: LocalLightSample): boolean {
  if (!placeLightTemplate(template, matrix, result) || !templateMoment(template, worldMs, moment)) return false;
  const e = matrix.elements;
  result.colour.copy(moment.colour);
  result.intensity = template.client ? moment.intensity
    : moment.intensity * fixtureFlicker(e[12]!, e[13]!, e[14]!, worldMs);
  return Number.isFinite(result.intensity);
}

/**
 * 15.11 (7.50): the template's far glow sample at a placement: its light at time 0 when steady (as
 * `farLightSources` samples a built lamp), its period mean when animated (`motionMean`, computed once per
 * template; `sampleMotionFar`, as `sampleFixtureFarLight` gives the built lamp).
 */
export function sampleLightTemplateFar(template: LightTemplate, matrix: THREE.Matrix4, result: LocalLightSample): boolean {
  if (!template.motion) return sampleLightTemplate(template, matrix, 0, result);
  const mean = motionMean(template.motion, template.colour, template.intensity);
  return mean !== undefined && sampleMotionFar(mean, template.position, template.reach, template.client, matrix, result);
}
