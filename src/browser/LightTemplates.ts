/**
 * 24.10 (7.50): a lamp model's lights as data, taken once from the model and placed at every
 * placement of it whether or not that placement has been built.
 *
 * Owner, 24.10: «Крайне сильно заметно, как источники света загораются при подгрузке». A fixture's
 * pool, halo and far glow came from its built placement (`modelFixtureLights` on the placement's
 * `wvm`), and placements build by a size leash and a per-frame budget — a hanging lantern at 90
 * yards, a lamp post at 245–305, later in a city whose build budget binds — so a light switched on
 * where its model did. A template is what the cinematic profile's heuristic and the model's own M2
 * lights give at the bind pose (`sampleFixtureLight` at time 0 through the identity), in model
 * space; `sampleLightTemplate` puts it where a placement stands and answers exactly what the built
 * placement's sample answers there (its tracks at time 0, its bones at rest, the same flicker).
 */
import * as THREE from "three";
import {
  FIXTURE_RADIUS_CAP, M2_LIGHT_RADIUS_CAP, fixtureFlicker, modelFixtureLights, sampleFixtureLight,
  type LocalLightSample,
} from "./LocalLighting.js";
import type { WvmModel } from "./Wvm.js";

/** One light of a model at its bind pose, in model space. */
export interface LightTemplate {
  readonly position: readonly [number, number, number];
  readonly colour: readonly [number, number, number];
  /** The fixture's reach before the placement's scale (the M2 light's `M2_LIGHT_REACH`). */
  readonly reach: number;
  /** Strength without the heuristic's flicker. */
  readonly intensity: number;
  /** A model's own M2 light: the client's falloff, no flicker (`sampleM2Light`). */
  readonly client: boolean;
}

const IDENTITY = new THREE.Matrix4();
const REST_FLICKER = fixtureFlicker(0, 0, 0, 0);

/** The cinematic profile's lights of `model` (named `name`) at the bind pose; empty for none. */
export function deriveLightTemplates(model: WvmModel, name: string): LightTemplate[] {
  const sample: LocalLightSample = { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 };
  const templates: LightTemplate[] = [];
  for (const fixture of modelFixtureLights(model, name, true)) {
    if (!sampleFixtureLight(fixture, model, IDENTITY, 0, 0, sample)) continue;
    const client = sample.client === true;
    templates.push({
      position: [fixture.position[0], fixture.position[1], fixture.position[2]],
      colour: [sample.colour.x, sample.colour.y, sample.colour.z],
      reach: client ? sample.radius : fixture.radius,
      intensity: client ? sample.intensity : sample.intensity / REST_FLICKER,
      client,
    });
  }
  return templates;
}

/** Whether a stored value is a template list (the persistent cache is read back untyped). */
export function validLightTemplates(value: unknown): value is LightTemplate[] {
  if (!Array.isArray(value) || value.length > 16) return false;
  const triple = (entry: unknown): boolean => Array.isArray(entry) && entry.length === 3
    && entry.every((number) => typeof number === "number" && Number.isFinite(number));
  return value.every((entry: Partial<LightTemplate> | null) => typeof entry === "object" && entry !== null
    && triple(entry.position) && triple(entry.colour) && typeof entry.reach === "number" && entry.reach > 0
    && typeof entry.intensity === "number" && Number.isFinite(entry.intensity) && typeof entry.client === "boolean");
}

/**
 * One template at a placement whose model-to-world matrix is `matrix`, at `worldMs` (the far glows
 * sample once, at 0): position, colour, reach and strength as `sampleFixtureLight` gives them for
 * the built placement.
 */
export function sampleLightTemplate(template: LightTemplate, matrix: THREE.Matrix4, worldMs: number,
  result: LocalLightSample): boolean {
  const e = matrix.elements;
  result.position.set(template.position[0], template.position[1], template.position[2]).applyMatrix4(matrix);
  result.colour.set(template.colour[0], template.colour[1], template.colour[2]);
  const scale = Math.max(Math.hypot(e[0]!, e[1]!, e[2]!), Math.hypot(e[4]!, e[5]!, e[6]!),
    Math.hypot(e[8]!, e[9]!, e[10]!));
  result.radius = Math.min(template.client ? M2_LIGHT_RADIUS_CAP : FIXTURE_RADIUS_CAP, template.reach * scale);
  result.intensity = template.client ? template.intensity
    : template.intensity * fixtureFlicker(e[12]!, e[13]!, e[14]!, worldMs);
  result.client = template.client;
  result.halo = true;
  return Number.isFinite(result.radius) && result.radius > 0 && Number.isFinite(result.intensity)
    && Number.isFinite(result.position.x) && Number.isFinite(result.position.y) && Number.isFinite(result.position.z);
}
