import {
  cloneWorldReplaySnapshot,
  hashWorldReplayFrameOrder,
  hashWorldReplaySnapshot,
  validateWorldReplayObservation,
  type WorldReplayCameraFrameV1,
  type WorldReplayObservation,
  type WorldReplaySnapshotV1,
} from "./BenchmarkReplay.js";
import {
  RENDER_BENCHMARK_MANIFEST,
  canonicalBenchmarkEnvironmentJson,
  cloneBenchmarkEnvironment,
  type ApprovedBenchmarkScenario,
  type BenchmarkEnvironmentMetadata,
  type BenchmarkPosition,
} from "./BenchmarkManifest.js";
import {
  hashBenchmarkRuntimeEnvironment,
  hashBenchmarkVariantConfiguration,
  projectBenchmarkVariantConfiguration,
  validateBenchmarkVariantKnobChange,
  type BenchmarkVariantConfiguration,
} from "./RenderBenchmarkIdentity.js";
import {
  RENDER_BENCHMARK_MIN_STABLE_SAMPLES,
  RENDER_BENCHMARK_STABLE_RESIDENCY_MS,
  type BenchmarkReadinessBlockingReason,
  type BenchmarkReadinessObservation,
} from "./RenderBenchmarkReadiness.js";
import {
  RENDER_REPLAY_DURATION_TOLERANCE_MS,
  RenderReplayScheduler,
  type RenderReplayFrameTicket,
  type RenderReplaySummary,
} from "./RenderReplayScheduler.js";
import {
  BENCHMARK_RUN_DURATION_MS,
  BenchmarkRunAccumulator,
  type BenchmarkGpuSample,
  type BenchmarkGpuUnavailableReason,
  type BenchmarkResourceCheckpointInput,
} from "./RenderBenchmarkRun.js";
import {
  buildPairedBenchmarkRunRecord,
  type FormalBenchmarkDiagnosticEvidence,
  type FormalBenchmarkScheduleIdentity,
} from "./RenderBenchmarkFormalRun.js";
import {
  PAIRED_BENCHMARK_ORDER,
  PAIRED_BENCHMARK_WARM_POLICY,
  buildPairedBenchmarkReport,
  type BenchmarkVariant,
  type PairedBenchmarkReport,
  type PairedBenchmarkRunRecord,
} from "./RenderBenchmarkPairing.js";
import { isLiveFormalRenderBenchmarkHost } from "./LiveFormalRenderBenchmarkHost.js";
import type { TrustedPairedBenchmarkReport } from "./RenderBenchmarkPairing.js";

export const FORMAL_BENCHMARK_FRAME_COUNT = 5_400 as const;
export const FORMAL_BENCHMARK_FRAME_STEP_MS = 1_000 / 60;
export const FORMAL_BENCHMARK_START_BARRIER_FRESHNESS_TOLERANCE_MS = 1_000;
/** Maximum per-axis deviation allowed when binding replay self position to the approved fixture. */
export const FORMAL_BENCHMARK_POSITION_TOLERANCE_YARDS = 0.01;

export interface FormalRenderBenchmarkDefinition {
  readonly snapshot: unknown;
  readonly environment: unknown;
  readonly configurations: Readonly<{ A: unknown; B: unknown }>;
  readonly comparisonId: string;
  readonly allowedKnobPath: string;
}

export interface FormalRenderBenchmarkIdentity {
  readonly scenarioId: string;
  readonly comparisonId: string;
  readonly allowedKnobPath: string;
  readonly snapshotHash: string;
  readonly frameOrderHash: string;
  readonly environmentHash: string;
  readonly variantConfigHashes: Readonly<{ A: string; B: string }>;
}

export interface FormalBenchmarkExclusiveLease {
  release(): void | Promise<void>;
}

export interface FormalBenchmarkEpochIdentity {
  readonly suiteNonce: string;
  readonly epochNonce: string;
}

export interface FormalBenchmarkBarrier {
  readonly suiteNonce: string;
  readonly epochNonce: string;
  readonly capturedAt: number;
  readonly readiness: Readonly<BenchmarkReadinessObservation>;
  readonly environment: Readonly<BenchmarkEnvironmentMetadata>;
  readonly observation: Readonly<WorldReplayObservation>;
  readonly resourceSignature: string;
  readonly activityStamp: string;
  readonly resources: Readonly<BenchmarkResourceCheckpointInput>;
}

export interface FormalBenchmarkSubmissionReceipt {
  readonly suiteNonce: string;
  readonly epochNonce: string;
  readonly submitted: true;
  readonly frameIndex: number;
  readonly submissionSerial: number;
  /** Host monotonic time after the renderer closed this submission's CPU/GPU envelope. */
  readonly completedAtWallMs: number;
  readonly fullFrameCpuMs: number;
  readonly rendererFrameCpuMs: number;
}

export type FormalBenchmarkGpuDrain =
  | Readonly<{ status: "available"; samples: readonly number[] }>
  | Readonly<{
    status: "unavailable";
    reason: BenchmarkGpuUnavailableReason;
    samples: readonly number[];
    attempted: number;
    dropped: number;
  }>;

export interface FormalRenderBenchmarkHost {
  acquireExclusiveLease(signal?: AbortSignal): FormalBenchmarkExclusiveLease | Promise<FormalBenchmarkExclusiveLease>;
  applyVariant(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    variant: BenchmarkVariant,
    configuration: Readonly<BenchmarkVariantConfiguration>,
    signal?: AbortSignal,
  ): void | Promise<void>;
  prewarm(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    snapshot: Readonly<WorldReplaySnapshotV1>,
    signal?: AbortSignal,
  ): void | Promise<void>;
  captureBarrier(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    phase: "start" | "measurement-end" | "post-gpu-drain",
    signal?: AbortSignal,
  ): unknown | Promise<unknown>;
  resetReplayEpoch(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    snapshot: Readonly<WorldReplaySnapshotV1>,
    signal?: AbortSignal,
  ): void | Promise<void>;
  endReplayEpoch(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
  ): void | Promise<void>;
  waitUntil(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    dueAtWallMs: number,
    signal?: AbortSignal,
  ): unknown | Promise<unknown>;
  renderFrame(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    ticket: Readonly<RenderReplayFrameTicket>,
    frame: Readonly<WorldReplayCameraFrameV1>,
    signal?: AbortSignal,
  ): unknown | Promise<unknown>;
  drainGpu(
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    measurementEndedAt: number,
    signal?: AbortSignal,
  ): unknown | Promise<unknown>;
}

export interface FormalRenderBenchmarkSuiteResult {
  readonly formalGateEligible: true;
  readonly identity: Readonly<FormalRenderBenchmarkIdentity>;
  readonly records: readonly Readonly<PairedBenchmarkRunRecord>[];
  readonly report: Readonly<TrustedPairedBenchmarkReport>;
}

export interface DiagnosticRenderBenchmarkSuiteResult {
  readonly formalGateEligible: false;
  readonly identity: Readonly<FormalRenderBenchmarkIdentity>;
  readonly records: readonly Readonly<PairedBenchmarkRunRecord>[];
  readonly report: Readonly<PairedBenchmarkReport>;
}

const TRUSTED_RUN_RECORDS = new WeakSet<object>();
const TRUSTED_SUITE_RESULTS = new WeakSet<object>();
const RECEIPT_KEYS = [
  "suiteNonce", "epochNonce", "submitted", "frameIndex", "submissionSerial", "completedAtWallMs",
  "fullFrameCpuMs", "rendererFrameCpuMs",
] as const;
const BARRIER_KEYS = [
  "suiteNonce", "epochNonce", "capturedAt", "readiness", "environment", "observation", "resourceSignature",
  "activityStamp", "resources",
] as const;
const READINESS_KEYS = [
  "capturedAt", "ready", "stableForMs", "stableSamples", "resourceSignature", "blockingReasons",
] as const;
const OBSERVATION_KEYS = ["indoors", "underwater", "weather"] as const;
const WEATHER_KEYS = ["state", "intensity", "abrupt"] as const;
const RESOURCE_KEYS = ["counters", "bytes"] as const;
const GPU_UNAVAILABLE_REASONS = new Set<BenchmarkGpuUnavailableReason>([
  "unsupported", "context-lost", "disjoint", "query-error", "not-provided", "queue-drop",
  "query-discard", "pending-at-finish", "mixed-availability", "sample-cap",
]);

/** Only records constructed inside a completed runner phase can cross this report boundary. */
export function buildTrustedFormalBenchmarkReport(
  records: readonly Readonly<PairedBenchmarkRunRecord>[],
): Readonly<TrustedPairedBenchmarkReport> {
  if (!Array.isArray(records) || records.length !== PAIRED_BENCHMARK_ORDER.length) {
    throw new RangeError(`trusted formal report requires exactly ${PAIRED_BENCHMARK_ORDER.length} records`);
  }
  for (const [index, record] of records.entries()) {
    if (record === null || typeof record !== "object" || !TRUSTED_RUN_RECORDS.has(record)) {
      throw new Error(`record ${index} does not have runner provenance`);
    }
  }
  const diagnostic = buildPairedBenchmarkReport(records);
  return deepFreeze({ ...diagnostic, formalGateEligible: true as const });
}

/** In-process provenance only; serialized/cloned suite lookalikes are deliberately untrusted. */
export function isTrustedFormalBenchmarkSuiteResult(
  value: unknown,
): value is Readonly<FormalRenderBenchmarkSuiteResult> {
  return value !== null && typeof value === "object" && TRUSTED_SUITE_RESULTS.has(value);
}

export class FormalRenderBenchmarkRunner {
  readonly #snapshot: Readonly<WorldReplaySnapshotV1>;
  readonly #configurations: Readonly<Record<BenchmarkVariant, Readonly<BenchmarkVariantConfiguration>>>;
  readonly #identity: Readonly<FormalRenderBenchmarkIdentity>;
  readonly #fixtureApproved: boolean;
  #running = false;

  private constructor(
    snapshot: Readonly<WorldReplaySnapshotV1>,
    configurations: Readonly<Record<BenchmarkVariant, Readonly<BenchmarkVariantConfiguration>>>,
    identity: Readonly<FormalRenderBenchmarkIdentity>,
    fixtureApproved: boolean,
  ) {
    this.#snapshot = snapshot;
    this.#configurations = configurations;
    this.#identity = identity;
    this.#fixtureApproved = fixtureApproved;
  }

  static async create(definition: Readonly<FormalRenderBenchmarkDefinition>): Promise<FormalRenderBenchmarkRunner> {
    return FormalRenderBenchmarkRunner.#create(definition, false);
  }

  /** Candidate replays may be captured and tested, but can never mint formal gate eligibility. */
  static async createDiagnosticCandidate(
    definition: Readonly<FormalRenderBenchmarkDefinition>,
  ): Promise<FormalRenderBenchmarkRunner> {
    return FormalRenderBenchmarkRunner.#create(definition, true);
  }

  static async #create(
    definition: Readonly<FormalRenderBenchmarkDefinition>,
    allowPendingFixture: boolean,
  ): Promise<FormalRenderBenchmarkRunner> {
    requireExactPlainObject(definition, "definition", [
      "snapshot", "environment", "configurations", "comparisonId", "allowedKnobPath",
    ]);
    const snapshot = cloneWorldReplaySnapshot(definition.snapshot);
    if (snapshot.frames.length !== FORMAL_BENCHMARK_FRAME_COUNT) {
      throw new RangeError(`formal snapshot must contain exactly ${FORMAL_BENCHMARK_FRAME_COUNT} frames`);
    }
    if (!numbersEqual(snapshot.frameStepMs, FORMAL_BENCHMARK_FRAME_STEP_MS)) {
      throw new RangeError("formal snapshot frameStepMs must equal 1000/60");
    }
    const self = snapshot.objects.find((object) => object.guid === snapshot.selfGuid);
    if (!self?.position) throw new Error("formal snapshot self must exist and have a position");
    const scenario = RENDER_BENCHMARK_MANIFEST.scenarios.find((entry) => entry.id === snapshot.scenarioId);
    if (!scenario || scenario.status !== "approved") {
      throw new Error("formal snapshot scenarioId must name an approved benchmark scenario");
    }
    if (scenario.kind !== snapshot.expectations.scene) {
      throw new Error("formal snapshot expectations.scene must match the approved scenario kind");
    }
    requireApprovedScenarioFixture(snapshot, self.position, scenario);

    const comparisonId = requireTrimmedNonEmpty("definition.comparisonId", definition.comparisonId);
    const allowedKnobPath = requireTrimmedNonEmpty("definition.allowedKnobPath", definition.allowedKnobPath);
    requireExactPlainObject(definition.configurations, "definition.configurations", ["A", "B"]);
    requireFormalVariantProfile(definition.configurations.A, "definition.configurations.A");
    requireFormalVariantProfile(definition.configurations.B, "definition.configurations.B");
    requireSameAllowedLeafType(definition.configurations.A, definition.configurations.B, allowedKnobPath);
    validateBenchmarkVariantKnobChange(
      definition.configurations.A,
      definition.configurations.B,
      [allowedKnobPath],
    );

    const environment = cloneBenchmarkEnvironment(definition.environment);
    requireFormalCanvasProfile(environment);
    const variantEnvironmentA = environmentWithConfiguration(environment, definition.configurations.A);
    const variantEnvironmentB = environmentWithConfiguration(environment, definition.configurations.B);
    const configurations = Object.freeze({
      A: projectBenchmarkVariantConfiguration(variantEnvironmentA),
      B: projectBenchmarkVariantConfiguration(variantEnvironmentB),
    });
    const [snapshotHash, frameOrderHash, environmentHash, configAHash, configBHash] = await Promise.all([
      hashWorldReplaySnapshot(snapshot),
      hashWorldReplayFrameOrder(snapshot),
      hashBenchmarkRuntimeEnvironment(environment),
      hashBenchmarkVariantConfiguration(variantEnvironmentA),
      hashBenchmarkVariantConfiguration(variantEnvironmentB),
    ]);
    const fixtureApproved = scenario.fixtureStatus === "approved";
    if (!fixtureApproved && !allowPendingFixture) {
      throw new Error("formal benchmark scenario replay fixture is pending approval");
    }
    if (fixtureApproved
      && (snapshotHash !== scenario.snapshotHash || frameOrderHash !== scenario.frameOrderHash)) {
      throw new Error("formal replay identities do not match the approved scenario fixture");
    }
    const identity = deepFreeze({
      scenarioId: snapshot.scenarioId,
      comparisonId,
      allowedKnobPath,
      snapshotHash,
      frameOrderHash,
      environmentHash,
      variantConfigHashes: { A: configAHash, B: configBHash },
    });
    return new FormalRenderBenchmarkRunner(snapshot, configurations, identity, fixtureApproved);
  }

  get identity(): Readonly<FormalRenderBenchmarkIdentity> {
    return this.#identity;
  }

  async run(
    host: FormalRenderBenchmarkHost,
    signal?: AbortSignal,
  ): Promise<Readonly<FormalRenderBenchmarkSuiteResult>> {
    if (!isLiveFormalRenderBenchmarkHost(host)) {
      throw new Error("formal benchmark runner requires a branded live formal renderer host");
    }
    if (!this.#fixtureApproved) {
      throw new Error("formal benchmark runner requires an approved pinned replay fixture");
    }
    const result = await this.#execute(host, true, signal);
    if (!result.formalGateEligible) throw new Error("live formal execution did not mint trusted evidence");
    return result;
  }

  async runDiagnostic(
    host: FormalRenderBenchmarkHost,
    signal?: AbortSignal,
  ): Promise<Readonly<DiagnosticRenderBenchmarkSuiteResult>> {
    const result = await this.#execute(host, false, signal);
    if (result.formalGateEligible) throw new Error("diagnostic execution unexpectedly minted trusted evidence");
    return result;
  }

  /** Compatibility alias for unit harnesses; production candidate capture should use runDiagnostic(). */
  runUntrustedForTesting(
    host: FormalRenderBenchmarkHost,
    signal?: AbortSignal,
  ): Promise<Readonly<DiagnosticRenderBenchmarkSuiteResult>> {
    return this.runDiagnostic(host, signal);
  }

  async #execute(
    host: FormalRenderBenchmarkHost,
    mintTrustedEvidence: boolean,
    signal?: AbortSignal,
  ): Promise<Readonly<FormalRenderBenchmarkSuiteResult | DiagnosticRenderBenchmarkSuiteResult>> {
    if (this.#running) throw new Error("formal benchmark runner is already running");
    this.#running = true;
    try {
      validateHost(host);
      throwIfAborted(signal);
      const suiteNonce = createFormalNonce();
      const lease = await host.acquireExclusiveLease(signal);
      validateLease(lease);
      const records: Readonly<PairedBenchmarkRunRecord>[] = [];
      const submissionSequence = { lastSerial: -1 };
      const barrierSequence: { lastCapturedAt?: number } = {};
      try {
        for (const scheduled of PAIRED_BENCHMARK_ORDER) {
          throwIfAborted(signal);
          const epoch = Object.freeze({ suiteNonce, epochNonce: createFormalNonce() });
          const record = await this.#runOne(
            host, lease, epoch, scheduled, submissionSequence, barrierSequence, mintTrustedEvidence, signal,
          );
          records.push(record);
        }
        const frozenRecords = Object.freeze([...records]);
        if (mintTrustedEvidence) {
          const report = buildTrustedFormalBenchmarkReport(frozenRecords);
          const result = deepFreeze({
            formalGateEligible: true as const,
            identity: this.#identity,
            records: frozenRecords,
            report,
          });
          TRUSTED_SUITE_RESULTS.add(result as object);
          return result;
        }
        const report = buildPairedBenchmarkReport(frozenRecords);
        return deepFreeze({
          formalGateEligible: false as const,
          identity: this.#identity,
          records: frozenRecords,
          report,
        });
      } finally {
        await lease.release();
      }
    } finally {
      this.#running = false;
    }
  }

  async #runOne(
    host: FormalRenderBenchmarkHost,
    lease: FormalBenchmarkExclusiveLease,
    epoch: Readonly<FormalBenchmarkEpochIdentity>,
    scheduled: Readonly<{ runIndex: number; pairIndex: number; variant: BenchmarkVariant }>,
    submissionSequence: { lastSerial: number },
    barrierSequence: { lastCapturedAt?: number },
    mintTrustedEvidence: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Readonly<PairedBenchmarkRunRecord>> {
    const configuration = this.#configurations[scheduled.variant];
    await host.applyVariant(lease, epoch, scheduled.variant, configuration, signal);
    throwIfAborted(signal);
    await host.prewarm(lease, epoch, this.#snapshot, signal);
    throwIfAborted(signal);

    let replayBoundaryCleanupRequired = false;
    try {
      replayBoundaryCleanupRequired = true;
      await host.resetReplayEpoch(lease, epoch, this.#snapshot, signal);
      throwIfAborted(signal);
      const startCaptureRequestedAt = mintTrustedEvidence ? formalMonotonicNow() : undefined;
      const startInput = await host.captureBarrier(lease, epoch, "start", signal);
      const startCaptureCompletedAt = mintTrustedEvidence ? formalMonotonicNow() : undefined;
      const start = await cloneBarrier(
        startInput,
        this.#snapshot,
        epoch,
        "start barrier",
      );
      if (startCaptureRequestedAt !== undefined && startCaptureCompletedAt !== undefined) {
        requireFreshStartBarrier(start, startCaptureRequestedAt, startCaptureCompletedAt);
      }
      if (barrierSequence.lastCapturedAt !== undefined
        && start.capturedAt <= barrierSequence.lastCapturedAt) {
        throw new Error("start barrier must be fresher than the preceding run's end barrier");
      }
      await this.#validateStartBarrier(start, scheduled.variant);
      // Hashing the immutable barrier may initialize WebCrypto and take longer than one 60 Hz
      // slot. Anchor cadence only after that validation, while bounding how far the already-proven
      // start state may age. A due time in the past makes a live host return its current monotonic
      // clock without sleeping.
      const measurementStartedAt = requireFinite(
        "host.waitUntil measurement anchor",
        await host.waitUntil(lease, epoch, start.capturedAt, signal),
      );
      if (measurementStartedAt < start.capturedAt
        || measurementStartedAt - start.capturedAt > FORMAL_BENCHMARK_START_BARRIER_FRESHNESS_TOLERANCE_MS) {
        throw new Error("formal measurement anchor is too far from the validated start barrier");
      }
      throwIfAborted(signal);

      const scheduler = new RenderReplayScheduler({
        frameCount: FORMAL_BENCHMARK_FRAME_COUNT,
        frameStepMs: FORMAL_BENCHMARK_FRAME_STEP_MS,
      });
      scheduler.start(measurementStartedAt);
      const accumulator = new BenchmarkRunAccumulator({
        scenario: this.#snapshot.scenarioId,
        variant: scheduled.variant,
        runIndex: scheduled.runIndex,
        startedAt: measurementStartedAt,
      });
      accumulator.recordResourceStart(start.resources);

      let previousSubmissionWallMs: number | undefined;
      for (let expectedFrameIndex = 0; expectedFrameIndex < FORMAL_BENCHMARK_FRAME_COUNT; expectedFrameIndex++) {
        throwIfAborted(signal);
        const dueAt = measurementStartedAt + expectedFrameIndex * FORMAL_BENCHMARK_FRAME_STEP_MS;
        const wallNow = expectedFrameIndex === 0
          ? measurementStartedAt
          : requireFinite("host.waitUntil result", await host.waitUntil(lease, epoch, dueAt, signal));
        const { ticket, polledAt } = await pollFrame(host, lease, epoch, scheduler, wallNow, signal);
        if (ticket.frameIndex !== expectedFrameIndex) {
          throw new Error(`scheduler emitted frame ${ticket.frameIndex}, expected ${expectedFrameIndex}`);
        }
        // A scheduler that merely preserves frame order can still be abused by submitting a long
        // overdue backlog in a tight loop and then waiting at the 90-second endpoint.  Every
        // formal frame therefore owns exactly one cadence slot: missing that slot invalidates the
        // run instead of turning the remainder into compressed catch-up work.
        if (polledAt < dueAt || polledAt >= dueAt + FORMAL_BENCHMARK_FRAME_STEP_MS) {
          throw new Error(
            `formal frame ${expectedFrameIndex} missed its 60 Hz submission window`,
          );
        }
        const receipt = cloneReceipt(await host.renderFrame(
          lease,
          epoch,
          ticket,
          this.#snapshot.frames[expectedFrameIndex]!,
          signal,
        ), epoch);
        throwIfAborted(signal);
        if (receipt.frameIndex !== ticket.frameIndex) {
          throw new Error(`submission receipt frame ${receipt.frameIndex} does not match ticket ${ticket.frameIndex}`);
        }
        if (receipt.submissionSerial <= submissionSequence.lastSerial) {
          throw new Error(
            `submissionSerial ${receipt.submissionSerial} must be strictly greater than ${submissionSequence.lastSerial}`,
          );
        }
        if (receipt.completedAtWallMs < polledAt
          || receipt.completedAtWallMs >= dueAt + FORMAL_BENCHMARK_FRAME_STEP_MS) {
          throw new Error(
            `formal frame ${expectedFrameIndex} did not complete inside its 60 Hz submission window`,
          );
        }
        submissionSequence.lastSerial = receipt.submissionSerial;
        if (previousSubmissionWallMs !== undefined) {
          accumulator.addFrameInterval(polledAt - previousSubmissionWallMs);
        }
        previousSubmissionWallMs = polledAt;
        accumulator.addFullFrameCpu(receipt.fullFrameCpuMs);
        accumulator.addRendererFrameCpu(receipt.rendererFrameCpuMs);
      }

      const finishDueAt = measurementStartedAt + BENCHMARK_RUN_DURATION_MS;
      const finishAt = requireFinite(
        "host.waitUntil measurement end",
        await host.waitUntil(lease, epoch, finishDueAt, signal),
      );
      const replay = scheduler.finish(finishAt);
      throwIfAborted(signal);

      const measurementEnd = await cloneBarrier(
        await host.captureBarrier(lease, epoch, "measurement-end", signal),
        this.#snapshot,
        epoch,
        "measurement-end barrier",
      );
      await this.#validateMeasurementEndBarrier(start, measurementEnd, replay, scheduled.variant);
      accumulator.sealMeasurement(replay.finishedAtWallMs, measurementEnd.resources);
      addGpuDrain(accumulator, await host.drainGpu(lease, epoch, replay.finishedAtWallMs, signal));
      throwIfAborted(signal);
      const postGpuDrain = await cloneBarrier(
        await host.captureBarrier(lease, epoch, "post-gpu-drain", signal),
        this.#snapshot,
        epoch,
        "post-GPU-drain barrier",
      );
      await this.#validatePostGpuDrainBarrier(start, measurementEnd, postGpuDrain, scheduled.variant);
      barrierSequence.lastCapturedAt = postGpuDrain.capturedAt;
      const run = accumulator.finishAfterGpuDrain();
      const diagnostic: Readonly<FormalBenchmarkDiagnosticEvidence> = Object.freeze({
        valid: true,
        frameSequenceComplete: true,
        frameFailures: 0,
        invalidReasons: Object.freeze([]),
      });
      const schedule: Readonly<FormalBenchmarkScheduleIdentity> = Object.freeze({
        scenario: this.#snapshot.scenarioId,
        variant: scheduled.variant,
        runIndex: scheduled.runIndex,
        pairIndex: scheduled.pairIndex,
        comparisonId: this.#identity.comparisonId,
        snapshotHash: this.#identity.snapshotHash,
        frameOrderHash: this.#identity.frameOrderHash,
        environmentHash: this.#identity.environmentHash,
        variantConfigHash: this.#identity.variantConfigHashes[scheduled.variant],
        warmPolicy: PAIRED_BENCHMARK_WARM_POLICY,
        cold: false,
      });
      const record = buildPairedBenchmarkRunRecord({ schedule, run, replay, diagnostic, readiness: start.readiness });
      if (mintTrustedEvidence) TRUSTED_RUN_RECORDS.add(record as object);
      return record;
    } finally {
      if (replayBoundaryCleanupRequired) await host.endReplayEpoch(lease, epoch);
    }
  }

  async #validateStartBarrier(barrier: Readonly<FormalBenchmarkBarrier>, variant: BenchmarkVariant): Promise<void> {
    if (barrier.readiness.capturedAt !== barrier.capturedAt) {
      throw new Error("start readiness must be captured exactly at run start");
    }
    requireReadyBarrier(barrier, "start barrier");
    validateWorldReplayObservation(this.#snapshot, barrier.observation);
    const [environmentHash, configHash] = await Promise.all([
      hashBenchmarkRuntimeEnvironment(barrier.environment),
      hashBenchmarkVariantConfiguration(barrier.environment),
    ]);
    if (environmentHash !== this.#identity.environmentHash) {
      throw new Error("start barrier runtime environment does not match the runner definition");
    }
    if (configHash !== this.#identity.variantConfigHashes[variant]) {
      throw new Error(`start barrier does not prove variant ${variant} configuration`);
    }
  }

  async #validateMeasurementEndBarrier(
    start: Readonly<FormalBenchmarkBarrier>,
    measurementEnd: Readonly<FormalBenchmarkBarrier>,
    replay: Readonly<RenderReplaySummary>,
    variant: BenchmarkVariant,
  ): Promise<void> {
    const endpointDelayMs = measurementEnd.capturedAt - replay.finishedAtWallMs;
    if (measurementEnd.capturedAt <= start.capturedAt
      || endpointDelayMs < 0
      || endpointDelayMs > RENDER_REPLAY_DURATION_TOLERANCE_MS) {
      throw new Error(
        `measurement-end barrier must be within [0, ${RENDER_REPLAY_DURATION_TOLERANCE_MS}]ms of replay endpoint`,
      );
    }
    if (measurementEnd.readiness.capturedAt !== measurementEnd.capturedAt) {
      throw new Error("measurement-end readiness must be captured exactly with its barrier");
    }
    requireGpuDrainableBarrier(measurementEnd);
    await this.#validateStableBarrierIdentity(start, measurementEnd, variant, "measurement-end barrier");
  }

  async #validatePostGpuDrainBarrier(
    start: Readonly<FormalBenchmarkBarrier>,
    measurementEnd: Readonly<FormalBenchmarkBarrier>,
    postGpuDrain: Readonly<FormalBenchmarkBarrier>,
    variant: BenchmarkVariant,
  ): Promise<void> {
    if (postGpuDrain.capturedAt <= measurementEnd.capturedAt) {
      throw new Error("post-GPU-drain barrier must be fresher than the measurement-end barrier");
    }
    if (postGpuDrain.readiness.capturedAt !== postGpuDrain.capturedAt) {
      throw new Error("post-GPU-drain readiness must be captured exactly with its barrier");
    }
    requireReadyBarrier(postGpuDrain, "post-GPU-drain barrier");
    await this.#validateStableBarrierIdentity(start, postGpuDrain, variant, "post-GPU-drain barrier");
    if (postGpuDrain.resourceSignature !== measurementEnd.resourceSignature
      || canonicalResourceCheckpoint(postGpuDrain.resources)
        !== canonicalResourceCheckpoint(measurementEnd.resources)
      || postGpuDrain.activityStamp !== measurementEnd.activityStamp) {
      throw new Error("benchmark residency changed while draining GPU queries");
    }
  }

  async #validateStableBarrierIdentity(
    start: Readonly<FormalBenchmarkBarrier>,
    candidate: Readonly<FormalBenchmarkBarrier>,
    variant: BenchmarkVariant,
    label: string,
  ): Promise<void> {
    validateWorldReplayObservation(this.#snapshot, candidate.observation);
    const [runtimeHash, configHash] = await Promise.all([
      hashBenchmarkRuntimeEnvironment(candidate.environment),
      hashBenchmarkVariantConfiguration(candidate.environment),
    ]);
    if (runtimeHash !== this.#identity.environmentHash
      || configHash !== this.#identity.variantConfigHashes[variant]
      || canonicalBenchmarkEnvironmentJson(candidate.environment)
        !== canonicalBenchmarkEnvironmentJson(start.environment)) {
      throw new Error(`${label} environment changed during the run`);
    }
    if (candidate.resourceSignature !== start.resourceSignature
      || canonicalResourceCheckpoint(candidate.resources) !== canonicalResourceCheckpoint(start.resources)) {
      throw new Error(`${label} resource residency changed during the run`);
    }
    if (candidate.activityStamp !== start.activityStamp) {
      throw new Error(`${label} resource activity changed during the run`);
    }
  }
}

async function pollFrame(
  host: FormalRenderBenchmarkHost,
  lease: FormalBenchmarkExclusiveLease,
  epoch: Readonly<FormalBenchmarkEpochIdentity>,
  scheduler: RenderReplayScheduler,
  initialWallNow: number,
  signal: AbortSignal | undefined,
): Promise<Readonly<{ ticket: Readonly<RenderReplayFrameTicket>; polledAt: number }>> {
  let wallNow = requireFinite("wall poll time", initialWallNow);
  for (;;) {
    const result = scheduler.poll(wallNow);
    if (result.status === "frame") return Object.freeze({ ticket: result.ticket, polledAt: wallNow });
    throwIfAborted(signal);
    const next = requireFinite(
      "host.waitUntil poll retry",
      await host.waitUntil(lease, epoch, result.dueAtWallMs, signal),
    );
    if (next <= wallNow) throw new Error("host.waitUntil must advance wall time when a frame is not due");
    wallNow = next;
  }
}

async function cloneBarrier(
  input: unknown,
  snapshot: Readonly<WorldReplaySnapshotV1>,
  epoch: Readonly<FormalBenchmarkEpochIdentity>,
  label: string,
): Promise<Readonly<FormalBenchmarkBarrier>> {
  requireExactPlainObject(input, label, BARRIER_KEYS);
  const source = input as Record<string, unknown>;
  requireEpochIdentity(source, epoch, label);
  const capturedAt = requireNonNegativeFinite(`${label}.capturedAt`, source.capturedAt);
  const readiness = cloneReadiness(source.readiness, `${label}.readiness`);
  const environment = cloneBenchmarkEnvironment(source.environment);
  const observation = cloneObservation(source.observation, `${label}.observation`);
  validateWorldReplayObservation(snapshot, observation);
  const resourceSignature = requireTrimmedNonEmpty(`${label}.resourceSignature`, source.resourceSignature);
  const activityStamp = requireTrimmedNonEmpty(`${label}.activityStamp`, source.activityStamp);
  const resources = cloneResourceCheckpoint(source.resources, `${label}.resources`);
  if (resourceSignature !== readiness.resourceSignature) {
    throw new Error(`${label} resourceSignature must match readiness.resourceSignature`);
  }
  return deepFreeze({
    suiteNonce: epoch.suiteNonce,
    epochNonce: epoch.epochNonce,
    capturedAt, readiness, environment, observation, resourceSignature, activityStamp, resources,
  });
}

function cloneReadiness(input: unknown, label: string): Readonly<BenchmarkReadinessObservation> {
  requireExactPlainObject(input, label, READINESS_KEYS);
  const source = input as Record<string, unknown>;
  const capturedAt = requireNonNegativeFinite(`${label}.capturedAt`, source.capturedAt);
  const ready = requireBoolean(`${label}.ready`, source.ready);
  const stableForMs = requireNonNegativeFinite(`${label}.stableForMs`, source.stableForMs);
  const stableSamples = requireNonNegativeSafeInteger(`${label}.stableSamples`, source.stableSamples);
  const resourceSignature = requireTrimmedNonEmpty(`${label}.resourceSignature`, source.resourceSignature);
  if (!Array.isArray(source.blockingReasons)
    || source.blockingReasons.some((reason) => typeof reason !== "string")) {
    throw new TypeError(`${label}.blockingReasons must be an array of strings`);
  }
  const blockingReasons = Object.freeze([...source.blockingReasons]) as readonly BenchmarkReadinessBlockingReason[];
  const derivedReady = stableForMs >= RENDER_BENCHMARK_STABLE_RESIDENCY_MS
    && stableSamples >= RENDER_BENCHMARK_MIN_STABLE_SAMPLES
    && blockingReasons.length === 0;
  if (ready !== derivedReady) throw new Error(`${label}.ready does not match raw readiness evidence`);
  return Object.freeze({ capturedAt, ready, stableForMs, stableSamples, resourceSignature, blockingReasons });
}

function cloneObservation(input: unknown, label: string): Readonly<WorldReplayObservation> {
  requireExactPlainObject(input, label, OBSERVATION_KEYS);
  const source = input as Record<string, unknown>;
  const indoors = requireBoolean(`${label}.indoors`, source.indoors);
  const underwater = requireBoolean(`${label}.underwater`, source.underwater);
  requireExactPlainObject(source.weather, `${label}.weather`, WEATHER_KEYS);
  const weather = source.weather as Record<string, unknown>;
  const state = requireNonNegativeSafeInteger(`${label}.weather.state`, weather.state);
  if (state > 0xffff_ffff) throw new RangeError(`${label}.weather.state must be uint32`);
  const intensity = requireNonNegativeFinite(`${label}.weather.intensity`, weather.intensity);
  if (intensity > 1) throw new RangeError(`${label}.weather.intensity must be in [0, 1]`);
  const abrupt = requireBoolean(`${label}.weather.abrupt`, weather.abrupt);
  return deepFreeze({ indoors, underwater, weather: { state, intensity, abrupt } });
}

function cloneReceipt(
  input: unknown,
  epoch: Readonly<FormalBenchmarkEpochIdentity>,
): Readonly<FormalBenchmarkSubmissionReceipt> {
  requireExactPlainObject(input, "submission receipt", RECEIPT_KEYS);
  const source = input as Record<string, unknown>;
  requireEpochIdentity(source, epoch, "submission receipt");
  if (source.submitted !== true) throw new Error("submission receipt must prove submitted:true");
  return Object.freeze({
    suiteNonce: epoch.suiteNonce,
    epochNonce: epoch.epochNonce,
    submitted: true,
    frameIndex: requireNonNegativeSafeInteger("submission receipt.frameIndex", source.frameIndex),
    submissionSerial: requireNonNegativeSafeInteger("submission receipt.submissionSerial", source.submissionSerial),
    completedAtWallMs: requireNonNegativeFinite(
      "submission receipt.completedAtWallMs",
      source.completedAtWallMs,
    ),
    fullFrameCpuMs: requireNonNegativeFinite("submission receipt.fullFrameCpuMs", source.fullFrameCpuMs),
    rendererFrameCpuMs: requireNonNegativeFinite(
      "submission receipt.rendererFrameCpuMs",
      source.rendererFrameCpuMs,
    ),
  });
}

function addGpuDrain(accumulator: BenchmarkRunAccumulator, input: unknown): void {
  requirePlainObject(input, "GPU drain");
  const status = input.status;
  if (status === "available") {
    requireExactPlainObject(input, "GPU drain", ["status", "samples"]);
    if (!Array.isArray(input.samples) || input.samples.length !== FORMAL_BENCHMARK_FRAME_COUNT) {
      throw new RangeError(`available GPU drain must contain exactly ${FORMAL_BENCHMARK_FRAME_COUNT} samples`);
    }
    assertDenseArray(input.samples, "GPU drain.samples");
    for (const [index, milliseconds] of input.samples.entries()) {
      accumulator.addGpuSample({
        status: "available",
        milliseconds: requireNonNegativeFinite(`GPU drain.samples[${index}]`, milliseconds),
      });
    }
    return;
  }
  requireExactPlainObject(input, "GPU drain", ["status", "reason", "samples", "attempted", "dropped"]);
  if (status !== "unavailable" || typeof input.reason !== "string"
    || !GPU_UNAVAILABLE_REASONS.has(input.reason as BenchmarkGpuUnavailableReason)) {
    throw new TypeError("GPU drain unavailable reason is unsupported");
  }
  if (!Array.isArray(input.samples) || input.samples.length > FORMAL_BENCHMARK_FRAME_COUNT) {
    throw new RangeError(`unavailable GPU drain may contain at most ${FORMAL_BENCHMARK_FRAME_COUNT} samples`);
  }
  assertDenseArray(input.samples, "GPU drain.samples");
  const attempted = requireNonNegativeSafeInteger("GPU drain.attempted", input.attempted);
  const dropped = requireNonNegativeSafeInteger("GPU drain.dropped", input.dropped);
  if (attempted > FORMAL_BENCHMARK_FRAME_COUNT
    || attempted !== input.samples.length + dropped) {
    throw new Error("unavailable GPU drain attempted must equal covered samples plus dropped");
  }
  for (const [index, milliseconds] of input.samples.entries()) {
    accumulator.addGpuSample({
      status: "available",
      milliseconds: requireNonNegativeFinite(`GPU drain.samples[${index}]`, milliseconds),
    });
  }
  const sample: BenchmarkGpuSample = { status: "unavailable", reason: input.reason as BenchmarkGpuUnavailableReason };
  accumulator.addGpuSample(sample);
  if (dropped > 0) {
    accumulator.addGpuDropped(
      dropped,
      input.reason === "queue-drop"
        ? "queue-drop"
        : input.reason === "pending-at-finish" ? "pending-at-finish" : "query-discard",
    );
  }
}

function cloneResourceCheckpoint(input: unknown, label: string): Readonly<BenchmarkResourceCheckpointInput> {
  requirePlainObject(input, label);
  requireAllowedKeys(input, label, RESOURCE_KEYS);
  const result: { counters?: Readonly<Record<string, number>>; bytes?: Readonly<Record<string, number>> } = {};
  if (Object.prototype.hasOwnProperty.call(input, "counters")) {
    result.counters = cloneMetricMap(input.counters, `${label}.counters`);
  }
  if (Object.prototype.hasOwnProperty.call(input, "bytes")) {
    result.bytes = cloneMetricMap(input.bytes, `${label}.bytes`);
  }
  return Object.freeze(result);
}

function cloneMetricMap(input: unknown, label: string): Readonly<Record<string, number>> {
  requirePlainObject(input, label);
  const result: Record<string, number> = {};
  for (const key of Object.keys(input).sort()) {
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      value: requireNonNegativeFinite(`${label}.${key}`, input[key]),
      writable: false,
    });
  }
  return Object.freeze(result);
}

function canonicalResourceCheckpoint(input: Readonly<BenchmarkResourceCheckpointInput>): string {
  return JSON.stringify({
    counters: input.counters === undefined
      ? null
      : Object.entries(input.counters).sort(([left], [right]) => left.localeCompare(right)),
    bytes: input.bytes === undefined
      ? null
      : Object.entries(input.bytes).sort(([left], [right]) => left.localeCompare(right)),
  });
}

function requireReadyBarrier(barrier: Readonly<FormalBenchmarkBarrier>, label: string): void {
  if (!barrier.readiness.ready
    || barrier.readiness.stableForMs < RENDER_BENCHMARK_STABLE_RESIDENCY_MS
    || barrier.readiness.stableSamples < RENDER_BENCHMARK_MIN_STABLE_SAMPLES
    || barrier.readiness.blockingReasons.length !== 0) {
    throw new Error(`${label} does not prove stable readiness`);
  }
}

function requireGpuDrainableBarrier(barrier: Readonly<FormalBenchmarkBarrier>): void {
  const reasons = barrier.readiness.blockingReasons;
  if (reasons.length === 0) {
    requireReadyBarrier(barrier, "measurement-end barrier");
    return;
  }
  if (reasons.length !== 1 || reasons[0] !== "gpu-queries-pending" || barrier.readiness.ready) {
    throw new Error("measurement-end barrier may only be blocked by pending GPU queries");
  }
}

function requireFormalCanvasProfile(environment: Readonly<BenchmarkEnvironmentMetadata>): void {
  const expected = RENDER_BENCHMARK_MANIFEST.profile.canvas;
  const actual = environment.canvas;
  if (actual.cssWidth !== expected.cssWidth
    || actual.cssHeight !== expected.cssHeight
    || actual.backingWidth !== expected.backingWidth
    || actual.backingHeight !== expected.backingHeight
    || actual.systemDpr !== expected.systemDpr
    || actual.effectivePixelRatio !== expected.effectivePixelRatio
    || actual.renderScalePercent !== expected.renderScalePercent) {
    throw new Error("formal benchmark canvas must be 1920x1080 at DPR 1, effective pixel ratio 1, and render scale 100");
  }
}

function requireApprovedScenarioFixture(
  snapshot: Readonly<WorldReplaySnapshotV1>,
  selfPosition: Readonly<BenchmarkPosition>,
  scenario: Readonly<ApprovedBenchmarkScenario>,
): void {
  if (snapshot.mapId !== scenario.mapId) {
    throw new Error("formal snapshot mapId must match the approved scenario fixture");
  }
  if (snapshot.halfMinute !== scenario.halfMinute) {
    throw new Error("formal snapshot halfMinute must match the approved scenario fixture");
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (Math.abs(selfPosition[axis] - scenario.position[axis]) > FORMAL_BENCHMARK_POSITION_TOLERANCE_YARDS) {
      throw new Error("formal snapshot self position must match the approved scenario fixture");
    }
  }
  if (scenario.weather?.mode !== "fine") {
    throw new Error("approved formal scenario must define fixed fine weather");
  }
  if (snapshot.weather.state !== 0 || snapshot.weather.intensity !== 0 || snapshot.weather.abrupt !== false) {
    throw new Error("formal snapshot weather must match the approved fine-weather fixture");
  }
}

function requireFormalVariantProfile(configuration: unknown, label: string): void {
  requireExactPlainObject(configuration, label, ["lighting", "settings"]);
  if (configuration.lighting !== RENDER_BENCHMARK_MANIFEST.profile.lighting) {
    throw new Error(`${label}.lighting must equal the formal manifest lighting profile`);
  }
  requirePlainObject(configuration.settings, `${label}.settings`);
  if (!Object.prototype.hasOwnProperty.call(configuration.settings, "renderScale")
    || configuration.settings.renderScale !== RENDER_BENCHMARK_MANIFEST.profile.canvas.renderScalePercent) {
    throw new Error(`${label}.settings.renderScale must equal the formal canvas render scale`);
  }
}

function environmentWithConfiguration(
  environment: Readonly<BenchmarkEnvironmentMetadata>,
  configurationInput: unknown,
): unknown {
  requireExactPlainObject(configurationInput, "variant configuration", ["lighting", "settings"]);
  const configuration = configurationInput as Record<string, unknown>;
  return {
    canvas: environment.canvas,
    browser: environment.browser,
    webgl: {
      version: environment.webgl.version,
      shadingLanguageVersion: environment.webgl.shadingLanguageVersion,
      extensions: environment.webgl.extensions,
    },
    lighting: configuration.lighting,
    settings: configuration.settings,
  };
}

function requireSameAllowedLeafType(left: unknown, right: unknown, path: string): void {
  const leftValue = valueAtDotPath(left, path);
  const rightValue = valueAtDotPath(right, path);
  if (leftValue === null || rightValue === null || typeof leftValue !== typeof rightValue) {
    throw new TypeError("allowlisted variant knob values must have the same scalar type");
  }
}

function valueAtDotPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split(".")) {
    requirePlainObject(current, `variant path ${path}`);
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new TypeError(`variant path ${path} is missing`);
    }
    current = current[segment];
  }
  return current;
}

function validateHost(host: unknown): asserts host is FormalRenderBenchmarkHost {
  if (host === null || (typeof host !== "object" && typeof host !== "function")) {
    throw new TypeError("formal benchmark host must be an object");
  }
  for (const method of [
    "acquireExclusiveLease", "applyVariant", "prewarm", "captureBarrier", "resetReplayEpoch",
    "endReplayEpoch", "waitUntil", "renderFrame", "drainGpu",
  ] as const) {
    if (typeof (host as unknown as Record<string, unknown>)[method] !== "function") {
      throw new TypeError(`formal benchmark host.${method} must be a function`);
    }
  }
}

function validateLease(lease: unknown): asserts lease is FormalBenchmarkExclusiveLease {
  if (lease === null || (typeof lease !== "object" && typeof lease !== "function")
    || typeof (lease as { release?: unknown }).release !== "function") {
    throw new TypeError("exclusive benchmark lease must expose release()");
  }
}

function createFormalNonce(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== "function") {
    throw new Error("Web Crypto random nonce generation is unavailable");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formalMonotonicNow(): number {
  const performance = globalThis.performance;
  if (performance === undefined || typeof performance.now !== "function") {
    throw new Error("runner-owned monotonic performance clock is unavailable");
  }
  return requireNonNegativeFinite("runner monotonic clock", performance.now());
}

function requireFreshStartBarrier(
  barrier: Readonly<FormalBenchmarkBarrier>,
  requestedAt: number,
  completedAt: number,
): void {
  if (completedAt < requestedAt
    || barrier.capturedAt < requestedAt - FORMAL_BENCHMARK_START_BARRIER_FRESHNESS_TOLERANCE_MS
    || barrier.capturedAt > completedAt + FORMAL_BENCHMARK_START_BARRIER_FRESHNESS_TOLERANCE_MS) {
    throw new Error("start barrier is stale or does not use the runner monotonic clock");
  }
}

function requireEpochIdentity(
  source: Readonly<Record<string, unknown>>,
  epoch: Readonly<FormalBenchmarkEpochIdentity>,
  label: string,
): void {
  if (source.suiteNonce !== epoch.suiteNonce || source.epochNonce !== epoch.epochNonce) {
    throw new Error(`${label} does not belong to the active formal replay epoch`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("formal benchmark aborted");
}

function requirePlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function requireExactPlainObject(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  requirePlainObject(value, label);
  const ownKeys = Reflect.ownKeys(value);
  const actual = ownKeys.filter((key): key is string => typeof key === "string");
  if (ownKeys.length !== actual.length
    || actual.length !== expectedKeys.length
    || expectedKeys.some((key) => !actual.includes(key))) {
    throw new TypeError(`${label} must contain exactly ${expectedKeys.join(", ")}`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function requireAllowedKeys(value: Record<string, unknown>, label: string, allowed: readonly string[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new TypeError(`${label} contains an unsupported key`);
  }
}

function requireFinite(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError(`${label} must be a canonical finite number`);
  }
  return value;
}

function requireNonNegativeFinite(label: string, value: unknown): number {
  const number = requireFinite(label, value);
  if (number < 0) throw new RangeError(`${label} must be non-negative`);
  return number;
}

function requireNonNegativeSafeInteger(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireBoolean(label: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function requireTrimmedNonEmpty(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a trimmed non-empty string`);
  }
  return value;
}

function assertDenseArray(value: readonly unknown[], label: string): void {
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) throw new TypeError(`${label}[${index}] is missing`);
  }
}

function numbersEqual(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
