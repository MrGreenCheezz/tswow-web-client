/**
 * Stable identities used by the formal paired render benchmark.
 *
 * The renderer environment and the experiment configuration deliberately have
 * separate identities: changing a quality knob must not make a run look as if
 * it was made in a different browser/WebGL capability/runtime state. Hardware
 * identity is intentionally not collected.
 */

import {
  type BenchmarkEnvironmentMetadata,
  type BenchmarkJsonObject,
  type BenchmarkJsonValue,
  cloneBenchmarkEnvironment,
  RENDER_BENCHMARK_MANIFEST_VERSION,
} from "./BenchmarkManifest.js";

export interface BenchmarkRuntimeEnvironmentIdentity {
  readonly schemaVersion: typeof RENDER_BENCHMARK_MANIFEST_VERSION;
  readonly canvas: BenchmarkEnvironmentMetadata["canvas"];
  readonly browser: BenchmarkEnvironmentMetadata["browser"];
  readonly webgl: BenchmarkEnvironmentMetadata["webgl"];
}

export interface BenchmarkVariantConfiguration {
  readonly lighting: number;
  readonly settings: BenchmarkJsonObject;
}

export interface BenchmarkVariantKnobChange {
  readonly knobPath: string;
}

type JsonRecord = Record<string, unknown>;

const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function assertPlainJsonObject(path: string, value: unknown): asserts value is JsonRecord {
  if (!isObject(value) || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const ownNames = Object.getOwnPropertyNames(value);
  const enumerableNames = Object.keys(value);
  if (ownNames.length !== enumerableNames.length || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${path} must contain only enumerable string keys`);
  }
  for (const key of ownNames) {
    if (POLLUTION_KEYS.has(key)) throw new TypeError(`${path}.${key} is not allowed`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be a data property`);
    }
  }
}

function cloneOwnedJson(value: unknown, path: string, seen = new WeakSet<object>()): BenchmarkJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${path} must contain canonical finite JSON numbers`);
    }
    return value;
  }
  if (!isObject(value)) throw new TypeError(`${path} must be JSON-safe`);
  if (seen.has(value)) throw new TypeError(`${path} must not be cyclic`);
  seen.add(value);
  if (Array.isArray(value)) {
    const ownNames = Object.getOwnPropertyNames(value);
    if (ownNames.length !== value.length + 1 || Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError(`${path} must contain only dense indexed values`);
    }
    const copy = value.map((child, index) => {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new TypeError(`${path}[${index}] must be present`);
      }
      return cloneOwnedJson(child, `${path}[${index}]`, seen);
    });
    seen.delete(value);
    return Object.freeze(copy);
  }
  assertPlainJsonObject(path, value);
  const copy: Record<string, BenchmarkJsonValue> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: cloneOwnedJson(value[key], `${path}.${key}`, seen),
      writable: true,
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function freezeRuntimeIdentity(source: BenchmarkEnvironmentMetadata): BenchmarkRuntimeEnvironmentIdentity {
  const canvas = {
    cssWidth: source.canvas.cssWidth,
    cssHeight: source.canvas.cssHeight,
    backingWidth: source.canvas.backingWidth,
    backingHeight: source.canvas.backingHeight,
    systemDpr: source.canvas.systemDpr,
    effectivePixelRatio: source.canvas.effectivePixelRatio,
    renderScalePercent: source.canvas.renderScalePercent,
  };
  const browser = { name: source.browser.name, version: source.browser.version };
  const webgl = {
    version: source.webgl.version,
    shadingLanguageVersion: source.webgl.shadingLanguageVersion,
    extensions: Object.freeze([...source.webgl.extensions]),
    gpu: Object.freeze({
      vendor: Object.freeze({ status: "unsupported" as const, reason: "not-collected" as const }),
      renderer: Object.freeze({ status: "unsupported" as const, reason: "not-collected" as const }),
    }),
  };
  return Object.freeze({
    schemaVersion: source.schemaVersion,
    canvas: Object.freeze(canvas),
    browser: Object.freeze(browser),
    webgl: Object.freeze(webgl),
  });
}

/** Projects a validated environment to runtime/browser/GPU identity only. */
export function projectBenchmarkRuntimeEnvironment(input: unknown): BenchmarkRuntimeEnvironmentIdentity {
  return freezeRuntimeIdentity(cloneBenchmarkEnvironment(input));
}

/** Projects a validated environment to the variant knobs being compared. */
export function projectBenchmarkVariantConfiguration(input: unknown): BenchmarkVariantConfiguration {
  const source = cloneBenchmarkEnvironment(input);
  const settings = cloneOwnedJson(source.settings, "settings") as BenchmarkJsonObject;
  return Object.freeze({ lighting: source.lighting, settings });
}

function canonicalJson(value: BenchmarkJsonValue): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("benchmark identity is not JSON-safe");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

/** Canonical JSON for runtime environment identity; arrays retain their order. */
export function canonicalBenchmarkRuntimeEnvironmentJson(input: unknown): string {
  return canonicalJson(projectBenchmarkRuntimeEnvironment(input) as unknown as BenchmarkJsonValue);
}

/** Canonical JSON for A/B variant configuration identity. */
export function canonicalBenchmarkVariantConfigurationJson(input: unknown): string {
  return canonicalJson(projectBenchmarkVariantConfiguration(input) as unknown as BenchmarkJsonValue);
}

async function hashCanonicalJson(canonical: string): Promise<string> {
  const crypto = globalThis.crypto;
  if (crypto === undefined || crypto.subtle === undefined || typeof crypto.subtle.digest !== "function") {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 for runtime environment identity, using Web Crypto only. */
export function hashBenchmarkRuntimeEnvironment(input: unknown): Promise<string> {
  return hashCanonicalJson(canonicalBenchmarkRuntimeEnvironmentJson(input));
}

/** SHA-256 for the A/B variant configuration identity, using Web Crypto only. */
export function hashBenchmarkVariantConfiguration(input: unknown): Promise<string> {
  return hashCanonicalJson(canonicalBenchmarkVariantConfigurationJson(input));
}

function validateConfigurationProjection(input: unknown, name: string): BenchmarkVariantConfiguration {
  assertPlainJsonObject(name, input);
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "lighting" || keys[1] !== "settings") {
    throw new TypeError(`${name} must have exactly lighting and settings keys`);
  }
  if (typeof input.lighting !== "number" || !Number.isFinite(input.lighting) || Object.is(input.lighting, -0)) {
    throw new TypeError(`${name}.lighting must be a canonical finite number`);
  }
  assertPlainJsonObject(`${name}.settings`, input.settings);
  cloneOwnedJson(input.settings, `${name}.settings`);
  return input as unknown as BenchmarkVariantConfiguration;
}

function pathSegments(path: unknown): string[] {
  if (typeof path !== "string" || path.length === 0 || path.startsWith(".") || path.endsWith(".")) {
    throw new TypeError("allowlisted knob path must be a non-empty dot path");
  }
  const segments = path.split(".");
  if (segments.some((segment) => segment.length === 0 || POLLUTION_KEYS.has(segment))) {
    throw new TypeError("allowlisted knob path contains an unsafe segment");
  }
  return segments;
}

function valueAtPath(root: BenchmarkVariantConfiguration, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isObject(current) || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new TypeError(`allowlisted knob path is missing: ${segments.join(".")}`);
    }
    current = (current as JsonRecord)[segment];
  }
  if (isObject(current)) throw new TypeError("allowlisted knob must address an existing leaf");
  return current;
}

function sameShapeExcept(left: unknown, right: unknown, path: string, allowed: string): void {
  const atAllowed = path === allowed;
  if (atAllowed) {
    const leftType = left === null ? "null" : typeof left;
    const rightType = right === null ? "null" : typeof right;
    if (isObject(left) || isObject(right) || leftType !== rightType || Object.is(left, right)) {
      throw new TypeError("allowlisted knob must be the only changed leaf");
    }
    return;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    if (!Object.is(left, right)) throw new TypeError(`unexpected variant difference at ${path || "<root>"}`);
    return;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      throw new TypeError(`array shape differs at ${path || "<root>"}`);
    }
    for (let index = 0; index < left.length; index += 1) {
      sameShapeExcept(left[index], right[index], `${path}[${index}]`, allowed);
    }
    return;
  }
  assertPlainJsonObject(path || "configuration", left);
  assertPlainJsonObject(path || "configuration", right);
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
    throw new TypeError(`object shape differs at ${path || "<root>"}`);
  }
  for (const key of leftKeys) {
    sameShapeExcept(left[key], right[key], path ? `${path}.${key}` : key, allowed);
  }
}

/**
 * Proves that two already-projected configurations differ at exactly one
 * existing scalar leaf, named by the one-entry allowlist.
 */
export function validateBenchmarkVariantKnobChange(
  leftInput: unknown,
  rightInput: unknown,
  allowedKnobPaths: readonly string[],
): BenchmarkVariantKnobChange {
  if (!Array.isArray(allowedKnobPaths) || allowedKnobPaths.length !== 1) {
    throw new TypeError("exactly one allowlisted knob path is required");
  }
  const segments = pathSegments(allowedKnobPaths[0]);
  const left = validateConfigurationProjection(leftInput, "left configuration");
  const right = validateConfigurationProjection(rightInput, "right configuration");
  const leftValue = valueAtPath(left, segments);
  const rightValue = valueAtPath(right, segments);
  if (Object.is(leftValue, rightValue)) throw new TypeError("allowlisted knob did not change");
  sameShapeExcept(left, right, "", allowedKnobPaths[0]);
  return Object.freeze({ knobPath: allowedKnobPaths[0] });
}
