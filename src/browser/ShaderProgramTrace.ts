/** JavaScript-only shader attribution, enabled exclusively during an explicit performance capture. */
interface ProgramIdentity { readonly id: number; }
interface ProgramDetails extends ProgramIdentity { readonly type?: string; readonly cacheKey?: string; }

export type ShaderProgramPhase = "existing" | "prepare" | "warm" | "sky" | "world" | "overlay" | "postprocess" | "portraits" | "overflow";
export interface ShaderProgramEvent {
  readonly at: number;
  readonly phase: ShaderProgramPhase;
  readonly added: number;
  readonly omitted: number;
  readonly diagnosticMs: number;
  readonly programs: readonly {
    readonly id: number;
    readonly type: string;
    readonly keyHash: string;
    readonly keyFields: readonly string[];
  }[];
}

const PROGRAM_LIMIT = 32;
const EVENT_LIMIT = 8;
const EMPTY_EVENTS: readonly ShaderProgramEvent[] = [];
const SAFE_TYPES = new Set(["MeshBasicMaterial", "MeshLambertMaterial", "MeshPhongMaterial",
  "MeshStandardMaterial", "MeshPhysicalMaterial", "MeshDepthMaterial", "MeshDistanceMaterial",
  "MeshNormalMaterial", "MeshMatcapMaterial", "ShaderMaterial", "RawShaderMaterial",
  "PointsMaterial", "LineBasicMaterial", "LineDashedMaterial", "SpriteMaterial", "ShadowMaterial"]);
const SAFE_FIELDS = new Set(["basic", "lambert", "phong", "standard", "physical", "matcap",
  "points", "linedashed", "depth", "normal", "sprite", "background", "cube", "equirect",
  "distanceRGBA", "shadow", "highp", "mediump", "lowp", "srgb", "srgb-linear",
  "true", "false", "undefined", "null"]);

/** Diagnostic identity, not a security hash; no source code, material names or resource URLs leave it. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A program as `mark()` saw it: the raw strings stay here until `drain()` describes them. */
interface RawProgram { readonly id: number; readonly type: string | undefined; readonly key: string; }
interface RawEvent {
  readonly at: number;
  readonly phase: ShaderProgramPhase;
  readonly added: number;
  readonly programs: readonly RawProgram[];
  readonly diagnosticMs: number;
}

/** Built-in switches remain readable; custom keys/defines and shader text are fingerprinted. */
function describe(program: RawProgram): ShaderProgramEvent["programs"][number] {
  const key = program.key;
  return { id: program.id, type: SAFE_TYPES.has(program.type ?? "") ? program.type! : "other",
    keyHash: fingerprint(key),
    keyFields: key.split(",", 64).map(field => SAFE_FIELDS.has(field) || /^-?\d{1,10}(?:\.\d{1,6})?$/.test(field)
      ? field : "#" + fingerprint(field)),
  };
}

/**
 * NET-22 (P1-02c): `mark()` runs inside measured render phases (`prepare`, `warm`, `sky`, `world`,
 * `overlay`, `postprocess`), so it only records ids, types and references to the cache-key strings;
 * fingerprints and key fields are computed in `drain()`, which the capture calls after the frame's CPU
 * clock has stopped. Limits and the drained fields are unchanged; raw keys never leave this class.
 */
export class ShaderProgramTrace {
  #lastId = -1;
  #pending: RawEvent[] = [];
  #overflow = 0;
  #overflowAt = 0;

  constructor(programs: readonly ProgramIdentity[] | null | undefined, at: number) {
    this.mark("existing", programs, at);
  }

  mark(phase: ShaderProgramPhase, programs: readonly ProgramIdentity[] | null | undefined, at: number): void {
    if (!programs) return;
    const started = performance.now();
    const previousId = this.#lastId;
    const recorded: RawProgram[] = [];
    let added = 0;
    for (const identity of programs) {
      // Three r185 program ids are monotonic; array indices change when old programs are freed.
      if (identity.id <= previousId) continue;
      this.#lastId = Math.max(this.#lastId, identity.id);
      added++;
      if (recorded.length >= PROGRAM_LIMIT || this.#pending.length >= EVENT_LIMIT) continue;
      const program = identity as ProgramDetails;
      recorded.push({ id: program.id, type: program.type, key: program.cacheKey ?? "" });
    }
    if (added > 0 && this.#pending.length < EVENT_LIMIT) this.#pending.push({
      at, phase, added, programs: recorded, diagnosticMs: performance.now() - started,
    });
    else if (added > 0) {
      this.#overflow += added;
      this.#overflowAt = at;
    }
  }

  drain(): readonly ShaderProgramEvent[] {
    if (this.#pending.length === 0) return EMPTY_EVENTS;
    const pending = this.#pending;
    this.#pending = [];
    const events: ShaderProgramEvent[] = [];
    for (const event of pending) {
      const programs = event.programs.map(describe);
      events.push({ at: event.at, phase: event.phase, added: event.added, omitted: event.added - programs.length,
        programs, diagnosticMs: event.diagnosticMs });
    }
    if (this.#overflow > 0) {
      events.push({ at: this.#overflowAt, phase: "overflow", added: this.#overflow,
        omitted: this.#overflow, diagnosticMs: 0, programs: [] });
      this.#overflow = 0;
    }
    return events;
  }
}
