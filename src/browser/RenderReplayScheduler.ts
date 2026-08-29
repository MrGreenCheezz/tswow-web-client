export const RENDER_REPLAY_EXPECTED_DURATION_MS = 90_000;
export const RENDER_REPLAY_DURATION_TOLERANCE_MS = 250;

export interface RenderReplaySchedulerConfig {
  readonly frameCount: number;
  readonly frameStepMs: number;
  readonly expectedDurationMs?: number;
  readonly toleranceMs?: number;
}

export interface RenderReplayFrameTicket {
  readonly frameIndex: number;
  /** Logical presentation timestamp from the start of the replay: frameIndex * frameStepMs. */
  readonly nowMs: number;
  readonly elapsedSeconds: number;
}

export interface RenderReplayFramePollResult {
  readonly status: "frame";
  readonly ticket: Readonly<RenderReplayFrameTicket>;
}

export interface RenderReplayNotDuePollResult {
  readonly status: "not-due";
  readonly nextFrameIndex: number;
  readonly dueAtWallMs: number;
}

export type RenderReplayPollResult =
  | Readonly<RenderReplayFramePollResult>
  | Readonly<RenderReplayNotDuePollResult>;

export type RenderReplayInvalidReason =
  | "incomplete-frame-sequence"
  | "duration-out-of-range";

export interface RenderReplaySummary {
  readonly startedAtWallMs: number;
  readonly finishedAtWallMs: number;
  readonly wallDurationMs: number;
  /** The configured interval between logical tickets; ticket nowMs advances by this value. */
  readonly frameStepMs: number;
  /** Logical replay span is frameCount * frameStepMs; tickets occupy [0, logicalDurationMs). */
  readonly logicalDurationMs: number;
  readonly expectedDurationMs: number;
  readonly toleranceMs: number;
  readonly expectedFrames: number;
  readonly emittedFrames: number;
  readonly complete: boolean;
  readonly durationValid: boolean;
  readonly valid: boolean;
  readonly invalidReasons: readonly RenderReplayInvalidReason[];
}

interface NormalizedConfig {
  readonly frameCount: number;
  readonly frameStepMs: number;
  readonly logicalDurationMs: number;
  readonly expectedDurationMs: number;
  readonly toleranceMs: number;
}

function requirePositiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function requireNonNegativeFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function normalizeConfig(config: RenderReplaySchedulerConfig): Readonly<NormalizedConfig> {
  if (!Number.isSafeInteger(config.frameCount) || config.frameCount <= 0) {
    throw new RangeError("frameCount must be a positive safe integer");
  }

  const frameStepMs = requirePositiveFinite("frameStepMs", config.frameStepMs);
  const logicalDurationMs = config.frameCount * frameStepMs;
  if (!Number.isFinite(logicalDurationMs)) {
    throw new RangeError("frameCount and frameStepMs must produce a finite logical duration");
  }

  const expectedDurationMs = requirePositiveFinite(
    "expectedDurationMs",
    config.expectedDurationMs ?? RENDER_REPLAY_EXPECTED_DURATION_MS,
  );
  const toleranceMs = requireNonNegativeFinite(
    "toleranceMs",
    config.toleranceMs ?? RENDER_REPLAY_DURATION_TOLERANCE_MS,
  );
  if (!Number.isFinite(expectedDurationMs + toleranceMs)) {
    throw new RangeError("expectedDurationMs and toleranceMs must produce a finite upper bound");
  }

  return Object.freeze({
    frameCount: config.frameCount,
    frameStepMs,
    logicalDurationMs,
    expectedDurationMs,
    toleranceMs,
  });
}

function requireFiniteWallTimestamp(wallNowMs: number): void {
  if (!Number.isFinite(wallNowMs)) throw new RangeError("wallNowMs must be finite");
}

export class RenderReplayScheduler {
  readonly #config: Readonly<NormalizedConfig>;
  #startedAtWallMs: number | undefined;
  #lastWallNowMs: number | undefined;
  #lastPollWallMs: number | undefined;
  #emittedFrames = 0;
  #finished = false;
  #summary: Readonly<RenderReplaySummary> | undefined;

  constructor(config: RenderReplaySchedulerConfig) {
    this.#config = normalizeConfig(config);
  }

  get summary(): Readonly<RenderReplaySummary> | undefined {
    return this.#summary;
  }

  start(wallNowMs: number): void {
    if (this.#startedAtWallMs !== undefined) throw new Error("scheduler has already started");
    requireFiniteWallTimestamp(wallNowMs);
    this.#startedAtWallMs = wallNowMs;
    this.#lastWallNowMs = wallNowMs;
  }

  poll(wallNowMs: number): RenderReplayPollResult {
    this.#assertOpen();
    this.#validateWallTimestamp(wallNowMs);
    if (this.#lastPollWallMs === wallNowMs) {
      throw new Error("scheduler may be polled only once per wall timestamp");
    }

    if (this.#emittedFrames === this.#config.frameCount) {
      throw new Error("all logical frames have been emitted; call finish");
    }

    const dueAtWallMs = (this.#startedAtWallMs as number)
      + this.#emittedFrames * this.#config.frameStepMs;
    if (!Number.isFinite(dueAtWallMs)) {
      throw new RangeError("start wall time and logical frame deadline must produce a finite due time");
    }
    if (wallNowMs < dueAtWallMs) {
      this.#lastPollWallMs = wallNowMs;
      this.#lastWallNowMs = wallNowMs;
      return Object.freeze({
        status: "not-due" as const,
        nextFrameIndex: this.#emittedFrames,
        dueAtWallMs,
      });
    }

    const frameIndex = this.#emittedFrames;
    const emittedFrames = frameIndex + 1;
    const ticket = Object.freeze({
      frameIndex,
      nowMs: frameIndex * this.#config.frameStepMs,
      elapsedSeconds: frameIndex === 0 ? 0 : this.#config.frameStepMs / 1_000,
    });
    this.#emittedFrames = emittedFrames;
    this.#lastPollWallMs = wallNowMs;
    this.#lastWallNowMs = wallNowMs;
    return Object.freeze({ status: "frame" as const, ticket });
  }

  finish(wallNowMs: number): Readonly<RenderReplaySummary> {
    this.#assertOpen();
    this.#validateWallTimestamp(wallNowMs);

    const startedAtWallMs = this.#startedAtWallMs as number;
    const wallDurationMs = wallNowMs - startedAtWallMs;
    if (!Number.isFinite(wallDurationMs)) throw new RangeError("wall duration must be finite");

    const complete = this.#emittedFrames === this.#config.frameCount;
    const durationValid = wallDurationMs >= this.#config.expectedDurationMs
      && wallDurationMs <= this.#config.expectedDurationMs + this.#config.toleranceMs;
    const invalidReasons: RenderReplayInvalidReason[] = [];
    if (!complete) invalidReasons.push("incomplete-frame-sequence");
    if (!durationValid) invalidReasons.push("duration-out-of-range");

    const summary: Readonly<RenderReplaySummary> = Object.freeze({
      startedAtWallMs,
      finishedAtWallMs: wallNowMs,
      wallDurationMs,
      frameStepMs: this.#config.frameStepMs,
      logicalDurationMs: this.#config.logicalDurationMs,
      expectedDurationMs: this.#config.expectedDurationMs,
      toleranceMs: this.#config.toleranceMs,
      expectedFrames: this.#config.frameCount,
      emittedFrames: this.#emittedFrames,
      complete,
      durationValid,
      valid: invalidReasons.length === 0,
      invalidReasons: Object.freeze(invalidReasons),
    });
    this.#lastWallNowMs = wallNowMs;
    this.#finished = true;
    this.#summary = summary;
    return summary;
  }

  #assertOpen(): void {
    if (this.#startedAtWallMs === undefined) throw new Error("scheduler has not started");
    if (this.#finished) throw new Error("scheduler is already finished");
  }

  #validateWallTimestamp(wallNowMs: number): void {
    requireFiniteWallTimestamp(wallNowMs);
    const lastWallNowMs = this.#lastWallNowMs as number;
    if (wallNowMs < lastWallNowMs) throw new RangeError("wallNowMs must be monotonic");
  }
}
