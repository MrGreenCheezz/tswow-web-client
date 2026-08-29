/**
 * The first repeatable render benchmark contract.
 *
 * This module stays independent of browser globals and renderer ownership: callers supply live
 * values, and the helpers below only validate/copy those values into JSON-safe records.
 */

export const RENDER_BENCHMARK_MANIFEST_VERSION = 1 as const;

export interface BenchmarkPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BenchmarkWeather {
  readonly mode: "fine" | "rain";
  readonly intensity?: number;
}

interface ApprovedBenchmarkScenarioBase {
  readonly id: "goldshire-exterior" | "stormwind";
  readonly label: string;
  readonly status: "approved";
  readonly kind: "exterior";
  readonly mapId: number;
  readonly position: BenchmarkPosition;
  readonly halfMinute: number;
  readonly weather?: BenchmarkWeather;
}

export interface PendingFixtureBenchmarkScenario extends ApprovedBenchmarkScenarioBase {
  /** Formal gating stays disabled until a reviewed replay artifact pins both identities. */
  readonly fixtureStatus: "pending";
}

export interface PinnedFixtureBenchmarkScenario extends ApprovedBenchmarkScenarioBase {
  readonly fixtureStatus: "approved";
  readonly snapshotHash: string;
  readonly frameOrderHash: string;
}

export type ApprovedBenchmarkScenario =
  | PendingFixtureBenchmarkScenario
  | PinnedFixtureBenchmarkScenario;

export interface PendingBenchmarkScenario {
  readonly id: "interior" | "underwater" | "rain";
  readonly label: string;
  readonly status: "pending";
  readonly kind: "interior" | "underwater" | "rain";
  /** No coordinates are implied until a real fixture is supplied. */
  readonly pendingReason: "coordinates-not-provided";
  readonly weather?: BenchmarkWeather;
}

export type BenchmarkScenario = ApprovedBenchmarkScenario | PendingBenchmarkScenario;

export interface BenchmarkProfile {
  readonly canvas: {
    readonly cssWidth: 1920;
    readonly cssHeight: 1080;
    readonly backingWidth: 1920;
    readonly backingHeight: 1080;
    readonly systemDpr: 1;
    readonly effectivePixelRatio: 1;
    readonly renderScalePercent: 100;
  };
  readonly lighting: 1;
  readonly warmRunSeconds: 90;
  readonly pairedAlternatingRuns: 5;
  readonly coldRunComparison: "separate-only";
  readonly replayRequirements: {
    readonly halfMinute: "fixed";
    readonly time: "fixed";
    readonly weather: "fixed";
    readonly rngSeed: "fixed";
    readonly cameraPath: "fixed";
    readonly frameOrder: "fixed";
  };
}

export interface BenchmarkManifest {
  readonly version: typeof RENDER_BENCHMARK_MANIFEST_VERSION;
  readonly profile: BenchmarkProfile;
  readonly scenarios: readonly BenchmarkScenario[];
}

const benchmarkManifest: BenchmarkManifest = {
  version: RENDER_BENCHMARK_MANIFEST_VERSION,
  profile: {
    canvas: {
      cssWidth: 1920,
      cssHeight: 1080,
      backingWidth: 1920,
      backingHeight: 1080,
      systemDpr: 1,
      effectivePixelRatio: 1,
      renderScalePercent: 100,
    },
    lighting: 1,
    warmRunSeconds: 90,
    pairedAlternatingRuns: 5,
    coldRunComparison: "separate-only",
    replayRequirements: {
      halfMinute: "fixed",
      time: "fixed",
      weather: "fixed",
      rngSeed: "fixed",
      cameraPath: "fixed",
      frameOrder: "fixed",
    },
  },
  scenarios: [
    {
      id: "goldshire-exterior",
      label: "Goldshire exterior",
      status: "approved",
      fixtureStatus: "pending",
      kind: "exterior",
      mapId: 0,
      position: { x: -9461.82, y: 63.31, z: 56.23 },
      halfMinute: 1440,
      weather: { mode: "fine" },
    },
    {
      id: "stormwind",
      label: "Stormwind",
      status: "approved",
      fixtureStatus: "pending",
      kind: "exterior",
      mapId: 0,
      position: { x: -8913.25, y: 554.5, z: 93.75 },
      halfMinute: 1440,
      weather: { mode: "fine" },
    },
    {
      id: "interior",
      label: "Interior",
      status: "pending",
      kind: "interior",
      pendingReason: "coordinates-not-provided",
    },
    {
      id: "underwater",
      label: "Underwater",
      status: "pending",
      kind: "underwater",
      pendingReason: "coordinates-not-provided",
    },
    {
      id: "rain",
      label: "Rain",
      status: "pending",
      kind: "rain",
      pendingReason: "coordinates-not-provided",
      weather: { mode: "rain", intensity: 0.7 },
    },
  ],
};

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Versioned benchmark inputs; every nested record is frozen. */
export const RENDER_BENCHMARK_MANIFEST = deepFreeze(benchmarkManifest);

export type BenchmarkJsonPrimitive = string | number | boolean | null;
export type BenchmarkJsonValue =
  | BenchmarkJsonPrimitive
  | readonly BenchmarkJsonValue[]
  | { readonly [key: string]: BenchmarkJsonValue };
export type BenchmarkJsonObject = { readonly [key: string]: BenchmarkJsonValue };

export interface BenchmarkEnvironmentInput {
  readonly canvas: {
    /** CSS layout size consumed by WorldRenderer3D.setSize(). */
    readonly cssWidth: number;
    readonly cssHeight: number;
    /** The drawing-buffer size actually owned by the canvas. */
    readonly backingWidth: number;
    readonly backingHeight: number;
    /** The browser-reported DPR, before the renderer's two-pixel cap. */
    readonly systemDpr: number;
    /** The renderer pixel ratio, or an explicit unsupported marker when no renderer exists. */
    readonly effectivePixelRatio: number | "unsupported";
    readonly renderScalePercent: number;
  };
  /** Effective quality supplied by the live renderer; settings remain included separately. */
  readonly lighting?: number;
  readonly browser: {
    readonly name: string;
    readonly version: string;
  };
  readonly webgl: {
    readonly version: string;
    readonly shadingLanguageVersion: string;
    readonly extensions: readonly string[];
  };
  readonly settings: BenchmarkJsonObject;
}

/** The renderer-owned portion of a live environment capture. */
export interface BenchmarkRendererEnvironment {
  readonly canvas: BenchmarkEnvironmentInput["canvas"];
  readonly lighting: number;
  readonly webgl: BenchmarkEnvironmentInput["webgl"];
}

export type BenchmarkCanvasEnvironment = BenchmarkEnvironmentInput["canvas"];

export interface UnsupportedGpuMetadata {
  readonly status: "unsupported";
  readonly reason: "not-collected";
}

export interface BenchmarkEnvironmentMetadata {
  readonly schemaVersion: typeof RENDER_BENCHMARK_MANIFEST_VERSION;
  readonly canvas: BenchmarkEnvironmentInput["canvas"];
  readonly lighting: number;
  readonly browser: BenchmarkEnvironmentInput["browser"];
  readonly webgl: {
    readonly version: string;
    readonly shadingLanguageVersion: string;
    readonly extensions: readonly string[];
    readonly gpu: {
      readonly vendor: UnsupportedGpuMetadata;
      readonly renderer: UnsupportedGpuMetadata;
    };
  };
  readonly settings: BenchmarkJsonObject;
}

export interface BenchmarkWebGlSource {
  readonly VERSION: number;
  readonly SHADING_LANGUAGE_VERSION: number;
  getParameter(parameter: number): unknown;
  getSupportedExtensions(): readonly string[] | null;
}

/** The renderer caps the browser DPR at two before applying the render-scale setting. */
export function benchmarkEffectivePixelRatio(systemDpr: number, renderScalePercent: number): number {
  const dpr = finiteValue("systemDpr", systemDpr);
  const scale = finiteValue("renderScalePercent", renderScalePercent) / 100;
  if (dpr <= 0) throw new RangeError("systemDpr must be positive");
  return Math.min(dpr, 2) * Math.max(0.5, Math.min(1, scale));
}

const UNSUPPORTED_WEBGL_VALUE = "unsupported";

/** Reads only non-fingerprinting WebGL capability strings required by the benchmark record. */
export function captureBenchmarkWebGl(
  context: BenchmarkWebGlSource | undefined,
): BenchmarkEnvironmentInput["webgl"] {
  if (!context) {
    return { version: UNSUPPORTED_WEBGL_VALUE, shadingLanguageVersion: UNSUPPORTED_WEBGL_VALUE, extensions: [] };
  }
  const parameter = (value: number): string => {
    try {
      const result = context.getParameter(value);
      return typeof result === "string" ? result : UNSUPPORTED_WEBGL_VALUE;
    } catch {
      return UNSUPPORTED_WEBGL_VALUE;
    }
  };
  let extensions: readonly string[] = [];
  try {
    const supported = context.getSupportedExtensions();
    extensions = supported === null
      ? []
      : supported
        .filter((extension): extension is string => typeof extension === "string")
        .sort();
  } catch {
    // A lost context can reject both capability queries; keep the rest of the live record useful.
  }
  return Object.freeze({
    version: parameter(context.VERSION),
    shadingLanguageVersion: parameter(context.SHADING_LANGUAGE_VERSION),
    extensions: Object.freeze(extensions),
  });
}

/** Best-effort browser identity from the UA supplied by the caller; no additional fingerprinting. */
export function benchmarkBrowserFromUserAgent(userAgent: string): BenchmarkEnvironmentInput["browser"] {
  const ua = stringValue("browser.userAgent", userAgent);
  const patterns: readonly [name: string, expression: RegExp][] = [
    ["Edge", /EdgA?\/([\d.]+)/i],
    ["Edge", /EdgiOS\/([\d.]+)/i],
    ["Opera", /OPR\/([\d.]+)/i],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/i],
    ["Firefox", /Firefox\/([\d.]+)/i],
    ["Firefox", /FxiOS\/([\d.]+)/i],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/i],
    ["Safari", /Version\/([\d.]+).*Safari\//i],
  ];
  for (const [name, expression] of patterns) {
    const match = expression.exec(ua);
    if (match?.[1]) return { name, version: match[1] };
  }
  return { name: "Unknown", version: "unknown" };
}

function stringValue(name: string, value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function finiteValue(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function nonNegativeValue(name: string, value: unknown): number {
  const result = finiteValue(name, value);
  if (result < 0) throw new RangeError(`${name} must be non-negative`);
  return result;
}

function objectValue(name: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(name: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function cloneJson(value: BenchmarkJsonValue, path: string, seen = new WeakSet<object>()): BenchmarkJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finiteValue(path, value);
  if (typeof value !== "object") throw new TypeError(`${path} must be JSON-safe`);
  if (seen.has(value)) throw new TypeError(`${path} must not be cyclic`);
  seen.add(value);

  if (Array.isArray(value)) {
    const copy = value.map((child, index) => cloneJson(child, `${path}[${index}]`, seen));
    seen.delete(value);
    return Object.freeze(copy);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain plain JSON objects`);
  }
  const copy: Record<string, BenchmarkJsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: cloneJson(child, `${path}.${key}`, seen),
      writable: true,
    });
  }
  seen.delete(value);
  return Object.freeze(copy);
}

/**
 * Captures only caller-provided runtime/capability values. GPU vendor and renderer are intentionally
 * explicit `unsupported`; this identity must not be treated as hardware identity.
 */
export function captureBenchmarkEnvironment(
  input: BenchmarkEnvironmentInput,
): DeepReadonly<BenchmarkEnvironmentMetadata> {
  const source = objectValue("environment", input);
  const canvasInput = objectValue("canvas", source.canvas);
  const effectivePixelRatio: number | "unsupported" = canvasInput.effectivePixelRatio === UNSUPPORTED_WEBGL_VALUE
    ? (UNSUPPORTED_WEBGL_VALUE as "unsupported")
    : finiteValue("canvas.effectivePixelRatio", canvasInput.effectivePixelRatio);
  if (effectivePixelRatio !== UNSUPPORTED_WEBGL_VALUE && effectivePixelRatio <= 0) {
    throw new RangeError("canvas.effectivePixelRatio must be positive");
  }
  const canvas = {
    cssWidth: nonNegativeValue("canvas.cssWidth", canvasInput.cssWidth),
    cssHeight: nonNegativeValue("canvas.cssHeight", canvasInput.cssHeight),
    backingWidth: nonNegativeValue("canvas.backingWidth", canvasInput.backingWidth),
    backingHeight: nonNegativeValue("canvas.backingHeight", canvasInput.backingHeight),
    systemDpr: finiteValue("canvas.systemDpr", canvasInput.systemDpr),
    effectivePixelRatio,
    renderScalePercent: finiteValue("canvas.renderScalePercent", canvasInput.renderScalePercent),
  };
  if (canvas.systemDpr <= 0) throw new RangeError("canvas.systemDpr must be positive");
  if (canvas.renderScalePercent <= 0) throw new RangeError("canvas.renderScalePercent must be positive");
  const browserInput = objectValue("browser", source.browser);
  const browser = {
    name: stringValue("browser.name", browserInput.name),
    version: stringValue("browser.version", browserInput.version),
  };
  const webglInput = objectValue("webgl", source.webgl);
  const extensionInput = arrayValue("webgl.extensions", webglInput.extensions);
  const webgl = {
    version: stringValue("webgl.version", webglInput.version),
    shadingLanguageVersion: stringValue(
      "webgl.shadingLanguageVersion",
      webglInput.shadingLanguageVersion,
    ),
    extensions: Object.freeze(extensionInput.map((extension, index) =>
      stringValue(`webgl.extensions[${index}]`, extension))),
    gpu: {
      vendor: { status: "unsupported" as const, reason: "not-collected" as const },
      renderer: { status: "unsupported" as const, reason: "not-collected" as const },
    },
  };
  const settingsInput = objectValue("settings", source.settings);
  const settings = cloneJson(settingsInput as BenchmarkJsonValue, "settings") as BenchmarkJsonObject;
  const configuredLighting = source.lighting
    ?? (typeof settings.lightingQuality === "number" ? settings.lightingQuality : undefined)
    ?? (typeof settings.lighting === "number" ? settings.lighting : undefined)
    ?? benchmarkManifest.profile.lighting;
  return deepFreeze({
    schemaVersion: RENDER_BENCHMARK_MANIFEST_VERSION,
    canvas,
    lighting: finiteValue("lighting", configuredLighting),
    browser,
    webgl,
    settings,
  });
}

/**
 * Validates and owns an environment passed across the live runtime boundary. Metadata generated by
 * this module is accepted as well as the input shape, but the caller's object is never retained.
 */
export function cloneBenchmarkEnvironment(
  input: unknown,
): DeepReadonly<BenchmarkEnvironmentMetadata> {
  const source = objectValue("environment", input);
  if (Object.prototype.hasOwnProperty.call(source, "schemaVersion")) {
    if (source.schemaVersion !== RENDER_BENCHMARK_MANIFEST_VERSION) {
      throw new TypeError("environment.schemaVersion is unsupported");
    }
    const webgl = objectValue("webgl", source.webgl);
    const gpu = objectValue("webgl.gpu", webgl.gpu);
    for (const name of ["vendor", "renderer"] as const) {
      const value = objectValue(`webgl.gpu.${name}`, gpu[name]);
      if (value.status !== "unsupported" || value.reason !== "not-collected") {
        throw new TypeError(`webgl.gpu.${name} must be explicitly unsupported`);
      }
    }
  }
  return captureBenchmarkEnvironment(source as unknown as BenchmarkEnvironmentInput);
}

/** Compares JSON-safe environment snapshots independent of object key insertion order. */
export function benchmarkEnvironmentsEqual(
  left: BenchmarkEnvironmentMetadata,
  right: BenchmarkEnvironmentMetadata,
): boolean {
  return equalJson(left, right);
}

function canonicalBenchmarkJson(value: BenchmarkJsonValue): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new TypeError("benchmark environment is not JSON-safe");
    return result;
  }
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalBenchmarkJson(child)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalBenchmarkJson(child)}`)
    .join(",")}}`;
}

/** Stable JSON for the owned environment metadata; object keys are sorted, array order is kept. */
export function canonicalBenchmarkEnvironmentJson(input: unknown): string {
  const owned = cloneBenchmarkEnvironment(input);
  return canonicalBenchmarkJson(owned as BenchmarkJsonValue);
}

/** SHA-256 of canonical environment metadata using only platform Web Crypto. */
export async function hashBenchmarkEnvironment(input: unknown): Promise<string> {
  const crypto = globalThis.crypto;
  if (crypto === undefined || crypto.subtle === undefined || typeof crypto.subtle.digest !== "function") {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }
  const bytes = new TextEncoder().encode(canonicalBenchmarkEnvironmentJson(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => equalJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && equalJson(leftRecord[key], rightRecord[key]));
}
